import { renderFingerprint, type RenderedCard } from '../digest/render.js';
import { randomUUID } from 'node:crypto';
import type { GateKey } from '../identity/keys.js';
import {
  boundedSlackUpdate,
  DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
  SlackUpdateTimeoutError,
  type SlackPoster,
} from '../slack/post.js';
import type { GateStore } from '../store/schema.js';
import { renderGateResolutionCard } from './resolution-render.js';
import type { GateResolutionLifecycle } from './resolution-types.js';

export type GateProjectionResult = {
  readonly kind: 'absent' | 'current' | 'projected' | 'pending';
  readonly card: RenderedCard | null;
  readonly fingerprint: string | null;
};

export type GateProjectionFault = 'after_slack_success_before_local_completion';

function projectionState(lifecycle: GateResolutionLifecycle): 'resolving' | 'resolved' | 'conflict' | 'degraded' {
  if (lifecycle === 'resolved') return 'resolved';
  if (lifecycle === 'conflict') return 'conflict';
  if (lifecycle === 'degraded' || lifecycle === 'uncertain') return 'degraded';
  return 'resolving';
}

/**
 * Projects the latest durable D2 generation. A completion for an older generation cannot clear a
 * newer pending card; when that CAS loses, the loop immediately converges to the newest snapshot.
 */
export async function projectGateResolutionCard(
  store: GateStore,
  slack: SlackPoster,
  gateKey: GateKey,
  now: () => Date,
  fault?: (point: GateProjectionFault, gateKey: GateKey) => void | Promise<void>,
  timeoutMs = DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
): Promise<GateProjectionResult> {
  const projectionOwner = `p${process.pid}.${randomUUID()}`;
  let ownsProjection = false;
  let abandonProjection = false;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
    const intent = store.findGateResolution(gateKey);
    const outbox = store.findGateResolutionOutbox(gateKey);
    const message = store.findGateMessage(gateKey);
    const localObservation = store.findGateLocalObservation(gateKey);
    if (intent === null || outbox === null || intent.ackState !== 'acked') {
      return { kind: 'absent', card: null, fingerprint: null };
    }
    // Intent and outbox are separate rows updated in one SQLite transaction. Re-read the intent
    // after collecting the outbox/message snapshot: a different revision means those reads were
    // mixed across generations. Advancing after this fence is safe because the outbox revision CAS
    // below then loses and the loop converges to the new generation.
    const fencedIntent = store.findGateResolution(gateKey);
    if (fencedIntent === null || fencedIntent.revision !== intent.revision) continue;
    if (outbox.cardState !== projectionState(intent.lifecycle)) {
      store.recordGateAttempt(
        gateKey,
        'card_projection',
        'snapshot_mismatch',
        null,
        now().toISOString(),
      );
      return { kind: 'pending', card: null, fingerprint: null };
    }
    const card = renderGateResolutionCard(intent, outbox);
    const fingerprint = renderFingerprint(card);
    const forceProjection =
      outbox.cardPending || localObservation?.mappingState === 'write_pending';
    if (
      message === null ||
      message.channelId !== intent.channelId ||
      message.messageTs !== intent.messageTs
    ) {
      store.recordGateAttempt(gateKey, 'card_projection', 'mapping_missing', null, now().toISOString());
      return { kind: 'pending', card, fingerprint };
    }
    if (!forceProjection && message.renderFingerprint === fingerprint) {
      return { kind: 'current', card, fingerprint };
    }
    if (forceProjection || message.renderFingerprint !== fingerprint) {
      const lease = store.acquireGateOutboxProjection(
        gateKey,
        outbox.revision,
        projectionOwner,
        now().toISOString(),
      );
      if (lease === 'busy') return { kind: 'pending', card, fingerprint };
      if (lease === 'superseded') continue;
      if (lease === 'recovered') {
        ownsProjection = true;
        continue;
      }
      ownsProjection = true;
      let updated: Awaited<ReturnType<SlackPoster['update']>>;
      try {
        updated = await boundedSlackUpdate(slack, {
          channel: message.channelId,
          ts: message.messageTs,
          text: card.text,
          blocks: card.blocks,
        }, timeoutMs);
      } catch (error) {
        store.releaseGateOutboxProjection(gateKey, projectionOwner, now().toISOString());
        ownsProjection = false;
        store.recordGateAttempt(
          gateKey,
          'card_projection',
          error instanceof SlackUpdateTimeoutError ? 'timed_out' : 'failed',
          null,
          now().toISOString(),
        );
        return { kind: 'pending', card, fingerprint };
      }
      try {
        await fault?.('after_slack_success_before_local_completion', gateKey);
      } catch (e) {
        // This seam models process death: keep the durable owner. A normal catchable Slack failure
        // above releases it; a real crash cannot run a local release.
        abandonProjection = true;
        throw e;
      }
      if (updated.channel !== message.channelId || updated.ts !== message.messageTs) {
        store.releaseGateOutboxProjection(gateKey, projectionOwner, now().toISOString());
        ownsProjection = false;
        store.recordGateAttempt(
          gateKey,
          'card_projection',
          'identity_mismatch',
          null,
          now().toISOString(),
        );
        return { kind: 'pending', card, fingerprint };
      }
    }
    if (store.markGateOutboxProjected(
      gateKey,
      outbox.revision,
      fingerprint,
      projectionOwner,
      now().toISOString(),
    )) {
      ownsProjection = false;
      store.recordGateAttempt(gateKey, 'card_projection', 'succeeded', null, now().toISOString());
      return { kind: 'projected', card, fingerprint };
    }
    store.recordGateAttempt(gateKey, 'card_projection', 'superseded', null, now().toISOString());
  }
    return { kind: 'pending', card: null, fingerprint: null };
  } finally {
    if (ownsProjection && !abandonProjection) {
      store.releaseGateOutboxProjection(gateKey, projectionOwner, now().toISOString());
    }
  }
}
