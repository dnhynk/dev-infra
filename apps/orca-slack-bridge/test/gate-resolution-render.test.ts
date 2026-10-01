import { describe, expect, it } from 'vitest';

import { GATE_DIRECT_OPTION_ID } from '../src/gate/direct-input-types.js';
import { renderGateResolutionCard } from '../src/gate/resolution-render.js';
import type {
  GateChannelDelivery,
  GateResolutionIntent,
  GateResolutionOutbox,
  GateResumeObservation,
} from '../src/gate/resolution-types.js';
import { gateKey, runKey, taskKey } from '../src/identity/keys.js';
import { fieldValue, footerText, headerText, sectionTexts, visibleTexts } from './card-text.js';

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
  it('does not show evidence, correlation, owner, or mutation IDs anywhere on the card', () => {
    const card = renderGateResolutionCard(
      intent('ctx_source_1234'),
      outbox,
      delivery(),
      resume('task_<!channel>', 'ctx_<@U123>'),
    );
    const shown = JSON.stringify(card);

    for (const hidden of ['<!channel>', '<@U123>', 'ctx_source_1234', 'U0OWNER', 'gate_resolution_render',
      'replayed', 'mutation']) {
      expect(shown).not.toContain(hidden);
    }
    expect(card.text).toBe('resolved · 유지 · ▶️ 작업 재개');
    expect(headerText(card)).toBe('▶️  작업 재개 · 유지');
    expect(fieldValue(card, '후속 Task')).toBe('재개 관찰 · 새 Dispatch 시작');
  });

  it('keeps every Slack field and section within its limit and never echoes long IDs', () => {
    const source = 's'.repeat(500);
    const taskId = 't'.repeat(500);
    const dispatchId = 'd'.repeat(500);
    const card = renderGateResolutionCard(
      { ...intent(source), optionResolution: '결'.repeat(5_000) },
      outbox,
      delivery(source),
      resume(taskId, dispatchId),
    );

    for (const text of visibleTexts(card)) expect(text.length).toBeLessThanOrEqual(3_000);
    expect(headerText(card).length).toBeLessThanOrEqual(150);
    expect((fieldValue(card, '결정') ?? '').length).toBeLessThanOrEqual(2_000);
    expect(JSON.stringify(card)).not.toContain(taskId);
    expect(JSON.stringify(card)).not.toContain(dispatchId);
    expect(JSON.stringify(card)).not.toContain(source);
  });

  it('keeps the lifecycle labels verbatim in the fallback and never claims resume early', () => {
    const waiting = renderGateResolutionCard(intent(), outbox, null, null);
    expect(waiting.text).toBe('resolved · 유지 · Coordinator 통지 대기');
    expect(headerText(waiting)).toBe('✅  결정됨 · 유지');
    expect(fieldValue(waiting, '결정')).toBe('유지');
    expect(fieldValue(waiting, 'Orca 반영')).toBe('확인됨');
    expect(fieldValue(waiting, '선택 방식')).toBe('버튼');
    // 선택 시각만 싣는다. 투영이 다시 그려도 움직이지 않는다.
    expect(footerText(waiting)).toBe('orca-slack-bridge · 08-24 19:00:00 KST 선택 · Orca Gate 기준');

    const receipted = renderGateResolutionCard(
      intent(), outbox, { ...delivery(), state: 'receipted', consumedAt: null }, null,
    );
    expect(receipted.text).toContain('Coordinator 확인됨 · 후속 Task 재개 미관찰');
    for (const card of [waiting, receipted]) {
      expect(JSON.stringify(card)).not.toContain('작업 재개');
    }
  });

  it('paints resolving, conflict, and degraded states with their cause and action', () => {
    const resolving = renderGateResolutionCard(
      intent(), { ...outbox, cardState: 'resolving' }, null, null,
    );
    expect(resolving.text.startsWith('resolving · ')).toBe(true);
    expect(headerText(resolving)).toBe('⏳  반영 중 · 유지');
    expect(resolving.attachments?.[0]?.color).toBe('#2f81f7');
    expect(fieldValue(resolving, 'Orca 반영')).toBe('확인 중');

    const conflict = renderGateResolutionCard(
      intent(), { ...outbox, cardState: 'conflict' }, null, null,
    );
    expect(headerText(conflict)).toBe('⛔  충돌 · 유지');
    expect(conflict.attachments?.[0]?.color).toBe('#cf222e');
    expect(sectionTexts(conflict)).toEqual(['다른 결정이 먼저 기록됐습니다 → Orca에서 확인하세요.']);

    const uncertain = renderGateResolutionCard(
      { ...intent(), lifecycle: 'uncertain' }, { ...outbox, cardState: 'degraded' }, null, null,
    );
    expect(headerText(uncertain)).toBe('⚠️  확인 필요 · 유지');
    expect(uncertain.attachments?.[0]?.color).toBe('#bf8700');
    expect(fieldValue(uncertain, 'Orca 반영')).toBe('확인 불가 · 원격 결과 미확정');
    expect(sectionTexts(uncertain)).toHaveLength(1);
  });

  it('shows a direct-input decision as 직접 입력 instead of the reserved option id', () => {
    const card = renderGateResolutionCard(
      { ...intent(), optionId: GATE_DIRECT_OPTION_ID, optionResolution: 'B로 가되 enterprise는 유지' },
      outbox,
    );
    expect(headerText(card)).toBe('✅  결정됨 · 직접 입력');
    expect(fieldValue(card, '결정')).toBe('B로 가되 enterprise는 유지');
    expect(fieldValue(card, '선택 방식')).toBe('직접 입력');
    expect(JSON.stringify(card)).not.toContain(GATE_DIRECT_OPTION_ID);
  });
});
