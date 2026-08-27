import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs, runDaemonCommand as runDaemonCommandWithNativeStatus } from '../src/cli.js';
import type {
  ChannelPipeErrorCode,
  ChannelProductionDeliveryHandlers,
} from '../src/channel/pipe-server.js';
import {
  gateActionId,
  gateBlockId,
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
  gateDirectInputActionId,
  gateDirectInputBlockId,
} from '../src/gate/actions.js';
import { GATE_DIRECT_OPTION_ID } from '../src/gate/direct-input-types.js';
import type { GateSnapshot } from '../src/gate/resolution-types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';
import type { PostMessageInput, PostedMessage, SlackPoster, UpdateMessageInput } from '../src/slack/post.js';
import type { SocketConnectionFactory, SocketConnectionHooks } from '../src/slack/socket.js';
import type { OpenSlackViewInput, OpenedSlackView, SlackViewOpener } from '../src/slack/views.js';
import { APP_TOKEN_VAR } from '../src/slack/verify.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import type {
  OperationalStatusSnapshotLease,
  OperationalStatusSnapshotLeaseStore,
} from '../src/operational/status-capability.js';

const GATE_ID = 'gate_daemon';
const RUN_ID = 'run_daemon';
const TASK_ID = 'task_daemon';
const GATE = gateKey(GATE_ID);
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const AT = '2026-08-24T10:00:00.000Z';
const CONFIG: BridgeConfig = {
  slack: {
    teamId: 'T0TEAM', apiAppId: 'A0APP', ownerUserIds: ['U0OWNER'],
    channels: { prDigest: 'C0PRDIGEST', agentRuns: CHANNEL },
  },
  projects: [],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

const TEST_STATUS_OWNER_SERVER = {
  start: () => Promise.resolve(),
  refresh: () => undefined,
  stop: () => Promise.resolve(),
};

class MemorySnapshotLeaseStore implements OperationalStatusSnapshotLeaseStore {
  held = false;

  async tryAcquireSnapshotLease(): Promise<OperationalStatusSnapshotLease | null> {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return {
      assertHeld: () => {
        if (released || !this.held) throw new Error('status.snapshot_lease_lost');
      },
      release: async () => {
        if (released) return;
        released = true;
        this.held = false;
      },
    };
  }
}

async function runDaemonCommand(
  ...args: Parameters<typeof runDaemonCommandWithNativeStatus>
): Promise<number> {
  const [parsed, config, dependencies] = args;
  return await runDaemonCommandWithNativeStatus(parsed, config, {
    ...(dependencies ?? {}),
    statusOwnerServer: dependencies?.statusOwnerServer ?? TEST_STATUS_OWNER_SERVER,
    statusSnapshotLeaseStore: dependencies?.statusSnapshotLeaseStore ??
      new MemorySnapshotLeaseStore(),
  });
}

let dir: string;
let statePath: string;
let previousAppToken: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cli-daemon-'));
  statePath = join(dir, 'state.db');
  previousAppToken = process.env[APP_TOKEN_VAR];
  process.env[APP_TOKEN_VAR] = ['xapp', 'FAKE', 'NOTAREALTOKEN'].join('-');
});
afterEach(() => {
  if (previousAppToken === undefined) delete process.env[APP_TOKEN_VAR];
  else process.env[APP_TOKEN_VAR] = previousAppToken;
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  const store = new SqliteDigestStore(statePath);
  store.insertGateMetadata({
    gateKey: GATE, runKey: runKey(RUN_ID), taskKey: taskKey(TASK_ID),
    dispatchKey: dispatchKey('ctx_daemon'), askMessageId: 'msg_daemon',
    questionThreadId: 'thread_daemon',
    options: [{ id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' }],
    recommendation: { optionId: 'keep', reason: '호환성' }, impact: '후속 방향', registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: GATE, runKey: runKey(RUN_ID), channelId: CHANNEL, threadTs: THREAD_TS,
    messageTs: MESSAGE_TS, renderFingerprint: 'fp', at: AT,
  });
  store.saveGateLocalObservation({
    gateKey: GATE, runKey: runKey(RUN_ID), taskKey: taskKey(TASK_ID), status: 'pending',
    resolution: null, resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: AT,
  });
  store.close();
}

function ownTerminalProjection(): SqliteDigestStore {
  const store = new SqliteDigestStore(statePath);
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
    threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'), actionValue: 'keep',
    retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('ACK persistence failed');
  const leased = store.acquireGateResolutionLease(
    GATE,
    't.daemon-terminal-seed',
    AT,
    '2026-08-24T10:01:00.000Z',
  );
  if (leased.kind !== 'acquired') throw new Error(`lease failed: ${leased.kind}`);
  const terminal = store.updateGateResolution(GATE, leased.intent.revision, 't.daemon-terminal-seed', {
    lifecycle: 'degraded', errorCode: 'seeded_degraded', at: AT,
  });
  if (terminal === null) throw new Error('terminal seed failed');
  store.releaseGateResolutionLease(GATE, 't.daemon-terminal-seed');
  const outbox = store.findGateResolutionOutbox(GATE);
  if (outbox === null) throw new Error('outbox seed failed');
  const acquired = store.acquireGateOutboxProjection(
    GATE,
    outbox.revision,
    `p${process.pid}.startup-projector`,
    new Date().toISOString(),
  );
  if (acquired !== 'acquired') throw new Error(`projection seed failed: ${acquired}`);
  return store;
}

function claimPendingIntent(): void {
  const store = new SqliteDigestStore(statePath);
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
    threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'), actionValue: 'keep',
    retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  if (store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT) === null) {
    throw new Error('ACK persistence failed');
  }
  store.close();
}

function seedPostMutationCrash(): void {
  seed();
  const store = new SqliteDigestStore(statePath);
  const requestId = '11111111-1111-4111-8111-111111111111';
  const pending: GateSnapshot = {
    gateId: GATE_ID, runId: RUN_ID, taskId: TASK_ID, options: ['현행 유지'],
    status: 'pending', resolution: null, resolvedAt: null,
  };
  const resolved: GateSnapshot = {
    ...pending, status: 'resolved', resolution: '현행 유지', resolvedAt: AT,
  };
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
    threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'), actionValue: 'keep', retryRequestId: requestId, at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('ACK persistence failed');
  const lease = store.acquireGateResolutionLease(
    GATE, 't.post-mutation-crash', AT, '2026-08-24T10:01:00.000Z',
  );
  if (lease.kind !== 'acquired') throw new Error(`lease failed: ${lease.kind}`);
  const pre = store.updateGateResolution(GATE, lease.intent.revision, 't.post-mutation-crash', {
    lifecycle: 'pre_read', preRead: pending, at: AT,
  });
  if (pre === null) throw new Error('pre-read persistence failed');
  const resolving = store.updateGateResolution(GATE, pre.revision, 't.post-mutation-crash', {
    lifecycle: 'resolving', at: AT,
  });
  if (resolving === null) throw new Error('resolving persistence failed');
  const result = store.updateGateResolution(
    GATE,
    resolving.revision,
    't.post-mutation-crash',
    {
      lifecycle: 'post_read',
      resolveResult: { gate: resolved, mutation: { requestId, replayed: false } },
      at: AT,
    },
  );
  if (result === null) throw new Error('structured result persistence failed');
  store.releaseGateResolutionLease(GATE, 't.post-mutation-crash');
  store.close();
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for reconciliation');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeOrca implements OrcaRunner {
  resolved = false;
  resolution = '현행 유지';
  blockFirstList = false;
  readonly calls: string[][] = [];
  private releaseBlockedList!: () => void;
  private readonly blockedList = new Promise<void>((resolve) => { this.releaseBlockedList = resolve; });
  protected gate(): Record<string, unknown> {
    return {
      id: GATE_ID, run_id: RUN_ID, task_id: TASK_ID, question: '표시용',
      options: '["현행 유지"]', status: this.resolved ? 'resolved' : 'pending',
      resolution: this.resolved ? this.resolution : null,
      created_at: '2026-08-24T09:00:00.000Z', resolved_at: this.resolved ? AT : null,
    };
  }
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[1] === 'run-show') {
      return Promise.resolve(JSON.stringify({
        id: 'run', ok: true,
        result: {
          run: {
            id: RUN_ID,
            objective: 'test',
            home_database: 'this_database',
            coordinator_handle: 'term_current_coordinator',
            coordinator_pane_key: 'tab:pane',
            consumer_generation: 2,
            legacy: 0,
            created_at: '2026-08-24T09:00:00.000Z',
            updated_at: '2026-08-24T10:00:00.000Z',
          },
        },
      }));
    }
    if (args[1] === 'gate-list') {
      const response = JSON.stringify({ id: 'x', ok: true, result: { runId: RUN_ID, gates: [this.gate()], count: 1 } });
      if (this.blockFirstList && this.calls.filter((call) => call[1] === 'gate-list').length === 1) {
        return this.blockedList.then(() => response);
      }
      return Promise.resolve(response);
    }
    if (args[1] === 'gate-resolve') {
      this.resolved = true;
      this.resolution = args[args.indexOf('--resolution') + 1] ?? this.resolution;
      const request = args[args.indexOf('--retry-request') + 1];
      return Promise.resolve(JSON.stringify({
        id: 'x', ok: true,
        result: { gate: this.gate(), mutation: { requestId: request, replayed: false } },
      }));
    }
    return Promise.reject(new Error('unexpected command'));
  }

  releaseList(): void {
    this.releaseBlockedList();
  }
}

class FakeViewOpener implements SlackViewOpener {
  readonly calls: OpenSlackViewInput[] = [];
  async open(input: OpenSlackViewInput): Promise<OpenedSlackView> {
    this.calls.push(input);
    return {
      id: 'V0DIRECT',
      teamId: 'T0TEAM',
      appId: 'A0APP',
      callbackId: input.view.callback_id ?? '',
      privateMetadata: input.view.private_metadata ?? '',
    };
  }
}

class FakeSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  post(_input: PostMessageInput): Promise<PostedMessage> { return Promise.reject(new Error('unused')); }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return Promise.resolve({ channel: input.channel, ts: input.ts });
  }
}

class NeverSettlingOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return new Promise<string>(() => undefined);
  }
}

class NeverSettlingSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('unused'));
  }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return new Promise(() => undefined);
  }
}

class FakeChannelServer {
  readonly events: string[];
  readonly failStart: boolean;
  productionHandlers: ChannelProductionDeliveryHandlers | null = null;
  readonly failure: Promise<ChannelPipeErrorCode>;
  private fail!: (code: ChannelPipeErrorCode) => void;

  constructor(events: string[] = [], failStart = false) {
    this.events = events;
    this.failStart = failStart;
    this.failure = new Promise((resolve) => { this.fail = resolve; });
  }

  async start(): Promise<void> {
    this.events.push('channel:start');
    if (this.failStart) throw new Error('pipe_in_use');
  }

  async stop(): Promise<void> {
    this.events.push('channel:stop');
  }

  quiesce(): void {
    this.events.push('channel:quiesce');
  }

  waitForFailure(): Promise<ChannelPipeErrorCode> {
    return this.failure;
  }

  triggerRuntimeFailure(): void {
    this.fail('pipe_runtime_error');
  }

  async deliverGate(): Promise<{ readonly kind: 'pending'; readonly code: 'no_candidate' }> {
    return { kind: 'pending', code: 'no_candidate' };
  }

  setProductionDeliveryHandlers(handlers: ChannelProductionDeliveryHandlers): void {
    this.productionHandlers = handlers;
  }
}

describe('daemon production wiring', () => {
  it('holds the snapshot lease from before writable store open through owner shutdown', async () => {
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const events: string[] = [];
    let held = false;
    const snapshotLeaseStore: OperationalStatusSnapshotLeaseStore = {
      tryAcquireSnapshotLease: async () => {
        events.push('lease:acquire');
        held = true;
        return {
          assertHeld: () => {
            if (!held) throw new Error('status.snapshot_lease_lost');
          },
          release: async () => {
            events.push('lease:release');
            held = false;
          },
        };
      },
    };
    const code = await runDaemonCommand(parsed, CONFIG, {
      statusSnapshotLeaseStore: snapshotLeaseStore,
      openStore: (path) => {
        expect(held).toBe(true);
        events.push('store:open');
        const store = new SqliteDigestStore(path);
        const close = store.close.bind(store);
        store.close = () => {
          expect(held).toBe(true);
          events.push('store:close');
          close();
        };
        return store;
      },
      statusOwnerServer: {
        start: () => {
          expect(held).toBe(true);
          events.push('owner:start');
          return Promise.resolve();
        },
        refresh: () => undefined,
        stop: () => {
          expect(held).toBe(true);
          events.push('owner:stop');
          return Promise.resolve();
        },
      },
      channelServer: new FakeChannelServer(),
      orca: new FakeOrca(),
      slack: new FakeSlack(),
      connectionFactory: () => ({
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => Promise.resolve(),
      }),
      waitForStop: () => Promise.resolve(),
    });
    expect(code).toBe(0);
    expect(events).toEqual([
      'lease:acquire', 'store:open', 'owner:start', 'owner:stop', 'store:close',
      'lease:release',
    ]);
    expect(held).toBe(false);
  });

  it('retains the snapshot lease and fails boundedly when writable store closure is uncertain', async () => {
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const privateDetail = 'SENTINEL_PRIVATE_STORE_CLOSE_DETAIL';
    const events: string[] = [];
    const diagnostics: string[] = [];
    let held = false;
    let releaseCalls = 0;
    const physicalClose: { current: (() => void) | null } = { current: null };
    const snapshotLeaseStore: OperationalStatusSnapshotLeaseStore = {
      tryAcquireSnapshotLease: async () => {
        if (held) return null;
        events.push('lease:acquire');
        held = true;
        return {
          assertHeld: () => {
            if (!held) throw new Error('status.snapshot_lease_lost');
          },
          release: async () => {
            releaseCalls += 1;
            events.push('lease:release');
            held = false;
          },
        };
      },
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((
      (value: string | Uint8Array) => {
        diagnostics.push(String(value));
        return true;
      }
    ) as typeof process.stderr.write);

    try {
      const code = await runDaemonCommand(parsed, CONFIG, {
        statusSnapshotLeaseStore: snapshotLeaseStore,
        openStore: (path) => {
          expect(held).toBe(true);
          events.push('store:open');
          const store = new SqliteDigestStore(path);
          physicalClose.current = store.close.bind(store);
          store.close = () => {
            expect(held).toBe(true);
            events.push('store:close');
            throw new Error(privateDetail);
          };
          return store;
        },
        statusOwnerServer: {
          start: () => {
            expect(held).toBe(true);
            events.push('owner:start');
            return Promise.resolve();
          },
          refresh: () => undefined,
          stop: () => {
            expect(held).toBe(true);
            events.push('owner:stop');
            return Promise.resolve();
          },
        },
        channelServer: new FakeChannelServer(),
        orca: new FakeOrca(),
        slack: new FakeSlack(),
        connectionFactory: () => ({
          start: () => Promise.resolve({ appId: 'A0APP' }),
          close: () => Promise.resolve(),
        }),
        waitForStop: () => Promise.resolve(),
      });

      expect(code).toBe(1);
      expect(events).toEqual([
        'lease:acquire', 'store:open', 'owner:start', 'owner:stop', 'store:close',
      ]);
      expect(releaseCalls).toBe(0);
      expect(held).toBe(true);
      expect(await snapshotLeaseStore.tryAcquireSnapshotLease(
        statePath,
        'a'.repeat(64),
      )).toBeNull();
      expect(diagnostics).toEqual([
        'daemon이 strict startup 또는 Gate reconciliation에 실패했다\n',
      ]);
      expect(diagnostics.join('')).not.toContain(privateDetail);
      expect(diagnostics.join('')).not.toContain(statePath);
    } finally {
      stderr.mockRestore();
      physicalClose.current?.();
    }
  });

  it('fails bounded lease contention before opening a writable store', async () => {
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    let opened = false;
    const code = await runDaemonCommand(parsed, CONFIG, {
      statusSnapshotLeaseStore: { tryAcquireSnapshotLease: async () => null },
      openStore: (path) => {
        opened = true;
        return new SqliteDigestStore(path);
      },
      statusOwnerServer: TEST_STATUS_OWNER_SERVER,
      waitForStop: () => Promise.resolve(),
    });
    expect(code).toBe(1);
    expect(opened).toBe(false);
  });

  it('owns the Channel server before Socket ingress and retains it through Socket shutdown', async () => {
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const events: string[] = [];
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(events),
      orca: new FakeOrca(),
      slack: new FakeSlack(),
      connectionFactory: () => ({
        start: () => { events.push('socket:start'); return Promise.resolve({ appId: 'A0APP' }); },
        close: () => { events.push('socket:stop'); return Promise.resolve(); },
      }),
      waitForStop: () => Promise.resolve(),
    });
    expect(code).toBe(0);
    expect(events).toEqual([
      'channel:start',
      'socket:start',
      'channel:quiesce',
      'socket:stop',
      'channel:stop',
    ]);
  });

  it('installs durable delivery callbacks and reconciles the live Channel runtime at startup', async () => {
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const channel = new FakeChannelServer();
    const deliveryEvents: string[] = [];
    let reconciles = 0;
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: channel,
      orca: new FakeOrca(),
      slack: new FakeSlack(),
      createChannelDelivery: (_store, _orca, transport) => {
        expect(transport).toBe(channel);
        return {
          reconcile: () => { reconciles += 1; return Promise.resolve(); },
          recordAttempted: (event) => deliveryEvents.push(`attempted:${event.gateId}`),
          recordReceipted: (event) => deliveryEvents.push(`receipted:${event.gateId}`),
        };
      },
      connectionFactory: () => ({
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => Promise.resolve(),
      }),
      waitForStop: async () => {
        await waitFor(() => reconciles === 1 && channel.productionHandlers !== null);
        channel.productionHandlers!.attempted({
          gateId: 'gate_aaaaaaaaaaaa', runId: RUN_ID,
          consumerGeneration: 1, connectionEpoch: 'epoch_test',
        }, () => true);
        channel.productionHandlers!.receipted({
          gateId: 'gate_aaaaaaaaaaaa', runId: RUN_ID,
          consumerGeneration: 1, connectionEpoch: 'epoch_test',
        }, () => true);
      },
    });

    expect(code).toBe(0);
    expect(reconciles).toBe(1);
    expect(deliveryEvents).toEqual([
      'attempted:gate_aaaaaaaaaaaa',
      'receipted:gate_aaaaaaaaaaaa',
    ]);
  });

  it('starts after a post-mutation crash, preserves D2 evidence, and lazy-seeds live D3 delivery', async () => {
    seedPostMutationCrash();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    orca.resolved = true;
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(),
      orca,
      slack: new FakeSlack(),
      connectionFactory: () => ({
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => Promise.resolve(),
      }),
      waitForStop: () => Promise.resolve(),
    });
    expect(code).toBe(0);

    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'resolved',
      preRead: { status: 'pending', resolution: null, resolvedAt: null },
      postRead: { status: 'resolved', resolution: '현행 유지', resolvedAt: AT },
    });
    expect(reopened.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'pending', attemptCount: 0,
    });
    expect(reopened.seedPendingGateChannelDeliveries(
      new Date().toISOString(),
      1_000,
      () => true,
    )).toEqual({ kind: 'committed', deliveries: [] });
    reopened.close();
  });

  it('fails closed before Socket ingress when Channel ownership cannot be acquired', async () => {
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const events: string[] = [];
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(events, true),
      orca: new FakeOrca(),
      slack: new FakeSlack(),
      connectionFactory: () => {
        events.push('socket:factory');
        throw new Error('must not create Socket transport');
      },
      waitForStop: () => Promise.resolve(),
    });
    expect(code).toBe(1);
    expect(events).toEqual(['channel:start', 'channel:quiesce', 'channel:stop']);
  });

  it('treats post-listen pipe ownership failure as fatal and drains Socket before release', async () => {
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const events: string[] = [];
    const channel = new FakeChannelServer(events);
    const running = runDaemonCommand(parsed, CONFIG, {
      channelServer: channel,
      orca: new FakeOrca(),
      slack: new FakeSlack(),
      connectionFactory: () => ({
        start: () => {
          events.push('socket:start');
          return Promise.resolve({ appId: 'A0APP' });
        },
        close: () => {
          events.push('socket:stop');
          return Promise.resolve();
        },
      }),
      waitForStop: () => new Promise<void>(() => undefined),
    });

    await waitFor(() => events.includes('socket:start'));
    channel.triggerRuntimeFailure();

    expect(await running).toBe(1);
    expect(events).toEqual([
      'channel:start',
      'socket:start',
      'channel:quiesce',
      'socket:stop',
      'channel:stop',
    ]);
  });

  it('direct button → modal errors → valid ACK → fake Orca → durable projection을 잇는다', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    const opener = new FakeViewOpener();
    let hooks: SocketConnectionHooks | null = null;
    let buttonAcks = 0;
    const invalidAcks: unknown[] = [];
    let validAcks = 0;
    const connectionFactory: SocketConnectionFactory = (received) => {
      hooks = received;
      return {
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => Promise.resolve(),
      };
    };

    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(),
      orca,
      slack,
      viewOpener: opener,
      connectionFactory,
      waitForStop: async () => {
        const consume = hooks?.event;
        if (consume === undefined) throw new Error('Socket event consumer was not wired');
        await consume({
          type: 'interactive',
          ack: () => { buttonAcks += 1; },
          body: {
            type: 'block_actions', api_app_id: 'A0APP', trigger_id: 'TRIGGER_PRIVATE',
            team: { id: 'T0TEAM' }, user: { id: 'U0OWNER', team_id: 'T0TEAM' },
            channel: { id: CHANNEL },
            container: {
              type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false,
            },
            message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
            actions: [{
              type: 'button', block_id: gateDirectBlockId(GATE),
              action_id: gateDirectActionId(GATE), value: gateDirectActionValue(GATE),
              action_ts: '1787554900.000011', text: { type: 'plain_text', text: '직접 입력' },
            }],
          },
        });
        expect(buttonAcks).toBe(1);
        expect(opener.calls).toHaveLength(1);
        const view = opener.calls[0]?.view;
        if (view === undefined) throw new Error('modal view missing');
        const input = view.blocks[0];
        expect(input).toMatchObject({
          type: 'input',
          block_id: gateDirectInputBlockId(GATE),
          element: {
            type: 'plain_text_input',
            action_id: gateDirectInputActionId(GATE),
          },
        });
        const submission = (value: string) => ({
          type: 'view_submission', api_app_id: 'A0APP',
          team: { id: 'T0TEAM' }, user: { id: 'U0OWNER', team_id: 'T0TEAM' },
          view: {
            id: 'V0DIRECT', type: 'modal', team_id: 'T0TEAM', app_id: 'A0APP',
            callback_id: view.callback_id, private_metadata: view.private_metadata,
            state: { values: {
              [gateDirectInputBlockId(GATE)]: {
                [gateDirectInputActionId(GATE)]: { type: 'plain_text_input', value },
              },
            } },
          },
        });
        await consume({
          type: 'interactive',
          ack: (body) => { invalidAcks.push(body); },
          body: submission('   \n\t'),
        });
        expect(invalidAcks).toEqual([{
          response_action: 'errors',
          errors: { [gateDirectInputBlockId(GATE)]: '1~3000자의 유효한 결정 내용을 입력하세요.' },
        }]);
        await consume({
          type: 'interactive',
          ack: () => { validAcks += 1; },
          body: submission('직접 입력으로 최종 결정'),
        });
      },
    });

    expect(code).toBe(0);
    expect(validAcks).toBe(1);
    expect(opener.calls[0]?.triggerId).toBe('TRIGGER_PRIVATE');
    expect(orca.calls.filter((call) => call[1] === 'gate-resolve')).toHaveLength(1);
    expect(orca.calls.find((call) => call[1] === 'gate-resolve')).toContain('직접 입력으로 최종 결정');
    expect(JSON.stringify(slack.updates.at(-1))).toContain('직접 입력');
    expect(JSON.stringify(slack.updates.at(-1))).not.toContain('작업 재개');
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      optionId: GATE_DIRECT_OPTION_ID,
      optionResolution: '직접 입력으로 최종 결정',
      lifecycle: 'resolved',
      ackState: 'acked',
    });
    expect(reopened.listPendingGateOutboxes()).toEqual([]);
    reopened.close();
  });

  it('Socket event → ACK → durable CAS → Orca resolve → existing card update를 실제 CLI path로 잇는다', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    let hooks: SocketConnectionHooks | null = null;
    let closed = 0;
    let acks = 0;
    const connectionFactory: SocketConnectionFactory = (received) => {
      hooks = received;
      return {
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => { closed += 1; return Promise.resolve(); },
      };
    };

    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(),
      orca,
      slack,
      connectionFactory,
      waitForStop: async () => {
        const event = hooks?.event;
        if (event === undefined) throw new Error('Socket event consumer was not wired');
        await event({
          type: 'interactive',
          ack: () => { acks += 1; },
          body: {
            type: 'block_actions', api_app_id: 'A0APP', team: { id: 'T0TEAM' }, user: { id: 'U0OWNER' },
            channel: { id: CHANNEL },
            container: { type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false },
            message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
            actions: [{
              type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
              value: 'keep', action_ts: '1787554900.000001', text: { type: 'plain_text', text: '현행 유지' },
            }],
          },
        });
      },
    });

    expect(code).toBe(0);
    expect(acks).toBe(1);
    expect(closed).toBe(1);
    expect(orca.calls.map((call) => call[1])).toEqual([
      'gate-list', 'gate-list', 'run-show', 'gate-resolve', 'gate-list',
    ]);
    expect(slack.updates).toHaveLength(2);
    expect(JSON.stringify(slack.updates[0])).toContain('resolving');
    expect(JSON.stringify(slack.updates.at(-1))).toContain('Coordinator 통지 대기');
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    expect(reopened.listPendingGateOutboxes()).toEqual([]);
    reopened.close();
  });

  it('shutdown stops intake and drains a contended post-ACK promotion before remote work', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const locker = new DatabaseSync(statePath);
    const probe = new DatabaseSync(statePath, { readOnly: true });
    const delegatedOrca = new FakeOrca();
    const remoteAckStates: Array<string | null> = [];
    const orca: OrcaRunner = {
      run: (args) => {
        const row = probe.prepare(
          'SELECT ack_state FROM gate_resolution WHERE gate_key = ?',
        ).get(GATE) as { readonly ack_state: string } | undefined;
        remoteAckStates.push(row?.ack_state ?? null);
        return delegatedOrca.run(args);
      },
    };
    const slack = new FakeSlack();
    let hooks: SocketConnectionHooks | null = null;
    let originalAcks = 0;
    let lateAcks = 0;
    let lateDeliveries = 0;
    let closeCount = 0;
    let ackStateAtClose: string | null = null;
    let lockHeld = false;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    let signalAck!: () => void;
    let signalReleased!: () => void;
    const ackObserved = new Promise<void>((resolve) => { signalAck = resolve; });
    const lockReleased = new Promise<void>((resolve) => { signalReleased = resolve; });
    const gateEvent = (ack: () => void) => ({
      type: 'interactive',
      ack,
      body: {
        type: 'block_actions', api_app_id: 'A0APP', team: { id: 'T0TEAM' },
        user: { id: 'U0OWNER' }, channel: { id: CHANNEL },
        container: {
          type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false,
        },
        message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
        actions: [{
          type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
          value: 'keep', action_ts: '1787554900.000001',
          text: { type: 'plain_text', text: '현행 유지' },
        }],
      },
    });
    const connectionFactory: SocketConnectionFactory = (received) => {
      hooks = received;
      return {
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => {
          closeCount += 1;
          if (closeCount === 1) {
            const row = probe.prepare(
              'SELECT ack_state FROM gate_resolution WHERE gate_key = ?',
            ).get(GATE) as { readonly ack_state: string } | undefined;
            ackStateAtClose = row?.ack_state ?? null;
            const late = received.event;
            if (late !== undefined) {
              lateDeliveries += 1;
              void late(gateEvent(() => { lateAcks += 1; }));
            }
            releaseTimer = setTimeout(() => {
              locker.exec('COMMIT');
              lockHeld = false;
              signalReleased();
            }, 25);
          }
          return Promise.resolve();
        },
      };
    };
    const began = performance.now();
    try {
      const code = await runDaemonCommand(parsed, CONFIG, {
        channelServer: new FakeChannelServer(),
        orca,
        slack,
        connectionFactory,
        waitForStop: async () => {
          const consume = hooks?.event;
          if (consume === undefined) throw new Error('Socket event consumer was not wired');
          void consume(gateEvent(() => {
            originalAcks += 1;
            locker.exec('BEGIN IMMEDIATE');
            lockHeld = true;
            signalAck();
          }));
          await ackObserved;
        },
      });
      await lockReleased;

      expect(code).toBe(0);
      expect(performance.now() - began).toBeLessThan(1_000);
      expect(closeCount).toBe(1);
      expect(ackStateAtClose).toBe('pending');
      expect(lateDeliveries).toBe(1);
      expect(originalAcks).toBe(1);
      expect(lateAcks).toBe(0);
      expect(remoteAckStates.length).toBeGreaterThan(0);
      expect(remoteAckStates.every((state) => state === 'acked')).toBe(true);
      expect(probe.prepare(
        'SELECT ack_state, lifecycle FROM gate_resolution WHERE gate_key = ?',
      ).get(GATE)).toEqual({ ack_state: 'acked', lifecycle: 'resolved' });
      expect(probe.prepare(
        `SELECT event, reason FROM gate_resolution_audit
          WHERE gate_key = ? ORDER BY id`,
      ).all(GATE)).toEqual([{ event: 'claimed', reason: 'first_valid_selection' }]);
      expect(slack.updates).toHaveLength(2);
    } finally {
      if (releaseTimer !== null) clearTimeout(releaseTimer);
      if (lockHeld) locker.exec('COMMIT');
      probe.close();
      locker.close();
    }
  });

  it('Socket close failure still drains an already-ACKed resolve before closing SQLite', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    orca.blockFirstList = true;
    const slack = new FakeSlack();
    let hooks: SocketConnectionHooks | null = null;
    let closed = 0;
    const connectionFactory: SocketConnectionFactory = (received) => {
      hooks = received;
      return {
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => {
          closed += 1;
          orca.releaseList();
          return new Promise<void>(() => undefined);
        },
      };
    };
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(),
      orca,
      slack,
      connectionFactory,
      socketTimeouts: { closeMs: 1 },
      waitForStop: async () => {
        const consume = hooks?.event;
        if (consume === undefined) throw new Error('Socket event consumer was not wired');
        await consume({
          type: 'interactive', ack: () => undefined,
          body: {
            type: 'block_actions', api_app_id: 'A0APP', team: { id: 'T0TEAM' }, user: { id: 'U0OWNER' },
            channel: { id: CHANNEL },
            container: { type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false },
            message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
            actions: [{
              type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
              value: 'keep', action_ts: '1787554900.000001', text: { type: 'plain_text', text: '현행 유지' },
            }],
          },
        });
      },
    });

    expect(code).toBe(1);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(orca.calls.map((call) => call[1])).toEqual([
      'gate-list', 'gate-list', 'run-show', 'gate-resolve', 'gate-list',
    ]);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    reopened.close();
  });

  it('periodic production reconciliation takes over when a live startup projector then dies', async () => {
    seed();
    const blocker = ownTerminalProjection();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    let blockerClosed = false;
    let closes = 0;
    try {
      const code = await runDaemonCommand(parsed, CONFIG, {
        channelServer: new FakeChannelServer(),
        orca,
        slack,
        reconcileIntervalMs: 10,
        connectionFactory: () => ({
          start: () => Promise.resolve({ appId: 'A0APP' }),
          close: () => { closes += 1; return Promise.resolve(); },
        }),
        waitForStop: async () => {
          // The one-shot startup pass respected the live owner and made no remote call.
          expect(slack.updates).toEqual([]);
          blocker.close();
          blockerClosed = true;
          await waitFor(() => slack.updates.length === 1);
        },
      });
      expect(code).toBe(0);
    } finally {
      if (!blockerClosed) blocker.close();
    }
    expect(closes).toBe(1);
    expect(orca.calls).toEqual([]);
    expect(JSON.stringify(slack.updates[0])).toContain('degraded');
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.listPendingGateOutboxes()).toEqual([]);
    reopened.close();
  });

  it('a never-settling startup Gate read is bounded before Socket acceptance', async () => {
    seed();
    claimPendingIntent();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new NeverSettlingOrca();
    let starts = 0;
    const began = Date.now();
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(),
      orca,
      slack: new FakeSlack(),
      orcaTimeoutMs: 10,
      connectionFactory: () => ({
        start: () => { starts += 1; return Promise.resolve({ appId: 'A0APP' }); },
        close: () => Promise.resolve(),
      }),
      waitForStop: () => Promise.resolve(),
    });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(code).toBe(0);
    expect(starts).toBe(1);
    expect(orca.calls.map((call) => call[1])).toEqual(['gate-list']);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', lastErrorCode: 'pre_read_failed', leaseOwner: null,
    });
    reopened.close();
  });

  it('never-settling startup Slack projections are bounded and leave a replayable card', async () => {
    seed();
    claimPendingIntent();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    const slack = new NeverSettlingSlack();
    let starts = 0;
    const began = Date.now();
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(),
      orca,
      slack,
      slackTimeoutMs: 10,
      connectionFactory: () => ({
        start: () => { starts += 1; return Promise.resolve({ appId: 'A0APP' }); },
        close: () => Promise.resolve(),
      }),
      waitForStop: () => Promise.resolve(),
    });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(code).toBe(0);
    expect(starts).toBe(1);
    expect(slack.updates).toHaveLength(3);
    expect(orca.calls.map((call) => call[1])).toEqual([
      'gate-list', 'gate-list', 'run-show', 'gate-resolve', 'gate-list', 'task-list',
    ]);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'resolved', leaseOwner: null,
    });
    expect(reopened.listPendingGateOutboxes()).toHaveLength(1);
    reopened.close();
  });

  it('shutdown drains a never-settling post-ACK Gate read through the same bound', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new NeverSettlingOrca();
    const slack = new FakeSlack();
    let hooks: SocketConnectionHooks | null = null;
    let acks = 0;
    const began = Date.now();
    const code = await runDaemonCommand(parsed, CONFIG, {
      channelServer: new FakeChannelServer(),
      orca,
      slack,
      orcaTimeoutMs: 10,
      connectionFactory: (received) => {
        hooks = received;
        return {
          start: () => Promise.resolve({ appId: 'A0APP' }),
          close: () => Promise.resolve(),
        };
      },
      waitForStop: async () => {
        const event = hooks?.event;
        if (event === undefined) throw new Error('Socket event consumer was not wired');
        await event({
          type: 'interactive',
          ack: () => { acks += 1; },
          body: {
            type: 'block_actions', api_app_id: 'A0APP', team: { id: 'T0TEAM' },
            user: { id: 'U0OWNER' }, channel: { id: CHANNEL },
            container: {
              type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false,
            },
            message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
            actions: [{
              type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
              value: 'keep', action_ts: '1787554900.000001',
              text: { type: 'plain_text', text: '현행 유지' },
            }],
          },
        });
      },
    });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(code).toBe(0);
    expect(acks).toBe(1);
    expect(orca.calls.map((call) => call[1])).toEqual(['gate-list']);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', lastErrorCode: 'pre_read_failed', leaseOwner: null,
    });
    reopened.close();
  });
});
