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
import {
  cardText,
  fieldValue,
  footerText,
  headerText,
  sectionTexts,
} from './card-text.js';

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

const CONTEXT = { runObjective: 'Slack 카드 개편\n둘째 줄', project: 'dev-infra' };

describe('Gate decision renderer', () => {
  it('matched pending Gate만 stable option ID 기반 fixed actions로 그린다', () => {
    const card = renderGateDecisionCard(facts(), CONTEXT);
    const json = JSON.stringify(card.blocks);

    expect(headerText(card)).toBe('❓  결정 필요 · 어느 production path를 선택할까?');
    expect(card.attachments?.[0]?.color).toBe('#bf8700');
    expect(fieldValue(card, 'Run')).toBe('Slack 카드 개편');
    expect(fieldValue(card, 'Project')).toBe('dev-infra');
    expect(fieldValue(card, '권장')).toBe('기존 유지');
    expect(fieldValue(card, '영향')).toBe('후속 Task 두 개의 구현 방향이 정해진다');
    expect(fieldValue(card, '대기 Task')).toBe('2개');
    expect(fieldValue(card, '계속 가능')).toBe('1개');
    expect(fieldValue(card, '대기 중')).toBe('Gate owner\nGate downstream');
    expect(fieldValue(card, '판정 제한')).toBe('없음');
    expect(sectionTexts(card)).toEqual([
      '권장 이유: 사용자를 보호한다',
      '*선택지*\n기존 유지 — 호환성을 유지한다\n변경 — 새 방식으로 간다',
    ]);
    // 열린 카드에는 시각이 없다.
    expect(footerText(card)).toBe('orca-slack-bridge · Coordinator 질문 · 등록 상세 기준');

    // 버튼은 최상위에만 있고 기계 판정 ID는 그대로다.
    expect(card.blocks.filter((block) => block['type'] === 'actions')).toHaveLength(2);
    expect(JSON.stringify(card.attachments)).not.toContain('"type":"actions"');
    expect(json).toContain('"type":"button"');
    expect(json).toContain('orca_gate_fixed_options_v1');
    expect(json).toContain('orca_gate_resolve_v1');
    expect(json).toContain('orca_gate_direct_open_v1');
    expect(json).toContain('orca_gate_direct_controls_v1');
    expect(json).toContain('직접 입력');
    expect(json).toContain('"value":"keep"');
    expect(json).toContain('"value":"change"');
    expect(json).toContain('"style":"primary"');
    expect(json).toContain(gateDirectBlockId(facts().key));
    expect(json).toContain(gateDirectActionId(facts().key));
    expect(json).toContain(gateDirectActionValue(facts().key));
  });

  it('Gate·Task·Run ID와 correlation, option ID를 카드에 보이지 않는다', () => {
    const shown = cardText(renderGateDecisionCard(facts(), CONTEXT));
    for (const id of ['gate_static', 'task_gate', 'task_after', 'task_side', 'run_d2a', 'msg_ask',
      'thread_question', 'ctx_gate', '(keep)']) {
      expect(shown).not.toContain(id);
    }
  });

  it('25 fixed options와 Gate-specific direct action을 서로 다른 actions block에 둔다', () => {
    const options = Array.from({ length: 25 }, (_, index) => ({
      id: `option_${index}`,
      label: `선택 ${index}`,
      description: `설명 ${index}`,
      resolution: `결정 ${index}`,
    }));
    const card = renderGateDecisionCard(facts({ options }), CONTEXT);
    const actionBlocks = card.blocks.filter((block) => block['type'] === 'actions');
    expect(actionBlocks).toHaveLength(2);
    expect((actionBlocks[0]?.['elements'] as readonly unknown[])).toHaveLength(25);
    expect((actionBlocks[1]?.['elements'] as readonly unknown[])).toHaveLength(1);
    expect(actionBlocks[0]?.['block_id']).not.toBe(actionBlocks[1]?.['block_id']);
  });

  it('degraded card는 recommendation/impact를 추측하지 않고 판정 불가 Task와 제한 수를 드러낸다', () => {
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
      CONTEXT,
    );
    expect(fieldValue(card, '권장')).toBe('확인 불가 · 상세 미등록');
    expect(fieldValue(card, '영향')).toBe('확인 불가 · 상세 미등록');
    expect(fieldValue(card, '대기 중')).toBe('없음');
    // 사유 문장은 ID를 싣고 있어 카드에는 수만 둔다. 사유는 `runs` 보고가 출력한다.
    expect(fieldValue(card, '판정 제한')).toBe('1건 · runs 보고 참고\n의존 판정 불가 Task 1개');
    expect(sectionTexts(card)).toEqual([
      '선택지를 Orca 기록과 맞추지 못해 버튼을 만들지 않았습니다 → Orca에서 직접 결정하세요.',
      '*선택지*\nraw label',
    ]);
    expect(footerText(card)).toBe('orca-slack-bridge · Coordinator 질문 · Orca 기록 기준');
    expect(cardText(card)).not.toContain('task_unknown');
    expect(cardText(card)).not.toContain('gate_static');
    expect(JSON.stringify(card)).not.toContain('button');
  });

  it('resolved Gate는 Orca resolution과 결정 시각을 정적 기록으로 표시한다', () => {
    const card = renderGateDecisionCard(
      facts({
        status: 'resolved',
        resolution: '기존 유지',
        resolvedAt: '2026-08-24T08:00:00.000Z',
      }),
      CONTEXT,
    );
    expect(card.text).toContain('결정됨');
    expect(headerText(card)).toBe('✅  결정됨 · 어느 production path를 선택할까?');
    expect(card.attachments?.[0]?.color).toBe('#1a7f37');
    expect(fieldValue(card, '결정')).toBe('기존 유지');
    // 결정 시각은 KST로 옮긴다(+9시간 고정).
    expect(footerText(card)).toBe('orca-slack-bridge · 08-24 17:00:00 KST 결정 · Orca Gate 기준');
    expect(card.blocks.some((block) => block['type'] === 'actions')).toBe(false);
  });

  it('Run 정보 없이 그리면 빈칸 대신 확인 불가를 쓴다', () => {
    const card = renderGateDecisionCard(facts());
    expect(fieldValue(card, 'Run')).toBe('확인 불가 · Run 정보 없음');
    expect(fieldValue(card, 'Project')).toBe('확인 불가 · Run 정보 없음');
  });

  it('동일 facts는 동일 card/fingerprint를 만든다', () => {
    const a = renderGateDecisionCard(facts(), CONTEXT);
    const b = renderGateDecisionCard(facts(), CONTEXT);
    expect(a).toEqual(b);
    expect(renderFingerprint(a)).toBe(renderFingerprint(b));
  });
});
