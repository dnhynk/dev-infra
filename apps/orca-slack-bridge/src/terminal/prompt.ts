import { createHash } from 'node:crypto';

/**
 * agent 터미널 화면에서 대화형 선택 프롬프트를 읽는다.
 *
 * ## 이것이 화면 파싱이라는 사실
 *
 * `agentWait`는 `{source, reason}` 두 문자열뿐이라 무엇을 묻는지 알려 주지 않는다. 질문과
 * 선택지는 화면에만 있고, 화면은 계약이 아니라 TUI의 그림이다. 그래서 이 파서는 **모양이
 * 정확히 맞을 때만** 결과를 낸다. 애매하면 null이고, 그때 그 프롬프트는 지금까지처럼 badge로만
 * 남는다. 반쯤 읽은 프롬프트로 카드를 만들면 사용자가 잘못된 선택지를 누른다.
 *
 * ## 실측한 모양 (2026-08-29, Claude Code)
 *
 * ```
 *   ← 여기 위의 ❯는 알림 줄이고 커서가 아니다
 * ──────────────────────────────────────────
 *  ☐ Windows 빌드
 * │ 질문 첫 줄
 * │ 질문 둘째 줄
 * ❯ 1. 첫 선택지
 *      선택지 설명
 *   2. 둘째 선택지
 * ──────────────────────────────────────────
 *   5. 구분선 뒤에도 선택지가 온다
 * Enter to select · ↑/↓ to navigate · Esc to cancel
 * ```
 *
 * 두 가지가 순진한 파서를 깨뜨린다. 화면 다른 곳에도 `❯`가 있고, 선택지 목록 중간에 구분선이
 * 있다. 그래서 커서는 `❯ <n>.` 형태로만 인정하고, 목록은 번호가 1..N으로 이어지는지로 닫는다.
 */

/** 선택지 하나. `index`는 화면에 보이는 번호이자 커서 이동 거리의 기준이다. */
export type TerminalPromptOption = {
  readonly index: number;
  readonly label: string;
  readonly description: string | null;
  readonly selected: boolean;
};

export type TerminalPrompt = {
  readonly title: string | null;
  readonly question: string;
  readonly options: readonly TerminalPromptOption[];
  /** 지금 `❯`가 가리키는 선택지 번호. 커서를 목표까지 옮길 거리를 이 값에서 뺀다. */
  readonly cursorIndex: number;
  /**
   * 프롬프트 영역의 지문. **커서 위치는 빠진다.**
   *
   * 두 가지를 뺀다. 화면 전체가 아니라 프롬프트 영역만 쓰는 것은 아래쪽 로그가 프롬프트와
   * 무관하게 움직이기 때문이고, 커서 표시를 빼는 것은 답을 보내는 절차가 커서를 옮기기
   * 때문이다. 커서가 지문에 들어가면 우리가 옮긴 직후 우리 자신의 fence에 걸린다.
   *
   * 그래서 이 값이 식별하는 것은 **질문과 선택지**다. 그것이 fence가 지켜야 할 대상이다.
   */
  readonly fingerprint: string;
  /** 지문을 만든 정확한 행. 재확인은 이 행들과 다시 대조한다. */
  readonly regionRows: readonly string[];
};

/** 등록 문서와 같은 상한을 쓴다. 카드의 버튼 label과 같은 자리에 실리기 때문이다. */
const MAX_OPTIONS = 25;
const LABEL_CAP = 75;
const DESCRIPTION_CAP = 3000;
const QUESTION_CAP = 3000;

const ANCHOR = /Enter to select/;
const NAVIGATE = /to navigate/;
const OPTION = /^(\s*)(❯)?\s*(\d{1,2})\.\s+(\S.*)$/;
const QUESTION_LINE = /^\s*│\s?(.*)$/;
const TITLE_LINE = /^\s*[☐☑☒]\s+(\S.*)$/;
const SEPARATOR = /^[\s─━┄┅-]{8,}$/;

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 프롬프트를 읽는다. 모양이 맞지 않으면 null이다.
 *
 * null은 실패가 아니라 "이 화면으로는 카드를 만들지 않는다"는 판정이다. 호출자는 그때 프롬프트를
 * 만들지 않고 지금까지의 badge 경로를 그대로 쓴다.
 */
export function parseTerminalPrompt(rows: readonly string[]): TerminalPrompt | null {
  /*
   * 기준은 선택지 목록이지 화면의 안내 문구가 아니다.
   *
   * 처음에는 `Enter to select …` 푸터를 필수로 봤는데, 그 줄이 없는 선택 화면이 실제로 있다.
   * 여러 질문에 답한 뒤 나오는 제출 확인 화면이 그렇다 — 목록과 커서는 있고 푸터는 없다.
   * 그 화면을 못 읽으면 사람은 마지막 한 번을 터미널에서 눌러야 하는데, 그럴 수 있었으면
   * 이 기능이 필요 없다.
   *
   * 그래서 판정은 목록의 모양에 건다: `❯ <n>.` 커서가 정확히 하나이고 번호가 1..N으로
   * 이어질 것. 푸터는 있으면 영역에 포함하고 없으면 넘어간다.
   */
  const options = collectOptions(rows, rows.length);
  if (options === null) return null;

  const anchor = anchorBelow(rows, options.lastRow);
  const start = questionStart(rows, options.firstRow);
  const regionRows = rows.slice(start, (anchor ?? options.lastRow) + 1);
  if (regionRows.length === 0) return null;

  const { title, question } = readQuestion(rows.slice(start, options.firstRow));
  // 질문 없이 선택지만 있는 화면은 프롬프트로 인정하지 않는다. 무엇을 고르는지 모르는 버튼을
  // 만들면 사용자가 맥락 없이 누르게 된다.
  if (question === '') return null;

  const cursor = options.entries.find((option) => option.selected);
  if (cursor === undefined) return null;

  return {
    title,
    question,
    options: options.entries,
    cursorIndex: cursor.index,
    fingerprint: fingerprintOf(regionRows),
    regionRows,
  };
}

/**
 * 커서 표시를 지운 뒤 해싱한다.
 *
 * 표시를 지우면 선택된 줄이 나머지 줄과 같은 모양이 되고, 그래서 커서를 어디에 두고 관측했든
 * 같은 질문은 같은 지문을 낸다.
 */
function fingerprintOf(regionRows: readonly string[]): string {
  const normalized = regionRows.map((row) => row.replace(/^(\s*)❯/, '$1 '));
  return createHash('sha256').update(normalized.join('\n'), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 화면에 선택 프롬프트가 떠 있는가. 선택지를 읽을 수 있는지와는 다른 질문이다.
 *
 * 이 둘을 구분하지 않으면 "읽지 못했다"가 "사라졌다"로 처리된다. 실제로 그랬다 — 커서가
 * 아래쪽 선택지로 내려가 화면이 스크롤되면서 1번이 화면 밖으로 밀렸고, 목록을 만들지 못한
 * 관측이 그 프롬프트를 처리 완료로 닫아 카드가 "이미 처리됨"이라고 말했다. 코디네이터는
 * 그대로 막혀 있었다.
 */
export function hasPromptAnchor(rows: readonly string[]): boolean {
  if (anyAnchor(rows)) return true;
  // 푸터가 없는 화면도 있다. 커서가 붙은 번호 줄이 보이면 무엇인가 고르기를 기다리는 중이다.
  return rows.some((row) => /^\s*❯\s*\d{1,2}\.\s+\S/.test(row));
}

/** 목록 바로 아래의 안내 문구. 없으면 null이고, 없는 화면도 정상이다. */
function anchorBelow(rows: readonly string[], lastOptionRow: number): number | null {
  for (let i = lastOptionRow + 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    if (ANCHOR.test(row) && NAVIGATE.test(row)) return i;
    // 안내 문구는 목록 바로 뒤에 온다. 빈 줄과 구분선만 사이에 허용한다.
    if (row.trim() !== '' && !SEPARATOR.test(row)) return null;
  }
  return null;
}

/** 화면에 선택 프롬프트가 떠 있는가. 선택지를 읽을 수 있는지와는 다른 질문이다. */
function anyAnchor(rows: readonly string[]): boolean {
  return rows.some((row) => ANCHOR.test(row) && NAVIGATE.test(row));
}

type CollectedOptions = {
  readonly entries: readonly TerminalPromptOption[];
  readonly firstRow: number;
  readonly lastRow: number;
};

/**
 * anchor 위쪽에서 선택지를 모은다.
 *
 * 목록은 번호가 1까지 내려오면 닫는다. 구분선과 설명 줄은 목록을 끊지 않는다. 화면 다른 곳의
 * 숫자 줄이 딸려 오는 것은 "1..N이 빠짐없이 이어질 것"으로 막는다.
 */
function collectOptions(rows: readonly string[], anchor: number): CollectedOptions | null {
  const found: { row: number; index: number; label: string; selected: boolean }[] = [];
  let firstRow = -1;
  for (let i = anchor - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined) continue;
    const match = OPTION.exec(row);
    if (match === null) continue;
    const index = Number.parseInt(match[3] ?? '', 10);
    if (!Number.isSafeInteger(index) || index < 1 || index > MAX_OPTIONS) return null;
    const label = collapse(match[4] ?? '');
    if (label === '' || label.length > LABEL_CAP) return null;
    found.push({ row: i, index, label, selected: (match[2] ?? '') !== '' });
    firstRow = i;
    if (index === 1) break;
  }
  if (found.length < 2 || firstRow < 0) return null;

  found.reverse();
  // 번호가 1..N으로 빠짐없이 이어져야 한다. 어긋나면 화면의 다른 숫자 줄을 선택지로 읽은 것이다.
  for (const [position, option] of found.entries()) {
    if (option.index !== position + 1) return null;
  }
  if (found.filter((option) => option.selected).length !== 1) return null;

  const entries = found.map((option, position) => ({
    index: option.index,
    label: option.label,
    description: readDescription(rows, option.row, found[position + 1]?.row ?? Number.NaN),
    selected: option.selected,
  }));
  return { entries, firstRow, lastRow: found[found.length - 1]!.row };
}

/** 선택지 줄 다음부터 다음 선택지 줄 전까지의 들여쓴 줄을 설명으로 본다. */
function readDescription(
  rows: readonly string[],
  optionRow: number,
  nextOptionRow: number,
): string | null {
  const end = Number.isSafeInteger(nextOptionRow) ? nextOptionRow : rows.length;
  const lines: string[] = [];
  for (let i = optionRow + 1; i < end; i += 1) {
    const row = rows[i];
    if (row === undefined || row.trim() === '' || SEPARATOR.test(row)) continue;
    if (ANCHOR.test(row)) break;
    lines.push(row.trim());
  }
  if (lines.length === 0) return null;
  const text = collapse(lines.join(' '));
  return text === '' ? null : text.slice(0, DESCRIPTION_CAP);
}

/** 첫 선택지 위쪽에서 질문 블록이 시작하는 행. 구분선이나 다른 내용에서 멈춘다. */
function questionStart(rows: readonly string[], firstOptionRow: number): number {
  let start = firstOptionRow;
  let sawStructured = false;
  for (let i = firstOptionRow - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row === undefined) break;
    if (row.trim() === '') { start = i; continue; }
    if (QUESTION_LINE.test(row) || TITLE_LINE.test(row)) { start = i; sawStructured = true; continue; }
    // `│` 형식이 없는 화면에서는 목록 바로 위 한 줄까지만 가져온다. 더 올라가면 이전 대화가
    // 질문으로 딸려 들어온다.
    if (!sawStructured && !SEPARATOR.test(row)) { start = i; }
    break;
  }
  return start;
}

function readQuestion(block: readonly string[]): { title: string | null; question: string } {
  let title: string | null = null;
  const lines: string[] = [];
  for (const row of block) {
    const titleMatch = TITLE_LINE.exec(row);
    if (titleMatch !== null && title === null) {
      title = collapse(titleMatch[1] ?? '').slice(0, LABEL_CAP) || null;
      continue;
    }
    const questionMatch = QUESTION_LINE.exec(row);
    if (questionMatch !== null) lines.push(questionMatch[1] ?? '');
  }
  if (lines.length > 0) {
    return { title, question: collapse(lines.join(' ')).slice(0, QUESTION_CAP) };
  }
  // `│` 형식이 없는 화면이 있다. 그때는 목록 바로 위의 마지막 문장이 질문이다.
  for (let i = block.length - 1; i >= 0; i -= 1) {
    const row = block[i];
    if (row === undefined || row.trim() === '' || SEPARATOR.test(row)) continue;
    return { title, question: collapse(row).slice(0, QUESTION_CAP) };
  }
  return { title, question: '' };
}

/**
 * 목표 선택지로 커서를 옮기는 데 필요한 이동. 음수면 위로, 양수면 아래로다.
 *
 * 이동은 선택이 아니다. 옮긴 뒤 화면을 다시 읽어 `❯`가 목표에 있는지 확인하고, 확인된 뒤에만
 * Enter를 보낸다. 그 순서가 이 기능의 안전성 전부다.
 */
export function cursorDelta(prompt: TerminalPrompt, targetIndex: number): number | null {
  if (!prompt.options.some((option) => option.index === targetIndex)) return null;
  return targetIndex - prompt.cursorIndex;
}

/**
 * 고르면 터미널이 자유 입력을 기다리게 되는 선택지인가.
 *
 * Claude Code의 선택 목록 끝에는 결정이 아니라 UI 동작인 항목이 붙는다. "Type something."은
 * 텍스트 입력창을 열고 "Chat about this"는 대화로 넘어간다. Slack에서 이것을 누르면 터미널이
 * 사람의 타이핑을 기다리는 상태가 되는데, **그 상태는 폰에서 빠져나올 수 없다.** 막힌 것을
 * 푸는 기능이 더 나쁜 막힘을 만들면 안 되므로 버튼으로 만들지 않는다.
 *
 * 판정이 문구에 기대는 것은 사실이다. 틀렸을 때 잃는 것은 "진짜 선택지 하나가 버튼이 되지
 * 않는 것"이고, 반대 방향으로 틀렸을 때 잃는 것은 "코디네이터가 아무도 답할 수 없는 상태로
 * 들어가는 것"이다. 그래서 이쪽으로 틀리는 것을 고른다. 카드는 이 선택지를 목록에는 그대로
 * 싣고 버튼만 만들지 않는다.
 */
const FREE_TEXT_AFFORDANCES: readonly RegExp[] = [
  /^type something/i,
  /^chat about this/i,
  /^직접 입력/,
  /^다른 의견/,
];

export function isFreeTextAffordance(label: string): boolean {
  const trimmed = label.trim();
  return FREE_TEXT_AFFORDANCES.some((pattern) => pattern.test(trimmed));
}
