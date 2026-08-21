/**
 * entity의 canonical key.
 *
 * key는 관측 입력에서 **결정적으로 파생**된다. 저장소에 발급 기록을 두지 않으므로
 * 같은 입력을 반복 관측하면 항상 같은 key가 나온다.
 *
 * Repository는 GitHub 숫자 databaseId를 쓴다. rename과 owner 이전에도 유지되므로
 * 같은 repository가 새 entity로 갈라지지 않는다. `owner/name`은 표시용이며
 * 동등성 판정에 쓰지 않는다.
 */

export type RepositoryKey = `repo:${number}`;
export type RunKey = `run:${string}`;
export type TaskKey = `task:${string}`;
export type DispatchKey = `dispatch:${string}`;
export type GateKey = `gate:${string}`;
export type PullRequestKey = `pr:${number}#${number}`;

export type EntityKey =
  | RepositoryKey
  | RunKey
  | TaskKey
  | DispatchKey
  | GateKey
  | PullRequestKey;

function requireNonEmpty(value: string, what: string): string {
  const v = value.trim();
  if (v === '') throw new TypeError(`${what}가 비어 있다`);
  return v;
}

function requirePositiveInt(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${what}가 양의 정수가 아니다: ${value}`);
  }
  return value;
}

export function repositoryKey(githubDatabaseId: number): RepositoryKey {
  return `repo:${requirePositiveInt(githubDatabaseId, 'GitHub repository id')}`;
}

export function runKey(orcaRunId: string): RunKey {
  return `run:${requireNonEmpty(orcaRunId, 'Orca run id')}`;
}

export function taskKey(orcaTaskId: string): TaskKey {
  return `task:${requireNonEmpty(orcaTaskId, 'Orca task id')}`;
}

export function dispatchKey(orcaDispatchId: string): DispatchKey {
  return `dispatch:${requireNonEmpty(orcaDispatchId, 'Orca dispatch id')}`;
}

export function gateKey(orcaGateId: string): GateKey {
  return `gate:${requireNonEmpty(orcaGateId, 'Orca gate id')}`;
}

export function pullRequestKey(githubDatabaseId: number, number: number): PullRequestKey {
  return `pr:${requirePositiveInt(githubDatabaseId, 'GitHub repository id')}#${requirePositiveInt(number, 'PR 번호')}`;
}
