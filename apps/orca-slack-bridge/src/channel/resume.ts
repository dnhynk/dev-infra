import { randomUUID } from 'node:crypto';

import type { GateKey } from '../identity/keys.js';
import {
  readExactResumeDispatch,
  readStrictResumeTaskDispatch,
  readStrictResumeTasks,
  readStrictResumeWorkers,
  type OrcaRunner,
  type StrictResumeTask,
} from '../orca/client.js';
import type { GateStore } from '../store/schema.js';
import type {
  GateChannelDelivery,
  GateResumeEvidence,
  GateResumeObservation,
  GateResumeSnapshot,
  GateResumeTaskFact,
} from '../gate/resolution-types.js';

const RESUME_RUNNING = new Set(['dispatched', 'completed']);
export const DEFAULT_RESUME_OBSERVATION_BACKOFF_MS = 30_000;

function record(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${at}이(가) object가 아니다`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], at: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new TypeError(`${at} shape가 어긋난다`);
  }
}

function text(value: unknown, at: string, cap = 500): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > cap) {
    throw new TypeError(`${at}이(가) 1..${cap}자의 string이 아니다`);
  }
  return value;
}

/** Canonicalize and strictly bound the only Orca facts allowed in durable resume evidence. */
export function normalizeGateResumeSnapshot(value: unknown, at = 'resume snapshot'): GateResumeSnapshot {
  const root = record(value, at);
  exactKeys(root, ['schemaVersion', 'sourceTaskId', 'sourceDispatchId', 'candidates'], at);
  if (root['schemaVersion'] !== 1 || !Array.isArray(root['candidates'])) {
    throw new TypeError(`${at} schemaVersion/candidates가 어긋난다`);
  }
  const sourceTaskId = text(root['sourceTaskId'], `${at}.sourceTaskId`);
  const sourceDispatchId = text(root['sourceDispatchId'], `${at}.sourceDispatchId`);
  const taskIds = new Set<string>();
  const dispatchIds = new Set<string>();
  const candidates: GateResumeTaskFact[] = root['candidates'].map((raw, taskIndex) => {
    const task = record(raw, `${at}.candidates[${taskIndex}]`);
    exactKeys(
      task,
      ['taskId', 'status', 'currentDispatchId', 'dispatches'],
      `${at}.candidates[${taskIndex}]`,
    );
    const taskId = text(task['taskId'], `${at}.candidates[${taskIndex}].taskId`);
    if (taskIds.has(taskId)) throw new TypeError(`${at}에 중복 Task ${taskId}가 있다`);
    taskIds.add(taskId);
    const currentDispatchId = task['currentDispatchId'];
    if (currentDispatchId !== null && typeof currentDispatchId !== 'string') {
      throw new TypeError(`${at}.${taskId}.currentDispatchId가 string/null이 아니다`);
    }
    if (!Array.isArray(task['dispatches'])) {
      throw new TypeError(`${at}.${taskId}.dispatches가 array가 아니다`);
    }
    const dispatches = task['dispatches'].map((rawDispatch, dispatchIndex) => {
      const dispatch = record(rawDispatch, `${at}.${taskId}.dispatches[${dispatchIndex}]`);
      exactKeys(dispatch, ['dispatchId', 'status'], `${at}.${taskId}.dispatches[${dispatchIndex}]`);
      const dispatchId = text(
        dispatch['dispatchId'],
        `${at}.${taskId}.dispatches[${dispatchIndex}].dispatchId`,
      );
      if (dispatchIds.has(dispatchId)) {
        throw new TypeError(`${at}에 중복 Dispatch ${dispatchId}가 있다`);
      }
      dispatchIds.add(dispatchId);
      return {
        dispatchId,
        status: text(dispatch['status'], `${at}.${dispatchId}.status`, 80),
      };
    }).sort((a, b) => a.dispatchId.localeCompare(b.dispatchId));
    const normalizedCurrent = currentDispatchId === null
      ? null
      : text(currentDispatchId, `${at}.${taskId}.currentDispatchId`);
    const status = text(task['status'], `${at}.${taskId}.status`, 80);
    if (status === 'dispatched' && normalizedCurrent === null) {
      throw new TypeError(`${at}.${taskId}.currentDispatchId가 dispatched 상태에서 없다`);
    }
    if (
      normalizedCurrent !== null &&
      !dispatches.some((dispatch) => dispatch.dispatchId === normalizedCurrent)
    ) {
      throw new TypeError(`${at}.${taskId}.currentDispatchId가 worker reread에 없다`);
    }
    return {
      taskId,
      status,
      currentDispatchId: normalizedCurrent,
      dispatches,
    };
  }).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const source = candidates.find((candidate) => candidate.taskId === sourceTaskId);
  if (source === undefined || !source.dispatches.some((row) => row.dispatchId === sourceDispatchId)) {
    throw new TypeError(`${at}의 source Task/Dispatch correlation이 어긋난다`);
  }
  return { schemaVersion: 1, sourceTaskId, sourceDispatchId, candidates };
}

export function parseGateResumeSnapshotJson(raw: string, at: string): GateResumeSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(`${at}이(가) JSON이 아니다`);
  }
  const normalized = normalizeGateResumeSnapshot(parsed, at);
  if (JSON.stringify(normalized) !== raw) {
    throw new TypeError(`${at}이(가) canonical normalized JSON이 아니다`);
  }
  return normalized;
}

function candidateTasks(
  tasks: readonly StrictResumeTask[],
  sourceTaskId: string,
): readonly StrictResumeTask[] {
  if (!tasks.some((task) => task.id === sourceTaskId)) {
    throw new TypeError('resume source Task가 strict reread에 정확히 한 건이 아니다');
  }
  const candidateIds = new Set([sourceTaskId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (candidateIds.has(task.id)) continue;
      if (task.deps.some((dep) => candidateIds.has(dep))) {
        candidateIds.add(task.id);
        changed = true;
      }
    }
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return [...candidateIds].sort().map((taskId) => {
    const task = byId.get(taskId);
    if (task === undefined) throw new TypeError(`resume candidate Task ${taskId}가 없다`);
    return task;
  });
}

function stableCandidateTaskCut(tasks: readonly StrictResumeTask[]): string {
  return JSON.stringify(tasks.map((task) => ({
    taskId: task.id,
    status: task.status,
    currentDispatchId: task.currentDispatchId,
    deps: [...task.deps].sort(),
  })));
}

/**
 * Bracket worker history with two identical targeted Task cuts, then build source + transitive
 * dependency descendants without persisting unrelated Orca rows. A mixed external cut is retried
 * instead of becoming either a pre-send baseline or positive evidence.
 */
export async function readGateResumeSnapshot(
  runner: OrcaRunner,
  identity: { readonly runId: string; readonly taskId: string; readonly dispatchId: string },
  signal?: AbortSignal,
): Promise<GateResumeSnapshot> {
  const options = signal === undefined ? undefined : { signal };
  const beforeTasks = candidateTasks(
    await readStrictResumeTasks(runner, identity.runId, options),
    identity.taskId,
  );
  const workers = await readStrictResumeWorkers(runner, identity.runId, options);
  const omittedCompletedDispatches = new Map(
    await Promise.all(beforeTasks
      .filter((task) => task.status === 'completed' && task.currentDispatchId === null)
      .map(async (task) => {
        const dispatch = await readStrictResumeTaskDispatch(runner, {
          runId: identity.runId,
          taskId: task.id,
        }, options);
        const matchingWorkers = workers.filter((worker) => worker.dispatchId === dispatch.dispatchId);
        if (
          !RESUME_RUNNING.has(dispatch.status) ||
          matchingWorkers.length !== 1 ||
          matchingWorkers[0]?.taskId !== task.id ||
          matchingWorkers[0]?.runId !== identity.runId ||
          matchingWorkers[0]?.dispatchStatus !== dispatch.status
        ) {
          throw new TypeError(
            `resume candidate Task ${task.id}의 omitted current Dispatch correlation이 어긋난다`,
          );
        }
        return [task.id, dispatch.dispatchId] as const;
      })),
  );
  const tasks = candidateTasks(
    await readStrictResumeTasks(runner, identity.runId, options),
    identity.taskId,
  );
  if (stableCandidateTaskCut(beforeTasks) !== stableCandidateTaskCut(tasks)) {
    throw new TypeError('resume Task/worker bracket가 하나의 stable cut이 아니다');
  }
  for (const task of tasks) {
    if (task.status === 'completed' && task.currentDispatchId === null &&
      !omittedCompletedDispatches.has(task.id)) {
      throw new TypeError(`resume candidate Task ${task.id}의 omitted current Dispatch가 없다`);
    }
  }
  const sourceWorkers = workers.filter((worker) => worker.dispatchId === identity.dispatchId);
  if (
    sourceWorkers.length !== 1 ||
    sourceWorkers[0]?.taskId !== identity.taskId ||
    sourceWorkers[0]?.runId !== identity.runId
  ) {
    throw new TypeError('resume source Dispatch correlation이 어긋난다');
  }
  const candidates = tasks.map((task) => {
    const taskId = task.id;
    const dispatches = workers
      .filter((worker) => worker.taskId === taskId)
      .map((worker) => ({ dispatchId: worker.dispatchId, status: worker.dispatchStatus }));
    const current = task.currentDispatchId === null
      ? null
      : dispatches.find((dispatch) => dispatch.dispatchId === task.currentDispatchId) ?? null;
    if (
      !RESUME_RUNNING.has(task.status) &&
      dispatches.some((dispatch) => dispatch.status === 'dispatched')
    ) {
      throw new TypeError(`resume candidate Task ${taskId}의 current worker correlation이 어긋난다`);
    }
    if (
      task.status === 'dispatched' &&
      (current?.status !== 'dispatched' ||
        dispatches.some(
          (dispatch) =>
            dispatch.status === 'dispatched' && dispatch.dispatchId !== task.currentDispatchId,
        ))
    ) {
      throw new TypeError(`resume candidate Task ${taskId}의 current worker correlation이 어긋난다`);
    }
    return {
      taskId,
      status: task.status,
      currentDispatchId: task.currentDispatchId,
      dispatches,
    };
  });
  return normalizeGateResumeSnapshot({
    schemaVersion: 1,
    sourceTaskId: identity.taskId,
    sourceDispatchId: identity.dispatchId,
    candidates,
  });
}

/** Pure conservative comparison; ambiguity returns no witness. */
export function detectGateResumeEvidence(
  baselineValue: GateResumeSnapshot,
  latestValue: GateResumeSnapshot,
): GateResumeEvidence | null {
  const baseline = normalizeGateResumeSnapshot(baselineValue, 'resume baseline');
  const latest = normalizeGateResumeSnapshot(latestValue, 'resume latest');
  if (
    baseline.sourceTaskId !== latest.sourceTaskId ||
    baseline.sourceDispatchId !== latest.sourceDispatchId
  ) return null;
  const before = new Map(baseline.candidates.map((task) => [task.taskId, task]));
  const witnesses = new Map<string, {
    task: GateResumeTaskFact;
    dispatchStatus: 'dispatched' | 'completed';
    isNew: boolean;
    from: string | null;
  }>();
  for (const task of latest.candidates) {
    if (!RESUME_RUNNING.has(task.status)) continue;
    const runningDispatches = task.currentDispatchId === null
      ? task.status === 'completed'
        ? task.dispatches.filter((dispatch) => RESUME_RUNNING.has(dispatch.status))
        : []
      : task.dispatches.filter(
          (dispatch) =>
            dispatch.dispatchId === task.currentDispatchId && RESUME_RUNNING.has(dispatch.status),
        );
    const previous = before.get(task.taskId);
    const newDispatches = runningDispatches.filter(
      (currentDispatch) => previous === undefined ||
        !previous.dispatches.some(
          (dispatch) => dispatch.dispatchId === currentDispatch.dispatchId,
        ),
    );
    if (newDispatches.length > 0) {
      for (const currentDispatch of newDispatches) {
        witnesses.set(`${task.taskId}\u0000${currentDispatch.dispatchId}`, {
          task,
          dispatchStatus: currentDispatch.status as 'dispatched' | 'completed',
          isNew: true,
          from: previous?.status ?? null,
        });
      }
    }
    const statusTransition = previous !== undefined &&
      !RESUME_RUNNING.has(previous.status) &&
      RESUME_RUNNING.has(task.status);
    if (!statusTransition || runningDispatches.length === 0) continue;
    const transitionedDispatches = runningDispatches.filter((currentDispatch) => {
      const beforeDispatch = previous.dispatches.find(
        (dispatch) => dispatch.dispatchId === currentDispatch.dispatchId,
      );
      return beforeDispatch !== undefined && !RESUME_RUNNING.has(beforeDispatch.status);
    });
    for (const currentDispatch of transitionedDispatches) {
      witnesses.set(`${task.taskId}\u0000${currentDispatch.dispatchId}`, {
        task,
        dispatchStatus: currentDispatch.status as 'dispatched' | 'completed',
        isNew: false,
        from: previous.status,
      });
    }
  }
  if (witnesses.size !== 1) return null;
  const [identity, witness] = [...witnesses.entries()][0]!;
  const [taskId, dispatchId] = identity.split('\u0000') as [string, string];
  return {
    kind: witness.isNew ? 'new_dispatch' : 'status_transition',
    taskId,
    dispatchId,
    fromStatus: witness.from,
    toStatus: witness.isNew
      ? witness.dispatchStatus
      : witness.task.status as 'dispatched' | 'completed',
  };
}

export type GateResumeEngineOptions = {
  readonly store: GateStore;
  readonly orca: OrcaRunner;
  readonly now?: () => Date;
  readonly leaseMs?: number;
  readonly retryMs?: number;
  readonly batchLimit?: number;
};

function positiveMs(value: number, at: string): number {
  if (!Number.isFinite(value) || value < 1) throw new TypeError(at);
  return Math.trunc(value);
}

function later(at: string, delayMs: number): string {
  return new Date(new Date(at).valueOf() + delayMs).toISOString();
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Pre-send baseline gate plus the targeted receipt/consumption resume scheduler. */
export class GateResumeEngine {
  readonly #store: GateStore;
  readonly #orca: OrcaRunner;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #retryMs: number;
  readonly #batchLimit: number;

  constructor(options: GateResumeEngineOptions) {
    this.#store = options.store;
    this.#orca = options.orca;
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = positiveMs(options.leaseMs ?? 30_000, 'resume_lease_invalid');
    this.#retryMs = positiveMs(
      options.retryMs ?? DEFAULT_RESUME_OBSERVATION_BACKOFF_MS,
      'resume_retry_invalid',
    );
    const batchLimit = options.batchLimit ?? 64;
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 1_000) {
      throw new TypeError('resume_batch_limit_invalid');
    }
    this.#batchLimit = batchLimit;
  }

  async ensureBaseline(
    delivery: GateChannelDelivery,
    owner: string,
    signal?: AbortSignal,
  ): Promise<GateChannelDelivery | null> {
    // v11 deliveries predate resume observations. They must retain D3-2 delivery liveness, but
    // can never acquire retroactive D3-3 evidence because no pre-send baseline exists.
    if (delivery.resumeBaselineState === 'unavailable') return delivery;
    if (delivery.resumeBaselineState === 'recorded') {
      return this.#store.findGateResumeObservation(delivery.gateKey) === null ? null : delivery;
    }
    const baseline = await readGateResumeSnapshot(this.#orca, {
      runId: delivery.runKey.slice('run:'.length),
      taskId: delivery.taskKey.slice('task:'.length),
      dispatchId: delivery.sourceDispatchId,
    }, signal);
    if (isAborted(signal)) return null;
    return this.#store.recordGateResumeBaseline(
      delivery.gateKey,
      delivery.revision,
      owner,
      baseline,
      this.#now().toISOString(),
    );
  }

  async reconcile(signal?: AbortSignal): Promise<void> {
    const at = this.#now().toISOString();
    const due = this.#store.listDueGateResumeObservations(at, this.#batchLimit);
    for (const candidate of due) {
      if (isAborted(signal)) return;
      await this.#reconcileOne(candidate, signal);
    }
  }

  async #reconcileOne(candidate: GateResumeObservation, signal?: AbortSignal): Promise<void> {
    const owner = `p${process.pid}.${randomUUID()}`;
    const acquiredAt = this.#now().toISOString();
    const lease = this.#store.acquireGateResumeLease(
      candidate.gateKey,
      candidate.revision,
      owner,
      acquiredAt,
      later(acquiredAt, this.#leaseMs),
    );
    if (lease.kind !== 'acquired') return;
    let released = false;
    const releaseOnAbort = (): void => {
      if (released) return;
      // Abort dispatch is synchronous. Relinquish this exact owner before the outer delivery
      // scheduler detaches non-cooperative Orca work and permits SQLite shutdown/restart.
      try {
        this.#store.releaseGateResumeLease(
          candidate.gateKey,
          owner,
          this.#now().toISOString(),
        );
      } catch {
        // The owner is fenced by its random identity and every late completion observes abort.
        // A store that is already unavailable cannot safely accept another cleanup write.
      } finally {
        released = true;
      }
    };
    signal?.addEventListener('abort', releaseOnAbort, { once: true });
    if (isAborted(signal)) releaseOnAbort();
    try {
      if (released || isAborted(signal)) return;
      const delivery = this.#store.findGateChannelDelivery(candidate.gateKey);
      if (delivery === null || delivery.resumeBaselineState !== 'recorded') return;
      let latest: GateResumeSnapshot;
      try {
        latest = await readGateResumeSnapshot(this.#orca, {
          runId: delivery.runKey.slice('run:'.length),
          taskId: delivery.taskKey.slice('task:'.length),
          dispatchId: delivery.sourceDispatchId,
        }, signal);
        if (isAborted(signal)) return;
      } catch {
        if (isAborted(signal)) return;
        const failedAt = this.#now().toISOString();
        released = this.#store.recordGateResumeObservation(
          candidate.gateKey,
          lease.observation.revision,
          owner,
          null,
          null,
          failedAt,
          later(failedAt, this.#retryMs),
          'resume_read_failed',
        ) !== null;
        return;
      }
      let evidence = detectGateResumeEvidence(lease.observation.baseline, latest);
      if (evidence !== null) {
        try {
          const dispatch = await readExactResumeDispatch(this.#orca, {
            runId: delivery.runKey.slice('run:'.length),
            taskId: evidence.taskId,
            dispatchId: evidence.dispatchId,
          }, signal === undefined ? undefined : { signal });
          if (isAborted(signal)) return;
          if (dispatch.status !== evidence.toStatus || !RESUME_RUNNING.has(dispatch.status)) {
            evidence = null;
          }
        } catch {
          evidence = null;
        }
      }
      const observedAt = this.#now().toISOString();
      if (isAborted(signal)) return;
      released = this.#store.recordGateResumeObservation(
        candidate.gateKey,
        lease.observation.revision,
        owner,
        latest,
        evidence,
        observedAt,
        later(observedAt, this.#retryMs),
        null,
      ) !== null;
    } finally {
      signal?.removeEventListener('abort', releaseOnAbort);
      if (!released) {
        this.#store.releaseGateResumeLease(candidate.gateKey, owner, this.#now().toISOString());
      }
    }
  }
}
