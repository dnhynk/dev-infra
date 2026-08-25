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

const RUN_ID = 'run_d3_acceptance';
const TERMINAL = 'term_d3-acceptance';
const PANE = 'd3-acceptance:pane-1';
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

class RejectingSlack implements SlackPoster {
  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('offline acceptance forbids Slack post'));
  }

  update(_input: UpdateMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('offline acceptance forbids Slack update'));
  }
}

class RecordingChannelServer implements ChannelDaemonServer {
  constructor(
    readonly inner: ChannelPipeServer,
    readonly events: string[],
  ) {}

  setProductionDeliveryHandlers(handlers: ChannelProductionDeliveryHandlers): void {
    this.inner.setProductionDeliveryHandlers(handlers);
  }

  async start(): Promise<void> {
    this.events.push('pipe:start:begin');
    await this.inner.start();
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
}): Promise<number> {
  const events = options.events;
  const running = runDaemonCommand(parsedDaemon(), CONFIG, {
    channelServer: options.channelServer,
    orca: options.orca,
    orcaTimeoutMs: 200,
    slack: new RejectingSlack(),
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

  it('restores the exact process signal listeners installed by the production daemon wait path', async () => {
    const beforeSigint = process.listeners('SIGINT');
    const beforeSigterm = process.listeners('SIGTERM');
    const path = pipePath('signals');
    const orca = new RunListOrca();
    const server = trackedServer(path, orca);
    let socketFactories = 0;
    const running = startDaemon({
      channelServer: server,
      orca,
      socketFactoryCalled: () => { socketFactories += 1; },
    });

    await waitFor(() =>
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
    const stop = addedSigterm[0] as () => void;
    signalStops.push(stop);
    stop();
    signalStops.splice(signalStops.indexOf(stop), 1);

    expect(await running).toBe(0);
    expect(socketFactories).toBe(0);
    expect(process.listeners('SIGINT')).toEqual(beforeSigint);
    expect(process.listeners('SIGTERM')).toEqual(beforeSigterm);
    zeroPipeResources(server);
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
