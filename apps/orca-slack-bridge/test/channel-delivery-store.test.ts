import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import { projectGateResolutionCard } from '../src/gate/resolution-project.js';
import type { GateChannelDelivery, GateSnapshot } from '../src/gate/resolution-types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type {
  PostedMessage,
  PostMessageInput,
  SlackPoster,
  UpdateMessageInput,
} from '../src/slack/post.js';
import { SCHEMA_VERSION } from '../src/store/schema.js';
import { SchemaVersionError, SqliteDigestStore } from '../src/store/sqlite.js';
import {
  downgradeGateMetadataToV13,
  dropTerminalPromptTables,
} from './fixtures/schema-downgrade.js';

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

class RecordingSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('unused'));
  }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return Promise.resolve({ channel: input.channel, ts: input.ts });
  }
}

type DeliveryFixture = {
  readonly gateId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly gate: ReturnType<typeof gateKey>;
  readonly run: ReturnType<typeof runKey>;
  readonly task: ReturnType<typeof taskKey>;
  readonly dispatchId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly resolutionRequest: string;
};

const FIXTURE: DeliveryFixture = {
  gateId: 'gate_delivery',
  runId: 'run_delivery',
  taskId: 'task_delivery',
  gate: GATE,
  run: RUN,
  task: TASK,
  dispatchId: DISPATCH_ID,
  threadTs: THREAD_TS,
  messageTs: MESSAGE_TS,
  resolutionRequest: RESOLUTION_REQUEST,
};

const COMPANION: DeliveryFixture = {
  gateId: 'gate_delivery_companion',
  runId: 'run_delivery_companion',
  taskId: 'task_delivery_companion',
  gate: gateKey('gate_delivery_companion'),
  run: runKey('run_delivery_companion'),
  task: taskKey('task_delivery_companion'),
  dispatchId: 'ctx_delivery_companion',
  threadTs: '1787554800.000011',
  messageTs: '1787554800.000012',
  resolutionRequest: '22222222-2222-4222-8222-222222222222',
};

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

function snapshots(fixture: DeliveryFixture): {
  readonly pending: GateSnapshot;
  readonly resolved: GateSnapshot;
} {
  const fixturePending: GateSnapshot = {
    gateId: fixture.gateId,
    runId: fixture.runId,
    taskId: fixture.taskId,
    options: ['현행 유지', '변경'],
    status: 'pending',
    resolution: null,
    resolvedAt: null,
  };
  return {
    pending: fixturePending,
    resolved: {
      ...fixturePending,
      status: 'resolved',
      resolution: '현행 유지',
      resolvedAt: '2026-08-24T10:00:01.000Z',
    },
  };
}

function seedD2(store: SqliteDigestStore, fixture: DeliveryFixture = FIXTURE): void {
  store.insertGateMetadata({
    gateKey: fixture.gate,
    runKey: fixture.run,
    taskKey: fixture.task,
    dispatchKey: dispatchKey(fixture.dispatchId),
    source: 'registered',
    askMessageId: `msg_${fixture.gateId}`,
    questionThreadId: `thread_${fixture.gateId}`,
    options: [
      { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '변경한다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성' },
    impact: '후속 방향',
    registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: fixture.gate,
    runKey: fixture.run,
    channelId: CHANNEL,
    threadTs: fixture.threadTs,
    messageTs: fixture.messageTs,
    renderFingerprint: 'fp',
    at: AT,
  });
  store.saveGateLocalObservation({
    gateKey: fixture.gate,
    runKey: fixture.run,
    taskKey: fixture.task,
    status: 'pending',
    resolution: null,
    resolvedAt: null,
    metadataState: 'matched',
    mappingState: 'matched',
    observedAt: AT,
  });
}

function resolveD2(store: SqliteDigestStore, fixture: DeliveryFixture = FIXTURE): void {
  const fixtureSnapshots = snapshots(fixture);
  seedD2(store, fixture);
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM',
    ownerUserId: 'U0OWNER',
    apiAppId: 'A0APP',
    channelId: CHANNEL,
    threadTs: fixture.threadTs,
    messageTs: fixture.messageTs,
    blockId: gateBlockId(fixture.gate),
    actionId: gateActionId(fixture.gate, 'keep'),
    actionValue: 'keep',
    retryRequestId: fixture.resolutionRequest,
    at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(fixture.gate, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('ACK failed');
  const lease = store.acquireGateResolutionLease(
    fixture.gate,
    't.d2-resolver',
    AT,
    LEASE_EXPIRY,
  );
  if (lease.kind !== 'acquired') throw new Error(`D2 lease failed: ${lease.kind}`);
  const preRead = store.updateGateResolution(
    fixture.gate,
    lease.intent.revision,
    't.d2-resolver',
    {
      lifecycle: 'pre_read', preRead: fixtureSnapshots.pending, at: AT,
    },
  );
  if (preRead === null) throw new Error('pre-read failed');
  const resolving = store.updateGateResolution(
    fixture.gate,
    preRead.revision,
    't.d2-resolver',
    {
      lifecycle: 'resolving', at: AT,
    },
  );
  if (resolving === null) throw new Error('resolving failed');
  const postRead = store.updateGateResolution(
    fixture.gate,
    resolving.revision,
    't.d2-resolver',
    {
      lifecycle: 'post_read',
      resolveResult: {
        gate: fixtureSnapshots.resolved,
        mutation: { requestId: fixture.resolutionRequest, replayed: false },
      },
      at: AT,
    },
  );
  if (postRead === null) throw new Error('post-read failed');
  const terminal = store.updateGateResolution(
    fixture.gate,
    postRead.revision,
    't.d2-resolver',
    {
      lifecycle: 'resolved', postRead: fixtureSnapshots.resolved, at: AT,
    },
  );
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
  const result = store.seedPendingGateChannelDeliveries(SEEDED_AT, 1_000, () => true);
  if (result.kind !== 'committed') throw new Error('seed fenced');
  const seeded = result.deliveries;
  expect(seeded).toHaveLength(1);
  return seeded[0]!;
}

function baselineFor(delivery: GateChannelDelivery) {
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

function recordBaseline(
  store: SqliteDigestStore,
  seeded: GateChannelDelivery,
  at = SEEDED_AT,
): GateChannelDelivery {
  const owner = 't.store-baseline';
  const lease = store.acquireGateChannelDeliveryLease(
    seeded.gateKey,
    owner,
    at,
    new Date(new Date(at).valueOf() + 60_000).toISOString(),
  );
  if (lease.kind !== 'acquired') throw new Error(`baseline lease failed: ${lease.kind}`);
  const recorded = store.recordGateResumeBaseline(
    seeded.gateKey,
    lease.delivery.revision,
    owner,
    baselineFor(seeded),
    at,
  );
  if (recorded === null) throw new Error('baseline record failed');
  if (!store.releaseGateChannelDeliveryLease(seeded.gateKey, owner, at)) {
    throw new Error('baseline release failed');
  }
  return store.findGateChannelDelivery(seeded.gateKey)!;
}

function seedAndBaseline(store: SqliteDigestStore, at = SEEDED_AT): GateChannelDelivery {
  return recordBaseline(store, seedDelivery(store), at);
}

describe('additive v12 Channel resume schema', () => {
  it('makes fresh v12 exactly equal to populated v10→v12 without rewriting the v10 outbox', () => {
    const migratedPath = join(dir, 'migrated.db');
    const v11 = new SqliteDigestStore(migratedPath);
    resolveD2(v11);
    v11.close();

    const v10 = new DatabaseSync(migratedPath);
    const outboxBefore = v10.prepare('SELECT * FROM gate_resolution_outbox').get();
    const outboxDdlBefore = v10.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gate_resolution_outbox'",
    ).get();
    v10.exec(`DROP TABLE gate_resume_observation;
      DROP TABLE slack_root_intent; DROP TABLE daemon_job_outcome; DROP TABLE daemon_health;
      DROP TABLE repository_discovery_issue; DROP TABLE orca_repository_binding;
      DROP TABLE repository_registry`);
    v10.exec('DROP TABLE gate_channel_delivery');
    dropTerminalPromptTables(v10);
    downgradeGateMetadataToV13(v10);
    v10.prepare('UPDATE schema_version SET version = 10 WHERE id = 1').run();
    v10.close();

    const migrated = new SqliteDigestStore(migratedPath);
    expect(migrated.findGateChannelDelivery(GATE)).toBeNull();
    migrated.close();

    const postMigration = new DatabaseSync(migratedPath, { readOnly: true });
    expect(postMigration.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({
      version: 16,
    });
    expect(postMigration.prepare('SELECT * FROM gate_resolution_outbox').get()).toEqual(outboxBefore);
    expect(postMigration.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='gate_resolution_outbox'",
    ).get()).toEqual(outboxDdlBefore);
    postMigration.close();

    const freshPath = join(dir, 'fresh.db');
    new SqliteDigestStore(freshPath).close();
    expect(SCHEMA_VERSION).toBe(16);
    expect(deliverySchemaShape(migratedPath)).toEqual(deliverySchemaShape(freshPath));

    const lazy = new SqliteDigestStore(migratedPath);
    expect(seedDelivery(lazy)).toMatchObject({
      state: 'pending', revision: 0, attemptCount: 0,
      runKey: RUN, taskKey: TASK, sourceDispatchId: DISPATCH_ID,
    });
    expect(lazy.seedPendingGateChannelDeliveries(SEEDED_AT, 1_000, () => true)).toEqual({
      kind: 'committed', deliveries: [],
    });
    expect(lazy.findGateResolutionOutbox(GATE)?.notificationState).toBe('pending');
    lazy.close();
  });

  it('quarantines an unprovable exact-base v10 recovery row while seeding its valid companion', () => {
    const legacyPath = join(dir, 'legacy-populated-v10.db');
    const prepared = new SqliteDigestStore(legacyPath);
    resolveD2(prepared);
    resolveD2(prepared, COMPANION);
    prepared.close();

    const v10 = new DatabaseSync(legacyPath);
    v10.exec(`DROP TABLE gate_resume_observation;
      DROP TABLE slack_root_intent; DROP TABLE daemon_job_outcome; DROP TABLE daemon_health;
      DROP TABLE repository_discovery_issue; DROP TABLE orca_repository_binding;
      DROP TABLE repository_registry`);
    v10.exec('DROP TABLE gate_channel_delivery');
    dropTerminalPromptTables(v10);
    downgradeGateMetadataToV13(v10);
    v10.prepare('UPDATE schema_version SET version = 10 WHERE id = 1').run();
    v10.prepare(
      `UPDATE gate_resolution
          SET pre_read_json = post_read_json
        WHERE gate_key = ?`,
    ).run(GATE);
    v10.close();

    const migrated = new SqliteDigestStore(legacyPath);
    expect(migrated.seedPendingGateChannelDeliveries(
      SEEDED_AT,
      1_000,
      () => true,
    )).toMatchObject({
      kind: 'committed',
      deliveries: [{
        gateKey: COMPANION.gate,
        runKey: COMPANION.run,
        taskKey: COMPANION.task,
        sourceDispatchId: COMPANION.dispatchId,
        state: 'pending',
      }],
    });
    expect(migrated.findGateChannelDelivery(GATE)).toBeNull();
    expect(migrated.findGateChannelDelivery(COMPANION.gate)).not.toBeNull();
    expect(migrated.findGateResolutionOutbox(GATE)?.notificationState).toBe('pending');
    expect(migrated.seedPendingGateChannelDeliveries(SEEDED_AT, 1_000, () => true)).toEqual({
      kind: 'committed', deliveries: [],
    });
    migrated.close();
  });

  it('fails closed on future schema instead of rewriting or downgrading it', () => {
    new SqliteDigestStore(path).close();
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE schema_version SET version = 17 WHERE id = 1').run();
    raw.close();
    expect(() => new SqliteDigestStore(path)).toThrow(SchemaVersionError);
  });

  it('clamps a regressed seed clock to persisted D2 evidence and reopens idempotently', () => {
    let store = new SqliteDigestStore(path);
    resolveD2(store);
    const rollbackAt = '2026-08-24T09:59:59.000Z';
    expect(store.seedPendingGateChannelDeliveries(rollbackAt, 1_000, () => true)).toMatchObject({
      kind: 'committed',
      deliveries: [{
        gateKey: GATE,
        state: 'pending',
        createdAt: '2026-08-24T10:00:01.000Z',
        updatedAt: '2026-08-24T10:00:01.000Z',
        nextAttemptAt: '2026-08-24T10:00:01.000Z',
      }],
    });
    expect(store.seedPendingGateChannelDeliveries(rollbackAt, 1_000, () => true)).toEqual({
      kind: 'committed', deliveries: [],
    });
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toHaveLength(1);
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'pending', createdAt: '2026-08-24T10:00:01.000Z',
      nextAttemptAt: '2026-08-24T10:00:01.000Z',
    });
    expect(store.seedPendingGateChannelDeliveries(rollbackAt, 1_000, () => true)).toEqual({
      kind: 'committed', deliveries: [],
    });
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
        name: 'event-after-update-clock',
        sql: `UPDATE gate_channel_delivery
                SET state = 'attempted', attempt_count = 1,
                    last_attempt_at = '2026-08-24T10:00:03.000Z',
                    updated_at = '2026-08-24T10:00:02.000Z'`,
      },
      {
        name: 'deferred-outbox-revision',
        sql: 'UPDATE gate_channel_delivery SET deferred_outbox_revision = 42',
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
  it('rolls back delivery state and its card re-arm when the commit deadline fence closes', () => {
    const store = new SqliteDigestStore(path);
    resolveD2(store);
    seedAndBaseline(store);
    const pendingDelivery = store.findGateChannelDelivery(GATE);
    const pendingOutbox = store.findGateResolutionOutbox(GATE);

    expect(store.markGateChannelAttempted(
      GATE,
      ATTEMPTED_AT,
      '2026-08-24T10:00:08.000Z',
      () => false,
    )).toBeNull();
    expect(store.findGateChannelDelivery(GATE)).toEqual(pendingDelivery);
    expect(store.findGateResolutionOutbox(GATE)).toEqual(pendingOutbox);

    expect(store.markGateChannelAttempted(
      GATE,
      ATTEMPTED_AT,
      '2026-08-24T10:00:08.000Z',
      () => true,
    )?.state).toBe('attempted');
    const attemptedDelivery = store.findGateChannelDelivery(GATE);
    const attemptedOutbox = store.findGateResolutionOutbox(GATE);
    expect(store.markGateChannelReceipted(
      GATE,
      RECEIPTED_AT,
      () => false,
    )).toBeNull();
    expect(store.findGateChannelDelivery(GATE)).toEqual(attemptedDelivery);
    expect(store.findGateResolutionOutbox(GATE)).toEqual(attemptedOutbox);
    store.close();
  });

  it('clamps a rollback defer to persisted lease history and survives reopen idempotently', () => {
    // Freeze the injected monotonic source here: this legacy assertion isolates causal clamping
    // itself, while the FINAL4 regression below advances monotonic time explicitly.
    let store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    seedAndBaseline(store);
    expect(store.markGateChannelAttempted(
      GATE,
      ATTEMPTED_AT,
      '2026-08-24T10:00:07.000Z',
    )).toMatchObject({ state: 'attempted', updatedAt: ATTEMPTED_AT });
    const lease = store.acquireGateChannelDeliveryLease(
      GATE,
      DELIVERY_OWNER,
      '2026-08-24T10:00:08.000Z',
      '2026-08-24T10:00:20.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error(`rollback lease failed: ${lease.kind}`);

    const deferred = store.deferGateChannelDelivery(
      GATE,
      lease.delivery.revision,
      DELIVERY_OWNER,
      '2026-08-24T10:00:02.500Z',
      '2026-08-24T10:00:07.500Z',
      'route_pending',
    );
    expect(deferred).toMatchObject({
      state: 'attempted',
      updatedAt: '2026-08-24T10:00:08.000Z',
      nextAttemptAt: '2026-08-24T10:00:13.000Z',
      lastAttemptAt: ATTEMPTED_AT,
      leaseOwner: null,
      lastErrorCode: 'route_pending',
    });
    expect(store.deferGateChannelDelivery(
      GATE,
      lease.delivery.revision,
      DELIVERY_OWNER,
      '2026-08-24T10:00:02.500Z',
      '2026-08-24T10:00:07.500Z',
      'route_pending',
    )).toBeNull();
    store.close();

    store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    expect(store.findGateChannelDelivery(GATE)).toEqual(deferred);
    expect(store.listDueGateChannelDeliveries('2026-08-24T10:00:12.999Z')).toEqual([]);
    expect(store.listDueGateChannelDeliveries('2026-08-24T10:00:13.000Z')).toHaveLength(1);
    store.close();
  });

  it('recovers an expired lease without allowing a stale owner to release the replacement', () => {
    const store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    seedAndBaseline(store);
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

  it('keeps lifecycle distinct while each D3 generation deterministically updates the existing card', async () => {
    const store = new SqliteDigestStore(path);
    const slack = new RecordingSlack();
    resolveD2(store);

    // Ordinary D2 owns and completes its pending generation before D3 is materialized.
    expect(await projectGateResolutionCard(
      store, slack, GATE, () => new Date(SEEDED_AT),
    )).toMatchObject({ kind: 'projected' });
    expect(slack.updates).toHaveLength(1);
    const projected = store.findGateResolutionOutbox(GATE)!;
    expect(projected.cardPending).toBe(false);

    const seeded = seedDelivery(store);
    const seededOutbox = store.findGateResolutionOutbox(GATE)!;
    expect(seeded.deferredOutboxRevision).toBe(seededOutbox.revision);
    expect(seededOutbox).toMatchObject({ cardPending: true, projectedAt: null });
    expect(store.acquireGateOutboxProjection(
      GATE, seededOutbox.revision, PROJECTION_OWNER, SEEDED_AT,
    )).toBe('deferred');
    expect(store.listAcknowledgedGateOutboxes()).toHaveLength(1);
    expect(await projectGateResolutionCard(
      store, slack, GATE, () => new Date(SEEDED_AT),
    )).toMatchObject({ kind: 'projected' });
    expect(slack.updates).toHaveLength(1);

    const lease = store.acquireGateChannelDeliveryLease(
      GATE, DELIVERY_OWNER, SEEDED_AT, LEASE_EXPIRY,
    );
    if (lease.kind !== 'acquired') throw new Error(`delivery lease failed: ${lease.kind}`);
    const baselined = store.recordGateResumeBaseline(
      GATE,
      lease.delivery.revision,
      DELIVERY_OWNER,
      baselineFor(seeded),
      SEEDED_AT,
    );
    if (baselined === null) throw new Error('delivery baseline failed');
    const attempted = store.markGateChannelAttempted(
      GATE, ATTEMPTED_AT, '2026-08-24T10:00:08.000Z',
    );
    expect(attempted).toMatchObject({ state: 'attempted', attemptCount: 1, receiptedAt: null });
    expect(attempted?.deferredOutboxRevision).toBe(
      store.findGateResolutionOutbox(GATE)?.revision,
    );
    expect(await projectGateResolutionCard(
      store, slack, GATE, () => new Date(ATTEMPTED_AT),
    )).toMatchObject({ kind: 'projected' });
    expect(slack.updates).toHaveLength(1);
    expect(store.markGateOutboxProjected(
      GATE, projected.revision, 'stale-card', PROJECTION_OWNER, ATTEMPTED_AT,
    )).toBe(false);
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({ cardPending: false });

    const receipted = store.markGateChannelReceipted(GATE, RECEIPTED_AT);
    expect(receipted).toMatchObject({ state: 'receipted', consumedAt: null });
    expect(receipted?.deferredOutboxRevision).toBe(
      store.findGateResolutionOutbox(GATE)?.revision,
    );
    expect(await projectGateResolutionCard(
      store, slack, GATE, () => new Date(RECEIPTED_AT),
    )).toMatchObject({ kind: 'projected' });
    expect(slack.updates).toHaveLength(2);
    expect(slack.updates.at(-1)?.text).toContain(
      'Coordinator 확인됨 · 후속 Task 재개 미관찰',
    );
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
    const consumedDelivery = store.findGateChannelDelivery(GATE)!;
    const consumedOutbox = store.findGateResolutionOutbox(GATE)!;
    expect(consumedDelivery.deferredOutboxRevision).toBe(consumedOutbox.revision);
    expect(consumedOutbox).toMatchObject({ cardPending: true, projectedAt: null });
    expect(store.listAcknowledgedGateOutboxes()).toHaveLength(1);
    expect(await projectGateResolutionCard(
      store, slack, GATE, () => new Date(CONSUMED_AT),
    )).toMatchObject({ kind: 'projected' });
    expect(slack.updates).toHaveLength(2);
    expect(store.listDueGateChannelDeliveries('2026-08-24T11:00:00.000Z')).toEqual([]);
    expect(store.consumeGateChannelDelivery(
      GATE, effectLease.delivery.revision, DELIVERY_OWNER, resolved, CONSUMED_AT,
    )).toMatchObject({ kind: 'duplicate', delivery: { state: 'consumed' } });
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({ cardPending: false });
    store.close();

    const reopened = new SqliteDigestStore(path);
    expect(reopened.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'consumed', nextAttemptAt: null, leaseOwner: null,
    });
    const deferred = reopened.findGateChannelDelivery(GATE)!;
    const pendingOutbox = reopened.findGateResolutionOutbox(GATE)!;
    expect(pendingOutbox).toMatchObject({ cardPending: false });
    expect(pendingOutbox.revision).toBeGreaterThan(deferred.deferredOutboxRevision);
    expect(await projectGateResolutionCard(
      reopened, slack, GATE, () => new Date(CONSUMED_AT),
    )).toMatchObject({ kind: 'current' });
    expect(slack.updates).toHaveLength(2);
    reopened.close();
  });

  it('recovers receipted rows after restart and refuses mismatched fresh Gate evidence', () => {
    let store = new SqliteDigestStore(path);
    resolveD2(store);
    seedAndBaseline(store);
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

describe('FINAL4 durable projection and rollback clocks', () => {
  it('advances exact D3 projection provenance on crash recovery and release without leaking it to D2', async () => {
    const slack = new RecordingSlack();
    const crashedOwner = 't.crashed-projector';
    const recoveryOwner = 't.recovery-projector';
    let store = new SqliteDigestStore(path);
    resolveD2(store);
    const initialDelivery = seedDelivery(store);
    const initialOutbox = store.findGateResolutionOutbox(GATE)!;
    const initialClaim = {
      expectedDeliveryRevision: initialDelivery.revision,
      expectedOutboxRevision: initialOutbox.revision,
    };

    expect(initialDelivery.deferredOutboxRevision).toBe(initialOutbox.revision);
    expect(store.acquireGateOutboxProjection(
      GATE,
      initialOutbox.revision,
      crashedOwner,
      ATTEMPTED_AT,
      initialClaim,
    )).toBe('acquired');
    store.close();

    store = new SqliteDigestStore(path, { observationOwnerAlive: () => false });
    expect(store.acquireGateOutboxProjection(
      GATE,
      initialOutbox.revision,
      recoveryOwner,
      RECEIPTED_AT,
      initialClaim,
    )).toBe('recovered');
    const recoveredDelivery = store.findGateChannelDelivery(GATE)!;
    const recoveredOutbox = store.findGateResolutionOutbox(GATE)!;
    const recoveredClaim = {
      expectedDeliveryRevision: recoveredDelivery.revision,
      expectedOutboxRevision: recoveredOutbox.revision,
    };
    expect(recoveredDelivery).toMatchObject({
      revision: initialDelivery.revision + 1,
      deferredOutboxRevision: initialOutbox.revision + 1,
    });
    expect(recoveredOutbox).toMatchObject({
      revision: initialOutbox.revision + 1,
      cardPending: true,
      projectedAt: null,
    });
    expect(recoveredDelivery.deferredOutboxRevision).toBe(recoveredOutbox.revision);

    // The abandoned generation cannot complete or release the replacement, and the exact D3
    // generation remains invisible to the ordinary D2 projector after recovery.
    expect(store.markGateOutboxProjected(
      GATE,
      initialOutbox.revision,
      'stale-recovery-completion',
      crashedOwner,
      CONSUMED_AT,
      initialClaim,
    )).toBe(false);
    expect(store.releaseGateOutboxProjection(
      GATE,
      crashedOwner,
      CONSUMED_AT,
      initialClaim,
    )).toBe(false);
    expect(store.acquireGateOutboxProjection(
      GATE,
      recoveredOutbox.revision,
      't.ordinary-projector',
      CONSUMED_AT,
    )).toBe('deferred');
    expect(store.listAcknowledgedGateOutboxes()).toHaveLength(1);
    expect(slack.updates).toEqual([]);

    // A recovered owner must loop on the new exact identity before acting. Its release advances
    // both generations together, so the newly pending generation cannot become ordinary D2 work.
    expect(store.acquireGateOutboxProjection(
      GATE,
      recoveredOutbox.revision,
      recoveryOwner,
      '2026-08-24T10:00:06.000Z',
      recoveredClaim,
    )).toBe('acquired');
    expect(store.releaseGateOutboxProjection(
      GATE,
      recoveryOwner,
      '2026-08-24T10:00:07.000Z',
      recoveredClaim,
    )).toBe(true);
    const releasedDelivery = store.findGateChannelDelivery(GATE)!;
    const releasedOutbox = store.findGateResolutionOutbox(GATE)!;
    expect(releasedDelivery).toMatchObject({
      revision: recoveredDelivery.revision + 1,
      deferredOutboxRevision: recoveredOutbox.revision + 1,
    });
    expect(releasedOutbox).toMatchObject({
      revision: recoveredOutbox.revision + 1,
      cardPending: true,
      projectedAt: null,
    });
    expect(releasedDelivery.deferredOutboxRevision).toBe(releasedOutbox.revision);
    expect(store.markGateOutboxProjected(
      GATE,
      recoveredOutbox.revision,
      'stale-release-completion',
      recoveryOwner,
      '2026-08-24T10:00:08.000Z',
      recoveredClaim,
    )).toBe(false);
    expect(store.releaseGateOutboxProjection(
      GATE,
      recoveryOwner,
      '2026-08-24T10:00:08.000Z',
      recoveredClaim,
    )).toBe(false);
    expect(store.listAcknowledgedGateOutboxes()).toHaveLength(1);
    expect(slack.updates).toEqual([]);
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.findGateChannelDelivery(GATE)).toEqual(releasedDelivery);
    expect(store.findGateResolutionOutbox(GATE)).toEqual(releasedOutbox);
    expect(store.findGateChannelDelivery(GATE)?.deferredOutboxRevision).toBe(
      store.findGateResolutionOutbox(GATE)?.revision,
    );
    expect(store.acquireGateOutboxProjection(
      GATE,
      releasedOutbox.revision,
      't.ordinary-after-restart',
      '2026-08-24T10:00:09.000Z',
    )).toBe('deferred');
    expect(store.markGateOutboxProjected(
      GATE,
      recoveredOutbox.revision,
      'stale-after-restart',
      recoveryOwner,
      '2026-08-24T10:00:09.000Z',
      recoveredClaim,
    )).toBe(false);

    // An unrelated, non-D3 D2 generation still follows the ordinary projection path.
    resolveD2(store, COMPANION);
    expect(await projectGateResolutionCard(
      store,
      slack,
      COMPANION.gate,
      () => new Date('2026-08-24T10:00:09.000Z'),
    )).toMatchObject({ kind: 'projected' });
    expect(slack.updates).toHaveLength(1);
    store.close();
  });

  it('clears an expired delivery lease inside exact projection recovery and release dual CAS', () => {
    const crashedProjectionOwner = 't.expired-projection-owner';
    const recoveredProjectionOwner = 't.recovered-projection-owner';
    const firstDeliveryOwner = 't.expired-delivery-owner';
    const secondDeliveryOwner = 't.equality-delivery-owner';
    let store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    resolveD2(store);
    seedAndBaseline(store);

    const firstLease = store.acquireGateChannelDeliveryLease(
      GATE,
      firstDeliveryOwner,
      SEEDED_AT,
      RECEIPTED_AT,
    );
    if (firstLease.kind !== 'acquired') throw new Error(`first lease failed: ${firstLease.kind}`);
    const initialOutbox = store.findGateResolutionOutbox(GATE)!;
    const firstClaim = {
      expectedDeliveryRevision: firstLease.delivery.revision,
      expectedOutboxRevision: initialOutbox.revision,
    };
    expect(store.acquireGateOutboxProjection(
      GATE,
      initialOutbox.revision,
      crashedProjectionOwner,
      ATTEMPTED_AT,
      firstClaim,
    )).toBe('acquired');
    store.close();

    // Recovery occurs exactly when the independent delivery lease expires. The same transaction
    // must clear that lease and advance both deferred generations; otherwise the v11 CHECK rejects
    // updated_at equality and rolls the whole recovery back.
    store = new SqliteDigestStore(path, {
      monotonicNow: () => 0,
      observationOwnerAlive: () => false,
    });
    expect(store.acquireGateOutboxProjection(
      GATE,
      initialOutbox.revision,
      recoveredProjectionOwner,
      RECEIPTED_AT,
      firstClaim,
    )).toBe('recovered');
    const recoveredDelivery = store.findGateChannelDelivery(GATE)!;
    const recoveredOutbox = store.findGateResolutionOutbox(GATE)!;
    expect(recoveredDelivery).toMatchObject({
      revision: firstLease.delivery.revision + 1,
      deferredOutboxRevision: recoveredOutbox.revision,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: RECEIPTED_AT,
    });
    expect(store.deferGateChannelDelivery(
      GATE,
      firstLease.delivery.revision,
      firstDeliveryOwner,
      RECEIPTED_AT,
      '2026-08-24T10:00:09.000Z',
      'route_pending',
    )).toBeNull();
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      firstDeliveryOwner,
      RECEIPTED_AT,
    )).toBe(false);

    // Repeat the boundary through explicit projection release. The lease is live when the exact
    // claim is renewed, then expires at equality before the release's dual generation advance.
    const secondLease = store.acquireGateChannelDeliveryLease(
      GATE,
      secondDeliveryOwner,
      CONSUMED_AT,
      '2026-08-24T10:00:06.000Z',
    );
    if (secondLease.kind !== 'acquired') throw new Error(`second lease failed: ${secondLease.kind}`);
    const releaseClaim = {
      expectedDeliveryRevision: secondLease.delivery.revision,
      expectedOutboxRevision: recoveredOutbox.revision,
    };
    expect(store.acquireGateOutboxProjection(
      GATE,
      recoveredOutbox.revision,
      recoveredProjectionOwner,
      '2026-08-24T10:00:05.500Z',
      releaseClaim,
    )).toBe('acquired');
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      leaseOwner: secondDeliveryOwner,
      leaseExpiresAt: '2026-08-24T10:00:06.000Z',
    });
    expect(store.releaseGateOutboxProjection(
      GATE,
      recoveredProjectionOwner,
      '2026-08-24T10:00:06.000Z',
      releaseClaim,
    )).toBe(true);
    const releasedDelivery = store.findGateChannelDelivery(GATE)!;
    const releasedOutbox = store.findGateResolutionOutbox(GATE)!;
    expect(releasedDelivery).toMatchObject({
      revision: secondLease.delivery.revision + 1,
      deferredOutboxRevision: releasedOutbox.revision,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: '2026-08-24T10:00:06.000Z',
    });
    expect(store.deferGateChannelDelivery(
      GATE,
      secondLease.delivery.revision,
      secondDeliveryOwner,
      '2026-08-24T10:00:06.000Z',
      '2026-08-24T10:00:11.000Z',
      'route_pending',
    )).toBeNull();
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      secondDeliveryOwner,
      '2026-08-24T10:00:06.000Z',
    )).toBe(false);
    expect(store.markGateOutboxProjected(
      GATE,
      recoveredOutbox.revision,
      'stale-equality-completion',
      recoveredProjectionOwner,
      '2026-08-24T10:00:06.000Z',
      releaseClaim,
    )).toBe(false);
    expect(store.listAcknowledgedGateOutboxes()).toHaveLength(1);
    store.close();

    store = new SqliteDigestStore(path, { monotonicNow: () => 0 });
    expect(store.findGateChannelDelivery(GATE)).toEqual(releasedDelivery);
    expect(store.findGateResolutionOutbox(GATE)).toEqual(releasedOutbox);
    expect(store.listAcknowledgedGateOutboxes()).toHaveLength(1);
    store.close();
  });

  it('uses one rollback-safe logical clock for due, retry, lease, receipt, and consume delays', () => {
    const rollbackAt = '2026-08-24T09:00:00.000Z';
    const rollbackLease4s = '2026-08-24T09:00:04.000Z';
    const rollbackLease6s = '2026-08-24T09:00:06.000Z';
    let monotonicMs = 0;
    let store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    resolveD2(store);
    seedAndBaseline(store);

    monotonicMs = 1_000;
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toHaveLength(1);

    monotonicMs = 2_000;
    const firstLease = store.acquireGateChannelDeliveryLease(
      GATE,
      't.release-owner',
      rollbackAt,
      '2026-08-24T09:00:10.000Z',
    );
    expect(firstLease).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:04.000Z',
        leaseExpiresAt: '2026-08-24T10:00:14.000Z',
      },
    });

    monotonicMs = 3_000;
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.release-owner',
      rollbackAt,
    )).toBe(true);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      updatedAt: '2026-08-24T10:00:05.000Z',
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    monotonicMs = 4_000;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.expired-clock-owner',
      rollbackAt,
      rollbackLease4s,
    )).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:06.000Z',
        leaseExpiresAt: '2026-08-24T10:00:10.000Z',
      },
    });

    monotonicMs = 7_000;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.recovery-clock-owner',
      rollbackAt,
      rollbackLease6s,
    )).toEqual({ kind: 'busy', expiresAt: '2026-08-24T10:00:10.000Z' });
    monotonicMs = 8_000;
    const recovered = store.acquireGateChannelDeliveryLease(
      GATE,
      't.recovery-clock-owner',
      rollbackAt,
      rollbackLease6s,
    );
    expect(recovered).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:10.000Z',
        leaseOwner: 't.recovery-clock-owner',
        leaseExpiresAt: '2026-08-24T10:00:16.000Z',
      },
    });
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.expired-clock-owner',
      rollbackAt,
    )).toBe(false);
    if (recovered.kind !== 'acquired') throw new Error(`recovery failed: ${recovered.kind}`);

    monotonicMs = 9_000;
    expect(store.deferGateChannelDelivery(
      GATE,
      recovered.delivery.revision,
      't.recovery-clock-owner',
      rollbackAt,
      '2026-08-24T09:00:05.000Z',
      'rollback_retry',
    )).toMatchObject({
      updatedAt: '2026-08-24T10:00:11.000Z',
      nextAttemptAt: '2026-08-24T10:00:16.000Z',
      leaseOwner: null,
      lastErrorCode: 'rollback_retry',
    });
    monotonicMs = 13_999;
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toEqual([]);
    monotonicMs = 14_000;
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toHaveLength(1);

    monotonicMs = 15_000;
    expect(store.markGateChannelAttempted(
      GATE,
      rollbackAt,
      '2026-08-24T09:00:07.000Z',
    )).toMatchObject({
      state: 'attempted',
      lastAttemptAt: '2026-08-24T10:00:17.000Z',
      updatedAt: '2026-08-24T10:00:17.000Z',
      nextAttemptAt: '2026-08-24T10:00:24.000Z',
    });
    monotonicMs = 21_999;
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toEqual([]);
    monotonicMs = 22_000;
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toHaveLength(1);

    monotonicMs = 23_000;
    expect(store.markGateChannelReceipted(GATE, rollbackAt)).toMatchObject({
      state: 'receipted',
      lastAttemptAt: '2026-08-24T10:00:17.000Z',
      receiptedAt: '2026-08-24T10:00:25.000Z',
      nextAttemptAt: '2026-08-24T10:00:25.000Z',
      updatedAt: '2026-08-24T10:00:25.000Z',
    });
    store.close();

    // A new process starts its monotonic source at an unrelated value, then continues from the
    // persisted causal floor instead of waiting for the wall clock to catch up.
    monotonicMs = 500;
    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    monotonicMs = 1_500;
    const effectLease = store.acquireGateChannelDeliveryLease(
      GATE,
      't.consume-clock-owner',
      rollbackAt,
      '2026-08-24T09:00:10.000Z',
    );
    expect(effectLease).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:26.000Z',
        leaseExpiresAt: '2026-08-24T10:00:36.000Z',
      },
    });
    if (effectLease.kind !== 'acquired') {
      throw new Error(`effect lease failed: ${effectLease.kind}`);
    }
    monotonicMs = 2_500;
    expect(store.consumeGateChannelDelivery(
      GATE,
      effectLease.delivery.revision,
      't.consume-clock-owner',
      resolved,
      rollbackAt,
    )).toMatchObject({
      kind: 'consumed',
      delivery: {
        state: 'consumed',
        consumedAt: '2026-08-24T10:00:27.000Z',
        updatedAt: '2026-08-24T10:00:27.000Z',
        nextAttemptAt: null,
        leaseOwner: null,
      },
    });
    expect(store.findGateChannelDelivery(GATE)?.deferredOutboxRevision).toBe(
      store.findGateResolutionOutbox(GATE)?.revision,
    );
    expect(store.listDueGateChannelDeliveries(rollbackAt)).toEqual([]);
    store.close();
  });

  it('advances from an equal persisted floor while the wall clock stays frozen', () => {
    const frozenNow = SEEDED_AT;
    let monotonicMs = 0;
    let store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    resolveD2(store);
    const frozenSeed = seedDelivery(store);
    expect(frozenSeed).toMatchObject({
      updatedAt: frozenNow,
      nextAttemptAt: frozenNow,
    });
    recordBaseline(store, frozenSeed, frozenNow);
    store.close();

    // The new process reads T as its causal floor, while every caller continues to report exactly
    // T. Equal and sub-millisecond samples may persist the same ISO millisecond, but never regress.
    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    expect(store.listDueGateChannelDeliveries(frozenNow)).toHaveLength(1);
    monotonicMs = 0.25;
    expect(store.listDueGateChannelDeliveries(frozenNow)).toHaveLength(1);
    monotonicMs = 0.75;
    expect(store.listDueGateChannelDeliveries(frozenNow)).toHaveLength(1);

    monotonicMs = 1;
    expect(store.markGateChannelAttempted(
      GATE,
      frozenNow,
      '2026-08-24T10:00:07.000Z',
    )).toMatchObject({
      state: 'attempted',
      lastAttemptAt: '2026-08-24T10:00:02.001Z',
      updatedAt: '2026-08-24T10:00:02.001Z',
      nextAttemptAt: '2026-08-24T10:00:07.001Z',
    });

    // The original five-second retry delay expires from monotonic progress alone. A sub-ms call
    // immediately before the boundary is still not due; equality at the boundary is due.
    monotonicMs = 5_000.999;
    expect(store.listDueGateChannelDeliveries(frozenNow)).toEqual([]);
    monotonicMs = 5_001;
    expect(store.listDueGateChannelDeliveries(frozenNow)).toHaveLength(1);

    monotonicMs = 5_002;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.frozen-expired',
      frozenNow,
      '2026-08-24T10:00:05.000Z',
    )).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:07.002Z',
        leaseExpiresAt: '2026-08-24T10:00:10.002Z',
      },
    });
    monotonicMs = 8_001.999;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.frozen-recovery',
      frozenNow,
      '2026-08-24T10:00:06.000Z',
    )).toEqual({ kind: 'busy', expiresAt: '2026-08-24T10:00:10.002Z' });
    monotonicMs = 8_002;
    const recovered = store.acquireGateChannelDeliveryLease(
      GATE,
      't.frozen-recovery',
      frozenNow,
      '2026-08-24T10:00:06.000Z',
    );
    expect(recovered).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:10.002Z',
        leaseOwner: 't.frozen-recovery',
        leaseExpiresAt: '2026-08-24T10:00:14.002Z',
      },
    });
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.frozen-expired',
      frozenNow,
    )).toBe(false);

    monotonicMs = 8_002.5;
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.frozen-recovery',
      frozenNow,
    )).toBe(true);
    const released = store.findGateChannelDelivery(GATE)!;
    expect(released).toMatchObject({
      updatedAt: '2026-08-24T10:00:10.002Z',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    store.close();

    // Reopening resets the process clock origin. The persisted floor validates, equal/sub-ms calls
    // remain non-regressing, and one monotonic millisecond produces durable forward progress.
    monotonicMs = 0;
    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    expect(store.findGateChannelDelivery(GATE)).toEqual(released);
    monotonicMs = 0.5;
    expect(store.listDueGateChannelDeliveries(frozenNow)).toHaveLength(1);
    monotonicMs = 1;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.frozen-reopen',
      frozenNow,
      '2026-08-24T10:00:04.000Z',
    )).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:10.003Z',
        leaseExpiresAt: '2026-08-24T10:00:12.003Z',
      },
    });
    monotonicMs = 1.5;
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.frozen-reopen',
      frozenNow,
    )).toBe(true);
    const releasedAfterReopen = store.findGateChannelDelivery(GATE)!;
    expect(releasedAfterReopen).toMatchObject({
      updatedAt: '2026-08-24T10:00:10.003Z',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    store.close();

    monotonicMs = 100;
    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    expect(store.findGateChannelDelivery(GATE)).toEqual(releasedAfterReopen);
    store.close();
  });

  it('uses monotonic elapsed time when the wall clock creeps forward too slowly', () => {
    const floor = SEEDED_AT;
    let monotonicMs = 0;
    let store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    resolveD2(store);
    const creepingSeed = seedDelivery(store);
    expect(creepingSeed).toMatchObject({ updatedAt: floor, nextAttemptAt: floor });
    recordBaseline(store, creepingSeed, floor);
    store.close();

    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    monotonicMs = 1_000;
    expect(store.listDueGateChannelDeliveries(
      '2026-08-24T10:00:02.001Z',
    )).toHaveLength(1);

    // One wall millisecond elapsed during each monotonic second. Scheduling must use the larger
    // monotonic advance instead of accepting the technically-forward wall samples as elapsed time.
    monotonicMs = 2_000;
    expect(store.markGateChannelAttempted(
      GATE,
      '2026-08-24T10:00:02.002Z',
      '2026-08-24T10:00:05.002Z',
    )).toMatchObject({
      state: 'attempted',
      lastAttemptAt: '2026-08-24T10:00:04.000Z',
      updatedAt: '2026-08-24T10:00:04.000Z',
      nextAttemptAt: '2026-08-24T10:00:07.000Z',
    });
    monotonicMs = 4_999;
    expect(store.listDueGateChannelDeliveries(
      '2026-08-24T10:00:02.003Z',
    )).toEqual([]);
    monotonicMs = 5_000;
    expect(store.listDueGateChannelDeliveries(
      '2026-08-24T10:00:02.004Z',
    )).toHaveLength(1);

    monotonicMs = 5_001;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.slow-wall-expired',
      '2026-08-24T10:00:02.005Z',
      '2026-08-24T10:00:04.005Z',
    )).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:07.001Z',
        leaseExpiresAt: '2026-08-24T10:00:09.001Z',
      },
    });
    monotonicMs = 7_000;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.slow-wall-recovery',
      '2026-08-24T10:00:02.006Z',
      '2026-08-24T10:00:05.006Z',
    )).toEqual({ kind: 'busy', expiresAt: '2026-08-24T10:00:09.001Z' });
    monotonicMs = 7_001;
    const recovered = store.acquireGateChannelDeliveryLease(
      GATE,
      't.slow-wall-recovery',
      '2026-08-24T10:00:02.007Z',
      '2026-08-24T10:00:05.007Z',
    );
    expect(recovered).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:09.001Z',
        leaseOwner: 't.slow-wall-recovery',
        leaseExpiresAt: '2026-08-24T10:00:12.001Z',
      },
    });
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.slow-wall-expired',
      '2026-08-24T10:00:02.008Z',
    )).toBe(false);
    monotonicMs = 7_001.5;
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.slow-wall-recovery',
      '2026-08-24T10:00:02.009Z',
    )).toBe(true);
    const released = store.findGateChannelDelivery(GATE)!;
    expect(released).toMatchObject({
      updatedAt: '2026-08-24T10:00:09.001Z',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    store.close();

    // A restart uses the persisted logical floor and a fresh monotonic origin; the still-creeping
    // wall cannot make a two-second lease take hundreds of seconds to progress.
    monotonicMs = 0;
    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    expect(store.findGateChannelDelivery(GATE)).toEqual(released);
    monotonicMs = 1_000;
    expect(store.acquireGateChannelDeliveryLease(
      GATE,
      't.slow-wall-reopen',
      '2026-08-24T10:00:02.010Z',
      '2026-08-24T10:00:04.010Z',
    )).toMatchObject({
      kind: 'acquired',
      delivery: {
        updatedAt: '2026-08-24T10:00:10.001Z',
        leaseExpiresAt: '2026-08-24T10:00:12.001Z',
      },
    });
    monotonicMs = 2_000;
    expect(store.releaseGateChannelDeliveryLease(
      GATE,
      't.slow-wall-reopen',
      '2026-08-24T10:00:02.011Z',
    )).toBe(true);
    const releasedAfterReopen = store.findGateChannelDelivery(GATE)!;
    expect(releasedAfterReopen).toMatchObject({
      updatedAt: '2026-08-24T10:00:11.001Z',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    store.close();

    monotonicMs = 50;
    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    expect(store.findGateChannelDelivery(GATE)).toEqual(releasedAfterReopen);
    store.close();
  });
});
