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

/**
 * `pr:<repo databaseId>#<number>`에서 PR 번호를 되읽는다. **표시용이다.**
 *
 * 이 함수가 필요한 이유는 하나다. Run 카드가 store에 저장된 `pr_key`만으로 `#N`을 그려야
 * 하는데(UX §3.1), key는 repository를 숫자 databaseId로 담으므로 `owner/name`도 URL도 여기서
 * 만들 수 없다. 만들려면 GitHub을 다시 조회해야 하고 그것은 D1 범위 밖이다.
 *
 * 타입은 형식을 강제하지만 **저장소에서 읽은 값은 문자열을 캐스팅한 것**이라 타입이 지켜주지
 * 않는다. 그래서 실제로 파싱하고 어긋나면 던진다. 0을 돌려주면 카드에 `#0`이 그려진다.
 */
export function pullRequestNumber(key: PullRequestKey): number {
  const at = key.lastIndexOf('#');
  const parsed = at === -1 ? Number.NaN : Number(key.slice(at + 1));
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`PullRequestKey에서 PR 번호를 읽을 수 없다: ${key}`);
  }
  return parsed;
}
