import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcaRunner } from '../src/orca/client.js';
import { runRunObserver } from '../src/run/publish.js';
import type { BridgeConfig } from '../src/project/config.js';
import { DEFAULT_CORRELATION_KEYS } from '../src/project/config.js';
import type {
  PostMessageInput,
  PostedMessage,
  SlackPoster,
  ThreadPoster,
  ThreadReplyInput,
  UpdateMessageInput,
} from '../src/slack/post.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';

const RUN_ID = 'run_d2a';
const GATE_ID = 'gate_static';
const GATE_TASK = 'task_gate';
const RAW_ONLY_GATE = 'gate_without_sidecar';
const RAW_ONLY_TASK = 'task_raw_gate';
const REPO_ID = 'repo-d2a';
const CHANNEL = 'C0AGENTRUNS';
const AT = '2026-08-24T07:00:00.000Z';

const CONFIG: BridgeConfig = {
  slack: {
    teamId: 'T0TEAM',
    ownerUserIds: ['U0OWNER'],
    channels: { prDigest: 'C0PRDIGEST', agentRuns: CHANNEL },
  },
  projects: [
    { name: 'dev-infra', repositories: ['dnhynk/dev-infra'], orcaRepositoryIds: [REPO_ID] },
  ],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-gate-publish-'));
  dbPath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function taskRow(id: string, deps: readonly string[] = []): Record<string, unknown> {
  return {
    id,
    run_id: RUN_ID,
    task_title: `title ${id}`,
    status: id === GATE_TASK ? 'blocked' : 'ready',
    deps: JSON.stringify(deps),
    result: null,
    created_by_process_incarnation: `${REPO_ID}::D:/dev-infra@@h:i`,
    created_by_terminal_handle: 'term_now',
    created_by_pane_key: 'pane:now',
    created_by_run_generation: 2,
    created_at: '2026-08-24 00:00:00',
    completed_at: null,
  };
}

function gateRow(
  id: string,
  taskId: string,
  question: string,
  options: readonly string[],
): Record<string, unknown> {
  return {
    id,
    run_id: RUN_ID,
    task_id: taskId,
    question,
    options: JSON.stringify(options),
    status: 'pending',
    resolution: null,
    created_at: '2026-08-24T05:00:00Z',
    resolved_at: null,
  };
}

class MutableFakeOrca implements OrcaRunner {
  gateQuestion = '정적 Gate card를 이 경로로 게시할까?';
  readonly calls: string[][] = [];

  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const command = args[1];
    let result: unknown;
    if (command === 'run-list') {
      result = {
        runs: [
          {
            id: RUN_ID,
            objective: 'D2-A Gate projection',
            coordinator_handle: 'term_now',
            coordinator_pane_key: 'pane:now',
            consumer_generation: 2,
            legacy: 0,
            created_at: '2026-08-24T00:00:00Z',
            updated_at: '2026-08-24T00:00:00Z',
          },
        ],
      };
    } else if (command === 'task-list') {
      const tasks = [
        taskRow(GATE_TASK),
        taskRow('task_after', [GATE_TASK]),
        taskRow(RAW_ONLY_TASK),
        taskRow('task_independent'),
      ];
      result = { tasks, count: tasks.length };
    } else if (command === 'gate-list') {
      result = {
        gates: [
          gateRow(GATE_ID, GATE_TASK, this.gateQuestion, ['기존 유지', '변경']),
          gateRow(RAW_ONLY_GATE, RAW_ONLY_TASK, 'sidecar가 없는 Gate', ['예', '아니오']),
        ],
      };
    } else if (command === 'worker-list') {
      result = { workers: [] };
    } else if (command === 'inbox') {
      result = { messages: [] };
    } else {
      throw new Error(`예상치 못한 Orca 호출: ${args.join(' ')}`);
    }
    return Promise.resolve(JSON.stringify({ id: 'x', ok: true, result }));
  }
}

class FakeSlack implements SlackPoster, ThreadPoster {
  readonly posts: PostMessageInput[] = [];
  readonly updates: UpdateMessageInput[] = [];
  readonly replies: ThreadReplyInput[] = [];

  async post(input: PostMessageInput): Promise<PostedMessage> {
    this.posts.push(input);
    return { channel: input.channel, ts: `root-${this.posts.length}` };
  }

  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return { channel: input.channel, ts: input.ts };
  }

  async reply(input: ThreadReplyInput): Promise<PostedMessage> {
    this.replies.push(input);
    return { channel: input.channel, ts: `gate-reply-${this.replies.length}` };
  }
}

function insertSidecar(store: SqliteDigestStore): void {
  store.insertGateMetadata({
    gateKey: gateKey(GATE_ID),
    runKey: runKey(RUN_ID),
    taskKey: taskKey(GATE_TASK),
    dispatchKey: dispatchKey('ctx_gate'),
    askMessageId: 'msg_ask',
    questionThreadId: 'thread_question',
    options: [
      { id: 'keep', label: '기존 유지', description: '호환성을 유지한다', resolution: '기존 유지' },
      { id: 'change', label: '변경', description: '새 경로로 간다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '현재 소비자와 호환된다' },
    impact: '후속 Task의 구현 방향을 고정한다',
    registeredAt: AT,
  });
}

function noActionBlocks(input: { readonly blocks: readonly Record<string, unknown>[] }): boolean {
  const encoded = JSON.stringify(input.blocks);
  return (
    input.blocks.every((block) => block['type'] === 'section') &&
    !encoded.includes('"type":"actions"') &&
    !encoded.includes('"type":"button"') &&
    !encoded.includes('action_id')
  );
}

describe('collect → project → render → existing Run thread publish', () => {
  it('Gate마다 정확히 한 reply를 기존 Run root 아래 만들고 matched/degraded card를 모두 action 없이 게시한다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const orca = new MutableFakeOrca();
    const slack = new FakeSlack();
    insertSidecar(store);
    try {
      const report = await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store,
        slack,
        thread: slack,
        now: () => new Date(AT),
      });

      expect(report.facts.runs[0]?.gates.map((gate) => gate.metadataState)).toEqual([
        'matched',
        'missing',
      ]);
      expect(report.published.gates.map((gate) => gate.action)).toEqual(['create', 'create']);
      expect(slack.posts).toHaveLength(2); // collection root + Run root
      expect(slack.replies).toHaveLength(2);
      expect(slack.replies.map((reply) => reply.threadTs)).toEqual(['root-2', 'root-2']);
      expect(slack.replies.every(noActionBlocks)).toBe(true);
      expect(slack.replies[0]?.text).toContain('정적 Gate card');
      expect(JSON.stringify(slack.replies[0]?.blocks)).toContain('현재 소비자와 호환된다');
      expect(JSON.stringify(slack.replies[1]?.blocks)).toContain('추측하지 않음');

      const matched = store.findGateMessage(gateKey(GATE_ID));
      const degraded = store.findGateMessage(gateKey(RAW_ONLY_GATE));
      expect(matched).toMatchObject({ threadTs: 'root-2', messageTs: 'gate-reply-1' });
      expect(degraded).toMatchObject({ threadTs: 'root-2', messageTs: 'gate-reply-2' });
    } finally {
      store.close();
    }
  });

  it('재시작/재관찰은 같은 Gate ts를 skip하고 새 reply를 만들지 않는다', async () => {
    const orca = new MutableFakeOrca();
    const firstStore = new SqliteDigestStore(dbPath);
    insertSidecar(firstStore);
    const firstSlack = new FakeSlack();
    const first = await runRunObserver(orca, {
      config: CONFIG,
      channel: CHANNEL,
      store: firstStore,
      slack: firstSlack,
      thread: firstSlack,
      now: () => new Date(AT),
    });
    const firstTs = first.published.gates.map((gate) => gate.messageTs);
    firstStore.close();

    const secondStore = new SqliteDigestStore(dbPath);
    const secondSlack = new FakeSlack();
    try {
      const second = await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store: secondStore,
        slack: secondSlack,
        thread: secondSlack,
        now: () => new Date('2026-08-24T08:00:00Z'),
      });
      expect(second.published.gates.map((gate) => gate.action)).toEqual(['skip', 'skip']);
      expect(second.published.gates.map((gate) => gate.messageTs)).toEqual(firstTs);
      expect(secondSlack.replies).toEqual([]);
      expect(secondSlack.updates).toEqual([]);
      expect(secondSlack.posts).toEqual([]);
    } finally {
      secondStore.close();
    }
  });

  it('Gate facts가 바뀌면 새 reply 대신 저장된 같은 ts를 update한다', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const firstSlack = new FakeSlack();
    const first = await runRunObserver(orca, {
      config: CONFIG,
      channel: CHANNEL,
      store,
      slack: firstSlack,
      thread: firstSlack,
      now: () => new Date(AT),
    });
    const gateTs = first.published.gates[0]?.messageTs;
    store.close();

    orca.gateQuestion = '바뀐 질문을 같은 정적 Gate card에 반영할까?';
    const restartedStore = new SqliteDigestStore(dbPath);
    const restartedSlack = new FakeSlack();
    try {
      const changed = await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store: restartedStore,
        slack: restartedSlack,
        thread: restartedSlack,
        now: () => new Date('2026-08-24T09:00:00Z'),
      });
      const changedGate = changed.published.gates.find((gate) => gate.gate.gateId === GATE_ID);
      expect(changedGate?.action).toBe('update');
      expect(changedGate?.messageTs).toBe(gateTs);
      expect(restartedSlack.replies).toEqual([]);
      expect(restartedSlack.posts).toEqual([]);
      expect(restartedSlack.updates.some((update) => update.ts === gateTs)).toBe(true);
      expect(restartedStore.findGateMessage(gateKey(GATE_ID))?.messageTs).toBe(gateTs);
    } finally {
      restartedStore.close();
    }
  });
});
