import type { RenderedCard } from '../digest/render.js';
import type { SlackBlock } from '../slack/post.js';
import type { GateDecisionFacts, GateTaskFacts } from './types.js';

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
 * Render a static Gate decision card. This module intentionally cannot create `actions` or `button`
 * blocks; D2-C/D own those producers together with their consumers.
 */
export function renderGateDecisionCard(gate: GateDecisionFacts): RenderedCard {
  const open = gate.status === 'pending';
  const headline = open ? '⚠️ 결정 필요' : '✅ Gate 결정 기록';
  const blocks: SlackBlock[] = [
    section(`${headline} · *${esc(gate.gateId)}* · task ${esc(gate.taskId)}`),
    labelled('문제', [esc(cut(gate.question, SECTION_TEXT_CAP)) || '(question 없음)']),
  ];

  const optionLines: string[] = [];
  if (gate.options.length === 0) {
    optionLines.push('표시할 option 없음');
  } else {
    for (const option of gate.options) {
      optionLines.push(`• *${esc(cut(option.label, DETAIL_CAP))}*`);
      optionLines.push(
        option.description === null
          ? '    설명 metadata 없음'
          : `    ${esc(cut(option.description, DETAIL_CAP))}`,
      );
    }
  }
  blocks.push(labelled('선택지', optionLines));

  blocks.push(
    labelled(
      'Coordinator 권장',
      gate.recommendation === null
        ? ['sidecar metadata가 없거나 어긋나 표시하지 않음']
        : [
            `${esc(gate.recommendation.label)} (${esc(gate.recommendation.optionId)})`,
            `이유 · ${esc(cut(gate.recommendation.reason, DETAIL_CAP))}`,
          ],
    ),
  );
  blocks.push(
    labelled(
      '영향',
      gate.impact === null
        ? ['sidecar metadata가 없거나 어긋나 추측하지 않음']
        : [esc(cut(gate.impact, SECTION_TEXT_CAP))],
    ),
  );

  blocks.push(labelled('이 Gate 때문에 대기', taskLines(gate.waitingTasks)));
  blocks.push(labelled('독립적으로 계속 가능', taskLines(gate.independentTasks)));
  if (gate.unclassifiedTasks.length > 0) {
    blocks.push(
      labelled('dependency 판정 불가', [
        ...taskLines(gate.unclassifiedTasks),
        'deps를 읽지 못했거나 dependency row가 없어 independent로 접지 않았다',
      ]),
    );
  }

  if (gate.resolution !== null) {
    blocks.push(
      labelled('Orca Gate resolution', [
        esc(cut(gate.resolution, SECTION_TEXT_CAP)),
        gate.resolvedAt === null ? 'resolved_at 없음' : `resolved_at ${esc(gate.resolvedAt)}`,
      ]),
    );
  }

  const correlation = gate.correlation;
  blocks.push(
    labelled(
      'correlation',
      correlation === null
        ? [`metadata ${gate.metadataState} · action correlation 사용 불가`]
        : [
            `ask ${esc(correlation.askMessageId)} · thread ${esc(correlation.questionThreadId)}`,
            `dispatch ${esc(correlation.dispatchId)} · task ${esc(correlation.taskId)} · gate ${esc(correlation.gateId)}`,
          ],
    ),
  );

  blocks.push(
    labelled(
      'degraded',
      gate.degraded.length === 0
        ? ['없음']
        : gate.degraded.map((reason) => `• ${esc(cut(reason, DETAIL_CAP))}`),
    ),
  );

  const question = cut(gate.question, 160) || '(question 없음)';
  return {
    text: `${headline} · ${esc(gate.gateId)} · ${esc(question)}`,
    blocks,
  };
}
