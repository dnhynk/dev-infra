import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runKey } from '../src/identity/keys.js';
import type { OrcaRunner } from '../src/orca/client.js';
import type { PostMessageInput, PostedMessage, SlackPoster, UpdateMessageInput } from '../src/slack/post.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import { runTerminalPromptPass, type TerminalPromptCandidate } from '../src/terminal/observer.js';

/** 실제 Claude Code 프롬프트 화면. 손으로 만든 화면이 아니라 이 기능이 상대하는 화면이다. */
const LIVE_SCREEN: readonly string[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/claude-code-option-prompt.json', import.meta.url)), 'utf8'),
) as string[];

const CHANNEL = 'C0DECISIONS';
const HANDLE = 'term_1111';

const CANDIDATE: TerminalPromptCandidate = {
  handle: HANDLE,
  runKey: runKey('run_abcdef012345'),
  role: 'worker',
  dispatchId: null,
  runLabel: 'Run 하나',
  channelId: CHANNEL,
};

/** 화면 하나를 돌려주는 대역. 테스트가 상태와 행을 바꿔 끼운다. */
class FakeOrca implements OrcaRunner {
  status = 'running';
  rows: readonly string[] = LIVE_SCREEN;
  async run(): Promise<string> {
    return JSON.stringify({
      id: 'x',
      ok: true,
      result: { terminal: { status: this.status, tail: this.rows } },
    });
  }
}

class FakeSlack implements SlackPoster {
  readonly posts: PostMessageInput[] = [];
  readonly updates: UpdateMessageInput[] = [];
  private seq = 0;
  async post(input: PostMessageInput): Promise<PostedMessage> {
    this.posts.push(input);
    this.seq += 1;
    return { channel: input.channel, ts: `1788${this.seq}.0001` };
  }
  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return { channel: input.channel, ts: input.ts };
  }
}

/** blocks 안에 버튼이 하나라도 있는가. */
function hasButtons(blocks: unknown): boolean {
  return JSON.stringify(blocks).includes('"type":"actions"');
}

describe('터미널 프롬프트 관측 pass', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'terminal-observer-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('프롬프트가 사라지면 카드에서 버튼을 걷어낸다', async () => {
    /*
     * 상태만 `gone`으로 닫고 카드를 그대로 두면 Slack에는 버튼이 남는다. 실측에서 프롬프트가
     * 사라진 지 두 시간 뒤에 그 버튼을 눌렀고, 클릭은 daemon까지 도착했지만 stale로 거절돼
     * 화면에 아무 변화도 없었다 — 사람에게는 "눌러도 안 눌린다"로 보인다.
     *
     * 터미널이 끝나면 다음 pass의 candidate 목록에서 빠지므로, 닫는 그 pass가 카드를 고칠
     * 마지막 기회다.
     */
    const store = new SqliteDigestStore(join(dir, 'state.db'));
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    const deps = {
      orca, store, slack,
      candidates: [CANDIDATE],
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      settle: () => Promise.resolve(),
    };

    const first = await runTerminalPromptPass(deps);
    expect(first.posted).toBe(1);
    expect(slack.posts).toHaveLength(1);
    expect(hasButtons(slack.posts[0]?.blocks)).toBe(true);

    // 터미널이 끝났다. 화면도 프롬프트도 없다.
    orca.status = 'exited';
    orca.rows = [];
    const second = await runTerminalPromptPass(deps);

    expect(second.observed).toBe(0);
    expect(slack.updates).toHaveLength(1);
    expect(hasButtons(slack.updates[0]?.blocks)).toBe(false);
    expect(JSON.stringify(slack.updates[0]?.blocks)).toContain('이미 처리됐습니다');
    const closed = store.listTerminalPromptsByState('gone');
    expect(closed.map((prompt) => prompt.terminalHandle)).toEqual([HANDLE]);
    store.close();
  });

  it('카드를 만든 적 없는 프롬프트는 사라져도 Slack을 부르지 않는다', async () => {
    // 아무도 본 적 없는 프롬프트에 "이미 처리됨" 카드를 새로 올리는 것은 잡음일 뿐이다.
    const store = new SqliteDigestStore(join(dir, 'state.db'));
    const orca = new FakeOrca();
    orca.status = 'exited';
    orca.rows = [];
    const slack = new FakeSlack();
    const report = await runTerminalPromptPass({
      orca, store, slack,
      candidates: [CANDIDATE],
      now: () => new Date('2026-09-05T00:00:00.000Z'),
      settle: () => Promise.resolve(),
    });
    expect(report.observed).toBe(0);
    expect(slack.posts).toHaveLength(0);
    expect(slack.updates).toHaveLength(0);
    store.close();
  });
});
