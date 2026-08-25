import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GateChannelDeliveryEngine,
  type GateChannelDeliveryErrorCode,
  type GateChannelDeliveryTransport,
} from '../src/channel/delivery.js';
import type {
  ChannelDeliverySendResult,
  ChannelProductionDeliveryEvent,
} from '../src/channel/pipe-server.js';
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import type { GateChannelDelivery, GateSnapshot } from '../src/gate/resolution-types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const GATE_ID = 'gate_aaaaaaaaaaaa';
const RUN_ID = 'run_delivery';
const TASK_ID = 'task_delivery';
const GATE = gateKey(GATE_ID);
const RUN = runKey(RUN_ID);
const TASK = taskKey(TASK_ID);
const AT = '2026-08-24T10:00:00.000Z';
const RESOLVED_AT = '2026-08-24T10:00:01.000Z';
const START = '2026-08-24T10:00:02.000Z';
const REQUEST = '11111111-1111-4111-8111-111111111111';

const pending: GateSnapshot = {
  gateId: GATE_ID,
  runId: RUN_ID,
  taskId: TASK_ID,
  options: ['현행 유지', '변경'],
  status: 'pending',
  resolution: null,
  resolvedAt: null,
};

const resolved: GateSnapshot = {
  ...pending,
  status: 'resolved',
  resolution: '현행 유지',
  resolvedAt: RESOLVED_AT,
};

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-channel-engine-'));
  path = join(dir, 'state.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function resolveD2(store: SqliteDigestStore): void {
  store.insertGateMetadata({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    dispatchKey: dispatchKey('ctx_delivery'),
    askMessageId: 'msg_delivery',
    questionThreadId: 'thread_delivery',
    options: [
      { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '변경한다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성' },
    impact: '후속 방향',
    registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: GATE,
    runKey: RUN,
    channelId: 'C0AGENTRUNS',
    threadTs: '1787554800.000001',
    messageTs: '1787554800.000002',
    renderFingerprint: 'fp',
    at: AT,
  });
  store.saveGateLocalObservation({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    status: 'pending',
    resolution: null,
    resolvedAt: null,
    metadataState: 'matched',
    mappingState: 'matched',
    observedAt: AT,
  });
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM',
    ownerUserId: 'U0OWNER',
    apiAppId: 'A0APP',
    channelId: 'C0AGENTRUNS',
    threadTs: '1787554800.000001',
    messageTs: '1787554800.000002',
    blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'),
    actionValue: 'keep',
    retryRequestId: REQUEST,
    at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  if (store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT) === null) {
    throw new Error('ACK failed');
  }
  const lease = store.acquireGateResolutionLease(
    GATE,
    't.d2-resolver',
    AT,
    '2026-08-24T10:01:00.000Z',
  );
  if (lease.kind !== 'acquired') throw new Error(`D2 lease failed: ${lease.kind}`);
  const preRead = store.updateGateResolution(GATE, lease.intent.revision, 't.d2-resolver', {
    lifecycle: 'pre_read', preRead: pending, at: AT,
  });
  if (preRead === null) throw new Error('pre-read failed');
  const resolving = store.updateGateResolution(GATE, preRead.revision, 't.d2-resolver', {
    lifecycle: 'resolving', at: AT,
  });
  if (resolving === null) throw new Error('resolving failed');
  const postRead = store.updateGateResolution(GATE, resolving.revision, 't.d2-resolver', {
    lifecycle: 'post_read',
    resolveResult: {
      gate: resolved,
      mutation: { requestId: REQUEST, replayed: false },
    },
    at: AT,
  });
  if (postRead === null) throw new Error('post-read failed');
  const terminal = store.updateGateResolution(GATE, postRead.revision, 't.d2-resolver', {
    lifecycle: 'resolved', postRead: resolved, at: AT,
  });
  if (terminal?.lifecycle !== 'resolved') throw new Error('terminal resolution failed');
}

function resolveAdditionalD2(
  store: SqliteDigestStore,
  input: {
    gateId: string;
    taskId: string;
    dispatchId: string;
    requestId: string;
    messageSuffix: string;
  },
): GateSnapshot {
  const gate = gateKey(input.gateId);
  const task = taskKey(input.taskId);
  const before: GateSnapshot = {
    ...pending, gateId: input.gateId, taskId: input.taskId,
  };
  const after: GateSnapshot = {
    ...before, status: 'resolved', resolution: '현행 유지', resolvedAt: RESOLVED_AT,
  };
  store.insertGateMetadata({
    gateKey: gate, runKey: RUN, taskKey: task, dispatchKey: dispatchKey(input.dispatchId),
    askMessageId: `msg_${input.messageSuffix}`,
    questionThreadId: `thread_${input.messageSuffix}`,
    options: [
      { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '변경한다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성' },
    impact: '후속 방향', registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: gate, runKey: RUN, channelId: 'C0AGENTRUNS',
    threadTs: `1787554800.100${input.messageSuffix}`,
    messageTs: `1787554800.200${input.messageSuffix}`,
    renderFingerprint: `fp_${input.messageSuffix}`, at: AT,
  });
  store.saveGateLocalObservation({
    gateKey: gate, runKey: RUN, taskKey: task, status: 'pending', resolution: null,
    resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: AT,
  });
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: 'C0AGENTRUNS',
    threadTs: `1787554800.100${input.messageSuffix}`,
    messageTs: `1787554800.200${input.messageSuffix}`,
    blockId: gateBlockId(gate), actionId: gateActionId(gate, 'keep'), actionValue: 'keep',
    retryRequestId: input.requestId, at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`additional claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(gate, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('additional ACK failed');
  const owner = `t.d2-${input.messageSuffix}`;
  const lease = store.acquireGateResolutionLease(
    gate, owner, AT, '2026-08-24T10:01:00.000Z',
  );
  if (lease.kind !== 'acquired') throw new Error(`additional lease failed: ${lease.kind}`);
  const preRead = store.updateGateResolution(gate, lease.intent.revision, owner, {
    lifecycle: 'pre_read', preRead: before, at: AT,
  });
  if (preRead === null) throw new Error('additional pre-read failed');
  const resolving = store.updateGateResolution(gate, preRead.revision, owner, {
    lifecycle: 'resolving', at: AT,
  });
  if (resolving === null) throw new Error('additional resolving failed');
  const postRead = store.updateGateResolution(gate, resolving.revision, owner, {
    lifecycle: 'post_read',
    resolveResult: {
      gate: after, mutation: { requestId: input.requestId, replayed: false },
    },
    at: AT,
  });
  if (postRead === null) throw new Error('additional post-read failed');
  const terminal = store.updateGateResolution(gate, postRead.revision, owner, {
    lifecycle: 'resolved', postRead: after, at: AT,
  });
  if (terminal?.lifecycle !== 'resolved') throw new Error('additional terminal failed');
  return after;
}

class FakeOrca implements OrcaRunner {
  snapshot: GateSnapshot = resolved;
  fail = false;
  readonly calls: string[][] = [];

  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (this.fail) return Promise.reject(new Error('raw private Orca failure'));
    if (args.join(' ') !== `orchestration gate-list --run ${RUN_ID} --json`) {
      return Promise.reject(new Error('unexpected fake command'));
    }
    const gate = {
      id: this.snapshot.gateId,
      run_id: this.snapshot.runId,
      task_id: this.snapshot.taskId,
      question: '표시용 질문',
      options: JSON.stringify(this.snapshot.options),
      status: this.snapshot.status,
      resolution: this.snapshot.resolution,
      created_at: '2026-08-24T09:00:00.000Z',
      resolved_at: this.snapshot.resolvedAt,
    };
    return Promise.resolve(JSON.stringify({
      id: 'fake', ok: true, result: { runId: RUN_ID, gates: [gate], count: 1 },
    }));
  }
}

class HeldGateOrca implements OrcaRunner {
  private releaseResponse!: () => void;
  private readonly responseReleased = new Promise<void>((resolve) => {
    this.releaseResponse = resolve;
  });

  constructor(private readonly snapshots: readonly GateSnapshot[]) {}

  release(): void {
    this.releaseResponse();
  }

  run(_args: readonly string[]): Promise<string> {
    // Intentionally ignores AbortSignal to prove the engine's lifecycle bound and late-write fence.
    return this.responseReleased.then(() => JSON.stringify({
      id: 'held',
      ok: true,
      result: {
        runId: RUN_ID,
        gates: this.snapshots.map((snapshot) => ({
          id: snapshot.gateId,
          run_id: snapshot.runId,
          task_id: snapshot.taskId,
          question: '표시용 질문',
          options: JSON.stringify(snapshot.options),
          status: snapshot.status,
          resolution: snapshot.resolution,
          created_at: '2026-08-24T09:00:00.000Z',
          resolved_at: snapshot.resolvedAt,
        })),
        count: this.snapshots.length,
      },
    }));
  }
}

class FakeTransport implements GateChannelDeliveryTransport {
  result: ChannelDeliverySendResult = { kind: 'sent', epoch: 'epoch_test', generation: 1 };
  fail = false;
  readonly calls: { runId: string; gateId: string }[] = [];

  deliverGate(runId: string, gateId: string): Promise<ChannelDeliverySendResult> {
    this.calls.push({ runId, gateId });
    return this.fail
      ? Promise.reject(new Error('raw private transport failure'))
      : Promise.resolve(this.result);
  }
}

function clock(start = START): { now: () => Date; advance: (milliseconds: number) => void } {
  let milliseconds = Date.parse(start);
  return {
    now: () => new Date(milliseconds),
    advance: (amount) => { milliseconds += amount; },
  };
}

function callback(gateId = GATE_ID): ChannelProductionDeliveryEvent {
  return {
    gateId,
    runId: RUN_ID,
    consumerGeneration: 1,
    connectionEpoch: 'epoch_test',
  };
}

function testBaseline(delivery: GateChannelDelivery) {
  return {
    schemaVersion: 1 as const,
    sourceTaskId: delivery.taskKey.slice('task:'.length),
    sourceDispatchId: delivery.sourceDispatchId,
    candidates: [{
      taskId: delivery.taskKey.slice('task:'.length),
      status: 'completed',
      currentDispatchId: delivery.sourceDispatchId,
      dispatches: [{ dispatchId: delivery.sourceDispatchId, status: 'completed' }],
    }],
  };
}

function recordTestBaseline(
  store: SqliteDigestStore,
  delivery: GateChannelDelivery,
  at = START,
): void {
  const owner = 't.test-baseline';
  const lease = store.acquireGateChannelDeliveryLease(
    delivery.gateKey,
    owner,
    at,
    new Date(new Date(at).valueOf() + 60_000).toISOString(),
  );
  if (lease.kind !== 'acquired') throw new Error(`test baseline lease ${lease.kind}`);
  if (store.recordGateResumeBaseline(
    delivery.gateKey,
    lease.delivery.revision,
    owner,
    testBaseline(delivery),
    at,
  ) === null) throw new Error('test baseline record failed');
  if (!store.releaseGateChannelDeliveryLease(delivery.gateKey, owner, at)) {
    throw new Error('test baseline release failed');
  }
}

function engine(
  store: SqliteDigestStore,
  orca: OrcaRunner,
  transport: GateChannelDeliveryTransport,
  time: ReturnType<typeof clock>,
  errors: GateChannelDeliveryErrorCode[] = [],
  bounds: { concurrency?: number; reconcileDeadlineMs?: number } = {},
): GateChannelDeliveryEngine {
  const ensureBaseline = (
    delivery: GateChannelDelivery,
    owner: string,
  ): Promise<GateChannelDelivery | null> => {
    if (delivery.resumeBaselineState === 'recorded') return Promise.resolve(delivery);
    if (delivery.resumeBaselineState === 'unavailable') return Promise.resolve(delivery);
    return Promise.resolve(store.recordGateResumeBaseline(
      delivery.gateKey,
      delivery.revision,
      owner,
      testBaseline(delivery),
      time.now().toISOString(),
    ));
  };
  return new GateChannelDeliveryEngine({
    store,
    orca,
    transport,
    now: time.now,
    routeRetryMs: 1_000,
    receiptBackoffMs: 3_000,
    attemptDelaysMs: [1_000, 2_000],
    ...bounds,
    resume: { ensureBaseline, reconcile: () => Promise.resolve() },
    onError: (code) => errors.push(code),
  });
}

describe('durable Channel delivery engine', () => {
  it('keeps send, attempted, receipt, and exact Gate effect consumption distinct', async () => {
    const store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    const orca = new FakeOrca();
    const transport = new FakeTransport();
    const time = clock();
    const delivery = engine(store, orca, transport, time);

    await delivery.reconcile();
    expect(transport.calls).toEqual([{ runId: RUN_ID, gateId: GATE_ID }]);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'pending', attemptCount: 0, receiptedAt: null, consumedAt: null,
    });
    expect(() => delivery.recordReceipted({
      ...callback(), runId: 'run_wrong',
    })).toThrowError('delivery_token_mismatch');
    expect(store.findGateChannelDelivery(GATE)?.state).toBe('pending');

    time.advance(10);
    expect(delivery.recordAttempted(callback())).toMatchObject({
      state: 'attempted', attemptCount: 1,
      lastAttemptAt: '2026-08-24T10:00:02.010Z',
      nextAttemptAt: '2026-08-24T10:00:03.010Z',
      receiptedAt: null, consumedAt: null,
    });
    expect(orca.calls).toHaveLength(0);
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(1);
    time.advance(999);
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(1);
    time.advance(1);
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(2);
    expect(orca.calls).toHaveLength(0);

    time.advance(10);
    expect(delivery.recordReceipted(callback())).toMatchObject({
      state: 'receipted', consumedAt: null,
    });
    expect(orca.calls).toHaveLength(0);

    await delivery.reconcile();
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'consumed', consumedAt: time.now().toISOString(), nextAttemptAt: null,
    });
    expect(orca.calls).toHaveLength(1);
    expect(orca.calls[0]).toEqual([
      'orchestration', 'gate-list', '--run', RUN_ID, '--json',
    ]);
    expect(delivery.recordReceipted(callback())?.state).toBe('consumed');
    expect(delivery.recordAttempted(callback())?.state).toBe('consumed');
    store.close();
  });

  it('recovers a receipted row after restart before consuming the fresh exact effect', async () => {
    let store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    const time = clock();
    const first = engine(store, new FakeOrca(), new FakeTransport(), time);
    await first.reconcile();
    time.advance(10);
    first.recordAttempted(callback());
    time.advance(10);
    first.recordReceipted(callback());
    expect(store.findGateChannelDelivery(GATE)?.state).toBe('receipted');
    store.close();

    store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    const restartedOrca = new FakeOrca();
    const restartedTransport = new FakeTransport();
    await engine(store, restartedOrca, restartedTransport, time).reconcile();
    expect(store.findGateChannelDelivery(GATE)?.state).toBe('consumed');
    expect(restartedOrca.calls).toHaveLength(1);
    expect(restartedTransport.calls).toHaveLength(0);
    store.close();
  });

  it('fences overlapping reconciles with acquisition-specific leases', async () => {
    const store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    const time = clock();
    let release!: () => void;
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => { started = resolve; });
    const heldWrite = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    const transport: GateChannelDeliveryTransport = {
      deliverGate: async (_runId, gateId) => {
        calls.push(gateId);
        started();
        await heldWrite;
        return { kind: 'sent', epoch: 'epoch_test', generation: 1 };
      },
    };
    const delivery = engine(store, new FakeOrca(), transport, time);

    const first = delivery.reconcile();
    await writeStarted;
    const firstOwner = store.findGateChannelDelivery(GATE)?.leaseOwner;
    expect(firstOwner).toMatch(/^p\d+\./);
    await delivery.reconcile();
    expect(calls).toEqual([GATE_ID]);
    expect(store.findGateChannelDelivery(GATE)?.leaseOwner).toBe(firstOwner);

    release();
    await first;
    expect(store.findGateChannelDelivery(GATE)?.leaseOwner).toBeNull();
    expect(calls).toEqual([GATE_ID]);
    store.close();
  });

  it('owner abort promptly releases a hung delivery without reporting a deadline failure', async () => {
    const store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    let started!: () => void;
    const writeStarted = new Promise<void>((resolve) => { started = resolve; });
    const transport: GateChannelDeliveryTransport = {
      deliverGate: () => {
        started();
        return new Promise<ChannelDeliverySendResult>(() => undefined);
      },
    };
    const errors: GateChannelDeliveryErrorCode[] = [];
    const controller = new AbortController();
    const delivery = engine(store, new FakeOrca(), transport, clock(), errors, {
      reconcileDeadlineMs: 1_000,
    });
    const running = delivery.reconcile(controller.signal);
    await writeStarted;
    expect(store.findGateChannelDelivery(GATE)?.leaseOwner).toMatch(/^p\d+\./);

    const began = Date.now();
    controller.abort();
    await running;

    expect(Date.now() - began).toBeLessThan(500);
    expect(errors).toEqual([]);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'pending',
      leaseOwner: null,
      lastErrorCode: null,
    });
    store.close();
  });

  it('bounds a concurrent multi-row reconcile and fences late hung-Orca completions after close', async () => {
    let store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    const second = resolveAdditionalD2(store, {
      gateId: 'gate_bbbbbbbbbbbb', taskId: 'task_delivery_b', dispatchId: 'ctx_delivery_b',
      requestId: '22222222-2222-4222-8222-222222222222', messageSuffix: '003',
    });
    const third = resolveAdditionalD2(store, {
      gateId: 'gate_cccccccccccc', taskId: 'task_delivery_c', dispatchId: 'ctx_delivery_c',
      requestId: '33333333-3333-4333-8333-333333333333', messageSuffix: '004',
    });
    const gateKeys = [GATE, gateKey(second.gateId), gateKey(third.gateId)];
    const seeded = store.seedPendingGateChannelDeliveries(START, 1_000, () => true);
    expect(seeded).toMatchObject({
      kind: 'committed', deliveries: [{}, {}, {}],
    });
    if (seeded.kind !== 'committed') throw new Error('seed fenced');
    for (const delivery of seeded.deliveries) recordTestBaseline(store, delivery);
    for (const key of gateKeys) {
      expect(store.markGateChannelReceipted(key, START)?.state).toBe('receipted');
    }

    const heldOrca = new HeldGateOrca([resolved, second, third]);
    const transport = new FakeTransport();
    const errors: GateChannelDeliveryErrorCode[] = [];
    const startedAt = Date.now();
    await engine(store, heldOrca, transport, clock(), errors, {
      concurrency: 2,
      reconcileDeadlineMs: 40,
    }).reconcile();
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(errors).toEqual(['delivery_reconcile_deadline']);
    expect(transport.calls).toEqual([]);
    const beforeClose = gateKeys.map((key) => store.findGateChannelDelivery(key));
    expect(beforeClose.every((row) => row?.state === 'receipted' && row.leaseOwner === null)).toBe(true);
    expect(beforeClose.filter(
      (row) => row?.lastErrorCode === 'delivery_reconcile_deadline',
    )).toHaveLength(2);
    store.close();

    store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    heldOrca.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gateKeys.map((key) => store.findGateChannelDelivery(key))).toEqual(beforeClose);
    store.close();
  });

  it('does not consume a receipt while the exact Gate is pending and retries at slower pacing', async () => {
    const store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    const time = clock();
    const orca = new FakeOrca();
    orca.snapshot = pending;
    const transport = new FakeTransport();
    const delivery = engine(store, orca, transport, time);

    await delivery.reconcile();
    time.advance(10);
    expect(delivery.recordReceipted(callback())).toMatchObject({
      state: 'receipted', attemptCount: 1,
    });
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(2);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'receipted', consumedAt: null, lastErrorCode: 'gate_effect_pending',
    });
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(2);
    time.advance(3_000);
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(3);
    expect(store.findGateChannelDelivery(GATE)?.state).toBe('receipted');
    store.close();
  });

  it('persists bounded read/mismatch/route errors without leaking downstream text', async () => {
    const store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    const time = clock();
    const orca = new FakeOrca();
    const transport = new FakeTransport();
    const errors: GateChannelDeliveryErrorCode[] = [];
    const delivery = engine(store, orca, transport, time, errors);

    await delivery.reconcile();
    time.advance(10);
    delivery.recordReceipted(callback());
    orca.fail = true;
    await delivery.reconcile();
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'receipted', lastErrorCode: 'gate_effect_read_failed',
    });
    expect(errors).toEqual(['gate_effect_read_failed']);
    expect(JSON.stringify(store.findGateChannelDelivery(GATE))).not.toContain('raw private');

    time.advance(3_000);
    orca.fail = false;
    orca.snapshot = { ...resolved, resolution: '변경' };
    await delivery.reconcile();
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'receipted', lastErrorCode: 'gate_effect_mismatch', consumedAt: null,
    });
    expect(errors.at(-1)).toBe('gate_effect_mismatch');

    time.advance(3_000);
    orca.snapshot = pending;
    transport.result = { kind: 'pending', code: 'no_candidate' };
    await delivery.reconcile();
    expect(store.findGateChannelDelivery(GATE)?.lastErrorCode).toBe(
      'route_pending_no_candidate',
    );
    expect(errors.at(-1)).toBe('route_pending_no_candidate');
    store.close();
  });
});
