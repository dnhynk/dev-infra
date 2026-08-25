import type { RenderedCard } from '../digest/render.js';
import type { GateResolutionIntent, GateResolutionOutbox } from './resolution-types.js';

function cut(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, Math.max(0, cap - 1))}…`;
}

/** Deterministic D2 card. It deliberately projects only a pending D3 notification. */
export function renderGateResolutionCard(
  intent: GateResolutionIntent,
  outbox: GateResolutionOutbox,
): RenderedCard {
  const heading =
    outbox.cardState === 'resolving'
      ? '⏳ Gate 해결 중'
      : outbox.cardState === 'resolved'
        ? '✅ Gate 해결 확인'
        : outbox.cardState === 'conflict'
          ? '⚠️ Gate 해결 충돌'
          : '⚠️ Gate 해결 상태 확인 필요';
  const status =
    outbox.cardState === 'resolving'
      ? 'Orca의 최종 상태를 확인하고 있습니다.'
      : outbox.cardState === 'resolved'
        ? 'Orca Gate의 최종 resolution과 일치합니다.'
        : outbox.cardState === 'conflict'
          ? '다른 resolver의 결과 또는 예상과 다른 최종 상태를 관측했습니다.'
          : intent.lifecycle === 'uncertain'
            ? '원격 결과를 확정하지 못했습니다. 재시작 시 같은 retry request로 재조정합니다.'
            : intent.lastErrorCode === 'mutation_ownership_ambiguous'
              ? 'Orca Gate는 선택한 resolution으로 끝났지만 이 Bridge 요청의 결과인지 확인할 수 없어 자동 확정을 중단했습니다.'
              : '필수 sidecar 또는 mapping을 확인하지 못해 자동 해결을 중단했습니다.';
  const mutation =
    intent.resolveResult === null
      ? 'Orca mutation 응답 없음'
      : `Orca mutation ${intent.resolveResult.mutation.requestId} · replayed ${intent.resolveResult.mutation.replayed ? 'yes' : 'no'}`;
  return {
    text: `${outbox.cardState} · ${intent.gateKey.slice('gate:'.length)} · Coordinator 통지 대기`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text: `${heading} · ${cut(intent.gateKey.slice('gate:'.length), 500)}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text:
            `선택 ${intent.optionId}\n` +
            `resolution ${cut(intent.optionResolution, 2500)}\n` +
            `상태 ${status}\n` +
            `owner ${intent.ownerUserId} · 선택 시각 ${intent.createdAt}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'plain_text',
          text:
            'Coordinator 통지 대기\n' +
            `${mutation}\n` +
            `ask ${cut(intent.askMessageId, 500)} · thread ${cut(intent.questionThreadId, 500)}\n` +
            `dispatch ${cut(intent.dispatchId, 500)} · task ${cut(intent.taskId, 500)}`,
          emoji: true,
        },
      },
    ],
  };
}
