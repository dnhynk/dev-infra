import { renderFingerprint, type RenderedCard } from '../digest/render.js';
import { taskKey, type RunKey } from '../identity/keys.js';
import {
  boundedSlackUpdate,
  DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
  type SlackPoster,
  type ThreadPoster,
} from '../slack/post.js';
import type { GateStore } from '../store/schema.js';
import { renderGateDecisionCard } from './render.js';
import { projectGateResolutionCard } from './resolution-project.js';
import { renderGateResolutionCard } from './resolution-render.js';
import type { GateLocalObservation } from './resolution-types.js';
import type { GateDecisionFacts } from './types.js';

export type GatePublishAction =
  | 'create'
  | 'update'
  | 'skip'
  | 'channel_mismatch'
  | 'thread_mismatch'
  | 'root_unavailable';

export type GatePublishResult = {
  readonly gate: GateDecisionFacts;
  readonly action: GatePublishAction;
  readonly messageTs: string | null;
  readonly fingerprint: string;
  readonly card: RenderedCard;
};

export type GatePublishOptions = {
  readonly store: GateStore;
  /** Root/update boundary. Null together with `thread` means dry-run. */
  readonly slack: SlackPoster | null;
  /** Thread-reply boundary. Null together with `slack` means dry-run. */
  readonly thread: ThreadPoster | null;
  readonly channel: string;
  readonly now: () => Date;
  readonly slackTimeoutMs?: number;
  readonly fault?: (
    point:
      | 'after_static_slack_before_observation'
      | 'after_static_observation_before_resolution_reproject',
    gateKey: GateDecisionFacts['key'],
  ) => void | Promise<void>;
};

function dryRun(options: GatePublishOptions): boolean {
  if ((options.slack === null) !== (options.thread === null)) {
    throw new Error('Gate publisher의 root/thread Slack 경계가 한쪽만 켜져 있다');
  }
  return options.slack === null;
}

/** Publish or update exactly one Gate reply under its existing Run root. */
export async function publishGateCard(
  options: GatePublishOptions,
  runKey: RunKey,
  rootMessageTs: string | null,
  gate: GateDecisionFacts,
): Promise<GatePublishResult> {
  const card = renderGateDecisionCard(gate);
  const fingerprint = renderFingerprint(card);
  const base = { gate, fingerprint, card } as const;
  const existing = options.store.findGateMessage(gate.key);
  const isDryRun = dryRun(options);
  const mappingState =
    rootMessageTs === null || existing === null
      ? 'missing'
      : existing.channelId === options.channel &&
          existing.runKey === runKey &&
          existing.threadTs === rootMessageTs
        ? 'matched'
        : 'mismatched';
  const locallyConsistentPending =
    gate.status === 'pending' && gate.resolution === null && gate.resolvedAt === null;
  const locallyConsistentResolved =
    gate.status === 'resolved' && gate.resolution !== null && gate.resolvedAt !== null;
  const localObservation: GateLocalObservation = {
    gateKey: gate.key,
    runKey,
    taskKey: taskKey(gate.taskId),
    status: locallyConsistentPending
      ? 'pending' as const
      : locallyConsistentResolved
        ? 'resolved' as const
        : 'unsupported' as const,
    resolution: locallyConsistentResolved ? gate.resolution : null,
    resolvedAt: locallyConsistentResolved ? gate.resolvedAt : null,
    metadataState: gate.metadataState,
    mappingState,
    observedAt: options.now().toISOString(),
  };

  // This is the only pre-ACK Gate-state source. It is written by the production observer, never
  // inferred from Slack prose. A newer unsupported/inconsistent state replaces an older pending
  // row so unknown future Orca states cannot leave stale buttons actionable.
  if (!isDryRun) {
    options.store.saveGateLocalObservation(localObservation);
  }
  const recoveringOrdinaryWrite =
    !isDryRun && options.store.findGateLocalObservation(gate.key)?.mappingState === 'write_pending';

  if (rootMessageTs === null && !isDryRun) {
    return { ...base, action: 'root_unavailable', messageTs: existing?.messageTs ?? null };
  }
  if (existing !== null && existing.channelId !== options.channel) {
    return { ...base, action: 'channel_mismatch', messageTs: existing.messageTs };
  }
  if (
    existing !== null &&
    (existing.runKey !== runKey ||
      (rootMessageTs !== null && existing.threadTs !== rootMessageTs))
  ) {
    return { ...base, action: 'thread_mismatch', messageTs: existing.messageTs };
  }
  const resolution = options.store.findGateResolution(gate.key);
  const resolutionOutbox = options.store.findGateResolutionOutbox(gate.key);
  if (resolution !== null && resolutionOutbox !== null) {
    // A claimed-but-unacknowledged action owns no remote effects yet. Freeze the existing card
    // until ACK succeeds (or a Slack redelivery succeeds) instead of letting the observer race it.
    if (resolution.ackState !== 'acked') {
      return { ...base, action: 'skip', messageTs: existing?.messageTs ?? null };
    }
    const resolutionCard = renderGateResolutionCard(resolution, resolutionOutbox);
    const resolutionFingerprint = renderFingerprint(resolutionCard);
    if (isDryRun || options.slack === null) {
      return {
        gate,
        card: resolutionCard,
        fingerprint: resolutionFingerprint,
        action: existing?.renderFingerprint === resolutionFingerprint ? 'skip' : 'update',
        messageTs: existing?.messageTs ?? null,
      };
    }
    const projection = await projectGateResolutionCard(
      options.store,
      options.slack,
      gate.key,
      options.now,
      undefined,
      options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
    );
    return {
      gate,
      card: projection.card ?? resolutionCard,
      fingerprint: projection.fingerprint ?? resolutionFingerprint,
      action: projection.kind === 'current' ? 'skip' : 'update',
      messageTs: existing?.messageTs ?? null,
    };
  }
  if (existing !== null && existing.renderFingerprint === fingerprint && !recoveringOrdinaryWrite) {
    return { ...base, action: 'skip', messageTs: existing.messageTs };
  }
  if (isDryRun) {
    return {
      ...base,
      action: existing === null ? 'create' : 'update',
      messageTs: existing?.messageTs ?? null,
    };
  }
  if (rootMessageTs === null || options.slack === null || options.thread === null) {
    return { ...base, action: 'root_unavailable', messageTs: existing?.messageTs ?? null };
  }

  const at = options.now().toISOString();
  if (existing === null) {
    const posted = await options.thread.reply({
      channel: options.channel,
      threadTs: rootMessageTs,
      text: card.text,
      blocks: card.blocks,
    });
    options.store.insertGateMessage({
      gateKey: gate.key,
      runKey,
      channelId: posted.channel,
      threadTs: rootMessageTs,
      messageTs: posted.ts,
      renderFingerprint: fingerprint,
      at,
    });
    // The pre-reply row was deliberately `missing`. Once the durable card identity exists, make
    // it actionable; a crash before this write remains a safe, reopenable missing observation.
    options.store.saveGateLocalObservation({ ...localObservation, mappingState: 'matched' });
    return { ...base, action: 'create', messageTs: posted.ts };
  }

  if (!options.store.beginGateObservationWrite(gate.key, at)) {
    // The fence and Gate claim use the same BEGIN IMMEDIATE boundary. If a winner committed after
    // the earlier read, never start the ordinary Slack update; render/project that durable state.
    const racedIntent = options.store.findGateResolution(gate.key);
    const racedOutbox = options.store.findGateResolutionOutbox(gate.key);
    if (racedIntent?.ackState === 'acked' && racedOutbox !== null) {
      const resolutionCard = renderGateResolutionCard(racedIntent, racedOutbox);
      const resolutionFingerprint = renderFingerprint(resolutionCard);
      const projection = await projectGateResolutionCard(
        options.store,
        options.slack,
        gate.key,
        options.now,
        undefined,
        options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
      );
      return {
        gate,
        card: projection.card ?? resolutionCard,
        fingerprint: projection.fingerprint ?? resolutionFingerprint,
        action: projection.kind === 'current' ? 'skip' : 'update',
        messageTs: existing.messageTs,
      };
    }
    return { ...base, action: 'skip', messageTs: existing.messageTs };
  }
  let updated: Awaited<ReturnType<SlackPoster['update']>>;
  try {
    updated = await boundedSlackUpdate(options.slack, {
      channel: existing.channelId,
      ts: existing.messageTs,
      text: card.text,
      blocks: card.blocks,
    }, options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS);
  } catch (e) {
    options.store.abandonGateObservationWrite(gate.key);
    throw e;
  }
  await options.fault?.('after_static_slack_before_observation', gate.key);
  try {
    options.store.updateGateObservation(
      gate.key,
      fingerprint,
      options.now().toISOString(),
      localObservation,
    );
  } catch (e) {
    options.store.abandonGateObservationWrite(gate.key);
    throw e;
  }
  await options.fault?.('after_static_observation_before_resolution_reproject', gate.key);
  // If a winner appeared while the ordinary update was in flight, D2 deterministically wins the
  // shared message and restores its newest durable generation before this observer returns.
  const racedResolution = options.store.findGateResolution(gate.key);
  if (racedResolution?.ackState === 'acked') {
    const projection = await projectGateResolutionCard(
      options.store,
      options.slack,
      gate.key,
      options.now,
      undefined,
      options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
    );
    if (projection.card !== null && projection.fingerprint !== null) {
      return {
        gate,
        card: projection.card,
        fingerprint: projection.fingerprint,
        action: 'update',
        messageTs: updated.ts,
      };
    }
  }
  return { ...base, action: 'update', messageTs: updated.ts };
}
