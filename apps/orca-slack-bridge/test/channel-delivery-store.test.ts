import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import type { GateSnapshot } from '../src/gate/resolution-types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import { SCHEMA_VERSION } from '../src/store/schema.js';
import { SchemaVersionError, SqliteDigestStore } from '../src/store/sqlite.js';

const GATE = gateKey('gate_delivery');
const RUN = runKey('run_delivery');
const TASK = taskKey('task_delivery');
const DISPATCH_ID = 'ctx_delivery';
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const AT = '2026-08-24T10:00:00.000Z';
const SEEDED_AT = '2026-08-24T10:00:02.000Z';
const ATTEMPTED_AT = '2026-08-24T10:00:03.000Z';
const RECEIPTED_AT = '2026-08-24T10:00:04.000Z';
const CONSUMED_AT = '2026-08-24T10:00:05.000Z';
const LEASE_EXPIRY = '2026-08-24T10:01:00.000Z';
const RESOLUTION_REQUEST = '11111111-1111-4111-8111-111111111111';
const DELIVERY_OWNER = 't.channel-delivery';
const PROJECTION_OWNER = 't.channel-projection';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-channel-delivery-'));
  path = join(dir, 'state.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pending: GateSnapshot = {
  gateId: 'gate_delivery',
  runId: 'run_delivery',
  taskId: 'task_delivery',
  options: ['현행 유지', '변경'],
  status: 'pending',
  resolution: null,
  resolvedAt: null,
};

const resolved: GateSnapshot = {
  ...pending,
  status: 'resolved',
  resolution: '현행 유지',
  resolvedAt: '2026-08-24T10:00:01.000Z',
};

function seedD2(store: SqliteDigestStore): void {
  store.insertGateMetadata({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    dispatchKey: dispatchKey(DISPATCH_ID),
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
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
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
}

function resolveD2(store: SqliteDigestStore): void {
  seedD2(store);
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM',
    ownerUserId: 'U0OWNER',
    apiAppId: 'A0APP',
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
    blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'),
    actionValue: 'keep',
    retryRequestId: RESOLUTION_REQUEST,
    at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('ACK failed');
  const lease = store.acquireGateResolutionLease(GATE, 't.d2-resolver', AT, LEASE_EXPIRY);
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
      mutation: { requestId: RESOLUTION_REQUEST, replayed: false },
    },
    at: AT,
  });
  if (postRead === null) throw new Error('post-read failed');
  const terminal = store.updateGateResolution(GATE, postRead.revision, 't.d2-resolver', {
    lifecycle: 'resolved', postRead: resolved, at: AT,
  });
  if (terminal?.lifecycle !== 'resolved') throw new Error('terminal resolution failed');
}

function deliverySchemaShape(dbPath: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      master: db.prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
          WHERE name LIKE 'gate_channel_delivery%'
          ORDER BY type, name`,
      ).all(),
      columns: db.prepare('PRAGMA table_xinfo(gate_channel_delivery)').all(),
      dueIndex: db.prepare('PRAGMA index_xinfo(gate_channel_delivery_due)').all(),
      runIndex: db.prepare('PRAGMA index_xinfo(gate_channel_delivery_run)').all(),
    };
  } finally {
    db.close();
  }
}

function seedDelivery(store: SqliteDigestStore) {
  const seeded = store.seedPendingGateChannelDeliveries(SEEDED_AT);
  expect(seeded).toHaveLength(1);
  return seeded[0]!;
}

describe('additive v11 Channel delivery schema', () => {
  it('makes fresh v11 exactly equal to populated v10→v11 without rewriting the v10 outbox', () => {
    const migratedPath = join(dir, 'migrated.db');
    const v11 = new SqliteDigestStore(migratedPath);
    resolveD2(v11);
    v11.close();

    const v10 = new DatabaseSync(migratedPath);
    const outboxBefore = v10.prepare('SELECT * FROM gate_resolution_outbox').get();
    const outboxDdlBefore = v10.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gate_resolution_outbox'",
    ).get();
    v10.exec('DROP TABLE gate_channel_delivery');
    v10.prepare('UPDATE schema_version SET version = 10 WHERE id = 1').run();
    v10.close();

    const migrated = new SqliteDigestStore(migratedPath);
    expect(migrated.findGateChannelDelivery(GATE)).toBeNull();
    migrated.close();

    const postMigration = new DatabaseSync(migratedPath, { readOnly: true });
    expect(postMigration.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({
      version: 11,
    });
    expect(postMigration.prepare('SELECT * FROM gate_resolution_outbox').get()).toEqual(outboxBefore);
    expect(postMigration.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gate_resolution_outbox'",
    ).get()).toEqual(outboxDdlBefore);
    postMigration.close();

    const freshPath = join(dir, 'fresh.db');
    new SqliteDigestStore(freshPath).close();
    expect(SCHEMA_VERSION).toBe(11);
    expect(deliverySchemaShape(migratedPath)).toEqual(deliverySchemaShape(freshPath));

    const lazy = new SqliteDigestStore(migratedPath);
    expect(seedDelivery(lazy)).toMatchObject({
      state: 'pending', revision: 0, attemptCount: 0,
      runKey: RUN, taskKey: TASK, sourceDispatchId: DISPATCH_ID,
    });
    expect(lazy.seedPendingGateChannelDeliveries(SEEDED_AT)).toEqual([]);
    expect(lazy.findGateResolutionOutbox(GATE)?.notificationState).toBe('pending');
    lazy.close();
  });

  it('fails closed on future schema instead of rewriting or downgrading it', () => {
    new SqliteDigestStore(path).close();
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE schema_version SET version = 12 WHERE id = 1').run();
    raw.close();
    expect(() => new SqliteDigestStore(path)).toThrow(SchemaVersionError);
  });

  it('clamps a regressed seed clock to persisted D2 evidence and reopens idempotently', () => {
    let store = new SqliteDigestStore(path);
    resolveD2(store);
    const rollbackAt = '2026-08-24T09:59:59.000Z';
    expect(store.seedPendingGateChannelDeliveries(rollbackAt)).toMatchObject([{
      gateKey: GATE,
      state: 'pending',
      createdAt: '2026-08-24T10:00:01.000Z',
      updatedAt: '2026-08-24T10:00:01.000Z',
      nextAttemptAt: '2026-08-24T10:00:01.000Z',
    }]);
    expect(store.seedPendingGateChannelDeliveries(rollbackAt)).toEqual([]);
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toEqual([]);
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'pending', createdAt: '2026-08-24T10:00:01.000Z',
      nextAttemptAt: '2026-08-24T10:00:01.000Z',
    });
    expect(store.seedPendingGateChannelDeliveries(rollbackAt)).toEqual([]);
    store.close();
  });

  it('rejects malformed lifecycle, cross-table identity, lease, and unknown objects on reopen', () => {
    const corruptions = [
      {
        name: 'cross-table',
        sql: "UPDATE gate_channel_delivery SET run_key = 'run:wrong'",
      },
      {
        name: 'lifecycle',
        sql: "UPDATE gate_channel_delivery SET state = 'consumed'",
      },
      {
        name: 'lease',
        sql: "UPDATE gate_channel_delivery SET lease_owner = 't.corrupt', lease_expires_at = NULL",
      },
      {
        name: 'seed-clock',
        sql: `UPDATE gate_channel_delivery
                SET created_at = '2026-08-24T09:59:59.000Z',
                    updated_at = '2026-08-24T09:59:59.000Z',
                    next_attempt_at = '2026-08-24T09:59:59.000Z'`,
      },
      {
        name: 'unknown-trigger',
        sql: `CREATE TRIGGER gate_channel_delivery_unknown AFTER UPDATE ON gate_channel_delivery
              BEGIN SELECT 1; END`,
      },
    ];
    for (const corruption of corruptions) {
      const corruptPath = join(dir, `${corruption.name}.db`);
      const store = new SqliteDigestStore(corruptPath);
      resolveD2(store);
      seedDelivery(store);
      store.close();
      const raw = new DatabaseSync(corruptPath);
      raw.exec('PRAGMA ignore_check_constraints = ON');
      raw.exec(corruption.sql);
      raw.close();
      expect(() => new SqliteDigestStore(corruptPath)).toThrow();
    }
  });
});

describe('monotonic crash-safe Channel lifecycle', () => {
  it('recovers an expired lease without allowing a stale owner to release the replacement', () => {
    const store = new SqliteDigestStore(path);
    resolveD2(store);
    seedDelivery(store);
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.expired-owner',
      SEEDED_AT,
      '2026-08-24T10:00:03.000Z',
    )).toMatchObject({ kind: 'acquired' });
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.expired-owner',
      '2026-08-24T10:00:02.500Z',
      '2026-08-24T10:00:04.000Z',
    )).toEqual({ kind: 'busy', expiresAt: '2026-08-24T10:00:03.000Z' });

    const recovered = store.acquireGateChannelDeliveryLease(
      GATE,
      't.recovery-owner',
      '2026-08-24T10:00:04.000Z',
      LEASE_EXPIRY,
    );
    expect(recovered).toMatchObject({
      kind: 'acquired', delivery: { leaseOwner: 't.recovery-owner' },
    });
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.expired-owner',
      '2026-08-24T10:00:05.000Z',
    )).toBe(false);
    expect(store.findGateChannelDelivery(GATE)?.leaseOwner).toBe('t.recovery-owner');
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.recovery-owner',
      '2026-08-24T10:00:05.000Z',
    )).toBe(true);
    store.close();
  });

  it('keeps attempted/receipt/consumed distinct and atomically re-arms the D2 card generation', () => {
    const store = new SqliteDigestStore(path);
    resolveD2(store);
    seedDelivery(store);

    const firstOutbox = store.findGateResolutionOutbox(GATE)!;
    expect(store.acquireGateOutboxProjection(
      GATE, firstOutbox.revision, PROJECTION_OWNER, SEEDED_AT,
    )).toBe('acquired');
    expect(store.markGateOutboxProjected(
      GATE, firstOutbox.revision, 'seeded-card', PROJECTION_OWNER, SEEDED_AT,
    )).toBe(true);
    const projected = store.findGateResolutionOutbox(GATE)!;
    expect(projected.cardPending).toBe(false);

    const lease = store.acquireGateChannelDeliveryLease(
      GATE, DELIVERY_OWNER, SEEDED_AT, LEASE_EXPIRY,
    );
    if (lease.kind !== 'acquired') throw new Error(`delivery lease failed: ${lease.kind}`);
    const attempted = store.markGateChannelAttempted(
      GATE, ATTEMPTED_AT, '2026-08-24T10:00:08.000Z',
    );
    expect(attempted).toMatchObject({ state: 'attempted', attemptCount: 1, receiptedAt: null });
    expect(store.markGateOutboxProjected(
      GATE, projected.revision, 'stale-card', PROJECTION_OWNER, ATTEMPTED_AT,
    )).toBe(false);
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({ cardPending: true });

    const receipted = store.markGateChannelReceipted(GATE, RECEIPTED_AT);
    expect(receipted).toMatchObject({ state: 'receipted', consumedAt: null });
    expect(store.markGateChannelAttempted(
      GATE, RECEIPTED_AT, '2026-08-24T10:00:09.000Z',
    )).toMatchObject({ state: 'receipted', attemptCount: 1 });
    const receiptRevision = store.findGateChannelDelivery(GATE)!.revision;
    expect(store.markGateChannelReceipted(GATE, RECEIPTED_AT)?.revision).toBe(receiptRevision);

    store.releaseGateChannelDeliveryLease(GATE, DELIVERY_OWNER, RECEIPTED_AT);
    const effectLease = store.acquireGateChannelDeliveryLease(
      GATE, DELIVERY_OWNER, RECEIPTED_AT, LEASE_EXPIRY,
    );
    if (effectLease.kind !== 'acquired') throw new Error(`effect lease failed: ${effectLease.kind}`);
    const consumed = store.consumeGateChannelDelivery(
      GATE, effectLease.delivery.revision, DELIVERY_OWNER, resolved, CONSUMED_AT,
    );
    expect(consumed).toMatchObject({ kind: 'consumed', delivery: { state: 'consumed' } });
    expect(store.listDueGateChannelDeliveries('2026-08-24T11:00:00.000Z')).toEqual([]);
    expect(store.consumeGateChannelDelivery(
      GATE, effectLease.delivery.revision, DELIVERY_OWNER, resolved, CONSUMED_AT,
    )).toMatchObject({ kind: 'duplicate', delivery: { state: 'consumed' } });
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({ cardPending: true });
    store.close();

    const reopened = new SqliteDigestStore(path);
    expect(reopened.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'consumed', nextAttemptAt: null, leaseOwner: null,
    });
    reopened.close();
  });

  it('recovers receipted rows after restart and refuses mismatched fresh Gate evidence', () => {
    let store = new SqliteDigestStore(path);
    resolveD2(store);
    seedDelivery(store);
    expect(store.markGateChannelAttempted(
      GATE, ATTEMPTED_AT, '2026-08-24T10:00:08.000Z',
    )?.state).toBe('attempted');
    expect(store.markGateChannelReceipted(GATE, RECEIPTED_AT)?.state).toBe('receipted');
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.listDueGateChannelDeliveries(RECEIPTED_AT)).toHaveLength(1);
    const lease = store.acquireGateChannelDeliveryLease(
      GATE, DELIVERY_OWNER, RECEIPTED_AT, LEASE_EXPIRY,
    );
    if (lease.kind !== 'acquired') throw new Error(`restart lease failed: ${lease.kind}`);
    expect(store.consumeGateChannelDelivery(
      GATE,
      lease.delivery.revision,
      DELIVERY_OWNER,
      { ...resolved, resolution: '변경' },
      CONSUMED_AT,
    )).toEqual({ kind: 'mismatch' });
    const deferred = store.deferGateChannelDelivery(
      GATE,
      lease.delivery.revision,
      DELIVERY_OWNER,
      CONSUMED_AT,
      '2026-08-24T10:00:10.000Z',
      'gate_effect_mismatch',
    );
    expect(deferred).toMatchObject({
      state: 'receipted', consumedAt: null, lastErrorCode: 'gate_effect_mismatch',
    });
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'receipted', consumedAt: null,
    });
    store.close();
  });
});
