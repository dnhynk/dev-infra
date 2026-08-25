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
import type {
  GateChannelProjectionClaim,
  GateResolutionLifecycle,
} from './resolution-types.js';

export type GateProjectionResult = {
  readonly kind: 'absent' | 'current' | 'projected' | 'pending';
  readonly card: RenderedCard | null;
  readonly fingerprint: string | null;
};

export type GateProjectionFault =
  | 'after_outbox_rearm_before_reread'
  | 'after_slack_success_before_local_completion';

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
  let ownedChannelClaim: GateChannelProjectionClaim | undefined;
  let abandonProjection = false;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
    const intent = store.findGateResolution(gateKey);
    const outbox = store.findGateResolutionOutbox(gateKey);
    const message = store.findGateMessage(gateKey);
    const localObservation = store.findGateLocalObservation(gateKey);
    const delivery = store.findGateChannelDelivery(gateKey);
    const resume = store.findGateResumeObservation(gateKey);
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
    const fencedDelivery = delivery === null ? null : store.findGateChannelDelivery(gateKey);
    if (delivery !== null && fencedDelivery?.revision !== delivery.revision) continue;
    const channelClaim = delivery !== null &&
      delivery.deferredOutboxRevision === outbox.revision
      ? {
          expectedDeliveryRevision: delivery.revision,
          expectedOutboxRevision: outbox.revision,
        }
      : undefined;
    const card = renderGateResolutionCard(intent, outbox, delivery, resume);
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
      if (!outbox.cardPending) {
        if (!store.rearmGateOutboxProjection(
          gateKey,
          outbox.revision,
          now().toISOString(),
        )) {
          continue;
        }
        // The renderer drift is now a durable pending generation. Never lease or call Slack from
        // the completed snapshot: re-read the advanced row so stale owners/completions are fenced.
        await fault?.('after_outbox_rearm_before_reread', gateKey);
        continue;
      }
      const lease = store.acquireGateOutboxProjection(
        gateKey,
        outbox.revision,
        projectionOwner,
        now().toISOString(),
        channelClaim,
      );
      if (lease === 'busy') return { kind: 'pending', card, fingerprint };
      // D3-2 re-arms the shared card outbox atomically but deliberately leaves its exact
      // Channel-originated generation for D3-3. Do not spin this loop or make a Slack call.
      if (lease === 'deferred') return { kind: 'pending', card, fingerprint };
      if (lease === 'superseded') continue;
      if (lease === 'recovered') {
        ownsProjection = true;
        ownedChannelClaim = channelClaim;
        continue;
      }
      ownsProjection = true;
      ownedChannelClaim = channelClaim;
      if (message.renderFingerprint !== fingerprint) {
        let updated: Awaited<ReturnType<SlackPoster['update']>>;
        try {
          updated = await boundedSlackUpdate(slack, {
            channel: message.channelId,
            ts: message.messageTs,
            text: card.text,
            blocks: card.blocks,
          }, timeoutMs);
        } catch (error) {
          const released = store.releaseGateOutboxProjection(
            gateKey,
            projectionOwner,
            now().toISOString(),
            channelClaim,
          );
          ownsProjection = !released;
          if (released) ownedChannelClaim = undefined;
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
          const released = store.releaseGateOutboxProjection(
            gateKey,
            projectionOwner,
            now().toISOString(),
            channelClaim,
          );
          ownsProjection = !released;
          if (released) ownedChannelClaim = undefined;
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
    }
    if (store.markGateOutboxProjected(
      gateKey,
      outbox.revision,
      fingerprint,
      projectionOwner,
      now().toISOString(),
      channelClaim,
    )) {
      ownsProjection = false;
      ownedChannelClaim = undefined;
      store.recordGateAttempt(gateKey, 'card_projection', 'succeeded', null, now().toISOString());
      return { kind: 'projected', card, fingerprint };
    }
    store.recordGateAttempt(gateKey, 'card_projection', 'superseded', null, now().toISOString());
  }
    return { kind: 'pending', card: null, fingerprint: null };
  } finally {
    if (ownsProjection && !abandonProjection) {
      store.releaseGateOutboxProjection(
        gateKey,
        projectionOwner,
        now().toISOString(),
        ownedChannelClaim,
      );
    }
  }
}
