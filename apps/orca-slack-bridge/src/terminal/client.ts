import type { OrcaRunner } from '../orca/client.js';

/**
 * Orca `terminal` 표면의 read-only 조회와 입력 전송.
 *
 * 이 모듈만이 살아 있는 agent 터미널에 입력을 쓴다. 그래서 여기에는 정책이 없다. 무엇을 언제
 * 보낼지는 호출자가 fence를 확인한 뒤 정하고, 여기서는 그 결정을 그대로 실행한다.
 *
 * ## 측정된 사실
 *
 * `terminal send --text`는 payload를 raw byte로 전달한다. 실측(2026-08-29, keyecho probe):
 *
 * - `--text "2"` → `[50]`
 * - `--text $'\033[B'` → `[27,91,66]` (Down)
 * - `--text "" --enter` → `[13]`
 *
 * escape sequence가 그대로 통과하므로 방향키로 커서를 옮기고 Enter로 확정할 수 있다. 숫자
 * 직접 선택을 지원하는 TUI인지 추측할 필요가 없다는 뜻이고, 그래서 이 모듈은 숫자를 쓰지 않는다.
 */

/** 커서를 한 칸 옮기는 입력. 선택이 아니라 이동이라 되돌릴 수 있다. */
export const KEY_DOWN = '\u001b[B';
export const KEY_UP = '\u001b[A';

/** 한 터미널의 현재 화면. `tail`은 화면 행이고 스크롤백이 아니다. */
export type TerminalScreen = {
  readonly handle: string;
  /** Orca가 보고한 프로세스 상태. `running`이 아니면 입력을 보내지 않는다. */
  readonly status: string;
  readonly rows: readonly string[];
};

export type TerminalSummary = {
  readonly handle: string;
  readonly title: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function call<T>(runner: OrcaRunner, args: readonly string[]): Promise<T> {
  const out = await runner.run(args);
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    // 터미널 화면에는 사용자 결정 본문이 그대로 있다. 이 경계의 진단은 실패 종류만 밝히고
    // 화면 내용을 복사하지 않는다.
    throw new SyntaxError('orca terminal 출력이 JSON이 아니다');
  }
  if (!isRecord(raw) || raw['ok'] !== true || !isRecord(raw['result'])) {
    throw new Error('orca terminal 호출이 ok가 아니다');
  }
  return raw['result'] as T;
}

/** 살아 있는 Orca 터미널 목록. handle과 title만 읽는다. */
export async function listTerminals(runner: OrcaRunner): Promise<readonly TerminalSummary[]> {
  const result = await call<{ terminals?: unknown }>(runner, ['terminal', 'list', '--json']);
  const rows = Array.isArray(result.terminals) ? result.terminals : [];
  const summaries: TerminalSummary[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const handle = text(row['handle']) || text(row['id']);
    if (!handle.startsWith('term_')) continue;
    summaries.push({ handle, title: text(row['title']) });
  }
  return summaries;
}

/**
 * 한 터미널의 현재 화면을 읽는다. 스크롤백이 아니라 `--screen`이다.
 *
 * 프롬프트 판정과 지문은 **지금 보이는 화면**에서만 나와야 한다. 스크롤백을 섞으면 이미 지나간
 * 프롬프트가 현재 프롬프트로 읽힌다.
 */
export async function readTerminalScreen(
  runner: OrcaRunner,
  handle: string,
): Promise<TerminalScreen | null> {
  const result = await call<{ terminal?: unknown }>(runner, [
    'terminal', 'read', '--terminal', handle, '--screen', '--json',
  ]);
  const terminal = result.terminal;
  if (!isRecord(terminal)) return null;
  const tail = terminal['tail'];
  if (!Array.isArray(tail)) return null;
  const rows: string[] = [];
  for (const row of tail) {
    if (typeof row === 'string') rows.push(row);
    else if (isRecord(row)) rows.push(text(row['text']));
    else return null;
  }
  return { handle, status: text(terminal['status']), rows };
}

/**
 * 입력을 보낸다. `text`가 비고 `enter`가 참이면 Enter만 보낸다.
 *
 * 반환값은 Orca가 입력을 받아들였는지뿐이다. **화면이 어떻게 되었는지는 말하지 않는다.**
 * 결과 확인은 호출자가 화면을 다시 읽어서 한다.
 */
export async function sendTerminalInput(
  runner: OrcaRunner,
  handle: string,
  input: { readonly text?: string; readonly enter?: boolean },
): Promise<boolean> {
  const args = ['terminal', 'send', '--terminal', handle];
  if (input.text !== undefined) args.push('--text', input.text);
  if (input.enter === true) args.push('--enter');
  const result = await call<{ send?: unknown }>(runner, [...args, '--json']);
  const send = result.send;
  return isRecord(send) && send['accepted'] === true;
}
