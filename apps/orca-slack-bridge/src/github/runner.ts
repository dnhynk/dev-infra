import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GITHUB_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;

/**
 * `gh` 호출 경계.
 *
 * 인터페이스로 분리해 테스트가 실제 네트워크를 타지 않게 하고,
 * 필요하면 REST 직접 호출로 교체할 수 있게 한다(OD-024).
 */
export interface GhRunner {
  /** stdout을 그대로 반환한다. 0이 아닌 종료 코드는 던진다. */
  run(args: readonly string[], options?: GhRunOptions): Promise<string>;
}

export type GhRunOptions = {
  /** Cancels the command and terminates the production child process. */
  readonly signal?: AbortSignal;
  /** Defense-in-depth subprocess timeout; callers still own an outer promise deadline. */
  readonly timeoutMs?: number;
};

export class GhCommandError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly terminated: boolean = false,
  ) {
    super(`gh ${args.join(' ')} 실패 (exit ${exitCode ?? 'unknown'}): ${stderr.trim()}`);
    this.name = 'GhCommandError';
  }
}

export class GhCli implements GhRunner {
  constructor(private readonly bin = 'gh') {}

  async run(args: readonly string[], options: GhRunOptions = {}): Promise<string> {
    if (options.timeoutMs !== undefined &&
        (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1)) {
      throw new TypeError('GitHub CLI timeout must be a finite positive number');
    }
    try {
      const { stdout } = await execFileAsync(this.bin, [...args], {
        encoding: 'utf8',
        maxBuffer: MAX_GITHUB_COMMAND_OUTPUT_BYTES,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.timeoutMs === undefined ? {} : { timeout: Math.trunc(options.timeoutMs) }),
        killSignal: 'SIGTERM',
      });
      return stdout;
    } catch (e) {
      const err = e as {
        code?: number | string;
        stderr?: string;
        killed?: boolean;
        signal?: string;
      };
      throw new GhCommandError(
        args,
        typeof err.code === 'number' ? err.code : null,
        err.stderr ?? String(e),
        options.signal?.aborted === true || err.killed === true || err.signal !== undefined,
      );
    }
  }
}

/** stdout을 JSON으로 파싱한다. 실패를 조용히 넘기지 않는다. */
export async function ghJson<T>(
  runner: GhRunner,
  args: readonly string[],
  options?: GhRunOptions,
): Promise<T> {
  const out = await runner.run(args, options);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new SyntaxError(`gh ${args.join(' ')} 출력이 JSON이 아니다: ${out.slice(0, 200)}`);
  }
}

/**
 * `gh api` 실패에서 HTTP status를 뽑는다.
 *
 * `gh api`는 실패해도 응답 body를 stdout에 쓰고 stderr에는 `gh: <message> (HTTP <code>)`만 남긴다.
 * `GhCommandError`가 stdout을 보존하지 않으므로 status는 이 stderr 형식에서 읽는다.
 *
 * 실측(2026-08-23): `gh api repos/cli/cli/branches/trunk/protection/required_status_checks`가
 * exit 1, stderr `gh: Not Found (HTTP 404)`였다.
 */
export function httpStatusOf(e: unknown): number | null {
  if (!(e instanceof GhCommandError)) return null;
  const m = /\(HTTP (\d{3})\)/.exec(e.stderr);
  return m === null ? null : Number(m[1]);
}
