import type { CorrelationMetadata } from './metadata.js';
import { hasAnyCorrelation } from './metadata.js';
import { runKey, taskKey, dispatchKey, type RunKey, type TaskKey, type DispatchKey } from '../identity/keys.js';

/**
 * PR ↔ Orca 연결 결과.
 *
 * `uncorrelated`는 실패가 아니라 **정상 출력**이다. 관찰·상관관계 계약이
 * "metadata가 없거나 모순될 때 branch 이름이나 PR 제목만으로 조용히 확정하지
 * 않는다"고 규정하므로, 연결되지 않았다는 사실 자체를 그대로 보고한다.
 */
export type Correlation =
  | {
      readonly kind: 'correlated';
      readonly run: RunKey;
      readonly task: TaskKey | null;
      readonly dispatch: DispatchKey | null;
    }
  | { readonly kind: 'uncorrelated'; readonly reason: UncorrelatedReason }
  | { readonly kind: 'conflict'; readonly details: readonly string[] };

export type UncorrelatedReason =
  /** PR body에 correlation metadata가 없다. */
  | 'no_metadata'
  /** metadata에 run은 없고 task/dispatch만 있다. Run을 확정할 수 없다. */
  | 'run_missing'
  /** metadata가 가리키는 Run이 Orca에 없다. */
  | 'run_not_found';

/** Orca live 상태 중 correlation 판정에 필요한 부분. */
export type OrcaCorrelationView = {
  /** 존재하는 Run id 집합. */
  readonly runIds: ReadonlySet<string>;
  /** task id → 그 task가 속한 run id. */
  readonly taskToRun: ReadonlyMap<string, string>;
};

export function resolveCorrelation(
  metadata: CorrelationMetadata,
  orca: OrcaCorrelationView,
): Correlation {
  if (metadata.duplicates.length > 0) {
    return {
      kind: 'conflict',
      details: metadata.duplicates.map((k) => `PR body에 ${k} 값이 여러 개다`),
    };
  }

  if (!hasAnyCorrelation(metadata)) {
    return { kind: 'uncorrelated', reason: 'no_metadata' };
  }

  if (metadata.runId === null) {
    return { kind: 'uncorrelated', reason: 'run_missing' };
  }

  if (!orca.runIds.has(metadata.runId)) {
    return { kind: 'uncorrelated', reason: 'run_not_found' };
  }

  // task가 명시됐다면 그 task가 정말 그 Run에 속하는지 대조한다.
  // 모순을 자동으로 어느 한쪽으로 덮지 않는다.
  if (metadata.taskId !== null) {
    const owner = orca.taskToRun.get(metadata.taskId);
    if (owner === undefined) {
      return {
        kind: 'conflict',
        details: [`task ${metadata.taskId}가 Orca에 없다 (run ${metadata.runId})`],
      };
    }
    if (owner !== metadata.runId) {
      return {
        kind: 'conflict',
        details: [
          `task ${metadata.taskId}는 run ${owner}에 속하는데 PR metadata는 run ${metadata.runId}를 가리킨다`,
        ],
      };
    }
  }

  return {
    kind: 'correlated',
    run: runKey(metadata.runId),
    task: metadata.taskId === null ? null : taskKey(metadata.taskId),
    dispatch: metadata.dispatchId === null ? null : dispatchKey(metadata.dispatchId),
  };
}
