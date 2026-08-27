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

/**
 * JSON field whose contract is specifically an array of strings.
 *
 * `parseJsonField` intentionally accepts already-decoded objects because `result` is object-shaped.
 * Reusing its generic cast for `deps` or Gate `options`, however, lets an object masquerade as an
 * array until a later `.map`/`.join`/iterator call throws and kills the whole observation. Keep the
 * shape check at the adapter boundary so callers receive the existing explicit `unreadable` outcome.
 */
export function parseStringArrayField(
  value: unknown,
  fallback: readonly string[],
  at: string,
): readonly string[] {
  const parsed = parseJsonField<unknown>(value, fallback);
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${at}이(가) string array가 아니다`);
  }
  for (let index = 0; index < parsed.length; index += 1) {
    if (typeof parsed[index] !== 'string') {
      throw new TypeError(`${at}[${index}]이(가) string이 아니다`);
    }
  }
  return parsed;
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

/**
 * `<repositoryId>::<로컬 경로>` 형태에서 앞부분을 꺼낸다. 형식이 다르면 null.
 *
 * 일반화한 `<repository-id>::<absolute-worktree-path>` 형식에서 앞부분은 worktree가 아닌
 * repository id다. 여러 worktree id가 동일한 접두사를 공유하고 응답의 repository id
 * 필드와도 일치했으며, Task의 worktree id도 같은 앞부분을 사용하므로 두 표면에 같은
 * 함수를 쓴다.
 *
 * **이 형식의 안정성은 계약이 아니다.** `docs/platform-capabilities.md` §7.1이 `<uuid>::<path>`
 * 파싱 안정성을 미검증으로 기록했고, 이 id가 Orca 재설치나 DB 재생성 뒤에도 유지되는지는
 * 관측하지 않았다. 형식이 바뀌면 이 함수는 null을 돌려주고 등록 대조가 전부 어긋난다.
 * 그 상태를 조용히 넘기지 않는 것이 `run/collect.ts`의 미등록 Run 계수다(OD-078).
 */
export function repositoryIdFromWorktreeId(worktreeId: string): string | null {
  const idx = worktreeId.indexOf('::');
  if (idx <= 0) return null;
  return worktreeId.slice(0, idx);
}

/** `<repositoryId>::<로컬 경로>` 형태에서 경로를 꺼낸다. 형식이 다르면 null. */
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
