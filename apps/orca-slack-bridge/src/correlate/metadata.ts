import type { CorrelationKeys } from '../project/config.js';

/**
 * PR body의 correlation metadata.
 *
 * 형식은 아직 계약이 아니다(OD-021, AB workstream 소유). 후보는 HTML comment다.
 *
 * ```html
 * <!-- orca-run: run_abc -->
 * <!-- orca-task: task_xyz -->
 * ```
 *
 * key 이름을 설정으로 주입받으므로 형식이 확정되면 설정만 바뀐다.
 */
export type CorrelationMetadata = {
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  /** 같은 key가 서로 다른 값으로 여러 번 나온 경우. 조용히 첫 값을 고르지 않는다. */
  readonly duplicates: readonly string[];
};

const VALUE = String.raw`[A-Za-z0-9_.:-]+`;
/** metadata key는 식별자로 제한한다. 정규식 메타문자를 이스케이프할 필요가 없어진다. */
const SAFE_KEY = /^[A-Za-z0-9_-]+$/;

function extract(body: string, key: string): string[] {
  if (!SAFE_KEY.test(key)) {
    throw new TypeError(`correlation key는 영숫자·밑줄·하이픈만 쓸 수 있다: ${key}`);
  }
  // <!-- key: value --> 형태. 공백은 관대하게 받는다.
  const re = new RegExp(String.raw`<!--\s*` + key + String.raw`\s*:\s*(` + VALUE + String.raw`)\s*-->`, 'g');
  const values: string[] = [];
  for (const m of body.matchAll(re)) {
    const v = m[1];
    if (v !== undefined) values.push(v);
  }
  return values;
}

function pick(body: string, key: string, duplicates: string[]): string | null {
  const values = extract(body, key);
  if (values.length === 0) return null;
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    duplicates.push(key);
    return null;
  }
  return distinct[0] ?? null;
}

export function parseCorrelationMetadata(
  body: string | null | undefined,
  keys: CorrelationKeys,
): CorrelationMetadata {
  const duplicates: string[] = [];
  if (!body) {
    return { runId: null, taskId: null, dispatchId: null, duplicates };
  }
  return {
    runId: pick(body, keys.run, duplicates),
    taskId: pick(body, keys.task, duplicates),
    dispatchId: pick(body, keys.dispatch, duplicates),
    duplicates,
  };
}

export function hasAnyCorrelation(m: CorrelationMetadata): boolean {
  return m.runId !== null || m.taskId !== null || m.dispatchId !== null;
}
