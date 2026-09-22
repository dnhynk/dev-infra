import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import {
  detectGateResumeEvidence,
  GateResumeEngine,
  normalizeGateResumeSnapshot,
} from '../src/channel/resume.js';
import {
  GateChannelDeliveryEngine,
  type GateChannelDeliveryTransport,
} from '../src/channel/delivery.js';
import type { ChannelDeliverySendResult } from '../src/channel/pipe-server.js';
import { publishGateCard } from '../src/gate/publish.js';
import { projectGateResolutionCard } from '../src/gate/resolution-project.js';
import type { GateResumeSnapshot, GateSnapshot } from '../src/gate/resolution-types.js';
import type { GateDecisionFacts } from '../src/gate/types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type {
  PostedMessage,
  PostMessageInput,
  SlackPoster,
  ThreadPoster,
  UpdateMessageInput,
} from '../src/slack/post.js';
import {
  GATE_V11_SCHEMA_OBJECTS,
  GATE_V12_SCHEMA_OBJECTS,
  SCHEMA_VERSION,
} from '../src/store/schema.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import type { OrcaRunner } from '../src/orca/client.js';
import {
  downgradeGateMetadataToV13,
  dropTerminalPromptTables,
} from './fixtures/schema-downgrade.js';

const GATE = gateKey('gate_resume_store');
const RUN = runKey('run_resume_store');
const TASK = taskKey('task_source');
const DISPATCH = 'ctx_source';
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const AT = '2026-08-24T10:00:00.000Z';
const SEED_AT = '2026-08-24T10:00:02.000Z';
const RECEIPT_AT = '2026-08-24T10:00:04.000Z';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-channel-resume-'));
  path = join(dir, 'state.db');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

class RecordingSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('D3-3 must never create a Slack identity'));
  }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return Promise.resolve({ channel: input.channel, ts: input.ts });
  }
}

class RejectingThread implements ThreadPoster {
  reply(): Promise<PostedMessage> {
    return Promise.reject(new Error('D3-3 must never create a Slack reply identity'));
  }
}

function ok(result: unknown): string {
  return JSON.stringify({ id: 'resume-engine', ok: true, result });
}

class MutableResumeOrca implements OrcaRunner {
  followup: 'pending' | 'dispatched' | 'completed' = 'pending';
  failBaseline = false;
  omitFollowupWorker = false;
  preexistingCompletedWorker = false;
  readonly calls: string[] = [];

  run(args: readonly string[]): Promise<string> {
    const command = args[1] ?? '';
    this.calls.push(command);
    if (this.failBaseline && (command === 'task-list' || command === 'worker-list')) {
      return Promise.reject(new Error('raw private baseline failure'));
    }
    const runId = RUN.slice('run:'.length);
    const sourceTaskId = TASK.slice('task:'.length);
    if (command === 'task-list') {
      const tasks = [
        {
          id: sourceTaskId, run_id: runId, status: 'completed', deps: '[]',
        },
        {
          id: 'task_followup', run_id: runId, status: this.followup,
          deps: JSON.stringify([sourceTaskId]),
          ...(this.followup === 'dispatched' ? { dispatch_id: 'ctx_followup' } : {}),
        },
        {
          id: 'task_unrelated', run_id: runId, status: 'dispatched', deps: '[]',
          dispatch_id: 'ctx_unrelated',
        },
      ];
      return Promise.resolve(ok({ runId, legacyReadOnly: false, count: tasks.length, tasks }));
    }
    if (command === 'worker-list') {
      const workers = [
        { dispatchId: DISPATCH, taskId: sourceTaskId, runId, dispatchStatus: 'completed' },
        { dispatchId: 'ctx_unrelated', taskId: 'task_unrelated', runId, dispatchStatus: 'dispatched' },
        ...((this.followup !== 'pending' || this.preexistingCompletedWorker) &&
          !this.omitFollowupWorker
          ? [{
              dispatchId: 'ctx_followup', taskId: 'task_followup', runId,
              dispatchStatus: this.followup === 'pending' ? 'completed' : this.followup,
            }]
          : []),
      ];
      return Promise.resolve(ok({ counts: { release_unknown: workers.length }, workers }));
    }
    if (command === 'dispatch-show') {
      const taskId = args[3];
      if (taskId === sourceTaskId) {
        return Promise.resolve(ok({ dispatch: {
          id: DISPATCH, task_id: sourceTaskId, run_id: runId, status: 'completed',
        } }));
      }
      return Promise.resolve(ok({ dispatch: {
        id: 'ctx_followup', task_id: 'task_followup', run_id: runId, status: this.followup,
      } }));
    }
    if (command === 'gate-list') {
      return Promise.resolve(ok({
        runId,
        count: 1,
        gates: [{
          id: pending.gateId, run_id: runId, task_id: sourceTaskId,
          question: '질문', options: JSON.stringify(pending.options), status: 'resolved',
          resolution: resolved.resolution, created_at: AT, resolved_at: resolved.resolvedAt,
        }],
      }));
    }
    return Promise.reject(new Error(`unexpected ${args.join(' ')}`));
  }
}

class HeldTaskResumeOrca extends MutableResumeOrca {
  readonly taskReadStarted: Promise<void>;
  readonly #taskReadReleased: Promise<void>;
  #markTaskReadStarted!: () => void;
  #releaseTaskRead!: () => void;
  #held = false;

  constructor() {
    super();
    this.taskReadStarted = new Promise<void>((resolve) => {
      this.#markTaskReadStarted = resolve;
    });
    this.#taskReadReleased = new Promise<void>((resolve) => {
      this.#releaseTaskRead = resolve;
    });
  }

  releaseTaskRead(): void {
    this.#releaseTaskRead();
  }

  override run(args: readonly string[]): Promise<string> {
    if (!this.#held && args[1] === 'task-list') {
      this.#held = true;
      this.#markTaskReadStarted();
      // Intentionally ignores AbortSignal. The cancelled owner must release its durable lease
      // before this external read settles, then remain fenced when the stale result arrives.
      return this.#taskReadReleased.then(() => super.run(args));
    }
    return super.run(args);
  }
}

class SkewedBaselineOrca extends MutableResumeOrca {
  taskReads = 0;

  override run(args: readonly string[]): Promise<string> {
    const command = args[1] ?? '';
    if (command === 'task-list') {
      this.taskReads += 1;
      this.followup = this.taskReads === 1 ? 'pending' : 'dispatched';
    } else if (command === 'worker-list') {
      this.followup = 'dispatched';
    }
    return super.run(args);
  }
}

type StableCutSkew = 'worker_newer_than_task' | 'task_newer_than_worker';

class StableCutSkewOrca extends MutableResumeOrca {
  skew: StableCutSkew | null = null;

  override run(args: readonly string[]): Promise<string> {
    const command = args[1] ?? '';
    if (this.skew === null || (command !== 'task-list' && command !== 'worker-list')) {
      return super.run(args);
    }
    this.calls.push(command);
    const runId = RUN.slice('run:'.length);
    const sourceTaskId = TASK.slice('task:'.length);
    if (command === 'task-list') {
      const taskIsNewer = this.skew === 'task_newer_than_worker';
      const tasks = [
        { id: sourceTaskId, run_id: runId, status: 'completed', deps: '[]' },
        {
          id: 'task_followup', run_id: runId,
          status: taskIsNewer ? 'dispatched' : 'pending',
          deps: JSON.stringify([sourceTaskId]),
          ...(taskIsNewer ? { dispatch_id: 'ctx_followup' } : {}),
        },
      ];
      return Promise.resolve(ok({ runId, legacyReadOnly: false, count: tasks.length, tasks }));
    }
    const workers = [
      { dispatchId: DISPATCH, taskId: sourceTaskId, runId, dispatchStatus: 'completed' },
      ...(this.skew === 'worker_newer_than_task'
        ? [{
            dispatchId: 'ctx_followup', taskId: 'task_followup', runId,
            dispatchStatus: 'dispatched',
          }]
        : []),
    ];
    return Promise.resolve(ok({ counts: { release_unknown: workers.length }, workers }));
  }
}

class BaselineCheckingTransport implements GateChannelDeliveryTransport {
  readonly calls: { runId: string; gateId: string }[] = [];
  constructor(private readonly store: SqliteDigestStore) {}
  deliverGate(runId: string, gateId: string): Promise<ChannelDeliverySendResult> {
    expect(this.store.findGateChannelDelivery(GATE)?.resumeBaselineState).toBe('recorded');
    expect(this.store.findGateResumeObservation(GATE)?.baseline).not.toBeNull();
    this.calls.push({ runId, gateId });
    return Promise.resolve({ kind: 'sent', epoch: 'epoch_resume', generation: 1 });
  }
}

class LegacyRecordingTransport implements GateChannelDeliveryTransport {
  readonly calls: { runId: string; gateId: string }[] = [];
  deliverGate(runId: string, gateId: string): Promise<ChannelDeliverySendResult> {
    this.calls.push({ runId, gateId });
    return Promise.resolve({ kind: 'sent', epoch: 'epoch_legacy', generation: 1 });
  }
}

const pending: GateSnapshot = {
  gateId: GATE.slice('gate:'.length),
  runId: RUN.slice('run:'.length),
  taskId: TASK.slice('task:'.length),
  options: ['유지', '변경'],
  status: 'pending',
  resolution: null,
  resolvedAt: null,
};
const resolved: GateSnapshot = {
  ...pending,
  status: 'resolved',
  resolution: '유지',
  resolvedAt: '2026-08-24T10:00:01.000Z',
};

const resolvedDecision: GateDecisionFacts = {
  key: GATE,
  gateId: GATE.slice('gate:'.length),
  runId: RUN.slice('run:'.length),
  taskId: TASK.slice('task:'.length),
  question: '질문',
  status: 'resolved',
  resolution: resolved.resolution,
  resolvedAt: resolved.resolvedAt,
  metadataState: 'matched',
  correlation: {
    askMessageId: 'msg_resume_store',
    questionThreadId: 'thread_resume_store',
    dispatchId: DISPATCH,
    taskId: TASK.slice('task:'.length),
    gateId: GATE.slice('gate:'.length),
  },
  options: [
    { id: 'keep', label: '유지', description: '유지', resolution: '유지' },
    { id: 'change', label: '변경', description: '변경', resolution: '변경' },
  ],
  recommendation: { optionId: 'keep', label: '유지', reason: '안전' },
  impact: '후속 방향',
  waitingTasks: [],
  independentTasks: [],
  unclassifiedTasks: [],
  degraded: [],
};

const baseline: GateResumeSnapshot = normalizeGateResumeSnapshot({
  schemaVersion: 1,
  sourceTaskId: TASK.slice('task:'.length),
  sourceDispatchId: DISPATCH,
  candidates: [
    {
      taskId: TASK.slice('task:'.length),
      status: 'completed',
      currentDispatchId: DISPATCH,
      dispatches: [{ dispatchId: DISPATCH, status: 'completed' }],
    },
    {
      taskId: 'task_followup',
      status: 'pending',
      currentDispatchId: null,
      dispatches: [],
    },
  ],
});
const sourceFact = baseline.candidates.find((candidate) => candidate.taskId === TASK.slice('task:'.length))!;

function resolveD2(store: SqliteDigestStore): void {
  store.insertGateMetadata({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    dispatchKey: dispatchKey(DISPATCH),
    source: 'registered',
    askMessageId: 'msg_resume_store',
    questionThreadId: 'thread_resume_store',
    options: [
      { id: 'keep', label: '유지', description: '유지', resolution: '유지' },
      { id: 'change', label: '변경', description: '변경', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '안전' },
    impact: '후속 방향',
    registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: GATE,
    runKey: RUN,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
    renderFingerprint: 'legacy-fingerprint',
    at: AT,
  });
  store.saveGateLocalObservation({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    status: 'pending', resolution: null, resolvedAt: null,
    metadataState: 'matched', mappingState: 'matched', observedAt: AT,
  });
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP',
    channelId: CHANNEL, threadTs: THREAD_TS, messageTs: MESSAGE_TS,
    blockId: gateBlockId(GATE), actionId: gateActionId(GATE, 'keep'), actionValue: 'keep',
    retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim ${claim.kind}`);
  const acked = store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('ack');
  const lease = store.acquireGateResolutionLease(
    GATE, 't.resume-d2', AT, '2026-08-24T10:01:00.000Z',
  );
  if (lease.kind !== 'acquired') throw new Error(`lease ${lease.kind}`);
  const pre = store.updateGateResolution(GATE, lease.intent.revision, 't.resume-d2', {
    lifecycle: 'pre_read', preRead: pending, at: AT,
  });
  const resolving = pre === null ? null : store.updateGateResolution(GATE, pre.revision, 't.resume-d2', {
    lifecycle: 'resolving', at: AT,
  });
  const post = resolving === null ? null : store.updateGateResolution(
    GATE,
    resolving.revision,
    't.resume-d2',
    {
      lifecycle: 'post_read',
      resolveResult: {
        gate: resolved,
        mutation: { requestId: '11111111-1111-4111-8111-111111111111', replayed: false },
      },
      at: AT,
    },
  );
  const done = post === null ? null : store.updateGateResolution(GATE, post.revision, 't.resume-d2', {
    lifecycle: 'resolved', postRead: resolved, at: AT,
  });
  if (done?.lifecycle !== 'resolved') throw new Error('resolve');
}

function seedAndBaseline(
  store: SqliteDigestStore,
  resumeBaseline: GateResumeSnapshot = baseline,
): void {
  const seed = store.seedPendingGateChannelDeliveries(SEED_AT, 1, () => true);
  if (seed.kind !== 'committed' || seed.deliveries.length !== 1) throw new Error('seed');
  const delivery = seed.deliveries[0]!;
  expect(delivery.resumeBaselineState).toBe('required');
  const lease = store.acquireGateChannelDeliveryLease(
    GATE, 't.resume-baseline', SEED_AT, '2026-08-24T10:01:02.000Z',
  );
  if (lease.kind !== 'acquired') throw new Error(`baseline lease ${lease.kind}`);
  const recorded = store.recordGateResumeBaseline(
    GATE, lease.delivery.revision, 't.resume-baseline', resumeBaseline, SEED_AT,
  );
  expect(recorded).toMatchObject({ resumeBaselineState: 'recorded', state: 'pending' });
  expect(store.releaseGateChannelDeliveryLease(GATE, 't.resume-baseline', SEED_AT)).toBe(true);
}

type LegacyDeliveryState = 'pending' | 'attempted' | 'receipted' | 'consumed';

function prepareLegacyDelivery(store: SqliteDigestStore, state: LegacyDeliveryState): void {
  resolveD2(store);
  seedAndBaseline(store);
  if (state === 'pending') return;
  expect(store.markGateChannelAttempted(
    GATE,
    '2026-08-24T10:00:03.000Z',
    '2026-08-24T10:00:05.000Z',
  )).toMatchObject({ state: 'attempted' });
  if (state === 'attempted') return;
  expect(store.markGateChannelReceipted(GATE, RECEIPT_AT)).toMatchObject({ state: 'receipted' });
  if (state === 'receipted') return;
  const lease = store.acquireGateChannelDeliveryLease(
    GATE,
    't.legacy-consume',
    RECEIPT_AT,
    '2026-08-24T10:01:04.000Z',
  );
  if (lease.kind !== 'acquired') throw new Error(`legacy consume lease ${lease.kind}`);
  expect(store.consumeGateChannelDelivery(
    GATE,
    lease.delivery.revision,
    't.legacy-consume',
    resolved,
    '2026-08-24T10:00:05.000Z',
  )).toMatchObject({ kind: 'consumed' });
}

function downgradeDeliveryDatabaseToV11(): string {
  const raw = new DatabaseSync(path);
  const legacyColumns = [
    'gate_key', 'run_key', 'task_key', 'source_dispatch_id', 'revision',
    'deferred_outbox_revision', 'state', 'attempt_count', 'last_attempt_at',
    'next_attempt_at', 'receipted_at', 'consumed_at', 'lease_owner', 'lease_expires_at',
    'last_error_code', 'created_at', 'updated_at',
  ] as const;
  const legacyRow = raw.prepare(
    `SELECT ${legacyColumns.join(', ')} FROM gate_channel_delivery WHERE gate_key = ?`,
  ).get(GATE) as Record<(typeof legacyColumns)[number], unknown>;
  raw.exec(`DROP TABLE gate_resume_observation;
    DROP TABLE slack_root_intent; DROP TABLE daemon_job_outcome; DROP TABLE daemon_health;
    DROP TABLE repository_discovery_issue; DROP TABLE orca_repository_binding;
    DROP TABLE repository_registry`);
  raw.exec('DROP TABLE gate_channel_delivery');
  for (const ddl of Object.values(GATE_V11_SCHEMA_OBJECTS)) raw.exec(ddl);
  raw.prepare(
    `INSERT INTO gate_channel_delivery (${legacyColumns.join(', ')})
     VALUES (${legacyColumns.map(() => '?').join(', ')})`,
  ).run(...legacyColumns.map((column) => legacyRow[column] as never));
  dropTerminalPromptTables(raw);
  downgradeGateMetadataToV13(raw);
  raw.prepare('UPDATE schema_version SET version = 11 WHERE id = 1').run();
  raw.exec('BEGIN');
  raw.exec("ALTER TABLE gate_channel_delivery ADD COLUMN resume_baseline_state TEXT NOT NULL DEFAULT 'unavailable' CHECK (resume_baseline_state IN ('unavailable','required','recorded'))");
  const migratedSql = (raw.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'gate_channel_delivery'",
  ).get() as { sql: string }).sql.replace(/\s+/g, ' ').trim();
  raw.exec('ROLLBACK');
  raw.close();
  return migratedSql;
}

describe('v12 durable resume evidence and existing-card projection', () => {
  it('commits the strict baseline before send, then observes an actual new Dispatch after restart', async () => {
    let nowMs = Date.parse(SEED_AT);
    const now = () => new Date(nowMs);
    const orca = new MutableResumeOrca();
    let store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    resolveD2(store);
    let transport = new BaselineCheckingTransport(store);
    let delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });

    await delivery.reconcile();
    expect(transport.calls).toEqual([{
      runId: RUN.slice('run:'.length), gateId: GATE.slice('gate:'.length),
    }]);
    expect(store.findGateResumeObservation(GATE)?.baseline.candidates.map(
      (candidate) => candidate.taskId,
    )).toEqual(['task_followup', TASK.slice('task:'.length)]);
    store.close();

    // Restart reuses the immutable pre-send baseline. The new descendant Dispatch exists only in
    // the targeted post-receipt reread and is confirmed by dispatch-show.
    store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    transport = new BaselineCheckingTransport(store);
    delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });
    nowMs += 10;
    delivery.recordAttempted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    nowMs += 10;
    delivery.recordReceipted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    orca.followup = 'dispatched';
    nowMs += 10;
    await delivery.reconcile();

    expect(store.findGateChannelDelivery(GATE)?.state).toBe('consumed');
    expect(store.findGateResumeObservation(GATE)).toMatchObject({
      evidence: {
        kind: 'new_dispatch', taskId: 'task_followup', dispatchId: 'ctx_followup',
        toStatus: 'dispatched',
      },
      nextObservationAt: null,
    });
    expect(orca.calls).toContain('dispatch-show');
    const slack = new RecordingSlack();
    expect(await projectGateResolutionCard(store, slack, GATE, now)).toMatchObject({
      kind: 'projected',
    });
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]).toMatchObject({ channel: CHANNEL, ts: MESSAGE_TS });
    expect(slack.updates[0]?.text).toContain('task_followup');
    expect(slack.updates[0]?.text).toContain('ctx_followup');
    store.close();
  });

  it('releases an aborted resume lease immediately and fences its late owner behind a successor', async () => {
    const observedAt = '2026-08-24T10:00:05.000Z';
    const nowMs = Date.parse(observedAt);
    const now = () => new Date(nowMs);
    const store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    const staleOrca = new HeldTaskResumeOrca();
    const successorOrca = new HeldTaskResumeOrca();
    successorOrca.followup = 'dispatched';
    const running: Promise<void>[] = [];
    try {
      prepareLegacyDelivery(store, 'consumed');
      expect(store.listDueGateResumeObservations(observedAt)).toHaveLength(1);

      const staleController = new AbortController();
      const staleRun = new GateResumeEngine({ store, orca: staleOrca, now }).reconcile(
        staleController.signal,
      );
      running.push(staleRun);
      await staleOrca.taskReadStarted;
      const staleLease = store.findGateResumeObservation(GATE);
      expect(staleLease).toMatchObject({
        evidence: null,
        leaseOwner: expect.stringMatching(/^p\d+\./),
      });
      if (staleLease?.leaseOwner === null || staleLease?.leaseOwner === undefined) {
        throw new Error('stale resume lease owner missing');
      }
      const staleOwner = staleLease.leaseOwner;
      const staleRevision = staleLease.revision;

      staleController.abort();
      const released = store.findGateResumeObservation(GATE);
      expect(released).toMatchObject({
        revision: staleRevision + 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        evidence: null,
        nextObservationAt: RECEIPT_AT,
      });
      expect(now().toISOString()).toBe(observedAt);
      if (released === null) throw new Error('resume lease release missing');

      const successorRun = new GateResumeEngine({ store, orca: successorOrca, now }).reconcile();
      running.push(successorRun);
      await successorOrca.taskReadStarted;
      const successorLease = store.findGateResumeObservation(GATE);
      expect(successorLease).toMatchObject({
        revision: released.revision + 1,
        leaseOwner: expect.stringMatching(/^p\d+\./),
        evidence: null,
      });
      expect(successorLease?.leaseOwner).not.toBe(staleOwner);
      expect(now().toISOString()).toBe(observedAt);

      expect(store.recordGateResumeObservation(
        GATE,
        staleRevision,
        staleOwner,
        baseline,
        null,
        observedAt,
        '2026-08-24T10:00:35.000Z',
        null,
      )).toBeNull();
      expect(store.releaseGateResumeLease(GATE, staleOwner, observedAt)).toBe(false);
      expect(store.findGateResumeObservation(GATE)).toEqual(successorLease);

      successorOrca.releaseTaskRead();
      await successorRun;
      const positive = store.findGateResumeObservation(GATE);
      expect(positive).toMatchObject({
        evidence: {
          kind: 'new_dispatch',
          taskId: 'task_followup',
          dispatchId: 'ctx_followup',
          fromStatus: 'pending',
          toStatus: 'dispatched',
        },
        nextObservationAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
      expect(successorOrca.calls).toContain('dispatch-show');
      expect(store.findGateResolutionOutbox(GATE)).toMatchObject({ cardPending: true });

      const slack = new RecordingSlack();
      expect(await projectGateResolutionCard(store, slack, GATE, now)).toMatchObject({
        kind: 'projected',
      });
      expect(slack.updates).toHaveLength(1);
      expect(slack.updates[0]).toMatchObject({ channel: CHANNEL, ts: MESSAGE_TS });
      expect(slack.updates[0]?.text).toContain('▶️ 작업 재개');
      expect(slack.updates[0]?.text).toContain('task_followup');
      expect(slack.updates[0]?.text).toContain('ctx_followup');

      const observationAfterSuccessor = store.findGateResumeObservation(GATE);
      const deliveryAfterSuccessor = store.findGateChannelDelivery(GATE);
      const outboxAfterSuccessor = store.findGateResolutionOutbox(GATE);
      staleOrca.releaseTaskRead();
      await staleRun;
      expect(store.findGateResumeObservation(GATE)).toEqual(observationAfterSuccessor);
      expect(store.findGateChannelDelivery(GATE)).toEqual(deliveryAfterSuccessor);
      expect(store.findGateResolutionOutbox(GATE)).toEqual(outboxAfterSuccessor);
      expect(slack.updates).toHaveLength(1);
    } finally {
      staleOrca.releaseTaskRead();
      successorOrca.releaseTaskRead();
      await Promise.allSettled(running);
      store.close();
    }
  });

  it('persists one new completed Dispatch when Task dispatch_id remains omitted', async () => {
    let nowMs = Date.parse(SEED_AT);
    const now = () => new Date(nowMs);
    const orca = new MutableResumeOrca();
    const store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    resolveD2(store);
    const transport = new BaselineCheckingTransport(store);
    const delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });

    await delivery.reconcile();
    expect(store.findGateResumeObservation(GATE)?.baseline.candidates).toMatchObject([
      { taskId: 'task_followup', status: 'pending', currentDispatchId: null },
      { taskId: TASK.slice('task:'.length), status: 'completed', currentDispatchId: null },
    ]);
    nowMs += 10;
    delivery.recordAttempted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    delivery.recordReceipted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    orca.followup = 'completed';
    nowMs += 10;
    await delivery.reconcile();

    expect(store.findGateResumeObservation(GATE)).toMatchObject({
      latest: {
        candidates: expect.arrayContaining([
          {
            taskId: 'task_followup',
            status: 'completed',
            currentDispatchId: null,
            dispatches: [{ dispatchId: 'ctx_followup', status: 'completed' }],
          },
        ]),
      },
      evidence: {
        kind: 'new_dispatch',
        taskId: 'task_followup',
        dispatchId: 'ctx_followup',
        toStatus: 'completed',
      },
    });
    expect(orca.calls).toContain('dispatch-show');
    store.close();
  });

  it('never sends when baseline rereads fail and restart without post-baseline evidence stays negative', async () => {
    let nowMs = Date.parse(SEED_AT);
    const now = () => new Date(nowMs);
    const orca = new MutableResumeOrca();
    orca.failBaseline = true;
    let store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    resolveD2(store);
    let transport = new BaselineCheckingTransport(store);
    let delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });
    await delivery.reconcile();
    expect(transport.calls).toEqual([]);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      resumeBaselineState: 'required', lastErrorCode: 'resume_baseline_read_failed',
    });
    expect(store.findGateResumeObservation(GATE)).toBeNull();
    store.close();

    // No send occurred, so a successful retry may still establish the baseline. Work already
    // present in that baseline is pre-existing and cannot be called resumed after receipt.
    nowMs += 1_000;
    orca.failBaseline = false;
    orca.followup = 'dispatched';
    store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    transport = new BaselineCheckingTransport(store);
    delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(1);
    nowMs += 10;
    delivery.recordAttempted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    delivery.recordReceipted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    nowMs += 10;
    await delivery.reconcile();
    expect(store.findGateResumeObservation(GATE)).toMatchObject({ evidence: null });
    expect(store.findGateResumeObservation(GATE)?.latest).not.toBeNull();
    expect(JSON.stringify(store.findGateResumeObservation(GATE))).not.toContain('raw private');
    store.close();
  });

  it('does not call Task catch-up to a pre-existing completed Dispatch resumed work', async () => {
    let nowMs = Date.parse(SEED_AT);
    const now = () => new Date(nowMs);
    const orca = new MutableResumeOrca();
    orca.preexistingCompletedWorker = true;
    const store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    resolveD2(store);
    const transport = new BaselineCheckingTransport(store);
    const delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });

    await delivery.reconcile();
    expect(store.findGateResumeObservation(GATE)?.baseline.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({
        taskId: 'task_followup', status: 'pending', currentDispatchId: null,
        dispatches: [{ dispatchId: 'ctx_followup', status: 'completed' }],
      })]),
    );
    nowMs += 10;
    delivery.recordAttempted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    delivery.recordReceipted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    orca.followup = 'completed';
    nowMs += 10;
    await delivery.reconcile();

    expect(store.findGateResumeObservation(GATE)).toMatchObject({ evidence: null });
    expect(store.findGateResumeObservation(GATE)?.latest).not.toBeNull();
    expect(store.findGateResolutionOutbox(GATE)?.cardPending).toBe(true);
    const slack = new RecordingSlack();
    await projectGateResolutionCard(store, slack, GATE, now);
    expect(slack.updates.at(-1)?.text).toContain(
      'Coordinator 확인됨 · 후속 Task 재개 미관찰',
    );
    expect(slack.updates.at(-1)?.text).not.toContain('▶️ 작업 재개');
    store.close();
  });

  it('fails baseline on a hidden completed current Dispatch, then treats worker catch-up as pre-existing', async () => {
    let nowMs = Date.parse(SEED_AT);
    const now = () => new Date(nowMs);
    const orca = new MutableResumeOrca();
    orca.followup = 'completed';
    orca.omitFollowupWorker = true;
    let store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    resolveD2(store);
    let transport = new BaselineCheckingTransport(store);
    let delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });

    await delivery.reconcile();
    expect(transport.calls).toEqual([]);
    expect(store.findGateResumeObservation(GATE)).toBeNull();
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      resumeBaselineState: 'required',
      state: 'pending',
      lastErrorCode: 'resume_baseline_read_failed',
    });
    store.close();

    nowMs += 1_000;
    orca.omitFollowupWorker = false;
    store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    transport = new BaselineCheckingTransport(store);
    delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });
    await delivery.reconcile();
    expect(transport.calls).toHaveLength(1);
    expect(store.findGateResumeObservation(GATE)?.baseline.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({
        taskId: 'task_followup',
        dispatches: [{ dispatchId: 'ctx_followup', status: 'completed' }],
      })]),
    );
    nowMs += 10;
    delivery.recordAttempted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    delivery.recordReceipted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    nowMs += 10;
    await delivery.reconcile();
    expect(store.findGateResumeObservation(GATE)).toMatchObject({ evidence: null });
    expect(store.findGateResumeObservation(GATE)?.latest).not.toBeNull();
    store.close();
  });

  it('rejects a hybrid Task/worker cut before persisting a baseline or sending', async () => {
    const now = () => new Date(SEED_AT);
    const orca = new SkewedBaselineOrca();
    const store = new SqliteDigestStore(path);
    resolveD2(store);
    const transport = new BaselineCheckingTransport(store);
    const delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });

    await delivery.reconcile();
    expect(orca.calls.filter((command) => command === 'task-list')).toHaveLength(2);
    expect(orca.calls.filter((command) => command === 'worker-list')).toHaveLength(1);
    expect(transport.calls).toEqual([]);
    expect(store.findGateResumeObservation(GATE)).toBeNull();
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      resumeBaselineState: 'required',
      state: 'pending',
      attemptCount: 0,
      lastErrorCode: 'resume_baseline_read_failed',
    });
    store.close();
  });

  it.each([
    'worker_newer_than_task',
    'task_newer_than_worker',
  ] as const)('fails closed on stable %s skew before baseline and transport', async (skew) => {
    const now = () => new Date(SEED_AT);
    const orca = new StableCutSkewOrca();
    orca.skew = skew;
    const store = new SqliteDigestStore(path);
    resolveD2(store);
    const transport = new BaselineCheckingTransport(store);
    const delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });

    await delivery.reconcile();
    expect(orca.calls.filter((command) => command === 'task-list')).toHaveLength(2);
    expect(orca.calls.filter((command) => command === 'worker-list')).toHaveLength(1);
    expect(transport.calls).toEqual([]);
    expect(store.findGateResumeObservation(GATE)).toBeNull();
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      resumeBaselineState: 'required',
      state: 'pending',
      attemptCount: 0,
      lastErrorCode: 'resume_baseline_read_failed',
    });
    store.close();
  });

  it.each([
    'worker_newer_than_task',
    'task_newer_than_worker',
  ] as const)('retries stable %s skew after receipt without persisting evidence', async (skew) => {
    let nowMs = Date.parse(SEED_AT);
    const now = () => new Date(nowMs);
    const orca = new StableCutSkewOrca();
    const store = new SqliteDigestStore(path, { monotonicNow: () => nowMs });
    resolveD2(store);
    const transport = new BaselineCheckingTransport(store);
    const delivery = new GateChannelDeliveryEngine({
      store, orca, transport, now, routeRetryMs: 1_000, receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });

    await delivery.reconcile();
    expect(transport.calls).toHaveLength(1);
    nowMs += 10;
    delivery.recordAttempted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    delivery.recordReceipted({
      gateId: GATE.slice('gate:'.length), runId: RUN.slice('run:'.length),
      consumerGeneration: 1, connectionEpoch: 'epoch_resume',
    });
    orca.skew = skew;
    nowMs += 10;
    await delivery.reconcile();

    const failed = store.findGateResumeObservation(GATE);
    expect(failed).toMatchObject({
      latest: null,
      evidence: null,
      lastErrorCode: 'resume_read_failed',
    });
    expect(failed?.nextObservationAt).not.toBeNull();
    expect(store.findGateChannelDelivery(GATE)?.state).toBe('consumed');
    // Baseline and failed latest cuts each targeted the completed source Task, but there is no
    // additional final positive-witness confirmation.
    expect(orca.calls.filter((command) => command === 'dispatch-show')).toHaveLength(2);
    expect(transport.calls).toHaveLength(1);

    orca.skew = null;
    nowMs += 30_000;
    await delivery.reconcile();
    expect(store.findGateResumeObservation(GATE)).toMatchObject({
      evidence: null,
      lastErrorCode: null,
    });
    expect(store.findGateResumeObservation(GATE)?.latest).not.toBeNull();
    expect(store.findGateChannelDelivery(GATE)?.state).toBe('consumed');
    expect(transport.calls).toHaveLength(1);
    store.close();
  });

  it('records the immutable baseline before transport state and survives restart without raw payloads', () => {
    let store = new SqliteDigestStore(path);
    resolveD2(store);
    seedAndBaseline(store);
    expect(store.findGateResumeObservation(GATE)).toMatchObject({
      revision: 0,
      evidence: null,
      nextObservationAt: null,
      baseline,
    });
    store.close();

    const raw = new DatabaseSync(path, { readOnly: true });
    const json = raw.prepare(
      'SELECT baseline_json FROM gate_resume_observation WHERE gate_key = ?',
    ).get(GATE) as { baseline_json: string };
    expect(json.baseline_json).not.toContain('worker payload secret');
    expect(Object.keys(JSON.parse(json.baseline_json) as object).sort()).toEqual([
      'candidates', 'schemaVersion', 'sourceDispatchId', 'sourceTaskId',
    ]);
    raw.close();

    store = new SqliteDigestStore(path);
    expect(store.findGateChannelDelivery(GATE)?.resumeBaselineState).toBe('recorded');
    expect(store.findGateResumeObservation(GATE)?.baseline).toEqual(baseline);
    store.close();
  });

  it.each([
    { label: 'negative observation', latest: baseline, errorCode: null },
    { label: 'read failure', latest: null, errorCode: 'resume_read_failed' },
  ])('restores the $label logical clock floor without making its future retry immediately due', ({
    latest,
    errorCode,
  }) => {
    let monotonicMs = 0;
    let store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    resolveD2(store);
    seedAndBaseline(store);
    store.markGateChannelAttempted(GATE, '2026-08-24T10:00:03.000Z', RECEIPT_AT);
    store.markGateChannelReceipted(GATE, RECEIPT_AT);
    const due = store.listDueGateResumeObservations(RECEIPT_AT);
    const lease = store.acquireGateResumeLease(
      GATE,
      due[0]!.revision,
      't.resume-clock',
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:01:00.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error(`resume clock lease ${lease.kind}`);
    expect(store.recordGateResumeObservation(
      GATE,
      lease.observation.revision,
      't.resume-clock',
      latest,
      null,
      '2026-08-24T12:00:00.000Z',
      '2026-08-24T12:00:30.000Z',
      errorCode,
    )).toMatchObject({
      updatedAt: '2026-08-24T12:00:00.000Z',
      nextObservationAt: '2026-08-24T12:00:30.000Z',
      lastErrorCode: errorCode,
    });
    expect(store.findGateChannelDelivery(GATE)?.updatedAt).toBe(RECEIPT_AT);
    store.close();

    // The wall sample rolled back two hours. Reopen restores only the persisted logical "now"
    // (updated_at), not the future schedule, then advances it with the monotonic source.
    monotonicMs = 0;
    store = new SqliteDigestStore(path, { monotonicNow: () => monotonicMs });
    const rollbackWall = '2026-08-24T10:00:00.000Z';
    expect(store.listDueGateResumeObservations(rollbackWall)).toEqual([]);
    expect(store.findGateResumeObservation(GATE)?.nextObservationAt).toBe(
      '2026-08-24T12:00:30.000Z',
    );
    monotonicMs = 29_999;
    expect(store.listDueGateResumeObservations(rollbackWall)).toEqual([]);
    monotonicMs = 30_000;
    expect(store.listDueGateResumeObservations(rollbackWall)).toHaveLength(1);
    store.close();
  });

  it('persists and reopens one omitted-current non-running to completed transition', () => {
    const transitionBaseline = normalizeGateResumeSnapshot({
      schemaVersion: 1,
      sourceTaskId: TASK.slice('task:'.length),
      sourceDispatchId: DISPATCH,
      candidates: [
        sourceFact,
        {
          taskId: 'task_followup', status: 'ready', currentDispatchId: null,
          dispatches: [{ dispatchId: 'ctx_existing', status: 'failed' }],
        },
      ],
    });
    const latest = normalizeGateResumeSnapshot({
      ...transitionBaseline,
      candidates: [
        sourceFact,
        {
          taskId: 'task_followup', status: 'completed', currentDispatchId: null,
          dispatches: [{ dispatchId: 'ctx_existing', status: 'completed' }],
        },
      ],
    });
    const evidence = detectGateResumeEvidence(transitionBaseline, latest);
    expect(evidence).toEqual({
      kind: 'status_transition',
      taskId: 'task_followup',
      dispatchId: 'ctx_existing',
      fromStatus: 'ready',
      toStatus: 'completed',
    });
    if (evidence === null) throw new Error('transition evidence missing');

    let store = new SqliteDigestStore(path);
    resolveD2(store);
    seedAndBaseline(store, transitionBaseline);
    store.markGateChannelAttempted(GATE, '2026-08-24T10:00:03.000Z', RECEIPT_AT);
    store.markGateChannelReceipted(GATE, RECEIPT_AT);
    const due = store.listDueGateResumeObservations(RECEIPT_AT);
    const lease = store.acquireGateResumeLease(
      GATE, due[0]!.revision, 't.resume-transition', RECEIPT_AT,
      '2026-08-24T10:01:04.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error(`resume transition lease ${lease.kind}`);
    expect(store.recordGateResumeObservation(
      GATE,
      lease.observation.revision,
      't.resume-transition',
      latest,
      evidence,
      '2026-08-24T10:00:05.000Z',
      '2026-08-24T10:00:35.000Z',
      null,
    )).toMatchObject({ evidence, nextObservationAt: null });
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.findGateResumeObservation(GATE)).toMatchObject({ evidence });
    expect(store.findGateChannelDelivery(GATE)?.deferredOutboxRevision).toBe(
      store.findGateResolutionOutbox(GATE)?.revision,
    );
    store.close();
  });

  it('rejects stale CAS and atomically rearms only one positive Task/Dispatch witness', async () => {
    let store = new SqliteDigestStore(path);
    resolveD2(store);
    seedAndBaseline(store);
    store.markGateChannelAttempted(GATE, '2026-08-24T10:00:03.000Z', RECEIPT_AT);
    store.markGateChannelReceipted(GATE, RECEIPT_AT);
    const due = store.listDueGateResumeObservations(RECEIPT_AT);
    expect(due).toHaveLength(1);
    const lease = store.acquireGateResumeLease(
      GATE, due[0]!.revision, 't.resume-observer', RECEIPT_AT, '2026-08-24T10:01:04.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error(`resume lease ${lease.kind}`);
    const latest: GateResumeSnapshot = {
      ...baseline,
      candidates: [
        sourceFact,
        {
          taskId: 'task_followup', status: 'dispatched', currentDispatchId: 'ctx_followup',
          dispatches: [{ dispatchId: 'ctx_followup', status: 'dispatched' }],
        },
      ],
    };
    const outboxBefore = store.findGateResolutionOutbox(GATE)!;
    expect(store.recordGateResumeObservation(
      GATE,
      lease.observation.revision - 1,
      't.resume-observer',
      latest,
      {
        kind: 'new_dispatch', taskId: 'task_followup', dispatchId: 'ctx_followup',
        fromStatus: 'pending', toStatus: 'dispatched',
      },
      '2026-08-24T10:00:05.000Z',
      '2026-08-24T10:00:35.000Z',
      null,
    )).toBeNull();
    expect(store.findGateResolutionOutbox(GATE)?.revision).toBe(outboxBefore.revision);

    const positive = store.recordGateResumeObservation(
      GATE,
      lease.observation.revision,
      't.resume-observer',
      latest,
      {
        kind: 'new_dispatch', taskId: 'task_followup', dispatchId: 'ctx_followup',
        fromStatus: 'pending', toStatus: 'dispatched',
      },
      '2026-08-24T10:00:05.000Z',
      '2026-08-24T10:00:35.000Z',
      null,
    );
    expect(positive).toMatchObject({
      evidence: { taskId: 'task_followup', dispatchId: 'ctx_followup' },
      nextObservationAt: null,
    });
    const delivery = store.findGateChannelDelivery(GATE)!;
    const outbox = store.findGateResolutionOutbox(GATE)!;
    expect(delivery.deferredOutboxRevision).toBe(outbox.revision);
    expect(outbox.cardPending).toBe(true);

    const slack = new RecordingSlack();
    await expect(projectGateResolutionCard(
      store,
      slack,
      GATE,
      () => new Date('2026-08-24T10:00:06.000Z'),
      (point) => {
        if (point === 'after_slack_success_before_local_completion') {
          throw new Error('simulated D3 projection crash');
        }
      },
    )).rejects.toThrow('simulated D3 projection crash');
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]).toMatchObject({ channel: CHANNEL, ts: MESSAGE_TS });
    expect(slack.updates[0]?.text).toContain('▶️ 작업 재개');
    expect(slack.updates[0]?.text).toContain('task_followup');
    expect(slack.updates[0]?.text).toContain('ctx_followup');
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({ cardPending: true });
    store.close();

    // Restart repairs the same durable Slack identity. Repeating chat.update is idempotent and
    // cannot open the non-idempotent reply-success ambiguity window.
    store = new SqliteDigestStore(path);
    expect(await projectGateResolutionCard(
      store, slack, GATE, () => new Date('2026-08-24T10:00:07.000Z'),
    )).toMatchObject({ kind: 'projected' });
    expect(slack.updates).toHaveLength(2);
    expect(slack.updates.every((update) =>
      update.channel === CHANNEL && update.ts === MESSAGE_TS
    )).toBe(true);

    // The ordinary observer fallback must render the same durable D3 evidence and remain current.
    const fallback = await publishGateCard({
      store,
      slack,
      thread: new RejectingThread(),
      channel: CHANNEL,
      now: () => new Date('2026-08-24T10:00:08.000Z'),
    }, RUN, THREAD_TS, resolvedDecision);
    expect(fallback).toMatchObject({ action: 'skip', messageTs: MESSAGE_TS });
    expect(fallback.card.text).toContain('▶️ 작업 재개');
    expect(fallback.card.text).not.toContain('Coordinator 통지 대기');
    expect(slack.updates).toHaveLength(2);
    store.close();
  });

  it.each([
    'pending',
    'attempted',
    'receipted',
    'consumed',
  ] as const)('migrates and reopens an authentic v11 %s delivery without losing D3-2 liveness', async (
    legacyState,
  ) => {
    let store = new SqliteDigestStore(path);
    prepareLegacyDelivery(store, legacyState);
    store.close();

    const migratedSql = downgradeDeliveryDatabaseToV11();
    expect(migratedSql).toBe(
      GATE_V12_SCHEMA_OBJECTS['gate_channel_delivery']!.replace(/\s+/g, ' ').trim(),
    );

    const nowAt = '2026-08-24T11:00:00.000Z';
    store = new SqliteDigestStore(path);
    expect(SCHEMA_VERSION).toBe(16);
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      resumeBaselineState: 'unavailable',
      state: legacyState,
    });
    expect(store.findGateResumeObservation(GATE)).toBeNull();
    expect(store.listDueGateChannelDeliveries(nowAt)).toHaveLength(
      legacyState === 'consumed' ? 0 : 1,
    );

    const slack = new RecordingSlack();
    await projectGateResolutionCard(store, slack, GATE, () => new Date(nowAt));
    expect(slack.updates.at(-1)?.text).toContain(
      legacyState === 'pending' || legacyState === 'attempted'
        ? 'Coordinator 통지 대기'
        : 'Coordinator 확인됨 · 후속 Task 재개 미관찰',
    );
    expect(slack.updates.at(-1)?.text).not.toContain('▶️ 작업 재개');

    if (legacyState !== 'consumed') {
      const lease = store.acquireGateChannelDeliveryLease(
        GATE,
        't.legacy-lease',
        nowAt,
        '2026-08-24T11:01:00.000Z',
      );
      if (lease.kind !== 'acquired') throw new Error(`legacy lease ${lease.kind}`);
      expect(store.acquireGateChannelDeliveryLease(
        GATE,
        't.legacy-contender',
        nowAt,
        '2026-08-24T11:01:00.000Z',
      )).toMatchObject({ kind: 'busy' });
      expect(store.deferGateChannelDelivery(
        GATE,
        lease.delivery.revision - 1,
        't.legacy-lease',
        nowAt,
        '2026-08-24T11:00:01.000Z',
        'stale_legacy_cas',
      )).toBeNull();
      expect(store.releaseGateChannelDeliveryLease(GATE, 't.legacy-lease', nowAt)).toBe(true);
    }

    const orca = new MutableResumeOrca();
    const transport = new LegacyRecordingTransport();
    const delivery = new GateChannelDeliveryEngine({
      store,
      orca,
      transport,
      now: () => new Date(nowAt),
      routeRetryMs: 1_000,
      receiptBackoffMs: 1_000,
      attemptDelaysMs: [1_000],
    });
    await delivery.reconcile();
    if (legacyState === 'pending' || legacyState === 'attempted') {
      expect(transport.calls).toEqual([{
        runId: RUN.slice('run:'.length),
        gateId: GATE.slice('gate:'.length),
      }]);
      expect(orca.calls).toEqual([]);
      expect(store.markGateChannelAttempted(
        GATE,
        '2026-08-24T11:00:01.000Z',
        '2026-08-24T11:00:02.000Z',
      )).toMatchObject({ state: 'attempted', resumeBaselineState: 'unavailable' });
      const receipt = store.markGateChannelReceipted(
        GATE,
        '2026-08-24T11:00:02.000Z',
      );
      expect(receipt).toMatchObject({ state: 'receipted', resumeBaselineState: 'unavailable' });
      expect(store.markGateChannelReceipted(
        GATE,
        '2026-08-24T11:00:03.000Z',
      )?.revision).toBe(receipt?.revision);
    } else if (legacyState === 'receipted') {
      expect(transport.calls).toEqual([]);
      expect(orca.calls).toEqual(['gate-list']);
      expect(store.findGateChannelDelivery(GATE)).toMatchObject({ state: 'consumed' });
      const consumedRevision = store.findGateChannelDelivery(GATE)!.revision;
      expect(store.markGateChannelReceipted(
        GATE,
        '2026-08-24T11:00:01.000Z',
      )?.revision).toBe(consumedRevision);
    } else {
      expect(transport.calls).toEqual([]);
      expect(orca.calls).toEqual([]);
      const consumedRevision = store.findGateChannelDelivery(GATE)!.revision;
      expect(store.markGateChannelReceipted(
        GATE,
        '2026-08-24T11:00:01.000Z',
      )?.revision).toBe(consumedRevision);
    }
    expect(store.findGateResumeObservation(GATE)).toBeNull();
    store.close();

    store = new SqliteDigestStore(path);
    expect(store.findGateChannelDelivery(GATE)?.resumeBaselineState).toBe('unavailable');
    expect(store.findGateResumeObservation(GATE)).toBeNull();
    store.close();
  });
});
