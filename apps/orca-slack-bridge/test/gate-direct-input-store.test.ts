import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  gateActionId,
  gateBlockId,
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
  gateDirectCallbackId,
  gateDirectInputActionId,
  gateDirectInputBlockId,
} from '../src/gate/actions.js';
import {
  GATE_DIRECT_OPTION_ID,
  type GateDirectClaimInput,
  type GateDirectModalSession,
  type GateDirectPrepareInput,
} from '../src/gate/direct-input-types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import { SCHEMA_VERSION } from '../src/store/schema.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const GATE = gateKey('gate_d2d');
const RUN = runKey('run_d2d');
const TASK = taskKey('task_d2d');
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787641200.000001';
const MESSAGE_TS = '1787641200.000002';
const TEAM = 'T0TEAM';
const OWNER = 'U0OWNER';
const APP = 'A0APP';
const AT = '2026-08-25T10:00:00.000Z';
const LATER = '2026-08-25T10:00:01.000Z';
const SESSION_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REQUEST_1 = '11111111-1111-4111-8111-111111111111';
const REQUEST_2 = '22222222-2222-4222-8222-222222222222';
const EVENT_1 = 'a'.repeat(64);
const EVENT_2 = 'b'.repeat(64);
const RESOLUTION = '직접 입력한 최종 결정';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-gate-direct-store-'));
  path = join(dir, 'state.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function testPath(name: string): string {
  return join(dir, `${name}.db`);
}

function observation(status: 'pending' | 'resolved' = 'pending') {
  return {
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    status,
    resolution: status === 'resolved' ? '이미 결정됨' : null,
    resolvedAt: status === 'resolved' ? AT : null,
    metadataState: 'matched' as const,
    mappingState: 'matched' as const,
    observedAt: AT,
  };
}

function seed(store: SqliteDigestStore, status: 'pending' | 'resolved' = 'pending'): void {
  store.insertGateMetadata({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    dispatchKey: dispatchKey('ctx_d2d'),
    askMessageId: 'msg_d2d',
    questionThreadId: 'thread_d2d',
    options: [
      { id: 'keep', label: '현행 유지', description: '현재 경로를 유지한다', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '새 경로를 택한다', resolution: '변경' },
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
    renderFingerprint: 'pending-fingerprint',
    at: AT,
  });
  store.saveGateLocalObservation(observation(status));
}

function prepareInput(
  overrides: Partial<GateDirectPrepareInput> = {},
): GateDirectPrepareInput {
  return {
    sessionId: SESSION_1,
    buttonEventKey: EVENT_1,
    teamId: TEAM,
    ownerUserId: OWNER,
    apiAppId: APP,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
    blockId: gateDirectBlockId(GATE),
    actionId: gateDirectActionId(GATE),
    actionValue: gateDirectActionValue(GATE),
    at: AT,
    ...overrides,
  };
}

function prepare(store: SqliteDigestStore, overrides: Partial<GateDirectPrepareInput> = {}) {
  return store.prepareGateDirectModal(prepareInput(overrides));
}

function openPrepared(
  store: SqliteDigestStore,
  overrides: Partial<GateDirectPrepareInput> = {},
): GateDirectModalSession {
  const prepared = prepare(store, overrides);
  if (prepared.kind !== 'prepared') throw new Error(`prepare failed: ${prepared.kind}`);
  const opening = store.beginGateDirectModalOpen(
    prepared.session.sessionId,
    prepared.session.revision,
    AT,
  );
  if (opening === null) throw new Error('open CAS failed');
  const opened = store.finishGateDirectModalOpen(
    opening.sessionId,
    opening.revision,
    {
      kind: 'opened',
      viewId: overrides.sessionId === SESSION_2 ? 'V2' : 'V1',
      teamId: opening.teamId,
      apiAppId: opening.apiAppId,
      callbackId: opening.callbackId,
      privateMetadata: opening.sessionId,
    },
    LATER,
  );
  if (opened === null || opened.state !== 'opened') throw new Error('open finish failed');
  return opened;
}

function directClaimInput(
  session: GateDirectModalSession,
  overrides: Partial<GateDirectClaimInput> = {},
): GateDirectClaimInput {
  return {
    sessionId: session.sessionId,
    teamId: session.teamId,
    ownerUserId: session.ownerUserId,
    apiAppId: session.apiAppId,
    viewId: session.viewId ?? 'V1',
    callbackId: session.callbackId,
    privateMetadata: session.sessionId,
    inputBlockId: session.inputBlockId,
    inputActionId: session.inputActionId,
    resolutionText: RESOLUTION,
    retryRequestId: REQUEST_1,
    at: LATER,
    ...overrides,
  };
}

function claimDirect(
  store: SqliteDigestStore,
  session: GateDirectModalSession,
  overrides: Partial<GateDirectClaimInput> = {},
) {
  return store.claimGateDirectResolution(directClaimInput(session, overrides));
}

function claimFixed(
  store: SqliteDigestStore,
  optionId = 'keep',
  requestId = REQUEST_2,
) {
  return store.claimGateResolution({
    teamId: TEAM,
    ownerUserId: OWNER,
    apiAppId: APP,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
    blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, optionId),
    actionValue: optionId,
    retryRequestId: requestId,
    at: LATER,
  });
}

describe('D2-D durable modal schema', () => {
  it('migrates v9 additively and persists no raw trigger field', () => {
    new SqliteDigestStore(path).close();
    const v9 = new DatabaseSync(path);
    v9.exec('DROP TABLE gate_direct_modal; DROP TABLE gate_channel_delivery');
    v9.prepare('UPDATE schema_version SET version = 9 WHERE id = 1').run();
    v9.close();

    new SqliteDigestStore(path).close();
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(SCHEMA_VERSION).toBe(11);
    expect(raw.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({
      version: 11,
    });
    const columns = (raw.prepare('PRAGMA table_info(gate_direct_modal)').all() as {
      readonly name: string;
    }[]).map((row) => row.name);
    expect(columns).toContain('button_event_key');
    expect(columns).not.toContain('trigger_id');
    expect(columns.filter((name) => name.includes('trigger'))).toEqual([]);
    const indexes = (raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'gate_direct_modal'",
    ).all() as { readonly name: string }[]).map((row) => row.name);
    expect(indexes).toContain('gate_direct_modal_gate');
    raw.close();
  });

  it('rolls back the v9→v10 version step when the additive table creation fails', () => {
    new SqliteDigestStore(path).close();
    const conflicted = new DatabaseSync(path);
    conflicted.exec('DROP TABLE gate_direct_modal; DROP TABLE gate_channel_delivery');
    conflicted.prepare('UPDATE schema_version SET version = 9 WHERE id = 1').run();
    conflicted.exec('CREATE TABLE gate_direct_modal (unexpected TEXT)');
    conflicted.close();

    expect(() => new SqliteDigestStore(path)).toThrow(/gate_direct_modal/);
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare('SELECT version FROM schema_version WHERE id = 1').get()).toEqual({ version: 9 });
    expect(raw.prepare('PRAGMA table_info(gate_direct_modal)').all()).toEqual([
      expect.objectContaining({ name: 'unexpected' }),
    ]);
    raw.close();
  });

  it('rejects code-owned extra indexes and triggers at startup', () => {
    for (const [name, sql] of [
      ['index', 'CREATE INDEX gate_direct_modal_unknown ON gate_direct_modal (updated_at)'],
      [
        'trigger',
        `CREATE TRIGGER gate_direct_modal_trigger AFTER INSERT ON gate_direct_modal
         BEGIN SELECT 1; END`,
      ],
    ] as const) {
      const corruptPath = testPath(`unknown-${name}`);
      new SqliteDigestStore(corruptPath).close();
      const raw = new DatabaseSync(corruptPath);
      raw.exec(sql);
      raw.close();
      expect(() => new SqliteDigestStore(corruptPath)).toThrow(/current code-owned Gate shape/);
    }
  });
});

describe('direct button preparation and open fencing', () => {
  it('prepares only exact Gate/message/action correlation', () => {
    const cases: readonly [string, Partial<GateDirectPrepareInput>, string][] = [
      ['bad-session', { sessionId: 'not-a-uuid' }, 'invalid_modal_correlation'],
      ['bad-event-key', { buttonEventKey: 'raw-trigger-id' }, 'invalid_modal_correlation'],
      ['bad-team-shape', { teamId: 'team-secret' }, 'invalid_slack_identity'],
      ['unknown-message', { messageTs: '1787641200.999999' }, 'unknown_message'],
      ['wrong-thread', { threadTs: '1787641200.999999' }, 'thread_identity_mismatch'],
      ['wrong-block', { blockId: 'wrong' }, 'unknown_direct_block'],
      ['wrong-action', { actionId: 'wrong' }, 'unknown_direct_action'],
      ['wrong-value', { actionValue: 'wrong' }, 'unknown_direct_value'],
    ];
    for (const [name, overrides, reason] of cases) {
      const isolated = new SqliteDigestStore(testPath(name));
      seed(isolated);
      expect(prepare(isolated, overrides)).toEqual({ kind: 'rejected', reason });
      expect(isolated.findGateDirectModal(SESSION_1)).toBeNull();
      isolated.close();
    }
  });

  it('fails closed for missing/stale/mismatched mutable sidecar evidence', () => {
    const missingPath = testPath('missing-observation');
    const missingSeed = new SqliteDigestStore(missingPath);
    seed(missingSeed);
    missingSeed.close();
    const missingRaw = new DatabaseSync(missingPath);
    missingRaw.prepare('DELETE FROM gate_observation_generation WHERE gate_key = ?').run(GATE);
    missingRaw.prepare('DELETE FROM gate_local_observation WHERE gate_key = ?').run(GATE);
    missingRaw.close();
    const missing = new SqliteDigestStore(missingPath);
    expect(prepare(missing)).toEqual({ kind: 'rejected', reason: 'missing_sidecar_or_observation' });
    missing.close();

    const stale = new SqliteDigestStore(testPath('stale'));
    seed(stale, 'resolved');
    expect(prepare(stale)).toEqual({ kind: 'rejected', reason: 'stale_or_resolved' });
    stale.close();

    const mismatched = new SqliteDigestStore(testPath('mismatched'));
    seed(mismatched);
    mismatched.saveGateLocalObservation({
      ...observation(),
      metadataState: 'mismatched',
      observedAt: LATER,
    });
    expect(prepare(mismatched)).toEqual({ kind: 'rejected', reason: 'sidecar_not_matched' });
    mismatched.close();
  });

  it('deduplicates a button delivery by its server hash and preserves the first session UUID', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const first = prepare(store);
    const duplicate = prepare(store, { sessionId: SESSION_2 });
    const collision = prepare(store, { sessionId: SESSION_2, ownerUserId: 'U0OTHER' });
    expect(first.kind).toBe('prepared');
    expect(duplicate).toMatchObject({
      kind: 'duplicate',
      session: { sessionId: SESSION_1, buttonEventKey: EVENT_1, state: 'prepared' },
    });
    expect(collision).toEqual({ kind: 'rejected', reason: 'button_event_collision' });
    expect(store.findGateDirectModal(SESSION_2)).toBeNull();
    store.close();
  });

  it('revalidates mutable sidecars at the non-replayable open edge on exact redelivery', () => {
    const resolved = new SqliteDigestStore(testPath('resolved-before-open'));
    seed(resolved);
    expect(prepare(resolved).kind).toBe('prepared');
    expect(claimFixed(resolved).kind).toBe('claimed');
    expect(prepare(resolved, { sessionId: SESSION_2 }).kind).toBe('duplicate');
    expect(resolved.beginGateDirectModalOpen(SESSION_1, 0, LATER)).toBeNull();
    expect(resolved.findGateDirectModal(SESSION_1)).toMatchObject({ state: 'prepared', revision: 0 });
    resolved.close();

    const stale = new SqliteDigestStore(testPath('stale-before-open'));
    seed(stale);
    expect(prepare(stale).kind).toBe('prepared');
    stale.saveGateLocalObservation({
      ...observation(),
      metadataState: 'mismatched',
      observedAt: LATER,
    });
    expect(prepare(stale, { sessionId: SESSION_2 }).kind).toBe('duplicate');
    expect(stale.beginGateDirectModalOpen(SESSION_1, 0, LATER)).toBeNull();
    expect(stale.findGateDirectModal(SESSION_1)).toMatchObject({ state: 'prepared', revision: 0 });
    stale.close();
  });

  it('uses revision/state CAS around the one non-replayable views.open edge', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const prepared = prepare(store);
    if (prepared.kind !== 'prepared') throw new Error('prepare failed');
    expect(prepared.session).toMatchObject({ revision: 0, state: 'prepared', viewId: null });
    const opening = store.beginGateDirectModalOpen(SESSION_1, 0, AT);
    expect(opening).toMatchObject({ revision: 1, state: 'opening' });
    expect(store.beginGateDirectModalOpen(SESSION_1, 0, AT)).toBeNull();
    expect(store.finishGateDirectModalOpen(
      SESSION_1,
      0,
      {
        kind: 'opened', viewId: 'V1', teamId: TEAM, apiAppId: APP,
        callbackId: gateDirectCallbackId(GATE), privateMetadata: SESSION_1,
      },
      LATER,
    )).toBeNull();
    const opened = store.finishGateDirectModalOpen(
      SESSION_1,
      opening?.revision ?? -1,
      {
        kind: 'opened', viewId: 'V1', teamId: TEAM, apiAppId: APP,
        callbackId: gateDirectCallbackId(GATE), privateMetadata: SESSION_1,
      },
      LATER,
    );
    expect(opened).toMatchObject({
      revision: 2,
      state: 'opened',
      viewId: 'V1',
      openedAt: LATER,
      failureCode: null,
    });
    expect(store.finishGateDirectModalOpen(
      SESSION_1,
      opened?.revision ?? -1,
      { kind: 'failed', code: 'late_failure' },
      LATER,
    )).toBeNull();
    store.close();
  });

  it('records remote failure and every opened-response identity mismatch as terminal failed', () => {
    const cases = [
      { name: 'remote-failure', result: { kind: 'failed' as const, code: 'request_timeout' }, code: 'request_timeout' },
      {
        name: 'team-mismatch',
        result: {
          kind: 'opened' as const, viewId: 'V1', teamId: 'T0OTHER', apiAppId: APP,
          callbackId: gateDirectCallbackId(GATE), privateMetadata: SESSION_1,
        },
        code: 'response_identity_mismatch',
      },
      {
        name: 'app-mismatch',
        result: {
          kind: 'opened' as const, viewId: 'V1', teamId: TEAM, apiAppId: 'A0OTHER',
          callbackId: gateDirectCallbackId(GATE), privateMetadata: SESSION_1,
        },
        code: 'response_identity_mismatch',
      },
      {
        name: 'callback-mismatch',
        result: {
          kind: 'opened' as const, viewId: 'V1', teamId: TEAM, apiAppId: APP,
          callbackId: 'wrong', privateMetadata: SESSION_1,
        },
        code: 'response_identity_mismatch',
      },
      {
        name: 'private-metadata-mismatch',
        result: {
          kind: 'opened' as const, viewId: 'V1', teamId: TEAM, apiAppId: APP,
          callbackId: gateDirectCallbackId(GATE), privateMetadata: SESSION_2,
        },
        code: 'response_identity_mismatch',
      },
      {
        name: 'view-shape-mismatch',
        result: {
          kind: 'opened' as const, viewId: 'view-secret', teamId: TEAM, apiAppId: APP,
          callbackId: gateDirectCallbackId(GATE), privateMetadata: SESSION_1,
        },
        code: 'response_identity_mismatch',
      },
    ];
    for (const testCase of cases) {
      const store = new SqliteDigestStore(testPath(testCase.name));
      seed(store);
      const prepared = prepare(store);
      if (prepared.kind !== 'prepared') throw new Error('prepare failed');
      const opening = store.beginGateDirectModalOpen(SESSION_1, 0, AT);
      if (opening === null) throw new Error('begin failed');
      expect(store.finishGateDirectModalOpen(
        SESSION_1,
        opening.revision,
        testCase.result,
        LATER,
      )).toMatchObject({ state: 'failed', failureCode: testCase.code, viewId: null });
      expect(store.beginGateDirectModalOpen(SESSION_1, 2, LATER)).toBeNull();
      store.close();
    }
  });
});

describe('direct submission Gate-local winner', () => {
  it('atomically accepts the modal, writes the direct sentinel intent, audit, and outbox', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const session = openPrepared(store);
    const claimed = claimDirect(store, session);
    expect(claimed).toMatchObject({
      kind: 'claimed',
      intent: {
        gateKey: GATE,
        retryRequestId: REQUEST_1,
        optionId: GATE_DIRECT_OPTION_ID,
        optionResolution: RESOLUTION,
        blockId: gateDirectInputBlockId(GATE),
        actionId: gateDirectInputActionId(GATE),
        actionValue: SESSION_1,
        ackState: 'pending',
        lifecycle: 'claimed',
      },
    });
    expect(store.findGateDirectModal(SESSION_1)).toMatchObject({
      revision: 3,
      state: 'accepted',
      resolutionText: RESOLUTION,
      acceptedAt: LATER,
    });
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({
      cardState: 'resolving',
      cardPending: true,
      notificationState: 'pending',
    });
    const raw = new DatabaseSync(path, { readOnly: true });
    expect(raw.prepare(
      "SELECT COUNT(*) AS count FROM gate_resolution_audit WHERE gate_key = ? AND event = 'claimed'",
    ).get(GATE)).toEqual({ count: 1 });
    raw.close();
    store.close();
  });

  it('rejects unopened, unknown, malformed, and mismatched modal submissions without an intent', () => {
    const unknown = new SqliteDigestStore(testPath('unknown-session'));
    seed(unknown);
    expect(unknown.claimGateDirectResolution({
      ...directClaimInput({
        sessionId: SESSION_1,
        revision: 0,
        buttonEventKey: EVENT_1,
        gateKey: GATE,
        teamId: TEAM,
        ownerUserId: OWNER,
        apiAppId: APP,
        channelId: CHANNEL,
        threadTs: THREAD_TS,
        messageTs: MESSAGE_TS,
        blockId: gateDirectBlockId(GATE),
        actionId: gateDirectActionId(GATE),
        actionValue: gateDirectActionValue(GATE),
        callbackId: gateDirectCallbackId(GATE),
        inputBlockId: gateDirectInputBlockId(GATE),
        inputActionId: gateDirectInputActionId(GATE),
        state: 'opened',
        viewId: 'V1',
        failureCode: null,
        resolutionText: null,
        createdAt: AT,
        updatedAt: AT,
        openedAt: AT,
        acceptedAt: null,
      }),
    })).toEqual({ kind: 'rejected', reason: 'unknown_modal_session' });
    expect(unknown.findGateResolution(GATE)).toBeNull();
    unknown.close();

    const unopened = new SqliteDigestStore(testPath('unopened'));
    seed(unopened);
    const prepared = prepare(unopened);
    if (prepared.kind !== 'prepared') throw new Error('prepare failed');
    // A prepared session has no server-confirmed view id, so immutable identity validation
    // rejects it before the later lifecycle guard can be reached.
    expect(claimDirect(unopened, prepared.session)).toEqual({
      kind: 'rejected', reason: 'modal_identity_mismatch',
    });
    expect(unopened.findGateResolution(GATE)).toBeNull();
    unopened.close();

    const mismatches: readonly [string, Partial<GateDirectClaimInput>][] = [
      ['team', { teamId: 'T0OTHER' }],
      ['owner', { ownerUserId: 'U0OTHER' }],
      ['app', { apiAppId: 'A0OTHER' }],
      ['view', { viewId: 'V9' }],
      ['callback', { callbackId: 'wrong' }],
      ['private-metadata', { privateMetadata: SESSION_2 }],
      ['input-block', { inputBlockId: 'wrong' }],
      ['input-action', { inputActionId: 'wrong' }],
    ];
    for (const [name, override] of mismatches) {
      const store = new SqliteDigestStore(testPath(`claim-${name}`));
      seed(store);
      const session = openPrepared(store);
      expect(claimDirect(store, session, override)).toEqual({
        kind: 'rejected', reason: 'modal_identity_mismatch',
      });
      expect(store.findGateResolution(GATE)).toBeNull();
      store.close();
    }

    for (const [name, override] of [
      ['empty', { resolutionText: '' }],
      ['too-long', { resolutionText: '가'.repeat(3001) }],
      ['bad-request', { retryRequestId: 'not-a-uuid' }],
    ] as const) {
      const store = new SqliteDigestStore(testPath(`invalid-${name}`));
      seed(store);
      const session = openPrepared(store);
      expect(claimDirect(store, session, override)).toEqual({
        kind: 'rejected', reason: 'invalid_direct_claim',
      });
      expect(store.findGateResolution(GATE)).toBeNull();
      store.close();
    }
  });

  it('makes exact redelivery duplicate while preserving the first request UUID', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const session = openPrepared(store);
    expect(claimDirect(store, session).kind).toBe('claimed');
    const same = claimDirect(store, store.findGateDirectModal(SESSION_1) ?? session, {
      retryRequestId: REQUEST_2,
    });
    const differentText = claimDirect(store, store.findGateDirectModal(SESSION_1) ?? session, {
      resolutionText: '다른 직접 결정',
      retryRequestId: REQUEST_2,
    });
    expect(same).toMatchObject({
      kind: 'duplicate',
      intent: { retryRequestId: REQUEST_1, optionResolution: RESOLUTION },
    });
    expect(differentText).toMatchObject({
      kind: 'lost',
      intent: { retryRequestId: REQUEST_1, optionResolution: RESOLUTION },
    });
    store.close();
  });

  it('lets only the first of two opened direct sessions win even when their text is equal', () => {
    const store = new SqliteDigestStore(path);
    seed(store);
    const first = openPrepared(store);
    const second = openPrepared(store, {
      sessionId: SESSION_2,
      buttonEventKey: EVENT_2,
    });
    expect(claimDirect(store, first).kind).toBe('claimed');
    expect(claimDirect(store, second, {
      resolutionText: RESOLUTION,
      retryRequestId: REQUEST_2,
    })).toMatchObject({
      kind: 'lost',
      intent: { actionValue: SESSION_1, optionResolution: RESOLUTION },
    });
    expect(store.findGateDirectModal(SESSION_2)).toMatchObject({
      state: 'opened', resolutionText: null,
    });
    store.close();
  });

  it('rejects a new modal after a fixed winner or a terminal observation', () => {
    const fixed = new SqliteDigestStore(testPath('fixed-already-won'));
    seed(fixed);
    expect(claimFixed(fixed).kind).toBe('claimed');
    expect(prepare(fixed)).toEqual({ kind: 'rejected', reason: 'resolution_already_claimed' });
    fixed.close();

    const resolved = new SqliteDigestStore(testPath('already-resolved'));
    seed(resolved, 'resolved');
    expect(prepare(resolved)).toEqual({ kind: 'rejected', reason: 'stale_or_resolved' });
    resolved.close();
  });

  it('serializes fixed-option versus direct claims across independent store connections', () => {
    for (const directWins of [true, false]) {
      const sharedPath = testPath(directWins ? 'direct-first' : 'fixed-first');
      const firstConnection = new SqliteDigestStore(sharedPath);
      seed(firstConnection);
      const session = openPrepared(firstConnection);
      const secondConnection = new SqliteDigestStore(sharedPath);
      if (directWins) {
        expect(claimDirect(firstConnection, session).kind).toBe('claimed');
        expect(claimFixed(secondConnection)).toMatchObject({
          kind: 'lost', intent: { optionId: GATE_DIRECT_OPTION_ID, actionValue: SESSION_1 },
        });
      } else {
        expect(claimFixed(secondConnection).kind).toBe('claimed');
        expect(claimDirect(firstConnection, session)).toMatchObject({
          kind: 'lost', intent: { optionId: 'keep', actionValue: 'keep' },
        });
      }
      expect(firstConnection.findGateResolution(GATE)?.optionId).toBe(
        directWins ? GATE_DIRECT_OPTION_ID : 'keep',
      );
      expect(secondConnection.findGateResolution(GATE)?.optionId).toBe(
        directWins ? GATE_DIRECT_OPTION_ID : 'keep',
      );
      firstConnection.close();
      secondConnection.close();
    }
  });

  it('survives restart and becomes reconciliation-eligible only after durable ACK', () => {
    const first = new SqliteDigestStore(path);
    seed(first);
    const session = openPrepared(first);
    const claimed = claimDirect(first, session);
    if (claimed.kind !== 'claimed') throw new Error('direct claim failed');
    expect(first.listNonterminalGateResolutions()).toEqual([]);
    first.close();

    const afterClaimCrash = new SqliteDigestStore(path);
    expect(afterClaimCrash.findGateDirectModal(SESSION_1)).toMatchObject({ state: 'accepted' });
    const redelivery = claimDirect(
      afterClaimCrash,
      afterClaimCrash.findGateDirectModal(SESSION_1) ?? session,
      { retryRequestId: REQUEST_2 },
    );
    expect(redelivery).toMatchObject({
      kind: 'duplicate', intent: { retryRequestId: REQUEST_1, ackState: 'pending' },
    });
    if (redelivery.kind !== 'duplicate') throw new Error('redelivery was not recovered');
    expect(afterClaimCrash.markGateResolutionAck(
      GATE,
      redelivery.intent.revision,
      'acked',
      LATER,
    )).toMatchObject({ ackState: 'acked' });
    afterClaimCrash.close();

    const reconciler = new SqliteDigestStore(path);
    expect(reconciler.listNonterminalGateResolutions()).toEqual([
      expect.objectContaining({
        gateKey: GATE,
        optionId: GATE_DIRECT_OPTION_ID,
        retryRequestId: REQUEST_1,
        ackState: 'acked',
      }),
    ]);
    expect(reconciler.listAcknowledgedGateOutboxes()).toEqual([
      expect.objectContaining({ gateKey: GATE, cardPending: true, notificationState: 'pending' }),
    ]);
    reconciler.close();
  });
});

describe('direct modal startup integrity', () => {
  it('rejects corrupt lifecycle evidence and orphan Gate correlation', () => {
    const corruptLifecyclePath = testPath('corrupt-lifecycle');
    const lifecycleStore = new SqliteDigestStore(corruptLifecyclePath);
    seed(lifecycleStore);
    prepare(lifecycleStore);
    lifecycleStore.close();
    const corruptLifecycle = new DatabaseSync(corruptLifecyclePath);
    corruptLifecycle.exec('PRAGMA ignore_check_constraints = ON');
    corruptLifecycle.prepare(
      "UPDATE gate_direct_modal SET state = 'opened' WHERE session_id = ?",
    ).run(SESSION_1);
    corruptLifecycle.close();
    expect(() => new SqliteDigestStore(corruptLifecyclePath)).toThrow(
      /integrity|direct modal lifecycle evidence/,
    );

    const orphanPath = testPath('orphan-modal');
    const orphanStore = new SqliteDigestStore(orphanPath);
    seed(orphanStore);
    prepare(orphanStore);
    orphanStore.close();
    const orphan = new DatabaseSync(orphanPath);
    orphan.prepare(
      "UPDATE gate_direct_modal SET gate_key = 'gate:orphan' WHERE session_id = ?",
    ).run(SESSION_1);
    orphan.close();
    expect(() => new SqliteDigestStore(orphanPath)).toThrow(/direct modal correlation/);
  });

  it('rejects impossible revision/state evidence and invalid accepted resolution text', () => {
    const revisionPath = testPath('impossible-modal-revision');
    const revisionStore = new SqliteDigestStore(revisionPath);
    seed(revisionStore);
    openPrepared(revisionStore);
    revisionStore.close();
    const revisionRaw = new DatabaseSync(revisionPath);
    revisionRaw.exec('PRAGMA ignore_check_constraints = ON');
    revisionRaw.prepare('UPDATE gate_direct_modal SET revision = 0 WHERE session_id = ?').run(SESSION_1);
    revisionRaw.close();
    expect(() => new SqliteDigestStore(revisionPath)).toThrow(/integrity|lifecycle evidence/);

    const resolutionPath = testPath('invalid-accepted-resolution');
    const resolutionStore = new SqliteDigestStore(resolutionPath);
    seed(resolutionStore);
    const opened = openPrepared(resolutionStore);
    expect(claimDirect(resolutionStore, opened).kind).toBe('claimed');
    resolutionStore.close();
    const resolutionRaw = new DatabaseSync(resolutionPath);
    resolutionRaw.prepare(
      'UPDATE gate_direct_modal SET resolution_text = ? WHERE session_id = ?',
    ).run(' \n\t ', SESSION_1);
    resolutionRaw.prepare(
      'UPDATE gate_resolution SET option_resolution = ? WHERE gate_key = ?',
    ).run(' \n\t ', GATE);
    resolutionRaw.close();
    expect(() => new SqliteDigestStore(resolutionPath)).toThrow(/lifecycle evidence/);
  });
});
