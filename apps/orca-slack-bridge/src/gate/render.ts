import type { RenderedCard } from '../digest/render.js';
import type { SlackBlock } from '../slack/post.js';
import type { GateDecisionFacts, GateTaskFacts } from './types.js';
import {
  gateActionId,
  gateBlockId,
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
} from './actions.js';

const SECTION_TEXT_CAP = 3000;
const SECTION_TRUNCATION_MARK = '\n…(표시 한도 3000자를 넘어 잘림)';
const DETAIL_CAP = 500;
const TASK_CAP = 20;

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cut(value: string, cap: number): string {
  const trimmed = value.trim();
  return trimmed.length <= cap ? trimmed : `${trimmed.slice(0, cap)}…`;
}

function capSectionText(text: string): string {
  if (text.length <= SECTION_TEXT_CAP) return text;
  const budget = SECTION_TEXT_CAP - SECTION_TRUNCATION_MARK.length;
  let end = 0;
  for (const point of text) {
    if (end + point.length > budget) break;
    end += point.length;
  }
  return `${text.slice(0, end)}${SECTION_TRUNCATION_MARK}`;
}

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: capSectionText(text) } };
}

function labelled(label: string, lines: readonly string[]): SlackBlock {
  return section([`*${label}*`, ...lines].join('\n'));
}

/** 작은 글씨 한 줄. 결정에 쓰지 않는 운영 사실을 지우지 않고 뒤로 물린다. */
function context(lines: readonly string[]): SlackBlock {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: capSectionText(lines.join('  ·  ')) }],
  };
}

function taskLines(tasks: readonly GateTaskFacts[]): readonly string[] {
  if (tasks.length === 0) return ['없음'];
  const shown = tasks.slice(0, TASK_CAP).map((task) => {
    const title = task.title.trim() === '' ? '(title 없음)' : cut(task.title, DETAIL_CAP);
    return `• ${esc(task.taskId)} · ${esc(task.status)} · ${esc(title)}`;
  });
  if (tasks.length > TASK_CAP) return [...shown, `• 외 ${tasks.length - TASK_CAP}건은 카드에 싣지 않았다`];
  return shown;
}

/**
 * Render a Gate card. Only an exactly correlated pending fixed-option Gate receives actions.
 *
 * 이 카드는 사람이 자리에 없을 때 폰에서 읽고 누르는 화면이다. 그래서 **결정에 필요한 것이
 * 먼저 오고, 운영 디버그 사실은 작은 글씨로 뒤로 간다.** 표시하는 사실은 스펙 §6.2가 요구하는
 * 여덟 가지 그대로이며 무엇도 빼지 않는다 — 순서와 무게만 결정 순서에 맞춘다:
 * 질문 → 권장과 이유 → 선택지 → 영향 → 무엇이 막히나 → 버튼 → correlation/degraded.
 */
export function renderGateDecisionCard(gate: GateDecisionFacts): RenderedCard {
  const open = gate.status === 'pending';
  const headline = open ? '⚠️ 결정 필요' : '✅ Gate 결정 기록';
  // 질문이 headline 본문이다. 이전에는 gate id가 큰 줄이고 질문이 `*문제*` 라벨 아래 있었는데,
  // 폰에서 먼저 읽어야 하는 것은 id가 아니라 무엇을 물었는가다.
  const blocks: SlackBlock[] = [
    section(`${headline}\n*${esc(cut(gate.question, SECTION_TEXT_CAP)) || '(question 없음)'}*`),
    context([`gate ${esc(gate.gateId)}`, `task ${esc(gate.taskId)}`, `run ${esc(gate.runId)}`]),
  ];

  // 권장을 선택지보다 먼저 둔다. 3초 안에 누르려는 사람이 찾는 한 줄이다.
  blocks.push(
    labelled(
      'Coordinator 권장',
      gate.recommendation === null
        ? ['sidecar metadata가 없거나 어긋나 표시하지 않음']
        : [
            `*${esc(gate.recommendation.label)}* (${esc(gate.recommendation.optionId)})`,
            `_이유 · ${esc(cut(gate.recommendation.reason, DETAIL_CAP))}_`,
          ],
    ),
  );

  const optionLines: string[] = [];
  if (gate.options.length === 0) {
    optionLines.push('표시할 option 없음');
  } else {
    for (const option of gate.options) {
      // 라벨과 설명을 한 줄로 잇는다. 두 줄로 나누면 선택지 넷이 여덟 줄이 되고 버튼이
      // 화면 밖으로 밀린다.
      const description = option.description === null
        ? '설명 metadata 없음'
        : esc(cut(option.description, DETAIL_CAP));
      optionLines.push(`• *${esc(cut(option.label, DETAIL_CAP))}* — ${description}`);
    }
  }
  blocks.push(labelled('선택지', optionLines));

  blocks.push(
    labelled(
      '영향',
      gate.impact === null
        ? ['sidecar metadata가 없거나 어긋나 추측하지 않음']
        : [esc(cut(gate.impact, SECTION_TEXT_CAP))],
    ),
  );

  // 대기와 계속 가능은 서로 대조해서 읽는 사실이다("이 결정을 미루면 무엇이 멈추나").
  // 한 블록에 나란히 두어야 그 대조가 보인다.
  const blocked: string[] = [
    `*이 Gate 때문에 대기* (${gate.waitingTasks.length}건)`,
    ...taskLines(gate.waitingTasks),
    `*독립적으로 계속 가능* (${gate.independentTasks.length}건)`,
    ...taskLines(gate.independentTasks),
  ];
  if (gate.unclassifiedTasks.length > 0) {
    blocked.push(`*dependency 판정 불가* (${gate.unclassifiedTasks.length}건)`);
    blocked.push(...taskLines(gate.unclassifiedTasks));
    blocked.push('deps를 읽지 못했거나 dependency row가 없어 independent로 접지 않았다');
  }
  blocks.push(section(blocked.join('\n')));

  const actionable =
    gate.status === 'pending' &&
    gate.metadataState === 'matched' &&
    gate.correlation !== null &&
    gate.options.length > 0 &&
    gate.options.every(
      (option) => option.id !== null && option.description !== null && option.resolution !== null,
    );
  if (actionable) {
    blocks.push({
      type: 'actions',
      block_id: gateBlockId(gate.key),
      elements: gate.options.map((option) => ({
        type: 'button',
        text: { type: 'plain_text', text: cut(option.label, 75), emoji: true },
        action_id: gateActionId(gate.key, option.id ?? ''),
        value: option.id,
        ...(gate.recommendation?.optionId === option.id ? { style: 'primary' } : {}),
      })),
    });
  }

  const directActionable =
    gate.status === 'pending' && gate.metadataState === 'matched' && gate.correlation !== null;
  if (directActionable) {
    blocks.push({
      type: 'actions',
      block_id: gateDirectBlockId(gate.key),
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '직접 입력', emoji: true },
        action_id: gateDirectActionId(gate.key),
        value: gateDirectActionValue(gate.key),
      }],
    });
  }

  if (gate.resolution !== null) {
    blocks.push(
      labelled('Orca Gate resolution', [
        esc(cut(gate.resolution, SECTION_TEXT_CAP)),
        gate.resolvedAt === null ? 'resolved_at 없음' : `resolved_at ${esc(gate.resolvedAt)}`,
      ]),
    );
  }

  // correlation ID와 degraded는 운영자가 추적할 때 필요한 사실이지 결정에 쓰는 사실이 아니다.
  // 지우지 않되 버튼 아래 작은 글씨로 내린다. degraded는 owner가 알아야 하므로 앞에 둔다.
  const correlation = gate.correlation;
  const footnotes: string[] = [];
  if (gate.degraded.length > 0) {
    footnotes.push(`degraded — ${gate.degraded.map((r) => esc(cut(r, DETAIL_CAP))).join(' · ')}`);
  } else {
    footnotes.push('degraded 없음');
  }
  footnotes.push(
    correlation === null
      ? `metadata ${esc(gate.metadataState)} · action correlation 사용 불가`
      : `correlation · ask ${esc(correlation.askMessageId)} · thread ${esc(correlation.questionThreadId)}` +
        ` · dispatch ${esc(correlation.dispatchId)} · task ${esc(correlation.taskId)}` +
        ` · gate ${esc(correlation.gateId)}`,
  );
  blocks.push(context(footnotes));

  const question = cut(gate.question, 160) || '(question 없음)';
  return {
    text: `${headline} · ${esc(gate.gateId)} · ${esc(question)}`,
    blocks,
  };
}
