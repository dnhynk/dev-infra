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
const RAW_ONLY_GATE = 'gate_without_sidecar';
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
        taskRow('task_independent'),
      ];
      result = { tasks, count: tasks.length };
    } else if (command === 'gate-list') {
      result = {
        gates: [
          gateRow(GATE_ID, GATE_TASK, this.gateQuestion, ['기존 유지', '변경'], this.gateStatus),
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

      expect(report.facts.runs[0]?.gates.map((gate) => gate.metadataState)).toEqual([
        'matched',
        'missing',
      ]);
      expect(report.published.gates.map((gate) => gate.action)).toEqual(['create', 'create']);
      expect(slack.posts).toHaveLength(2); // collection root + Run root
      expect(slack.replies).toHaveLength(2);
      expect(slack.replies.map((reply) => reply.threadTs)).toEqual([RUN_ROOT_TS, RUN_ROOT_TS]);
      expect(noActionBlocks(slack.replies[0] ?? { blocks: [] })).toBe(true);
      expect(noActionBlocks(slack.replies[1] ?? { blocks: [] })).toBe(true);
      const promoted = slack.updates.find((update) => update.ts === FIRST_GATE_TS);
      expect(noActionBlocks(promoted ?? { blocks: [] })).toBe(false);
      expect(JSON.stringify(promoted?.blocks)).toContain('"value":"keep"');
      expect(slack.replies[0]?.text).toContain('정적 Gate card');
      expect(JSON.stringify(promoted?.blocks)).toContain('현재 소비자와 호환된다');
      expect(JSON.stringify(slack.replies[1]?.blocks)).toContain('추측하지 않음');

      const matched = store.findGateMessage(gateKey(GATE_ID));
      const degraded = store.findGateMessage(gateKey(RAW_ONLY_GATE));
      expect(matched).toMatchObject({ threadTs: RUN_ROOT_TS, messageTs: FIRST_GATE_TS });
      expect(degraded).toMatchObject({ threadTs: RUN_ROOT_TS, messageTs: '1787554800.000102' });
      expect(store.findGateLocalObservation(gateKey(GATE_ID))).toMatchObject({
        status: 'pending', metadataState: 'matched', mappingState: 'matched',
      });
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

  it('does not let a stale first-publisher snapshot downgrade the canonical mapped card', async () => {
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
            if (point === 'after_gate_message_snapshot_before_observation') {
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
      await expect(stalePublishing).rejects.toThrow(/thread 메시지를 기록할 수 없다/);

      expect(slack.replies).toHaveLength(2);
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
      await observing;

      const gateUpdates = racingSlack.updates.filter((update) => update.ts === FIRST_GATE_TS);
      expect(gateUpdates).toHaveLength(1);
      expect(JSON.stringify(gateUpdates[0])).toContain('ordinary update in flight');
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
