import type { RenderedCard } from '../digest/render.js';
import { cut, esc, listText, renderCardShell, type CardField, type CardTone } from '../slack/card.js';
import type { SlackBlock } from '../slack/post.js';
import { promptActionId, promptActionValue, promptBlockId } from './actions.js';
import { isFreeTextAffordance } from './prompt.js';
import type { TerminalPromptRecord } from './types.js';

/**
 * 막혀 있는 agent 터미널 한 대의 카드.
 *
 * 이 카드를 읽는 사람은 이동 중이고 터미널을 볼 수 없다. 그래서 화면에 있던 것을 그대로 옮기지
 * 않고, 결정에 필요한 것만 결정하는 순서로 싣는다: 무엇을 묻나 → 버튼 → 어느 Run의 어디인가 →
 * 선택지.
 *
 * 터미널 handle, 화면 지문, 고른 사람의 ID, 오류 코드는 싣지 않는다(DL-074). 버튼 ID가 handle과
 * 지문을 싣고 store가 클릭마다 다시 대조한다. **현재 시각을 읽지 않는다.** footer 시각은 감지
 * (`createdAt`)·선택(`claimedAt`)·종결(`settledAt`) 시각이다.
 */

const QUESTION_CAP = 1200;
const LABEL_CAP = 120;
const RUN_LABEL_CAP = 80;
const BUTTON_CAP = 72;
const BUTTONS_PER_ROW = 5;
/** header의 plain_text 상한(`slack/card.ts`). 질문이 이보다 길면 전문을 본문에도 싣는다. */
const HEADER_CAP = 150;

const ROLE_LABEL: Readonly<Record<TerminalPromptRecord['role'], string>> = {
  coordinator: '코디네이터',
  worker: 'worker',
};

/**
 * 상태별 머리.
 *
 * `open`만 사람의 행동을 요구한다. 나머지는 이미 지나간 일이라 같은 색으로 그리지 않는다.
 */
const STATE_HEAD: Readonly<Record<TerminalPromptRecord['state'], {
  readonly tone: CardTone;
  readonly emoji: string;
  readonly kind: string;
  readonly verb: string;
  readonly at: (prompt: TerminalPromptRecord) => string | null;
}>> = {
  open: { tone: 'attention', emoji: '⏸', kind: '답변 대기', verb: '감지', at: (p) => p.createdAt },
  claimed: { tone: 'entry', emoji: '📨', kind: '보내는 중', verb: '선택', at: (p) => p.claimedAt },
  answered: { tone: 'success', emoji: '✅', kind: '답변함', verb: '답변', at: (p) => p.settledAt },
  failed: { tone: 'error', emoji: '⚠️', kind: '전송 실패', verb: '실패', at: (p) => p.settledAt },
  gone: { tone: 'status', emoji: '⚪', kind: '이미 처리됨', verb: '확인', at: (p) => p.settledAt },
};

/** 화면이 바뀌어 보내지 않은 실패. 사람에게는 같은 원인이다. */
const SCREEN_CHANGED = new Set([
  'screen_changed',
  'screen_changed_after_move',
  'screen_unreadable',
  'prompt_gone',
]);

export type TerminalPromptCardInput = {
  readonly prompt: TerminalPromptRecord;
  /** 카드에 적을 Run 이름(objective 첫 줄). */
  readonly runLabel: string;
};

/**
 * 열려 있지 않은 카드의 원인 → 행동 한 문장.
 *
 * `failed`에서 무엇을 해야 하는지 말하는 것이 중요하다. 보내지 못했다는 사실만 남기면 사용자는
 * 카드를 다시 눌러 보고, 그 클릭도 같은 이유로 거절된다.
 */
function stateNote(prompt: TerminalPromptRecord): string | null {
  switch (prompt.state) {
    case 'failed': {
      const cause = prompt.lastErrorCode !== null && SCREEN_CHANGED.has(prompt.lastErrorCode)
        ? '화면이 바뀌어 보내지 않았습니다'
        : prompt.lastErrorCode === 'terminal_not_running'
          ? '터미널이 실행 중이 아니라 보내지 않았습니다'
          : '터미널로 보내지 못했습니다';
      return `${cause} → 터미널에서 직접 답하세요.`;
    }
    case 'gone':
      return '이 질문은 터미널에서 이미 처리됐습니다.';
    default:
      return null;
  }
}

export function renderTerminalPromptCard(input: TerminalPromptCardInput): RenderedCard {
  const { prompt } = input;
  const head = STATE_HEAD[prompt.state];
  const question = prompt.question.replace(/\s+/g, ' ').trim();
  const chosen = prompt.options.find((option) => option.index === prompt.claimedOption) ?? null;

  const actions: SlackBlock[] = [];
  if (prompt.state === 'open') {
    // 자유 입력으로 들어가는 항목은 버튼으로 만들지 않는다. Slack에서 그 상태를 끝낼 수 없다.
    const answerable = prompt.options.filter((option) => !isFreeTextAffordance(option.label));
    for (let start = 0; start < answerable.length; start += BUTTONS_PER_ROW) {
      const row = answerable.slice(start, start + BUTTONS_PER_ROW);
      actions.push({
        type: 'actions',
        block_id: `${promptBlockId(prompt.terminalHandle, prompt.fingerprint)}:${start}`,
        elements: row.map((option) => ({
          type: 'button',
          text: {
            type: 'plain_text',
            text: cut(`${option.index}. ${option.label}`, BUTTON_CAP),
            emoji: true,
          },
          action_id: promptActionId(prompt.terminalHandle, prompt.fingerprint, option.index),
          value: promptActionValue(prompt.terminalHandle, prompt.fingerprint, option.index),
        })),
      });
    }
  }

  const runLabel = input.runLabel.trim();
  const fields: CardField[] = [
    ['Run', runLabel === '' ? '확인 불가 · Run 이름 없음' : esc(cut(runLabel, RUN_LABEL_CAP))],
    ['위치', ROLE_LABEL[prompt.role]],
  ];
  if (prompt.title !== null && prompt.title.trim() !== '') {
    fields.push(['주제', esc(cut(prompt.title, LABEL_CAP))]);
  }
  if (chosen !== null) fields.push(['선택', `${chosen.index}. ${esc(cut(chosen.label, LABEL_CAP))}`]);

  const sections: string[] = [];
  // 머리는 plain_text 150자에서 잘린다. 잘리는 질문은 전문을 본문 첫 줄에 싣는다.
  if (`${head.emoji}  ${head.kind} · ${question}`.length > HEADER_CAP) {
    sections.push(esc(cut(prompt.question, QUESTION_CAP)));
  }
  const note = stateNote(prompt);
  if (note !== null) sections.push(note);
  if (prompt.options.length > 0) {
    sections.push(listText('선택지', prompt.options.map((option) => {
      const free = isFreeTextAffordance(option.label) ? ' — 터미널에서만 가능' : '';
      const marked = prompt.claimedOption === option.index ? ' · 선택됨' : '';
      return `${option.index}. ${esc(cut(option.label, LABEL_CAP))}${free}${marked}`;
    })));
  }

  return renderCardShell({
    tone: head.tone,
    emoji: head.emoji,
    kind: head.kind,
    head: question === '' ? '확인 불가 · 질문 없음' : question,
    text: `${head.emoji} ${head.kind} · ${esc(cut(input.runLabel, 60))} · ${
      esc(cut(prompt.title ?? prompt.question, 80))
    }`,
    actions,
    fields,
    sections,
    footer: { at: head.at(prompt), verb: head.verb, basis: '터미널 화면 기준' },
  });
}
