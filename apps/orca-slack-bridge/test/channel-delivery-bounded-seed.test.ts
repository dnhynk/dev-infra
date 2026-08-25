import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  GateChannelDeliveryEngine,
  type GateChannelDeliveryTransport,
} from '../src/channel/delivery.js';
import type { ChannelDeliverySendResult } from '../src/channel/pipe-server.js';
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import type { GateChannelDelivery, GateSnapshot } from '../src/gate/resolution-types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const BACKLOG_SIZE = 2_048;
const RUN_ID = 'run_bounded_seed';
const RUN = runKey(RUN_ID);
const CHANNEL = 'C0BOUNDEDSEED';
const AT = '2026-08-24T10:00:00.000Z';
const RESOLVED_AT = '2026-08-24T10:00:01.000Z';
const RECONCILE_AT = '2026-08-24T10:00:02.000Z';
const LEASE_EXPIRY = '2026-08-24T10:01:00.000Z';

type SqlValue = string | number | bigint | Uint8Array | null;
type SqlRow = Record<string, SqlValue>;

type Fixture = {
  readonly gateId: string;
  readonly gate: ReturnType<typeof gateKey>;
  readonly taskId: string;
  readonly task: ReturnType<typeof taskKey>;
  readonly dispatchId: string;
  readonly requestId: string;
  readonly threadTs: string;
  readonly messageTs: string;
};

function fixture(index: number): Fixture {
  const decimal = index.toString().padStart(4, '0');
  const timestamp = index.toString().padStart(6, '0');
  const gateId = `gate_seed_${decimal}`;
  const taskId = `task_seed_${decimal}`;
  return {
    gateId,
    gate: gateKey(gateId),
    taskId,
    task: taskKey(taskId),
    dispatchId: `ctx_seed_${decimal}`,
    requestId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    threadTs: `1787554800.${timestamp}`,
    messageTs: `1787554801.${timestamp}`,
  };
}

function snapshots(input: Fixture): { readonly pending: GateSnapshot; readonly resolved: GateSnapshot } {
  const pending: GateSnapshot = {
    gateId: input.gateId,
    runId: RUN_ID,
    taskId: input.taskId,
    options: ['현행 유지', '변경'],
    status: 'pending',
    resolution: null,
    resolvedAt: null,
  };
  return {
    pending,
    resolved: {
      ...pending,
      status: 'resolved',
      resolution: '현행 유지',
      resolvedAt: RESOLVED_AT,
    },
  };
}

function resolveCanonicalD2(store: SqliteDigestStore): void {
  const input = fixture(0);
  const evidence = snapshots(input);
  store.insertGateMetadata({
    gateKey: input.gate,
    runKey: RUN,
    taskKey: input.task,
    dispatchKey: dispatchKey(input.dispatchId),
    askMessageId: `msg_${input.gateId}`,
    questionThreadId: `thread_${input.gateId}`,
    options: [
      { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '변경한다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성' },
    impact: '후속 방향',
    registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: input.gate,
    runKey: RUN,
    channelId: CHANNEL,
    threadTs: input.threadTs,
    messageTs: input.messageTs,
    renderFingerprint: 'fp_seed_0000',
    at: AT,
  });
  store.saveGateLocalObservation({
    gateKey: input.gate,
    runKey: RUN,
    taskKey: input.task,
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
    channelId: CHANNEL,
    threadTs: input.threadTs,
    messageTs: input.messageTs,
    blockId: gateBlockId(input.gate),
    actionId: gateActionId(input.gate, 'keep'),
    actionValue: 'keep',
    retryRequestId: input.requestId,
    at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`canonical claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(input.gate, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('canonical ACK failed');
  const lease = store.acquireGateResolutionLease(input.gate, 't.seed-resolver', AT, LEASE_EXPIRY);
  if (lease.kind !== 'acquired') throw new Error(`canonical lease failed: ${lease.kind}`);
  const preRead = store.updateGateResolution(input.gate, lease.intent.revision, 't.seed-resolver', {
    lifecycle: 'pre_read', preRead: evidence.pending, at: AT,
  });
  if (preRead === null) throw new Error('canonical pre-read failed');
  const resolving = store.updateGateResolution(input.gate, preRead.revision, 't.seed-resolver', {
    lifecycle: 'resolving', at: AT,
  });
  if (resolving === null) throw new Error('canonical resolving failed');
  const postRead = store.updateGateResolution(input.gate, resolving.revision, 't.seed-resolver', {
    lifecycle: 'post_read',
    resolveResult: {
      gate: evidence.resolved,
      mutation: { requestId: input.requestId, replayed: false },
    },
    at: AT,
  });
  if (postRead === null) throw new Error('canonical post-read failed');
  const terminal = store.updateGateResolution(input.gate, postRead.revision, 't.seed-resolver', {
    lifecycle: 'resolved', postRead: evidence.resolved, at: AT,
  });
  if (terminal?.lifecycle !== 'resolved') throw new Error('canonical resolution failed');
}

function sqlRow(db: DatabaseSync, table: string, gate: string): SqlRow {
  const row = db.prepare(`SELECT * FROM ${table} WHERE gate_key = ?`).get(gate) as
    | SqlRow
    | undefined;
  if (row === undefined) throw new Error(`missing canonical ${table}`);
  return row;
}

function insertClone(
  db: DatabaseSync,
  table: string,
  source: SqlRow,
  changes: SqlRow,
  omitted: readonly string[] = [],
): void {
  const row = { ...source, ...changes };
  const columns = Object.keys(row).filter((column) => !omitted.includes(column));
  db.prepare(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  ).run(...columns.map((column) => row[column]!));
}

function rewriteSnapshot(raw: SqlValue, input: Fixture): string {
  if (typeof raw !== 'string') throw new Error('canonical snapshot is absent');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.gateId = input.gateId;
  parsed.runId = RUN_ID;
  parsed.taskId = input.taskId;
  return JSON.stringify(parsed);
}

function rewriteResolveResult(raw: SqlValue, input: Fixture): string {
  if (typeof raw !== 'string') throw new Error('canonical resolve result is absent');
  const parsed = JSON.parse(raw) as {
    gate: Record<string, unknown>;
    mutation: Record<string, unknown>;
  };
  parsed.gate.gateId = input.gateId;
  parsed.gate.runId = RUN_ID;
  parsed.gate.taskId = input.taskId;
  parsed.mutation.requestId = input.requestId;
  return JSON.stringify(parsed);
}

/** Build once via the public D2 state machine, then clone the same valid evidence in one raw tx. */
function createLegacyBacklog(path: string): void {
  const canonical = new SqliteDigestStore(path);
  resolveCanonicalD2(canonical);
  canonical.close();

  const db = new DatabaseSync(path);
  const base = fixture(0);
  const metadata = sqlRow(db, 'gate_metadata', base.gate);
  const message = sqlRow(db, 'gate_message', base.gate);
  const observation = sqlRow(db, 'gate_local_observation', base.gate);
  const generation = sqlRow(db, 'gate_observation_generation', base.gate);
  const resolution = sqlRow(db, 'gate_resolution', base.gate);
  const outbox = sqlRow(db, 'gate_resolution_outbox', base.gate);
  const audit = sqlRow(db, 'gate_resolution_audit', base.gate);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 1; index < BACKLOG_SIZE; index += 1) {
      const input = fixture(index);
      insertClone(db, 'gate_metadata', metadata, {
        gate_key: input.gate,
        task_key: input.task,
        dispatch_key: dispatchKey(input.dispatchId),
        ask_message_id: `msg_${input.gateId}`,
        question_thread_id: `thread_${input.gateId}`,
      });
      insertClone(db, 'gate_message', message, {
        gate_key: input.gate,
        thread_ts: input.threadTs,
        message_ts: input.messageTs,
        render_fingerprint: `fp_seed_${index.toString().padStart(4, '0')}`,
      });
      insertClone(db, 'gate_local_observation', observation, {
        gate_key: input.gate,
        task_key: input.task,
      });
      insertClone(db, 'gate_observation_generation', generation, { gate_key: input.gate });
      insertClone(db, 'gate_resolution', resolution, {
        gate_key: input.gate,
        retry_request_id: input.requestId,
        ask_message_id: `msg_${input.gateId}`,
        question_thread_id: `thread_${input.gateId}`,
        dispatch_id: input.dispatchId,
        task_id: input.taskId,
        thread_ts: input.threadTs,
        message_ts: input.messageTs,
        block_id: gateBlockId(input.gate),
        action_id: gateActionId(input.gate, 'keep'),
        pre_read_json: rewriteSnapshot(resolution.pre_read_json!, input),
        resolve_result_json: rewriteResolveResult(resolution.resolve_result_json!, input),
        post_read_json: rewriteSnapshot(resolution.post_read_json!, input),
      });
      insertClone(db, 'gate_resolution_outbox', outbox, { gate_key: input.gate });
      insertClone(db, 'gate_resolution_audit', audit, { gate_key: input.gate }, ['id']);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

function rawRows(path: string, sql: string): readonly Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function rawRow(path: string, sql: string, ...params: readonly SqlValue[]): Record<string, unknown> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    if (row === undefined) throw new Error(`query returned no row: ${sql}`);
    return row;
  } finally {
    db.close();
  }
}

class RecordingTransport implements GateChannelDeliveryTransport {
  readonly calls: { readonly runId: string; readonly gateId: string }[] = [];
  readonly result: ChannelDeliverySendResult = {
    kind: 'sent', epoch: 'epoch_bounded_seed', generation: 1,
  };

  deliverGate(runId: string, gateId: string): Promise<ChannelDeliverySendResult> {
    this.calls.push({ runId, gateId });
    return Promise.resolve(this.result);
  }
}

const unusedOrca: OrcaRunner = {
  run: () => Promise.reject(new Error('pending delivery must not reread Orca')),
};

function boundedEngine(
  store: SqliteDigestStore,
  transport: RecordingTransport,
  batchLimit: number,
): GateChannelDeliveryEngine {
  const ensureBaseline = (
    delivery: GateChannelDelivery,
    owner: string,
  ): Promise<GateChannelDelivery | null> => {
    if (delivery.resumeBaselineState === 'recorded') return Promise.resolve(delivery);
    return Promise.resolve(store.recordGateResumeBaseline(
      delivery.gateKey, delivery.revision, owner, {
      schemaVersion: 1,
      sourceTaskId: delivery.taskKey.slice('task:'.length),
      sourceDispatchId: delivery.sourceDispatchId,
      candidates: [{
        taskId: delivery.taskKey.slice('task:'.length),
        status: 'completed',
        currentDispatchId: delivery.sourceDispatchId,
        dispatches: [{ dispatchId: delivery.sourceDispatchId, status: 'completed' }],
      }],
      }, RECONCILE_AT,
    ));
  };
  return new GateChannelDeliveryEngine({
    store,
    orca: unusedOrca,
    transport,
    now: () => new Date(RECONCILE_AT),
    leaseMs: 10_000,
    routeRetryMs: 1_000,
    receiptBackoffMs: 1_000,
    attemptDelaysMs: [1_000],
    batchLimit,
    concurrency: 8,
    reconcileDeadlineMs: 2_000,
    resume: { ensureBaseline, reconcile: () => Promise.resolve() },
  });
}

let dir: string;
let templatePath: string;
let copyIndex = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-bounded-channel-seed-'));
  templatePath = join(dir, 'template.db');
  createLegacyBacklog(templatePath);
}, 30_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function databaseCopy(): string {
  copyIndex += 1;
  const path = join(dir, `case-${copyIndex}.db`);
  copyFileSync(templatePath, path);
  return path;
}

describe('bounded lazy Channel seed', () => {
  it('pages 2,048 eligible legacy outboxes, resumes after restart, and stays idempotent', () => {
    const path = databaseCopy();
    const d2Before = rawRows(path, 'SELECT * FROM gate_resolution ORDER BY gate_key');
    const untouchedGate = fixture(BACKLOG_SIZE - 1).gate;
    const untouchedOutbox = rawRow(
      path,
      'SELECT * FROM gate_resolution_outbox WHERE gate_key = ?',
      untouchedGate,
    );
    let checks = 0;
    let store = new SqliteDigestStore(path);
    const first = store.seedPendingGateChannelDeliveries(RECONCILE_AT, 17, () => {
      checks += 1;
      return true;
    });
    expect(first).toMatchObject({ kind: 'committed' });
    if (first.kind !== 'committed') throw new Error('first seed unexpectedly fenced');
    expect(first.deliveries).toHaveLength(17);
    expect(checks).toBe(37);
    expect(first.deliveries.map((row) => row.gateKey)).toEqual(
      Array.from({ length: 17 }, (_, index) => fixture(index).gate),
    );
    const firstDelivery = store.findGateChannelDelivery(fixture(0).gate);
    store.close();

    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 17 });
    expect(rawRow(
      path,
      'SELECT * FROM gate_resolution_outbox WHERE gate_key = ?',
      untouchedGate,
    )).toEqual(untouchedOutbox);

    store = new SqliteDigestStore(path);
    let total = 17;
    while (total < BACKLOG_SIZE) {
      const limit = Math.min(1_000, BACKLOG_SIZE - total);
      const page = store.seedPendingGateChannelDeliveries(RECONCILE_AT, limit, () => true);
      if (page.kind !== 'committed') throw new Error('restart seed unexpectedly fenced');
      expect(page.deliveries.length).toBeLessThanOrEqual(limit);
      total += page.deliveries.length;
    }
    expect(total).toBe(BACKLOG_SIZE);
    expect(store.seedPendingGateChannelDeliveries(RECONCILE_AT, 1_000, () => true)).toEqual({
      kind: 'committed', deliveries: [],
    });
    expect(store.findGateChannelDelivery(fixture(0).gate)).toEqual(firstDelivery);
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.seedPendingGateChannelDeliveries(RECONCILE_AT, 1_000, () => true)).toEqual({
      kind: 'committed', deliveries: [],
    });
    store.close();
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({
      count: BACKLOG_SIZE,
    });
    expect(rawRows(path, 'SELECT * FROM gate_resolution ORDER BY gate_key')).toEqual(d2Before);
  }, 30_000);

  it('rolls back the whole page and releases its writer for an already-open competing store', () => {
    const path = databaseCopy();
    const outboxesBefore = rawRows(path, 'SELECT * FROM gate_resolution_outbox ORDER BY gate_key');
    const store = new SqliteDigestStore(path);
    // Both connections exist before the first BEGIN IMMEDIATE. The second call below therefore
    // proves rollback released the writer lock; it is not progress obtained by reopening SQLite.
    const secondWriter = new SqliteDigestStore(path);
    let checks = 0;
    const result = store.seedPendingGateChannelDeliveries(RECONCILE_AT, 64, () => {
      checks += 1;
      return checks < 12;
    });
    expect(result).toEqual({ kind: 'fenced' });
    expect(checks).toBe(12);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 0 });
    expect(rawRows(path, 'SELECT * FROM gate_resolution_outbox ORDER BY gate_key'))
      .toEqual(outboxesBefore);

    const competingPage = secondWriter.seedPendingGateChannelDeliveries(
      RECONCILE_AT,
      9,
      () => true,
    );
    expect(competingPage).toMatchObject({ kind: 'committed' });
    if (competingPage.kind !== 'committed') throw new Error('competing seed unexpectedly fenced');
    expect(competingPage.deliveries.map((row) => row.gateKey)).toEqual(
      Array.from({ length: 9 }, (_, index) => fixture(index).gate),
    );
    secondWriter.close();
    store.close();

    const restarted = new SqliteDigestStore(path);
    const retry = restarted.seedPendingGateChannelDeliveries(RECONCILE_AT, 9, () => true);
    expect(retry).toMatchObject({ kind: 'committed' });
    if (retry.kind !== 'committed') throw new Error('retry seed unexpectedly fenced');
    expect(retry.deliveries.map((row) => row.gateKey)).toEqual(
      Array.from({ length: 9 }, (_, index) => fixture(index + 9).gate),
    );
    restarted.close();
  }, 30_000);

  it('releases every committed page for a second live writer without duplicate selection', () => {
    const path = databaseCopy();
    const firstWriter = new SqliteDigestStore(path);
    const secondWriter = new SqliteDigestStore(path);
    const first = firstWriter.seedPendingGateChannelDeliveries(RECONCILE_AT, 8, () => true);
    const second = secondWriter.seedPendingGateChannelDeliveries(RECONCILE_AT, 8, () => true);
    if (first.kind !== 'committed' || second.kind !== 'committed') {
      throw new Error('live writer page unexpectedly fenced');
    }
    expect(first.deliveries.map((row) => row.gateKey)).toEqual(
      Array.from({ length: 8 }, (_, index) => fixture(index).gate),
    );
    expect(second.deliveries.map((row) => row.gateKey)).toEqual(
      Array.from({ length: 8 }, (_, index) => fixture(index + 8).gate),
    );
    expect(new Set([...first.deliveries, ...second.deliveries].map((row) => row.gateKey)).size)
      .toBe(16);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 16 });
    secondWriter.close();
    firstWriter.close();
  }, 30_000);

  it('aborts a production reconcile whose monotonic deadline closes during synchronous seed', async () => {
    const path = databaseCopy();
    const outboxesBefore = rawRows(path, 'SELECT * FROM gate_resolution_outbox ORDER BY gate_key');
    let store = new SqliteDigestStore(path);
    const transport = new RecordingTransport();
    const errors: string[] = [];
    let monotonicCalls = 0;
    let abortCalls = 0;
    let capturedSignalAborted = false;
    const NativeAbortController = globalThis.AbortController;
    class RecordingAbortController extends NativeAbortController {
      override abort(reason?: unknown): void {
        abortCalls += 1;
        super.abort(reason);
        capturedSignalAborted = this.signal.aborted;
      }
    }
    vi.stubGlobal('AbortController', RecordingAbortController);
    try {
      const delivery = new GateChannelDeliveryEngine({
        store,
        orca: unusedOrca,
        transport,
        now: () => new Date(RECONCILE_AT),
        // Call 1 establishes the engine deadline. Call 12 is reached inside the store's
        // synchronous row loop, after several provisional INSERTs but before COMMIT.
        monotonicNow: () => {
          monotonicCalls += 1;
          return monotonicCalls < 12 ? 0 : 101;
        },
        leaseMs: 10_000,
        routeRetryMs: 1_000,
        receiptBackoffMs: 1_000,
        attemptDelaysMs: [1_000],
        batchLimit: 64,
        concurrency: 8,
        reconcileDeadlineMs: 100,
        onError: (code) => errors.push(code),
      });
      await delivery.reconcile();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(monotonicCalls).toBe(12);
    expect(abortCalls).toBe(1);
    expect(capturedSignalAborted).toBe(true);
    expect(errors).toEqual(['delivery_reconcile_deadline']);
    expect(transport.calls).toEqual([]);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 0 });
    expect(rawRows(path, 'SELECT * FROM gate_resolution_outbox ORDER BY gate_key'))
      .toEqual(outboxesBefore);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 0 });
    store.close();

    store = new SqliteDigestStore(path);
    const restartedTransport = new RecordingTransport();
    await boundedEngine(store, restartedTransport, 8).reconcile();
    expect(restartedTransport.calls).toHaveLength(4);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 4 });
    store.close();
  }, 30_000);

  it('keeps seed inserts plus send candidates within one batch limit', async () => {
    const path = databaseCopy();
    const store = new SqliteDigestStore(path);
    const seed = vi.spyOn(store, 'seedPendingGateChannelDeliveries');
    const transport = new RecordingTransport();
    const delivery = boundedEngine(store, transport, 8);

    await delivery.reconcile();

    expect(seed).toHaveBeenCalledTimes(1);
    expect(seed.mock.calls[0]?.[1]).toBe(4);
    const seeded = seed.mock.results[0]?.value;
    if (seeded?.kind !== 'committed') throw new Error('engine seed unexpectedly fenced');
    expect(seeded.deliveries).toHaveLength(4);
    expect(transport.calls).toHaveLength(4);
    expect(seeded.deliveries.length + transport.calls.length).toBeLessThanOrEqual(8);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 4 });
    store.close();
  }, 30_000);

  it('alternates a single slot so neither backlog seeding nor due delivery starves across restart', async () => {
    const path = databaseCopy();
    let store = new SqliteDigestStore(path);
    let transport = new RecordingTransport();
    let delivery = boundedEngine(store, transport, 1);

    await delivery.reconcile();
    expect(transport.calls).toHaveLength(0);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 1 });
    await delivery.reconcile();
    expect(transport.calls.map((call) => call.gateId)).toEqual([fixture(0).gateId]);
    await delivery.reconcile();
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 2 });
    await delivery.reconcile();
    expect(transport.calls.map((call) => call.gateId)).toEqual([
      fixture(0).gateId,
      fixture(1).gateId,
    ]);
    store.close();

    store = new SqliteDigestStore(path);
    transport = new RecordingTransport();
    delivery = boundedEngine(store, transport, 1);
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(0);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 3 });
    await delivery.reconcile();
    expect(transport.calls.map((call) => call.gateId)).toEqual([fixture(2).gateId]);
    expect(rawRow(path, 'SELECT COUNT(*) AS count FROM gate_channel_delivery')).toEqual({ count: 3 });
    store.close();
  }, 30_000);
});
