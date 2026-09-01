import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import { publishGateCard } from '../src/gate/publish.js';

const RUN_ID = 'run_d2a';
const GATE_ID = 'gate_static';
const GATE_TASK = 'task_gate';
const DECISIONS_CHANNEL = 'C0DECISIONS1';
const RAW_ONLY_GATE = 'gate_without_sidecar';
// options를 읽지 못하면 파생도 등록도 할 수 없다. 파생이 생긴 뒤에도 missing이 남는 유일한 경우다.
const UNREADABLE_GATE = 'gate_unreadable_options';
const UNREADABLE_TASK = 'task_unreadable';
const RAW_ONLY_TASK = 'task_raw_gate';
const REPO_ID = 'repo-d2a';
const CHANNEL = 'C0AGENTRUNS';
const AT = '2026-08-24T07:00:00.000Z';
const RUN_ROOT_TS = '1787554800.000002';
const FIRST_GATE_TS = '1787554800.000101';

const CONFIG: BridgeConfig = {
  slack: {
    teamId: 'T0TEAM',
    ownerUserIds: ['U0OWNER'],
    channels: { prDigest: 'C0PRDIGEST', agentRuns: CHANNEL , decisions: CHANNEL },
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
  status = 'pending',
): Record<string, unknown> {
  return {
    id,
    run_id: RUN_ID,
    task_id: taskId,
    question,
    options: JSON.stringify(options),
    status,
    resolution: null,
    created_at: '2026-08-24T05:00:00Z',
    resolved_at: null,
  };
}

class MutableFakeOrca implements OrcaRunner {
  gateQuestion = '정적 Gate card를 이 경로로 게시할까?';
  gateStatus = 'pending';
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
        taskRow(UNREADABLE_TASK),
        taskRow('task_independent'),
      ];
      result = { tasks, count: tasks.length };
    } else if (command === 'gate-list') {
      result = {
        gates: [
          gateRow(GATE_ID, GATE_TASK, this.gateQuestion, ['기존 유지', '변경'], this.gateStatus),
          gateRow(RAW_ONLY_GATE, RAW_ONLY_TASK, 'sidecar가 없는 Gate', ['예', '아니오']),
          {
            ...gateRow(UNREADABLE_GATE, UNREADABLE_TASK, 'options를 읽지 못하는 Gate', []),
            options: '{not json',
          },
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
    return { channel: input.channel, ts: `1787554800.${String(this.posts.length).padStart(6, '0')}` };
  }

  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return { channel: input.channel, ts: input.ts };
  }

  async reply(input: ThreadReplyInput): Promise<PostedMessage> {
    this.replies.push(input);
    return {
      channel: input.channel,
      ts: `1787554800.${String(100 + this.replies.length).padStart(6, '0')}`,
    };
  }
}

class BlockingGateSlack extends FakeSlack {
  readonly gateUpdateStarted: Promise<void>;
  private signalStarted!: () => void;
  private release!: () => void;
  private readonly blocked: Promise<void>;
  private blockedOnce = false;

  constructor() {
    super();
    this.gateUpdateStarted = new Promise((resolve) => { this.signalStarted = resolve; });
    this.blocked = new Promise((resolve) => { this.release = resolve; });
  }

  releaseGateUpdate(): void {
    this.release();
  }

  override async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    if (input.ts === FIRST_GATE_TS && !this.blockedOnce) {
      this.blockedOnce = true;
      this.signalStarted();
      await this.blocked;
    }
    return { channel: input.channel, ts: input.ts };
  }
}

class FailingGateReplySlack extends FakeSlack {
  override async reply(input: ThreadReplyInput): Promise<PostedMessage> {
    this.replies.push(input);
    throw new Error('thread reply unavailable');
  }
}

class NeverSettlingGateReplySlack extends FakeSlack {
  readonly replySignals: (AbortSignal | undefined)[] = [];

  override reply(input: ThreadReplyInput): Promise<PostedMessage> {
    this.replies.push(input);
    this.replySignals.push(input.signal);
    return new Promise(() => undefined);
  }
}

class FailOnceGateUpdateSlack extends FakeSlack {
  private failed = false;

  override async update(input: UpdateMessageInput): Promise<PostedMessage> {
    if (input.ts === FIRST_GATE_TS && !this.failed) {
      this.failed = true;
      throw new Error('Gate update unavailable once');
    }
    return super.update(input);
  }
}

class NeverSettlingGateUpdateSlack extends FakeSlack {
  override update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return input.ts === FIRST_GATE_TS
      ? new Promise(() => undefined)
      : Promise.resolve({ channel: input.channel, ts: input.ts });
  }
}

function insertSidecar(store: SqliteDigestStore): void {
  store.insertGateMetadata({
    gateKey: gateKey(GATE_ID),
    runKey: runKey(RUN_ID),
    taskKey: taskKey(GATE_TASK),
    dispatchKey: dispatchKey('ctx_gate'),
    source: 'registered',
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

/** 이 카드가 상호작용 요소를 하나도 싣지 않았는지. section/context/divider는 모두 비-상호작용이다. */
const INERT_BLOCK_TYPES = new Set(['section', 'context', 'divider']);

function noActionBlocks(input: { readonly blocks: readonly Record<string, unknown>[] }): boolean {
  const encoded = JSON.stringify(input.blocks);
  return (
    input.blocks.every((block) => INERT_BLOCK_TYPES.has(String(block['type']))) &&
    !encoded.includes('"type":"actions"') &&
    !encoded.includes('"type":"button"') &&
    !encoded.includes('action_id')
  );
}

async function matchedGateFacts(store: SqliteDigestStore, orca: MutableFakeOrca) {
  const preview = await runRunObserver(orca, {
    config: CONFIG,
    channel: CHANNEL,
    store,
    slack: null,
    thread: null,
    now: () => new Date(AT),
  });
  const gate = preview.facts.runs[0]?.gates.find((candidate) => candidate.gateId === GATE_ID);
  if (gate === undefined) throw new Error('matched Gate preview missing');
  return gate;
}

function claimGate(
  store: SqliteDigestStore,
  gate: ReturnType<typeof gateKey>,
  retryRequestId: string,
  at = '2026-08-24T08:00:00.000Z',
) {
  return store.claimGateResolution({
    teamId: 'T0TEAM',
    ownerUserId: 'U0OWNER',
    apiAppId: null,
    channelId: CHANNEL,
    threadTs: RUN_ROOT_TS,
    messageTs: FIRST_GATE_TS,
    blockId: gateBlockId(gate),
    actionId: gateActionId(gate, 'keep'),
    actionValue: 'keep',
    retryRequestId,
    at,
  });
}

describe('collect → project → render → existing Run thread publish', () => {
  it('Gate마다 한 reply를 만들고 matched pending만 fixed actions를 게시한다', async () => {
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

      // sidecar를 등록하지 않은 Gate도 Orca options로 파생되어 matched가 된다. options 자체를
      // 읽지 못한 Gate만 missing으로 남고, 그 카드에는 버튼이 없다.
      // Gate는 id 순으로 정렬된다: 등록된 Gate, options를 읽지 못한 Gate, sidecar 없는 Gate.
      expect(report.facts.runs[0]?.gates.map((gate) => gate.metadataState)).toEqual([
        'matched',
        'missing',
        'matched',
      ]);
      expect(report.published.gates.map((gate) => gate.action)).toEqual([
        'create',
        'create',
        'create',
      ]);
      expect(slack.posts).toHaveLength(2); // collection root + Run root
      expect(slack.replies).toHaveLength(3);
      expect(slack.replies.map((reply) => reply.threadTs)).toEqual([
        RUN_ROOT_TS,
        RUN_ROOT_TS,
        RUN_ROOT_TS,
      ]);
      for (const reply of slack.replies) expect(noActionBlocks(reply)).toBe(true);
      const promoted = slack.updates.find((update) => update.ts === FIRST_GATE_TS);
      expect(noActionBlocks(promoted ?? { blocks: [] })).toBe(false);
      expect(JSON.stringify(promoted?.blocks)).toContain('"value":"keep"');
      expect(slack.replies[0]?.text).toContain('정적 Gate card');
      expect(JSON.stringify(promoted?.blocks)).toContain('현재 소비자와 호환된다');
      // 파생 카드도 누를 수 있어야 한다. 이것이 없으면 등록을 빠뜨린 Gate를 폰에서 해결할 수 없다.
      const derived = slack.updates.find((update) => update.ts === '1787554800.000103');
      expect(noActionBlocks(derived ?? { blocks: [] })).toBe(false);
      expect(JSON.stringify(derived?.blocks)).toContain('"value":"orca_');
      const unreadable = slack.updates.find((update) => update.ts === '1787554800.000102');
      expect(unreadable === undefined || noActionBlocks(unreadable)).toBe(true);

      const matched = store.findGateMessage(gateKey(GATE_ID));
      const degraded = store.findGateMessage(gateKey(RAW_ONLY_GATE));
      expect(matched).toMatchObject({ threadTs: RUN_ROOT_TS, messageTs: FIRST_GATE_TS });
      expect(degraded).toMatchObject({ threadTs: RUN_ROOT_TS, messageTs: '1787554800.000103' });
      expect(store.findGateLocalObservation(gateKey(GATE_ID))).toMatchObject({
        status: 'pending', metadataState: 'matched', mappingState: 'matched',
      });
    } finally {
      store.close();
    }
  });

  it('답할 카드 채널이 설정되면 Gate를 그 채널에 최상위로 놓는다', async () => {
    /*
     * Slack은 메시지를 게시 순서로 고정한다. 상태 카드는 제자리에서 갱신되므로 아래로 내려오지
     * 않고, 답할 카드가 그 사이에 섞이면 둘 다 스크롤로 찾아야 한다. 폰에서 채널을 열었을 때
     * 맨 아래가 지금 할 일이 아니면 이 기능의 목적이 성립하지 않는다.
     *
     * 최상위 메시지 자체가 알림이므로 broadcast가 필요 없다. 스레드 답글은 스레드를 따르지
     * 않는 사람에게 알림이 가지 않고, 알림을 위해 broadcast를 켜면 그 복사본이 다시 상태 카드
     * 사이에 섞인다.
     */
    const store = new SqliteDigestStore(dbPath);
    const orca = new MutableFakeOrca();
    const slack = new FakeSlack();
    insertSidecar(store);
    try {
      const report = await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        decisionsChannel: DECISIONS_CHANNEL,
        store,
        slack,
        thread: slack,
        now: () => new Date(AT),
      });

      expect(report.published.gates.every((gate) => gate.action !== 'root_unavailable')).toBe(true);
      // Gate 카드가 답할 카드 채널의 최상위 메시지로 간다. Run 카드 채널에는 답글이 없다.
      const decisionPosts = slack.posts.filter((post) => post.channel === DECISIONS_CHANNEL);
      expect(decisionPosts.length).toBeGreaterThan(0);
      expect(slack.replies).toHaveLength(0);

      // 매핑은 그 채널을 가리키고, 자기 자신이 루트다.
      const mapped = store.findGateMessage(gateKey(GATE_ID));
      expect(mapped?.channelId).toBe(DECISIONS_CHANNEL);
      expect(mapped?.threadTs).toBe(mapped?.messageTs);

      // 재관찰이 같은 카드를 다시 만들지 않는다.
      const again = await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        decisionsChannel: DECISIONS_CHANNEL,
        store,
        slack,
        thread: slack,
        now: () => new Date(AT),
      });
      expect(again.published.gates.map((gate) => gate.action)).not.toContain('create');
      expect(store.findGateMessage(gateKey(GATE_ID))?.messageTs).toBe(mapped?.messageTs);
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
      expect(second.published.gates.map((gate) => gate.action)).toEqual(['skip', 'skip', 'skip']);
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

  it('a first Gate reply failure leaves a strict missing mapping that the next observer can create', async () => {
    const orca = new MutableFakeOrca();
    const firstStore = new SqliteDigestStore(dbPath);
    insertSidecar(firstStore);
    const failedSlack = new FailingGateReplySlack();
    await expect(runRunObserver(orca, {
      config: CONFIG,
      channel: CHANNEL,
      store: firstStore,
      slack: failedSlack,
      thread: failedSlack,
      now: () => new Date(AT),
    })).rejects.toThrow(/thread reply unavailable/);
    expect(noActionBlocks(failedSlack.replies[0] ?? { blocks: [] })).toBe(true);
    expect(firstStore.findGateMessage(gateKey(GATE_ID))).toBeNull();
    expect(firstStore.findGateLocalObservation(gateKey(GATE_ID))).toMatchObject({
      metadataState: 'matched', mappingState: 'missing',
    });
    firstStore.close();

    const reopened = new SqliteDigestStore(dbPath);
    const recoveredSlack = new FakeSlack();
    try {
      await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store: reopened,
        slack: recoveredSlack,
        thread: recoveredSlack,
        now: () => new Date('2026-08-24T07:01:00.000Z'),
      });
      expect(reopened.findGateMessage(gateKey(GATE_ID))).not.toBeNull();
      expect(reopened.findGateLocalObservation(gateKey(GATE_ID))?.mappingState).toBe('matched');
    } finally {
      reopened.close();
    }
  });

  it('bounds a cancellation-ignoring first Gate reply and leaves its mapping retryable', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const hanging = new NeverSettlingGateReplySlack();
    try {
      const began = Date.now();
      await expect(runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store,
        slack: hanging,
        thread: hanging,
        now: () => new Date(AT),
        slackTimeoutMs: 10,
      })).rejects.toThrow(/thread reply deadline/);

      expect(Date.now() - began).toBeLessThan(1_000);
      expect(hanging.replies).toHaveLength(1);
      expect(hanging.replySignals[0]?.aborted).toBe(true);
      expect(store.findGateMessage(gateKey(GATE_ID))).toBeNull();
      expect(store.findGateLocalObservation(gateKey(GATE_ID))).toMatchObject({
        metadataState: 'matched', mappingState: 'missing',
      });
    } finally {
      store.close();
    }
  });

  it('keeps a Slack-accepted first reply inert across a crash before durable mapping', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const gate = await matchedGateFacts(store, orca);
    const slack = new FakeSlack();
    await expect(publishGateCard(
      {
        store,
        slack,
        thread: slack,
        channel: CHANNEL,
        now: () => new Date(AT),
        fault: (point) => {
          if (point === 'after_staged_first_reply_before_mapping') {
            throw new Error('process died after staged reply acceptance');
          }
        },
      },
      runKey(RUN_ID),
      RUN_ROOT_TS,
      gate,
    )).rejects.toThrow(/staged reply acceptance/);
    expect(slack.replies).toHaveLength(1);
    expect(noActionBlocks(slack.replies[0] ?? { blocks: [] })).toBe(true);
    expect(slack.updates).toEqual([]);
    expect(store.findGateMessage(gate.key)).toBeNull();
    expect(store.findGateLocalObservation(gate.key)?.mappingState).toBe('missing');
    store.close();

    const reopened = new SqliteDigestStore(dbPath);
    try {
      await publishGateCard(
        {
          store: reopened,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T07:01:00.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      expect(slack.replies).toHaveLength(2);
      expect(slack.replies.every(noActionBlocks)).toBe(true);
      const actionable = slack.updates.filter((update) => !noActionBlocks(update));
      expect(actionable).toHaveLength(1);
      expect(actionable[0]?.ts).toBe('1787554800.000102');
      expect(reopened.findGateMessage(gate.key)?.messageTs).toBe('1787554800.000102');
      expect(reopened.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
    } finally {
      reopened.close();
    }
  });

  it('restarts from a durable staged mapping and promotes that same reply in place', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const gate = await matchedGateFacts(store, orca);
    const slack = new FakeSlack();
    await expect(publishGateCard(
      {
        store,
        slack,
        thread: slack,
        channel: CHANNEL,
        now: () => new Date(AT),
        fault: (point) => {
          if (point === 'after_staged_first_mapping_before_action_update') {
            throw new Error('process died after staged mapping');
          }
        },
      },
      runKey(RUN_ID),
      RUN_ROOT_TS,
      gate,
    )).rejects.toThrow(/staged mapping/);
    expect(slack.replies).toHaveLength(1);
    expect(noActionBlocks(slack.replies[0] ?? { blocks: [] })).toBe(true);
    expect(slack.updates).toEqual([]);
    expect(store.findGateMessage(gate.key)?.messageTs).toBe(FIRST_GATE_TS);
    expect(store.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
    store.close();

    const reopened = new SqliteDigestStore(dbPath);
    try {
      await publishGateCard(
        {
          store: reopened,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T07:01:00.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      expect(slack.replies).toHaveLength(1);
      expect(slack.updates).toHaveLength(1);
      expect(noActionBlocks(slack.updates[0] ?? { blocks: [] })).toBe(false);
      expect(slack.updates[0]?.ts).toBe(FIRST_GATE_TS);
      expect(reopened.findGateMessage(gate.key)?.messageTs).toBe(FIRST_GATE_TS);
    } finally {
      reopened.close();
    }
  });

  it('reopens a staged first mapping when registration replaces its derived sidecar after the inert reply', async () => {
    const orca = new MutableFakeOrca();
    const publisher = new SqliteDigestStore(dbPath);
    const registrar = new SqliteDigestStore(dbPath);
    const preview = await runRunObserver(orca, {
      config: CONFIG,
      channel: CHANNEL,
      store: publisher,
      slack: null,
      thread: null,
      now: () => new Date(AT),
    });
    const gate = preview.facts.runs[0]?.gates.find((candidate) => candidate.gateId === GATE_ID);
    if (gate === undefined) throw new Error('missing-sidecar Gate preview missing');
    // 등록 전이라 관측이 파생 행을 남긴다. matched지만 권장안이 없는 것으로 파생임을 판정한다.
    expect(gate.metadataState).toBe('matched');
    expect(gate.recommendation).toBeNull();
    const slack = new FakeSlack();
    await expect(publishGateCard(
      {
        store: publisher,
        slack,
        thread: slack,
        channel: CHANNEL,
        now: () => new Date(AT),
        fault: (point) => {
          if (point === 'after_staged_first_reply_before_mapping') insertSidecar(registrar);
          if (point === 'after_staged_first_mapping_before_action_update') {
            throw new Error('process died after concurrent sidecar mapping');
          }
        },
      },
      runKey(RUN_ID),
      RUN_ROOT_TS,
      gate,
    )).rejects.toThrow(/concurrent sidecar mapping/);
    expect(slack.replies).toHaveLength(1);
    expect(noActionBlocks(slack.replies[0] ?? { blocks: [] })).toBe(true);
    expect(slack.updates).toEqual([]);
    expect(publisher.findGateMessage(gate.key)?.messageTs).toBe(FIRST_GATE_TS);
    // 파생 행으로 이미 matched였으므로 등록이 그 판정을 되돌리지 않는다. 바뀌는 것은 option
    // identity라서 카드가 다시 그려지고, 옛 파생 option ID로 누른 클릭은 claim에서 거부된다.
    expect(publisher.findGateLocalObservation(gate.key)).toMatchObject({
      metadataState: 'matched',
      mappingState: 'matched',
    });
    registrar.close();
    publisher.close();

    const reopened = new SqliteDigestStore(dbPath);
    try {
      const currentGate = await matchedGateFacts(reopened, orca);
      await publishGateCard(
        {
          store: reopened,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T07:01:00.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        currentGate,
      );
      expect(slack.replies).toHaveLength(1);
      expect(slack.updates).toHaveLength(1);
      expect(noActionBlocks(slack.updates[0] ?? { blocks: [] })).toBe(false);
      expect(slack.updates[0]?.ts).toBe(FIRST_GATE_TS);
      expect(reopened.findGateLocalObservation(gate.key)).toMatchObject({
        metadataState: 'matched',
        mappingState: 'matched',
      });
    } finally {
      reopened.close();
    }
  });

  it('leaves only an inert orphan when a second SQLite writer blocks first mapping persistence', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const gate = await matchedGateFacts(store, orca);
    const slack = new FakeSlack();
    const locker = new DatabaseSync(dbPath);
    let locked = false;
    try {
      await expect(publishGateCard(
        {
          store,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date(AT),
          fault: (point) => {
            if (point === 'after_staged_first_reply_before_mapping') {
              locker.exec('BEGIN IMMEDIATE');
              locked = true;
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      )).rejects.toThrow(/thread 메시지를 기록할 수 없다/);
      expect(noActionBlocks(slack.replies[0] ?? { blocks: [] })).toBe(true);
      expect(store.findGateMessage(gate.key)).toBeNull();
      expect(store.findGateLocalObservation(gate.key)?.mappingState).toBe('missing');
      locker.exec('COMMIT');
      locked = false;
    } finally {
      if (locked) locker.exec('ROLLBACK');
      locker.close();
      store.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      await publishGateCard(
        {
          store: reopened,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T07:01:00.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      expect(slack.replies).toHaveLength(2);
      expect(slack.replies.every(noActionBlocks)).toBe(true);
      expect(slack.updates.filter((update) => !noActionBlocks(update))).toHaveLength(1);
      expect(reopened.findGateMessage(gate.key)?.messageTs).toBe('1787554800.000102');
    } finally {
      reopened.close();
    }
  });

  it('keeps matched only when a paused publisher has the exact canonical run/channel/thread identity', async () => {
    const orca = new MutableFakeOrca();
    const firstStore = new SqliteDigestStore(dbPath);
    insertSidecar(firstStore);
    const staleStore = new SqliteDigestStore(dbPath);
    const gate = await matchedGateFacts(firstStore, orca);
    const slack = new FakeSlack();
    let signalSnapshot!: () => void;
    let resumeStale!: () => void;
    const snapshotRead = new Promise<void>((resolve) => { signalSnapshot = resolve; });
    const staleResume = new Promise<void>((resolve) => { resumeStale = resolve; });
    try {
      const stalePublishing = publishGateCard(
        {
          store: staleStore,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date(AT),
          fault: async (point) => {
            if (point === 'after_gate_observation_reservation_before_confirmation') {
              signalSnapshot();
              await staleResume;
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      await snapshotRead;

      await publishGateCard(
        {
          store: firstStore,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T07:00:01.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      expect(firstStore.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
      resumeStale();
      await expect(stalePublishing).resolves.toMatchObject({ action: 'skip', messageTs: null });

      expect(slack.replies).toHaveLength(1);
      expect(slack.replies.every(noActionBlocks)).toBe(true);
      const actionable = slack.updates.filter((update) => !noActionBlocks(update));
      expect(actionable).toHaveLength(1);
      expect(actionable[0]?.ts).toBe(FIRST_GATE_TS);
      expect(staleStore.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
      expect(staleStore.findGateResolution(gate.key)).toBeNull();
    } finally {
      staleStore.close();
      firstStore.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      expect(reopened.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
      expect(reopened.claimGateResolution({
        teamId: 'T0TEAM',
        ownerUserId: 'U0OWNER',
        apiAppId: null,
        channelId: CHANNEL,
        threadTs: RUN_ROOT_TS,
        messageTs: FIRST_GATE_TS,
        blockId: gateBlockId(gate.key),
        actionId: gateActionId(gate.key, 'keep'),
        actionValue: 'keep',
        retryRequestId: '22222222-2222-4222-8222-222222222222',
        at: '2026-08-24T07:00:02.000Z',
      }).kind).toBe('claimed');
    } finally {
      reopened.close();
    }
  });

  it('same-timestamp newer exact render supersedes an older reserved publisher before Slack', async () => {
    const orca = new MutableFakeOrca();
    const bootstrapStore = new SqliteDigestStore(dbPath);
    const olderStore = new SqliteDigestStore(dbPath);
    const newerStore = new SqliteDigestStore(dbPath);
    insertSidecar(bootstrapStore);
    const gate = await matchedGateFacts(bootstrapStore, orca);
    const bootstrapSlack = new FakeSlack();
    let signalReserved!: () => void;
    let resumeOlder!: () => void;
    const reserved = new Promise<void>((resolve) => { signalReserved = resolve; });
    const olderResume = new Promise<void>((resolve) => { resumeOlder = resolve; });
    try {
      await publishGateCard(
        {
          store: bootstrapStore,
          slack: bootstrapSlack,
          thread: bootstrapSlack,
          channel: CHANNEL,
          now: () => new Date(AT),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );

      const sameAt = '2026-08-24T08:00:00.000Z';
      const olderSlack = new FakeSlack();
      const olderPublishing = publishGateCard(
        {
          store: olderStore,
          slack: olderSlack,
          thread: olderSlack,
          channel: CHANNEL,
          now: () => new Date(sameAt),
          fault: async (point) => {
            if (point === 'after_gate_observation_reservation_before_confirmation') {
              signalReserved();
              await olderResume;
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, question: 'same-time older reserved render' },
      );
      await reserved;

      const newerSlack = new FakeSlack();
      const newerPublishing = await publishGateCard(
        {
          store: newerStore,
          slack: newerSlack,
          thread: newerSlack,
          channel: CHANNEL,
          now: () => new Date(sameAt),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, question: 'same-time CURRENT exact render' },
      );
      expect(newerPublishing.action).toBe('update');
      expect(newerSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(JSON.stringify(newerSlack.updates[0])).toContain('same-time CURRENT exact render');
      expect(newerStore.findGateMessage(gate.key)?.renderFingerprint).toBe(newerPublishing.fingerprint);

      resumeOlder();
      await expect(olderPublishing).resolves.toMatchObject({
        action: 'skip',
        messageTs: FIRST_GATE_TS,
      });
      expect(olderSlack.updates).toEqual([]);
      expect(olderSlack.replies).toEqual([]);
      expect(olderStore.findGateMessage(gate.key)?.renderFingerprint).toBe(newerPublishing.fingerprint);
      expect(olderStore.findGateLocalObservation(gate.key)).toMatchObject({
        observedAt: sameAt,
        mappingState: 'matched',
      });
    } finally {
      resumeOlder();
      newerStore.close();
      olderStore.close();
      bootstrapStore.close();
    }
  });

  it('a crashed same-timestamp reservation invalidates an in-flight owner without an orphan or Slack call', async () => {
    const orca = new MutableFakeOrca();
    const ownerStore = new SqliteDigestStore(dbPath);
    const reservingStore = new SqliteDigestStore(dbPath);
    insertSidecar(ownerStore);
    const gate = await matchedGateFacts(ownerStore, orca);
    const bootstrapSlack = new FakeSlack();
    const blockingSlack = new BlockingGateSlack();
    const sameAt = '2026-08-24T08:00:00.000Z';
    const currentGate = { ...gate, question: 'current render reserved before crash' };
    let draining: Promise<unknown> | null = null;
    try {
      await publishGateCard(
        {
          store: ownerStore,
          slack: bootstrapSlack,
          thread: bootstrapSlack,
          channel: CHANNEL,
          now: () => new Date(AT),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      draining = publishGateCard(
        {
          store: ownerStore,
          slack: blockingSlack,
          thread: blockingSlack,
          channel: CHANNEL,
          now: () => new Date(sameAt),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, question: 'in-flight render invalidated by crashed reservation' },
      );
      await blockingSlack.gateUpdateStarted;

      const reservingSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store: reservingStore,
          slack: reservingSlack,
          thread: reservingSlack,
          channel: CHANNEL,
          now: () => new Date(sameAt),
          fault: (point) => {
            if (point === 'after_gate_observation_reservation_before_confirmation') {
              throw new Error('crash after durable observation reservation');
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        currentGate,
      )).rejects.toThrow(/crash after durable observation reservation/);
      expect(reservingSlack.updates).toEqual([]);
      expect(reservingSlack.replies).toEqual([]);
      expect(reservingStore.findGateLocalObservation(gate.key)).toMatchObject({
        status: 'pending',
        metadataState: 'matched',
        mappingState: 'write_pending',
        observedAt: sameAt,
      });
      expect(claimGate(
        reservingStore,
        gate.key,
        '92929292-9292-4292-8292-929292929292',
        sameAt,
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      blockingSlack.releaseGateUpdate();
      await expect(draining).rejects.toThrow(/더 새 관찰/);
      expect(blockingSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(ownerStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
    } finally {
      blockingSlack.releaseGateUpdate();
      if (draining !== null) await Promise.allSettled([draining]);
      reservingStore.close();
      ownerStore.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      const repairSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store: reopened,
          slack: repairSlack,
          thread: repairSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:30.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        currentGate,
      )).resolves.toMatchObject({ action: 'update', messageTs: FIRST_GATE_TS });
      const repairs = repairSlack.updates.filter((update) => update.ts === FIRST_GATE_TS);
      expect(repairs).toHaveLength(1);
      expect(JSON.stringify(repairs[0])).toContain('current render reserved before crash');
      expect(reopened.findGateLocalObservation(gate.key)).toMatchObject({
        status: 'pending',
        metadataState: 'matched',
        mappingState: 'matched',
        observedAt: '2026-08-24T08:00:30.000Z',
      });
    } finally {
      reopened.close();
    }
  });

  it.each([
    {
      identity: 'wrong channel',
      staleChannel: 'C0WRONGCHANNEL',
      staleRootTs: RUN_ROOT_TS,
    },
    {
      identity: 'wrong threadTs',
      staleChannel: CHANNEL,
      staleRootTs: '1787554800.999999',
    },
  ])('fails closed when a paused publisher has $identity despite the same runKey', async ({
    staleChannel,
    staleRootTs,
  }) => {
    const orca = new MutableFakeOrca();
    const canonicalStore = new SqliteDigestStore(dbPath);
    insertSidecar(canonicalStore);
    const staleStore = new SqliteDigestStore(dbPath);
    const gate = await matchedGateFacts(canonicalStore, orca);
    const slack = new FakeSlack();
    let signalSnapshot!: () => void;
    let resumeStale!: () => void;
    const snapshotRead = new Promise<void>((resolve) => { signalSnapshot = resolve; });
    const staleResume = new Promise<void>((resolve) => { resumeStale = resolve; });
    try {
      const stalePublishing = publishGateCard(
        {
          store: staleStore,
          slack,
          thread: slack,
          channel: staleChannel,
          now: () => new Date(AT),
          fault: async (point) => {
            if (point === 'after_gate_observation_reservation_before_confirmation') {
              signalSnapshot();
              await staleResume;
            }
          },
        },
        runKey(RUN_ID),
        staleRootTs,
        gate,
      );
      await snapshotRead;

      await publishGateCard(
        {
          store: canonicalStore,
          slack,
          thread: slack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T07:00:01.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      expect(canonicalStore.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
      resumeStale();
      await expect(stalePublishing).resolves.toMatchObject({ action: 'skip', messageTs: null });
      expect(staleStore.findGateLocalObservation(gate.key)?.mappingState).toBe('mismatched');

      expect(slack.replies).toHaveLength(1);
      expect(slack.replies.every(noActionBlocks)).toBe(true);
      const actionable = slack.updates.filter((update) => !noActionBlocks(update));
      expect(actionable).toHaveLength(1);
      expect(actionable[0]?.ts).toBe(FIRST_GATE_TS);
      expect(staleStore.findGateLocalObservation(gate.key)?.mappingState).toBe('mismatched');
      expect(staleStore.findGateResolution(gate.key)).toBeNull();
    } finally {
      staleStore.close();
      canonicalStore.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      expect(reopened.findGateLocalObservation(gate.key)?.mappingState).toBe('mismatched');
      expect(reopened.claimGateResolution({
        teamId: 'T0TEAM',
        ownerUserId: 'U0OWNER',
        apiAppId: null,
        channelId: CHANNEL,
        threadTs: RUN_ROOT_TS,
        messageTs: FIRST_GATE_TS,
        blockId: gateBlockId(gate.key),
        actionId: gateActionId(gate.key, 'keep'),
        actionValue: 'keep',
        retryRequestId: '33333333-3333-4333-8333-333333333333',
        at: '2026-08-24T07:00:02.000Z',
      })).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });
    } finally {
      reopened.close();
    }
  });

  it.each([
    {
      identity: 'wrong channel',
      wrongChannel: 'C0WRONGCHANNEL',
      wrongRootTs: RUN_ROOT_TS,
      expectedAction: 'channel_mismatch' as const,
    },
    {
      identity: 'wrong threadTs',
      wrongChannel: CHANNEL,
      wrongRootTs: '1787554800.999999',
      expectedAction: 'thread_mismatch' as const,
    },
  ])('repairs a same-fingerprint card after a no-Slack $identity mismatch without a claim window', async ({
    wrongChannel,
    wrongRootTs,
    expectedAction,
  }) => {
    const orca = new MutableFakeOrca();
    const canonicalStore = new SqliteDigestStore(dbPath);
    const wrongStore = new SqliteDigestStore(dbPath);
    const repairStore = new SqliteDigestStore(dbPath);
    const claimProbeStore = new SqliteDigestStore(dbPath);
    insertSidecar(canonicalStore);
    const gate = await matchedGateFacts(canonicalStore, orca);
    const initialSlack = new FakeSlack();
    const repairSlack = new BlockingGateSlack();
    let signalConfirmed!: () => void;
    let resumeRepair!: () => void;
    const confirmed = new Promise<void>((resolve) => { signalConfirmed = resolve; });
    const repairResume = new Promise<void>((resolve) => { resumeRepair = resolve; });
    let repairing: Promise<unknown> | null = null;
    try {
      const initial = await publishGateCard(
        {
          store: canonicalStore,
          slack: initialSlack,
          thread: initialSlack,
          channel: CHANNEL,
          now: () => new Date(AT),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      const originalFingerprint = canonicalStore.findGateMessage(gate.key)?.renderFingerprint;
      expect(originalFingerprint).toBe(initial.fingerprint);

      const wrongSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store: wrongStore,
          slack: wrongSlack,
          thread: wrongSlack,
          channel: wrongChannel,
          now: () => new Date('2026-08-24T08:00:00.000Z'),
        },
        runKey(RUN_ID),
        wrongRootTs,
        gate,
      )).resolves.toMatchObject({ action: expectedAction, fingerprint: originalFingerprint });
      expect(wrongSlack.updates).toEqual([]);
      expect(wrongSlack.replies).toEqual([]);
      expect(wrongStore.findGateMessage(gate.key)?.renderFingerprint).toBe(originalFingerprint);
      expect(wrongStore.findGateLocalObservation(gate.key)?.mappingState).toBe('mismatched');

      repairing = publishGateCard(
        {
          store: repairStore,
          slack: repairSlack,
          thread: repairSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:01.000Z'),
          fault: async (point) => {
            if (point === 'after_gate_observation_confirmation_before_write') {
              signalConfirmed();
              await repairResume;
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      await confirmed;
      expect(claimProbeStore.findGateLocalObservation(gate.key)?.mappingState).toBe('mismatched');
      expect(claimGate(
        claimProbeStore,
        gate.key,
        '35353535-3535-4535-8535-353535353535',
        '2026-08-24T08:00:01.000Z',
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      resumeRepair();
      await repairSlack.gateUpdateStarted;
      expect(claimProbeStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
      expect(claimGate(
        claimProbeStore,
        gate.key,
        '36363636-3636-4636-8636-363636363636',
        '2026-08-24T08:00:01.001Z',
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      repairSlack.releaseGateUpdate();
      await expect(repairing).resolves.toMatchObject({
        action: 'update',
        messageTs: FIRST_GATE_TS,
        fingerprint: originalFingerprint,
      });
      expect(repairSlack.updates).toHaveLength(1);
      expect(repairStore.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
      expect(claimGate(
        claimProbeStore,
        gate.key,
        '37373737-3737-4737-8737-373737373737',
        '2026-08-24T08:00:01.002Z',
      ).kind).toBe('claimed');
    } finally {
      repairSlack.releaseGateUpdate();
      resumeRepair();
      if (repairing !== null) await Promise.allSettled([repairing]);
      claimProbeStore.close();
      repairStore.close();
      wrongStore.close();
      canonicalStore.close();
    }
  });

  it.each([
    {
      identity: 'wrong channel',
      expectedChannel: 'C0WRONGCHANNEL',
      expectedThreadTs: RUN_ROOT_TS,
    },
    {
      identity: 'wrong threadTs',
      expectedChannel: CHANNEL,
      expectedThreadTs: '1787554800.999999',
    },
  ])('same-timestamp $identity invalidates a live ordinary completion until exact restart repair', async ({
    expectedChannel,
    expectedThreadTs,
  }) => {
    const orca = new MutableFakeOrca();
    const ownerStore = new SqliteDigestStore(dbPath);
    const identityStore = new SqliteDigestStore(dbPath);
    insertSidecar(ownerStore);
    const gate = await matchedGateFacts(ownerStore, orca);
    const initialSlack = new FakeSlack();
    const sameAt = '2026-08-24T08:00:00.000Z';
    let draining: Promise<unknown> | null = null;
    let initialFingerprint: string | null = null;
    const blockingSlack = new BlockingGateSlack();
    try {
      await publishGateCard(
        { store: ownerStore, slack: initialSlack, thread: initialSlack, channel: CHANNEL, now: () => new Date(AT) },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      initialFingerprint = ownerStore.findGateMessage(gate.key)?.renderFingerprint ?? null;
      draining = publishGateCard(
        {
          store: ownerStore,
          slack: blockingSlack,
          thread: blockingSlack,
          channel: CHANNEL,
          now: () => new Date(sameAt),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, question: 'same-time stale remote card' },
      );
      await blockingSlack.gateUpdateStarted;

      const mismatch = identityStore.saveGateLocalObservation({
        gateKey: gate.key,
        runKey: runKey(RUN_ID),
        taskKey: taskKey(GATE_TASK),
        status: 'pending',
        resolution: null,
        resolvedAt: null,
        metadataState: 'matched',
        mappingState: 'missing',
        observedAt: sameAt,
      }, {
        channelId: expectedChannel,
        threadTs: expectedThreadTs,
      });
      expect(mismatch.observation.mappingState).toBe('mismatched');
      expect(identityStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
      expect(claimGate(
        identityStore,
        gate.key,
        '44444444-4444-4444-8444-444444444444',
        sameAt,
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      const exactSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store: identityStore,
          slack: exactSlack,
          thread: exactSlack,
          channel: CHANNEL,
          now: () => new Date(sameAt),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      )).resolves.toMatchObject({ action: 'skip' });
      expect(exactSlack.updates).toEqual([]);
      expect(exactSlack.replies).toEqual([]);
      expect(identityStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
      expect(claimGate(
        identityStore,
        gate.key,
        '45454545-4545-4545-8545-454545454545',
        sameAt,
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      blockingSlack.releaseGateUpdate();
      await expect(draining).rejects.toThrow(/더 새 관찰/);
      expect(blockingSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(ownerStore.findGateMessage(gate.key)?.renderFingerprint).not.toBe(initialFingerprint);
      expect(ownerStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
    } finally {
      blockingSlack.releaseGateUpdate();
      if (draining !== null) await Promise.allSettled([draining]);
      identityStore.close();
      ownerStore.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      const repairSlack = new FakeSlack();
      await publishGateCard(
        {
          store: reopened,
          slack: repairSlack,
          thread: repairSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:30.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      expect(repairSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(reopened.findGateMessage(gate.key)?.renderFingerprint).toBe(initialFingerprint);
      expect(reopened.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
      expect(claimGate(
        reopened,
        gate.key,
        '55555555-5555-4555-8555-555555555555',
        '2026-08-24T08:00:30.001Z',
      ).kind).toBe('claimed');
    } finally {
      reopened.close();
    }
  });

  it('same-timestamp exact render drift fences stale Slack success and repairs once after restart', async () => {
    const orca = new MutableFakeOrca();
    const ownerStore = new SqliteDigestStore(dbPath);
    const newerStore = new SqliteDigestStore(dbPath);
    insertSidecar(ownerStore);
    const gate = await matchedGateFacts(ownerStore, orca);
    const initialSlack = new FakeSlack();
    const sameAt = '2026-08-24T08:00:00.000Z';
    const staleGate = { ...gate, question: 'older render at the same timestamp' };
    const currentGate = { ...gate, question: 'current render at the same timestamp' };
    const blockingSlack = new BlockingGateSlack();
    let draining: Promise<unknown> | null = null;
    try {
      await publishGateCard(
        { store: ownerStore, slack: initialSlack, thread: initialSlack, channel: CHANNEL, now: () => new Date(AT) },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      draining = publishGateCard(
        { store: ownerStore, slack: blockingSlack, thread: blockingSlack, channel: CHANNEL, now: () => new Date(sameAt) },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        staleGate,
      );
      await blockingSlack.gateUpdateStarted;

      const currentSlack = new FakeSlack();
      await expect(publishGateCard(
        { store: newerStore, slack: currentSlack, thread: currentSlack, channel: CHANNEL, now: () => new Date(sameAt) },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        currentGate,
      )).resolves.toMatchObject({ action: 'skip' });
      expect(currentSlack.updates).toEqual([]);
      expect(newerStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
      expect(claimGate(
        newerStore,
        gate.key,
        '66666666-6666-4666-8666-666666666666',
        sameAt,
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      blockingSlack.releaseGateUpdate();
      await expect(draining).rejects.toThrow(/더 새 관찰/);
      expect(ownerStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
    } finally {
      blockingSlack.releaseGateUpdate();
      if (draining !== null) await Promise.allSettled([draining]);
      newerStore.close();
      ownerStore.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      const repairSlack = new FakeSlack();
      await publishGateCard(
        {
          store: reopened,
          slack: repairSlack,
          thread: repairSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:30.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        currentGate,
      );
      const repairs = repairSlack.updates.filter((update) => update.ts === FIRST_GATE_TS);
      expect(repairs).toHaveLength(1);
      expect(JSON.stringify(repairs[0])).toContain('current render at the same timestamp');
      expect(reopened.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
    } finally {
      reopened.close();
    }
  });

  it('keeps a no-owner remote-dirty card unclaimable between exact confirmation and write ownership', async () => {
    const orca = new MutableFakeOrca();
    const ownerStore = new SqliteDigestStore(dbPath);
    const takeoverStore = new SqliteDigestStore(dbPath);
    const claimProbeStore = new SqliteDigestStore(dbPath);
    const repairStore = new SqliteDigestStore(dbPath);
    insertSidecar(ownerStore);
    const gate = await matchedGateFacts(ownerStore, orca);
    const bootstrapSlack = new FakeSlack();
    const staleSlack = new BlockingGateSlack();
    const ownerAt = '2026-08-24T08:00:00.000Z';
    let ownerNow = ownerAt;
    const currentGate = { ...gate, question: 'exact current card after no-owner remote drift' };
    let stalePublishing: Promise<unknown> | null = null;
    let signalConfirmed!: () => void;
    let resumeRepair!: () => void;
    const confirmed = new Promise<void>((resolve) => { signalConfirmed = resolve; });
    const repairResume = new Promise<void>((resolve) => { resumeRepair = resolve; });
    const repairSlack = new BlockingGateSlack();
    let repairing: Promise<unknown> | null = null;
    try {
      await publishGateCard(
        {
          store: ownerStore,
          slack: bootstrapSlack,
          thread: bootstrapSlack,
          channel: CHANNEL,
          now: () => new Date(AT),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      stalePublishing = publishGateCard(
        {
          store: ownerStore,
          slack: staleSlack,
          thread: staleSlack,
          channel: CHANNEL,
          now: () => new Date(ownerNow),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, question: 'stale remote card that lands after takeover' },
      );
      await staleSlack.gateUpdateStarted;

      const takeoverSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store: takeoverStore,
          slack: takeoverSlack,
          thread: takeoverSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:30.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        currentGate,
      )).resolves.toMatchObject({ action: 'update', messageTs: FIRST_GATE_TS });
      expect(takeoverStore.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');

      ownerNow = '2026-08-24T08:00:30.001Z';
      staleSlack.releaseGateUpdate();
      await expect(stalePublishing).rejects.toThrow(/더 새 관찰/);
      expect(ownerStore.findGateLocalObservation(gate.key)?.mappingState).toBe('mismatched');
      expect(claimGate(
        claimProbeStore,
        gate.key,
        '31313131-3131-4131-8131-313131313131',
        ownerNow,
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      repairing = publishGateCard(
        {
          store: repairStore,
          slack: repairSlack,
          thread: repairSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:30.002Z'),
          fault: async (point) => {
            if (point === 'after_gate_observation_confirmation_before_write') {
              signalConfirmed();
              await repairResume;
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        currentGate,
      );
      await confirmed;

      // Reservation and confirmation are separate SQLite transactions. The old remote card still
      // has buttons, so another process must continue to see fail-closed mapping in this window.
      expect(claimProbeStore.findGateLocalObservation(gate.key)?.mappingState).toBe('mismatched');
      expect(claimGate(
        claimProbeStore,
        gate.key,
        '32323232-3232-4232-8232-323232323232',
        '2026-08-24T08:00:30.002Z',
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      resumeRepair();
      await repairSlack.gateUpdateStarted;
      expect(claimProbeStore.findGateLocalObservation(gate.key)?.mappingState).toBe('write_pending');
      expect(claimGate(
        claimProbeStore,
        gate.key,
        '33333333-3333-4333-8333-333333333334',
        '2026-08-24T08:00:30.003Z',
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      repairSlack.releaseGateUpdate();
      await expect(repairing).resolves.toMatchObject({ action: 'update', messageTs: FIRST_GATE_TS });
      expect(repairStore.findGateLocalObservation(gate.key)?.mappingState).toBe('matched');
      expect(claimGate(
        claimProbeStore,
        gate.key,
        '34343434-3434-4434-8434-343434343434',
        '2026-08-24T08:00:30.004Z',
      ).kind).toBe('claimed');
    } finally {
      staleSlack.releaseGateUpdate();
      repairSlack.releaseGateUpdate();
      resumeRepair();
      if (stalePublishing !== null) await Promise.allSettled([stalePublishing]);
      if (repairing !== null) await Promise.allSettled([repairing]);
      repairStore.close();
      claimProbeStore.close();
      takeoverStore.close();
      ownerStore.close();
    }
  });

  it('a paused older pending snapshot cannot roll back a newer resolved card or start Slack', async () => {
    const orca = new MutableFakeOrca();
    const bootstrapStore = new SqliteDigestStore(dbPath);
    const oldStore = new SqliteDigestStore(dbPath);
    const resolvedStore = new SqliteDigestStore(dbPath);
    insertSidecar(bootstrapStore);
    const gate = await matchedGateFacts(bootstrapStore, orca);
    const initialSlack = new FakeSlack();
    let signalSnapshot!: () => void;
    let resumeOld!: () => void;
    const snapshotRead = new Promise<void>((resolve) => { signalSnapshot = resolve; });
    const oldResume = new Promise<void>((resolve) => { resumeOld = resolve; });
    try {
      await publishGateCard(
        { store: bootstrapStore, slack: initialSlack, thread: initialSlack, channel: CHANNEL, now: () => new Date(AT) },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      const oldSlack = new FakeSlack();
      const oldPublishing = publishGateCard(
        {
          store: oldStore,
          slack: oldSlack,
          thread: oldSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:00.000Z'),
          fault: async (point) => {
            if (point === 'after_gate_observation_reservation_before_confirmation') {
              signalSnapshot();
              await oldResume;
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, question: 'older pending render that must never reach Slack' },
      );
      await snapshotRead;

      const resolvedSlack = new FakeSlack();
      const resolvedAt = '2026-08-24T08:00:01.000Z';
      await publishGateCard(
        {
          store: resolvedStore,
          slack: resolvedSlack,
          thread: resolvedSlack,
          channel: CHANNEL,
          now: () => new Date(resolvedAt),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, status: 'resolved', resolution: '외부에서 이미 결정됨', resolvedAt },
      );
      const resolvedFingerprint = resolvedStore.findGateMessage(gate.key)?.renderFingerprint;
      expect(resolvedSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(resolvedSlack.updates.filter((update) => update.ts === FIRST_GATE_TS).every(noActionBlocks)).toBe(true);

      resumeOld();
      await expect(oldPublishing).resolves.toMatchObject({ action: 'skip' });
      expect(oldSlack.updates).toEqual([]);
      expect(oldSlack.replies).toEqual([]);
      expect(oldStore.findGateMessage(gate.key)?.renderFingerprint).toBe(resolvedFingerprint);
      expect(oldStore.findGateLocalObservation(gate.key)).toMatchObject({
        status: 'resolved',
        resolution: '외부에서 이미 결정됨',
        resolvedAt,
        observedAt: resolvedAt,
        mappingState: 'matched',
      });
      expect(claimGate(
        oldStore,
        gate.key,
        '77777777-7777-4777-8777-777777777777',
        '2026-08-24T08:00:02.000Z',
      )).toEqual({ kind: 'rejected', reason: 'stale_or_resolved' });
    } finally {
      resumeOld();
      resolvedStore.close();
      oldStore.close();
      bootstrapStore.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      expect(reopened.findGateLocalObservation(gate.key)?.status).toBe('resolved');
      expect(claimGate(
        reopened,
        gate.key,
        '88888888-8888-4888-8888-888888888888',
        '2026-08-24T08:00:03.000Z',
      )).toEqual({ kind: 'rejected', reason: 'stale_or_resolved' });
    } finally {
      reopened.close();
    }
  });

  it('an in-flight pending Slack success stays fenced behind a newer resolved observation until expiry repair', async () => {
    const orca = new MutableFakeOrca();
    const ownerStore = new SqliteDigestStore(dbPath);
    const resolvedStore = new SqliteDigestStore(dbPath);
    insertSidecar(ownerStore);
    const gate = await matchedGateFacts(ownerStore, orca);
    const bootstrapSlack = new FakeSlack();
    const blockingSlack = new BlockingGateSlack();
    const ownerAt = '2026-08-24T08:00:00.000Z';
    const resolvedAt = '2026-08-24T08:00:00.000Z';
    const resolvedGate = {
      ...gate,
      status: 'resolved' as const,
      resolution: '외부에서 이미 결정됨',
      resolvedAt,
    };
    let draining: Promise<unknown> | null = null;
    try {
      await publishGateCard(
        {
          store: ownerStore,
          slack: bootstrapSlack,
          thread: bootstrapSlack,
          channel: CHANNEL,
          now: () => new Date(AT),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        gate,
      );
      draining = publishGateCard(
        {
          store: ownerStore,
          slack: blockingSlack,
          thread: blockingSlack,
          channel: CHANNEL,
          now: () => new Date(ownerAt),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...gate, question: 'old pending render already accepted by Slack' },
      );
      await blockingSlack.gateUpdateStarted;

      const resolvedSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store: resolvedStore,
          slack: resolvedSlack,
          thread: resolvedSlack,
          channel: CHANNEL,
          now: () => new Date(resolvedAt),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        resolvedGate,
      )).resolves.toMatchObject({ action: 'skip', messageTs: FIRST_GATE_TS });
      expect(resolvedSlack.updates).toEqual([]);
      expect(resolvedSlack.replies).toEqual([]);
      expect(resolvedStore.findGateLocalObservation(gate.key)).toMatchObject({
        status: 'resolved',
        resolution: '외부에서 이미 결정됨',
        resolvedAt,
        mappingState: 'write_pending',
      });
      expect(claimGate(
        resolvedStore,
        gate.key,
        '89898989-8989-4989-8989-898989898989',
        resolvedAt,
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      blockingSlack.releaseGateUpdate();
      await expect(draining).rejects.toThrow(/더 새 관찰/);
      expect(blockingSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(ownerStore.findGateLocalObservation(gate.key)).toMatchObject({
        status: 'resolved',
        resolution: '외부에서 이미 결정됨',
        resolvedAt,
        mappingState: 'write_pending',
      });
      expect(claimGate(
        ownerStore,
        gate.key,
        '90909090-9090-4090-8090-909090909090',
        '2026-08-24T08:00:00.001Z',
      )).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });
    } finally {
      blockingSlack.releaseGateUpdate();
      if (draining !== null) await Promise.allSettled([draining]);
      resolvedStore.close();
      ownerStore.close();
    }

    const reopened = new SqliteDigestStore(dbPath);
    try {
      const repairSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store: reopened,
          slack: repairSlack,
          thread: repairSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:30.000Z'),
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        resolvedGate,
      )).resolves.toMatchObject({ action: 'update', messageTs: FIRST_GATE_TS });
      const repairs = repairSlack.updates.filter((update) => update.ts === FIRST_GATE_TS);
      expect(repairs).toHaveLength(1);
      expect(repairs.every(noActionBlocks)).toBe(true);
      expect(reopened.findGateLocalObservation(gate.key)).toMatchObject({
        status: 'resolved',
        resolution: '외부에서 이미 결정됨',
        resolvedAt,
        mappingState: 'matched',
      });
      expect(claimGate(
        reopened,
        gate.key,
        '91919191-9191-4191-8191-919191919191',
        '2026-08-24T08:00:30.001Z',
      )).toEqual({ kind: 'rejected', reason: 'stale_or_resolved' });
    } finally {
      reopened.close();
    }
  });

  it('새 unknown Orca 상태가 이전 pending 관찰을 unsupported로 덮어써 stale action을 막는다', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const slack = new FakeSlack();
    try {
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack, thread: slack, now: () => new Date(AT),
      });
      expect(store.findGateLocalObservation(gateKey(GATE_ID))?.status).toBe('pending');

      orca.gateStatus = 'future_state';
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack, thread: slack,
        now: () => new Date('2026-08-24T08:00:00.000Z'),
      });
      expect(store.findGateLocalObservation(gateKey(GATE_ID))).toMatchObject({
        status: 'unsupported', resolution: null, resolvedAt: null,
      });
    } finally {
      store.close();
    }
  });

  it('ordinary observations preserve the durable D2 card and never restore fixed-action buttons', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const initialSlack = new FakeSlack();
    try {
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: initialSlack, thread: initialSlack,
        now: () => new Date(AT),
      });
      const gate = gateKey(GATE_ID);
      const claim = store.claimGateResolution({
        teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: null,
        channelId: CHANNEL, threadTs: RUN_ROOT_TS, messageTs: FIRST_GATE_TS,
        blockId: gateBlockId(gate), actionId: gateActionId(gate, 'keep'), actionValue: 'keep',
        retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
      });
      if (claim.kind !== 'claimed') throw new Error('claim failed');
      expect(store.markGateResolutionAck(gate, claim.intent.revision, 'acked', AT)).not.toBeNull();

      const d2Slack = new FakeSlack();
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: d2Slack, thread: d2Slack,
        now: () => new Date('2026-08-24T08:00:00.000Z'),
      });
      const d2Update = d2Slack.updates.find((update) => update.ts === FIRST_GATE_TS);
      expect(JSON.stringify(d2Update)).toContain('Coordinator 통지 대기');
      expect(JSON.stringify(d2Update)).not.toContain('"type":"actions"');
      const d2Fingerprint = store.findGateMessage(gate)?.renderFingerprint;

      orca.gateQuestion = 'observer가 바꾼 prose는 D2 카드 소스가 아니다';
      const observedAgain = new FakeSlack();
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: observedAgain, thread: observedAgain,
        now: () => new Date('2026-08-24T09:00:00.000Z'),
      });
      expect(observedAgain.updates.filter((update) => update.ts === FIRST_GATE_TS)).toEqual([]);
      expect(store.findGateMessage(gate)?.renderFingerprint).toBe(d2Fingerprint);
      expect(store.findGateResolutionOutbox(gate)?.cardPending).toBe(false);
    } finally {
      store.close();
    }
  });

  it('the durable ordinary-write fence excludes a concurrent Gate winner before Slack completion', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    const concurrentStore = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const initialSlack = new FakeSlack();
    try {
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: initialSlack, thread: initialSlack,
        now: () => new Date(AT),
      });
      orca.gateQuestion = 'ordinary update in flight';
      const racingSlack = new BlockingGateSlack();
      const observing = runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: racingSlack, thread: racingSlack,
        now: () => new Date('2026-08-24T08:00:00.000Z'),
      });
      await racingSlack.gateUpdateStarted;
      const gate = gateKey(GATE_ID);
      // A second production observer cannot erase or take over the live owner's durable fence.
      const concurrentSlack = new FakeSlack();
      await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store: concurrentStore,
        slack: concurrentSlack,
        thread: concurrentSlack,
        now: () => new Date('2026-08-24T08:00:01.000Z'),
      });
      expect(concurrentSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toEqual([]);
      expect(concurrentStore.findGateLocalObservation(gate)?.mappingState).toBe('write_pending');
      const blockedClaim = concurrentStore.claimGateResolution({
        teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: null,
        channelId: CHANNEL, threadTs: RUN_ROOT_TS, messageTs: FIRST_GATE_TS,
        blockId: gateBlockId(gate), actionId: gateActionId(gate, 'keep'), actionValue: 'keep',
        retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
      });
      expect(blockedClaim).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });
      expect(store.findGateResolution(gate)).toBeNull();
      racingSlack.releaseGateUpdate();
      await expect(observing).rejects.toThrow(/더 새 관찰/);

      const gateUpdates = racingSlack.updates.filter((update) => update.ts === FIRST_GATE_TS);
      expect(gateUpdates).toHaveLength(1);
      expect(JSON.stringify(gateUpdates[0])).toContain('ordinary update in flight');
      expect(store.findGateLocalObservation(gate)?.mappingState).toBe('write_pending');
      expect(store.claimGateResolution({
        teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: null,
        channelId: CHANNEL, threadTs: RUN_ROOT_TS, messageTs: FIRST_GATE_TS,
        blockId: gateBlockId(gate), actionId: gateActionId(gate, 'keep'), actionValue: 'keep',
        retryRequestId: '22222222-2222-4222-8222-222222222222', at: AT,
      })).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

      const repairSlack = new FakeSlack();
      await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store,
        slack: repairSlack,
        thread: repairSlack,
        now: () => new Date('2026-08-24T08:00:02.000Z'),
      });
      expect(repairSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(store.findGateLocalObservation(gate)?.mappingState).toBe('matched');
      const recoveredClaim = store.claimGateResolution({
        teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: null,
        channelId: CHANNEL, threadTs: RUN_ROOT_TS, messageTs: FIRST_GATE_TS,
        blockId: gateBlockId(gate), actionId: gateActionId(gate, 'keep'), actionValue: 'keep',
        retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
      });
      expect(recoveredClaim.kind).toBe('claimed');
    } finally {
      concurrentStore.close();
      store.close();
    }
  });

  it('a crash after ordinary Slack success is settled by the next production observer pass', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath, {
      observationWriteOwner: `p${process.pid}.crashed-observer`,
    });
    insertSidecar(store);
    const initialSlack = new FakeSlack();
    try {
      const initial = await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: initialSlack, thread: initialSlack,
        now: () => new Date(AT),
      });
      const observedGate = initial.facts.runs[0]?.gates.find((gate) => gate.gateId === GATE_ID);
      if (observedGate === undefined) throw new Error('observed Gate missing');
      const gate = gateKey(GATE_ID);
      const crashSlack = new FakeSlack();
      await expect(publishGateCard(
        {
          store,
          slack: crashSlack,
          thread: crashSlack,
          channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:00.000Z'),
          fault: (point) => {
            if (point === 'after_static_slack_before_observation') {
              throw new Error('process died after Slack success');
            }
          },
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...observedGate, question: 'ordinary update applied before process death' },
      )).rejects.toThrow(/after Slack success/);
      expect(crashSlack.updates).toHaveLength(1);
      expect(store.findGateLocalObservation(gate)?.mappingState).toBe('write_pending');
      expect(store.findGateResolution(gate)).toBeNull();
    } finally {
      store.close();
    }
    const reopened = new SqliteDigestStore(dbPath, { observationOwnerAlive: () => true });
    try {
      const gate = gateKey(GATE_ID);
      expect(reopened.findGateLocalObservation(gate)?.mappingState).toBe('write_pending');
      orca.gateQuestion = 'ordinary update applied before process death';
      const reusedPidSlack = new FakeSlack();
      await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store: reopened,
        slack: reusedPidSlack,
        thread: reusedPidSlack,
        now: () => new Date('2026-08-24T08:00:29.999Z'),
      });
      expect(reusedPidSlack.updates.filter((update) => update.ts === FIRST_GATE_TS)).toEqual([]);
      expect(reopened.findGateLocalObservation(gate)?.mappingState).toBe('write_pending');
      const recoverySlack = new FakeSlack();
      await runRunObserver(orca, {
        config: CONFIG,
        channel: CHANNEL,
        store: reopened,
        slack: recoverySlack,
        thread: recoverySlack,
        now: () => new Date('2026-08-24T08:00:30.000Z'),
      });
      const gateUpdates = recoverySlack.updates.filter((update) => update.ts === FIRST_GATE_TS);
      expect(gateUpdates).toHaveLength(1);
      expect(JSON.stringify(gateUpdates[0])).toContain('ordinary update applied before process death');
      expect(reopened.findGateLocalObservation(gate)?.mappingState).toBe('matched');
      expect(reopened.claimGateResolution({
        teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: null,
        channelId: CHANNEL, threadTs: RUN_ROOT_TS, messageTs: FIRST_GATE_TS,
        blockId: gateBlockId(gate), actionId: gateActionId(gate, 'keep'), actionValue: 'keep',
        retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
      }).kind).toBe('claimed');
    } finally {
      reopened.close();
    }
  });

  it('a catchable ordinary Slack failure releases local ownership for the same daemon retry', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const initialSlack = new FakeSlack();
    try {
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: initialSlack, thread: initialSlack,
        now: () => new Date(AT),
      });
      const gate = gateKey(GATE_ID);
      orca.gateQuestion = 'catchable failure must be retried by this process';
      const failedSlack = new FailOnceGateUpdateSlack();
      await expect(runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: failedSlack, thread: failedSlack,
        now: () => new Date('2026-08-24T08:00:00.000Z'),
      })).rejects.toThrow(/unavailable once/);
      expect(store.findGateLocalObservation(gate)?.mappingState).toBe('write_pending');

      const retrySlack = new FakeSlack();
      await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: retrySlack, thread: retrySlack,
        now: () => new Date('2026-08-24T08:00:01.000Z'),
      });
      const gateUpdates = retrySlack.updates.filter((update) => update.ts === FIRST_GATE_TS);
      expect(gateUpdates).toHaveLength(1);
      expect(JSON.stringify(gateUpdates[0])).toContain('catchable failure must be retried');
      expect(store.findGateLocalObservation(gate)?.mappingState).toBe('matched');
    } finally {
      store.close();
    }
  });

  it('a never-settling ordinary Gate update times out before its lease and can retry', async () => {
    const orca = new MutableFakeOrca();
    const store = new SqliteDigestStore(dbPath);
    insertSidecar(store);
    const initialSlack = new FakeSlack();
    try {
      const initial = await runRunObserver(orca, {
        config: CONFIG, channel: CHANNEL, store, slack: initialSlack, thread: initialSlack,
        now: () => new Date(AT),
      });
      const observedGate = initial.facts.runs[0]?.gates.find((gate) => gate.gateId === GATE_ID);
      if (observedGate === undefined) throw new Error('observed Gate missing');
      const gate = gateKey(GATE_ID);
      const hanging = new NeverSettlingGateUpdateSlack();
      const began = Date.now();
      await expect(publishGateCard(
        {
          store, slack: hanging, thread: hanging, channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:00.000Z'), slackTimeoutMs: 10,
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...observedGate, question: 'bounded ordinary update' },
      )).rejects.toThrow(/deadline/);
      expect(Date.now() - began).toBeLessThan(1_000);
      expect(store.findGateLocalObservation(gate)?.mappingState).toBe('write_pending');

      const retry = new FakeSlack();
      await publishGateCard(
        {
          store, slack: retry, thread: retry, channel: CHANNEL,
          now: () => new Date('2026-08-24T08:00:01.000Z'), slackTimeoutMs: 10,
        },
        runKey(RUN_ID),
        RUN_ROOT_TS,
        { ...observedGate, question: 'bounded ordinary update' },
      );
      expect(retry.updates.filter((update) => update.ts === FIRST_GATE_TS)).toHaveLength(1);
      expect(store.findGateLocalObservation(gate)?.mappingState).toBe('matched');
    } finally {
      store.close();
    }
  });
});
