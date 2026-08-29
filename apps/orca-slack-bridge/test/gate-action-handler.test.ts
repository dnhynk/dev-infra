import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GateActionHandler, type SlackSocketEvent } from '../src/gate/action-handler.js';
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import { GateResolutionEngine } from '../src/gate/resolve.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { SlackConfig } from '../src/project/config.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const GATE = gateKey('gate_action');
const RUN = runKey('run_action');
const TASK = taskKey('task_action');
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const AT = '2026-08-24T10:00:00.000Z';
const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];
const CONFIG: SlackConfig = {
  teamId: 'T0TEAM',
  apiAppId: 'A0APP',
  ownerUserIds: ['U0OWNER', 'U0SECOND'],
  channels: { prDigest: 'C0PRDIGEST', agentRuns: CHANNEL , decisions: CHANNEL },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-gate-action-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(store: SqliteDigestStore, over: {
  readonly status?: 'pending' | 'resolved' | 'unsupported';
  readonly metadataState?: 'matched' | 'missing' | 'mismatched';
  readonly mappingState?: 'matched' | 'missing' | 'mismatched';
} = {}): void {
  store.insertGateMetadata({
    source: 'registered',
    gateKey: GATE, runKey: RUN, taskKey: TASK, dispatchKey: dispatchKey('ctx_action'),
    askMessageId: 'msg_action', questionThreadId: 'thread_action',
    options: [
      { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '새 경로', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성' }, impact: '후속 방향', registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: GATE, runKey: RUN, channelId: CHANNEL, threadTs: THREAD_TS,
    messageTs: MESSAGE_TS, renderFingerprint: 'fp', at: AT,
  });
  const status = over.status ?? 'pending';
  store.saveGateLocalObservation({
    gateKey: GATE, runKey: RUN, taskKey: TASK, status,
    resolution: status === 'resolved' ? '외부 결정' : null,
    resolvedAt: status === 'resolved' ? AT : null,
    metadataState: over.metadataState ?? 'matched', mappingState: over.mappingState ?? 'matched', observedAt: AT,
  });
}

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'block_actions',
    api_app_id: 'A0APP',
    team: { id: 'T0TEAM', domain: 'ignored-human-name' },
    user: { id: 'U0OWNER', username: 'ignored-human-name' },
    container: {
      type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS,
      is_ephemeral: false,
    },
    channel: { id: CHANNEL, name: 'ignored-human-name' },
    message: { ts: MESSAGE_TS, thread_ts: THREAD_TS, text: 'NEVER PARSE THIS GATE PROSE' },
    actions: [{
      type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
      value: 'keep', action_ts: '1787554900.000001',
      text: { type: 'plain_text', text: 'ignored label' },
    }],
    response_url: 'https://hooks.slack.invalid/SECRET',
    trigger_id: 'SECRET-TRIGGER',
    ...over,
  };
}

function event(raw: unknown, ack: () => void | Promise<void>, type = 'interactive'): SlackSocketEvent {
  return { type, body: raw, ack };
}

function handler(
  store: SqliteDigestStore,
  engineCalls: string[],
  over: Partial<ConstructorParameters<typeof GateActionHandler>[0]> = {},
): GateActionHandler {
  let next = 0;
  return new GateActionHandler({
    config: CONFIG,
    store,
    engine: { resolveAndProject: async (key) => { engineCalls.push(key); } },
    now: () => new Date(AT),
    requestId: () => UUIDS[next++] ?? UUIDS[2]!,
    schedule: (job) => void job(),
    ...over,
  });
}

describe('fixed-option Slack Gate action boundary', () => {
  it('persists the winner before ACK and schedules remote work only after one timely ACK', async () => {
    const store = new SqliteDigestStore(join(dir, 'state.db'));
    seed(store);
    let acked = false;
    let ackCount = 0;
    let clock = 0;
    const engineCalls: string[] = [];
    const originalClaim = store.claimGateResolution.bind(store);
    vi.spyOn(store, 'claimGateResolution').mockImplementation((input) => {
      const result = originalClaim(input);
      expect(acked).toBe(false);
      clock = 200;
      return result;
    });
    const consumer = handler(store, engineCalls, { monotonic: () => clock });
    const outcome = await consumer.handle(event(body({ state: { values: {} } }), () => {
      ackCount += 1;
      expect(clock).toBeLessThan(3_000);
      expect(store.findGateResolution(GATE)?.retryRequestId).toBe(UUIDS[0]);
      expect(engineCalls).toEqual([]);
      acked = true;
    }));
    await Promise.resolve();
    expect(outcome).toBe('claimed');
    expect(ackCount).toBe(1);
    expect(engineCalls).toEqual([GATE]);
    store.close();
  });

  it('retries a transient two-connection writer lock during the pre-ACK winner claim', async () => {
    const path = join(dir, 'claim-writer-contention.db');
    const store = new SqliteDigestStore(path);
    seed(store);
    const locker = new DatabaseSync(path);
    locker.exec('BEGIN IMMEDIATE');
    const engineCalls: string[] = [];
    let acks = 0;
    const release = setTimeout(() => locker.exec('COMMIT'), 25);
    const outcome = await handler(store, engineCalls).handle(event(body(), () => { acks += 1; }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    clearTimeout(release);
    locker.close();

    expect(outcome).toBe('claimed');
    expect(acks).toBe(1);
    expect(store.findGateResolution(GATE)?.ackState).toBe('acked');
    expect(engineCalls).toEqual([GATE]);
    store.close();
  });

  it('retries transient writer contention while promoting the ACKed winner', async () => {
    const path = join(dir, 'ack-writer-contention.db');
    const store = new SqliteDigestStore(path);
    seed(store);
    const locker = new DatabaseSync(path);
    const engineCalls: string[] = [];
    let acks = 0;
    let release: ReturnType<typeof setTimeout> | null = null;
    const outcome = await handler(store, engineCalls).handle(event(body(), () => {
      acks += 1;
      locker.exec('BEGIN IMMEDIATE');
      release = setTimeout(() => locker.exec('COMMIT'), 25);
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (release !== null) clearTimeout(release);
    locker.close();

    expect(outcome).toBe('claimed');
    expect(acks).toBe(1);
    expect(store.findGateResolution(GATE)?.ackState).toBe('acked');
    expect(engineCalls).toEqual([GATE]);
    store.close();
  });

  it('ACKs promptly and audits fail-closed when claim contention exhausts local headroom', async () => {
    const path = join(dir, 'claim-writer-deadline.db');
    const store = new SqliteDigestStore(path);
    seed(store);
    const locker = new DatabaseSync(path);
    locker.exec('BEGIN IMMEDIATE');
    const engineCalls: string[] = [];
    let acks = 0;
    let ackElapsed = Number.POSITIVE_INFINITY;
    const began = performance.now();
    const outcome = await handler(store, engineCalls, {
      localCasDeadlineMs: 40,
      slackAckDeadlineMs: 200,
      sqliteBusyRetryMs: 5,
      // A stalled injected clock cannot turn bounded retry into an unbounded ACK delay.
      monotonic: () => 0,
    }).handle(event(body(), () => {
      acks += 1;
      ackElapsed = performance.now() - began;
      locker.exec('COMMIT');
    }));

    expect(outcome).toBe('store_failed');
    expect(acks).toBe(1);
    expect(ackElapsed).toBeLessThan(200);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)).toBeNull();
    expect(locker.prepare(
      'SELECT event, reason FROM gate_resolution_audit ORDER BY id DESC LIMIT 1',
    ).get()).toEqual({ event: 'store_failed', reason: 'claim_sqlite_busy_deadline' });
    locker.close();
    store.close();
  });

  it('keeps an ACKed-but-unpromoted winner non-runnable when writer contention outlives the deadline', async () => {
    const path = join(dir, 'ack-writer-deadline.db');
    const store = new SqliteDigestStore(path);
    seed(store);
    const locker = new DatabaseSync(path);
    const engineCalls: string[] = [];
    let acks = 0;
    let ackElapsed = Number.POSITIVE_INFINITY;
    let release: ReturnType<typeof setTimeout> | null = null;
    const began = performance.now();
    const outcome = await handler(store, engineCalls, {
      localCasDeadlineMs: 40,
      slackAckDeadlineMs: 80,
      sqliteBusyRetryMs: 5,
    }).handle(event(body(), () => {
      acks += 1;
      ackElapsed = performance.now() - began;
      locker.exec('BEGIN IMMEDIATE');
      release = setTimeout(() => locker.exec('COMMIT'), 120);
    }));
    await new Promise((resolve) => setTimeout(resolve, 130));
    if (release !== null) clearTimeout(release);

    expect(outcome).toBe('store_failed');
    expect(acks).toBe(1);
    expect(ackElapsed).toBeLessThan(80);
    expect(performance.now() - began).toBeLessThan(500);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)?.ackState).toBe('pending');
    expect(store.listNonterminalGateResolutions()).toEqual([]);
    locker.close();
    store.close();

    const restarted = new SqliteDigestStore(path);
    const remoteCalls: string[] = [];
    await new GateResolutionEngine({
      store: restarted,
      orca: { run: async () => { remoteCalls.push('orca'); return ''; } },
      slack: {
        post: async () => { remoteCalls.push('slack:post'); throw new Error('unexpected'); },
        update: async () => { remoteCalls.push('slack:update'); throw new Error('unexpected'); },
      },
      now: () => new Date(AT),
      leaseOwner: 't.ack-contention-restart',
    }).reconcile();
    expect(remoteCalls).toEqual([]);
    expect(restarted.findGateResolution(GATE)?.ackState).toBe('pending');
    restarted.close();
  });

  it('aborts a contended pre-ACK claim sleep, ACKs once, and never starts remote work', async () => {
    const path = join(dir, 'claim-writer-abort.db');
    const store = new SqliteDigestStore(path);
    seed(store);
    const locker = new DatabaseSync(path);
    locker.exec('BEGIN IMMEDIATE');
    const abort = new AbortController();
    const engineCalls: string[] = [];
    let acks = 0;
    const abortTimer = setTimeout(() => abort.abort(), 20);
    const outcome = await handler(store, engineCalls, {
      abortSignal: abort.signal,
      localCasDeadlineMs: 200,
      slackAckDeadlineMs: 300,
      sqliteBusyRetryMs: 10,
    }).handle(event(body(), () => {
      acks += 1;
      locker.exec('COMMIT');
    }));
    clearTimeout(abortTimer);

    expect(outcome).toBe('store_failed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)).toBeNull();
    expect(locker.prepare(
      'SELECT event, reason FROM gate_resolution_audit ORDER BY id DESC LIMIT 1',
    ).get()).toEqual({ event: 'store_failed', reason: 'claim_sqlite_busy_aborted' });
    locker.close();
    store.close();
  });

  it('aborts contended ACK promotion without authorizing the durable pending winner', async () => {
    const path = join(dir, 'ack-writer-abort.db');
    const store = new SqliteDigestStore(path);
    seed(store);
    const locker = new DatabaseSync(path);
    const abort = new AbortController();
    const engineCalls: string[] = [];
    let acks = 0;
    let release: ReturnType<typeof setTimeout> | null = null;
    const outcome = await handler(store, engineCalls, {
      abortSignal: abort.signal,
      localCasDeadlineMs: 200,
      slackAckDeadlineMs: 300,
      sqliteBusyRetryMs: 10,
    }).handle(event(body(), () => {
      acks += 1;
      locker.exec('BEGIN IMMEDIATE');
      setTimeout(() => abort.abort(), 20);
      release = setTimeout(() => locker.exec('COMMIT'), 40);
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (release !== null) clearTimeout(release);

    expect(outcome).toBe('store_failed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)?.ackState).toBe('pending');
    expect(store.listNonterminalGateResolutions()).toEqual([]);
    locker.close();
    store.close();
  });

  it('ACK throw, store failure, and both pre-ACK fault windows never start a remote operation', async () => {
    for (const mode of ['ack', 'store', 'before', 'after'] as const) {
      const store = new SqliteDigestStore(join(dir, `${mode}.db`));
      seed(store);
      const engineCalls: string[] = [];
      if (mode === 'store') vi.spyOn(store, 'claimGateResolution').mockImplementation(() => { throw new Error('disk full'); });
      const consumer = handler(store, engineCalls, {
        ...(mode === 'before' ? { fault: (point) => { if (point === 'before_local_cas') throw new Error('fault'); } } : {}),
        ...(mode === 'after' ? { fault: (point) => { if (point === 'after_local_cas_before_ack') throw new Error('fault'); } } : {}),
      });
      let acks = 0;
      const result = await consumer.handle(event(body(), () => {
        acks += 1;
        if (mode === 'ack') throw new Error('ack transport failed');
      }));
      expect(acks).toBe(1);
      expect(engineCalls).toEqual([]);
      expect(result).toBe(mode === 'ack' ? 'ack_failed' : 'store_failed');
      expect(store.findGateResolution(GATE) !== null).toBe(mode === 'ack' || mode === 'after');
      if (mode === 'ack') {
        expect(store.findGateResolution(GATE)?.ackState).toBe('failed');
        expect(store.listNonterminalGateResolutions()).toEqual([]);
      }
      if (mode === 'after') {
        expect(store.findGateResolution(GATE)?.ackState).toBe('acked');
        expect(store.listNonterminalGateResolutions()).toHaveLength(1);
      }
      store.close();
    }
  });

  it('a hard crash after CAS before ACK waits for exact Slack redelivery and reuses the winner UUID', async () => {
    const path = join(dir, 'crash-after-cas-before-ack.db');
    const first = new SqliteDigestStore(path);
    seed(first);
    const claimed = first.claimGateResolution({
      teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
      threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
      actionId: gateActionId(GATE, 'keep'), actionValue: 'keep', retryRequestId: UUIDS[0]!, at: AT,
    });
    expect(claimed.kind).toBe('claimed');
    expect(first.findGateResolution(GATE)?.ackState).toBe('pending');
    first.close();

    const reopened = new SqliteDigestStore(path);
    const remoteCalls: string[] = [];
    const startup = new GateResolutionEngine({
      store: reopened,
      orca: { run: async (args) => { remoteCalls.push(`orca:${args.join(' ')}`); return ''; } },
      slack: {
        post: async () => { remoteCalls.push('slack:post'); throw new Error('unexpected'); },
        update: async () => { remoteCalls.push('slack:update'); throw new Error('unexpected'); },
      },
      now: () => new Date(AT),
      leaseOwner: 't.ack-gap-startup',
    });
    await startup.reconcile();
    expect(remoteCalls).toEqual([]);
    expect(reopened.findGateResolution(GATE)?.ackState).toBe('pending');

    const engineCalls: string[] = [];
    let acks = 0;
    expect(await handler(reopened, engineCalls).handle(event(body(), () => { acks += 1; }))).toBe('duplicate');
    expect(acks).toBe(1);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      ackState: 'acked', retryRequestId: UUIDS[0],
    });
    expect(engineCalls).toEqual([GATE]);
    reopened.close();
  });

  it('rejects at the local deadline guard while still issuing the one ACK before three seconds', async () => {
    const store = new SqliteDigestStore(join(dir, 'deadline.db'));
    seed(store);
    const engineCalls: string[] = [];
    let reads = 0;
    let acks = 0;
    const consumer = handler(store, engineCalls, {
      monotonic: () => (reads++ === 0 ? 0 : 2_600),
    });
    expect(await consumer.handle(event(body(), () => {
      acks += 1;
      expect(reads).toBeGreaterThanOrEqual(2);
    }))).toBe('rejected');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)).toBeNull();
    store.close();
  });

  it('applies the absolute ingress deadline to a delayed ACK on the pre-CAS deadline path', async () => {
    const store = new SqliteDigestStore(join(dir, 'pre-cas-delayed-ack.db'));
    seed(store);
    const engineCalls: string[] = [];
    let clock = 0;
    let reads = 0;
    let acks = 0;
    const consumer = handler(store, engineCalls, {
      monotonic: () => (reads++ === 0 ? 0 : clock),
    });
    // The validation/local-deadline sample consumes 2.6 seconds. ACK completion after the
    // remaining 0.4-second budget is fail-closed even though ack() itself is still called once.
    clock = 2_600;
    expect(await consumer.handle(event(body(), () => {
      acks += 1;
      return new Promise<void>((resolve) => {
        setTimeout(() => { clock = 3_100; resolve(); }, 5);
      });
    }))).toBe('ack_failed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)).toBeNull();
    store.close();
  });

  it('a CAS that crosses three seconds is ACKed once but quarantined until a timely redelivery', async () => {
    const store = new SqliteDigestStore(join(dir, 'post-cas-deadline.db'));
    seed(store);
    const engineCalls: string[] = [];
    const ticks = [0, 100, 3_100];
    let index = 0;
    let acks = 0;
    const late = handler(store, engineCalls, {
      monotonic: () => ticks[index++] ?? 3_100,
    });
    expect(await late.handle(event(body(), () => { acks += 1; }))).toBe('ack_failed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)?.ackState).toBe('failed');
    expect(store.listNonterminalGateResolutions()).toEqual([]);

    expect(await handler(store, engineCalls).handle(event(body(), () => undefined))).toBe('duplicate');
    expect(store.findGateResolution(GATE)?.ackState).toBe('acked');
    expect(engineCalls).toEqual([GATE]);
    store.close();
  });

  it('a CAS completing inside the reserved ACK headroom is acknowledged once before three seconds', async () => {
    const store = new SqliteDigestStore(join(dir, 'post-cas-headroom.db'));
    seed(store);
    const engineCalls: string[] = [];
    const ticks = [0, 100, 2_900];
    let index = 0;
    let acks = 0;
    const consumer = handler(store, engineCalls, { monotonic: () => ticks[index++] ?? 2_900 });
    expect(await consumer.handle(event(body(), () => {
      acks += 1;
    }))).toBe('claimed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([GATE]);
    store.close();
  });

  it('a post-CAS clock failure is ACKed once and remains non-runnable', async () => {
    const store = new SqliteDigestStore(join(dir, 'post-cas-clock.db'));
    seed(store);
    const engineCalls: string[] = [];
    let reads = 0;
    let acks = 0;
    const consumer = handler(store, engineCalls, {
      monotonic: () => {
        reads += 1;
        if (reads === 3) throw new Error('clock unavailable');
        return reads === 1 ? 0 : 100;
      },
    });
    expect(await consumer.handle(event(body(), () => { acks += 1; }))).toBe('rejected');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)?.ackState).toBe('failed');
    expect(store.listNonterminalGateResolutions()).toEqual([]);
    store.close();
  });

  it('a non-finite post-CAS clock value is quarantined fail-closed', async () => {
    const store = new SqliteDigestStore(join(dir, 'post-cas-nan.db'));
    seed(store);
    const engineCalls: string[] = [];
    const ticks = [0, 100, Number.NaN];
    let index = 0;
    let acks = 0;
    const consumer = handler(store, engineCalls, {
      monotonic: () => ticks[index++] ?? Number.NaN,
    });
    expect(await consumer.handle(event(body(), () => { acks += 1; }))).toBe('ack_failed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)?.ackState).toBe('failed');
    store.close();
  });

  it('a delayed ACK completion that crosses three seconds never authorizes remote work', async () => {
    const store = new SqliteDigestStore(join(dir, 'delayed-ack.db'));
    seed(store);
    const engineCalls: string[] = [];
    let clock = 0;
    let acks = 0;
    const consumer = handler(store, engineCalls, { monotonic: () => clock });
    expect(await consumer.handle(event(body(), () => {
      acks += 1;
      return new Promise<void>((resolve) => {
        setTimeout(() => { clock = 3_100; resolve(); }, 5);
      });
    }))).toBe('ack_failed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)?.ackState).toBe('failed');
    store.close();
  });

  it('a stalled ACK is bounded by the remaining budget and remains non-runnable', async () => {
    const store = new SqliteDigestStore(join(dir, 'stalled-ack.db'));
    seed(store);
    const engineCalls: string[] = [];
    const ticks = [0, 100, 2_995];
    let index = 0;
    let acks = 0;
    const consumer = handler(store, engineCalls, {
      monotonic: () => ticks[index++] ?? 2_995,
    });
    expect(await consumer.handle(event(body(), () => {
      acks += 1;
      return new Promise<void>(() => undefined);
    }))).toBe('ack_failed');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)?.ackState).toBe('failed');
    store.close();
  });

  it('a successful concurrent duplicate upgrades failed ACK state and cannot be downgraded', async () => {
    const store = new SqliteDigestStore(join(dir, 'mixed-ack.db'));
    seed(store);
    const engineCalls: string[] = [];
    const consumer = handler(store, engineCalls);
    let rejectFirst!: (reason: Error) => void;
    const blockedAck = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const first = consumer.handle(event(body(), () => blockedAck));
    await Promise.resolve();
    const second = await consumer.handle(event(body(), () => undefined));
    rejectFirst(new Error('first ACK failed'));
    expect(await first).toBe('ack_failed');
    expect(second).toBe('duplicate');
    expect(store.findGateResolution(GATE)?.ackState).toBe('acked');
    expect(engineCalls).toEqual([GATE]);
    store.close();
  });

  it('simultaneous same selection reuses one durable request; different selection loses', async () => {
    const sameStore = new SqliteDigestStore(join(dir, 'same.db'));
    seed(sameStore);
    const sameCalls: string[] = [];
    const sameHandler = handler(sameStore, sameCalls);
    const same = await Promise.all([
      sameHandler.handle(event(body(), () => undefined)),
      sameHandler.handle(event(body({ user: { id: 'U0SECOND' } }), () => undefined)),
    ]);
    expect(same.sort()).toEqual(['claimed', 'duplicate']);
    expect(sameStore.findGateResolution(GATE)?.retryRequestId).toBe(UUIDS[0]);
    sameStore.close();

    const differentStore = new SqliteDigestStore(join(dir, 'different.db'));
    seed(differentStore);
    const differentCalls: string[] = [];
    const differentHandler = handler(differentStore, differentCalls);
    const differentAction = body();
    differentAction['actions'] = [{
      type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'change'),
      value: 'change', action_ts: '1787554900.000002', text: { type: 'plain_text', text: '변경' },
    }];
    const different = await Promise.all([
      differentHandler.handle(event(body(), () => undefined)),
      differentHandler.handle(event(differentAction, () => undefined)),
    ]);
    expect(different.sort()).toEqual(['claimed', 'lost']);
    expect(differentStore.findGateResolution(GATE)?.optionId).toBe('keep');
    differentStore.close();
  });

  it('api_app_id is optional only when the Bridge configuration does not pin one', async () => {
    const store = new SqliteDigestStore(join(dir, 'optional-app-id.db'));
    seed(store);
    const raw = body();
    delete raw['api_app_id'];
    const configWithoutAppId: SlackConfig = {
      teamId: CONFIG.teamId,
      ownerUserIds: CONFIG.ownerUserIds,
      channels: CONFIG.channels,
    };
    let acks = 0;
    expect(await handler(store, [], { config: configWithoutAppId }).handle(
      event(raw, () => { acks += 1; }),
    )).toBe('claimed');
    expect(acks).toBe(1);
    expect(store.findGateResolution(GATE)?.apiAppId).toBeNull();
    store.close();
  });

  it('every invalid identity/action/container/sidecar form ACKs once and never mutates Orca', async () => {
    const mutations: readonly ((raw: Record<string, unknown>) => void)[] = [
      (raw) => { raw['type'] = 'view_submission'; },
      (raw) => { raw['team'] = { id: 'TOTHER' }; },
      (raw) => { delete raw['team']; },
      (raw) => { raw['user'] = { id: 'UOTHER' }; },
      (raw) => { delete raw['user']; },
      (raw) => { raw['user'] = { id: 'U0OWNER', team_id: 'TOTHER' }; },
      (raw) => { raw['api_app_id'] = 'AOTHER'; },
      (raw) => { delete raw['api_app_id']; },
      (raw) => { raw['channel'] = { id: 'COTHER' }; },
      (raw) => { (raw['container'] as Record<string, unknown>)['channel_id'] = 'COTHER'; },
      (raw) => { (raw['container'] as Record<string, unknown>)['type'] = 'view'; },
      (raw) => { delete (raw['container'] as Record<string, unknown>)['is_ephemeral']; },
      (raw) => { (raw['container'] as Record<string, unknown>)['is_ephemeral'] = true; },
      (raw) => { (raw['container'] as Record<string, unknown>)['message_ts'] = '1787554800.9'; },
      (raw) => { (raw['container'] as Record<string, unknown>)['thread_ts'] = '1787554800.9'; },
      (raw) => { (raw['message'] as Record<string, unknown>)['ts'] = '1787554800.9'; },
      (raw) => { (raw['message'] as Record<string, unknown>)['thread_ts'] = '1787554800.9'; },
      (raw) => { delete (raw['message'] as Record<string, unknown>)['thread_ts']; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['block_id'] = 'wrong'; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['action_id'] = 'wrong'; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['value'] = 'unknown'; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['value'] = 'x'.repeat(65); },
      (raw) => { raw['actions'] = []; },
      (raw) => { raw['actions'] = 'not-an-array'; },
      (raw) => { raw['actions'] = [...(raw['actions'] as unknown[]), ...(raw['actions'] as unknown[])]; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['surprise'] = true; },
      (raw) => { raw['surprise'] = true; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['type'] = 'static_select'; },
      (raw) => { raw['state'] = 'not-an-object'; },
      (raw) => { raw['state'] = {}; },
      (raw) => { raw['state'] = { values: { modal_block: { input: { value: 'secret' } } } }; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const store = new SqliteDigestStore(join(dir, `invalid-${index}.db`));
      seed(store);
      const engineCalls: string[] = [];
      const consumer = handler(store, engineCalls);
      const raw = body();
      mutate(raw);
      let ackCount = 0;
      expect(await consumer.handle(event(raw, () => { ackCount += 1; }))).toBe('rejected');
      expect(ackCount).toBe(1);
      expect(engineCalls).toEqual([]);
      expect(store.findGateResolution(GATE)).toBeNull();
      store.close();
    }

    for (const [name, observation] of [
      ['stale', { status: 'resolved' as const }],
      ['unsupported', { status: 'unsupported' as const }],
      ['mismatched', { metadataState: 'mismatched' as const }],
      ['mapping-mismatched', { mappingState: 'mismatched' as const }],
    ] as const) {
      const store = new SqliteDigestStore(join(dir, `${name}.db`));
      seed(store, observation);
      const engineCalls: string[] = [];
      let acks = 0;
      expect(await handler(store, engineCalls).handle(event(body(), () => { acks += 1; }))).toBe('rejected');
      expect(acks).toBe(1);
      expect(engineCalls).toEqual([]);
      store.close();
    }

    const missingSidecar = new SqliteDigestStore(join(dir, 'missing-sidecar.db'));
    missingSidecar.insertGateMessage({
      gateKey: GATE, runKey: RUN, channelId: CHANNEL, threadTs: THREAD_TS,
      messageTs: MESSAGE_TS, renderFingerprint: 'fp', at: AT,
    });
    missingSidecar.saveGateLocalObservation({
      gateKey: GATE, runKey: RUN, taskKey: TASK, status: 'pending', resolution: null,
      resolvedAt: null, metadataState: 'missing', mappingState: 'matched', observedAt: AT,
    });
    let missingAcks = 0;
    expect(await handler(missingSidecar, []).handle(event(body(), () => { missingAcks += 1; }))).toBe('rejected');
    expect(missingAcks).toBe(1);
    missingSidecar.close();

    const missingObservation = new SqliteDigestStore(join(dir, 'missing-observation.db'));
    missingObservation.insertGateMetadata({
      source: 'registered',
      gateKey: GATE, runKey: RUN, taskKey: TASK, dispatchKey: dispatchKey('ctx_action'),
      askMessageId: 'msg_action', questionThreadId: 'thread_action',
      options: [{ id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' }],
      recommendation: { optionId: 'keep', reason: '호환성' }, impact: '후속 방향', registeredAt: AT,
    });
    missingObservation.insertGateMessage({
      gateKey: GATE, runKey: RUN, channelId: CHANNEL, threadTs: THREAD_TS,
      messageTs: MESSAGE_TS, renderFingerprint: 'fp', at: AT,
    });
    let missingObservationAcks = 0;
    expect(await handler(missingObservation, []).handle(event(
      body(),
      () => { missingObservationAcks += 1; },
    ))).toBe('rejected');
    expect(missingObservationAcks).toBe(1);
    missingObservation.close();

    const unknownMessageStore = new SqliteDigestStore(join(dir, 'unknown-message.db'));
    seed(unknownMessageStore);
    const unknown = body();
    const unknownTs = '1787554800.999999';
    unknown['container'] = { type: 'message', channel_id: CHANNEL, message_ts: unknownTs, is_ephemeral: false };
    unknown['message'] = { ts: unknownTs, thread_ts: THREAD_TS };
    let unknownAcks = 0;
    expect(await handler(unknownMessageStore, []).handle(event(unknown, () => { unknownAcks += 1; }))).toBe('rejected');
    expect(unknownAcks).toBe(1);
    unknownMessageStore.close();
  });

  it('normal Slack text/events are ACKed and ignored without storing raw payload secrets', async () => {
    const path = join(dir, 'ignored.db');
    const store = new SqliteDigestStore(path);
    seed(store);
    const engineCalls: string[] = [];
    let acks = 0;
    const result = await handler(store, engineCalls).handle(event(
      { type: 'events_api', event: { type: 'message', text: 'xoxb-DO-NOT-PERSIST' } },
      () => { acks += 1; },
      'events_api',
    ));
    expect(result).toBe('ignored');
    expect(acks).toBe(1);
    expect(engineCalls).toEqual([]);
    expect(store.findGateResolution(GATE)).toBeNull();
    store.close();
  });
});
