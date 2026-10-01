import type { RenderedCard } from '../digest/render.js';
import type { SlackBlock } from './post.js';

/**
 * Slack 카드 한 장의 시각 문법(DL-074). 카드 renderer는 전부 이 껍데기를 쓴다.
 *
 * ```text
 * blocks       header "{emoji}  {kind} · {head}"   ← 카드의 유일한 emoji
 *              actions…                            ← 버튼은 여기에만 둔다
 * attachments  [{ color,                           ← 종류별 색 바
 *                 blocks: fields · sections… · divider · dashboard fields · context footer }]
 * ```
 *
 * ## 버튼이 attachment 밖에 있는 이유
 *
 * attachment 안의 버튼 클릭은 `container.type: "message_attachment"`로 온다. Gate와 직접 입력
 * handler는 `message`만 받는다(`gate/action-handler.ts`의 `parseAction`,
 * `gate/direct-input-handler.ts`). 그래서 머리와 버튼은 최상위 `blocks`에 두고 색 바를 입힌 본문만
 * attachment에 넣는다. `renderCardShell`은 attachment에 action block이 들어가면 던진다.
 *
 * ## 카드에 싣지 않는 것
 *
 * 링크(PR 버튼의 URL만 예외), code span, mention(치명 종료 알림의 owner mention만 예외), raw JSON,
 * 내부 ID(`run_`·`task_`·`gate_`·`ctx_`·`term_` handle과 12자 이상 hex hash), 경로, `[snake_case]`
 * 진단 코드. 그 사실이 필요한 사람은 `runs` 보고와 운영 로그를 본다. 값이 없으면 빈칸 대신
 * `계산 불가`나 `확인 불가 · …`를 쓴다.
 *
 * ## 시각
 *
 * 이 파일은 현재 시각을 읽지 않는다. footer 시각은 renderer 입력에서만 온다. Gate·결정·터미널
 * 카드의 시각은 저장된 사실의 시각이다. 살아 있는 카드(Run·컬렉션·PR 루트)의 "갱신" 시각은 게시
 * 직전에 찍고, 그 카드의 렌더 지문은 시각을 비운 렌더에서 계산한다(`run/publish.ts`,
 * `digest/digest.ts`).
 */

/** 카드 종류별 색 바(legacy attachment `color`). GitHub Primer 계열이다. */
export const CARD_COLOR = {
  /** 접수·진행 중 */
  entry: '#2f81f7',
  /** 성공 */
  success: '#1a7f37',
  /** 오류·막힘 */
  error: '#cf222e',
  /** 사람의 주의나 결정이 필요함 */
  attention: '#bf8700',
  /** 변경 */
  change: '#8250df',
  /** 상태·판정 불가 */
  status: '#6e7781',
} as const;

export type CardTone = keyof typeof CARD_COLOR;

/**
 * section block `text`의 문자 수 상한.
 *
 * Slack이 고정한 값이다. "Minimum length for the `text` in this field is 1 and maximum length
 * is 3000 characters."(`https://docs.slack.dev/reference/block-kit/composition-objects/text-object`)
 * 넘기면 `chat.postMessage`가 `invalid_blocks`로 거절하고 **카드 전체가 게시되지 않는다.**
 * 상한이 없는 입력이 여럿이므로(worker 보고 본문, 요약, Gate 영향) section을 만드는 한 지점에서
 * 일반적으로 적용한다.
 */
const SECTION_TEXT_CAP = 3000;

/**
 * 상한에서 잘렸음을 카드에 남기는 표시.
 *
 * 조용히 자르지 않는다. 부분만 보여 주고 전부인 척하지 않는다(UX §6). 이것은 관측 절단이 아니라
 * 표시 한도다. 관측은 전부 했고 Slack이 그만큼만 그릴 수 있을 뿐이다.
 */
const SECTION_TRUNCATION_MARK = '\n…(표시 한도 3000자를 넘어 잘림)';

/** section `fields` 한 칸의 상한. Slack은 칸마다 2000자, section마다 10칸까지 받는다. */
const FIELD_TEXT_CAP = 2000;
const FIELD_TRUNCATION_MARK = '\n…(표시 한도 2000자를 넘어 잘림)';
const FIELDS_PER_SECTION = 10;

/** header block plain_text의 상한. */
const HEADER_TEXT_CAP = 150;

/** Slack이 메시지 하나에 받는 block 수 상한. 최상위와 attachment의 block을 함께 센다. */
const MESSAGE_BLOCK_CAP = 50;

/** 한국은 일광 절약 시간이 없다. 고정 offset이다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * Slack mrkdwn 예약 문자를 이스케이프한다.
 *
 * PR 제목, Run objective, Gate question, Task 제목, 모델 출력은 사람이나 모델이 자유롭게 쓰는
 * 값이다. `<`나 `&`가 들어오면 Slack이 링크·mention·entity로 해석해 원문과 다른 것을 보여주고,
 * 이스케이프하지 않은 `<!channel>` 하나가 카드 한 번에 workspace 전체를 깨운다. 대상은 Slack이
 * 명시한 세 문자뿐이다.
 *
 * header의 plain_text에는 쓰지 않는다. plain_text는 해석되지 않으므로 `&lt;`가 그대로 보인다.
 */
export function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `text`의 앞에서 `budget` code unit 안에 **통째로** 들어가는 code point까지만 남긴다.
 *
 * 상한은 UTF-16 code unit 단위이고 `String.prototype.slice`도 code unit 단위다. astral plane
 * 문자(emoji 등)는 2 code unit이므로 그 가운데에서 자르면 surrogate pair가 갈라져 lone surrogate가
 * 남는다. Slack에 보내는 JSON은 그 자리에 U+FFFD를 넣거나 요청을 거절한다.
 *
 * 경계는 code point까지다. grapheme cluster(ZWJ emoji, 결합 문자)는 보존하지 않는다. Slack이 세는
 * 단위가 code unit이고 카드가 거절되는 원인은 lone surrogate와 길이 초과뿐이다.
 */
function prefixWithin(text: string, budget: number): string {
  let end = 0;
  // `for...of`는 문자열을 code point 단위로 훑는다. `point.length`가 그 code point의 code unit 수다.
  for (const point of text) {
    if (end + point.length > budget) break;
    end += point.length;
  }
  return text.slice(0, end);
}

/**
 * 앞뒤 공백을 걷고 `cap` code unit 안으로 자른다. 자르면 끝에 `…`을 붙여 잘렸음을 드러낸다.
 *
 * 결과는 `…`을 포함해 `cap` 이하다. 버튼 label처럼 Slack 상한이 걸린 자리에 그대로 쓴다.
 */
export function cut(value: string, cap: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${prefixWithin(trimmed, cap - 1).trimEnd()}…`;
}

function capText(text: string, cap: number, mark: string): string {
  if (text.length <= cap) return text;
  // 예산을 mark 길이만큼 덜어 두므로 mark를 붙인 결과도 cap 이하다.
  return `${prefixWithin(text, cap - mark.length)}${mark}`;
}

/**
 * section text를 Slack 상한 안으로 맞춘다.
 *
 * 이스케이프 뒤의 길이로 센다. Slack이 보는 것은 전송된 문자열이고 `&amp;`는 5자다. 자른 결과가
 * 그대로 카드에 실리므로 `renderFingerprint`도 자른 결과를 해싱한다.
 */
export function capSectionText(text: string): string {
  return capText(text, SECTION_TEXT_CAP, SECTION_TRUNCATION_MARK);
}

/**
 * `MM-DD HH:MM:SS KST`.
 *
 * host의 timezone과 locale을 읽지 않는다. 같은 입력이면 어느 기계에서 그려도 같은 카드다.
 */
export function kst(at: string | Date): string {
  const ms = typeof at === 'string' ? Date.parse(at) : at.getTime();
  if (!Number.isFinite(ms)) return '시각 확인 불가';
  const d = new Date(ms + KST_OFFSET_MS);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ` +
    `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} KST`;
}

/** `*Label*\nvalue` 한 칸. value는 mrkdwn이고 호출자가 이스케이프한 값이다. */
export type CardField = readonly [label: string, value: string];

/**
 * `orca-slack-bridge · MM-DD HH:MM:SS KST <verb> · <basis>`.
 *
 * `at`이 null이면 시각 없이 쓴다. 열린 Gate 카드처럼 카드에 실을 고정 시각이 없을 때다.
 * `verb`가 null이면 시각만 쓴다.
 */
export type CardFooter = {
  readonly at: string | Date | null;
  readonly verb: string | null;
  readonly basis: string;
};

/** 굵은 제목 한 줄과 항목 한 줄씩. 항목은 호출자가 이스케이프한 값이다. */
export function listText(label: string, items: readonly string[]): string {
  return [`*${label}*`, ...items].join('\n');
}

export type CardShell = {
  readonly tone: CardTone;
  readonly emoji: string;
  readonly kind: string;
  /** header의 `head`. plain_text이므로 이스케이프하지 않는다. 줄바꿈은 공백으로 접는다. */
  readonly head: string;
  /** 알림용 대체 텍스트. mrkdwn으로 해석되므로 호출자가 이스케이프한 값이다. */
  readonly text: string;
  /** 최상위에 둘 action block. 버튼은 attachment에 넣지 않는다. */
  readonly actions?: readonly SlackBlock[];
  readonly fields: readonly CardField[];
  /** fields 아래에 순서대로 놓는 mrkdwn section(설명 한두 문장, 목록). */
  readonly sections?: readonly string[];
  /** divider 아래의 두 번째 fields. 비어 있으면 divider도 만들지 않는다. */
  readonly dashboard?: readonly CardField[];
  readonly footer: CardFooter;
};

const DIVIDER: SlackBlock = { type: 'divider' };

function fieldSections(fields: readonly CardField[]): SlackBlock[] {
  const sections: SlackBlock[] = [];
  for (let start = 0; start < fields.length; start += FIELDS_PER_SECTION) {
    sections.push({
      type: 'section',
      fields: fields.slice(start, start + FIELDS_PER_SECTION).map(([label, value]) => ({
        type: 'mrkdwn',
        // 빈 값은 Slack이 거절하고 사람에게는 "없음"과 "모름"이 같아 보인다. 자리표시로 채운다.
        text: capText(
          `*${label}*\n${value.trim() === '' ? '확인 불가' : value}`,
          FIELD_TEXT_CAP,
          FIELD_TRUNCATION_MARK,
        ),
      })),
    });
  }
  return sections;
}

function footerText(footer: CardFooter): string {
  const when = [footer.at === null ? null : kst(footer.at), footer.verb]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
  return ['orca-slack-bridge', when, footer.basis].filter((part) => part !== '').join(' · ');
}

/**
 * 카드 껍데기를 만든다.
 *
 * 절 순서를 여기서 고정한다. 순서가 흔들리면 렌더 지문이 흔들려 사실이 그대로여도
 * `chat.update`가 나간다.
 */
export function renderCardShell(shell: CardShell): RenderedCard {
  const actions = shell.actions ?? [];
  for (const block of actions) {
    if (block['type'] !== 'actions') {
      throw new TypeError('card top-level blocks accept only action blocks after the header');
    }
  }
  const header: SlackBlock = {
    type: 'header',
    text: {
      type: 'plain_text',
      text: cut(`${shell.emoji}  ${shell.kind} · ${shell.head.replace(/\s+/g, ' ').trim()}`, HEADER_TEXT_CAP),
      emoji: true,
    },
  };
  const body: SlackBlock[] = [
    ...fieldSections(shell.fields),
    ...(shell.sections ?? []).map((text): SlackBlock => ({
      type: 'section',
      text: { type: 'mrkdwn', text: capSectionText(text) },
    })),
  ];
  const dashboard = shell.dashboard ?? [];
  if (dashboard.length > 0) body.push(DIVIDER, ...fieldSections(dashboard));
  body.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: capSectionText(footerText(shell.footer)) }],
  });
  if (body.some((block) => block['type'] === 'actions')) {
    throw new TypeError('an action block inside an attachment would reject every click');
  }
  const blocks = [header, ...actions];
  if (blocks.length + body.length > MESSAGE_BLOCK_CAP) {
    throw new RangeError('card exceeds the bounded Slack block count');
  }
  return {
    text: shell.text,
    blocks,
    attachments: [{ color: CARD_COLOR[shell.tone], blocks: body }],
  };
}
