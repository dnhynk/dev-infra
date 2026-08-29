import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  TerminalPromptActionHandler,
  isTerminalPromptEvent,
} from '../src/terminal/action-handler.js';
import { parseTerminalPrompt } from '../src/terminal/prompt.js';
import { renderTerminalPromptCard } from '../src/terminal/render.js';
import type { SlackConfig } from '../src/project/config.js';
import type { SocketSlackEvent } from '../src/slack/socket.js';
import { runKey } from '../src/identity/keys.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const LIVE_SCREEN: readonly string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/claude-code-option-prompt.json', import.meta.url)), 'utf8'),
) as string[];

const HANDLE = 'term_0bb89f84-bd61-4ffe-9dce-1c05d9e197f0';
const AT = '2026-08-29T11:18:27.177Z';

/** 운영 config와 같은 모양. teamId는 실제 워크스페이스 형식을 따른다. */
const CONFIG = { teamId: 'T0BRD3XH6LE' } as unknown as SlackConfig;

/**
 * Slack이 버튼 클릭에 보내는 봉투.
 *
 * Gate handler가 허용하는 root 필드 목록을 그대로 따른다. 실제 payload에 있는 필드를 빼고
 * 만들면 handler가 통과시키는 것이 payload가 아니라 우리 상상이 된다.
 */
function clickPayload(actionId: string, value: string): unknown {
  return {
    type: 'block_actions',
    api_app_id: 'A0BRXXXXXXX',
    token: 'legacy',
    team: { id: 'T0BRD3XH6LE', domain: 'workspace' },
    user: { id: 'U0BRUSER01', username: 'dongh', team_id: 'T0BRD3XH6LE' },
    container: {
      type: 'message',
      message_ts: '1788002307.783239',
      channel_id: 'C0BRG9YMF7U',
      is_ephemeral: false,
      thread_ts: '1787932047.002029',
    },
    trigger_id: '123.456.abc',
    channel: { id: 'C0BRG9YMF7U', name: 'agent-runs' },
    message: { type: 'message', ts: '1788002307.783239', thread_ts: '1787932047.002029' },
    response_url: 'https://hooks.slack.com/actions/T0/1/abc',
    is_enterprise_install: false,
    actions: [{
      type: 'button',
      action_id: actionId,
      block_id: 'orca_prompt_options_v1:deadbeef:0',
      text: { type: 'plain_text', text: '2. NOT_RUN으로 기록하고 설치하지 않음', emoji: true },
      value,
      action_ts: '1788002367.000100',
    }],
  };
}

describe('터미널 프롬프트 버튼 처리', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-prompt-action-'));
    path = join(dir, 'state.db');
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows에서 열린 핸들이 남으면 지워지지 않는다. 테스트 결과와 무관하다.
    }
  });

  function seed(store: SqliteDigestStore): ReturnType<typeof renderTerminalPromptCard> {
    const prompt = parseTerminalPrompt(LIVE_SCREEN);
    if (prompt === null) throw new Error('fixture를 읽지 못했다');
    const record = store.observeTerminalPrompt({
      terminalHandle: HANDLE,
      runKey: runKey('run_98ccc873ba4b'),
      role: 'coordinator',
      dispatchId: null,
      fingerprint: prompt.fingerprint,
      title: prompt.title,
      question: prompt.question,
      options: prompt.options,
      cursorIndex: prompt.cursorIndex,
    }, AT);
    return renderTerminalPromptCard({ prompt: record, runLabel: 'Academic' });
  }

  /** 카드에 실제로 실린 버튼을 그대로 눌러 본다. 손으로 만든 값이 아니다. */
  function buttonFromCard(card: ReturnType<typeof renderTerminalPromptCard>, index: number): {
    readonly actionId: string;
    readonly value: string;
  } {
    for (const block of card.blocks as readonly Record<string, unknown>[]) {
      if (block['type'] !== 'actions') continue;
      for (const element of block['elements'] as readonly Record<string, unknown>[]) {
        const value = String(element['value'] ?? '');
        if (value.endsWith(`|${index}`)) {
          return { actionId: String(element['action_id'] ?? ''), value };
        }
      }
    }
    throw new Error(`카드에 ${index}번 버튼이 없다`);
  }

  it('카드의 버튼을 그대로 누르면 durable하게 확정된다', async () => {
    const store = new SqliteDigestStore(path);
    try {
      const card = seed(store);
      const button = buttonFromCard(card, 2);
      const outcomes: string[] = [];
      const handler = new TerminalPromptActionHandler({
        config: CONFIG, store, now: () => new Date(AT),
        onOutcome: (outcome) => outcomes.push(outcome),
      });

      let acked = 0;
      const event: SocketSlackEvent = {
        type: 'interactive',
        body: clickPayload(button.actionId, button.value),
        ack: () => { acked += 1; },
      };
      expect(isTerminalPromptEvent(event)).toBe(true);
      await handler.handle(event);

      expect(outcomes).toEqual(['claimed']);
      expect(acked).toBe(1);
      const claimed = store.findActiveTerminalPrompt(HANDLE);
      expect(claimed).toMatchObject({ state: 'claimed', claimedOption: 2, claimedBy: 'U0BRUSER01' });
    } finally {
      store.close();
    }
  });

  it('같은 사람이 같은 선택지를 다시 눌러도 중복으로만 남는다', async () => {
    const store = new SqliteDigestStore(path);
    try {
      const card = seed(store);
      const button = buttonFromCard(card, 1);
      const outcomes: string[] = [];
      const handler = new TerminalPromptActionHandler({
        config: CONFIG, store, now: () => new Date(AT),
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      const event = (): SocketSlackEvent => ({
        type: 'interactive',
        body: clickPayload(button.actionId, button.value),
        ack: () => {},
      });
      await handler.handle(event());
      await handler.handle(event());
      expect(outcomes).toEqual(['claimed', 'duplicate']);
    } finally {
      store.close();
    }
  });

  it('다른 워크스페이스의 클릭을 받지 않는다', async () => {
    const store = new SqliteDigestStore(path);
    try {
      const card = seed(store);
      const button = buttonFromCard(card, 1);
      const outcomes: string[] = [];
      const handler = new TerminalPromptActionHandler({
        config: { teamId: 'T_OTHER' } as unknown as SlackConfig,
        store, now: () => new Date(AT),
        onOutcome: (outcome) => outcomes.push(outcome),
      });
      await handler.handle({
        type: 'interactive',
        body: clickPayload(button.actionId, button.value),
        ack: () => {},
      });
      expect(outcomes).toEqual(['team_mismatch']);
      expect(store.findActiveTerminalPrompt(HANDLE)?.state).toBe('open');
    } finally {
      store.close();
    }
  });
});
