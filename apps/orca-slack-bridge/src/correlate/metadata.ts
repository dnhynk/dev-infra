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

function commentRe(key: string): RegExp {
  if (!SAFE_KEY.test(key)) {
    throw new TypeError(`correlation key는 영숫자·밑줄·하이픈만 쓸 수 있다: ${key}`);
  }
  // <!-- key: value --> 형태. 공백은 관대하게 받는다.
  return new RegExp(String.raw`<!--\s*` + key + String.raw`\s*:\s*(` + VALUE + String.raw`)\s*-->`, 'g');
}

function extract(body: string, key: string): string[] {
  const re = commentRe(key);
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

/**
 * PR body에서 correlation metadata 블록을 지운다.
 *
 * summarizer에 보내는 본문에서 기계용 주석을 빼는 용도다(OD-036). 사람이 읽는 내용은
 * 건드리지 않는다. 파싱과 같은 정규식을 쓴다. 두 곳에서 형식을 따로 정의하면 key 형식이
 * 바뀔 때 한쪽만 바뀐다.
 *
 * 중복 key도 모두 지운다. `duplicates`는 correlation 판정의 입력이지 본문 정리의 조건이 아니다.
 */
export function stripCorrelationMetadata(body: string, keys: CorrelationKeys): string {
  let out = body;
  for (const key of [keys.run, keys.task, keys.dispatch]) {
    out = out.replace(commentRe(key), '');
  }
  return out.trimEnd();
}
