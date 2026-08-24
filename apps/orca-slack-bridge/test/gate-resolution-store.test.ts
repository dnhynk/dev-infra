import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import { SCHEMA_VERSION } from '../src/store/schema.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const GATE = gateKey('gate_d2c');
const RUN = runKey('run_d2c');
const TASK = taskKey('task_d2c');
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const AT = '2026-08-24T10:00:00.000Z';
const REQUEST = '11111111-1111-4111-8111-111111111111';
const LEASE = 't.lease-store-test';
const PROJECTION_OWNER = 't.projection-store-test';
const LEASE_EXPIRY = '2026-08-24T10:01:00.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-gate-resolution-store-'));
  path = join(dir, 'state.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(store: SqliteDigestStore, status: 'pending' | 'resolved' = 'pending'): void {
  store.insertGateMetadata({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    dispatchKey: dispatchKey('ctx_d2c'),
    askMessageId: 'msg_d2c',
    questionThreadId: 'thread_d2c',
    options: [
      { id: 'keep', label: '현행 유지', description: '호환성을 유지한다', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '새 경로로 간다', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성' },
    impact: '후속 구현 방향',
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
    status,
    resolution: status === 'resolved' ? '외부 결정' : null,
    resolvedAt: status === 'resolved' ? AT : null,
    metadataState: 'matched',
    mappingState: 'matched',
    observedAt: AT,
  });
}

function claim(store: SqliteDigestStore, option = 'keep', request = REQUEST) {
  return store.claimGateResolution({
    teamId: 'T0TEAM',
    ownerUserId: 'U0OWNER',
    apiAppId: 'A0APP',
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
    blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, option),
    actionValue: option,
    retryRequestId: request,
    at: AT,
  });
}

function lease(store: SqliteDigestStore) {
  const result = store.acquireGateResolutionLease(GATE, LEASE, AT, LEASE_EXPIRY);
  if (result.kind !== 'acquired') throw new Error(`lease failed: ${result.kind}`);
  return result.intent;
}

describe('schema v8 strict persisted shape', () => {
  it('fresh v8와 v7→v8가 같은 additive resolution tables를 만든다', () => {
    new SqliteDigestStore(path).close();
    const raw = new DatabaseSync(path);
    raw.exec(`
      DROP TABLE gate_resolution_audit;
      DROP TABLE gate_resolution_attempt;
      DROP TABLE gate_resolution_outbox;
      DROP TABLE gate_resolution;
      DROP TABLE gate_local_observation;
    `);
    raw.prepare('UPDATE schema_version SET version = 7 WHERE id = 1').run();
    raw.close();

    new SqliteDigestStore(path).close();
    const migrated = new DatabaseSync(path, { readOnly: true });
    const tables = (migrated.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'gate_resolution%' ORDER BY name",
    ).all() as { readonly name: string }[]).map((row) => row.name);
    expect(SCHEMA_VERSION).toBe(8);
    expect(migrated.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 8 });
    expect(tables).toEqual([
      'gate_resolution',
      'gate_resolution_attempt',
      'gate_resolution_audit',
      'gate_resolution_outbox',
    ]);
    migrated.close();
  });

  it('unknown column shape와 malformed lifecycle row를 모두 startup에서 거부한다', () => {
    new SqliteDigestStore(path).close();
    const shape = new DatabaseSync(path);
    shape.exec('ALTER TABLE gate_resolution RENAME COLUMN action_value TO action_value_bad');
    shape.close();
    expect(() => new SqliteDigestStore(path)).toThrow(/persisted shape/);

    const malformedPath = join(dir, 'malformed.db');
    const store = new SqliteDigestStore(malformedPath);
    seed(store);
    expect(claim(store).kind).toBe('claimed');
    store.close();
    const malformed = new DatabaseSync(malformedPath);
    malformed.exec('PRAGMA ignore_check_constraints = ON');
    malformed.prepare("UPDATE gate_resolution SET lifecycle = 'unknown'").run();
    malformed.close();
    expect(() => new SqliteDigestStore(malformedPath)).toThrow(/integrity|lifecycle/);

    const unreadableSidecarPath = join(dir, 'unreadable-sidecar.db');
    const sidecarStore = new SqliteDigestStore(unreadableSidecarPath);
    seed(sidecarStore);
    sidecarStore.close();
    const unreadableSidecar = new DatabaseSync(unreadableSidecarPath);
    unreadableSidecar.prepare("UPDATE gate_metadata SET options_json = 'not-json'").run();
    unreadableSidecar.close();
    expect(() => new SqliteDigestStore(unreadableSidecarPath)).toThrow(/options_json.*JSON/);

    const malformedLeasePath = join(dir, 'malformed-lease.db');
    const leaseStore = new SqliteDigestStore(malformedLeasePath);
    seed(leaseStore);
    expect(claim(leaseStore).kind).toBe('claimed');
    leaseStore.close();
    const malformedLease = new DatabaseSync(malformedLeasePath);
    malformedLease.prepare(
      "UPDATE gate_resolution SET lease_owner = 'https://secret.invalid/token', lease_expires_at = ?",
    ).run(LEASE_EXPIRY);
    malformedLease.close();
    expect(() => new SqliteDigestStore(malformedLeasePath)).toThrow(/lease_owner|lease owner/);

    const invalidLeaseIntervalPath = join(dir, 'invalid-lease-interval.db');
    const intervalStore = new SqliteDigestStore(invalidLeaseIntervalPath);
    seed(intervalStore);
    const intervalClaim = claim(intervalStore);
    if (intervalClaim.kind !== 'claimed') throw new Error('interval claim failed');
    const intervalAck = intervalStore.markGateResolutionAck(
      GATE,
      intervalClaim.intent.revision,
      'acked',
      AT,
    );
    if (intervalAck === null) throw new Error('interval ACK failed');
    expect(intervalStore.acquireGateResolutionLease(GATE, LEASE, AT, LEASE_EXPIRY).kind).toBe('acquired');
    intervalStore.close();
    const invalidInterval = new DatabaseSync(invalidLeaseIntervalPath);
    invalidInterval.prepare('UPDATE gate_resolution SET lease_expires_at = ?').run(
      '2026-08-24T09:59:59.999Z',
    );
    invalidInterval.close();
    expect(() => new SqliteDigestStore(invalidLeaseIntervalPath)).toThrow(/lifecycle evidence/);

    const invalidOwnershipPath = join(dir, 'invalid-mutation-ownership.db');
    const ownershipStore = new SqliteDigestStore(invalidOwnershipPath);
    seed(ownershipStore);
    expect(claim(ownershipStore).kind).toBe('claimed');
    ownershipStore.close();
    const invalidOwnership = new DatabaseSync(invalidOwnershipPath);
    invalidOwnership.prepare("UPDATE gate_resolution SET mutation_ownership = 'structured'").run();
    invalidOwnership.close();
    expect(() => new SqliteDigestStore(invalidOwnershipPath)).toThrow(/lifecycle evidence/);

    const invalidProjectionOwnerPath = join(dir, 'invalid-projection-owner.db');
    const projectionStore = new SqliteDigestStore(invalidProjectionOwnerPath);
    seed(projectionStore);
    expect(claim(projectionStore).kind).toBe('claimed');
    projectionStore.close();
    const invalidProjectionOwner = new DatabaseSync(invalidProjectionOwnerPath);
    invalidProjectionOwner.prepare(
      "UPDATE gate_resolution_outbox SET projection_owner = 'https://secret.invalid/token'",
    ).run();
    invalidProjectionOwner.close();
    expect(() => new SqliteDigestStore(invalidProjectionOwnerPath)).toThrow(
      /projection_owner|projection owner/,
    );
  });

  it('rejects unknown triggers and indexes on every code-owned D2 table', () => {
    new SqliteDigestStore(path).close();
    const triggerDb = new DatabaseSync(path);
    triggerDb.exec(`
      CREATE TRIGGER surprise_resolution_trigger
      AFTER UPDATE ON gate_resolution
      BEGIN
        UPDATE gate_resolution_outbox SET card_pending = 0 WHERE gate_key = NEW.gate_key;
      END;
    `);
    triggerDb.close();
    expect(() => new SqliteDigestStore(path)).toThrow(/schema object/);

    const indexPath = join(dir, 'unknown-metadata-index.db');
    new SqliteDigestStore(indexPath).close();
    const indexDb = new DatabaseSync(indexPath);
    indexDb.exec('CREATE INDEX surprise_metadata_index ON gate_metadata (ask_message_id)');
    indexDb.close();
    expect(() => new SqliteDigestStore(indexPath)).toThrow(/schema object/);
  });

  it('keeps a collect-missing sidecar fail-closed across concurrent registration and reopen', () => {
    const observer = new SqliteDigestStore(path);
    observer.insertGateMessage({
      gateKey: GATE,
      runKey: RUN,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      messageTs: MESSAGE_TS,
      renderFingerprint: 'fp',
      at: AT,
    });
    const registrar = new SqliteDigestStore(path);
    registrar.insertGateMetadata({
      gateKey: GATE,
      runKey: RUN,
      taskKey: TASK,
      dispatchKey: dispatchKey('ctx_d2c'),
      askMessageId: 'msg_d2c',
      questionThreadId: 'thread_d2c',
      options: [
        { id: 'keep', label: '현행 유지', description: '호환성을 유지한다', resolution: '현행 유지' },
        { id: 'change', label: '변경', description: '새 경로로 간다', resolution: '변경' },
      ],
      recommendation: { optionId: 'keep', reason: '호환성' },
      impact: '후속 구현 방향',
      registeredAt: AT,
    });
    observer.saveGateLocalObservation({
      gateKey: GATE,
      runKey: RUN,
      taskKey: TASK,
      status: 'pending',
      resolution: null,
      resolvedAt: null,
      metadataState: 'missing',
      mappingState: 'matched',
      observedAt: AT,
    });
    expect(observer.findGateLocalObservation(GATE)?.metadataState).toBe('mismatched');
    registrar.close();
    observer.close();
    const reopened = new SqliteDigestStore(path);
    expect(reopened.findGateLocalObservation(GATE)?.metadataState).toBe('mismatched');
    reopened.close();
  });

  it('startup validates all cross-table invariants from one WAL snapshot during a live commit', () => {
    const writer = new SqliteDigestStore(path);
    seed(writer);
    const claimed = claim(writer);
    if (claimed.kind !== 'claimed') throw new Error('claim failed');
    const acked = writer.markGateResolutionAck(GATE, claimed.intent.revision, 'acked', AT);
    if (acked === null) throw new Error('ACK failed');
    const leased = writer.acquireGateResolutionLease(GATE, LEASE, AT, LEASE_EXPIRY);
    if (leased.kind !== 'acquired') throw new Error('lease failed');
    let committed = false;
    const reader = new SqliteDigestStore(path, {
      validationFault: (point) => {
        if (point !== 'after_resolution_rows' || committed) return;
        committed = true;
        expect(writer.updateGateResolution(GATE, leased.intent.revision, LEASE, {
          lifecycle: 'uncertain', errorCode: 'validation_barrier', at: AT,
        })).not.toBeNull();
      },
    });
    expect(committed).toBe(true);
    reader.close();
    expect(writer.findGateResolution(GATE)?.lifecycle).toBe('uncertain');
    writer.close();
    expect(() => new SqliteDigestStore(path).close()).not.toThrow();
  });

  it('rejects a malformed ordinary completion before either correlated row can commit', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    expect(store.beginGateObservationWrite(GATE, AT)).toBe(true);

    expect(() => store.updateGateObservation(GATE, 'malformed-fingerprint', AT, {
      gateKey: GATE,
      runKey: RUN,
      taskKey: TASK,
      status: 'resolved',
      resolution: null,
      resolvedAt: null,
      metadataState: 'matched',
      mappingState: 'matched',
      observedAt: AT,
    } as never)).toThrow(/resolved|resolution/);
    expect(store.findGateMessage(GATE)?.renderFingerprint).toBe('fp');
    expect(store.findGateLocalObservation(GATE)).toMatchObject({
      status: 'pending', mappingState: 'write_pending',
    });
    store.close();

    const reopened = new SqliteDigestStore(path);
    expect(reopened.findGateMessage(GATE)?.renderFingerprint).toBe('fp');
    expect(reopened.findGateLocalObservation(GATE)?.mappingState).toBe('write_pending');
    reopened.close();
  });

  it('uses one strict lifecycle/evidence matrix at progress writes and startup', () => {
    const snapshot = {
      gateId: 'gate_d2c', runId: 'run_d2c', taskId: 'task_d2c',
      options: ['현행 유지', '변경'], status: 'pending' as const,
      resolution: null, resolvedAt: null,
    };
    const writeStore = new SqliteDigestStore(path);
    seed(writeStore);
    const writeClaim = claim(writeStore);
    if (writeClaim.kind !== 'claimed') throw new Error('write claim failed');
    const writeAck = writeStore.markGateResolutionAck(GATE, writeClaim.intent.revision, 'acked', AT);
    if (writeAck === null) throw new Error('write ACK failed');
    const writeLease = lease(writeStore);
    expect(() => writeStore.updateGateResolution(GATE, writeLease.revision, LEASE, {
      lifecycle: 'claimed', errorCode: 'stale_error', at: AT,
    })).toThrow(/lifecycle evidence/);
    expect(() => writeStore.updateGateResolution(GATE, writeLease.revision, LEASE, {
      lifecycle: 'uncertain', postRead: snapshot, errorCode: 'stale_post_read', at: AT,
    })).toThrow(/lifecycle evidence/);
    expect(writeStore.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'claimed', mutationOwnership: 'not_started', lastErrorCode: null, postRead: null,
    });
    writeStore.close();

    const corruptions = [
      {
        name: 'claimed-unknown',
        mutate: (db: DatabaseSync) => {
          db.prepare("UPDATE gate_resolution SET mutation_ownership = 'unknown'").run();
        },
      },
      {
        name: 'claimed-error',
        mutate: (db: DatabaseSync) => {
          db.prepare("UPDATE gate_resolution SET last_error_code = 'stale_error'").run();
        },
      },
    ];
    for (const corruption of corruptions) {
      const corruptPath = join(dir, `${corruption.name}.db`);
      const store = new SqliteDigestStore(corruptPath);
      seed(store);
      expect(claim(store).kind).toBe('claimed');
      store.close();
      const raw = new DatabaseSync(corruptPath);
      corruption.mutate(raw);
      raw.close();
      expect(() => new SqliteDigestStore(corruptPath)).toThrow(/lifecycle evidence/);
    }

    const stalePostPath = join(dir, 'nonterminal-stale-post.db');
    const stalePostStore = new SqliteDigestStore(stalePostPath);
    seed(stalePostStore);
    const staleClaim = claim(stalePostStore);
    if (staleClaim.kind !== 'claimed') throw new Error('stale-post claim failed');
    const staleAck = stalePostStore.markGateResolutionAck(GATE, staleClaim.intent.revision, 'acked', AT);
    if (staleAck === null) throw new Error('stale-post ACK failed');
    const staleLease = lease(stalePostStore);
    expect(stalePostStore.updateGateResolution(GATE, staleLease.revision, LEASE, {
      lifecycle: 'uncertain', errorCode: 'read_failed', at: AT,
    })).not.toBeNull();
    stalePostStore.close();
    const staleRaw = new DatabaseSync(stalePostPath);
    staleRaw.prepare('UPDATE gate_resolution SET post_read_json = ?').run(JSON.stringify(snapshot));
    staleRaw.close();
    expect(() => new SqliteDigestStore(stalePostPath)).toThrow(/lifecycle evidence/);
  });

  it('requires exactly one canonical winner audit and rejects orphan claimed audits', () => {
    const missingPath = join(dir, 'missing-winner-audit.db');
    const missingStore = new SqliteDigestStore(missingPath);
    seed(missingStore);
    expect(claim(missingStore).kind).toBe('claimed');
    expect(() => missingStore.recordGateAudit(
      GATE, 'claimed', 'first_valid_selection', AT,
    )).toThrow(/claim transaction/);
    missingStore.close();
    const missingRaw = new DatabaseSync(missingPath);
    missingRaw.prepare(
      "DELETE FROM gate_resolution_audit WHERE gate_key = ? AND event = 'claimed' AND reason = 'first_valid_selection'",
    ).run(GATE);
    missingRaw.close();
    expect(() => new SqliteDigestStore(missingPath)).toThrow(/winner audit.*정확히 하나/);

    const duplicatePath = join(dir, 'duplicate-winner-audit.db');
    const duplicateStore = new SqliteDigestStore(duplicatePath);
    seed(duplicateStore);
    expect(claim(duplicateStore).kind).toBe('claimed');
    duplicateStore.close();
    const duplicateRaw = new DatabaseSync(duplicatePath);
    duplicateRaw.prepare(
      `INSERT INTO gate_resolution_audit (gate_key, event, reason, created_at)
       VALUES (?, 'claimed', 'first_valid_selection', ?)`,
    ).run(GATE, AT);
    duplicateRaw.close();
    expect(() => new SqliteDigestStore(duplicatePath)).toThrow(/winner audit.*정확히 하나/);

    const orphanPath = join(dir, 'orphan-winner-audit.db');
    const orphanStore = new SqliteDigestStore(orphanPath);
    seed(orphanStore);
    orphanStore.close();
    const orphanRaw = new DatabaseSync(orphanPath);
    orphanRaw.prepare(
      `INSERT INTO gate_resolution_audit (gate_key, event, reason, created_at)
       VALUES (?, 'claimed', 'first_valid_selection', ?)`,
    ).run(GATE, AT);
    orphanRaw.close();
    expect(() => new SqliteDigestStore(orphanPath)).toThrow(/orphan claimed audit/);
  });
});

describe('Gate-local durable CAS and outbox', () => {
  it('first selection wins; exact retry reuses the first UUID; a different selection loses', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    try {
      const first = claim(store);
      const same = claim(store, 'keep', '22222222-2222-4222-8222-222222222222');
      const other = claim(store, 'change', '33333333-3333-4333-8333-333333333333');
      expect(first.kind).toBe('claimed');
      expect(same.kind).toBe('duplicate');
      expect(other.kind).toBe('lost');
      expect(store.findGateResolution(GATE)).toMatchObject({
        retryRequestId: REQUEST,
        optionId: 'keep',
        optionResolution: '현행 유지',
      });
      expect(store.listPendingGateOutboxes()).toEqual([
        expect.objectContaining({ gateKey: GATE, cardState: 'resolving', notificationState: 'pending' }),
      ]);
    } finally {
      store.close();
    }
  });

  it('resolved/stale observation과 모든 code-owned mapping mismatch를 fail-closed한다', () => {
    const stale = new SqliteDigestStore(path);
    seed(stale, 'resolved');
    expect(claim(stale)).toEqual({ kind: 'rejected', reason: 'stale_or_resolved' });
    stale.close();

    const staleDuplicate = new SqliteDigestStore(join(dir, 'stale-duplicate.db'));
    seed(staleDuplicate);
    expect(claim(staleDuplicate).kind).toBe('claimed');
    staleDuplicate.saveGateLocalObservation({
      gateKey: GATE,
      runKey: RUN,
      taskKey: TASK,
      status: 'resolved',
      resolution: '현행 유지',
      resolvedAt: AT,
      metadataState: 'matched',
      mappingState: 'matched',
      observedAt: AT,
    });
    const staleRetry = claim(
      staleDuplicate,
      'keep',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(staleRetry.kind).toBe('duplicate');
    if (staleRetry.kind !== 'duplicate') throw new Error('exact retry was not recovered');
    expect(staleRetry.intent.retryRequestId).toBe(REQUEST);
    expect(staleDuplicate.findGateResolution(GATE)?.retryRequestId).toBe(REQUEST);
    staleDuplicate.close();

    const cases = [
      { blockId: 'wrong', reason: 'unknown_block' },
      { actionId: 'wrong', reason: 'unknown_action' },
      { actionValue: 'unknown', actionId: gateActionId(GATE, 'unknown'), reason: 'unknown_or_ambiguous_option' },
      { threadTs: '1787554800.999999', reason: 'thread_identity_mismatch' },
    ];
    for (const [index, over] of cases.entries()) {
      const isolated = new SqliteDigestStore(join(dir, `invalid-${index}.db`));
      seed(isolated);
      const result = isolated.claimGateResolution({
        teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP',
        channelId: CHANNEL, threadTs: THREAD_TS, messageTs: MESSAGE_TS,
        blockId: gateBlockId(GATE), actionId: gateActionId(GATE, 'keep'), actionValue: 'keep',
        retryRequestId: REQUEST, at: AT, ...over,
      });
      expect(result).toEqual({ kind: 'rejected', reason: over.reason });
      expect(isolated.findGateResolution(GATE)).toBeNull();
      isolated.close();
    }
  });

  it('card outbox is replayable and D3 notification remains pending', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const claimed = claim(store);
    if (claimed.kind !== 'claimed') throw new Error('claim failed');
    const acked = store.markGateResolutionAck(GATE, claimed.intent.revision, 'acked', AT);
    if (acked === null) throw new Error('ACK persistence failed');
    const outbox = store.findGateResolutionOutbox(GATE);
    if (outbox === null) throw new Error('outbox missing');
    expect(store.acquireGateOutboxProjection(GATE, outbox.revision, PROJECTION_OWNER, AT)).toBe('acquired');
    store.markGateOutboxProjected(
      GATE, outbox.revision, 'resolution-fingerprint', PROJECTION_OWNER, AT,
    );
    expect(store.listPendingGateOutboxes()).toEqual([]);
    const leased = lease(store);
    store.updateGateResolution(GATE, leased.revision, LEASE, {
      lifecycle: 'uncertain', errorCode: 'read_failed', at: AT,
    });
    expect(store.listPendingGateOutboxes()).toEqual([
      expect.objectContaining({ cardState: 'degraded', notificationState: 'pending', cardPending: true }),
    ]);
    store.close();
  });

  it('a stale projection completion cannot clear a newer pending card generation', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const claimed = claim(store);
    if (claimed.kind !== 'claimed') throw new Error('claim failed');
    const acked = store.markGateResolutionAck(GATE, claimed.intent.revision, 'acked', AT);
    const stale = store.findGateResolutionOutbox(GATE);
    if (acked === null || stale === null) throw new Error('seed failed');
    expect(store.acquireGateOutboxProjection(GATE, stale.revision, PROJECTION_OWNER, AT)).toBe('acquired');
    const leased = lease(store);
    expect(store.updateGateResolution(GATE, leased.revision, LEASE, {
      lifecycle: 'uncertain', errorCode: 'pre_read_failed', at: AT,
    })).not.toBeNull();
    expect(store.markGateOutboxProjected(
      GATE, stale.revision, 'stale-fingerprint', PROJECTION_OWNER, AT,
    )).toBe(false);
    expect(store.listPendingGateOutboxes()).toEqual([
      expect.objectContaining({ cardState: 'degraded', cardPending: true, revision: stale.revision + 1 }),
    ]);
    expect(store.findGateMessage(GATE)?.renderFingerprint).toBe('fp');
    store.close();
  });

  it('terminal lifecycle state dominates a stale cross-process advance', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const claimed = claim(store);
    if (claimed.kind !== 'claimed') throw new Error('claim failed');
    const acked = store.markGateResolutionAck(GATE, claimed.intent.revision, 'acked', AT);
    if (acked === null) throw new Error('ACK failed');
    const snapshot = {
      gateId: 'gate_d2c', runId: 'run_d2c', taskId: 'task_d2c',
      options: ['현행 유지', '변경'], status: 'pending' as const,
      resolution: null, resolvedAt: null,
    };
    const leased = lease(store);
    const preRead = store.updateGateResolution(GATE, leased.revision, LEASE, {
      lifecycle: 'pre_read', preRead: snapshot, at: AT,
    });
    if (preRead === null) throw new Error('pre-read transition failed');
    const external = { ...snapshot, status: 'resolved' as const, resolution: '외부 결정', resolvedAt: AT };
    expect(store.updateGateResolution(GATE, preRead.revision, LEASE, {
      lifecycle: 'conflict', postRead: external, errorCode: 'external_resolution', at: AT,
    })?.lifecycle).toBe('conflict');
    expect(store.updateGateResolution(GATE, preRead.revision, LEASE, {
      lifecycle: 'resolving', at: AT,
    })).toBeNull();
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('conflict');
    store.close();
  });

  it('lease expiry is authoritative even when an unrelated live process reuses the owner PID', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const claimed = claim(store);
    if (claimed.kind !== 'claimed') throw new Error('claim failed');
    expect(store.markGateResolutionAck(GATE, claimed.intent.revision, 'acked', AT)).not.toBeNull();
    const firstOwner = `p${process.pid}.owner-one`;
    const secondOwner = `p${process.pid}.owner-two`;
    expect(store.acquireGateResolutionLease(GATE, firstOwner, AT, LEASE_EXPIRY).kind).toBe('acquired');
    expect(store.acquireGateResolutionLease(
      GATE, secondOwner, '2026-08-24T10:02:00.000Z', '2026-08-24T10:03:00.000Z',
    ).kind).toBe('acquired');
    store.close();
  });

  it('attempt/audit facts are append-only bounded and redact URL/token details', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    claim(store);
    for (let i = 0; i < 200; i += 1) {
      store.recordGateAttempt(
        GATE,
        'resolve',
        'failed',
        `https://secret.invalid/${i} response_url=https://hooks.slack.invalid/${i} ` +
          `xoxb-secret-${i} xapp-secret-${i}`,
        AT,
      );
      store.recordGateAudit(GATE, 'rejected', 'unknown_action', AT);
    }
    store.close();
    const raw = new DatabaseSync(path, { readOnly: true });
    const attempts = raw.prepare('SELECT detail FROM gate_resolution_attempt').all() as { readonly detail: string }[];
    const auditCount = raw.prepare('SELECT COUNT(*) AS count FROM gate_resolution_audit WHERE gate_key = ?').get(GATE) as { readonly count: number };
    expect(attempts).toHaveLength(128);
    expect(auditCount.count).toBe(128);
    expect(JSON.stringify(attempts)).not.toContain('secret.invalid');
    expect(JSON.stringify(attempts)).not.toContain('xoxb-secret');
    expect(JSON.stringify(attempts)).not.toContain('xapp-secret');
    expect(JSON.stringify(attempts)).not.toContain('hooks.slack.invalid');
    raw.close();
  });

  it('reserves bounded audit capacity so the first valid winner still commits', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    for (let index = 0; index < 128; index += 1) {
      store.recordGateAudit(GATE, 'rejected', 'unknown_action', AT);
    }
    expect(claim(store).kind).toBe('claimed');
    expect(store.findGateResolution(GATE)).not.toBeNull();
    expect(store.findGateResolutionOutbox(GATE)).not.toBeNull();
    store.close();
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare(
      'SELECT COUNT(*) AS count FROM gate_resolution_audit WHERE gate_key = ?',
    ).get(GATE)).toEqual({ count: 128 });
    expect(raw.prepare(
      "SELECT COUNT(*) AS count FROM gate_resolution_audit WHERE gate_key = ? AND event = 'claimed'",
    ).get(GATE)).toEqual({ count: 1 });
    raw.close();
  });
});
