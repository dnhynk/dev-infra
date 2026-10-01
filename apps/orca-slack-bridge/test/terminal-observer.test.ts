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
import { renderTerminalPromptCard } from '../src/terminal/render.js';
import type { TerminalPromptRecord } from '../src/terminal/types.js';
import { cardText, fieldValue, footerText, headerText, sectionTexts } from './card-text.js';

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
    // 버튼은 최상위에만 있다. attachment 안의 버튼 클릭은 handler가 받지 않는다.
    expect(hasButtons(slack.posts[0]?.attachments)).toBe(false);

    // 터미널이 끝났다. 화면도 프롬프트도 없다.
    orca.status = 'exited';
    orca.rows = [];
    const second = await runTerminalPromptPass(deps);

    expect(second.observed).toBe(0);
    expect(slack.updates).toHaveLength(1);
    expect(hasButtons(slack.updates[0]?.blocks)).toBe(false);
    expect(hasButtons(slack.updates[0]?.attachments)).toBe(false);
    // 본문은 attachment에 있다. 갱신이 그것을 함께 보내야 옛 본문이 남지 않는다.
    expect(JSON.stringify(slack.updates[0]?.attachments)).toContain('이미 처리됐습니다');
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

describe('터미널 프롬프트 카드', () => {
  const CREATED = '2026-10-01T05:20:11.000Z';
  const CLAIMED = '2026-10-01T05:21:00.000Z';
  const SETTLED = '2026-10-01T05:22:30.000Z';

  function record(over: Partial<TerminalPromptRecord> = {}): TerminalPromptRecord {
    return {
      terminalHandle: HANDLE,
      runKey: runKey('run_abcdef012345'),
      role: 'coordinator',
      dispatchId: null,
      fingerprint: 'f'.repeat(64),
      title: null,
      question: 'Do you want to proceed?',
      options: [
        { index: 1, label: 'Yes', description: null, selected: true },
        { index: 2, label: 'No', description: null, selected: false },
        { index: 3, label: 'Type something.', description: null, selected: false },
      ],
      cursorIndex: 1,
      channelId: CHANNEL,
      threadTs: null,
      messageTs: null,
      renderFingerprint: null,
      state: 'open',
      claimedOption: null,
      claimedBy: null,
      claimedAt: null,
      settledAt: null,
      lastErrorCode: null,
      createdAt: CREATED,
      updatedAt: CREATED,
      ...over,
    };
  }

  it('열린 질문은 답변 대기이고 감지 시각과 자유 입력 선택지를 밝힌다', () => {
    const card = renderTerminalPromptCard({ prompt: record(), runLabel: 'Run 하나' });
    expect(headerText(card)).toBe('⏸  답변 대기 · Do you want to proceed?');
    expect(card.attachments?.[0]?.color).toBe('#bf8700');
    expect(fieldValue(card, 'Run')).toBe('Run 하나');
    expect(fieldValue(card, '위치')).toBe('코디네이터');
    expect(sectionTexts(card)).toEqual([
      '*선택지*\n1. Yes\n2. No\n3. Type something. — 터미널에서만 가능',
    ]);
    expect(footerText(card)).toBe('orca-slack-bridge · 10-01 14:20:11 KST 감지 · 터미널 화면 기준');
    // 자유 입력은 버튼으로 만들지 않는다. 버튼은 최상위 한 줄이다.
    const rows = card.blocks.filter((block) => block['type'] === 'actions');
    expect(rows).toHaveLength(1);
    expect((rows[0]?.['elements'] as readonly unknown[])).toHaveLength(2);
  });

  it('지나간 상태는 고른 선택지와 그 상태의 시각을 싣고 handle·지문·고른 사람은 싣지 않는다', () => {
    const claimed = renderTerminalPromptCard({
      prompt: record({ state: 'claimed', claimedOption: 2, claimedBy: 'U0OWNER', claimedAt: CLAIMED }),
      runLabel: 'Run 하나',
    });
    expect(headerText(claimed).startsWith('📨  보내는 중')).toBe(true);
    expect(fieldValue(claimed, '선택')).toBe('2. No');
    expect(footerText(claimed)).toContain('10-01 14:21:00 KST 선택');
    expect(sectionTexts(claimed)[0]).toContain('2. No · 선택됨');

    const answered = renderTerminalPromptCard({
      prompt: record({ state: 'answered', claimedOption: 2, claimedAt: CLAIMED, settledAt: SETTLED }),
      runLabel: 'Run 하나',
    });
    expect(headerText(answered).startsWith('✅  답변함')).toBe(true);
    expect(footerText(answered)).toContain('10-01 14:22:30 KST 답변');

    for (const card of [claimed, answered]) {
      expect(card.blocks.some((block) => block['type'] === 'actions')).toBe(false);
      for (const hidden of ['term_', '1111', 'ffffffff', 'U0OWNER']) expect(cardText(card)).not.toContain(hidden);
    }
  });

  it('전송 실패는 원인과 할 일을 말하고 오류 코드는 싣지 않는다', () => {
    const failed = renderTerminalPromptCard({
      prompt: record({
        state: 'failed', claimedOption: 1, claimedAt: CLAIMED, settledAt: SETTLED,
        lastErrorCode: 'screen_changed',
      }),
      runLabel: 'Run 하나',
    });
    expect(headerText(failed).startsWith('⚠️  전송 실패')).toBe(true);
    expect(failed.attachments?.[0]?.color).toBe('#cf222e');
    expect(sectionTexts(failed)[0]).toBe('화면이 바뀌어 보내지 않았습니다 → 터미널에서 직접 답하세요.');
    expect(cardText(failed)).not.toContain('screen_changed');

    const gone = renderTerminalPromptCard({
      prompt: record({ state: 'gone', settledAt: SETTLED }),
      runLabel: 'Run 하나',
    });
    expect(headerText(gone).startsWith('⚪  이미 처리됨')).toBe(true);
    expect(gone.attachments?.[0]?.color).toBe('#6e7781');
    expect(sectionTexts(gone)[0]).toBe('이 질문은 터미널에서 이미 처리됐습니다.');
  });

  it('머리에서 잘리는 긴 질문은 전문을 본문에 싣는다', () => {
    const question = '가'.repeat(400);
    const card = renderTerminalPromptCard({ prompt: record({ question }), runLabel: 'Run 하나' });
    expect(headerText(card).length).toBeLessThanOrEqual(150);
    expect(sectionTexts(card)[0]).toBe(question);
  });
});
