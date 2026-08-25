import { describe, expect, it } from 'vitest';

import { renderGateResolutionCard } from '../src/gate/resolution-render.js';
import type {
  GateChannelDelivery,
  GateResolutionIntent,
  GateResolutionOutbox,
  GateResumeObservation,
} from '../src/gate/resolution-types.js';
import { gateKey, runKey, taskKey } from '../src/identity/keys.js';

const GATE = gateKey('gate_resolution_render');
const AT = '2026-08-24T10:00:00.000Z';

function intent(value = 'source'): GateResolutionIntent {
  return {
    gateKey: GATE,
    revision: 1,
    ackState: 'acked',
    leaseOwner: null,
    leaseExpiresAt: null,
    retryRequestId: value,
    optionId: 'keep',
    optionResolution: '유지',
    askMessageId: value,
    questionThreadId: value,
    dispatchId: value,
    taskId: value,
    teamId: 'T0TEAM',
    ownerUserId: 'U0OWNER',
    apiAppId: null,
    channelId: 'C0CHANNEL',
    threadTs: '1787554800.000001',
    messageTs: '1787554800.000002',
    blockId: 'gate_block',
    actionId: 'gate_action',
    actionValue: 'keep',
    lifecycle: 'resolved',
    mutationOwnership: 'structured',
    preRead: null,
    resolveResult: {
      gate: {
        gateId: GATE.slice('gate:'.length),
        runId: 'run_render',
        taskId: value,
        options: ['유지'],
        status: 'resolved',
        resolution: '유지',
        resolvedAt: AT,
      },
      mutation: { requestId: value, replayed: false },
    },
    postRead: null,
    lastErrorCode: null,
    lastErrorDetail: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

const outbox: GateResolutionOutbox = {
  gateKey: GATE,
  revision: 1,
  cardState: 'resolved',
  cardPending: true,
  notificationState: 'pending',
  projectedAt: null,
  lastErrorCode: null,
  createdAt: AT,
  updatedAt: AT,
};

function delivery(source = 'source'): GateChannelDelivery {
  return {
    gateKey: GATE,
    runKey: runKey('run_render'),
    taskKey: taskKey(source),
    sourceDispatchId: source,
    revision: 1,
    deferredOutboxRevision: 1,
    resumeBaselineState: 'recorded',
    state: 'consumed',
    attemptCount: 1,
    lastAttemptAt: AT,
    nextAttemptAt: null,
    receiptedAt: AT,
    consumedAt: AT,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function resume(taskId: string, dispatchId: string): GateResumeObservation {
  const source = {
    taskId: 'source',
    status: 'completed',
    currentDispatchId: 'source',
    dispatches: [{ dispatchId: 'source', status: 'completed' }],
  } as const;
  const resumed = {
    taskId,
    status: 'dispatched',
    currentDispatchId: dispatchId,
    dispatches: [{ dispatchId, status: 'dispatched' }],
  } as const;
  return {
    gateKey: GATE,
    revision: 1,
    baseline: {
      schemaVersion: 1,
      sourceTaskId: 'source',
      sourceDispatchId: 'source',
      candidates: [source],
    },
    latest: {
      schemaVersion: 1,
      sourceTaskId: 'source',
      sourceDispatchId: 'source',
      candidates: [source, resumed],
    },
    evidence: {
      kind: 'new_dispatch',
      taskId,
      dispatchId,
      fromStatus: null,
      toStatus: 'dispatched',
    },
    nextObservationAt: null,
    observedAt: AT,
    leaseOwner: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

describe('Gate resume resolution renderer', () => {
  it('escapes exact evidence IDs in Slack mrkdwn fallback while preserving plain-text IDs', () => {
    const card = renderGateResolutionCard(
      intent(),
      outbox,
      delivery(),
      resume('<!channel>', '<@U123>'),
    );

    expect(card.text).toContain('Task &lt;!channel&gt; · Dispatch &lt;@U123&gt;');
    expect(card.text).not.toContain('Task <!channel> · Dispatch <@U123>');
    expect(JSON.stringify(card.blocks)).toContain('Task <!channel> · Dispatch <@U123>');
  });

  it('keeps every Slack section within 3000 characters without truncating evidence IDs', () => {
    const source = 's'.repeat(500);
    const taskId = 't'.repeat(500);
    const dispatchId = 'd'.repeat(500);
    const card = renderGateResolutionCard(
      intent(source),
      outbox,
      delivery(source),
      resume(taskId, dispatchId),
    );

    for (const block of card.blocks) {
      const blockText = (block as { readonly text?: { readonly text?: string } }).text?.text;
      if (blockText !== undefined) expect(blockText.length).toBeLessThanOrEqual(3_000);
    }
    expect(JSON.stringify(card.blocks)).toContain(taskId);
    expect(JSON.stringify(card.blocks)).toContain(dispatchId);
  });
});
