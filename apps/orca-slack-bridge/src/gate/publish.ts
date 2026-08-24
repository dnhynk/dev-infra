import { renderFingerprint, type RenderedCard } from '../digest/render.js';
import type { RunKey } from '../identity/keys.js';
import type { SlackPoster, ThreadPoster } from '../slack/post.js';
import type { GateStore } from '../store/schema.js';
import { renderGateDecisionCard } from './render.js';
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
  if (existing !== null && existing.renderFingerprint === fingerprint) {
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
    return { ...base, action: 'create', messageTs: posted.ts };
  }

  const updated = await options.slack.update({
    channel: existing.channelId,
    ts: existing.messageTs,
    text: card.text,
    blocks: card.blocks,
  });
  options.store.updateGateObservation(gate.key, fingerprint, at);
  return { ...base, action: 'update', messageTs: updated.ts };
}
