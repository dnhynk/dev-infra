import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelAdapterClient,
  type ChannelAdapterIdentity,
  type ChannelNotificationWriter,
} from '../src/channel/adapter.js';
import {
  ChannelPipeServer,
  DEFAULT_PROBE_DELAYS_MS,
} from '../src/channel/pipe-server.js';
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
  completions = 0;

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
    if (this.delayMs === 0) {
      this.completions += 1;
      return Promise.resolve(response);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        options.signal?.removeEventListener('abort', abort);
        this.completions += 1;
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

type HeldRouteRead = {
  readonly generation: number;
  release(): void;
};

/** Captures authority at invocation while allowing exact settlement order in cross-Gate tests. */
class HeldRouteOrca implements OrcaRunner {
  generation = 1;
  hold = false;
  calls = 0;
  readonly held: HeldRouteRead[] = [];

  run(args: readonly string[], options: OrcaRunOptions = {}): Promise<string> {
    this.calls += 1;
    if (args.join(' ') !== 'orchestration run-list --json') {
      return Promise.reject(new Error('unexpected fake command'));
    }
    const generation = this.generation;
    const response = JSON.stringify({
      id: 'fake',
      ok: true,
      result: {
        runs: [{
          id: RUN_ID,
          objective: 'channel test',
          coordinator_handle: TERMINAL,
          coordinator_pane_key: PANE,
          consumer_generation: generation,
          legacy: false,
          created_at: '2026-08-25T00:00:00.000Z',
          updated_at: '2026-08-25T00:00:00.000Z',
        }],
      },
    });
    if (!this.hold) return Promise.resolve(response);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const abort = (): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', abort);
        reject(new Error('fake aborted'));
      };
      const held: HeldRouteRead = {
        generation,
        release: () => {
          if (settled) return;
          settled = true;
          options.signal?.removeEventListener('abort', abort);
          resolve(response);
        },
      };
      this.held.push(held);
      if (options.signal?.aborted === true) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

type GlobalRouteBinding = {
  readonly runId: string;
  readonly gateId: string;
  readonly identity: ChannelAdapterIdentity;
};

type GlobalHeldRouteRead = {
  readonly index: number;
  release(): void;
  reject(): void;
};

/**
 * Multi-binding authority fixture whose held reads deliberately ignore AbortSignal. This exposes
 * daemon-global admission directly and lets close/deadline/shutdown retire server work before a
 * stale injected dependency settles.
 */
class GlobalAdmissionOrca implements OrcaRunner {
  hold = false;
  calls = 0;
  active = 0;
  maxActive = 0;
  readonly held: GlobalHeldRouteRead[] = [];

  constructor(readonly bindings: readonly GlobalRouteBinding[]) {}

  run(args: readonly string[], _options: OrcaRunOptions = {}): Promise<string> {
    this.calls += 1;
    if (args.join(' ') !== 'orchestration run-list --json') {
      return Promise.reject(new Error('unexpected global-admission command'));
    }
    const response = JSON.stringify({
      id: 'fake',
      ok: true,
      result: {
        runs: this.bindings.map((binding) => ({
          id: binding.runId,
          objective: 'global admission test',
          coordinator_handle: binding.identity.terminalHandle,
          coordinator_pane_key: binding.identity.paneKey,
          consumer_generation: 1,
          legacy: false,
          created_at: '2026-08-25T00:00:00.000Z',
          updated_at: '2026-08-25T00:00:00.000Z',
        })),
      },
    });
    if (!this.hold) return Promise.resolve(response);

    const index = this.held.length;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (result: 'release' | 'reject'): void => {
        if (settled) return;
        settled = true;
        this.active -= 1;
        if (result === 'release') resolve(response);
        else reject(new Error('controlled global-admission read failure'));
      };
      this.held.push({
        index,
        release: () => finish('release'),
        reject: () => finish('reject'),
      });
    });
  }
}

function globalBindings(count: number, offset = 0): readonly GlobalRouteBinding[] {
  return Array.from({ length: count }, (_, localIndex) => {
    const index = offset + localIndex + 1;
    return {
      runId: `run_global${index}`,
      gateId: `gate_${String(index).padStart(12, '0')}`,
      identity: {
        sessionId: randomUUID(),
        terminalHandle: `term_global-${index}`,
        paneKey: `global-${index}:pane-${index}`,
      },
    };
  });
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

async function rawAdapter(
  path: string,
  adapterIdentity: ChannelAdapterIdentity = identity(),
): Promise<{
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
    session_id: adapterIdentity.sessionId,
    terminal_handle: adapterIdentity.terminalHandle,
    pane_key: adapterIdentity.paneKey,
    instance_id: `adapter_${randomUUID()}`,
    connection_id: `connection_${randomUUID()}`,
  }));
  await waitFor(() => messages.some((message) => message.type === 'notify'));
  return { socket, messages };
}

type RawAdapterConnection = Awaited<ReturnType<typeof rawAdapter>>;

function rawProbe(raw: RawAdapterConnection): Extract<DaemonToAdapterMessage, { type: 'notify' }> {
  const probe = raw.messages.find((message) => message.type === 'notify');
  if (probe === undefined) throw new Error('raw adapter probe missing');
  return probe;
}

function rawAttemptedFrame(raw: RawAdapterConnection, gateId: string): Buffer {
  return encodeChannelFrame({
    version: CHANNEL_PROTOCOL_VERSION,
    type: 'attempted',
    connection_epoch: rawProbe(raw).connection_epoch,
    gate_id: gateId,
  });
}

function rawReceiptFrame(raw: RawAdapterConnection, gateId: string, budgetMs = 5_000): Buffer {
  return encodeChannelFrame({
    version: CHANNEL_PROTOCOL_VERSION,
    type: 'receipt',
    connection_epoch: rawProbe(raw).connection_epoch,
    gate_id: gateId,
    ack_budget_ms: budgetMs,
    ack_deadline_ns: (process.hrtime.bigint() + BigInt(budgetMs) * 1_000_000n).toString(),
  });
}

function receiptAckCount(raw: RawAdapterConnection, gateId: string): number {
  return raw.messages.filter(
    (message) => message.type === 'receipt_ack' && message.gate_id === gateId,
  ).length;
}

async function openVerifiedRaw(
  path: string,
  binding: GlobalRouteBinding,
): Promise<RawAdapterConnection> {
  const raw = await rawAdapter(path, binding.identity);
  const probe = rawProbe(raw);
  raw.socket.write(rawReceiptFrame(raw, probe.gate_id));
  await waitFor(() => receiptAckCount(raw, probe.gate_id) === 1);
  return raw;
}

const servers: ChannelPipeServer[] = [];
const adapters: ChannelAdapterClient[] = [];

function server(path: string, orca: OrcaRunner = new FakeOrca(), errors: string[] = []): ChannelPipeServer {
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
  it('검증되지 않은 연결의 정상 상태 probe 주기가 짧지 않다', () => {
    /*
     * probe는 세션 화면에 보이는 줄을 하나 남긴다. adapter의 중복 제거가 전송 중 집합만 보므로
     * 같은 probe gate id라도 매번 다시 알림으로 나간다. 그래서 이 주기가 곧 "검증되지 않은
     * 연결이 사람 화면에 줄을 쌓는 속도"다.
     *
     * 30초였을 때 실제로 코디네이터가 띄운 선택 프롬프트가 쌓인 probe 줄에 밀려 화면 밖으로
     * 나갔다. 그 상태는 드물지 않다 — 프롬프트 앞에 멈춘 세션은 도구를 호출할 수 없어 receipt를
     * 보내지 못하고, 즉 사람이 답을 기다리는 순간이 바로 연결이 검증되지 않는 순간이다.
     *
     * 앞쪽 값들은 정상 연결을 빠르게 검증하므로 짧아도 된다. 고정되는 마지막 값만 길어야 한다.
     */
    const steadyState = DEFAULT_PROBE_DELAYS_MS[DEFAULT_PROBE_DELAYS_MS.length - 1]!;
    expect(steadyState).toBeGreaterThanOrEqual(300_000);
    // 완전히 멈추지는 않는다. 세션이 나중에 풀렸을 때 복구되어야 한다.
    expect(Number.isFinite(steadyState)).toBe(true);
  });

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

  it('keeps attempted replayable and ACK-free while honoring a preceding receipt boundary', async () => {
    const path = pipePath('production-attempted-historical-boundary');
    const orca = new HeldRouteOrca();
    const daemon = server(path, orca);
    const firstGateId = 'gate_121212121212';
    const secondGateId = 'gate_343434343434';
    const callbacks: string[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: ({ gateId }) => callbacks.push(`attempted:${gateId}`),
      receipted: ({ gateId }) => callbacks.push(`receipted:${gateId}`),
    });
    await daemon.start();
    const raw = await rawAdapter(path);
    const probe = raw.messages.find((message) => message.type === 'notify')!;
    const receipt = (gateId: string): Buffer => encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: probe.connection_epoch,
      gate_id: gateId,
      ack_budget_ms: 5_000,
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    });
    const attempted = (gateId: string): Buffer => encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'attempted',
      connection_epoch: probe.connection_epoch,
      gate_id: gateId,
    });
    raw.socket.write(receipt(probe.gate_id));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    for (const gateId of [firstGateId, secondGateId]) {
      expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    }
    await waitFor(() => [firstGateId, secondGateId].every((gateId) =>
      raw.messages.some((message) => message.type === 'notify' && message.gate_id === gateId)));

    // Both reads begin before the receipt commits. Once that sole authority boundary advances,
    // the later historical attempt must perform its own fresh route read before its callback.
    orca.hold = true;
    const validationReadStart = orca.calls;
    raw.socket.write(Buffer.concat([receipt(firstGateId), attempted(secondGateId)]));
    await waitFor(() => orca.held.length === 2);
    expect(orca.held.map((read) => read.generation)).toEqual([1, 1]);
    orca.held[0]!.release();
    await waitFor(() => callbacks.length === 1);
    await waitFor(() => raw.messages.some(
      (message) => message.type === 'receipt_ack' && message.gate_id === firstGateId,
    ));
    expect(callbacks).toEqual([`receipted:${firstGateId}`]);

    orca.held[1]!.release();
    await waitFor(() => orca.held.length === 3);
    expect(callbacks).toEqual([`receipted:${firstGateId}`]);
    expect(orca.held[2]!.generation).toBe(1);
    orca.held[2]!.release();
    await waitFor(() => callbacks.length === 2);
    expect(callbacks).toEqual([
      `receipted:${firstGateId}`,
      `attempted:${secondGateId}`,
    ]);
    expect(orca.calls - validationReadStart).toBe(3);
    expect(orca.generation).toBe(1);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === firstGateId,
    )).toHaveLength(1);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === secondGateId,
    )).toHaveLength(0);

    // Attempted does not consume or remove the exact token: the scheduler may retry the same Gate
    // on this verified epoch, and that retry still creates neither an ACK nor an Orca mutation.
    const secondNotifyCount = raw.messages.filter(
      (message) => message.type === 'notify' && message.gate_id === secondGateId,
    ).length;
    orca.hold = false;
    expect(await daemon.deliverGate(RUN_ID, secondGateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => raw.messages.filter(
      (message) => message.type === 'notify' && message.gate_id === secondGateId,
    ).length === secondNotifyCount + 1);
    expect(callbacks).toHaveLength(2);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === secondGateId,
    )).toHaveLength(0);
    raw.socket.destroy();
  });

  it('admits production events through one fair daemon-global FIFO with a hard concurrency cap', async () => {
    const path = pipePath('production-global-admission-fifo');
    const bindings = globalBindings(4);
    const noisyGateIds = [
      bindings[0]!.gateId,
      'gate_a00000000001',
      'gate_a00000000002',
      'gate_a00000000003',
    ];
    const orca = new GlobalAdmissionOrca(bindings);
    const callbacks: string[] = [];
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      maxConcurrentProductionEvents: 2,
    });
    servers.push(daemon);
    daemon.setProductionDeliveryHandlers({
      attempted: ({ gateId }) => callbacks.push(gateId),
      receipted: () => undefined,
    });
    await daemon.start();
    const raws: RawAdapterConnection[] = [];
    for (const binding of bindings) raws.push(await openVerifiedRaw(path, binding));
    expect(daemon.listConnections().filter((connection) => connection.verified)).toHaveLength(4);

    for (const gateId of noisyGateIds) {
      expect(await daemon.deliverGate(bindings[0]!.runId, gateId)).toMatchObject({
        kind: 'sent', generation: 1,
      });
      await waitFor(() => raws[0]!.messages.some(
        (message) => message.type === 'notify' && message.gate_id === gateId,
      ));
    }
    for (let index = 1; index < bindings.length; index += 1) {
      const binding = bindings[index]!;
      expect(await daemon.deliverGate(binding.runId, binding.gateId)).toMatchObject({
        kind: 'sent', generation: 1,
      });
      await waitFor(() => raws[index]!.messages.some(
        (message) => message.type === 'notify' && message.gate_id === binding.gateId,
      ));
    }

    orca.hold = true;
    raws[0]!.socket.write(rawAttemptedFrame(raws[0]!, noisyGateIds[0]!));
    await waitFor(() => orca.held.length === 1);
    raws[0]!.socket.write(rawAttemptedFrame(raws[0]!, noisyGateIds[1]!));
    await waitFor(() => orca.held.length === 2);

    // B becomes ready while A owns both permits. Only then add A's noisy backlog, followed by C
    // and D. A fair per-connection FIFO must admit B before either later A event and continue to
    // rotate C/D ahead of A's final queued event.
    raws[1]!.socket.write(rawAttemptedFrame(raws[1]!, bindings[1]!.gateId));
    const bEpoch = rawProbe(raws[1]!).connection_epoch;
    await waitFor(() => daemon.listConnections().some(
      (connection) => connection.epoch === bEpoch && connection.attemptedWrites === 1,
    ));
    raws[0]!.socket.write(Buffer.concat([
      rawAttemptedFrame(raws[0]!, noisyGateIds[2]!),
      rawAttemptedFrame(raws[0]!, noisyGateIds[3]!),
    ]));
    const aEpoch = rawProbe(raws[0]!).connection_epoch;
    await waitFor(() => daemon.listConnections().some(
      (connection) => connection.epoch === aEpoch && connection.attemptedWrites === 4,
    ));
    for (const index of [2, 3]) {
      const raw = raws[index]!;
      raw.socket.write(rawAttemptedFrame(raw, bindings[index]!.gateId));
      const epoch = rawProbe(raw).connection_epoch;
      await waitFor(() => daemon.listConnections().some(
        (connection) => connection.epoch === epoch && connection.attemptedWrites === 1,
      ));
    }
    expect(orca.held).toHaveLength(2);
    expect(orca.active).toBe(2);
    expect(orca.maxActive).toBe(2);
    expect(callbacks).toEqual([]);

    orca.held[0]!.release();
    await waitFor(() => callbacks.length === 1 && orca.held.length === 3);
    expect(callbacks).toEqual([noisyGateIds[0]]);
    expect(orca.active).toBe(2);
    orca.held[2]!.release();
    await waitFor(() => callbacks.length === 2 && orca.held.length === 4);
    expect(callbacks).toEqual([noisyGateIds[0], bindings[1]!.gateId]);
    expect(orca.active).toBe(2);

    orca.held[1]!.release();
    await waitFor(() => callbacks.length === 3 && orca.held.length === 5);
    orca.held[3]!.release();
    await waitFor(() => callbacks.length === 4 && orca.held.length === 6);
    orca.held[4]!.release();
    await waitFor(() => callbacks.length === 5 && orca.held.length === 7);
    orca.held[5]!.release();
    await waitFor(() => callbacks.length === 6);
    orca.held[6]!.release();
    await waitFor(() => callbacks.length === 7);
    expect(callbacks).toEqual([
      noisyGateIds[0],
      bindings[1]!.gateId,
      noisyGateIds[1],
      noisyGateIds[2],
      bindings[2]!.gateId,
      bindings[3]!.gateId,
      noisyGateIds[3],
    ]);
    expect(orca.active).toBe(0);
    expect(orca.maxActive).toBe(2);
    for (const raw of raws) raw.socket.destroy();
  });

  it('returns a global permit exactly once when a connection closes around a non-abort-aware read', async () => {
    const path = pipePath('production-global-admission-close');
    const bindings = globalBindings(3, 10);
    const orca = new GlobalAdmissionOrca(bindings);
    const callbacks: string[] = [];
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      eventValidationTimeoutMs: 1_000,
      productionEventDeadlineMs: 2_000,
      maxConcurrentProductionEvents: 1,
    });
    servers.push(daemon);
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: ({ gateId }) => callbacks.push(gateId),
    });
    await daemon.start();
    const raws: RawAdapterConnection[] = [];
    for (const binding of bindings) raws.push(await openVerifiedRaw(path, binding));
    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index]!;
      expect(await daemon.deliverGate(binding.runId, binding.gateId)).toMatchObject({ kind: 'sent' });
      await waitFor(() => raws[index]!.messages.some(
        (message) => message.type === 'notify' && message.gate_id === binding.gateId,
      ));
    }

    orca.hold = true;
    raws[0]!.socket.write(rawReceiptFrame(raws[0]!, bindings[0]!.gateId));
    await waitFor(() => orca.held.length === 1);
    raws[1]!.socket.write(rawReceiptFrame(raws[1]!, bindings[1]!.gateId));
    raws[2]!.socket.write(rawReceiptFrame(raws[2]!, bindings[2]!.gateId));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(orca.held).toHaveLength(1);

    const closedEpoch = rawProbe(raws[0]!).connection_epoch;
    raws[0]!.socket.destroy();
    await waitFor(() => !daemon.listConnections().some(
      (connection) => connection.epoch === closedEpoch,
    ));
    await waitFor(() => orca.held.length === 2, 300);
    expect(callbacks).toEqual([]);

    // The retired injected read may settle later, but it cannot invoke durable state or return the
    // already-reclaimed permit a second time while connection 2 still owns the only slot.
    orca.held[0]!.release();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(orca.held).toHaveLength(2);
    expect(callbacks).toEqual([]);
    expect(receiptAckCount(raws[0]!, bindings[0]!.gateId)).toBe(0);

    orca.held[1]!.release();
    await waitFor(() => callbacks.length === 1 && orca.held.length === 3);
    await waitFor(() => receiptAckCount(raws[1]!, bindings[1]!.gateId) === 1);
    expect(callbacks).toEqual([bindings[1]!.gateId]);
    orca.held[2]!.release();
    await waitFor(() => callbacks.length === 2);
    await waitFor(() => receiptAckCount(raws[2]!, bindings[2]!.gateId) === 1);
    expect(callbacks).toEqual([bindings[1]!.gateId, bindings[2]!.gateId]);
    raws[1]!.socket.destroy();
    raws[2]!.socket.destroy();
  });

  it('reclaims a timed-out global permit while a non-abort-aware read settles harmlessly late', async () => {
    const path = pipePath('production-global-admission-timeout');
    const bindings = globalBindings(3, 20);
    const orca = new GlobalAdmissionOrca(bindings);
    const errors: string[] = [];
    const callbacks: string[] = [];
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      eventValidationTimeoutMs: 100,
      productionEventDeadlineMs: 500,
      maxConcurrentProductionEvents: 1,
      onError: (code) => errors.push(code),
    });
    servers.push(daemon);
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: ({ gateId }) => callbacks.push(gateId),
    });
    await daemon.start();
    const raws: RawAdapterConnection[] = [];
    for (const binding of bindings) raws.push(await openVerifiedRaw(path, binding));
    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index]!;
      expect(await daemon.deliverGate(binding.runId, binding.gateId)).toMatchObject({ kind: 'sent' });
      await waitFor(() => raws[index]!.messages.some(
        (message) => message.type === 'notify' && message.gate_id === binding.gateId,
      ));
    }

    orca.hold = true;
    raws[0]!.socket.write(rawReceiptFrame(raws[0]!, bindings[0]!.gateId, 500));
    await waitFor(() => orca.held.length === 1);
    raws[1]!.socket.write(rawReceiptFrame(raws[1]!, bindings[1]!.gateId, 500));
    raws[2]!.socket.write(rawReceiptFrame(raws[2]!, bindings[2]!.gateId, 500));
    await waitFor(() => orca.held.length === 2, 300);
    expect(errors).toContain('run_read_failed');
    expect(callbacks).toEqual([]);
    expect(receiptAckCount(raws[0]!, bindings[0]!.gateId)).toBe(0);

    orca.held[0]!.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(orca.held).toHaveLength(2);
    expect(callbacks).toEqual([]);
    orca.held[1]!.release();
    await waitFor(() => callbacks.length === 1 && orca.held.length === 3);
    await waitFor(() => receiptAckCount(raws[1]!, bindings[1]!.gateId) === 1);
    expect(callbacks).toEqual([bindings[1]!.gateId]);
    orca.held[2]!.release();
    await waitFor(() => callbacks.length === 2);
    await waitFor(() => receiptAckCount(raws[2]!, bindings[2]!.gateId) === 1);
    expect(callbacks).toEqual([bindings[1]!.gateId, bindings[2]!.gateId]);
    for (const raw of raws) raw.socket.destroy();
  });

  it('expires a queued receipt from its original receive-time deadline before any route read', async () => {
    const path = pipePath('production-global-queued-original-deadline');
    const bindings = globalBindings(2, 60);
    const orca = new GlobalAdmissionOrca(bindings);
    const errors: string[] = [];
    const callbacks: string[] = [];
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      eventValidationTimeoutMs: 400,
      productionEventDeadlineMs: 500,
      maxConcurrentProductionEvents: 1,
      onError: (code) => errors.push(code),
    });
    servers.push(daemon);
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: ({ gateId }) => callbacks.push(gateId),
    });
    await daemon.start();
    const raws = [
      await openVerifiedRaw(path, bindings[0]!),
      await openVerifiedRaw(path, bindings[1]!),
    ];
    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index]!;
      expect(await daemon.deliverGate(binding.runId, binding.gateId)).toMatchObject({ kind: 'sent' });
      await waitFor(() => raws[index]!.messages.some(
        (message) => message.type === 'notify' && message.gate_id === binding.gateId,
      ));
    }

    orca.hold = true;
    raws[0]!.socket.write(rawReceiptFrame(raws[0]!, bindings[0]!.gateId, 500));
    await waitFor(() => orca.held.length === 1);
    const readsWithAHeld = orca.calls;

    // The attempted marker is only an observable inbound fence: once its counter advances, B's
    // preceding short-budget receipt is definitely in the global queue behind A's sole permit.
    raws[1]!.socket.write(Buffer.concat([
      rawReceiptFrame(raws[1]!, bindings[1]!.gateId, 40),
      rawAttemptedFrame(raws[1]!, bindings[1]!.gateId),
    ]));
    const bEpoch = rawProbe(raws[1]!).connection_epoch;
    await waitFor(() => daemon.listConnections().some(
      (connection) => connection.epoch === bEpoch && connection.attemptedWrites === 1,
    ));
    expect(orca.held).toHaveLength(1);
    expect(orca.calls).toBe(readsWithAHeld);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(orca.calls).toBe(readsWithAHeld);
    expect(callbacks).toEqual([]);
    expect(receiptAckCount(raws[1]!, bindings[1]!.gateId)).toBe(0);

    orca.held[0]!.release();
    await waitFor(() => callbacks.length === 1);
    await waitFor(() => receiptAckCount(raws[0]!, bindings[0]!.gateId) === 1);
    await waitFor(() => !daemon.listConnections().some(
      (connection) => connection.epoch === bEpoch,
    ));
    expect(errors).toContain('delivery_event_expired');
    expect(callbacks).toEqual([bindings[0]!.gateId]);
    expect(orca.calls).toBe(readsWithAHeld);
    expect(receiptAckCount(raws[1]!, bindings[1]!.gateId)).toBe(0);
    expect(orca.held).toHaveLength(1);
    for (const raw of raws) raw.socket.destroy();
  });

  it('returns global permits after callback throw/reject and an Orca read rejection', async () => {
    const path = pipePath('production-global-admission-failures');
    const bindings = globalBindings(4, 30);
    const orca = new GlobalAdmissionOrca(bindings);
    const errors: string[] = [];
    const handlerCalls: string[] = [];
    const durableCallbacks: string[] = [];
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      eventValidationTimeoutMs: 1_000,
      productionEventDeadlineMs: 2_000,
      maxConcurrentProductionEvents: 1,
      onError: (code) => errors.push(code),
    });
    servers.push(daemon);
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: ({ gateId }) => {
        handlerCalls.push(gateId);
        if (gateId === bindings[0]!.gateId) throw new Error('controlled durable failure');
        if (gateId === bindings[1]!.gateId) {
          return Promise.reject(new Error('controlled async durable failure'));
        }
        durableCallbacks.push(gateId);
      },
    });
    await daemon.start();
    const raws: RawAdapterConnection[] = [];
    for (const binding of bindings) raws.push(await openVerifiedRaw(path, binding));
    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index]!;
      expect(await daemon.deliverGate(binding.runId, binding.gateId)).toMatchObject({ kind: 'sent' });
      await waitFor(() => raws[index]!.messages.some(
        (message) => message.type === 'notify' && message.gate_id === binding.gateId,
      ));
    }

    orca.hold = true;
    raws[0]!.socket.write(rawReceiptFrame(raws[0]!, bindings[0]!.gateId));
    await waitFor(() => orca.held.length === 1);
    raws[1]!.socket.write(rawReceiptFrame(raws[1]!, bindings[1]!.gateId));
    raws[2]!.socket.write(rawReceiptFrame(raws[2]!, bindings[2]!.gateId));
    raws[3]!.socket.write(rawReceiptFrame(raws[3]!, bindings[3]!.gateId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(orca.held).toHaveLength(1);

    orca.held[0]!.release();
    await waitFor(() => handlerCalls.length === 1 && orca.held.length === 2);
    expect(handlerCalls).toEqual([bindings[0]!.gateId]);
    expect(durableCallbacks).toEqual([]);
    expect(errors).toContain('delivery_event_failed');
    expect(receiptAckCount(raws[0]!, bindings[0]!.gateId)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(orca.held).toHaveLength(2);

    orca.held[1]!.release();
    await waitFor(() => handlerCalls.length === 2 && orca.held.length === 3);
    expect(errors.filter((code) => code === 'delivery_event_failed')).toHaveLength(2);
    expect(receiptAckCount(raws[1]!, bindings[1]!.gateId)).toBe(0);
    orca.held[2]!.reject();
    await waitFor(() => errors.includes('run_read_failed') && orca.held.length === 4);
    expect(handlerCalls).toEqual([bindings[0]!.gateId, bindings[1]!.gateId]);
    expect(receiptAckCount(raws[2]!, bindings[2]!.gateId)).toBe(0);
    orca.held[3]!.release();
    await waitFor(() => durableCallbacks.length === 1);
    await waitFor(() => receiptAckCount(raws[3]!, bindings[3]!.gateId) === 1);
    expect(handlerCalls).toEqual([
      bindings[0]!.gateId,
      bindings[1]!.gateId,
      bindings[3]!.gateId,
    ]);
    expect(durableCallbacks).toEqual([bindings[3]!.gateId]);
    for (const raw of raws) raw.socket.destroy();
  });

  it('clears global admission on shutdown and fences every stale or queued completion after restart', async () => {
    const path = pipePath('production-global-admission-shutdown');
    const bindings = globalBindings(4, 40);
    const orca = new GlobalAdmissionOrca(bindings);
    const durableCallbacks: string[] = [];
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      eventValidationTimeoutMs: 1_000,
      productionEventDeadlineMs: 2_000,
      maxConcurrentProductionEvents: 2,
    });
    servers.push(daemon);
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: ({ gateId }) => durableCallbacks.push(gateId),
    });
    await daemon.start();
    const staleRaws: RawAdapterConnection[] = [];
    for (const binding of bindings.slice(0, 3)) {
      staleRaws.push(await openVerifiedRaw(path, binding));
    }
    for (let index = 0; index < staleRaws.length; index += 1) {
      const binding = bindings[index]!;
      expect(await daemon.deliverGate(binding.runId, binding.gateId)).toMatchObject({ kind: 'sent' });
      await waitFor(() => staleRaws[index]!.messages.some(
        (message) => message.type === 'notify' && message.gate_id === binding.gateId,
      ));
    }

    orca.hold = true;
    staleRaws[0]!.socket.write(rawReceiptFrame(staleRaws[0]!, bindings[0]!.gateId));
    await waitFor(() => orca.held.length === 1);
    staleRaws[1]!.socket.write(rawReceiptFrame(staleRaws[1]!, bindings[1]!.gateId));
    await waitFor(() => orca.held.length === 2);
    staleRaws[2]!.socket.write(rawReceiptFrame(staleRaws[2]!, bindings[2]!.gateId));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(orca.held).toHaveLength(2);

    await daemon.stop();
    expect(daemon.getResourceSnapshot()).toMatchObject({ listening: false, sockets: 0 });
    expect(durableCallbacks).toEqual([]);
    for (let index = 0; index < staleRaws.length; index += 1) {
      expect(receiptAckCount(staleRaws[index]!, bindings[index]!.gateId)).toBe(0);
    }

    orca.held[0]!.release();
    orca.held[1]!.release();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(orca.held).toHaveLength(2);
    expect(durableCallbacks).toEqual([]);
    for (let index = 0; index < staleRaws.length; index += 1) {
      expect(receiptAckCount(staleRaws[index]!, bindings[index]!.gateId)).toBe(0);
    }

    // Restarting creates a new admission epoch with all permits available; no stale release or
    // discarded queued event can consume them or cross into the new durable callback stream.
    orca.hold = false;
    await daemon.start();
    const currentBinding = bindings[3]!;
    const currentRaw = await openVerifiedRaw(path, currentBinding);
    expect(await daemon.deliverGate(currentBinding.runId, currentBinding.gateId)).toMatchObject({
      kind: 'sent', generation: 1,
    });
    await waitFor(() => currentRaw.messages.some(
      (message) => message.type === 'notify' && message.gate_id === currentBinding.gateId,
    ));
    currentRaw.socket.write(rawReceiptFrame(currentRaw, currentBinding.gateId));
    await waitFor(() => durableCallbacks.length === 1);
    await waitFor(() => receiptAckCount(currentRaw, currentBinding.gateId) === 1);
    expect(durableCallbacks).toEqual([currentBinding.gateId]);
    currentRaw.socket.destroy();
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
    // Three exact authority waves (initial, speculative refresh, commit-boundary refresh) must
    // remain inside the production 5 second ACK budget without assigning a stale read a new
    // predecessor revision. 1.4s keeps that adversarial three-wave path below 4.5s.
    orca.delayMs = 1_400;
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
    // Six initial attempted/receipt reads form wave one. Receipt 2 and 3 each start a speculative
    // post-receipt refresh in wave two, and receipt 3 needs one exact commit-boundary read in wave
    // three after receipt 2 advances the boundary: 6 + 2 + 1 reads, all inside 4.5 seconds.
    expect(orca.calls - callbackReadStart).toBe(9);
    expect(daemonErrors).not.toContain('delivery_event_expired');
    expect(daemonErrors).not.toContain('stale_delivery');
    expect(adapterErrors).not.toContain('wrong_receipt_ack');
    expect(daemon.listConnections()[0]?.verified).toBe(true);
  });

  it('restarts a nested stale refresh after two different-Gate predecessor commits', async () => {
    const path = pipePath('production-nested-cross-gate-refresh');
    const orca = new HeldRouteOrca();
    const errors: string[] = [];
    const daemon = server(path, orca, errors);
    const firstGateId = 'gate_343434343434';
    const secondGateId = 'gate_565656565656';
    const thirdGateId = 'gate_787878787878';
    const durableReceipts: string[] = [];
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: ({ gateId }) => {
        durableReceipts.push(gateId);
        if (gateId === secondGateId) orca.generation = 2;
      },
    });
    await daemon.start();
    const raw = await rawAdapter(path);
    const probe = raw.messages.find((message) => message.type === 'notify')!;
    const receipt = (gateId: string): Buffer => encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: probe.connection_epoch,
      gate_id: gateId,
      ack_budget_ms: 5_000,
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    });
    raw.socket.write(receipt(probe.gate_id));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    for (const gateId of [firstGateId, secondGateId, thirdGateId]) {
      expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    }
    await waitFor(() => [firstGateId, secondGateId, thirdGateId].every((gateId) =>
      raw.messages.some((message) => message.type === 'notify' && message.gate_id === gateId)));

    // A/B/C all start at revision 0 and capture generation 1. A settles first and advances the
    // callback revision; C then settles its stale initial read and starts a held speculative refresh.
    orca.hold = true;
    raw.socket.write(Buffer.concat([
      receipt(firstGateId),
      receipt(secondGateId),
      receipt(thirdGateId),
    ]));
    await waitFor(() => orca.held.length === 3);
    expect(orca.held.map((read) => read.generation)).toEqual([1, 1, 1]);
    orca.held[0]!.release();
    await waitFor(() => durableReceipts.length === 1);
    expect(durableReceipts).toEqual([firstGateId]);
    orca.held[2]!.release();
    await waitFor(() => orca.held.length === 4);
    expect(orca.held[3]!.generation).toBe(1);

    // B's own stale initial read and refresh now settle, letting B commit and switch generation.
    // C's refresh was already in flight with revision 1, so settling it after B must trigger yet
    // another fresh read at its commit boundary instead of inheriting revision 2 at settlement.
    orca.held[1]!.release();
    await waitFor(() => orca.held.length === 5);
    expect(orca.held[4]!.generation).toBe(1);
    orca.held[4]!.release();
    await waitFor(() => durableReceipts.length === 2);
    expect(durableReceipts).toEqual([firstGateId, secondGateId]);
    expect(orca.generation).toBe(2);
    orca.hold = false;
    orca.held[3]!.release();
    await waitFor(() => errors.includes('stale_delivery'));
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(durableReceipts).toEqual([firstGateId, secondGateId]);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === firstGateId,
    )).toHaveLength(1);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === secondGateId,
    )).toHaveLength(1);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === thirdGateId,
    )).toHaveLength(0);
    raw.socket.destroy();
  });

  it('fences a receipt when the same socket becomes non-writable after its drain wait resolves', async () => {
    const path = pipePath('production-receipt-drain-microtask-fence');
    const errors: string[] = [];
    const orca = new HeldRouteOrca();
    const blockerGateId = 'gate_909090909090';
    const targetGateId = 'gate_abababababab';
    const pressureGateId = 'gate_bcbcbcbcbcbc';
    let blockedServerSocket: Socket | null = null;
    let blockFirstAck = true;
    let pressureWriteSaturated = false;
    const daemon = new ChannelPipeServer({
      orca,
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      writeTimeoutMs: 1_000,
      shutdownTimeoutMs: 500,
      onError: (code) => errors.push(code),
      writeFrame: (socket, frame) => {
        blockedServerSocket = socket;
        socket.write(frame);
        if (
          blockFirstAck &&
          frame.includes(Buffer.from('"type":"receipt_ack"')) &&
          frame.includes(Buffer.from(`"gate_id":"${blockerGateId}"`))
        ) {
          blockFirstAck = false;
          return false;
        }
        if (
          frame.includes(Buffer.from('"type":"notify"')) &&
          frame.includes(Buffer.from(`"gate_id":"${pressureGateId}"`))
        ) {
          const saturationFrame = Buffer.alloc(64 * 1_024, 0x61);
          for (let writes = 0; writes < 64 && !socket.writableNeedDrain; writes += 1) {
            socket.write(saturationFrame);
          }
          pressureWriteSaturated = socket.writableNeedDrain;
          return false;
        }
        return true;
      },
    });
    servers.push(daemon);
    let targetDurableTransitions = 0;
    let targetCardRearms = 0;
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: ({ gateId }) => {
        if (gateId !== targetGateId) return;
        targetDurableTransitions += 1;
        targetCardRearms += 1;
      },
    });
    await daemon.start();
    const raw = await rawAdapter(path);
    const probe = raw.messages.find((message) => message.type === 'notify')!;
    const receipt = (gateId: string): Buffer => encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: probe.connection_epoch,
      gate_id: gateId,
      ack_budget_ms: 5_000,
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    });
    raw.socket.write(receipt(probe.gate_id));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    for (const gateId of [blockerGateId, targetGateId]) {
      expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    }
    await waitFor(() => [blockerGateId, targetGateId].every((gateId) =>
      raw.messages.some((message) => message.type === 'notify' && message.gate_id === gateId)));
    raw.socket.write(receipt(blockerGateId));
    await waitFor(() => blockFirstAck === false);

    orca.hold = true;
    raw.socket.write(receipt(targetGateId));
    await waitFor(() => orca.held.length === 1);
    orca.held[0]!.release();
    await waitFor(() => (blockedServerSocket?.listenerCount('drain') ?? 0) >= 2);
    raw.socket.pause();

    // The drain clears writeBlocked and resolves the receipt waiter. Its mandatory fresh read then
    // stays in flight while another exact deliverGate saturates this same socket and re-blocks it.
    blockedServerSocket!.emit('drain');
    await waitFor(() => orca.held.length === 2);
    orca.hold = false;
    expect(await daemon.deliverGate(RUN_ID, pressureGateId)).toMatchObject({ kind: 'sent' });
    expect(pressureWriteSaturated).toBe(true);
    expect(blockedServerSocket!.writableNeedDrain).toBe(true);
    orca.held[1]!.release();
    await waitFor(() => errors.includes('delivery_event_expired'));
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(targetDurableTransitions).toBe(0);
    expect(targetCardRearms).toBe(0);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === targetGateId,
    )).toHaveLength(0);
    raw.socket.destroy();

    // The uncommitted receipt remains replayable on a newly verified epoch.
    const replay = await rawAdapter(path);
    const replayProbe = replay.messages.find((message) => message.type === 'notify')!;
    const replayReceipt = (gateId: string): Buffer => encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: replayProbe.connection_epoch,
      gate_id: gateId,
      ack_budget_ms: 5_000,
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    });
    replay.socket.write(replayReceipt(replayProbe.gate_id));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);
    expect(await daemon.deliverGate(RUN_ID, targetGateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => replay.messages.some(
      (message) => message.type === 'notify' && message.gate_id === targetGateId,
    ));
    replay.socket.write(replayReceipt(targetGateId));
    await waitFor(() => targetDurableTransitions === 1);
    await waitFor(() => replay.messages.some(
      (message) => message.type === 'receipt_ack' && message.gate_id === targetGateId,
    ));
    expect(targetCardRearms).toBe(1);
    replay.socket.destroy();
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
    // Both prevalidate concurrently; the second also performs one exact post-drain refresh.
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
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

  it('closes the transactional commit fence when a receipt handler crosses its monotonic deadline', async () => {
    const path = pipePath('production-receipt-commit-deadline');
    const errors: string[] = [];
    const daemon = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      eventValidationTimeoutMs: 100,
      productionEventDeadlineMs: 30,
      onError: (code) => errors.push(code),
    });
    servers.push(daemon);
    let durableReceipts = 0;
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: (_event, commitFence) => {
        const blockedUntil = performance.now() + 60;
        while (performance.now() < blockedUntil) {
          // Model synchronous SQLite work that reaches its in-transaction fence after expiry.
        }
        if (!commitFence()) throw new Error('deadline fence closed');
        durableReceipts += 1;
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    }));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    const productionGateId = 'gate_565656565656';
    expect(await daemon.deliverGate(RUN_ID, productionGateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => raw.messages.some(
      (message) => message.type === 'notify' && message.gate_id === productionGateId,
    ));
    raw.socket.write(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: probe.connection_epoch,
      gate_id: productionGateId,
      ack_budget_ms: 5_000,
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    }));
    await waitFor(() => errors.includes('delivery_event_expired'));
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(durableReceipts).toBe(0);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === productionGateId,
    )).toHaveLength(0);
    raw.socket.destroy();
  });

  it('rejects a receipt whose absolute monotonic budget expires before socket dispatch', async () => {
    const path = pipePath('production-receipt-transit-deadline');
    const errors: string[] = [];
    const daemon = new ChannelPipeServer({
      orca: new FakeOrca(),
      pipePath: path,
      probeDelaysMs: [15, 30],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      productionEventDeadlineMs: 500,
      onError: (code) => errors.push(code),
    });
    servers.push(daemon);
    let durableReceipts = 0;
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: () => { durableReceipts += 1; },
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    }));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    const gateId = 'gate_cdcdcdcdcdcd';
    expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => raw.messages.some(
      (message) => message.type === 'notify' && message.gate_id === gateId,
    ));
    raw.socket.write(encodeChannelFrame({
      version: CHANNEL_PROTOCOL_VERSION,
      type: 'receipt',
      connection_epoch: probe.connection_epoch,
      gate_id: gateId,
      ack_budget_ms: 5_000,
      ack_deadline_ns: (process.hrtime.bigint() + 20_000_000n).toString(),
    }));
    const blockedUntil = performance.now() + 50;
    while (performance.now() < blockedUntil) {
      // Keep the shared event loop busy so the daemon receives this already at/after its deadline.
    }

    await waitFor(() => errors.includes('delivery_event_expired'));
    await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    expect(durableReceipts).toBe(0);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === gateId,
    )).toHaveLength(0);
    raw.socket.destroy();
  });

  it('treats exact monotonic wire-deadline equality as expired', async () => {
    const path = pipePath('production-receipt-deadline-equality');
    const errors: string[] = [];
    const daemon = server(path, new FakeOrca(), errors);
    let durableReceipts = 0;
    daemon.setProductionDeliveryHandlers({
      attempted: () => undefined,
      receipted: () => { durableReceipts += 1; },
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
    }));
    await waitFor(() => daemon.listConnections()[0]?.verified === true);

    const gateId = 'gate_dededededede';
    expect(await daemon.deliverGate(RUN_ID, gateId)).toMatchObject({ kind: 'sent' });
    await waitFor(() => raw.messages.some(
      (message) => message.type === 'notify' && message.gate_id === gateId,
    ));
    const exactDeadlineNs = process.hrtime.bigint() + 1_000_000_000n;
    const monotonicSpy = vi.spyOn(process.hrtime, 'bigint').mockReturnValue(exactDeadlineNs);
    try {
      raw.socket.write(encodeChannelFrame({
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt',
        connection_epoch: probe.connection_epoch,
        gate_id: gateId,
        ack_budget_ms: 5_000,
        ack_deadline_ns: exactDeadlineNs.toString(),
      }));
      await waitFor(() => errors.includes('delivery_event_expired'));
      await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    } finally {
      monotonicSpy.mockRestore();
    }
    expect(durableReceipts).toBe(0);
    expect(raw.messages.filter(
      (message) => message.type === 'receipt_ack' && message.gate_id === gateId,
    )).toHaveLength(0);
    raw.socket.destroy();
  });

  it('times a queued Adapter receipt monotonically and recalibrates after reconnect', async () => {
    const path = pipePath('adapter-receipt-budget-reconnect');
    const daemon = server(path);
    await daemon.start();
    const notifications: string[] = [];
    const receiptFrames: Array<{
      readonly gateId: string;
      readonly budgetMs: number;
      readonly deadlineNs: string;
    }> = [];
    const adapterErrors: string[] = [];
    let blockFirstAttempt = true;
    let client!: ChannelAdapterClient;
    client = new ChannelAdapterClient({
      identity: identity(),
      notificationWriter: {
        notifyGate: async (gateId) => { notifications.push(gateId); },
      },
      pipePath: path,
      reconnectDelaysMs: [10],
      receiptAckTimeoutMs: 50,
      writeTimeoutMs: 500,
      shutdownTimeoutMs: 500,
      onError: (code) => adapterErrors.push(code),
      writeFrame: (socket, frame) => {
        const message = JSON.parse(frame.toString('utf8')) as {
          readonly type?: unknown;
          readonly gate_id?: unknown;
          readonly ack_budget_ms?: unknown;
          readonly ack_deadline_ns?: unknown;
        };
        socket.write(frame);
        if (message.type === 'attempted' && blockFirstAttempt) {
          blockFirstAttempt = false;
          return false;
        }
        if (
          message.type === 'receipt' &&
          typeof message.gate_id === 'string' &&
          typeof message.ack_budget_ms === 'number' &&
          typeof message.ack_deadline_ns === 'string'
        ) {
          receiptFrames.push({
            gateId: message.gate_id,
            budgetMs: message.ack_budget_ms,
            deadlineNs: message.ack_deadline_ns,
          });
        }
        return true;
      },
    });
    adapters.push(client);
    client.start();
    await waitFor(() => notifications.length === 1 && client.getResourceSnapshot().writeTimer === 1);
    const firstGateId = notifications[0]!;
    const firstEpoch = client.getResourceSnapshot().epoch;

    // Neither a backwards nor forwards wall-clock jump can extend the fixed timer-start budget.
    let wallForward = false;
    const wallSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      wallForward = !wallForward;
      return wallForward ? 9_000_000_000_000 : -9_000_000_000_000;
    });
    let firstResult: string;
    try {
      firstResult = await client.reportReceipt(firstGateId).then(
        () => 'accepted',
        (error: unknown) => error instanceof Error ? error.message : 'unknown',
      );
    } finally {
      wallSpy.mockRestore();
    }
    expect(firstResult).toBe('receipt_timeout');
    expect(receiptFrames.filter((frame) => frame.gateId === firstGateId)).toHaveLength(0);

    await waitFor(() => (
      notifications.length >= 2 &&
      client.getResourceSnapshot().epoch !== null &&
      client.getResourceSnapshot().epoch !== firstEpoch
    ));
    const secondGateId = notifications.at(-1)!;
    await expect(client.reportReceipt(secondGateId)).resolves.toBe('accepted');
    const secondFrame = receiptFrames.find((frame) => frame.gateId === secondGateId)!;
    expect(secondFrame.budgetMs).toBeGreaterThan(0);
    expect(secondFrame.budgetMs).toBeLessThan(50);
    expect(secondFrame.deadlineNs).toMatch(/^[1-9][0-9]{0,29}$/);
    expect(daemon.listConnections()[0]?.verified).toBe(true);
    expect(adapterErrors).not.toContain('wrong_receipt_ack');
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
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
        ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
      }),
      encodeChannelFrame({
        version: CHANNEL_PROTOCOL_VERSION,
        type: 'receipt',
        connection_epoch: coalescedNotify.connection_epoch,
        gate_id: coalescedNotify.gate_id,
        ack_budget_ms: 5_000,
        ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
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
      ack_deadline_ns: (process.hrtime.bigint() + 5_000_000_000n).toString(),
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

    first.quiesce();
    expect(first.getResourceSnapshot()).toMatchObject({ listening: true, sockets: 0, timers: 0 });
    await expect(second.start()).rejects.toThrowError('pipe_in_use');

    await first.stop();
    expect(first.getResourceSnapshot()).toEqual({
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
      productionEventPermits: 0,
      productionEventsActive: 0,
      queuedProductionEvents: 0,
      readyProductionConnections: 0,
      pendingInboundMessages: 0,
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
