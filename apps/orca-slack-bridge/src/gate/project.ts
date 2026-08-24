import { gateKey, runKey, taskKey } from '../identity/keys.js';
import type { OrcaGate, OrcaTask, Read } from '../orca/client.js';
import type {
  GateDecisionFacts,
  GateMetadata,
  GateOptionFacts,
  GateTaskFacts,
} from './types.js';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed']);

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function depsKey(deps: Read<readonly string[]>): string {
  return deps.kind === 'unreadable'
    ? `1\u0000${deps.reason}`
    : `0\u0000${[...new Set(deps.value)].sort(compare).join('\u0000')}`;
}

/** Total order so duplicate/conflicting rows cannot reintroduce source-row order. */
function byTask(a: OrcaTask, b: OrcaTask): number {
  return compare(
    [a.id, a.status, a.title, depsKey(a.deps)].join('\u0001'),
    [b.id, b.status, b.title, depsKey(b.deps)].join('\u0001'),
  );
}

function taskFacts(task: OrcaTask): GateTaskFacts {
  return { taskId: task.id, title: task.title, status: task.status };
}

type TaskClassification = {
  readonly waiting: readonly GateTaskFacts[];
  readonly independent: readonly GateTaskFacts[];
  readonly unclassified: readonly GateTaskFacts[];
  readonly degraded: readonly string[];
};

/**
 * Find the Gate Task and every Task transitively depending on it.
 *
 * The closure contains current nonterminal Task nodes only. Completed/failed rows are observed so a
 * dependency on one is not mistaken for a missing row, but they are neither displayed nor allowed to
 * bridge the Gate to a downstream current Task. An unreadable or missing dependency makes that Task
 * (and known downstream dependants) unclassified; it is never silently treated as an empty list.
 */
export function classifyGateTasks(
  gateTaskId: string,
  input: readonly OrcaTask[],
): TaskClassification {
  const ordered = [...input].sort(byTask);
  const observedIds = new Set(ordered.map((task) => task.id));
  const tasks = new Map<string, OrcaTask>();
  const duplicateIds = new Set<string>();
  for (const task of ordered) {
    if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
    if (tasks.has(task.id)) {
      duplicateIds.add(task.id);
      continue;
    }
    tasks.set(task.id, task);
  }

  const waitingIds = new Set<string>(tasks.has(gateTaskId) ? [gateTaskId] : []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks.values()) {
      if (waitingIds.has(task.id) || task.deps.kind === 'unreadable') continue;
      const deps = new Set(task.deps.value);
      if ([...deps].some((dependency) => waitingIds.has(dependency))) {
        waitingIds.add(task.id);
        changed = true;
      }
    }
  }

  const unknownIds = new Set<string>(duplicateIds);
  const issues = new Set<string>();
  if (!tasks.has(gateTaskId)) {
    issues.add(`Gate Task ${gateTaskId}의 current nonterminal row가 없어 Task title/status를 표시할 수 없다`);
  }
  for (const task of tasks.values()) {
    if (waitingIds.has(task.id)) continue;
    if (task.deps.kind === 'unreadable') {
      unknownIds.add(task.id);
      issues.add(`Task ${task.id}의 deps를 읽지 못해 waiting/independent를 판정할 수 없다`);
      continue;
    }
    const missing = [...new Set(task.deps.value)]
      .filter((dependency) => !observedIds.has(dependency))
      .sort(compare);
    if (missing.length > 0) {
      unknownIds.add(task.id);
      issues.add(
        `Task ${task.id}의 dependency row가 없어 waiting/independent를 판정할 수 없다: ${missing.join(', ')}`,
      );
    }
  }
  for (const id of [...duplicateIds].sort(compare)) {
    if (!waitingIds.has(id)) issues.add(`Task ${id} row가 중복돼 dependency 관계를 하나로 판정하지 않았다`);
  }

  changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks.values()) {
      if (waitingIds.has(task.id) || unknownIds.has(task.id) || task.deps.kind === 'unreadable') {
        continue;
      }
      if (task.deps.value.some((dependency) => unknownIds.has(dependency))) {
        unknownIds.add(task.id);
        issues.add(`Task ${task.id}는 dependency 관계를 판정할 수 없는 Task에 의존한다`);
        changed = true;
      }
    }
  }

  const current = [...tasks.values()].sort((a, b) => compare(a.id, b.id));
  return {
    waiting: current.filter((task) => waitingIds.has(task.id)).map(taskFacts),
    independent: current
      .filter((task) => !waitingIds.has(task.id) && !unknownIds.has(task.id))
      .map(taskFacts),
    unclassified: current
      .filter((task) => !waitingIds.has(task.id) && unknownIds.has(task.id))
      .map(taskFacts),
    degraded: [...issues].sort(compare),
  };
}

function rawOptions(gate: OrcaGate): readonly GateOptionFacts[] {
  if (gate.options.kind === 'unreadable') return [];
  return gate.options.value.map((label) => ({
    id: null,
    label,
    description: null,
    resolution: null,
  }));
}

function sameLabels(gate: OrcaGate, metadata: GateMetadata): boolean {
  if (gate.options.kind === 'unreadable') return false;
  return (
    gate.options.value.length === metadata.options.length &&
    gate.options.value.every((label, index) => label === metadata.options[index]?.label)
  );
}

function metadataMismatch(gate: OrcaGate, metadata: GateMetadata): readonly string[] {
  const reasons: string[] = [];
  if (metadata.runKey !== runKey(gate.runId)) reasons.push('sidecar run identity가 Orca Gate와 어긋난다');
  if (metadata.taskKey !== taskKey(gate.taskId)) reasons.push('sidecar task identity가 Orca Gate와 어긋난다');
  if (gate.options.kind === 'unreadable') {
    reasons.push(`Orca Gate options를 읽지 못해 sidecar와 대조할 수 없다: ${gate.options.reason}`);
  } else if (!sameLabels(gate, metadata)) {
    reasons.push('sidecar option label/order가 Orca Gate options와 어긋난다');
  }
  return reasons;
}

function baseGateFacts(gate: OrcaGate, classification: TaskClassification) {
  return {
    key: gateKey(gate.id),
    gateId: gate.id,
    runId: gate.runId,
    taskId: gate.taskId,
    question: gate.question,
    status: gate.status,
    resolution: gate.resolution,
    resolvedAt: gate.resolvedAt?.toISOString() ?? null,
    waitingTasks: classification.waiting,
    independentTasks: classification.independent,
    unclassifiedTasks: classification.unclassified,
  } as const;
}

function degradedGateFacts(
  gate: OrcaGate,
  classification: TaskClassification,
  metadataState: 'missing' | 'mismatched',
  reasons: readonly string[],
): GateDecisionFacts {
  return {
    ...baseGateFacts(gate, classification),
    metadataState,
    correlation: null,
    options: rawOptions(gate),
    recommendation: null,
    impact: null,
    degraded: [...classification.degraded, ...reasons].sort(compare),
  };
}

/** Project every observed Gate; metadata absence or conflict never removes the card. */
export function projectGateDecisions(
  rawGates: readonly OrcaGate[],
  rawTasks: readonly OrcaTask[],
  sidecar: readonly GateMetadata[],
): readonly GateDecisionFacts[] {
  const metadata = new Map(sidecar.map((row) => [row.gateKey, row] as const));
  return [...rawGates]
    .sort((a, b) => compare(a.id, b.id))
    .map((gate): GateDecisionFacts => {
      const classification = classifyGateTasks(gate.taskId, rawTasks);
      const stored = metadata.get(gateKey(gate.id));
      const mismatch = stored === undefined ? [] : metadataMismatch(gate, stored);

      if (stored === undefined) {
        const reasons = [`Gate ${gate.id}의 sidecar metadata가 없다`];
        if (gate.options.kind === 'unreadable') {
          reasons.push(`Gate ${gate.id}의 options를 읽지 못했다: ${gate.options.reason}`);
        }
        return degradedGateFacts(gate, classification, 'missing', reasons);
      }

      if (mismatch.length > 0) {
        return degradedGateFacts(
          gate,
          classification,
          'mismatched',
          mismatch.map((reason) => `Gate ${gate.id}: ${reason}`),
        );
      }

      const recommendation = stored.options.find(
        (option) => option.id === stored.recommendation.optionId,
      );
      // Registration and store reads both validate this. Keep the guard so a hand-built test double cannot
      // turn an invalid recommendation into a guessed label.
      if (recommendation === undefined) {
        return degradedGateFacts(gate, classification, 'mismatched', [
          `Gate ${gate.id}: sidecar recommendation이 options에 없다`,
        ]);
      }

      return {
        ...baseGateFacts(gate, classification),
        metadataState: 'matched',
        correlation: {
          askMessageId: stored.askMessageId,
          questionThreadId: stored.questionThreadId,
          dispatchId: stored.dispatchKey.slice('dispatch:'.length),
          taskId: gate.taskId,
          gateId: gate.id,
        },
        options: stored.options.map((option) => ({ ...option })),
        recommendation: {
          optionId: recommendation.id,
          label: recommendation.label,
          reason: stored.recommendation.reason,
        },
        impact: stored.impact,
        degraded: [...classification.degraded].sort(compare),
      };
    });
}
