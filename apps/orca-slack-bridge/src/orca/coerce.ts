/**
 * Orca row의 표현 불일치를 어댑터 경계에서 흡수한다.
 *
 * 실측된 불일치:
 * - `deps`, `options`, `result`는 배열/객체가 아니라 JSON 문자열이다.
 * - 타임스탬프 형식이 섞여 있다. Run은 ISO8601 UTC(`2026-08-21T14:32:45Z`),
 *   Task와 Gate는 타임존 없는 `2026-08-21 14:33:10`이다.
 */

/**
 * JSON 문자열로 저장된 필드를 파싱한다.
 * 이미 파싱된 값이 오면 그대로 통과시킨다. Orca가 나중에 형식을 바꿔도 깨지지 않는다.
 */
export function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  const trimmed = value.trim();
  if (trimmed === '') return fallback;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // 파싱 실패를 fallback으로 덮으면 데이터 손실을 조용히 넘긴다.
    throw new SyntaxError(`JSON 필드를 파싱할 수 없다: ${trimmed.slice(0, 80)}`);
  }
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/;

/**
 * Orca 타임스탬프를 Date로 바꾼다.
 *
 * 타임존이 없는 형식은 **UTC로 해석한다.** Orca가 이 형식을 로컬 시간으로 쓴다면
 * 이 가정은 틀린다. 두 형식이 같은 DB에서 나오고 Run 쪽이 명시적 UTC이므로
 * UTC가 더 그럴듯하지만, 실제 worker 데이터로 재확인해야 한다.
 */
export function parseOrcaTimestamp(value: string): Date {
  const m = NAIVE.exec(value);
  if (m) {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Orca 타임스탬프를 해석할 수 없다: ${value}`);
  }
  return d;
}

/** `<workspaceUuid>::<로컬 경로>` 형태에서 경로를 꺼낸다. 형식이 다르면 null. */
export function worktreePathFromId(worktreeId: string): string | null {
  const idx = worktreeId.indexOf('::');
  if (idx < 0) return null;
  const path = worktreeId.slice(idx + 2);
  return path.length > 0 ? path : null;
}

/**
 * Task의 `created_by_process_incarnation`에서 작업 디렉터리를 꺼낸다.
 * 관측 형태: `<uuid>::<경로>@@<hash>:<uuid>`
 */
export function worktreePathFromIncarnation(incarnation: string): string | null {
  const afterSep = worktreePathFromId(incarnation);
  if (afterSep === null) return null;
  const at = afterSep.indexOf('@@');
  const path = at < 0 ? afterSep : afterSep.slice(0, at);
  return path.length > 0 ? path : null;
}
