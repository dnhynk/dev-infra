import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseArgs,
  runDaemonCommand,
  type ChannelDaemonServer,
} from '../src/cli.js';
import {
  ChannelAdapterClient,
  type ChannelAdapterIdentity,
  type ChannelNotificationWriter,
} from '../src/channel/adapter.js';
import {
  ChannelPipeServer,
  type ChannelDeliverySendResult,
  type ChannelProductionDeliveryHandlers,
} from '../src/channel/pipe-server.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';
import type {
  PostMessageInput,
  PostedMessage,
  SlackPoster,
  UpdateMessageInput,
} from '../src/slack/post.js';
import { APP_TOKEN_VAR } from '../src/slack/verify.js';
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import type { GateSnapshot } from '../src/gate/resolution-types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const RUN_ID = 'run_d3_acceptance';
const TERMINAL = 'term_d3-acceptance';
const PANE = 'd3-acceptance:pane-1';
const STATEFUL_GATE_ID = 'gate_d3acceptance';
const STATEFUL_SOURCE_TASK_ID = 'task_d3source';
const STATEFUL_SOURCE_DISPATCH_ID = 'ctx_d3source';
const STATEFUL_FOLLOWUP_TASK_ID = 'task_d3followup';
const STATEFUL_FOLLOWUP_DISPATCH_ID = 'ctx_d3followup';
const STATEFUL_CHANNEL = 'C0AGENTRUNS';
const STATEFUL_THREAD_TS = '1787727600.000001';
const STATEFUL_MESSAGE_TS = '1787727600.000002';
const STATEFUL_AT = '2026-08-26T00:00:00.000Z';
const CONFIG: BridgeConfig = {
  slack: {
    teamId: 'T0TEAM',
    apiAppId: 'A0APP',
    ownerUserIds: ['U0OWNER'],
    channels: { prDigest: 'C0PRDIGEST', agentRuns: 'C0AGENTRUNS' },
  },
  projects: [],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

class RunListOrca implements OrcaRunner {
  generation = 1;
  missing = false;

  run(args: readonly string[]): Promise<string> {
    if (args.join(' ') !== 'orchestration run-list --json') {
      return Promise.reject(new Error('unexpected acceptance Orca command'));
    }
    const runs = this.missing ? [] : [{
      id: RUN_ID,
      objective: 'D3-4 hermetic acceptance fixture',
      coordinator_handle: TERMINAL,
      coordinator_pane_key: PANE,
      consumer_generation: this.generation,
      legacy: false,
      created_at: '2026-08-26T00:00:00.000Z',
      updated_at: '2026-08-26T00:00:00.000Z',
    }];
    return Promise.resolve(JSON.stringify({
      id: 'd3-acceptance',
      ok: true,
      result: { runs },
    }));
  }
}

type HeldTaskRead = {
  readonly started: Deferred;
  readonly release: Deferred;
};

class StatefulAcceptanceOrca implements OrcaRunner {
  generation = 1;
  followup: 'pending' | 'dispatched' = 'pending';
  readonly calls: string[] = [];
  #nextTaskRead: HeldTaskRead | null = null;
  #nextGateRead: HeldTaskRead | null = null;

  holdNextTaskRead(): HeldTaskRead {
    if (this.#nextTaskRead !== null) throw new Error('task read already held');
    const held = { started: deferred(), release: deferred() };
    this.#nextTaskRead = held;
    return held;
  }

  holdNextGateRead(): HeldTaskRead {
    if (this.#nextGateRead !== null) throw new Error('Gate read already held');
    const held = { started: deferred(), release: deferred() };
    this.#nextGateRead = held;
    return held;
  }

  run(args: readonly string[]): Promise<string> {
    const command = args[1] ?? '';
    this.calls.push(command);
    const ok = (result: unknown): string => JSON.stringify({
      id: 'd3-stateful-acceptance', ok: true, result,
    });
    if (args.join(' ') === 'orchestration run-list --json') {
      return Promise.resolve(ok({
        runs: [{
          id: RUN_ID,
          objective: 'D3-4 stateful lifecycle acceptance',
          coordinator_handle: TERMINAL,
          coordinator_pane_key: PANE,
          consumer_generation: this.generation,
          legacy: false,
          created_at: STATEFUL_AT,
          updated_at: STATEFUL_AT,
        }],
      }));
    }
    if (command === 'task-list') {
      const followup = this.followup;
      const tasks = [
        {
          id: STATEFUL_SOURCE_TASK_ID,
          run_id: RUN_ID,
          status: 'completed',
          deps: '[]',
        },
        {
          id: STATEFUL_FOLLOWUP_TASK_ID,
          run_id: RUN_ID,
          status: followup,
          deps: JSON.stringify([STATEFUL_SOURCE_TASK_ID]),
          ...(followup === 'dispatched'
            ? { dispatch_id: STATEFUL_FOLLOWUP_DISPATCH_ID }
            : {}),
        },
      ];
      const response = ok({ runId: RUN_ID, legacyReadOnly: false, count: tasks.length, tasks });
      const held = this.#nextTaskRead;
      if (held === null) return Promise.resolve(response);
      this.#nextTaskRead = null;
      held.started.resolve();
      // Deliberately ignores AbortSignal: the production owner must detach safely and release its
      // exact SQLite lease before this stale dependency is allowed to settle.
      return held.release.promise.then(() => response);
    }
    if (command === 'worker-list') {
      const workers = [
        {
          dispatchId: STATEFUL_SOURCE_DISPATCH_ID,
          taskId: STATEFUL_SOURCE_TASK_ID,
          runId: RUN_ID,
          dispatchStatus: 'completed',
        },
        ...(this.followup === 'dispatched'
          ? [{
              dispatchId: STATEFUL_FOLLOWUP_DISPATCH_ID,
              taskId: STATEFUL_FOLLOWUP_TASK_ID,
              runId: RUN_ID,
              dispatchStatus: 'dispatched',
            }]
          : []),
      ];
      return Promise.resolve(ok({ counts: { release_unknown: workers.length }, workers }));
    }
    if (command === 'dispatch-show') {
      const taskId = args[3];
      const followup = taskId === STATEFUL_FOLLOWUP_TASK_ID;
      return Promise.resolve(ok({
        dispatch: {
          id: followup ? STATEFUL_FOLLOWUP_DISPATCH_ID : STATEFUL_SOURCE_DISPATCH_ID,
          task_id: followup ? STATEFUL_FOLLOWUP_TASK_ID : STATEFUL_SOURCE_TASK_ID,
          run_id: RUN_ID,
          status: followup ? this.followup : 'completed',
        },
      }));
    }
    if (command === 'gate-list') {
      const response = ok({
        runId: RUN_ID,
        count: 1,
        gates: [{
          id: STATEFUL_GATE_ID,
          run_id: RUN_ID,
          task_id: STATEFUL_SOURCE_TASK_ID,
          question: 'D3-4 acceptance decision',
          options: JSON.stringify(STATEFUL_PENDING.options),
          status: 'resolved',
          resolution: STATEFUL_RESOLVED.resolution,
          created_at: STATEFUL_AT,
          resolved_at: STATEFUL_RESOLVED.resolvedAt,
        }],
      });
      const held = this.#nextGateRead;
      if (held === null) return Promise.resolve(response);
      this.#nextGateRead = null;
      held.started.resolve();
      return held.release.promise.then(() => response);
    }
    return Promise.reject(new Error(`unexpected stateful Orca command: ${args.join(' ')}`));
  }
}

class RejectingSlack implements SlackPoster {
  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('offline acceptance forbids Slack post'));
  }

  update(_input: UpdateMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('offline acceptance forbids Slack update'));
  }
}

class StatefulAcceptanceSlack implements SlackPoster {
  readonly posts: PostMessageInput[] = [];
  readonly updates: UpdateMessageInput[] = [];
  readonly initialUpdateStarted = deferred();
  readonly #initialUpdateRelease = deferred();

  post(input: PostMessageInput): Promise<PostedMessage> {
    this.posts.push(input);
    return Promise.reject(new Error('stateful acceptance must reuse the existing Slack identity'));
  }

  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    if (this.updates.length === 1) {
      this.initialUpdateStarted.resolve();
      await this.#initialUpdateRelease.promise;
    }
    return { channel: input.channel, ts: input.ts };
  }

  releaseInitialUpdate(): void {
    this.#initialUpdateRelease.resolve();
  }
}

class StatefulAcceptanceWriter implements ChannelNotificationWriter {
  readonly notifications: string[] = [];
  readonly productionSeen = deferred();

  constructor(readonly getAdapter: () => ChannelAdapterClient) {}

  notifyGate(gateId: string): Promise<void> {
    this.notifications.push(gateId);
    if (gateId === STATEFUL_GATE_ID) {
      this.productionSeen.resolve();
    } else {
      setImmediate(() => {
        void this.getAdapter().reportReceipt(gateId).catch(() => undefined);
      });
    }
    return Promise.resolve();
  }
}

class RecordingChannelServer implements ChannelDaemonServer {
  constructor(
    readonly inner: ChannelPipeServer,
    readonly events: string[],
    readonly startHold?: Promise<void>,
  ) {}

  setProductionDeliveryHandlers(handlers: ChannelProductionDeliveryHandlers): void {
    this.inner.setProductionDeliveryHandlers(handlers);
  }

  async start(): Promise<void> {
    this.events.push('pipe:start:begin');
    await this.inner.start();
    if (this.startHold !== undefined) {
      this.events.push('pipe:start:held');
      await this.startHold;
    }
    this.events.push('pipe:start:end');
  }

  async stop(): Promise<void> {
    this.events.push('pipe:stop:begin');
    await this.inner.stop();
    this.events.push('pipe:stop:end');
  }

  quiesce(): void {
    this.events.push('pipe:quiesce');
    this.inner.quiesce();
  }

  waitForFailure() {
    return this.inner.waitForFailure();
  }

  deliverGate(
    runId: string,
    gateId: string,
    signal?: AbortSignal,
  ): Promise<ChannelDeliverySendResult> {
    return this.inner.deliverGate(runId, gateId, signal);
  }
}

type Deferred = {
  readonly promise: Promise<void>;
  resolve(): void;
};

function deferred(): Deferred {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

const STATEFUL_GATE_KEY = gateKey(STATEFUL_GATE_ID);
const STATEFUL_RUN_KEY = runKey(RUN_ID);
const STATEFUL_TASK_KEY = taskKey(STATEFUL_SOURCE_TASK_ID);
const STATEFUL_PENDING: GateSnapshot = {
  gateId: STATEFUL_GATE_ID,
  runId: RUN_ID,
  taskId: STATEFUL_SOURCE_TASK_ID,
  options: ['유지', '변경'],
  status: 'pending',
  resolution: null,
  resolvedAt: null,
};
const STATEFUL_RESOLVED: GateSnapshot = {
  ...STATEFUL_PENDING,
  status: 'resolved',
  resolution: '유지',
  resolvedAt: '2026-08-26T00:00:01.000Z',
};

function seedStatefulResolvedGate(path: string): void {
  const store = new SqliteDigestStore(path);
  try {
    store.insertGateMetadata({
      gateKey: STATEFUL_GATE_KEY,
      runKey: STATEFUL_RUN_KEY,
      taskKey: STATEFUL_TASK_KEY,
      dispatchKey: dispatchKey(STATEFUL_SOURCE_DISPATCH_ID),
      askMessageId: 'msg_d3_stateful',
      questionThreadId: 'thread_d3_stateful',
      options: [
        { id: 'keep', label: '유지', description: '유지', resolution: '유지' },
        { id: 'change', label: '변경', description: '변경', resolution: '변경' },
      ],
      recommendation: { optionId: 'keep', reason: 'stateful acceptance' },
      impact: 'D3-4 lifecycle evidence',
      registeredAt: STATEFUL_AT,
    });
    store.insertGateMessage({
      gateKey: STATEFUL_GATE_KEY,
      runKey: STATEFUL_RUN_KEY,
      channelId: STATEFUL_CHANNEL,
      threadTs: STATEFUL_THREAD_TS,
      messageTs: STATEFUL_MESSAGE_TS,
      renderFingerprint: 'stateful-acceptance-seed',
      at: STATEFUL_AT,
    });
    store.saveGateLocalObservation({
      gateKey: STATEFUL_GATE_KEY,
      runKey: STATEFUL_RUN_KEY,
      taskKey: STATEFUL_TASK_KEY,
      status: 'pending',
      resolution: null,
      resolvedAt: null,
      metadataState: 'matched',
      mappingState: 'matched',
      observedAt: STATEFUL_AT,
    });
    const claim = store.claimGateResolution({
      teamId: 'T0TEAM',
      ownerUserId: 'U0OWNER',
      apiAppId: 'A0APP',
      channelId: STATEFUL_CHANNEL,
      threadTs: STATEFUL_THREAD_TS,
      messageTs: STATEFUL_MESSAGE_TS,
      blockId: gateBlockId(STATEFUL_GATE_KEY),
      actionId: gateActionId(STATEFUL_GATE_KEY, 'keep'),
      actionValue: 'keep',
      retryRequestId: '11111111-1111-4111-8111-111111111111',
      at: STATEFUL_AT,
    });
    if (claim.kind !== 'claimed') throw new Error(`stateful claim ${claim.kind}`);
    if (store.markGateResolutionAck(
      STATEFUL_GATE_KEY,
      claim.intent.revision,
      'acked',
      STATEFUL_AT,
    ) === null) throw new Error('stateful ack');
    const owner = 't.d3-stateful-seed';
    const lease = store.acquireGateResolutionLease(
      STATEFUL_GATE_KEY,
      owner,
      STATEFUL_AT,
      '2026-08-26T00:01:00.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error(`stateful lease ${lease.kind}`);
    const pre = store.updateGateResolution(
      STATEFUL_GATE_KEY,
      lease.intent.revision,
      owner,
      { lifecycle: 'pre_read', preRead: STATEFUL_PENDING, at: STATEFUL_AT },
    );
    const resolving = pre === null ? null : store.updateGateResolution(
      STATEFUL_GATE_KEY,
      pre.revision,
      owner,
      { lifecycle: 'resolving', at: STATEFUL_AT },
    );
    const post = resolving === null ? null : store.updateGateResolution(
      STATEFUL_GATE_KEY,
      resolving.revision,
      owner,
      {
        lifecycle: 'post_read',
        resolveResult: {
          gate: STATEFUL_RESOLVED,
          mutation: {
            requestId: '11111111-1111-4111-8111-111111111111',
            replayed: false,
          },
        },
        at: STATEFUL_AT,
      },
    );
    const resolved = post === null ? null : store.updateGateResolution(
      STATEFUL_GATE_KEY,
      post.revision,
      owner,
      { lifecycle: 'resolved', postRead: STATEFUL_RESOLVED, at: STATEFUL_AT },
    );
    if (resolved?.lifecycle !== 'resolved') throw new Error('stateful resolve');
    store.releaseGateResolutionLease(STATEFUL_GATE_KEY, owner);
  } finally {
    store.close();
  }
}

function inspectState<T>(read: (store: SqliteDigestStore) => T): T {
  const store = new SqliteDigestStore(statePath);
  try {
    return read(store);
  } finally {
    store.close();
  }
}

async function waitForState(
  check: (store: SqliteDigestStore) => boolean,
  timeoutMs = 4_000,
): Promise<void> {
  await waitFor(() => {
    try {
      return inspectState(check);
    } catch {
      return false;
    }
  }, timeoutMs);
}

function pipePath(label: string): string {
  const id = `${label}-${process.pid}-${randomUUID()}`;
  return process.platform === 'win32'
    ? String.raw`\\.\pipe\orca-d3-acceptance-${id}`
    : join(tmpdir(), `orca-d3-acceptance-${id}.sock`);
}

function identity(sessionId = randomUUID()): ChannelAdapterIdentity {
  return { sessionId, terminalHandle: TERMINAL, paneKey: PANE };
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('d3_acceptance_timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function zeroPipeResources(server: ChannelPipeServer): void {
  expect(server.getResourceSnapshot()).toMatchObject({
    listening: false,
    sockets: 0,
    timers: 0,
    bindingReads: 0,
    queuedReceiptAcks: 0,
    productionEventPermits: 0,
    productionEventsActive: 0,
    queuedProductionEvents: 0,
    readyProductionConnections: 0,
    pendingInboundMessages: 0,
  });
}

function zeroAdapterResources(adapter: ChannelAdapterClient): void {
  expect(adapter.getResourceSnapshot()).toEqual({
    socket: 0,
    reconnectTimer: 0,
    receiptTimers: 0,
    writeTimer: 0,
    queuedReceipts: 0,
    notificationWrites: 0,
    epoch: null,
  });
}

const servers: ChannelPipeServer[] = [];
const adapters: ChannelAdapterClient[] = [];
const daemonStops: Deferred[] = [];
const daemonRuns: Promise<number>[] = [];
const signalStops: Array<() => void> = [];
let fixtureDir = '';
let statePath = '';
let previousAppToken: string | undefined;

function trackedServer(path: string, orca: OrcaRunner): ChannelPipeServer {
  const value = new ChannelPipeServer({
    orca,
    pipePath: path,
    probeDelaysMs: [10, 20],
    helloTimeoutMs: 500,
    shutdownTimeoutMs: 500,
  });
  servers.push(value);
  return value;
}

function trackedAdapter(
  path: string,
  writer: ChannelNotificationWriter,
  adapterIdentity = identity(),
  errors: string[] = [],
): ChannelAdapterClient {
  const value = new ChannelAdapterClient({
    identity: adapterIdentity,
    notificationWriter: writer,
    pipePath: path,
    reconnectDelaysMs: [10, 20],
    receiptAckTimeoutMs: 500,
    writeTimeoutMs: 500,
    shutdownTimeoutMs: 500,
    onError: (code) => errors.push(code),
  });
  adapters.push(value);
  return value;
}

function autoReceiptWriter(getAdapter: () => ChannelAdapterClient): ChannelNotificationWriter {
  return {
    notifyGate: (gateId) => {
      setImmediate(() => {
        void getAdapter().reportReceipt(gateId).catch(() => undefined);
      });
      return Promise.resolve();
    },
  };
}

function parsedDaemon() {
  const parsed = parseArgs(['daemon', '--state', statePath]);
  if (parsed.kind !== 'run') throw new Error('daemon acceptance args failed');
  return parsed;
}

function startDaemon(options: {
  readonly channelServer: ChannelDaemonServer;
  readonly orca: OrcaRunner;
  readonly events?: string[];
  readonly stop?: Deferred;
  readonly socketFactoryCalled?: () => void;
  readonly slack?: SlackPoster;
}): Promise<number> {
  const events = options.events;
  const running = runDaemonCommand(parsedDaemon(), CONFIG, {
    channelServer: options.channelServer,
    statusOwnerServer: {
      start: () => Promise.resolve(),
      refresh: () => undefined,
      stop: () => Promise.resolve(),
    },
    orca: options.orca,
    orcaTimeoutMs: 200,
    slack: options.slack ?? new RejectingSlack(),
    reconcileIntervalMs: 20,
    connectionFactory: () => {
      options.socketFactoryCalled?.();
      return {
        start: () => {
          events?.push('socket:start');
          return Promise.resolve({ appId: 'A0APP' });
        },
        close: () => {
          events?.push('socket:stop');
          return Promise.resolve();
        },
      };
    },
    ...(options.stop === undefined
      ? {}
      : { waitForStop: () => options.stop!.promise }),
  });
  daemonRuns.push(running);
  return running;
}

beforeEach(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), 'orca-d3-lifecycle-acceptance-'));
  statePath = join(fixtureDir, 'state.db');
  previousAppToken = process.env[APP_TOKEN_VAR];
  process.env[APP_TOKEN_VAR] = 'xapp-FAKE-D3-ACCEPTANCE';
});

afterEach(async () => {
  for (const stop of signalStops.splice(0)) stop();
  for (const stop of daemonStops.splice(0)) stop.resolve();
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.stop()));
  await Promise.allSettled(daemonRuns.splice(0));
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
  if (previousAppToken === undefined) delete process.env[APP_TOKEN_VAR];
  else process.env[APP_TOKEN_VAR] = previousAppToken;
  rmSync(fixtureDir, { recursive: true, force: true });
});

describe('D3-4 offline lifecycle acceptance', () => {
  it('runs the actual daemon owner in strict order, fails a second daemon closed, and reconnects on a new epoch after restart', async () => {
    const path = pipePath('restart');
    const orca = new RunListOrca();
    const firstEvents: string[] = [];
    const firstInner = trackedServer(path, orca);
    const firstStop = deferred();
    daemonStops.push(firstStop);
    const firstRun = startDaemon({
      channelServer: new RecordingChannelServer(firstInner, firstEvents),
      orca,
      events: firstEvents,
      stop: firstStop,
    });
    await waitFor(() => firstInner.getResourceSnapshot().listening && firstEvents.includes('socket:start'));

    let adapter!: ChannelAdapterClient;
    adapter = trackedAdapter(path, autoReceiptWriter(() => adapter));
    adapter.start();
    await waitFor(() => firstInner.listConnections().some((connection) => connection.verified));
    const firstEpoch = adapter.getResourceSnapshot().epoch;
    expect(firstEpoch).toMatch(/^epoch_/);

    let contenderSocketFactories = 0;
    const contender = trackedServer(path, orca);
    const contenderCode = await startDaemon({
      channelServer: contender,
      orca,
      stop: { promise: Promise.resolve(), resolve: () => undefined },
      socketFactoryCalled: () => { contenderSocketFactories += 1; },
    });
    expect(contenderCode).toBe(1);
    expect(contenderSocketFactories).toBe(0);
    zeroPipeResources(contender);

    firstStop.resolve();
    expect(await firstRun).toBe(0);
    expect(firstEvents).toEqual([
      'pipe:start:begin',
      'pipe:start:end',
      'socket:start',
      'pipe:quiesce',
      'socket:stop',
      'pipe:stop:begin',
      'pipe:stop:end',
    ]);
    zeroPipeResources(firstInner);

    const secondEvents: string[] = [];
    const secondInner = trackedServer(path, orca);
    const secondStop = deferred();
    daemonStops.push(secondStop);
    const secondRun = startDaemon({
      channelServer: new RecordingChannelServer(secondInner, secondEvents),
      orca,
      events: secondEvents,
      stop: secondStop,
    });
    await waitFor(() =>
      secondInner.listConnections().some((connection) => connection.verified) &&
      adapter.getResourceSnapshot().epoch !== null &&
      adapter.getResourceSnapshot().epoch !== firstEpoch,
    );
    expect(adapter.getResourceSnapshot().epoch).toMatch(/^epoch_/);

    await adapter.stop();
    zeroAdapterResources(adapter);
    secondStop.resolve();
    expect(await secondRun).toBe(0);
    zeroPipeResources(secondInner);

    const rebound = trackedServer(path, orca);
    await rebound.start();
    expect(rebound.getResourceSnapshot().listening).toBe(true);
    await rebound.stop();
    zeroPipeResources(rebound);
  });

  it('drives the default durable delivery and resume chain across abort, restart, and generation takeover', async () => {
    const path = pipePath('stateful-default-chain');
    seedStatefulResolvedGate(statePath);
    const orca = new StatefulAcceptanceOrca();
    const slack = new StatefulAcceptanceSlack();
    let adapter!: ChannelAdapterClient;
    const writer = new StatefulAcceptanceWriter(() => adapter);
    adapter = trackedAdapter(
      path,
      writer,
      identity('11111111-1111-4111-8111-111111111111'),
    );
    // Adapter-first is intentional: it must reconnect to each real daemon owner and establish a
    // fresh epoch before any production Gate can leave durable pending state.
    adapter.start();

    const firstServer = trackedServer(path, orca);
    const firstStop = deferred();
    daemonStops.push(firstStop);
    const firstRun = startDaemon({
      channelServer: firstServer,
      orca,
      slack,
      stop: firstStop,
    });
    await waitFor(() =>
      slack.updates.length === 1 &&
      firstServer.listConnections().some((connection) => connection.verified),
    );
    const firstConnection = firstServer.listConnections().find((connection) => connection.verified)!;
    const firstEpoch = firstConnection.epoch;
    await expect(firstServer.evaluateProductionRoute(RUN_ID)).resolves.toEqual({
      kind: 'eligible',
      epoch: firstEpoch,
      generation: 1,
    });
    slack.releaseInitialUpdate();

    await writer.productionSeen.promise;
    await waitForState((store) =>
      store.findGateChannelDelivery(STATEFUL_GATE_KEY)?.state === 'attempted',
    );
    const attempted = inspectState((store) => ({
      delivery: store.findGateChannelDelivery(STATEFUL_GATE_KEY),
      resume: store.findGateResumeObservation(STATEFUL_GATE_KEY),
    }));
    expect(attempted.delivery).toMatchObject({
      state: 'attempted',
      attemptCount: 1,
      resumeBaselineState: 'recorded',
    });
    expect(attempted.resume).toMatchObject({ evidence: null });
    expect(writer.notifications.filter((gateId) => gateId === STATEFUL_GATE_ID)).toHaveLength(1);
    expect(slack.posts).toEqual([]);
    expect(slack.updates.every((input) => !input.text.includes('▶️ 작업 재개'))).toBe(true);

    const heldEffectRead = orca.holdNextGateRead();
    const staleTaskRead = orca.holdNextTaskRead();
    let staleTaskReadStarted = false;
    void staleTaskRead.started.promise.then(() => { staleTaskReadStarted = true; });
    await expect(adapter.reportReceipt(STATEFUL_GATE_ID)).resolves.toBe('accepted');
    await heldEffectRead.started.promise;
    expect(inspectState(
      (store) => store.findGateChannelDelivery(STATEFUL_GATE_KEY)?.state,
    )).toBe('receipted');
    expect(inspectState(
      (store) => store.findGateResumeObservation(STATEFUL_GATE_KEY)?.evidence,
    )).toBeNull();
    expect(slack.updates.every((input) => !input.text.includes('▶️ 작업 재개'))).toBe(true);

    heldEffectRead.release.resolve();
    await waitForState((store) =>
      store.findGateChannelDelivery(STATEFUL_GATE_KEY)?.state === 'consumed',
    );
    await waitFor(() => staleTaskReadStarted);
    await waitForState((store) =>
      store.findGateResumeObservation(STATEFUL_GATE_KEY)?.leaseOwner !== null,
    );
    const beforeAbort = inspectState((store) => ({
      delivery: store.findGateChannelDelivery(STATEFUL_GATE_KEY),
      resume: store.findGateResumeObservation(STATEFUL_GATE_KEY),
    }));
    expect(beforeAbort.delivery).toMatchObject({ state: 'consumed', attemptCount: 1 });
    expect(beforeAbort.resume).toMatchObject({
      evidence: null,
      leaseOwner: expect.stringMatching(/^p\d+\./),
    });

    firstStop.resolve();
    let firstSettled = false;
    void firstRun.then(() => { firstSettled = true; });
    await waitFor(() => firstSettled, 2_000);
    expect(await firstRun).toBe(0);
    zeroPipeResources(firstServer);
    expect(inspectState(
      (store) => store.findGateResumeObservation(STATEFUL_GATE_KEY),
    )).toMatchObject({ evidence: null, leaseOwner: null, leaseExpiresAt: null });

    orca.generation = 2;
    orca.followup = 'dispatched';
    const secondServer = trackedServer(path, orca);
    const secondStop = deferred();
    daemonStops.push(secondStop);
    const secondRun = startDaemon({
      channelServer: secondServer,
      orca,
      slack,
      stop: secondStop,
    });
    await waitFor(() => {
      const current = secondServer.listConnections().find((connection) => connection.verified);
      return current !== undefined && current.epoch !== firstEpoch &&
        adapter.getResourceSnapshot().epoch === current.epoch;
    });
    const secondConnection = secondServer.listConnections().find(
      (connection) => connection.verified,
    )!;
    await expect(secondServer.evaluateProductionRoute(RUN_ID)).resolves.toEqual({
      kind: 'eligible',
      epoch: secondConnection.epoch,
      generation: 2,
    });
    await waitForState((store) => {
      const evidence = store.findGateResumeObservation(STATEFUL_GATE_KEY)?.evidence;
      return evidence?.taskId === STATEFUL_FOLLOWUP_TASK_ID &&
        evidence.dispatchId === STATEFUL_FOLLOWUP_DISPATCH_ID;
    });
    await waitFor(() => slack.updates.some((input) => input.text.includes('▶️ 작업 재개')));

    const successor = inspectState((store) => ({
      delivery: store.findGateChannelDelivery(STATEFUL_GATE_KEY),
      resume: store.findGateResumeObservation(STATEFUL_GATE_KEY),
    }));
    expect(successor.delivery).toMatchObject({ state: 'consumed', attemptCount: 1 });
    expect(successor.resume).toMatchObject({
      evidence: {
        kind: 'new_dispatch',
        taskId: STATEFUL_FOLLOWUP_TASK_ID,
        dispatchId: STATEFUL_FOLLOWUP_DISPATCH_ID,
        toStatus: 'dispatched',
      },
      leaseOwner: null,
      nextObservationAt: null,
    });
    expect(writer.notifications.filter((gateId) => gateId === STATEFUL_GATE_ID)).toHaveLength(1);
    expect(slack.posts).toEqual([]);
    expect(slack.updates.every((input) =>
      input.channel === STATEFUL_CHANNEL && input.ts === STATEFUL_MESSAGE_TS,
    )).toBe(true);
    const finalUpdate = slack.updates.at(-1)!;
    expect(finalUpdate.text).toContain('▶️ 작업 재개');
    expect(finalUpdate.text).toContain(STATEFUL_FOLLOWUP_TASK_ID);
    expect(finalUpdate.text).toContain(STATEFUL_FOLLOWUP_DISPATCH_ID);

    // Settle daemon 1's stale non-cooperative read only after daemon 2 owns the durable witness.
    // Its aborted owner and old revision cannot rewrite the successor evidence or queue a post.
    const successorResume = JSON.stringify(successor.resume);
    staleTaskRead.release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(JSON.stringify(inspectState(
      (store) => store.findGateResumeObservation(STATEFUL_GATE_KEY),
    ))).toBe(successorResume);
    expect(writer.notifications.filter((gateId) => gateId === STATEFUL_GATE_ID)).toHaveLength(1);
    expect(slack.posts).toEqual([]);

    await adapter.stop();
    zeroAdapterResources(adapter);
    secondStop.resolve();
    expect(await secondRun).toBe(0);
    zeroPipeResources(secondServer);
  });

  it('never broadcasts across same-binding sessions and forces a fresh capture after Run generation takeover', async () => {
    const path = pipePath('multi-session');
    const orca = new RunListOrca();
    const server = trackedServer(path, orca);
    await server.start();

    let first!: ChannelAdapterClient;
    let second!: ChannelAdapterClient;
    const binding = identity('11111111-1111-4111-8111-111111111111');
    first = trackedAdapter(path, autoReceiptWriter(() => first), binding);
    second = trackedAdapter(path, autoReceiptWriter(() => second), binding);
    first.start();
    second.start();
    await waitFor(() => server.listConnections().filter((row) => row.verified).length === 2);
    await expect(server.evaluateProductionRoute(RUN_ID)).resolves.toEqual({
      kind: 'ambiguous',
      code: 'same_binding',
    });
    expect(server.getResourceSnapshot().productionGateWrites).toBe(0);

    await second.stop();
    await waitFor(() => server.listConnections().length === 1);
    const beforeTakeover = await server.evaluateProductionRoute(RUN_ID);
    expect(beforeTakeover).toMatchObject({ kind: 'eligible', generation: 1 });
    if (beforeTakeover.kind !== 'eligible') throw new Error('eligible route missing');

    orca.generation = 2;
    await expect(server.evaluateProductionRoute(RUN_ID)).resolves.toEqual({
      kind: 'pending',
      code: 'stale_generation',
    });
    await waitFor(() => {
      const current = server.listConnections();
      return current.length === 1 && current[0]?.verified === true &&
        current[0].epoch !== beforeTakeover.epoch;
    });
    const afterTakeover = await server.evaluateProductionRoute(RUN_ID);
    expect(afterTakeover).toMatchObject({ kind: 'eligible', generation: 2 });

    const current = server.listConnections()[0];
    if (current === undefined) throw new Error('current Adapter missing');
    // Server verification proves the automatic receipt was sent, but its ACK can still be queued
    // on the Adapter. Joining that exact pending promise may therefore observe its one `accepted`;
    // every subsequent report in the same epoch must be the deterministic duplicate.
    await expect(first.reportReceipt(current.probeGateId)).resolves.toMatch(/^(?:accepted|duplicate)$/u);
    await expect(first.reportReceipt(current.probeGateId)).resolves.toBe('duplicate');
    expect(server.getResourceSnapshot().productionGateWrites).toBe(0);

    await first.stop();
    await server.stop();
    zeroAdapterResources(first);
    zeroAdapterResources(second);
    zeroPipeResources(server);
  });

  it('simulates no development flag and policy denial without treating transport writes as opt-in', async () => {
    const path = pipePath('policy');
    const orca = new RunListOrca();
    const server = trackedServer(path, orca);
    await server.start();

    let notifications = 0;
    const noFlag = trackedAdapter(path, {
      notifyGate: () => {
        notifications += 1;
        return Promise.resolve();
      },
    });
    noFlag.start();
    await waitFor(() => notifications >= 2);
    expect(server.listConnections()[0]).toMatchObject({
      verified: false,
      attemptedWrites: expect.any(Number),
    });
    await expect(server.evaluateProductionRoute(RUN_ID)).resolves.toEqual({
      kind: 'pending',
      code: 'unverified',
    });
    await noFlag.stop();
    await waitFor(() => server.listConnections().length === 0);

    const policyErrors: string[] = [];
    const denied = trackedAdapter(path, {
      notifyGate: () => Promise.reject(new Error('simulated policy denial')),
    }, identity(), policyErrors);
    denied.start();
    await waitFor(() => policyErrors.includes('mcp_write_failed'));
    expect(server.listConnections()[0]?.verified).toBe(false);
    await expect(server.evaluateProductionRoute(RUN_ID)).resolves.toEqual({
      kind: 'pending',
      code: 'unverified',
    });
    expect(server.getResourceSnapshot().productionGateWrites).toBe(0);

    await denied.stop();
    await server.stop();
    zeroAdapterResources(noFlag);
    zeroAdapterResources(denied);
    zeroPipeResources(server);
  });

  it('stops a held real-pipe start through each production signal and restores exact ownership', async () => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const beforeSigint = process.listeners('SIGINT');
      const beforeSigterm = process.listeners('SIGTERM');
      const path = pipePath(`signals-${signal.toLowerCase()}`);
      const orca = new RunListOrca();
      const server = trackedServer(path, orca);
      const events: string[] = [];
      const heldStart = new Promise<void>(() => undefined);
      let socketFactories = 0;
      const running = startDaemon({
        channelServer: new RecordingChannelServer(server, events, heldStart),
        orca,
        socketFactoryCalled: () => { socketFactories += 1; },
      });

      await waitFor(() =>
        events.includes('pipe:start:held') &&
        process.listeners('SIGINT').length === beforeSigint.length + 1 &&
        process.listeners('SIGTERM').length === beforeSigterm.length + 1,
      );
      const addedSigint = process.listeners('SIGINT').filter(
        (listener) => !beforeSigint.includes(listener),
      );
      const addedSigterm = process.listeners('SIGTERM').filter(
        (listener) => !beforeSigterm.includes(listener),
      );
      expect(addedSigint).toHaveLength(1);
      expect(addedSigterm).toEqual(addedSigint);
      const stop = (signal === 'SIGINT' ? addedSigint[0] : addedSigterm[0]) as () => void;
      signalStops.push(stop);
      stop();

      let outcome: { readonly kind: 'code'; readonly code: number } |
        { readonly kind: 'error'; readonly error: unknown } | null = null;
      void running.then(
        (code) => { outcome = { kind: 'code', code }; },
        (error: unknown) => { outcome = { kind: 'error', error }; },
      );
      await waitFor(() => outcome !== null, 2_000);
      expect(outcome).toEqual({ kind: 'code', code: 0 });
      signalStops.splice(signalStops.indexOf(stop), 1);

      expect(socketFactories).toBe(0);
      expect(events).toEqual([
        'pipe:start:begin',
        'pipe:start:held',
        'pipe:quiesce',
        'pipe:stop:begin',
        'pipe:stop:end',
      ]);
      expect(process.listeners('SIGINT')).toEqual(beforeSigint);
      expect(process.listeners('SIGTERM')).toEqual(beforeSigterm);
      zeroPipeResources(server);

      const rebound = trackedServer(path, orca);
      await rebound.start();
      expect(rebound.getResourceSnapshot().listening).toBe(true);
      await rebound.stop();
      zeroPipeResources(rebound);
    }
  });

  it('keeps the executable harness and MCP template secret-free and explicitly live-unverified', () => {
    const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const repositoryRoot = resolve(appRoot, '..', '..');
    const mcp = JSON.parse(readFileSync(join(appRoot, 'mcp.example.json'), 'utf8')) as {
      readonly mcpServers: Record<string, { readonly command: string; readonly args: string[] }>;
    };
    expect(mcp).toEqual({
      mcpServers: {
        'orca-slack': {
          command: 'node',
          args: [
            '<ABSOLUTE_REPOSITORY_PATH>/apps/orca-slack-bridge/dist/cli.js',
            'channel-adapter',
          ],
        },
      },
    });
    const serialized = JSON.stringify(mcp);
    expect(serialized).not.toMatch(/xox[bp]-|token|secret|--config|--state/i);

    const harness = readFileSync(
      join(repositoryRoot, 'tools', 'd3-4-lifecycle-acceptance.mjs'),
      'utf8',
    );
    expect(harness).toContain('LIVE_CHANNEL_UNVERIFIED');
    expect(harness).not.toMatch(/spawnSync\([^\n]*claude|\.mcp\.json[^\n]*(write|copy)/i);
  });
});
