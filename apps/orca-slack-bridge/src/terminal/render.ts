import type { RenderedCard } from '../digest/render.js';
import type { SlackBlock } from '../slack/post.js';
import { promptActionId, promptActionValue, promptBlockId } from './actions.js';
import { isFreeTextAffordance } from './prompt.js';
import type { TerminalPromptRecord } from './types.js';

/**
 * 막혀 있는 agent 터미널 한 대의 카드.
 *
 * 이 카드를 읽는 사람은 이동 중이고 터미널을 볼 수 없다. 그래서 화면에 있던 것을 그대로 옮기지
 * 않고, 결정에 필요한 것만 결정하는 순서로 싣는다: 무엇이 멈췄나 → 무엇을 묻나 → 고르면 어떻게
 * 되나 → 버튼.
 */

const SECTION_CAP = 2800;
const QUESTION_CAP = 1200;
const DESCRIPTION_CAP = 420;
const BUTTON_CAP = 72;
const BUTTONS_PER_ROW = 5;
const MAX_OPTION_SECTIONS = 8;

function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cut(value: string, cap: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap - 1).trimEnd()}…`;
}

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: cut(text, SECTION_CAP) } };
}

function context(lines: readonly string[]): SlackBlock {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: cut(lines.join('  ·  '), SECTION_CAP) }],
  };
}

const DIVIDER: SlackBlock = { type: 'divider' };

/** 짧은 handle. 카드에 40자짜리 UUID를 그대로 두면 읽는 흐름이 끊긴다. */
function shortHandle(handle: string): string {
  const body = handle.startsWith('term_') ? handle.slice('term_'.length) : handle;
  return body.slice(0, 8);
}

const ROLE_LABEL: Readonly<Record<TerminalPromptRecord['role'], string>> = {
  coordinator: '코디네이터',
  worker: 'worker',
};

/**
 * 상태별 머리글.
 *
 * `open`만 사람의 행동을 요구한다. 나머지는 이미 지나간 일이라 같은 무게로 그리지 않는다.
 */
const STATE_KICKER: Readonly<Record<TerminalPromptRecord['state'], string>> = {
  open: '⏸  답변을 기다리는 중',
  claimed: '📨  답변을 보내는 중',
  answered: '✅  답변함',
  failed: '⚠️  보내지 못했습니다',
  gone: '· 이미 처리됨',
};

export type TerminalPromptCardInput = {
  readonly prompt: TerminalPromptRecord;
  /** 카드 머리글에 함께 적을 Run 이름. 없으면 Run key를 쓴다. */
  readonly runLabel: string;
};

export function renderTerminalPromptCard(input: TerminalPromptCardInput): RenderedCard {
  const { prompt } = input;
  const blocks: SlackBlock[] = [];

  const where = `${ROLE_LABEL[prompt.role]}${
    prompt.dispatchId === null ? '' : ` · ${esc(prompt.dispatchId)}`
  }`;
  blocks.push(context([STATE_KICKER[prompt.state], esc(cut(input.runLabel, 80)), where]));

  const title = prompt.title === null ? null : esc(cut(prompt.title, 120));
  const question = esc(cut(prompt.question, QUESTION_CAP));
  blocks.push(section(title === null ? `*${question}*` : `*${title}*\n\n${question}`));

  if (prompt.options.length > 0) {
    blocks.push(DIVIDER);
    // 선택지가 많으면 설명을 접는다. 설명 없이 label만 남아도 버튼과 짝이 맞는다.
    const withDescription = prompt.options.length <= MAX_OPTION_SECTIONS;
    const lines = prompt.options.map((option) => {
      const chosen = prompt.claimedOption === option.index;
      const marker = chosen ? '▶︎' : isFreeTextAffordance(option.label) ? '✎' : '·';
      const label = `${marker} *${option.index}*  ${esc(cut(option.label, 120))}`;
      if (!withDescription || option.description === null) return label;
      // 설명은 인용으로 들여쓴다. label과 같은 왼쪽 끝에 붙으면 어디까지가 한 선택지인지 흐려진다.
      return `${label}\n> ${esc(cut(option.description, DESCRIPTION_CAP))}`;
    });
    // 한 section에 다 넣으면 상한에 걸리므로 선택지 단위로 나눈다. 잘림보다 나눔이 낫다.
    for (const line of lines) blocks.push(section(line));
  }

  if (prompt.state === 'open') {
    // 자유 입력으로 들어가는 항목은 버튼으로 만들지 않는다. Slack에서 그 상태를 끝낼 수 없다.
    const answerable = prompt.options.filter((option) => !isFreeTextAffordance(option.label));
    if (answerable.length < prompt.options.length) {
      blocks.push(context([
        '✎ 표시된 선택지는 터미널에서 직접 입력해야 합니다',
      ]));
    }
    for (let start = 0; start < answerable.length; start += BUTTONS_PER_ROW) {
      const row = answerable.slice(start, start + BUTTONS_PER_ROW);
      blocks.push({
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
  } else {
    blocks.push(section(settledLine(prompt)));
  }

  blocks.push(context([
    `터미널 ${esc(shortHandle(prompt.terminalHandle))}`,
    `화면 지문 ${esc(prompt.fingerprint.slice(0, 8))}`,
    ...(prompt.claimedBy === null ? [] : [`선택 ${esc(prompt.claimedBy)}`]),
    ...(prompt.lastErrorCode === null ? [] : [`오류 ${esc(prompt.lastErrorCode)}`]),
  ]));

  const text = `${STATE_KICKER[prompt.state]} · ${esc(cut(input.runLabel, 60))} · ${
    esc(cut(prompt.title ?? prompt.question, 80))
  }`;
  return { text, blocks };
}

/**
 * 열려 있지 않은 카드의 본문 한 줄.
 *
 * `failed`에서 무엇을 해야 하는지 말하는 것이 중요하다. 보내지 못했다는 사실만 남기면 사용자는
 * 카드를 다시 눌러 보고, 그 클릭도 같은 이유로 거절된다.
 */
function settledLine(prompt: TerminalPromptRecord): string {
  const chosen = prompt.options.find((option) => option.index === prompt.claimedOption);
  const chosenLabel = chosen === undefined ? null : esc(cut(chosen.label, 120));
  switch (prompt.state) {
    case 'claimed':
      return chosenLabel === null
        ? '_선택을 터미널로 보내는 중입니다._'
        : `_*${prompt.claimedOption}. ${chosenLabel}* 를 터미널로 보내는 중입니다._`;
    case 'answered':
      return chosenLabel === null
        ? '_터미널에 답을 보냈습니다._'
        : `*${prompt.claimedOption}. ${chosenLabel}* 로 답했습니다.`;
    case 'failed':
      return '_보내지 못했습니다. 이 질문은 터미널에서 직접 답해야 합니다._';
    case 'gone':
      return '_이 질문은 터미널에서 이미 처리됐습니다._';
    default:
      return '';
  }
}
