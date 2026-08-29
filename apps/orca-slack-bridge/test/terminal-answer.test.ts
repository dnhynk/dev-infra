import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { answerTerminalPrompt } from '../src/terminal/answer.js';
import { KEY_DOWN } from '../src/terminal/client.js';
import { parseTerminalPrompt } from '../src/terminal/prompt.js';
import type { TerminalPromptRecord } from '../src/terminal/types.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { runKey } from '../src/identity/keys.js';

const LIVE_SCREEN: readonly string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/claude-code-option-prompt.json', import.meta.url)), 'utf8'),
) as string[];

/** 커서를 index로 옮긴 화면. 실제 TUI가 하는 일과 같다. */
function screenWithCursor(index: number): readonly string[] {
  return LIVE_SCREEN.map((row) => {
    const match = /^(\s*)(❯)?(\s*)(\d{1,2})\.\s/.exec(row);
    if (match === null) return row;
    const optionIndex = Number.parseInt(match[4] ?? '', 10);
    const stripped = row.replace(/^(\s*)❯/, '$1 ');
    return optionIndex === index ? `❯${stripped.slice(1)}` : stripped;
  });
}

type Call = { readonly args: readonly string[] };

/** Orca `terminal` 표면만 흉내 낸다. 화면은 호출자가 단계별로 정한다. */
function fakeOrca(screens: readonly (readonly string[])[], options?: {
  readonly status?: string;
  readonly rejectMove?: boolean;
  readonly rejectEnter?: boolean;
}): { runner: OrcaRunner; calls: Call[] } {
  const calls: Call[] = [];
  let reads = 0;
  const runner: OrcaRunner = {
    run: async (args: readonly string[]): Promise<string> => {
      calls.push({ args: [...args] });
      if (args[1] === 'read') {
        const rows = screens[Math.min(reads, screens.length - 1)] ?? [];
        reads += 1;
        return JSON.stringify({
          id: 'x', ok: true,
          result: { terminal: { handle: 'term_probe', status: options?.status ?? 'running', tail: rows } },
        });
      }
      if (args[1] === 'send') {
        const isEnter = args.includes('--enter');
        const accepted = isEnter ? options?.rejectEnter !== true : options?.rejectMove !== true;
        return JSON.stringify({ id: 'x', ok: true, result: { send: { accepted } } });
      }
      throw new Error(`예상치 못한 호출: ${args.join(' ')}`);
    },
  } as OrcaRunner;
  return { runner, calls };
}

const FINGERPRINT = (() => {
  const prompt = parseTerminalPrompt(LIVE_SCREEN);
  if (prompt === null) throw new Error('fixture를 읽지 못했다');
  return prompt.fingerprint;
})();

function record(overrides: Partial<TerminalPromptRecord> = {}): TerminalPromptRecord {
  const prompt = parseTerminalPrompt(LIVE_SCREEN);
  if (prompt === null) throw new Error('fixture를 읽지 못했다');
  return {
    terminalHandle: 'term_probe',
    runKey: runKey('run_probe'),
    role: 'coordinator',
    dispatchId: null,
    fingerprint: FINGERPRINT,
    title: prompt.title,
    question: prompt.question,
    options: prompt.options,
    cursorIndex: prompt.cursorIndex,
    channelId: 'C1',
    threadTs: '1.1',
    messageTs: '1.2',
    renderFingerprint: 'fp',
    state: 'claimed',
    claimedOption: 2,
    claimedBy: 'U1',
    claimedAt: '2026-08-29T00:00:00.000Z',
    settledAt: null,
    lastErrorCode: null,
    createdAt: '2026-08-29T00:00:00.000Z',
    updatedAt: '2026-08-29T00:00:00.000Z',
    ...overrides,
  };
}

const settle = async (): Promise<void> => {};

describe('확정된 선택을 터미널에 넣는 절차', () => {
  it('지문 확인 → 커서 이동 → 이동 확인 → Enter 순서로만 커밋한다', async () => {
    // 두 번째 읽기는 커서가 2번으로 옮겨진 화면이다.
    const { runner, calls } = fakeOrca([LIVE_SCREEN, screenWithCursor(2)]);
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record());
    expect(outcome).toEqual({ kind: 'answered' });

    const kinds = calls.map((call) => `${call.args[1]}${call.args.includes('--enter') ? ':enter' : ''}`);
    expect(kinds).toEqual(['read', 'send', 'read', 'send:enter']);
    // 이동은 아래쪽으로 정확히 한 칸이다. 커서가 1번에 있었고 목표가 2번이다.
    const move = calls[1]?.args ?? [];
    expect(move[move.indexOf('--text') + 1]).toBe(KEY_DOWN);
  });

  it('커서가 이미 목표에 있으면 이동 없이 Enter만 보낸다', async () => {
    const { runner, calls } = fakeOrca([LIVE_SCREEN]);
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record({ claimedOption: 1 }));
    expect(outcome).toEqual({ kind: 'answered' });
    expect(calls.map((call) => call.args[1])).toEqual(['read', 'send']);
    expect(calls[1]?.args).toContain('--enter');
  });

  it('보내기 전에 화면이 바뀌었으면 아무것도 보내지 않는다', async () => {
    const changed = [...LIVE_SCREEN];
    changed[23] = '│ 완전히 다른 질문입니다.';
    const { runner, calls } = fakeOrca([changed]);
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record());
    expect(outcome).toEqual({ kind: 'refused', reason: 'screen_changed' });
    // 읽기 한 번뿐이다. 살아 있는 세션에 아무 입력도 들어가지 않았다.
    expect(calls.map((call) => call.args[1])).toEqual(['read']);
  });

  it('이동이 확인되지 않으면 Enter를 보내지 않는다', async () => {
    // 이동을 보냈지만 커서가 그대로다.
    const { runner, calls } = fakeOrca([LIVE_SCREEN, LIVE_SCREEN]);
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record());
    expect(outcome).toEqual({ kind: 'refused', reason: 'cursor_not_confirmed' });
    expect(calls.some((call) => call.args.includes('--enter'))).toBe(false);
  });

  it('이동 뒤 다른 프롬프트로 바뀌었으면 Enter를 보내지 않는다', async () => {
    const changed = [...LIVE_SCREEN];
    changed[23] = '│ 이동하는 사이에 바뀐 질문입니다.';
    const { runner, calls } = fakeOrca([LIVE_SCREEN, changed]);
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record());
    expect(outcome).toEqual({ kind: 'refused', reason: 'screen_changed_after_move' });
    expect(calls.some((call) => call.args.includes('--enter'))).toBe(false);
  });

  it('프롬프트가 사라졌으면 거절한다', async () => {
    const { runner, calls } = fakeOrca([LIVE_SCREEN.slice(0, 20)]);
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record());
    expect(outcome).toEqual({ kind: 'refused', reason: 'prompt_gone' });
    expect(calls).toHaveLength(1);
  });

  it('터미널이 살아 있지 않으면 거절한다', async () => {
    const { runner } = fakeOrca([LIVE_SCREEN], { status: 'exited' });
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record());
    expect(outcome).toEqual({ kind: 'refused', reason: 'terminal_not_running' });
  });

  it('이동 입력이 거부되면 실패로 남기고 Enter를 보내지 않는다', async () => {
    const { runner, calls } = fakeOrca([LIVE_SCREEN], { rejectMove: true });
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record());
    expect(outcome).toEqual({ kind: 'failed', reason: 'move_rejected' });
    expect(calls.some((call) => call.args.includes('--enter'))).toBe(false);
  });

  it('없는 선택지는 거절한다', async () => {
    const { runner } = fakeOrca([LIVE_SCREEN]);
    const outcome = await answerTerminalPrompt({ orca: runner, settle }, record({ claimedOption: 9 }));
    expect(outcome).toEqual({ kind: 'refused', reason: 'unknown_option' });
  });
});
