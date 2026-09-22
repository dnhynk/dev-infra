import { renderFingerprint, type RenderedCard } from '../digest/render.js';
import { taskKey, type RunKey } from '../identity/keys.js';
import {
  boundedSlackReply,
  boundedSlackUpdate,
  DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
  SlackApiError,
  type SlackPoster,
  type ThreadPoster,
} from '../slack/post.js';
import type { GateStore } from '../store/schema.js';
import { renderGateDecisionCard } from './render.js';
import { projectGateResolutionCard } from './resolution-project.js';
import { renderGateResolutionCard } from './resolution-render.js';
import type { GateLocalObservation, GateObservationSaveResult } from './resolution-types.js';
import type { GateDecisionFacts } from './types.js';

export type GatePublishAction =
  | 'create'
  | 'update'
  | 'skip'
  | 'channel_mismatch'
  | 'thread_mismatch'
  | 'root_unavailable'
  /**
   * 사람이 카드를 지웠다. 가리킬 곳이 없어진 매핑을 버렸다.
   *
   * 아직 열린 Gate면 다음 관측이 새로 만들고, 이미 끝난 Gate면 만들지 않는다. 이 값이 없으면
   * 지워진 카드 한 장이 관측 pass 전체를 영원히 멈춘다.
   */
  | 'relinked';

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
  /**
   * 카드를 어디에 놓는가. 기본은 Run 루트 아래 답글이다.
   *
   * `channel`은 답할 카드만 오는 채널에 최상위 메시지로 놓는다. 답글은 스레드를 따르지 않는
   * 사람에게 알림이 가지 않고, 알림을 위해 broadcast를 켜면 그 복사본이 상태 카드 사이에
   * 섞인다. 답할 카드는 그 채널의 맨 아래에 혼자 있어야 폰에서 열자마자 보인다.
   */
  readonly placement?: 'thread' | 'channel';
  readonly now: () => Date;
  readonly slackTimeoutMs?: number;
  /** Observer deadline/shutdown fence carried through first replies and later updates. */
  readonly signal?: AbortSignal;
  readonly fault?: (
    point:
      | 'after_gate_observation_reservation_before_confirmation'
      | 'after_gate_observation_confirmation_before_write'
      | 'after_staged_first_reply_before_mapping'
      | 'after_staged_first_mapping_before_action_update'
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

/** A first reply is inert until its Slack identity and matched observation are durable. */
function stagedGateCard(card: RenderedCard): RenderedCard {
  const blocks = card.blocks.filter((block) => block['type'] !== 'actions');
  return blocks.length === card.blocks.length ? card : { text: card.text, blocks };
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
  const topLevel = options.placement === 'channel';
  const mappingState =
    existing === null || (!topLevel && rootMessageTs === null)
      ? 'missing'
      : existing.channelId === options.channel &&
          existing.runKey === runKey &&
          (topLevel || existing.threadTs === rootMessageTs)
        ? 'matched'
        : 'mismatched';
  /** 기대 매핑 신원. 최상위 카드에는 대조할 루트 ts가 없다. */
  const expectedIdentity = {
    channelId: options.channel,
    threadTs: rootMessageTs,
    ...(topLevel ? { placement: 'channel' as const } : {}),
  };
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
  let savedObservation: GateObservationSaveResult | null = null;
  if (!isDryRun) {
    // Reserve the logical generation before any asynchronous pause. Confirmation below prevents a
    // same-timestamp publisher that started first but resumed last from becoming current merely
    // because it reached SQLite later.
    const reservedObservation = options.store.saveGateLocalObservation(
      localObservation,
      existing === null ? expectedIdentity : undefined,
    );
    await options.fault?.('after_gate_observation_reservation_before_confirmation', gate.key);
    // When this publisher observed no message, recheck that fact inside the SQLite write. A
    // concurrent first publisher may have mapped and exposed the canonical card while this task
    // was paused; persist the current facts without downgrading that established mapping.
    savedObservation = options.store.saveGateLocalObservation(
      localObservation,
      existing === null ? expectedIdentity : undefined,
      reservedObservation.revision,
    );
  }
  if (existing === null && savedObservation?.current === false) {
    // A first-publisher snapshot can become stale while paused before its observation save. It may
    // persist a fail-closed correlation result, but must not create even an inert remote orphan.
    return { ...base, action: 'skip', messageTs: null };
  }
  const recoveringOrdinaryWrite =
    !isDryRun && options.store.findGateLocalObservation(gate.key)?.mappingState !== 'matched';

  // 최상위 배치에는 매달 루트가 없다. 루트 부재가 게시를 막는 것은 답글 배치에서만이다.
  if (rootMessageTs === null && !topLevel && !isDryRun) {
    return { ...base, action: 'root_unavailable', messageTs: existing?.messageTs ?? null };
  }
  if (existing !== null && existing.channelId !== options.channel) {
    return { ...base, action: 'channel_mismatch', messageTs: existing.messageTs };
  }
  if (
    existing !== null &&
    (existing.runKey !== runKey ||
      (!topLevel && rootMessageTs !== null && existing.threadTs !== rootMessageTs))
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
    const resolutionCard = renderGateResolutionCard(
      resolution,
      resolutionOutbox,
      options.store.findGateChannelDelivery(gate.key),
      options.store.findGateResumeObservation(gate.key),
    );
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
      options.signal,
    );
    return {
      gate,
      card: projection.card ?? resolutionCard,
      fingerprint: projection.fingerprint ?? resolutionFingerprint,
      action: projection.kind === 'current' ? 'skip' : 'update',
      messageTs: existing?.messageTs ?? null,
    };
  }
  if (existing !== null && savedObservation?.current === false) {
    // The durable save observed a later/terminal generation than this caller rendered. It may
    // record fail-closed correlation, but it may not start an older ordinary Slack card.
    return { ...base, action: 'skip', messageTs: existing.messageTs };
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
  if ((rootMessageTs === null && !topLevel) || options.slack === null || options.thread === null) {
    return { ...base, action: 'root_unavailable', messageTs: existing?.messageTs ?? null };
  }

  const at = options.now().toISOString();
  if (existing === null && gate.status !== 'pending') {
    /*
     * 끝난 Gate에 카드를 새로 만들지 않는다.
     *
     * 카드는 사람이 결정하라고 있는 것이고, 이미 결정된 Gate의 카드는 이력이다. 사람이 그
     * 이력을 지웠으면 다음 관측이 되살릴 이유가 없다. 이것이 없으면 지운 카드가 채널마다
     * 계속 다시 나타난다.
     */
    return { ...base, action: 'skip', messageTs: null };
  }
  if (existing === null) {
    const stagedCard = stagedGateCard(card);
    const stagedFingerprint = renderFingerprint(stagedCard);
    const posted = topLevel
      // 답할 카드만 오는 채널이다. 최상위 메시지 자체가 알림이므로 broadcast가 필요 없다.
      ? await options.slack.post({
          channel: options.channel,
          text: stagedCard.text,
          blocks: stagedCard.blocks,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      : await boundedSlackReply(options.thread, {
          channel: options.channel,
          threadTs: rootMessageTs!,
          text: stagedCard.text,
          blocks: stagedCard.blocks,
          // Gate는 owner가 결정하기 전에는 아무것도 진행되지 않는 유일한 사실이다. thread
          // reply만으로는 그 thread를 따르지 않는 owner에게 도달하지 않으므로 채널에도 함께
          // 띄운다(OD-072).
          broadcast: true,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }, options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS);
    await options.fault?.('after_staged_first_reply_before_mapping', gate.key);
    options.store.insertGateMessage({
      gateKey: gate.key,
      runKey,
      channelId: posted.channel,
      // 최상위 카드는 자기 자신이 루트다. 매핑의 세 값이 함께 있어야 한다는 규칙을 지킨다.
      threadTs: topLevel ? posted.ts : rootMessageTs!,
      messageTs: posted.ts,
      renderFingerprint: stagedFingerprint,
      at,
    }, {
      ...localObservation,
      mappingState: 'matched',
      observedAt: at,
    });
    await options.fault?.('after_staged_first_mapping_before_action_update', gate.key);
    if (stagedFingerprint !== fingerprint) {
      // Re-enter the ordinary bounded update path now that the exact Slack identity is durable.
      // A crash before/during this update leaves an inert mapped card that the next observer can
      // safely update in place; a duplicate first publisher can leave only an inert orphan.
      await publishGateCard(options, runKey, rootMessageTs, gate);
    }
    return { ...base, action: 'create', messageTs: posted.ts };
  }

  if (savedObservation === null) {
    throw new Error(`${gate.key}의 ordinary write observation generation이 없다`);
  }
  await options.fault?.('after_gate_observation_confirmation_before_write', gate.key);
  if (!options.store.beginGateObservationWrite(
    gate.key,
    at,
    savedObservation.observation,
    savedObservation.revision,
    expectedIdentity,
  )) {
    // The fence and Gate claim use the same BEGIN IMMEDIATE boundary. If a winner committed after
    // the earlier read, never start the ordinary Slack update; render/project that durable state.
    const racedIntent = options.store.findGateResolution(gate.key);
    const racedOutbox = options.store.findGateResolutionOutbox(gate.key);
    if (racedIntent?.ackState === 'acked' && racedOutbox !== null) {
      const resolutionCard = renderGateResolutionCard(
        racedIntent,
        racedOutbox,
        options.store.findGateChannelDelivery(gate.key),
        options.store.findGateResumeObservation(gate.key),
      );
      const resolutionFingerprint = renderFingerprint(resolutionCard);
      const projection = await projectGateResolutionCard(
        options.store,
        options.slack,
        gate.key,
        options.now,
        undefined,
        options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
        options.signal,
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }, options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS);
  } catch (e) {
    options.store.abandonGateObservationWrite(gate.key);
    if (e instanceof SlackApiError && e.code === 'message_not_found') {
      // 사람이 카드를 지웠다. 가리킬 곳이 없어진 매핑을 버린다. 던지면 이 Gate 하나가 관측
      // pass 전체를 멈춘다.
      options.store.forgetGateMessage(gate.key);
      return { ...base, action: 'relinked', messageTs: null };
    }
    throw e;
  }
  await options.fault?.('after_static_slack_before_observation', gate.key);
  try {
    options.store.updateGateObservation(
      gate.key,
      fingerprint,
      options.now().toISOString(),
      savedObservation.observation,
      savedObservation.revision,
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
      options.signal,
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
