import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GateActionHandler, type SlackSocketEvent } from '../src/gate/action-handler.js';
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import { GateResolutionEngine, type GateResolutionFault } from '../src/gate/resolve.js';
import { projectGateResolutionCard } from '../src/gate/resolution-project.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import { boundedOrcaRunner, type OrcaRunner } from '../src/orca/client.js';
import type { SlackConfig } from '../src/project/config.js';
import type { PostMessageInput, PostedMessage, SlackPoster, UpdateMessageInput } from '../src/slack/post.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const GATE_ID = 'gate_resolve';
const RUN_ID = 'run_resolve';
const TASK_ID = 'task_resolve';
const GATE = gateKey(GATE_ID);
const RUN = runKey(RUN_ID);
const TASK = taskKey(TASK_ID);
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const AT = '2026-08-24T10:00:00.000Z';
const REQUEST = '11111111-1111-4111-8111-111111111111';

let dir: string;
let engineSequence = 0;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orca-gate-resolve-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function seed(path: string): SqliteDigestStore {
  const store = new SqliteDigestStore(path);
  store.insertGateMetadata({
    source: 'registered',
    gateKey: GATE, runKey: RUN, taskKey: TASK, dispatchKey: dispatchKey('ctx_resolve'),
    askMessageId: 'msg_resolve', questionThreadId: 'thread_resolve',
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
  store.saveGateLocalObservation({
    gateKey: GATE, runKey: RUN, taskKey: TASK, status: 'pending', resolution: null,
    resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: AT,
  });
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
    threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'), actionValue: 'keep', retryRequestId: REQUEST, at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`seed claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT);
  if (acked?.ackState !== 'acked') throw new Error('seed ACK state failed');
  return store;
}

type ResolveMode =
  | 'normal'
  | 'throw_before'
  | 'hang_before'
  | 'apply_then_throw'
  | 'malformed'
  | 'pending_structured'
  | 'wrong_structured';

class FakeOrca implements OrcaRunner {
  status: 'pending' | 'resolved' = 'pending';
  resolution: string | null = null;
  resolvedAt: string | null = null;
  resolveMode: ResolveMode = 'normal';
  replayed = false;
  failConfirmationAfterLost = false;
  failNextLists = 0;
  resolveExternallyOnListCall: number | null = null;
  listCount = 0;
  blockResolveResponse = false;
  readonly failListCalls = new Set<number>();
  readonly calls: string[][] = [];
  readonly retryRequests: string[] = [];
  readonly resolveStarted: Promise<void>;
  private signalResolveStarted!: () => void;
  private releaseResolveResponse!: () => void;
  private readonly resolveResponseReleased: Promise<void>;

  constructor() {
    this.resolveStarted = new Promise((resolve) => { this.signalResolveStarted = resolve; });
    this.resolveResponseReleased = new Promise((resolve) => { this.releaseResolveResponse = resolve; });
  }

  releaseResolve(): void {
    this.releaseResolveResponse();
  }

  resolveExternally(resolution: string, resolvedAt = AT): void {
    this.status = 'resolved';
    this.resolution = resolution;
    this.resolvedAt = resolvedAt;
  }

  private gate(): Record<string, unknown> {
    return {
      id: GATE_ID, run_id: RUN_ID, task_id: TASK_ID, question: '표시용 질문은 파싱하지 않는다',
      options: JSON.stringify(['현행 유지', '변경']), status: this.status,
      resolution: this.resolution, created_at: '2026-08-24T09:00:00.000Z',
      resolved_at: this.resolvedAt,
    };
  }

  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[1] === 'run-show') {
      return Promise.resolve(JSON.stringify({
        id: 'run', ok: true,
        result: {
          run: {
            id: RUN_ID,
            objective: 'test',
            home_database: 'this_database',
            coordinator_handle: 'term_current_coordinator',
            coordinator_pane_key: 'tab:pane',
            consumer_generation: 2,
            legacy: 0,
            created_at: '2026-08-24T09:00:00.000Z',
            updated_at: '2026-08-24T10:00:00.000Z',
          },
        },
      }));
    }
    if (args[1] === 'gate-list') {
      this.listCount += 1;
      if (this.resolveExternallyOnListCall === this.listCount) {
        this.resolveExternally('현행 유지', '2026-08-24T10:00:01.000Z');
      }
      if (this.failNextLists > 0 || this.failListCalls.has(this.listCount)) {
        if (this.failNextLists > 0) this.failNextLists -= 1;
        return Promise.reject(new Error('read unavailable'));
      }
      return Promise.resolve(JSON.stringify({
        id: 'read', ok: true,
        result: { runId: RUN_ID, gates: [this.gate()], count: 1 },
      }));
    }
    if (args[1] !== 'gate-resolve') return Promise.reject(new Error('unexpected command'));
    const requestAt = args.indexOf('--retry-request');
    const resolutionAt = args.indexOf('--resolution');
    const request = args[requestAt + 1] ?? '';
    const resolution = args[resolutionAt + 1] ?? '';
    this.retryRequests.push(request);
    if (this.resolveMode === 'throw_before') return Promise.reject(new Error('request not sent'));
    if (this.resolveMode === 'hang_before') return new Promise<string>(() => undefined);
    if (this.resolveMode === 'pending_structured') {
      return Promise.resolve(JSON.stringify({
        id: 'resolve', ok: true,
        result: { gate: this.gate(), mutation: { requestId: request, replayed: false } },
      }));
    }
    if (this.resolveMode === 'wrong_structured') {
      this.resolveExternally('외부 결정');
      return Promise.resolve(JSON.stringify({
        id: 'resolve', ok: true,
        result: { gate: this.gate(), mutation: { requestId: request, replayed: false } },
      }));
    }
    this.resolveExternally(resolution);
    if (this.resolveMode === 'apply_then_throw') {
      if (this.failConfirmationAfterLost) this.failNextLists = 1;
      return Promise.reject(new Error('response lost'));
    }
    if (this.resolveMode === 'malformed') {
      return Promise.resolve(JSON.stringify({ id: 'resolve', ok: true, result: { gate: this.gate() } }));
    }
    const response = JSON.stringify({
      id: 'resolve', ok: true,
      result: { gate: this.gate(), mutation: { requestId: request, replayed: this.replayed } },
    });
    this.signalResolveStarted();
    return this.blockResolveResponse
      ? this.resolveResponseReleased.then(() => response)
      : Promise.resolve(response);
  }
}

class FakeSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  fail = false;
  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('not used'));
  }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return this.fail
      ? Promise.reject(new Error('Slack unavailable'))
      : Promise.resolve({ channel: input.channel, ts: input.ts });
  }
}

class DeferredFirstSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  readonly firstStarted: Promise<void>;
  private signalStarted!: () => void;
  private release!: () => void;
  private readonly firstCompletion: Promise<void>;

  constructor() {
    this.firstStarted = new Promise((resolve) => { this.signalStarted = resolve; });
    this.firstCompletion = new Promise((resolve) => { this.release = resolve; });
  }

  releaseFirst(): void {
    this.release();
  }

  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('not used'));
  }

  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    if (this.updates.length === 1) {
      this.signalStarted();
      await this.firstCompletion;
    }
    return { channel: input.channel, ts: input.ts };
  }
}

class SequencedSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  readonly started: readonly Promise<void>[];
  private readonly signalStarted: readonly (() => void)[];
  private readonly completions: readonly Promise<void>[];
  private readonly signalCompletion: readonly (() => void)[];

  constructor(count: number) {
    const started: Promise<void>[] = [];
    const signalStarted: (() => void)[] = [];
    const completions: Promise<void>[] = [];
    const signalCompletion: (() => void)[] = [];
    for (let index = 0; index < count; index += 1) {
      started.push(new Promise((resolve) => signalStarted.push(resolve)));
      completions.push(new Promise((resolve) => signalCompletion.push(resolve)));
    }
    this.started = started;
    this.signalStarted = signalStarted;
    this.completions = completions;
    this.signalCompletion = signalCompletion;
  }

  release(index: number): void {
    const release = this.signalCompletion[index];
    if (release === undefined) throw new Error(`missing Slack completion ${index}`);
    release();
  }

  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('not used'));
  }

  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    const index = this.updates.length;
    const started = this.signalStarted[index];
    const completion = this.completions[index];
    if (started === undefined || completion === undefined) {
      throw new Error(`unexpected Slack attempt ${index + 1}`);
    }
    this.updates.push(input);
    started();
    await completion;
    return { channel: input.channel, ts: input.ts };
  }
}

function engine(
  store: SqliteDigestStore,
  orca: OrcaRunner,
  slack: FakeSlack,
  fault?: (point: GateResolutionFault) => void | Promise<void>,
  leaseDurationMs = 30_000,
  leaseNow?: () => Date,
): GateResolutionEngine {
  return new GateResolutionEngine({
    store, orca, slack, now: () => new Date(AT), leaseDurationMs,
    leaseOwner: `t.engine-${++engineSequence}`,
    ...(fault ? { fault } : {}),
    ...(leaseNow ? { leaseNow } : {}),
  });
}

describe('post-ACK exact Orca resolve and reconciliation', () => {
  it('pre-read → mutation-edge read → official resolve → post-read confirms and projects pending notification', async () => {
    const store = seed(join(dir, 'happy.db'));
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    const worker = engine(store, orca, slack);
    await Promise.all([worker.resolveAndProject(GATE), worker.resolveAndProject(GATE)]);
    expect(orca.calls.map((call) => call[1])).toEqual([
      'gate-list', 'gate-list', 'run-show', 'gate-resolve', 'gate-list',
    ]);
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'resolved',
      optionResolution: '현행 유지',
      resolveResult: { mutation: { requestId: REQUEST, replayed: false } },
      postRead: { status: 'resolved', resolution: '현행 유지' },
    });
    expect(store.listPendingGateOutboxes()).toEqual([]);
    expect(slack.updates).toHaveLength(2);
    expect(JSON.stringify(slack.updates[0])).toContain('resolving');
    const card = JSON.stringify(slack.updates.at(-1));
    expect(card).toContain('Coordinator 통지 대기');
    expect(card).not.toContain('작업 재개');
    store.close();
  });

  it('mutation.replayed=true를 strict하게 보존하고 같은 logical request만 사용한다', async () => {
    const store = seed(join(dir, 'replayed.db'));
    const orca = new FakeOrca();
    orca.replayed = true;
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)?.resolveResult?.mutation).toEqual({
      requestId: REQUEST,
      replayed: true,
    });
    expect(new Set(orca.retryRequests)).toEqual(new Set([REQUEST]));
    store.close();
  });

  it('response loss after applied resolve is surfaced as ownership-ambiguous without double mutation', async () => {
    const store = seed(join(dir, 'response-loss.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'apply_then_throw';
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'degraded', lastErrorCode: 'mutation_ownership_ambiguous',
    });
    expect(orca.retryRequests).toEqual([REQUEST]);
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST]);
    store.close();
  });

  it('response loss plus failed confirmation becomes ownership-ambiguous after restart without replay', async () => {
    const store = seed(join(dir, 'response-loss-restart.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'apply_then_throw';
    orca.failConfirmationAfterLost = true;
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('uncertain');
    expect(orca.retryRequests).toEqual([REQUEST]);
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'degraded', lastErrorCode: 'mutation_ownership_ambiguous',
    });
    expect(orca.retryRequests).toEqual([REQUEST]);
    store.close();
  });

  it('malformed structured output cannot claim ownership from an equal exact post-read', async () => {
    const store = seed(join(dir, 'malformed-result.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'malformed';
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'degraded',
      lastErrorCode: 'mutation_ownership_ambiguous',
      resolveResult: null,
      postRead: { status: 'resolved', resolution: '현행 유지' },
    });
    store.close();
  });

  it('a structured resolve result that is still pending is rejected and only the same UUID retries', async () => {
    const store = seed(join(dir, 'pending-structured.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'pending_structured';
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', resolveResult: null, lastErrorCode: 'response_unknown_pending',
    });
    orca.resolveMode = 'normal';
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST, REQUEST]);
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    store.close();
  });

  it('a structured resolve result with the wrong final resolution is rejected as conflict', async () => {
    const store = seed(join(dir, 'wrong-structured.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'wrong_structured';
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'conflict', resolveResult: null, lastErrorCode: 'external_resolution',
      postRead: { resolution: '외부 결정' },
    });
    expect(orca.retryRequests).toEqual([REQUEST]);
    store.close();
  });

  it('unresolved uncertainty retries only the original durable UUID on startup', async () => {
    const store = seed(join(dir, 'uncertain.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'throw_before';
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('uncertain');
    expect(store.listPendingGateOutboxes()[0]?.cardState).toBeUndefined(); // projected degraded
    orca.resolveMode = 'normal';
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST, REQUEST]);
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    store.close();
  });

  it('a bounded resolve timeout becomes response-unknown and retries only the durable UUID', async () => {
    const store = seed(join(dir, 'resolve-timeout.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'hang_before';
    const bounded = boundedOrcaRunner(orca, 10);
    await engine(store, bounded, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', mutationOwnership: 'unknown',
      lastErrorCode: 'response_unknown_pending', resolveResult: null,
    });
    expect(orca.retryRequests).toEqual([REQUEST]);

    orca.resolveMode = 'normal';
    await engine(store, bounded, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST, REQUEST]);
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    store.close();
  });

  it('owner abort cancels a hung pre-read, releases its lease, and does not persist uncertainty', async () => {
    const path = join(dir, 'owner-abort.db');
    const store = seed(path);
    let started!: () => void;
    const readStarted = new Promise<void>((resolve) => { started = resolve; });
    const raw: OrcaRunner = {
      run: () => {
        started();
        return new Promise<string>(() => undefined);
      },
    };
    const controller = new AbortController();
    const worker = engine(store, boundedOrcaRunner(raw, 1_000), new FakeSlack());
    const resolving = worker.resolveAndProject(GATE, controller.signal);
    await readStarted;

    controller.abort();
    await resolving;

    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'claimed',
      preRead: null,
      lastErrorCode: null,
      leaseOwner: null,
    });
    const probe = new DatabaseSync(path, { readOnly: true });
    expect(probe.prepare(
      `SELECT outcome FROM gate_resolution_attempt
        WHERE gate_key = ? AND phase = 'pre_read' ORDER BY id`,
    ).all(GATE)).toEqual([{ outcome: 'started' }]);
    probe.close();
    store.close();
  });

  it('a later equal winner remains ambiguous after a response-unknown request was observed pending', async () => {
    const store = seed(join(dir, 'response-unknown-pending-external.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'throw_before';
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', lastErrorCode: 'response_unknown_pending',
    });
    orca.resolveExternally('현행 유지', '2026-08-24T10:00:01.000Z');
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'degraded', lastErrorCode: 'mutation_ownership_ambiguous',
    });
    store.close();
  });

  it('an equal winner appearing at the mutation-edge read remains ownership-ambiguous', async () => {
    const store = seed(join(dir, 'response-unknown-edge-equal.db'));
    const orca = new FakeOrca();
    orca.resolveMode = 'throw_before';
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', mutationOwnership: 'unknown', lastErrorCode: 'response_unknown_pending',
    });

    orca.resolveExternallyOnListCall = orca.listCount + 2;
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'degraded', mutationOwnership: 'unknown',
      lastErrorCode: 'mutation_ownership_ambiguous',
      postRead: { status: 'resolved', resolution: '현행 유지' },
    });
    store.close();
  });

  it.each([
    ['after_ack_before_pre_read', 'claimed'],
    ['after_pre_read_before_resolve', 'pre_read'],
    ['after_resolve_before_post_read', 'post_read'],
    ['after_post_read_before_projection', 'resolved'],
  ] as const)('%s fault is durably resumed by startup reconciliation', async (point, lifecycle) => {
    const store = seed(join(dir, `${point}.db`));
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    const crash = engine(store, orca, slack, (at) => {
      if (at === point) throw new Error('injected crash');
    });
    await expect(crash.resolveAndProject(GATE)).rejects.toThrow(/injected crash/);
    expect(store.findGateResolution(GATE)).toMatchObject({ lifecycle, leaseOwner: null });
    expect(store.listPendingGateOutboxes()).toHaveLength(1);
    await engine(store, orca, slack).reconcile();
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    expect(store.listPendingGateOutboxes()).toEqual([]);
    store.close();
  });

  it('preserves the pending baseline across a post-mutation crash and lazy D3 seed restart', async () => {
    const dbPath = join(dir, 'post-mutation-d3-seed.db');
    let store = seed(dbPath);
    const orca = new FakeOrca();
    await expect(engine(store, orca, new FakeSlack(), (point) => {
      if (point === 'after_resolve_before_post_read') {
        throw new Error('process died after structured result persistence');
      }
    }).resolveAndProject(GATE)).rejects.toThrow(/structured result persistence/);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'post_read',
      preRead: { status: 'pending', resolution: null, resolvedAt: null },
      postRead: null,
      resolveResult: { gate: { status: 'resolved', resolution: '현행 유지' } },
    });
    store.close();

    store = new SqliteDigestStore(dbPath);
    orca.failNextLists = 1;
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', lastErrorCode: 'post_read_failed',
      preRead: { status: 'pending', resolution: null, resolvedAt: null },
      resolveResult: { gate: { status: 'resolved', resolution: '현행 유지' } },
    });
    store.close();

    store = new SqliteDigestStore(dbPath);
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'resolved',
      preRead: { status: 'pending', resolution: null, resolvedAt: null },
      postRead: { status: 'resolved', resolution: '현행 유지', resolvedAt: AT },
    });
    const seeded = store.seedPendingGateChannelDeliveries(
      new Date().toISOString(),
      1_000,
      () => true,
    );
    expect(seeded).toMatchObject({
      kind: 'committed', deliveries: [{ state: 'pending', gateKey: GATE }],
    });
    store.close();

    store = new SqliteDigestStore(dbPath);
    expect(store.seedPendingGateChannelDeliveries(
      new Date().toISOString(),
      1_000,
      () => true,
    )).toEqual({ kind: 'committed', deliveries: [] });
    expect(store.findGateChannelDelivery(GATE)).toMatchObject({
      state: 'pending', attemptCount: 0,
    });
    store.close();
  });

  it('restart surfaces ambiguous ownership after Orca succeeds before local result persistence', async () => {
    const store = seed(join(dir, 'after-response-before-result.db'));
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    await expect(engine(store, orca, slack, (point) => {
      if (point === 'after_resolve_response_before_result_persist') {
        throw new Error('process died before result persistence');
      }
    }).resolveAndProject(GATE)).rejects.toThrow(/before result persistence/);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'resolving',
      leaseOwner: null,
      resolveResult: null,
    });
    expect(orca.retryRequests).toEqual([REQUEST]);

    await engine(store, orca, slack).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'degraded',
      lastErrorCode: 'mutation_ownership_ambiguous',
      resolveResult: null,
      postRead: { status: 'resolved', resolution: '현행 유지' },
    });
    const degradedCard = JSON.stringify(slack.updates.at(-1));
    expect(degradedCard).toContain('degraded');
    expect(degradedCard).toContain('Bridge 요청의 결과인지 확인할 수 없어');
    expect(degradedCard).not.toContain('sidecar 또는 mapping');
    store.close();
  });

  it('repeated read failure cannot erase crossed-mutation ambiguity across restarts', async () => {
    const store = seed(join(dir, 'sticky-mutation-ambiguity.db'));
    const orca = new FakeOrca();
    await expect(engine(store, orca, new FakeSlack(), (point) => {
      if (point === 'after_resolve_response_before_result_persist') {
        throw new Error('process died after mutation');
      }
    }).resolveAndProject(GATE)).rejects.toThrow(/after mutation/);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'resolving', mutationOwnership: 'unknown', resolveResult: null,
    });

    orca.failNextLists = 1;
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', mutationOwnership: 'unknown', lastErrorCode: 'pre_read_failed',
    });

    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'degraded', mutationOwnership: 'unknown',
      lastErrorCode: 'mutation_ownership_ambiguous',
    });
    store.close();
  });

  it('external resolver during pre-read window is caught before mutation and never overwritten', async () => {
    const store = seed(join(dir, 'external-before.db'));
    const orca = new FakeOrca();
    await engine(store, orca, new FakeSlack(), (point) => {
      if (point === 'after_pre_read_before_resolve') orca.resolveExternally('외부 결정');
    }).resolveAndProject(GATE);
    expect(orca.retryRequests).toEqual([]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'conflict', postRead: { resolution: '외부 결정' },
    });
    store.close();
  });

  it('an equal external resolution before the mutation edge is still persisted as a conflict', async () => {
    const store = seed(join(dir, 'external-equal-before.db'));
    const orca = new FakeOrca();
    await engine(store, orca, new FakeSlack(), (point) => {
      if (point === 'after_pre_read_before_resolve') orca.resolveExternally('현행 유지');
    }).resolveAndProject(GATE);
    expect(orca.retryRequests).toEqual([]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'conflict', lastErrorCode: 'external_resolution',
      postRead: { resolution: '현행 유지' },
    });
    store.close();
  });

  it.each([
    ['pre_read_failed', 1],
    ['mutation_edge_read_failed', 2],
  ] as const)('%s uncertainty cannot claim an equal external winner after restart', async (code, listCall) => {
    const store = seed(join(dir, `${code}-equal-external.db`));
    const orca = new FakeOrca();
    orca.failListCalls.add(listCall);
    await engine(store, orca, new FakeSlack()).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)).toMatchObject({ lifecycle: 'uncertain', lastErrorCode: code });
    orca.resolveExternally('현행 유지', '2026-08-24T10:00:01.000Z');
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'conflict', lastErrorCode: 'external_resolution',
    });
    store.close();
  });

  it('external resolver before post-read is persisted as conflict and never overwritten again', async () => {
    const store = seed(join(dir, 'external-post.db'));
    const orca = new FakeOrca();
    await engine(store, orca, new FakeSlack(), (point) => {
      if (point === 'after_resolve_before_post_read') orca.resolveExternally('외부 최종 결정');
    }).resolveAndProject(GATE);
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'conflict', postRead: { resolution: '외부 최종 결정' },
    });
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST]);
    store.close();
  });

  it('an equal-text external overwrite with a different resolvedAt is detected before post-read', async () => {
    const store = seed(join(dir, 'external-equal-post.db'));
    const orca = new FakeOrca();
    await engine(store, orca, new FakeSlack(), (point) => {
      if (point === 'after_resolve_before_post_read') {
        orca.resolveExternally('현행 유지', '2026-08-24T10:00:01.000Z');
      }
    }).resolveAndProject(GATE);
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'conflict', lastErrorCode: 'final_state_mismatch',
      resolveResult: { gate: { resolvedAt: AT } },
      postRead: { resolution: '현행 유지', resolvedAt: '2026-08-24T10:00:01.000Z' },
    });
    store.close();
  });

  it('restart compares a durable mutation result timestamp before accepting equal text', async () => {
    const store = seed(join(dir, 'external-equal-restart.db'));
    const orca = new FakeOrca();
    await expect(engine(store, orca, new FakeSlack(), (point) => {
      if (point === 'after_resolve_before_post_read') throw new Error('crash');
    }).resolveAndProject(GATE)).rejects.toThrow(/crash/);
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('post_read');
    orca.resolveExternally('현행 유지', '2026-08-24T10:00:01.000Z');
    await engine(store, orca, new FakeSlack()).reconcile();
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'conflict', lastErrorCode: 'external_resolution',
    });
    store.close();
  });

  it('card update failure leaves replayable outbox; restart projects it without another Orca mutation', async () => {
    const store = seed(join(dir, 'outbox.db'));
    const orca = new FakeOrca();
    const failedSlack = new FakeSlack();
    failedSlack.fail = true;
    await engine(store, orca, failedSlack).resolveAndProject(GATE);
    expect(store.listPendingGateOutboxes()).toHaveLength(1);
    const recoveredSlack = new FakeSlack();
    await engine(store, orca, recoveredSlack).reconcile();
    expect(recoveredSlack.updates).toHaveLength(1);
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(store.listPendingGateOutboxes()).toEqual([]);
    store.close();
  });

  it('re-arms a completed outbox before projecting a newer renderer fingerprint', async () => {
    const path = join(dir, 'completed-renderer-drift.db');
    const store = seed(path);
    const completed = store.findGateResolutionOutbox(GATE);
    if (completed === null) throw new Error('outbox missing');
    const owner = `p${process.pid}.completed-renderer-v0`;
    expect(store.acquireGateOutboxProjection(GATE, completed.revision, owner, AT)).toBe('acquired');
    expect(store.markGateOutboxProjected(
      GATE,
      completed.revision,
      'legacy-renderer-fingerprint',
      owner,
      AT,
    )).toBe(true);
    expect(store.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);

    const crashedSlack = new FakeSlack();
    await expect(projectGateResolutionCard(
      store,
      crashedSlack,
      GATE,
      () => new Date('2026-08-24T10:00:01.000Z'),
      (point) => {
        if (point === 'after_outbox_rearm_before_reread') {
          throw new Error('process died after renderer re-arm');
        }
      },
    )).rejects.toThrow(/renderer re-arm/);
    expect(crashedSlack.updates).toEqual([]);
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({
      revision: completed.revision + 2,
      cardPending: true,
      projectedAt: null,
    });
    expect(store.markGateOutboxProjected(
      GATE,
      completed.revision,
      'late-legacy-completion',
      owner,
      '2026-08-24T10:00:01.001Z',
    )).toBe(false);
    store.close();

    const restarted = new SqliteDigestStore(path);
    expect(restarted.listPendingGateOutboxes()).toHaveLength(1);
    const recoveredSlack = new FakeSlack();
    await expect(projectGateResolutionCard(
      restarted,
      recoveredSlack,
      GATE,
      () => new Date('2026-08-24T10:00:02.000Z'),
    )).resolves.toMatchObject({ kind: 'projected' });
    expect(recoveredSlack.updates).toHaveLength(1);
    expect(restarted.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
    expect(restarted.findGateMessage(GATE)?.renderFingerprint).not.toBe(
      'legacy-renderer-fingerprint',
    );
    restarted.close();
  });

  it('startup reconciliation checks a completed terminal card for renderer drift', async () => {
    const path = join(dir, 'terminal-completed-renderer-drift.db');
    const store = seed(path);
    const orca = new FakeOrca();
    const initialSlack = new FakeSlack();
    await engine(store, orca, initialSlack).resolveAndProject(GATE);
    expect(store.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    expect(store.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
    const orcaCalls = orca.calls.length;
    store.close();

    // A renderer deployment changes the deterministic fingerprint without creating a lifecycle
    // generation. This is fixture evidence for the persisted pre-deploy completed card.
    const raw = new DatabaseSync(path);
    raw.prepare('UPDATE gate_message SET render_fingerprint = ? WHERE gate_key = ?').run(
      'legacy-terminal-renderer-fingerprint',
      GATE,
    );
    raw.close();

    const restarted = new SqliteDigestStore(path);
    const recoveredSlack = new FakeSlack();
    try {
      await engine(restarted, orca, recoveredSlack).reconcile();
      expect(orca.calls).toHaveLength(orcaCalls); // terminal lifecycle never re-enters Orca
      expect(recoveredSlack.updates).toHaveLength(1);
      expect(restarted.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
      expect(restarted.findGateMessage(GATE)?.renderFingerprint).not.toBe(
        'legacy-terminal-renderer-fingerprint',
      );
    } finally {
      restarted.close();
    }
  });

  it('a never-settling Slack projection times out, releases ownership, and remains replayable', async () => {
    const store = seed(join(dir, 'outbox-timeout.db'));
    const hanging: SlackPoster = {
      post: () => Promise.reject(new Error('unused')),
      update: () => new Promise(() => undefined),
    };
    const began = Date.now();
    expect(await projectGateResolutionCard(
      store,
      hanging,
      GATE,
      () => new Date(AT),
      undefined,
      10,
    )).toMatchObject({ kind: 'pending' });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(store.findGateResolutionOutbox(GATE)).toMatchObject({ cardPending: true });

    const replay = new FakeSlack();
    expect(await projectGateResolutionCard(
      store, replay, GATE, () => new Date(AT), undefined, 10,
    )).toMatchObject({ kind: 'projected' });
    expect(replay.updates).toHaveLength(1);
    expect(store.listPendingGateOutboxes()).toEqual([]);
    store.close();
  });

  it('a stale Slack completion converges to the newer durable card instead of clearing it', async () => {
    const store = seed(join(dir, 'outbox-generation-race.db'));
    const slack = new DeferredFirstSlack();
    const projecting = projectGateResolutionCard(store, slack, GATE, () => new Date(AT));
    await slack.firstStarted;
    const intent = store.findGateResolution(GATE);
    if (intent === null) throw new Error('intent missing');
    const lease = store.acquireGateResolutionLease(
      GATE, 't.lease-projection-test', AT, '2026-08-24T10:01:00.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error('lease failed');
    expect(store.updateGateResolution(GATE, lease.intent.revision, 't.lease-projection-test', {
      lifecycle: 'uncertain', errorCode: 'pre_read_failed', at: AT,
    })).not.toBeNull();
    slack.releaseFirst();
    await projecting;
    expect(slack.updates).toHaveLength(2);
    expect(JSON.stringify(slack.updates[0])).toContain('resolving');
    expect(JSON.stringify(slack.updates[1])).toContain('degraded');
    expect(store.listPendingGateOutboxes()).toEqual([]);
    expect(store.findGateMessage(GATE)?.renderFingerprint).not.toBe('fp');
    store.close();
  });

  it('renews one projection owner across three generations and fences old-boundary takeover', async () => {
    const path = join(dir, 'three-generation-projection-renewal.db');
    const store = seed(path);
    const slack = new SequencedSlack(3);
    let projectionNow = new Date(AT);
    const acquisitions: { readonly revision: number; readonly owner: string }[] = [];
    const originalAcquire = store.acquireGateOutboxProjection.bind(store);
    vi.spyOn(store, 'acquireGateOutboxProjection').mockImplementation(
      (gate, revision, owner, at) => {
        acquisitions.push({ revision, owner });
        return originalAcquire(gate, revision, owner, at);
      },
    );
    const projecting = projectGateResolutionCard(store, slack, GATE, () => projectionNow);
    await slack.started[0];

    const lifecycleOwner = 't.three-generation-lifecycle';
    const leased = store.acquireGateResolutionLease(
      GATE,
      lifecycleOwner,
      AT,
      '2026-08-24T10:01:00.000Z',
    );
    if (leased.kind !== 'acquired') throw new Error(`lifecycle lease failed: ${leased.kind}`);
    const pendingSnapshot = {
      gateId: GATE_ID,
      runId: RUN_ID,
      taskId: TASK_ID,
      options: ['현행 유지', '변경'],
      status: 'pending' as const,
      resolution: null,
      resolvedAt: null,
    };
    projectionNow = new Date('2026-08-24T10:00:10.000Z');
    const preRead = store.updateGateResolution(
      GATE,
      leased.intent.revision,
      lifecycleOwner,
      { lifecycle: 'pre_read', preRead: pendingSnapshot, at: projectionNow.toISOString() },
    );
    if (preRead === null) throw new Error('pre-read generation failed');
    slack.release(0);
    await slack.started[1];

    projectionNow = new Date('2026-08-24T10:00:20.000Z');
    const resolving = store.updateGateResolution(
      GATE,
      preRead.revision,
      lifecycleOwner,
      { lifecycle: 'resolving', at: projectionNow.toISOString() },
    );
    if (resolving === null) throw new Error('resolving generation failed');
    slack.release(1);
    await slack.started[2];

    const currentOutbox = store.findGateResolutionOutbox(GATE);
    if (currentOutbox === null) throw new Error('current outbox missing');
    const contender = new SqliteDigestStore(path, { observationOwnerAlive: () => true });
    expect(contender.acquireGateOutboxProjection(
      GATE,
      currentOutbox.revision,
      `p${process.pid}.old-boundary-contender`,
      '2026-08-24T10:00:30.000Z',
    )).toBe('busy');

    projectionNow = new Date('2026-08-24T10:00:30.000Z');
    slack.release(2);
    await projecting;
    expect(slack.updates).toHaveLength(3);
    expect(acquisitions.map(({ revision }) => revision)).toEqual([0, 1, 2]);
    expect(new Set(acquisitions.map(({ owner }) => owner)).size).toBe(1);
    expect(store.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
    const projectionOwner = acquisitions[0]?.owner;
    if (projectionOwner === undefined) throw new Error('projection owner missing');
    expect(store.markGateOutboxProjected(
      GATE,
      0,
      'late-generation-zero',
      projectionOwner,
      '2026-08-24T10:00:30.001Z',
    )).toBe(false);
    expect(store.markGateOutboxProjected(
      GATE,
      1,
      'late-generation-one',
      projectionOwner,
      '2026-08-24T10:00:30.002Z',
    )).toBe(false);
    contender.close();
    store.close();
  });

  it('a lifecycle advance between intent and outbox reads cannot clear a mixed projection snapshot', async () => {
    const store = seed(join(dir, 'mixed-projection-snapshot.db'));
    const slack = new FakeSlack();
    const originalOutbox = store.findGateResolutionOutbox.bind(store);
    let advanced = false;
    vi.spyOn(store, 'findGateResolutionOutbox').mockImplementation((gate) => {
      const snapshot = originalOutbox(gate);
      if (!advanced) {
        advanced = true;
        const lease = store.acquireGateResolutionLease(
          GATE,
          't.mixed-projection-fence',
          AT,
          '2026-08-24T10:01:00.000Z',
        );
        if (lease.kind !== 'acquired') throw new Error('projection fence lease failed');
        expect(store.updateGateResolution(GATE, lease.intent.revision, 't.mixed-projection-fence', {
          lifecycle: 'uncertain',
          errorCode: 'injected_projection_advance',
          at: AT,
        })).not.toBeNull();
      }
      return snapshot;
    });
    await projectGateResolutionCard(store, slack, GATE, () => new Date(AT));
    expect(slack.updates).toHaveLength(1);
    expect(JSON.stringify(slack.updates[0])).toContain('degraded');
    expect(JSON.stringify(slack.updates[0])).not.toContain('resolving');
    expect(store.listPendingGateOutboxes()).toEqual([]);
    store.close();
  });

  it('a durable projection owner prevents a newer projector from clearing while an older call is live', async () => {
    const store = seed(join(dir, 'concurrent-projection-completion.db'));
    const slack = new DeferredFirstSlack();
    const stale = projectGateResolutionCard(store, slack, GATE, () => new Date(AT));
    await slack.firstStarted;
    const lease = store.acquireGateResolutionLease(
      GATE,
      't.concurrent-projection-fence',
      AT,
      '2026-08-24T10:01:00.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error('projection lease failed');
    expect(store.updateGateResolution(GATE, lease.intent.revision, 't.concurrent-projection-fence', {
      lifecycle: 'uncertain',
      errorCode: 'injected_newer_projection',
      at: AT,
    })).not.toBeNull();

    await projectGateResolutionCard(store, slack, GATE, () => new Date(AT));
    expect(store.findGateResolutionOutbox(GATE)?.cardPending).toBe(true);
    expect(slack.updates).toHaveLength(1);
    slack.releaseFirst();
    await stale;

    expect(slack.updates).toHaveLength(2);
    expect(JSON.stringify(slack.updates[0])).toContain('resolving');
    expect(JSON.stringify(slack.updates[1])).toContain('degraded');
    expect(store.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
    store.close();
  });

  it('a late ordinary completion re-arms the terminal D2 card and only corrective projection settles', async () => {
    const path = join(dir, 'late-ordinary-after-terminal-d2.db');
    const ordinary = new SqliteDigestStore(path, {
      observationWriteOwner: `p${process.pid}.late-ordinary-owner`,
      observationOwnerAlive: () => true,
    });
    ordinary.insertGateMetadata({
      source: 'registered',
      gateKey: GATE, runKey: RUN, taskKey: TASK, dispatchKey: dispatchKey('ctx_resolve'),
      askMessageId: 'msg_resolve', questionThreadId: 'thread_resolve',
      options: [
        { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
        { id: 'change', label: '변경', description: '새 경로', resolution: '변경' },
      ],
      recommendation: { optionId: 'keep', reason: '호환성' }, impact: '후속 방향', registeredAt: AT,
    });
    ordinary.insertGateMessage({
      gateKey: GATE, runKey: RUN, channelId: CHANNEL, threadTs: THREAD_TS,
      messageTs: MESSAGE_TS, renderFingerprint: 'initial-ordinary-fingerprint', at: AT,
    });
    const staleObservation = ordinary.saveGateLocalObservation({
      gateKey: GATE, runKey: RUN, taskKey: TASK, status: 'pending', resolution: null,
      resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: AT,
    });
    expect(ordinary.beginGateObservationWrite(
      GATE,
      '2026-08-24T10:00:01.000Z',
      staleObservation.observation,
      staleObservation.revision,
    )).toBe(true);
    const staleSlack = new DeferredFirstSlack();
    const staleRemote = staleSlack.update({
      channel: CHANNEL,
      ts: MESSAGE_TS,
      text: 'stale ordinary card with actions',
      blocks: [{ type: 'actions', elements: [] }],
    });
    await staleSlack.firstStarted;

    const current = new SqliteDigestStore(path, { observationOwnerAlive: () => true });
    const mismatched = current.saveGateLocalObservation({
      ...staleObservation.observation,
      mappingState: 'mismatched',
      observedAt: '2026-08-24T10:00:02.000Z',
    });
    expect(mismatched.observation.mappingState).toBe('mismatched');
    expect(current.findGateLocalObservation(GATE)?.mappingState).toBe('write_pending');
    const exact = current.saveGateLocalObservation({
      ...staleObservation.observation,
      observedAt: '2026-08-24T10:00:03.000Z',
    });
    expect(current.findGateLocalObservation(GATE)?.mappingState).toBe('write_pending');
    expect(current.claimGateResolution({
      teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
      threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
      actionId: gateActionId(GATE, 'keep'), actionValue: 'keep', retryRequestId: REQUEST,
      at: '2026-08-24T10:00:03.001Z',
    })).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });
    expect(current.beginGateObservationWrite(
      GATE,
      '2026-08-24T10:00:30.999Z',
      exact.observation,
      exact.revision,
    )).toBe(false);
    expect(current.beginGateObservationWrite(
      GATE,
      '2026-08-24T10:00:31.000Z',
      exact.observation,
      exact.revision,
    )).toBe(true);
    current.updateGateObservation(
      GATE,
      'repaired-current-ordinary-fingerprint',
      '2026-08-24T10:00:31.001Z',
      exact.observation,
      exact.revision,
    );
    expect(current.findGateLocalObservation(GATE)?.mappingState).toBe('matched');

    const claimed = current.claimGateResolution({
      teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
      threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
      actionId: gateActionId(GATE, 'keep'), actionValue: 'keep', retryRequestId: REQUEST,
      at: '2026-08-24T10:00:31.002Z',
    });
    if (claimed.kind !== 'claimed') throw new Error(`terminal D2 claim failed: ${claimed.kind}`);
    const acked = current.markGateResolutionAck(
      GATE,
      claimed.intent.revision,
      'acked',
      '2026-08-24T10:00:31.003Z',
    );
    if (acked === null) throw new Error('terminal D2 ACK failed');
    expect(current.beginGateObservationWrite(
      GATE,
      '2026-08-24T10:00:31.004Z',
      exact.observation,
      exact.revision,
    )).toBe(false);

    const lifecycleOwner = 't.late-ordinary-terminal-d2';
    const leased = current.acquireGateResolutionLease(
      GATE,
      lifecycleOwner,
      '2026-08-24T10:00:31.004Z',
      '2026-08-24T10:01:31.004Z',
    );
    if (leased.kind !== 'acquired') throw new Error(`terminal D2 lease failed: ${leased.kind}`);
    const pending = {
      gateId: GATE_ID, runId: RUN_ID, taskId: TASK_ID, options: ['현행 유지', '변경'],
      status: 'pending' as const, resolution: null, resolvedAt: null,
    };
    const selected = {
      ...pending,
      status: 'resolved' as const,
      resolution: '현행 유지',
      resolvedAt: '2026-08-24T10:00:31.007Z',
    };
    const preRead = current.updateGateResolution(GATE, leased.intent.revision, lifecycleOwner, {
      lifecycle: 'pre_read', preRead: pending, at: '2026-08-24T10:00:31.005Z',
    });
    if (preRead === null) throw new Error('terminal D2 pre-read failed');
    const resolving = current.updateGateResolution(GATE, preRead.revision, lifecycleOwner, {
      lifecycle: 'resolving', at: '2026-08-24T10:00:31.006Z',
    });
    if (resolving === null) throw new Error('terminal D2 resolving failed');
    const postRead = current.updateGateResolution(GATE, resolving.revision, lifecycleOwner, {
      lifecycle: 'post_read',
      resolveResult: {
        gate: selected,
        mutation: { requestId: REQUEST, replayed: false },
      },
      at: '2026-08-24T10:00:31.007Z',
    });
    if (postRead === null) throw new Error('terminal D2 result failed');
    const resolved = current.updateGateResolution(GATE, postRead.revision, lifecycleOwner, {
      lifecycle: 'resolved', postRead: selected, at: '2026-08-24T10:00:31.008Z',
    });
    if (resolved === null) throw new Error('terminal D2 completion failed');
    const terminalSlack = new FakeSlack();
    await projectGateResolutionCard(
      current,
      terminalSlack,
      GATE,
      () => new Date('2026-08-24T10:00:31.009Z'),
    );
    expect(terminalSlack.updates).toHaveLength(1);
    expect(JSON.stringify(terminalSlack.updates[0])).not.toContain('"type":"actions"');
    expect(current.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);

    // A is deliberately released after the exact repair, winner, and terminal D2 projection. Its
    // remote card is now the last applied Slack state, so local completion must durably re-arm D2.
    staleSlack.releaseFirst();
    await staleRemote;
    expect(() => ordinary.updateGateObservation(
      GATE,
      'stale-ordinary-fingerprint',
      '2026-08-24T10:00:31.010Z',
      staleObservation.observation,
      staleObservation.revision,
    )).toThrow(/owner|더 새 관찰/);
    expect(current.findGateMessage(GATE)?.renderFingerprint).toBe('stale-ordinary-fingerprint');
    expect(current.findGateResolutionOutbox(GATE)).toMatchObject({
      cardState: 'resolved',
      cardPending: true,
      projectedAt: null,
    });
    expect(current.claimGateResolution({
      teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
      threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
      actionId: gateActionId(GATE, 'keep'), actionValue: 'keep',
      retryRequestId: '22222222-2222-4222-8222-222222222222',
      at: '2026-08-24T10:00:31.011Z',
    })).toEqual({ kind: 'rejected', reason: 'card_mapping_not_matched' });

    const correctiveSlack = new FakeSlack();
    await projectGateResolutionCard(
      current,
      correctiveSlack,
      GATE,
      () => new Date('2026-08-24T10:00:31.012Z'),
    );
    expect(correctiveSlack.updates).toHaveLength(1);
    expect(JSON.stringify(correctiveSlack.updates[0])).toContain('Coordinator 통지 대기');
    expect(JSON.stringify(correctiveSlack.updates[0])).not.toContain('"type":"actions"');
    expect(current.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
    const correctedFingerprint = current.findGateMessage(GATE)?.renderFingerprint;
    expect(correctedFingerprint).not.toBe('stale-ordinary-fingerprint');
    expect(() => ordinary.updateGateObservation(
      GATE,
      'impossible-second-stale-completion',
      '2026-08-24T10:00:31.013Z',
      staleObservation.observation,
      staleObservation.revision,
    )).toThrow(/owner|active|fence/);
    expect(current.findGateMessage(GATE)?.renderFingerprint).toBe(correctedFingerprint);
    expect(current.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);

    ordinary.close();
    current.close();
    expect(() => new SqliteDigestStore(path).close()).not.toThrow();
  });

  it('an exact Slack redelivery ACKs its pending winner after a late ordinary completion fails mapping closed', async () => {
    const path = join(dir, 'late-ordinary-before-pending-winner-redelivery.db');
    const staleOwner = new SqliteDigestStore(path, {
      observationWriteOwner: `p${process.pid}.audit-b-stale-owner`,
      observationOwnerAlive: () => true,
    });
    staleOwner.insertGateMetadata({
      source: 'registered',
      gateKey: GATE, runKey: RUN, taskKey: TASK, dispatchKey: dispatchKey('ctx_resolve'),
      askMessageId: 'msg_resolve', questionThreadId: 'thread_resolve',
      options: [
        { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
        { id: 'change', label: '변경', description: '새 경로', resolution: '변경' },
      ],
      recommendation: { optionId: 'keep', reason: '호환성' }, impact: '후속 방향', registeredAt: AT,
    });
    staleOwner.insertGateMessage({
      gateKey: GATE, runKey: RUN, channelId: CHANNEL, threadTs: THREAD_TS,
      messageTs: MESSAGE_TS, renderFingerprint: 'audit-b-initial-fingerprint', at: AT,
    });
    const staleGeneration = staleOwner.saveGateLocalObservation({
      gateKey: GATE, runKey: RUN, taskKey: TASK, status: 'pending', resolution: null,
      resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: AT,
    });
    expect(staleOwner.beginGateObservationWrite(
      GATE,
      '2026-08-24T10:00:01.000Z',
      staleGeneration.observation,
      staleGeneration.revision,
      { channelId: CHANNEL, threadTs: THREAD_TS },
    )).toBe(true);
    const staleSlack = new DeferredFirstSlack();
    const staleRemote = staleSlack.update({
      channel: CHANNEL,
      ts: MESSAGE_TS,
      text: 'stale ordinary generation g with controls',
      blocks: [{ type: 'actions', elements: [] }],
    });
    await staleSlack.firstStarted;

    const winnerStore = new SqliteDigestStore(path, { observationOwnerAlive: () => true });
    const currentGeneration = winnerStore.saveGateLocalObservation({
      ...staleGeneration.observation,
      observedAt: '2026-08-24T10:00:02.000Z',
    });
    expect(winnerStore.findGateLocalObservation(GATE)?.mappingState).toBe('write_pending');
    expect(winnerStore.beginGateObservationWrite(
      GATE,
      '2026-08-24T10:00:31.000Z',
      currentGeneration.observation,
      currentGeneration.revision,
      { channelId: CHANNEL, threadTs: THREAD_TS },
    )).toBe(true);
    const currentSlack = new FakeSlack();
    await currentSlack.update({
      channel: CHANNEL,
      ts: MESSAGE_TS,
      text: 'current ordinary generation g+1 with controls',
      blocks: [{ type: 'actions', elements: [] }],
    });
    winnerStore.updateGateObservation(
      GATE,
      'audit-b-current-fingerprint',
      '2026-08-24T10:00:31.001Z',
      currentGeneration.observation,
      currentGeneration.revision,
    );
    expect(winnerStore.findGateLocalObservation(GATE)?.mappingState).toBe('matched');

    const pendingWinner = winnerStore.claimGateResolution({
      teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
      threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
      actionId: gateActionId(GATE, 'keep'), actionValue: 'keep', retryRequestId: REQUEST,
      at: '2026-08-24T10:00:31.002Z',
    });
    if (pendingWinner.kind !== 'claimed') {
      throw new Error(`Audit B pending winner failed: ${pendingWinner.kind}`);
    }
    expect(pendingWinner.intent).toMatchObject({ retryRequestId: REQUEST, ackState: 'pending' });
    expect(winnerStore.findGateResolutionOutbox(GATE)?.cardPending).toBe(true);

    // A lands last. Its old generation is now the physical Slack card, while its local completion
    // must record that fingerprint, fail mapping closed, and re-arm the pending winner's outbox.
    staleSlack.releaseFirst();
    await staleRemote;
    expect(() => staleOwner.updateGateObservation(
      GATE,
      'audit-b-stale-fingerprint',
      '2026-08-24T10:00:31.003Z',
      staleGeneration.observation,
      staleGeneration.revision,
    )).toThrow(/더 새 관찰/);
    expect(winnerStore.findGateMessage(GATE)?.renderFingerprint).toBe('audit-b-stale-fingerprint');
    expect(winnerStore.findGateLocalObservation(GATE)?.mappingState).toBe('mismatched');
    expect(winnerStore.findGateResolutionOutbox(GATE)).toMatchObject({
      cardPending: true,
      projectedAt: null,
    });
    expect(winnerStore.findGateResolution(GATE)).toMatchObject({
      retryRequestId: REQUEST,
      ackState: 'pending',
      lifecycle: 'claimed',
    });
    staleOwner.close();
    winnerStore.close();

    const reopened = new SqliteDigestStore(path);
    try {
      const config: SlackConfig = {
        teamId: 'T0TEAM',
        apiAppId: 'A0APP',
        ownerUserIds: ['U0OWNER'],
        channels: { prDigest: 'C0PRDIGEST', agentRuns: CHANNEL },
      };
      const actionBody = (
        optionId: 'keep' | 'change',
        ownerUserId = 'U0OWNER',
        threadTs = THREAD_TS,
      ): Record<string, unknown> => ({
        type: 'block_actions',
        api_app_id: 'A0APP',
        team: { id: 'T0TEAM' },
        user: { id: ownerUserId },
        container: {
          type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false,
        },
        channel: { id: CHANNEL },
        message: { ts: MESSAGE_TS, thread_ts: threadTs, text: 'never parse Gate prose' },
        actions: [{
          type: 'button',
          block_id: gateBlockId(GATE),
          action_id: gateActionId(GATE, optionId),
          value: optionId,
          action_ts: '1787554900.000001',
          text: { type: 'plain_text', text: optionId },
        }],
      });
      const actionEvent = (
        body: Record<string, unknown>,
        ack: () => void,
      ): SlackSocketEvent => ({ type: 'interactive', body, ack });
      const orca = new FakeOrca();
      const resolutionSlack = new FakeSlack();
      const resolver = new GateResolutionEngine({
        store: reopened,
        orca,
        slack: resolutionSlack,
        now: () => new Date('2026-08-24T10:00:32.000Z'),
        leaseOwner: 't.audit-b-redelivery-resolution',
      });
      const scheduled: Array<() => Promise<void>> = [];
      const consumer = new GateActionHandler({
        config,
        store: reopened,
        engine: resolver,
        now: () => new Date('2026-08-24T10:00:31.004Z'),
        requestId: () => '33333333-3333-4333-8333-333333333333',
        schedule: (job) => { scheduled.push(job); },
      });

      let unauthorizedAcks = 0;
      expect(await consumer.handle(actionEvent(
        actionBody('keep', 'U0INTRUDER'),
        () => { unauthorizedAcks += 1; },
      ))).toBe('rejected');
      expect(unauthorizedAcks).toBe(1);
      expect(reopened.findGateResolution(GATE)?.ackState).toBe('pending');

      let wrongThreadAcks = 0;
      expect(await consumer.handle(actionEvent(
        actionBody('keep', 'U0OWNER', '1787554800.999999'),
        () => { wrongThreadAcks += 1; },
      ))).toBe('rejected');
      expect(wrongThreadAcks).toBe(1);
      expect(reopened.findGateResolution(GATE)?.ackState).toBe('pending');
      expect(scheduled).toEqual([]);

      let lostAcks = 0;
      expect(await consumer.handle(actionEvent(
        actionBody('change'),
        () => { lostAcks += 1; },
      ))).toBe('lost');
      expect(lostAcks).toBe(1);
      expect(reopened.findGateResolution(GATE)).toMatchObject({
        retryRequestId: REQUEST,
        ackState: 'pending',
      });
      expect(scheduled).toEqual([]);

      let duplicateAcks = 0;
      expect(await consumer.handle(actionEvent(
        actionBody('keep'),
        () => { duplicateAcks += 1; },
      ))).toBe('duplicate');
      expect(duplicateAcks).toBe(1);
      expect(reopened.findGateResolution(GATE)).toMatchObject({
        retryRequestId: REQUEST,
        ackState: 'acked',
        lifecycle: 'claimed',
      });
      expect(scheduled).toHaveLength(1);
      expect(reopened.findGateResolution(GATE)?.retryRequestId).toBe(REQUEST);

      const scheduledResolution = scheduled[0];
      if (scheduledResolution === undefined) throw new Error('Audit B resolution was not scheduled');
      await scheduledResolution();
      expect(orca.retryRequests).toEqual([REQUEST]);
      expect(reopened.findGateResolution(GATE)).toMatchObject({
        retryRequestId: REQUEST,
        ackState: 'acked',
        lifecycle: 'resolved',
        optionId: 'keep',
        optionResolution: '현행 유지',
      });
      expect(resolutionSlack.updates.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(resolutionSlack.updates.at(-1))).not.toContain('"type":"actions"');
      expect(reopened.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
      expect(reopened.findGateMessage(GATE)?.renderFingerprint).not.toBe('audit-b-stale-fingerprint');
    } finally {
      reopened.close();
    }
  });

  it('startup forces the newest card after a stale Slack success crashes before local completion', async () => {
    const path = join(dir, 'projection-crash-before-local.db');
    const firstStore = seed(path);
    const secondStore = new SqliteDigestStore(path, { observationOwnerAlive: () => true });
    const staleSlack = new DeferredFirstSlack();
    const stale = projectGateResolutionCard(
      firstStore,
      staleSlack,
      GATE,
      () => new Date(AT),
      (point) => {
        if (point === 'after_slack_success_before_local_completion') {
          throw new Error('projector died after stale Slack success');
        }
      },
    );
    await staleSlack.firstStarted;
    const lease = secondStore.acquireGateResolutionLease(
      GATE,
      't.projection-crash-lifecycle',
      AT,
      '2026-08-24T10:01:00.000Z',
    );
    if (lease.kind !== 'acquired') throw new Error('projection lifecycle lease failed');
    expect(secondStore.updateGateResolution(
      GATE,
      lease.intent.revision,
      't.projection-crash-lifecycle',
      { lifecycle: 'uncertain', errorCode: 'injected_newer_generation', at: AT },
    )).not.toBeNull();

    const blockedSlack = new FakeSlack();
    expect(await projectGateResolutionCard(
      secondStore, blockedSlack, GATE, () => new Date(AT),
    )).toMatchObject({ kind: 'pending' });
    expect(blockedSlack.updates).toEqual([]);
    staleSlack.releaseFirst();
    await expect(stale).rejects.toThrow(/projector died/);
    expect(secondStore.findGateResolutionOutbox(GATE)?.cardPending).toBe(true);

    // Model PID reuse after process death: liveness alone remains true, but durable expiry wins.
    firstStore.close();
    const reusedPidSlack = new FakeSlack();
    expect(await projectGateResolutionCard(
      secondStore,
      reusedPidSlack,
      GATE,
      () => new Date('2026-08-24T10:00:29.999Z'),
    )).toMatchObject({ kind: 'pending' });
    expect(reusedPidSlack.updates).toEqual([]);
    const recoveredSlack = new FakeSlack();
    await projectGateResolutionCard(
      secondStore,
      recoveredSlack,
      GATE,
      () => new Date('2026-08-24T10:00:30.000Z'),
    );
    expect(recoveredSlack.updates).toHaveLength(1);
    expect(JSON.stringify(recoveredSlack.updates[0])).toContain('degraded');
    expect(secondStore.findGateResolutionOutbox(GATE)?.cardPending).toBe(false);
    secondStore.close();
  });

  it('a two-store reconciliation pass skips a live renewable lease without blocking shutdown', async () => {
    const path = join(dir, 'two-process-lease.db');
    const firstStore = seed(path);
    const laterGate = gateKey('z_later');
    const laterMessageTs = '1787554800.000003';
    firstStore.insertGateMetadata({
      source: 'registered',
      gateKey: laterGate, runKey: RUN, taskKey: TASK, dispatchKey: dispatchKey('ctx_later'),
      askMessageId: 'msg_later', questionThreadId: 'thread_later',
      options: [{ id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' }],
      recommendation: { optionId: 'keep', reason: '호환성' }, impact: '후속', registeredAt: AT,
    });
    firstStore.insertGateMessage({
      gateKey: laterGate, runKey: RUN, channelId: CHANNEL, threadTs: THREAD_TS,
      messageTs: laterMessageTs, renderFingerprint: 'later-fp', at: AT,
    });
    firstStore.saveGateLocalObservation({
      gateKey: laterGate, runKey: RUN, taskKey: TASK, status: 'pending', resolution: null,
      resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: AT,
    });
    const laterClaim = firstStore.claimGateResolution({
      teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
      threadTs: THREAD_TS, messageTs: laterMessageTs, blockId: gateBlockId(laterGate),
      actionId: gateActionId(laterGate, 'keep'), actionValue: 'keep',
      retryRequestId: '22222222-2222-4222-8222-222222222222', at: AT,
    });
    if (laterClaim.kind !== 'claimed') throw new Error('later claim failed');
    const laterAck = firstStore.markGateResolutionAck(
      laterGate, laterClaim.intent.revision, 'acked', AT,
    );
    if (laterAck === null) throw new Error('later ACK failed');
    const laterLease = firstStore.acquireGateResolutionLease(
      laterGate, 't.later-seed', AT, '2026-08-24T10:01:00.000Z',
    );
    if (laterLease.kind !== 'acquired') throw new Error('later lease failed');
    expect(firstStore.updateGateResolution(laterGate, laterLease.intent.revision, 't.later-seed', {
      lifecycle: 'degraded', errorCode: 'later_pending_projection', at: AT,
    })).not.toBeNull();
    const secondStore = new SqliteDigestStore(path);
    const orca = new FakeOrca();
    orca.blockResolveResponse = true;
    const leaseBase = new Date(AT).valueOf();
    let leaseClock = leaseBase;
    const leaseNow = (): Date => new Date(leaseClock);
    const first = engine(firstStore, orca, new FakeSlack(), undefined, 100, leaseNow);
    const secondSlack = new FakeSlack();
    const second = engine(secondStore, orca, secondSlack, undefined, 100, leaseNow);
    const firstRun = first.resolveAndProject(GATE);
    await orca.resolveStarted;

    const initialExpiry = firstStore.findGateResolution(GATE)?.leaseExpiresAt;
    if (initialExpiry === null || initialExpiry === undefined) throw new Error('initial lease missing');
    leaseClock = leaseBase + 80;
    // Wait for an observed renewal, not an elapsed wall-clock guess. Under a loaded CI worker the
    // event loop may not run a 33 ms interval before a fixed 180 ms assertion, which correctly
    // fences the owner but makes this renewable-lease test nondeterministic.
    let renewedExpiry = initialExpiry;
    for (let attempt = 0; attempt < 200 && renewedExpiry === initialExpiry; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      renewedExpiry = firstStore.findGateResolution(GATE)?.leaseExpiresAt ?? initialExpiry;
    }
    expect(renewedExpiry > initialExpiry).toBe(true);
    leaseClock = leaseBase + 150; // past the original lease, still inside the observed renewal

    const secondRun = second.reconcile();
    expect(await Promise.race([
      secondRun.then(() => 'settled' as const),
      new Promise<'timed_out'>((resolve) => setTimeout(() => resolve('timed_out'), 50)),
    ])).toBe('settled');
    expect(secondSlack.updates.some((update) => update.ts === laterMessageTs)).toBe(true);
    expect(orca.calls.map((call) => call[1])).toEqual([
      'gate-list', 'gate-list', 'run-show', 'gate-resolve',
    ]);
    orca.releaseResolve();
    await firstRun;
    expect(orca.retryRequests).toEqual([REQUEST]);
    expect(firstStore.findGateResolution(GATE)).toMatchObject({ lifecycle: 'resolved' });
    expect(secondStore.findGateResolution(GATE)).toMatchObject({ lifecycle: 'resolved' });
    firstStore.close();
    secondStore.close();
  });

  it('an expired renewal fence aborts before Orca mutation and leaves restart-safe state', async () => {
    const store = seed(join(dir, 'lease-expired-before-mutation.db'));
    const orca = new FakeOrca();
    const base = new Date(AT).valueOf();
    let leaseClock = base;
    const worker = new GateResolutionEngine({
      store,
      orca,
      slack: new FakeSlack(),
      now: () => new Date(AT),
      leaseNow: () => new Date(leaseClock),
      leaseDurationMs: 100,
      leaseOwner: 't.engine-expiry-fence',
      fault: (point) => {
        if (point === 'after_pre_read_before_resolve') leaseClock = base + 101;
      },
    });
    await worker.resolveAndProject(GATE);
    expect(orca.calls.map((call) => call[1])).toEqual(['gate-list']);
    expect(orca.retryRequests).toEqual([]);
    expect(store.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'pre_read',
      leaseOwner: null,
      resolveResult: null,
    });
    store.close();
  });
});
