import type { RenderedCard } from '../digest/render.js';
import { cut, esc, renderCardShell, type CardTone } from '../slack/card.js';
import type {
  GateCardState,
  GateChannelDelivery,
  GateResolutionIntent,
  GateResolutionOutbox,
  GateResumeObservation,
} from './resolution-types.js';
import { GATE_DIRECT_OPTION_ID } from './direct-input-types.js';

const RESOLUTION_CAP = 1500;

type ResolutionHead = { readonly tone: CardTone; readonly emoji: string; readonly kind: string };

const STATE_HEAD: Readonly<Record<GateCardState, ResolutionHead>> = {
  resolving: { tone: 'entry', emoji: '⏳', kind: '반영 중' },
  resolved: { tone: 'success', emoji: '✅', kind: '결정됨' },
  conflict: { tone: 'error', emoji: '⛔', kind: '충돌' },
  degraded: { tone: 'attention', emoji: '⚠️', kind: '확인 필요' },
};

/** 실제 Orca 상태로 후속 작업 재개를 관찰했을 때만 쓰는 머리. */
const RESUMED_HEAD: ResolutionHead = { tone: 'success', emoji: '▶️', kind: '작업 재개' };

/** 확인 필요 카드의 원인과 할 일. 원격 결과를 모르는 것과 사람의 확인이 필요한 것을 가른다. */
function degradedReason(intent: GateResolutionIntent): { readonly value: string; readonly note: string } {
  if (intent.lifecycle === 'uncertain') {
    return {
      value: '확인 불가 · 원격 결과 미확정',
      note: '원격 결과를 확정하지 못했습니다 → 재시작하면 같은 요청으로 다시 맞춥니다.',
    };
  }
  if (intent.lastErrorCode === 'mutation_ownership_ambiguous') {
    return {
      value: '확인 불가 · 요청 소유 불명',
      note: 'Orca Gate는 선택한 결정으로 끝났지만 이 Bridge 요청의 결과인지 확인하지 못했습니다 → Orca에서 확인하세요.',
    };
  }
  return {
    value: '확인 불가 · sidecar·매핑 미확인',
    note: '필수 sidecar 또는 매핑을 확인하지 못해 자동 해결을 멈췄습니다 → Orca에서 확인하세요.',
  };
}

/**
 * Deterministic D2 card. It deliberately projects only a pending D3 notification.
 *
 * 카드는 결정 내용, Orca 반영 상태, 후속 Task 상태, 선택 방식만 싣는다. 누른 사람의 Slack ID,
 * Orca mutation request ID와 replay 여부, ask·thread·Dispatch·Task ID는 싣지 않는다(DL-074) —
 * 누가 결정했는지와 요청 ID는 store의 resolution row(`gate_resolution`)에 있다.
 *
 * **현재 시각을 읽지 않는다.** footer 시각은 선택 시각(`createdAt`)이다. 바뀐 카드는
 * `rearmGateOutboxProjection`을 다시 걸기 때문에(`resolution-project.ts`) 움직이는 값을 그리면
 * 투영이 끝나지 않는다.
 *
 * 대체 텍스트는 `cardState`와 후속 Task 라벨을 그대로 싣는다. channel 전달·재개 lifecycle 테스트가 이
 * 라벨로 상태를 읽는다. `작업 재개`는 재개 증거가 있을 때만 나온다 — Channel 전달이나 receipt만으로
 * 쓰지 않는다(스펙 §6.3).
 */
export function renderGateResolutionCard(
  intent: GateResolutionIntent,
  outbox: GateResolutionOutbox,
  delivery: GateChannelDelivery | null = null,
  resume: GateResumeObservation | null = null,
): RenderedCard {
  const evidence = resume?.evidence ?? null;
  const resumeLabel = evidence !== null
    ? '▶️ 작업 재개'
    : delivery?.state === 'receipted' || delivery?.state === 'consumed'
      ? 'Coordinator 확인됨 · 후속 Task 재개 미관찰'
      : 'Coordinator 통지 대기';
  const followUp = evidence === null
    ? resumeLabel
    : evidence.kind === 'new_dispatch'
      ? '재개 관찰 · 새 Dispatch 시작'
      : `재개 관찰 · Task 상태 ${evidence.toStatus === 'completed' ? '완료' : '진행'}`;
  const head = evidence === null ? STATE_HEAD[outbox.cardState] : RESUMED_HEAD;
  const direct = intent.optionId === GATE_DIRECT_OPTION_ID;
  const degraded = outbox.cardState === 'degraded' ? degradedReason(intent) : null;
  const reflected =
    outbox.cardState === 'resolving'
      ? '확인 중'
      : outbox.cardState === 'resolved'
        ? '확인됨'
        : outbox.cardState === 'conflict'
          ? '충돌 · 다른 결정 먼저 기록'
          : degraded?.value ?? '확인 불가';
  const note =
    outbox.cardState === 'conflict'
      ? '다른 결정이 먼저 기록됐습니다 → Orca에서 확인하세요.'
      : degraded?.note ?? null;

  return renderCardShell({
    tone: head.tone,
    emoji: head.emoji,
    kind: head.kind,
    head: direct ? '직접 입력' : intent.optionResolution,
    text: `${outbox.cardState} · ${esc(cut(intent.optionResolution, 80))} · ${resumeLabel}`,
    fields: [
      ['결정', esc(cut(intent.optionResolution, RESOLUTION_CAP))],
      ['Orca 반영', reflected],
      ['후속 Task', followUp],
      ['선택 방식', direct ? '직접 입력' : '버튼'],
    ],
    sections: note === null ? [] : [note],
    footer: { at: intent.createdAt, verb: '선택', basis: 'Orca Gate 기준' },
  });
}
