import type { RenderedCard } from '../digest/render.js';
import {
  cut,
  esc,
  listText,
  renderCardShell,
  type CardField,
  type CardFooter,
  type CardTone,
} from '../slack/card.js';
import type { SlackBlock } from '../slack/post.js';
import type { GateDecisionFacts } from './types.js';
import {
  gateActionId,
  gateBlockId,
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
} from './actions.js';

const DETAIL_CAP = 500;
const OBJECTIVE_CAP = 80;
const TITLE_CAP = 80;
/** `대기 중` 칸에 이름을 싣는 Task 수. 나머지는 수로 남긴다. */
const TITLE_LIST_CAP = 5;

/**
 * 결정 카드가 속한 Run. 결정 카드는 Run 카드와 다른 채널(`decisions`)에 놓이므로 어느 Run의
 * 결정인지 카드가 직접 말해야 한다. Run 카드가 그리는 것과 같은 값이다.
 */
export type GateCardContext = {
  readonly runObjective: string;
  readonly project: string | null;
};

type GateHead = { readonly tone: CardTone; readonly emoji: string; readonly kind: string };

const OPEN_HEAD: GateHead = { tone: 'attention', emoji: '❓', kind: '결정 필요' };
const RESOLVED_HEAD: GateHead = { tone: 'success', emoji: '✅', kind: '결정됨' };
/** pending도 resolved도 아닌 status. 지원하지 않는 Orca 상태를 결정된 것처럼 그리지 않는다. */
const UNKNOWN_HEAD: GateHead = { tone: 'status', emoji: '⚪', kind: '확인 불가' };

const NO_BUTTONS_NOTE =
  '선택지를 Orca 기록과 맞추지 못해 버튼을 만들지 않았습니다 → Orca에서 직접 결정하세요.';

/** sidecar 상세(권장·영향)가 없는 자리. 파생 행과 metadata가 없거나 어긋난 카드가 쓴다. */
const NO_DETAIL = '확인 불가 · 상세 미등록';

function titleLines(gate: GateDecisionFacts): string {
  if (gate.waitingTasks.length === 0) return '없음';
  const shown = gate.waitingTasks.slice(0, TITLE_LIST_CAP).map((task) =>
    task.title.trim() === '' ? '확인 불가 · 제목 없음' : esc(cut(task.title, TITLE_CAP)));
  const hidden = gate.waitingTasks.length - shown.length;
  return [...shown, ...(hidden > 0 ? [`외 ${hidden}개`] : [])].join('\n');
}

/**
 * 판정 제한 칸. **수만 싣는다.**
 *
 * `degraded` 사유 문장에는 Task·Gate ID가 들어 있다(`gate/project.ts`). 카드는 ID를 싣지 않으므로
 * 사유는 `runs` 보고(`formatRunObserveReport`)가 출력한다. dependency를 판정하지 못한 Task는
 * 독립으로 접지 않고 따로 센다.
 */
function limitValue(gate: GateDecisionFacts): string {
  const lines = [gate.degraded.length === 0 ? '없음' : `${gate.degraded.length}건 · runs 보고 참고`];
  if (gate.unclassifiedTasks.length > 0) {
    lines.push(`의존 판정 불가 Task ${gate.unclassifiedTasks.length}개`);
  }
  return lines.join('\n');
}

function optionLines(gate: GateDecisionFacts): readonly string[] {
  if (gate.options.length === 0) return ['표시할 option 없음'];
  // 라벨과 설명을 한 줄로 잇는다. 두 줄로 나누면 선택지 넷이 여덟 줄이 된다. 파생 행에는 설명이 없다.
  return gate.options.map((option) => option.description === null
    ? esc(cut(option.label, DETAIL_CAP))
    : `${esc(cut(option.label, DETAIL_CAP))} — ${esc(cut(option.description, DETAIL_CAP))}`);
}

/**
 * Render a Gate card. Only an exactly correlated pending fixed-option Gate receives actions.
 *
 * 이 카드는 사람이 자리에 없을 때 폰에서 읽고 누르는 화면이다. 그래서 질문과 버튼이 머리에 오고,
 * 그 아래 색 바 안에 Run·권장·영향·대기 Task가 칸으로 온다. 표시하는 사실은 스펙 §6.2가 요구하는
 * 여덟 가지다: 질문 → 버튼(선택지·직접 입력) → 권장과 이유 → 선택지 설명 → 영향 → 대기 Task와
 * 독립 Task.
 *
 * Gate·Task·Run ID, correlation(ask·thread·dispatch), option ID는 싣지 않는다(DL-074). 버튼의 기계
 * 판정은 store가 sidecar metadata로 다시 계산하고(`store/sqlite.ts`), 추적용 ID는 `runs` 보고에 있다.
 * 현재 시각을 읽지 않는다. 열린 카드에는 시각이 없고 결정된 카드는 Orca의 `resolvedAt`을 쓴다.
 */
export function renderGateDecisionCard(
  gate: GateDecisionFacts,
  context: GateCardContext | null = null,
): RenderedCard {
  const open = gate.status === 'pending';
  const resolved = gate.status === 'resolved';
  const head = open ? OPEN_HEAD : resolved ? RESOLVED_HEAD : UNKNOWN_HEAD;
  const question = gate.question.trim();

  const actions: SlackBlock[] = [];
  const actionable =
    gate.status === 'pending' &&
    gate.metadataState === 'matched' &&
    gate.correlation !== null &&
    gate.options.length > 0 &&
    // 설명은 카드를 읽는 데 쓰이지 누르는 데 쓰이지 않는다. 파생 행에는 설명이 없으므로
    // 여기서 요구하면 등록을 빠뜨린 Gate가 다시 누를 수 없는 카드가 된다.
    gate.options.every((option) => option.id !== null && option.resolution !== null);
  if (actionable) {
    actions.push({
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
    actions.push({
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

  const objective = context === null
    ? ''
    : cut(context.runObjective.split('\n')[0] ?? '', OBJECTIVE_CAP);
  const fields: CardField[] = [];
  if (!open && gate.resolution !== null) {
    fields.push(['결정', esc(cut(gate.resolution, DETAIL_CAP))]);
  }
  fields.push(
    [
      'Run',
      context === null
        ? '확인 불가 · Run 정보 없음'
        : objective === '' ? '확인 불가 · 목표 없음' : esc(objective),
    ],
    [
      'Project',
      context === null
        ? '확인 불가 · Run 정보 없음'
        : context.project === null ? '확인 불가 · Project 미등록' : esc(context.project),
    ],
    // 권장을 선택지보다 먼저 둔다. 3초 안에 누르려는 사람이 찾는 한 칸이다.
    ['권장', gate.recommendation === null ? NO_DETAIL : esc(cut(gate.recommendation.label, DETAIL_CAP))],
    // 대기와 계속 가능은 서로 대조해서 읽는 사실이다("이 결정을 미루면 무엇이 멈추나").
    ['대기 Task', `${gate.waitingTasks.length}개`],
    ['영향', gate.impact === null ? NO_DETAIL : esc(cut(gate.impact, DETAIL_CAP))],
    ['계속 가능', `${gate.independentTasks.length}개`],
  );

  const sections: string[] = [];
  if (open && !actionable) sections.push(NO_BUTTONS_NOTE);
  if (gate.recommendation !== null) {
    sections.push(`권장 이유: ${esc(cut(gate.recommendation.reason, DETAIL_CAP))}`);
  }
  sections.push(listText('선택지', optionLines(gate)));

  // 열린 카드에는 시각을 싣지 않는다. 결정된 카드는 Orca가 기록한 결정 시각만 쓴다.
  const footer: CardFooter = open
    ? {
        at: null,
        verb: 'Coordinator 질문',
        basis: gate.recommendation !== null || gate.impact !== null ? '등록 상세 기준' : 'Orca 기록 기준',
      }
    : { at: gate.resolvedAt, verb: '결정', basis: 'Orca Gate 기준' };

  return renderCardShell({
    tone: head.tone,
    emoji: head.emoji,
    kind: head.kind,
    head: question === '' ? '확인 불가 · 질문 없음' : question,
    text: `${head.emoji} ${head.kind} · ${esc(cut(gate.question, 160) || '(question 없음)')}`,
    actions,
    fields,
    sections,
    dashboard: [
      ['대기 중', titleLines(gate)],
      ['판정 제한', limitValue(gate)],
    ],
    footer,
  });
}
