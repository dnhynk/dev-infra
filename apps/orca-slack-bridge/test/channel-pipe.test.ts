import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelAdapterClient,
  type ChannelAdapterIdentity,
  type ChannelNotificationWriter,
} from '../src/channel/adapter.js';
import { ChannelPipeServer } from '../src/channel/pipe-server.js';
import {
  CHANNEL_PROTOCOL_VERSION,
  ChannelNdjsonDecoder,
  decodeDaemonMessage,
  encodeChannelFrame,
  type DaemonToAdapterMessage,
} from '../src/channel/protocol.js';
import {
  boundedOrcaRunner,
  type OrcaRunner,
  type OrcaRunOptions,
} from '../src/orca/client.js';

const RUN_ID = 'run_channel';
const TERMINAL = 'term_22222222-2222-4222-8222-222222222222';
const PANE = '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444';

class FakeOrca implements OrcaRunner {
  generation = 1;
  duplicateRun = false;
  missingRun = false;
  fail = false;
  delayMs = 0;
  calls = 0;

  run(args: readonly string[], options: OrcaRunOptions = {}): Promise<string> {
    this.calls += 1;
    if (this.fail) return Promise.reject(new Error('raw private Orca failure'));
    if (args.join(' ') !== 'orchestration run-list --json') {
      return Promise.reject(new Error('unexpected fake command'));
    }
    const row = {
      id: RUN_ID,
      objective: 'channel test',
      coordinator_handle: TERMINAL,
      coordinator_pane_key: PANE,
      consumer_generation: this.generation,
      legacy: false,
      created_at: '2026-08-25T00:00:00.000Z',
      updated_at: '2026-08-25T00:00:00.000Z',
    };
    const response = JSON.stringify({
      id: 'fake',
      ok: true,
      result: {
        runs: this.missingRun ? [] : this.duplicateRun ? [row, { ...row }] : [row],
      },
    });
    if (this.delayMs === 0) return Promise.resolve(response);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort);
        resolve(response);
      }, this.delayMs);
      const abort = (): void => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('fake aborted'));
      };
      if (options.signal?.aborted === true) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

class AbortAwareNeverSettlingOrca implements OrcaRunner {
  calls = 0;
  active = 0;
  maxActive = 0;

  run(args: readonly string[], options: OrcaRunOptions = {}): Promise<string> {
    if (args.join(' ') !== 'orchestration run-list --json') {
      return Promise.reject(new Error('unexpected fake Orca command'));
    }
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise<string>((_resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true;
        this.active -= 1;
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('fake aborted'));
      };
      if (options.signal?.aborted === true) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

function pipePath(label: string): string {
  const id = `${label}-${process.pid}-${randomUUID()}`;
  return process.platform === 'win32'
    ? String.raw`\\.\pipe\orca-d3-${id}`
    : join(tmpdir(), `orca-d3-${id}.sock`);
}

function identity(session = '11111111-1111-4111-8111-111111111111'): ChannelAdapterIdentity {
  return { sessionId: session, terminalHandle: TERMINAL, paneKey: PANE };
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('channel_test_timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function rawAdapter(path: string): Promise<{
  readonly socket: Socket;
  readonly messages: DaemonToAdapterMessage[];
}> {
  const socket = createConnection(path);
  const messages: DaemonToAdapterMessage[] = [];
  const decoder = new ChannelNdjsonDecoder(decodeDaemonMessage);
  socket.on('data', (chunk) => {
    messages.push(...decoder.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(encodeChannelFrame({
    version: CHANNEL_PROTOCOL_VERSION,
    type: 'hello',
    session_id: randomUUID(),
    terminal_handle: TERMINAL,
    pane_key: PANE,
    instance_id: `adapter_${randomUUID()}`,
    connection_id: `connection_${randomUUID()}`,
  }));
  await waitFor(() => messages.some((message) => message.type === 'notify'));
  return { socket, messages };
}

const servers: ChannelPipeServer[] = [];
const adapters: ChannelAdapterClient[] = [];

function server(path: string, orca = new FakeOrca(), errors: string[] = []): ChannelPipeServer {
  const value = new ChannelPipeServer({
    orca,
    pipePath: path,
    probeDelaysMs: [15, 30],
    helloTimeoutMs: 500,
    shutdownTimeoutMs: 500,
    onError: (code) => errors.push(code),
  });
  servers.push(value);
  return value;
}

function adapter(
  path: string,
  writer: ChannelNotificationWriter,
  adapterIdentity = identity(),
  errors: string[] = [],
): ChannelAdapterClient {
  const value = new ChannelAdapterClient({
    identity: adapterIdentity,
    notificationWriter: writer,
    pipePath: path,
    reconnectDelaysMs: [10, 20, 40],
    receiptAckTimeoutMs: 500,
    shutdownTimeoutMs: 500,
    onError: (code) => errors.push(code),
  });
  adapters.push(value);
  return value;
}

afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((value) => value.stop()));
  await Promise.allSettled(servers.splice(0).map((value) => value.stop()));
});

describe('daemon named pipe + reconnecting Adapter vertical seam', () => {
  it('works daemon-first and verifies only the exact receipt callback', async () => {
    const path = pipePath('daemon-first');
    const daemon = server(path);
    await daemon.start();
    const gates: string[] = [];
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => {
        gates.push(gateId);
        await client.reportReceipt(gateId);
      },
    });
    client.start();

    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    const connection = daemon.listConnections()[0]!;
    expect(gates.length).toBeGreaterThanOrEqual(1);
    expect(new Set(gates)).toEqual(new Set([connection.probeGateId]));
    expect(connection.attemptedWrites).toBeGreaterThanOrEqual(0);
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toMatchObject({
      kind: 'eligible',
      epoch: connection.epoch,
      generation: 1,
    });
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('delivers production Gates only through a verified exact route and durably observes each callback', async () => {
    const path = pipePath('production-delivery');
    const daemon = server(path);
    const attempted: string[] = [];
    const receipted: string[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: ({ gateId }) => attempted.push(gateId),
      receipted: ({ gateId }) => receipted.push(gateId),
    });
    await daemon.start();

    const writes: string[] = [];
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => {
        writes.push(gateId);
        const probeGateId = daemon.listConnections()[0]?.probeGateId;
        if (gateId === probeGateId) await client.reportReceipt(gateId);
      },
    });
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    const firstGateId = 'gate_aaaaaaaaaaaa';
    const secondGateId = 'gate_bbbbbbbbbbbb';
    expect(await daemon.deliverGate(RUN_ID, firstGateId)).toMatchObject({ kind: 'sent' });
    expect(await daemon.deliverGate(RUN_ID, secondGateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => attempted.length === 2);
    expect(writes.slice(-2)).toEqual([firstGateId, secondGateId]);
    expect(attempted).toEqual([firstGateId, secondGateId]);
    expect(receipted).toEqual([]);

    expect(await client.reportReceipt(secondGateId)).toBe('accepted');
    expect(await client.reportReceipt(firstGateId)).toBe('accepted');
    await waitFor(() => receipted.length === 2);
    expect(receipted).toEqual([secondGateId, firstGateId]);
    expect(await client.reportReceipt(firstGateId)).toBe('duplicate');
    await expect(client.reportReceipt('gate_cccccccccccc')).rejects.toThrowError(
      'receipt_not_current',
    );
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(2);
  });

  it('validates a three-Gate slow-route burst concurrently while committing callbacks in wire order', async () => {
    const path = pipePath('production-slow-route-burst');
    const orca = new FakeOrca();
    const daemonErrors: string[] = [];
    const adapterErrors: string[] = [];
    const daemon = server(path, orca, daemonErrors);
    const callbacks: string[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: ({ gateId }) => callbacks.push(`attempted:${gateId}`),
      receipted: ({ gateId }) => callbacks.push(`receipted:${gateId}`),
    });
    await daemon.start();

    const gates = [
      'gate_111111111111',
      'gate_222222222222',
      'gate_333333333333',
    ];
    const productionWrites: string[] = [];
    let releaseFirstProductionWrite!: () => void;
    const heldFirstProductionWrite = new Promise<void>((resolve) => {
      releaseFirstProductionWrite = resolve;
    });
    let client!: ChannelAdapterClient;
    client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: {
        notifyGate: async (gateId) => {
          if (gateId === daemon.listConnections()[0]?.probeGateId) {
            await client.reportReceipt(gateId);
            return;
          }
          productionWrites.push(gateId);
          if (productionWrites.length === 1) await heldFirstProductionWrite;
        },
      },
      pipePath: path,
      reconnectDelaysMs: [10, 20, 40],
      shutdownTimeoutMs: 500,
      onError: (code) => adapterErrors.push(code),
      // Intentionally omit receiptAckTimeoutMs: this exercises the production 5 second default.
    });
    adapters.push(client);
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    const attemptedBefore = daemon.listConnections()[0]!.attemptedWrites;

    for (const gateId of gates) {
      expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    }
    const callbackReadStart = orca.calls;
    orca.delayMs = 1_700;
    releaseFirstProductionWrite();
    await waitFor(() => productionWrites.length === gates.length);
    await waitFor(() => (
      (daemon.listConnections()[0]?.attemptedWrites ?? 0) >= attemptedBefore + gates.length
    ));

    const receiptBeganAt = Date.now();
    await expect(Promise.all(gates.map((gateId) => client.reportReceipt(gateId)))).resolves.toEqual([
      'accepted',
      'accepted',
      'accepted',
    ]);
    expect(Date.now() - receiptBeganAt).toBeLessThan(4_500);
    await waitFor(() => callbacks.length === gates.length * 2);
    expect(callbacks).toEqual([
      ...gates.map((gateId) => `attempted:${gateId}`),
      ...gates.map((gateId) => `receipted:${gateId}`),
    ]);
    expect(orca.calls - callbackReadStart).toBe(gates.length * 2);
    expect(daemonErrors).not.toContain('delivery_event_expired');
    expect(daemonErrors).not.toContain('stale_delivery');
    expect(adapterErrors).not.toContain('wrong_receipt_ack');
    expect(daemon.listConnections()[0]?.verified).toBe(true);
  });

  it('pauses multi-Gate MCP notifications behind an attempted-frame drain without losing callbacks', async () => {
    const path = pipePath('production-attempted-drain');
    const daemon = server(path);
    const attempted: string[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: ({ gateId }) => attempted.push(gateId),
      receipted: () => undefined,
    });
    await daemon.start();

    const gates = [
      'gate_444444444444',
      'gate_555555555555',
      'gate_666666666666',
    ];
    const writes: string[] = [];
    const adapterErrors: string[] = [];
    let blockedSocket: Socket | null = null;
    let client!: ChannelAdapterClient;
    client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: {
        notifyGate: async (gateId) => {
          if (!gates.includes(gateId)) {
            await client.reportReceipt(gateId);
            return;
          }
          writes.push(gateId);
        },
      },
      pipePath: path,
      reconnectDelaysMs: [10],
      receiptAckTimeoutMs: 1_000,
      writeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      onError: (code) => adapterErrors.push(code),
      writeFrame: (socket, frame) => {
        socket.write(frame);
        if (
          blockedSocket === null &&
          frame.includes(Buffer.from('"type":"attempted"')) &&
          frame.includes(Buffer.from(`"gate_id":"${gates[0]}"`))
        ) {
          blockedSocket = socket;
          return false;
        }
        return true;
      },
    });
    adapters.push(client);
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    for (const gateId of gates) {
      expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    }
    await waitFor(() => attempted.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(writes).toEqual([gates[0]]);
    expect(attempted).toEqual([gates[0]]);
    expect(client.getResourceSnapshot().writeTimer).toBe(1);

    (blockedSocket as Socket | null)?.emit('drain');
    await waitFor(() => attempted.length === gates.length);
    expect(writes).toEqual(gates);
    expect(attempted).toEqual(gates);
    expect(adapterErrors).not.toContain('write_timeout');
  });

  it('carries queued receipt budget through Adapter and daemon drains before durable ACKs', async () => {
    const path = pipePath('production-receipt-drains');
    const orca = new FakeOrca();
    const daemonErrors: string[] = [];
    const adapterErrors: string[] = [];
    const gates = ['gate_777777777777', 'gate_888888888888'];
    let daemonBlockedSocket: Socket | null = null;
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      writeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      onError: (code) => daemonErrors.push(code),
      writeFrame: (socket, frame) => {
        socket.write(frame);
        if (
          daemonBlockedSocket === null &&
          frame.includes(Buffer.from('"type":"receipt_ack"')) &&
          frame.includes(Buffer.from(`"gate_id":"${gates[0]}"`))
        ) {
          daemonBlockedSocket = socket;
          return false;
        }
        return true;
      },
    });
    servers.push(daemon);
    const attempted: string[] = [];
    const receipted: string[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: ({ gateId }) => attempted.push(gateId),
      receipted: ({ gateId }) => receipted.push(gateId),
    });
    await daemon.start();

    let adapterBlockedSocket: Socket | null = null;
    const receiptBudgets = new Map<string, number>();
    let client!: ChannelAdapterClient;
    client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: {
        notifyGate: async (gateId) => {
          if (!gates.includes(gateId)) await client.reportReceipt(gateId);
        },
      },
      pipePath: path,
      reconnectDelaysMs: [10],
      receiptAckTimeoutMs: 1_000,
      writeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      onError: (code) => adapterErrors.push(code),
      writeFrame: (socket, frame) => {
        const message = JSON.parse(frame.toString('utf8')) as {
          readonly type?: unknown;
          readonly gate_id?: unknown;
          readonly ack_budget_ms?: unknown;
        };
        socket.write(frame);
        if (
          message.type === 'receipt' &&
          typeof message.gate_id === 'string' &&
          typeof message.ack_budget_ms === 'number' &&
          gates.includes(message.gate_id)
        ) {
          receiptBudgets.set(message.gate_id, message.ack_budget_ms);
          if (message.gate_id === gates[0] && adapterBlockedSocket === null) {
            adapterBlockedSocket = socket;
            return false;
          }
        }
        return true;
      },
    });
    adapters.push(client);
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    for (const gateId of gates) {
      expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    }
    await waitFor(() => attempted.length === gates.length);
    const receiptRouteReadStart = orca.calls;

    const firstReceipt = client.reportReceipt(gates[0]!);
    const secondReceipt = client.reportReceipt(gates[1]!);
    await waitFor(() => client.getResourceSnapshot().queuedReceipts === 1);
    await expect(firstReceipt).resolves.toBe('accepted');
    expect(receipted).toEqual([gates[0]]);
    expect(daemonBlockedSocket).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 100));
    (adapterBlockedSocket as Socket | null)?.emit('drain');
    await waitFor(() => receiptBudgets.has(gates[1]!));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(receipted).toEqual([gates[0]]);

    (daemonBlockedSocket as Socket | null)?.emit('drain');
    await expect(secondReceipt).resolves.toBe('accepted');
    expect(receipted).toEqual(gates);
    expect(receiptBudgets.get(gates[1]!)).toBeLessThan(receiptBudgets.get(gates[0]!)!);
    expect(orca.calls - receiptRouteReadStart).toBe(3);
    expect(daemonErrors).not.toContain('delivery_event_expired');
    expect(adapterErrors).not.toContain('wrong_receipt_ack');
  });

  it('expires a saturated receipt queue on monotonic time despite wall-clock rollback', async () => {
    const path = pipePath('production-monotonic-expiry');
    const orca = new FakeOrca();
    const daemonErrors: string[] = [];
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      maxConcurrentProductionEvents: 1,
      productionEventDeadlineMs: 120,
      eventValidationTimeoutMs: 200,
      onError: (code) => daemonErrors.push(code),
    });
    servers.push(daemon);
    const gates = ['gate_999999999999', 'gate_aaaaaaaaaaaa'];
    const attempted: string[] = [];
    const receipted: string[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: ({ gateId }) => attempted.push(gateId),
      receipted: ({ gateId }) => receipted.push(gateId),
    });
    await daemon.start();

    const adapterErrors: string[] = [];
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => {
        if (!gates.includes(gateId)) await client.reportReceipt(gateId);
      },
    }, identity(), adapterErrors);
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    for (const gateId of gates) {
      expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    }
    await waitFor(() => attempted.length === gates.length);
    orca.delayMs = 80;

    const originalWall = Date.now();
    let rollbackWall = originalWall;
    const wallSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      rollbackWall -= 60_000;
      return rollbackWall;
    });
    let results: PromiseSettledResult<'accepted' | 'duplicate'>[];
    try {
      results = await Promise.allSettled(gates.map((gateId) => client.reportReceipt(gateId)));
    } finally {
      wallSpy.mockRestore();
    }

    expect(results[0]).toEqual({ status: 'fulfilled', value: 'accepted' });
    expect(results[1]).toMatchObject({ status: 'rejected' });
    expect(receipted).toEqual([gates[0]]);
    expect(adapterErrors).not.toContain('wrong_receipt_ack');
    expect(daemonErrors).toContain('run_read_failed');
  });

  it('replays an unreceipted production Gate through a newly verified reconnect epoch', async () => {
    const path = pipePath('production-replay');
    const attemptedEpochs: string[] = [];
    const productionGateId = 'gate_dddddddddddd';
    let daemon = server(path);
    daemon.setProductionDeliveryHandlers({
      attempted: ({ connectionEpoch }) => attemptedEpochs.push(connectionEpoch),
      receipted: () => undefined,
    });
    await daemon.start();

    const writes: string[] = [];
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => {
        writes.push(gateId);
        if (gateId === daemon.listConnections()[0]?.probeGateId) {
          await client.reportReceipt(gateId);
        }
      },
    });
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    const firstEpoch = daemon.listConnections()[0]!.epoch;
    expect(await daemon.deliverGate(RUN_ID, productionGateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => writes.filter((gateId) => gateId === productionGateId).length === 1);
    await waitFor(() => attemptedEpochs.includes(firstEpoch));

    await daemon.stop();
    daemon = server(path);
    daemon.setProductionDeliveryHandlers({
      attempted: ({ connectionEpoch }) => attemptedEpochs.push(connectionEpoch),
      receipted: () => undefined,
    });
    await daemon.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    const secondEpoch = daemon.listConnections()[0]!.epoch;
    expect(secondEpoch).not.toBe(firstEpoch);
    expect(await daemon.deliverGate(RUN_ID, productionGateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => writes.filter((gateId) => gateId === productionGateId).length === 2);
    await waitFor(() => attemptedEpochs.includes(secondEpoch));
    expect(await client.reportReceipt(productionGateId)).toBe('accepted');
  });

  it('rejects an old-epoch receipt after Run takeover and replays to the new generation', async () => {
    const path = pipePath('production-takeover-fence');
    const orca = new FakeOrca();
    const errors: string[] = [];
    const daemon = server(path, orca, errors);
    const attempted: { gateId: string; generation: number; epoch: string }[] = [];
    const receipted: { gateId: string; generation: number; epoch: string }[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: (event) => attempted.push({
        gateId: event.gateId,
        generation: event.consumerGeneration,
        epoch: event.connectionEpoch,
      }),
      receipted: (event) => receipted.push({
        gateId: event.gateId,
        generation: event.consumerGeneration,
        epoch: event.connectionEpoch,
      }),
    });
    await daemon.start();

    const productionGateId = 'gate_ffffffffffff';
    let productionWrites = 0;
    let releaseOldWrite!: () => void;
    const heldOldWrite = new Promise<void>((resolve) => { releaseOldWrite = resolve; });
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => {
        if (gateId === daemon.listConnections()[0]?.probeGateId) {
          await client.reportReceipt(gateId);
          return;
        }
        if (gateId === productionGateId) {
          productionWrites += 1;
          if (productionWrites === 1) await heldOldWrite;
        }
      },
    });
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    const oldEpoch = daemon.listConnections()[0]!.epoch;
    expect(await daemon.deliverGate(RUN_ID, productionGateId)).toMatchObject({
      kind: 'sent', generation: 1, epoch: oldEpoch,
    });
    await waitFor(() => productionWrites === 1);

    orca.generation = 2;
    await expect(client.reportReceipt(productionGateId)).rejects.toThrowError(
      /receipt_disconnected|receipt_timeout/,
    );
    await waitFor(() => errors.includes('stale_delivery'));
    expect(receipted).toEqual([]);
    expect(attempted).toEqual([]);

    releaseOldWrite();
    await waitFor(() => (
      daemon.listConnections()[0]?.verified === true &&
      daemon.listConnections()[0]?.epoch !== oldEpoch
    ));
    const currentEpoch = daemon.listConnections()[0]!.epoch;
    expect(await daemon.deliverGate(RUN_ID, productionGateId)).toMatchObject({
      kind: 'sent', generation: 2, epoch: currentEpoch,
    });
    await waitFor(() => productionWrites === 2);
    await waitFor(() => attempted.some((event) => event.epoch === currentEpoch));
    expect(await client.reportReceipt(productionGateId)).toBe('accepted');
    await waitFor(() => receipted.length === 1);
    expect(receipted).toEqual([{
      gateId: productionGateId,
      generation: 2,
      epoch: currentEpoch,
    }]);
  });

  it('withholds a production receipt ACK until the synchronous durable callback succeeds', async () => {
    const path = pipePath('production-receipt-fence');
    const errors: string[] = [];
    const daemon = server(path, new FakeOrca(), errors);
    let receiptCalls = 0;
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: () => {
        receiptCalls += 1;
        if (receiptCalls === 1) throw new Error('raw durable failure');
      },
    });
    await daemon.start();
    const raw = await rawAdapter(path);
    const probe = raw.messages.find((message) => message.type === 'notify')!;
    raw.socket.write(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: probe.connection_epoch,
      gate_id: probe.gate_id,
      ack_budget_ms: 5_000,
    }));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    const productionGateId = 'gate_eeeeeeeeeeee';
    expect(await daemon.deliverGate(RUN_ID, productionGateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => raw.messages.some(
      (message) => message.type === 'notify' && message.gate_id === productionGateId,
    ));
    const receipt = encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: probe.connection_epoch,
      gate_id: productionGateId,
      ack_budget_ms: 5_000,
    });
    raw.socket.write(receipt);
    await waitFor(() => errors.includes('delivery_event_failed'));
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === productionGateId,
    )).toHaveLength(0);

    raw.socket.write(receipt);
    await waitFor(() => raw.messages.some(
      (message) => message.type === 'receipt_ack' && message.gate_id === productionGateId,
    ));
    expect(receiptCalls).toBe(2);
    raw.socket.destroy();
  });

  it('keeps an Adapter-first client alive through ENOENT and connects when the daemon appears', async () => {
    const path = pipePath('adapter-first');
    const adapterErrors: string[] = [];
    const gates: string[] = [];
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => {
        gates.push(gateId);
        await client.reportReceipt(gateId);
      },
    }, identity(), adapterErrors);
    client.start();
    await waitFor(() => adapterErrors.includes('daemon_unavailable'));

    const daemon = server(path);
    await daemon.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    expect(gates).toHaveLength(1);
    expect(client.getResourceSnapshot().socket).toBe(1);
    expect(client.getResourceSnapshot().reconnectTimer).toBe(0);
  });

  it('repeats one opaque probe ID on bounded pacing and never verifies from write/attempt alone', async () => {
    const path = pipePath('no-receipt');
    const daemon = server(path);
    await daemon.start();
    const writes: string[] = [];
    const client = adapter(path, {
      notifyGate: async (gateId) => {
        writes.push(gateId);
        // Simulates a no-flag/policy-blocked session: MCP transport write resolves, no tool call.
      },
    });
    client.start();

    await waitFor(() => writes.length >= 3);
    expect(new Set(writes).size).toBe(1);
    const connection = daemon.listConnections()[0]!;
    expect(connection.probeWrites).toBeGreaterThanOrEqual(3);
    expect(connection.attemptedWrites).toBeGreaterThanOrEqual(2);
    expect(connection.verified).toBe(false);
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({ kind: 'pending', code: 'unverified' });
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('reports attempted only after the MCP transport write resolves, without treating either as receipt', async () => {
    const path = pipePath('write-order');
    const daemon = server(path);
    await daemon.start();
    let releaseWrite!: () => void;
    const heldWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const client = adapter(path, { notifyGate: () => heldWrite });
    client.start();

    await waitFor(() => client.getResourceSnapshot().notificationWrites === 1);
    expect(daemon.listConnections()[0]).toMatchObject({
      probeWrites: 1,
      attemptedWrites: 0,
      verified: false,
    });
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);

    releaseWrite();
    await waitFor(() => (daemon.listConnections()[0]?.attemptedWrites ?? 0) >= 1);
    expect(daemon.listConnections()[0]?.verified).toBe(false);
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('fences disconnect/reconnect epochs and rejects stale, wrong, and duplicate receipt calls', async () => {
    const path = pipePath('reconnect');
    let daemon = server(path);
    await daemon.start();
    const writes: string[] = [];
    const client = adapter(path, { notifyGate: async (gateId) => { writes.push(gateId); } });
    client.start();
    await waitFor(() => writes.length >= 1);
    const firstGate = writes[0]!;
    expect(await client.reportReceipt(firstGate)).toBe('accepted');
    expect(await client.reportReceipt(firstGate)).toBe('duplicate');
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    const firstEpoch = daemon.listConnections()[0]!.epoch;

    await daemon.stop();
    daemon = server(path);
    await daemon.start();
    await waitFor(() => writes.some((gateId) => gateId !== firstGate));
    const secondGate = writes.find((gateId) => gateId !== firstGate)!;
    await expect(client.reportReceipt(firstGate)).rejects.toThrowError('receipt_not_current');
    await expect(client.reportReceipt('gate_deadbeefcafe')).rejects.toThrowError('receipt_not_current');
    expect(await client.reportReceipt(secondGate)).toBe('accepted');
    expect(await client.reportReceipt(secondGate)).toBe('duplicate');
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    expect(daemon.listConnections()[0]!.epoch).not.toBe(firstEpoch);
  });

  it('rejects stale and wrong wire receipts while idempotently acknowledging an exact duplicate', async () => {
    const path = pipePath('wire-receipts');
    const errors: string[] = [];
    const daemon = server(path, new FakeOrca(), errors);
    await daemon.start();

    const stale = await rawAdapter(path);
    const staleNotify = stale.messages.find((message) => message.type === 'notify')!;
    stale.socket.write(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: `epoch_${randomUUID()}`,
      gate_id: staleNotify.gate_id,
      ack_budget_ms: 5_000,
    }));
    await waitFor(() => errors.includes('stale_epoch'));
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    stale.socket.destroy();

    const wrong = await rawAdapter(path);
    const wrongNotify = wrong.messages.find((message) => message.type === 'notify')!;
    wrong.socket.write(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: wrongNotify.connection_epoch,
      gate_id: 'gate_deadbeefcafe',
      ack_budget_ms: 5_000,
    }));
    await waitFor(() => errors.includes('wrong_receipt'));
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    wrong.socket.destroy();

    const coalesced = await rawAdapter(path);
    const coalescedNotify = coalesced.messages.find((message) => message.type === 'notify')!;
    coalesced.socket.write(Buffer.concat([
      encodeChannelFrame({
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt',
        connection_epoch: `epoch_${randomUUID()}`,
        gate_id: coalescedNotify.gate_id,
        ack_budget_ms: 5_000,
      }),
      encodeChannelFrame({
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt',
        connection_epoch: coalescedNotify.connection_epoch,
        gate_id: coalescedNotify.gate_id,
        ack_budget_ms: 5_000,
      }),
    ]));
    await waitFor(() => errors.filter((code) => code === 'stale_epoch').length === 2);
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(coalesced.messages.filter((message) => message.type === 'receipt_ack')).toHaveLength(0);
    coalesced.socket.destroy();

    const exact = await rawAdapter(path);
    const exactNotify = exact.messages.find((message) => message.type === 'notify')!;
    const receipt = encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: exactNotify.connection_epoch,
      gate_id: exactNotify.gate_id,
      ack_budget_ms: 5_000,
    });
    exact.socket.write(Buffer.concat([receipt, receipt]));
    await waitFor(() => exact.messages.filter((message) => message.type === 'receipt_ack').length === 2);
    expect(daemon.listConnections()[0]?.verified).toBe(true);
    expect(exact.messages.filter((message) => message.type === 'receipt_ack')).toEqual([
      {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt_ack',
        connection_epoch: exactNotify.connection_epoch,
        gate_id: exactNotify.gate_id,
      },
      {
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt_ack',
        connection_epoch: exactNotify.connection_epoch,
        gate_id: exactNotify.gate_id,
      },
    ]);
    exact.socket.destroy();
  });

  it('fails closed on two verified sessions claiming the same current binding and never broadcasts', async () => {
    const path = pipePath('ambiguous');
    const daemon = server(path);
    await daemon.start();
    let first!: ChannelAdapterClient;
    let second!: ChannelAdapterClient;
    first = adapter(path, { notifyGate: async (gateId) => { await first.reportReceipt(gateId); } });
    second = adapter(
      path,
      { notifyGate: async (gateId) => { await second.reportReceipt(gateId); } },
      identity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    );
    first.start();
    second.start();
    await waitFor(() => daemon.listConnections().filter((value) => value.verified).length === 2);

    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({
      kind: 'ambiguous',
      code: 'same_binding',
    });
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('retires a stale same-binding claim before routing the current generation', async () => {
    const path = pipePath('stale-and-current');
    const orca = new FakeOrca();
    const daemon = server(path, orca);
    await daemon.start();

    const stale = await rawAdapter(path);
    const staleNotify = stale.messages.find((message) => message.type === 'notify')!;
    stale.socket.write(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: staleNotify.connection_epoch,
      gate_id: staleNotify.gate_id,
      ack_budget_ms: 5_000,
    }));
    await waitFor(() => (
      daemon.listConnections().some((connection) => (
        connection.epoch === staleNotify.connection_epoch && connection.verified
      )) && daemon.getResourceSnapshot().bindingReads === 0
    ));

    orca.generation = 2;
    let current!: ChannelAdapterClient;
    current = adapter(
      path,
      { notifyGate: async (gateId) => { await current.reportReceipt(gateId); } },
      identity('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    );
    current.start();
    await waitFor(() => daemon.listConnections().filter((value) => value.verified).length === 2);
    const currentConnection = daemon.listConnections().find(
      (connection) => connection.epoch !== staleNotify.connection_epoch,
    )!;
    const expected = {
      kind: 'eligible',
      epoch: currentConnection.epoch,
      generation: 2,
    } as const;

    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual(expected);
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual(expected);
    await waitFor(() => daemon.getResourceSnapshot().sockets === 1);
    expect(daemon.listConnections().map((connection) => connection.epoch)).toEqual([
      currentConnection.epoch,
    ]);
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('keeps an exact Run route pending when every verified claim has the wrong binding', async () => {
    const path = pipePath('wrong-binding');
    const daemon = server(path);
    await daemon.start();
    let client!: ChannelAdapterClient;
    client = adapter(
      path,
      { notifyGate: async (gateId) => { await client.reportReceipt(gateId); } },
      {
        ...identity(),
        terminalHandle: 'term_99999999-9999-4999-8999-999999999999',
      },
    );
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({
      kind: 'pending',
      code: 'no_candidate',
    });
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('binds one verified connection to the authoritative generation and fences takeover', async () => {
    const path = pipePath('generation');
    const orca = new FakeOrca();
    const daemon = server(path, orca);
    await daemon.start();
    let client!: ChannelAdapterClient;
    client = adapter(path, { notifyGate: async (gateId) => { await client.reportReceipt(gateId); } });
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    expect((await daemon.evaluateProductionRoute(RUN_ID)).kind).toBe('eligible');

    orca.generation = 2;
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({
      kind: 'pending',
      code: 'stale_generation',
    });
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('fences a generation takeover that occurs before the first production route evaluation', async () => {
    const path = pipePath('generation-before-route');
    const orca = new FakeOrca();
    const daemon = server(path, orca);
    await daemon.start();
    let client!: ChannelAdapterClient;
    client = adapter(path, { notifyGate: async (gateId) => { await client.reportReceipt(gateId); } });
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    orca.generation = 2;
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({
      kind: 'pending',
      code: 'stale_generation',
    });
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('disconnects a failed hello-time Run read and recovers on the Adapter retry', async () => {
    const path = pipePath('binding-read-retry');
    const orca = new FakeOrca();
    orca.fail = true;
    const errors: string[] = [];
    const daemon = server(path, orca, errors);
    await daemon.start();
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => { await client.reportReceipt(gateId); },
    });
    client.start();

    await waitFor(() => errors.includes('run_read_failed'));
    orca.fail = false;
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    expect((await daemon.evaluateProductionRoute(RUN_ID)).kind).toBe('eligible');
    expect(daemon.getResourceSnapshot().bindingReads).toBe(0);
  });

  it('keeps a Run absent at hello pending, then reconnects to capture its appearing generation', async () => {
    const path = pipePath('binding-run-appears');
    const orca = new FakeOrca();
    orca.missingRun = true;
    const daemon = server(path, orca);
    await daemon.start();
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => { await client.reportReceipt(gateId); },
    });
    client.start();
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    const firstEpoch = daemon.listConnections()[0]!.epoch;
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({
      kind: 'pending',
      code: 'run_missing',
    });

    orca.missingRun = false;
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({
      kind: 'pending',
      code: 'stale_generation',
    });
    await waitFor(() => (
      daemon.listConnections()[0]?.verified === true &&
      daemon.listConnections()[0]?.epoch !== firstEpoch
    ));
    expect((await daemon.evaluateProductionRoute(RUN_ID)).kind).toBe('eligible');
  });

  it('fails the second daemon on fixed ownership, then releases every socket/timer for rebind', async () => {
    const path = pipePath('ownership');
    const first = server(path);
    const secondErrors: string[] = [];
    const second = server(path, new FakeOrca(), secondErrors);
    await first.start();
    await expect(second.start()).rejects.toThrowError('pipe_in_use');
    expect(secondErrors).toEqual([]);
    expect(first.getResourceSnapshot()).toMatchObject({ listening: true, sockets: 0, timers: 0 });

    await first.stop();
    expect(first.getResourceSnapshot()).toEqual({
      listening: false,
      sockets: 0,
      timers: 0,
      bindingReads: 0,
      queuedReceiptAcks: 0,
      productionRouteEvaluations: 0,
      productionGateWrites: 0,
    });
    const rebound = server(path);
    await rebound.start();
    await rebound.stop();
    expect(rebound.getResourceSnapshot()).toMatchObject({ listening: false, sockets: 0, timers: 0 });
  });

  it('pauses probe production under pipe backpressure and tears down on a bounded write deadline', async () => {
    const path = pipePath('backpressure');
    const errors: string[] = [];
    let notifyWrites = 0;
    const daemon = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: path,
      probeDelaysMs: [5],
      helloTimeoutMs: 100,
      writeTimeoutMs: 25,
      shutdownTimeoutMs: 100,
      onError: (code) => errors.push(code),
      writeFrame: (socket, frame) => {
        const isNotify = frame.includes(Buffer.from('"type":"notify"'));
        if (isNotify) notifyWrites += 1;
        socket.write(frame);
        return !isNotify;
      },
    });
    servers.push(daemon);
    await daemon.start();
    const client = adapter(path, { notifyGate: () => Promise.resolve() });
    client.start();

    await waitFor(() => errors.includes('write_timeout'));
    await client.stop();
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(notifyWrites).toBe(1);
    expect(daemon.getResourceSnapshot().timers).toBe(0);
    expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);
  });

  it('preserves the server write deadline when an exact receipt arrives before drain', async () => {
    const path = pipePath('receipt-before-drain-timeout');
    const errors: string[] = [];
    let receiptAckWrites = 0;
    const daemon = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: path,
      probeDelaysMs: [100],
      helloTimeoutMs: 100,
      writeTimeoutMs: 30,
      shutdownTimeoutMs: 100,
      onError: (code) => errors.push(code),
      writeFrame: (socket, frame) => {
        if (frame.includes(Buffer.from('"type":"receipt_ack"'))) receiptAckWrites += 1;
        const accepted = !frame.includes(Buffer.from('"type":"notify"'));
        socket.write(frame);
        return accepted;
      },
    });
    servers.push(daemon);
    await daemon.start();
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => { await client.reportReceipt(gateId); },
    });
    client.start();

    await waitFor(() => errors.includes('write_timeout'));
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(receiptAckWrites).toBe(0);
    expect(daemon.getResourceSnapshot()).toMatchObject({
      sockets: 0,
      timers: 0,
      queuedReceiptAcks: 0,
      productionGateWrites: 0,
    });
  });

  it('flushes one queued receipt acknowledgement after server drain without losing verification', async () => {
    const path = pipePath('receipt-before-drain-flush');
    const errors: string[] = [];
    let receiptAckWrites = 0;
    const daemon = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: path,
      probeDelaysMs: [100],
      helloTimeoutMs: 100,
      writeTimeoutMs: 500,
      shutdownTimeoutMs: 100,
      onError: (code) => errors.push(code),
      writeFrame: (socket, frame) => {
        if (frame.includes(Buffer.from('"type":"receipt_ack"'))) receiptAckWrites += 1;
        const isNotify = frame.includes(Buffer.from('"type":"notify"'));
        socket.write(frame);
        if (isNotify) setTimeout(() => socket.emit('drain'), 50).unref?.();
        return !isNotify;
      },
    });
    servers.push(daemon);
    await daemon.start();
    let receiptResolved = false;
    let client!: ChannelAdapterClient;
    client = adapter(path, {
      notifyGate: async (gateId) => {
        await client.reportReceipt(gateId);
        receiptResolved = true;
      },
    });
    client.start();

    await waitFor(() => receiptResolved);
    expect(daemon.listConnections()[0]?.verified).toBe(true);
    expect(receiptAckWrites).toBe(1);
    expect(errors).not.toContain('write_timeout');
    expect(daemon.getResourceSnapshot()).toMatchObject({
      timers: 0,
      queuedReceiptAcks: 0,
      productionGateWrites: 0,
    });
  });

  it('bounds Adapter backpressure and queues at most the current receipt until drain', async () => {
    const path = pipePath('adapter-backpressure');
    const daemon = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: path,
      probeDelaysMs: [200],
      helloTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });
    servers.push(daemon);
    await daemon.start();
    const errors: string[] = [];
    let attemptedWrites = 0;
    let receiptWrites = 0;
    const client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: { notifyGate: () => Promise.resolve() },
      pipePath: path,
      reconnectDelaysMs: [1_000],
      receiptAckTimeoutMs: 200,
      writeTimeoutMs: 30,
      shutdownTimeoutMs: 100,
      onError: (code) => errors.push(code),
      writeFrame: (socket, frame) => {
        const isAttempted = frame.includes(Buffer.from('"type":"attempted"'));
        if (isAttempted) attemptedWrites += 1;
        if (frame.includes(Buffer.from('"type":"receipt"'))) receiptWrites += 1;
        socket.write(frame);
        return !isAttempted;
      },
    });
    adapters.push(client);
    client.start();
    await waitFor(() => client.getResourceSnapshot().writeTimer === 1);
    const gateId = daemon.listConnections()[0]!.probeGateId;
    const receipt = client.reportReceipt(gateId).then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.message : 'unknown',
    );
    await waitFor(() => client.getResourceSnapshot().queuedReceipts === 1);
    expect(attemptedWrites).toBe(1);
    expect(receiptWrites).toBe(0);

    await waitFor(() => errors.includes('write_timeout'));
    expect(await receipt).toBe('receipt_disconnected');
    await client.stop();
    expect(client.getResourceSnapshot()).toEqual({
      socket: 0,
      reconnectTimer: 0,
      receiptTimers: 0,
      writeTimer: 0,
      queuedReceipts: 0,
      notificationWrites: 0,
      epoch: null,
    });
  });

  it('flushes the one queued Adapter receipt on drain and keeps its write deadline clear', async () => {
    const path = pipePath('adapter-backpressure-drain');
    const daemon = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: path,
      probeDelaysMs: [200],
      helloTimeoutMs: 100,
      shutdownTimeoutMs: 100,
    });
    servers.push(daemon);
    await daemon.start();
    const errors: string[] = [];
    let blockedSocket: Socket | null = null;
    let receiptWrites = 0;
    const client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: { notifyGate: () => Promise.resolve() },
      pipePath: path,
      reconnectDelaysMs: [1_000],
      receiptAckTimeoutMs: 500,
      writeTimeoutMs: 500,
      shutdownTimeoutMs: 100,
      onError: (code) => errors.push(code),
      writeFrame: (socket, frame) => {
        const isAttempted = frame.includes(Buffer.from('"type":"attempted"'));
        if (isAttempted) blockedSocket = socket;
        if (frame.includes(Buffer.from('"type":"receipt"'))) receiptWrites += 1;
        socket.write(frame);
        return !isAttempted;
      },
    });
    adapters.push(client);
    client.start();
    await waitFor(() => client.getResourceSnapshot().writeTimer === 1);
    const gateId = daemon.listConnections()[0]!.probeGateId;
    const receipt = client.reportReceipt(gateId);
    await waitFor(() => client.getResourceSnapshot().queuedReceipts === 1);
    expect(receiptWrites).toBe(0);

    (blockedSocket as Socket | null)?.emit('drain');
    await expect(receipt).resolves.toBe('accepted');
    expect(receiptWrites).toBe(1);
    expect(errors).not.toContain('write_timeout');
    expect(client.getResourceSnapshot()).toMatchObject({
      writeTimer: 0,
      queuedReceipts: 0,
      receiptTimers: 0,
    });
    expect(daemon.listConnections()[0]?.verified).toBe(true);
  });

  it('coalesces hello-time Orca reads and aborts the sole read during bounded shutdown', async () => {
    const path = pipePath('binding-read-coalesce');
    const orca = new AbortAwareNeverSettlingOrca();
    const errors: string[] = [];
    const daemon = new ChannelPipeServer({
      orca: boundedOrcaRunner(orca, 10_000),
      pipePath: path,
      probeDelaysMs: [100],
      helloTimeoutMs: 100,
      shutdownTimeoutMs: 100,
      maxConnections: 1,
      maxConnectionsPerBinding: 1,
      onError: (code) => errors.push(code),
    });
    servers.push(daemon);
    await daemon.start();

    for (let index = 0; index < 8; index += 1) {
      const raw = await rawAdapter(path);
      raw.socket.destroy();
      await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    }
    expect(orca.calls).toBe(1);
    expect(orca.active).toBe(1);
    expect(orca.maxActive).toBe(1);
    expect(daemon.getResourceSnapshot().bindingReads).toBe(1);

    const began = Date.now();
    await daemon.stop();
    expect(Date.now() - began).toBeLessThan(500);
    expect(orca.active).toBe(0);
    expect(errors).not.toContain('shutdown_timeout');
    expect(daemon.getResourceSnapshot()).toEqual({
      listening: false,
      sockets: 0,
      timers: 0,
      bindingReads: 0,
      queuedReceiptAcks: 0,
      productionRouteEvaluations: 0,
      productionGateWrites: 0,
    });
  });

  it('caps total untrusted sockets and same-binding hello claims', async () => {
    const totalPath = pipePath('total-cap');
    const totalErrors: string[] = [];
    const total = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: totalPath,
      probeDelaysMs: [20],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 100,
      maxConnections: 2,
      onError: (code) => totalErrors.push(code),
    });
    servers.push(total);
    await total.start();
    const rawSockets = Array.from({ length: 3 }, () => {
      const socket = createConnection(totalPath);
      socket.on('error', () => undefined);
      return socket;
    });
    await waitFor(() => totalErrors.includes('connection_limit'));
    expect(total.getResourceSnapshot()).toMatchObject({ sockets: 2, timers: 2 });
    rawSockets.forEach((socket) => socket.destroy());
    await waitFor(() => total.getResourceSnapshot().sockets === 0);

    const bindingPath = pipePath('binding-cap');
    const bindingErrors: string[] = [];
    const binding = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: bindingPath,
      probeDelaysMs: [20],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 100,
      maxConnections: 4,
      maxConnectionsPerBinding: 1,
      onError: (code) => bindingErrors.push(code),
    });
    servers.push(binding);
    await binding.start();
    let first!: ChannelAdapterClient;
    first = adapter(bindingPath, {
      notifyGate: async (gateId) => { await first.reportReceipt(gateId); },
    });
    first.start();
    await waitFor(() => binding.listConnections()[0]?.verified === true);
    const second = adapter(bindingPath, { notifyGate: () => Promise.resolve() });
    second.start();
    await waitFor(() => bindingErrors.includes('connection_limit'));
    await second.stop();
    await waitFor(() => binding.getResourceSnapshot().sockets === 1);
    expect(binding.listConnections()).toHaveLength(1);
  });

  it('keeps one global MCP write when a hanging notification survives reconnect epochs', async () => {
    const path = pipePath('notification-reconnect-cap');
    let daemon = server(path);
    await daemon.start();
    const adapterErrors: string[] = [];
    let notificationCalls = 0;
    const client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: {
        notifyGate: () => {
          notificationCalls += 1;
          return never();
        },
      },
      pipePath: path,
      reconnectDelaysMs: [5],
      receiptAckTimeoutMs: 50,
      shutdownTimeoutMs: 25,
      onError: (code) => adapterErrors.push(code),
    });
    adapters.push(client);
    client.start();
    await waitFor(() => client.getResourceSnapshot().notificationWrites === 1);

    for (let epoch = 0; epoch < 4; epoch += 1) {
      await daemon.stop();
      daemon = server(path);
      await daemon.start();
      await waitFor(() => (daemon.listConnections()[0]?.probeWrites ?? 0) >= 1);
    }
    expect(notificationCalls).toBe(1);
    expect(client.getResourceSnapshot().notificationWrites).toBe(1);

    await client.stop();
    expect(adapterErrors.filter((code) => code === 'shutdown_timeout')).toHaveLength(1);
    expect(client.getResourceSnapshot()).toMatchObject({
      socket: 0,
      reconnectTimer: 0,
      notificationWrites: 0,
    });
  });

  it('bounds shutdown when an MCP notification write never settles and clears socket/timer state', async () => {
    const path = pipePath('bounded-shutdown');
    const daemon = server(path);
    await daemon.start();
    const adapterErrors: string[] = [];
    const client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: { notifyGate: never },
      pipePath: path,
      reconnectDelaysMs: [10],
      receiptAckTimeoutMs: 50,
      shutdownTimeoutMs: 25,
      onError: (code) => adapterErrors.push(code),
    });
    adapters.push(client);
    client.start();
    await waitFor(() => client.getResourceSnapshot().notificationWrites === 1);

    const began = Date.now();
    await client.stop();
    await client.stop();
    expect(Date.now() - began).toBeLessThan(500);
    expect(adapterErrors.filter((code) => code === 'shutdown_timeout')).toHaveLength(1);
    expect(client.getResourceSnapshot()).toEqual({
      socket: 0,
      reconnectTimer: 0,
      receiptTimers: 0,
      writeTimer: 0,
      queuedReceipts: 0,
      notificationWrites: 0,
      epoch: null,
    });
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(daemon.getResourceSnapshot().timers).toBe(0);
  });

  it('returns redacted routing failure codes when the Orca reader fails', async () => {
    const path = pipePath('router-error');
    const orca = new FakeOrca();
    orca.fail = true;
    const errors: string[] = [];
    const daemon = server(path, orca, errors);
    await daemon.start();
    expect(await daemon.evaluateProductionRoute(RUN_ID)).toEqual({
      kind: 'pending',
      code: 'run_read_failed',
    });
    expect(errors).toEqual(['run_read_failed']);
    expect(errors.join(' ')).not.toContain('raw private Orca failure');
  });
});

function never(): Promise<void> {
  return new Promise(() => undefined);
}
