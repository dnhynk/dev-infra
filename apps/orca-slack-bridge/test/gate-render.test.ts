import { describe, expect, it } from 'vitest';
import { renderFingerprint } from '../src/digest/render.js';
import { renderGateDecisionCard } from '../src/gate/render.js';
import {
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
} from '../src/gate/actions.js';
import type { GateDecisionFacts } from '../src/gate/types.js';
import { gateKey } from '../src/identity/keys.js';

function facts(over: Partial<GateDecisionFacts> = {}): GateDecisionFacts {
  return {
    key: gateKey('gate_static'),
    gateId: 'gate_static',
    runId: 'run_d2a',
    taskId: 'task_gate',
    question: '어느 production path를 선택할까?',
    status: 'pending',
    resolution: null,
    resolvedAt: null,
    metadataState: 'matched',
    correlation: {
      askMessageId: 'msg_ask',
      questionThreadId: 'thread_question',
      dispatchId: 'ctx_gate',
      taskId: 'task_gate',
      gateId: 'gate_static',
    },
    options: [
      { id: 'keep', label: '기존 유지', description: '호환성을 유지한다', resolution: '기존 유지' },
      { id: 'change', label: '변경', description: '새 방식으로 간다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', label: '기존 유지', reason: '사용자를 보호한다' },
    impact: '후속 Task 두 개의 구현 방향이 정해진다',
    waitingTasks: [
      { taskId: 'task_gate', title: 'Gate owner', status: 'blocked' },
      { taskId: 'task_after', title: 'Gate downstream', status: 'ready' },
    ],
    independentTasks: [{ taskId: 'task_side', title: 'Independent work', status: 'in_progress' }],
    unclassifiedTasks: [],
    degraded: [],
    ...over,
  };
}

function text(card: ReturnType<typeof renderGateDecisionCard>): string {
  return card.blocks
    .map((block) => {
      const raw = block['text'];
      return typeof raw === 'object' && raw !== null && 'text' in raw
        ? String((raw as { text: unknown }).text)
        : '';
    })
    .join('\n');
}

describe('Gate decision renderer', () => {
  it('matched pending Gate만 stable option ID 기반 fixed actions로 그린다', () => {
    const card = renderGateDecisionCard(facts());
    const rendered = text(card);
    const json = JSON.stringify(card.blocks);

    expect(rendered).toContain('어느 production path를 선택할까?');
    expect(rendered).toContain('기존 유지');
    expect(rendered).toContain('사용자를 보호한다');
    expect(rendered).toContain('후속 Task 두 개');
    expect(rendered).toContain('task_after');
    expect(rendered).toContain('task_side');
    expect(rendered).toContain('msg_ask');
    expect(rendered).toContain('ctx_gate');
    expect(card.blocks.filter((block) => block['type'] === 'actions')).toHaveLength(2);
    expect(json).toContain('"type":"button"');
    expect(json).toContain('orca_gate_fixed_options_v1');
    expect(json).toContain('orca_gate_resolve_v1');
    expect(json).toContain('orca_gate_direct_open_v1');
    expect(json).toContain('orca_gate_direct_controls_v1');
    expect(json).toContain('직접 입력');
    expect(json).toContain('"value":"keep"');
    expect(json).toContain('"value":"change"');
    expect(json).toContain(gateDirectBlockId(facts().key));
    expect(json).toContain(gateDirectActionId(facts().key));
    expect(json).toContain(gateDirectActionValue(facts().key));
  });

  it('25 fixed options와 Gate-specific direct action을 서로 다른 actions block에 둔다', () => {
    const options = Array.from({ length: 25 }, (_, index) => ({
      id: `option_${index}`,
      label: `선택 ${index}`,
      description: `설명 ${index}`,
      resolution: `결정 ${index}`,
    }));
    const card = renderGateDecisionCard(facts({ options }));
    const actionBlocks = card.blocks.filter((block) => block['type'] === 'actions');
    expect(actionBlocks).toHaveLength(2);
    expect((actionBlocks[0]?.['elements'] as readonly unknown[])).toHaveLength(25);
    expect((actionBlocks[1]?.['elements'] as readonly unknown[])).toHaveLength(1);
    expect(actionBlocks[0]?.['block_id']).not.toBe(actionBlocks[1]?.['block_id']);
  });

  it('degraded card는 recommendation/impact를 추측하지 않고 판정 불가 Task를 드러낸다', () => {
    const card = renderGateDecisionCard(
      facts({
        metadataState: 'missing',
        correlation: null,
        options: [{ id: null, label: 'raw label', description: null, resolution: null }],
        recommendation: null,
        impact: null,
        waitingTasks: [],
        independentTasks: [],
        unclassifiedTasks: [
          { taskId: 'task_unknown', title: 'deps unreadable', status: 'ready' },
        ],
        degraded: ['Gate gate_static의 sidecar metadata가 없다'],
      }),
    );
    const rendered = text(card);
    expect(rendered).toContain('sidecar metadata가 없거나 어긋나 표시하지 않음');
    expect(rendered).toContain('추측하지 않음');
    expect(rendered).toContain('task_unknown');
    expect(rendered).toContain('independent로 접지 않았다');
    expect(rendered).toContain('action correlation 사용 불가');
    expect(JSON.stringify(card.blocks)).not.toContain('button');
  });

  it('resolved Gate는 Orca resolution을 정적 기록으로 표시한다', () => {
    const card = renderGateDecisionCard(
      facts({
        status: 'resolved',
        resolution: '기존 유지',
        resolvedAt: '2026-08-24T08:00:00.000Z',
      }),
    );
    expect(card.text).toContain('Gate 결정 기록');
    expect(text(card)).toContain('resolved_at 2026-08-24T08:00:00.000Z');
  });

  it('동일 facts는 동일 card/fingerprint를 만든다', () => {
    const a = renderGateDecisionCard(facts());
    const b = renderGateDecisionCard(facts());
    expect(a).toEqual(b);
    expect(renderFingerprint(a)).toBe(renderFingerprint(b));
  });
});
