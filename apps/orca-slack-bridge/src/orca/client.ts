import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unwrap } from './envelope.js';
import {
  parseJsonField,
  parseOrcaTimestamp,
  parseStringArrayField,
  repositoryIdFromWorktreeId,
  worktreePathFromIncarnation,
} from './coerce.js';
import type { FindingFacts } from '../summarize/contract.js';
import type { GateResolveResult, GateSnapshot } from '../gate/resolution-types.js';
import {
  OrcaRepositoryContractError,
  parseOrcaRepositoryListJson,
} from '../discovery/orca-repositories.js';
import type { RepositoryDiscoverySnapshot } from '../discovery/types.js';

const execFileAsync = promisify(execFile);

/**
 * Orca CLI 호출 경계.
 *
 * Observer는 read-only 명령만 쓴다. `check --ack`는 coordinator가 받아야 할
 * batch를 소비하므로 이 클라이언트에 넣지 않는다. `check`는 기본 동작과 `--ack`가
 * 배치를 소비하므로 아예 쓰지 않고, 소비하지 않는 `inbox`만 쓴다(`listWorkerDone`).
 */
export interface OrcaRunner {
  run(args: readonly string[], options?: OrcaRunOptions): Promise<string>;
}

export type OrcaRunOptions = {
  readonly signal?: AbortSignal;
};

export type OrcaCliOptions = {
  /** Kills the child after this deadline. Omit only for non-daemon legacy callers. */
  readonly timeoutMs?: number;
};

/**
 * The daemon is an external control-plane client, not the Orca terminal that happened to launch
 * it.  Forwarding that terminal's launch attestation fences an explicit `--from` coordinator
 * authority as impersonation.  Keep ordinary runtime discovery variables, but deliberately drop
 * the one credential that turns a child CLI into the launching terminal.
 */
export function orcaServiceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child = { ...env };
  delete child['ORCA_AGENT_LAUNCH_TOKEN'];
  return child;
}

export class OrcaCli implements OrcaRunner {
  private readonly timeoutMs: number | undefined;

  constructor(private readonly bin: string, options: OrcaCliOptions = {}) {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10)
    ) {
      throw new TypeError('Orca CLI timeout must be a finite number >= 10');
    }
    this.timeoutMs =
      options.timeoutMs === undefined ? undefined : Math.trunc(options.timeoutMs);
  }

  async run(args: readonly string[], options: OrcaRunOptions = {}): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, [...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: orcaServiceEnvironment(process.env),
      ...(this.timeoutMs === undefined ? {} : { timeout: this.timeoutMs }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return stdout;
  }
}

/**
 * Bounds injected runners too, so daemon startup and shutdown cannot depend on a promise that
 * never settles. The production OrcaCli also receives the same timeout and kills its subprocess;
 * this outer fence is the JS lifecycle guarantee for every OrcaRunner implementation.
 */
export function boundedOrcaRunner(runner: OrcaRunner, timeoutMs: number): OrcaRunner {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10) {
    throw new TypeError('Orca runner timeout must be a finite number >= 10');
  }
  const deadline = Math.trunc(timeoutMs);
  return {
    async run(args: readonly string[], options: OrcaRunOptions = {}): Promise<string> {
      if (options.signal?.aborted === true) throw new Error('Orca command aborted');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectCancellation!: (error: Error) => void;
      const cancellation = new Promise<string>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const onExternalAbort = (): void => {
        controller.abort();
        rejectCancellation(new Error('Orca command aborted'));
      };
      options.signal?.addEventListener('abort', onExternalAbort, { once: true });
      try {
        return await Promise.race([
          runner.run(args, { signal: controller.signal }),
          cancellation,
          new Promise<string>((_resolve, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Orca command deadline exceeded'));
            }, deadline);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

async function call<T>(
  runner: OrcaRunner,
  args: readonly string[],
  options?: OrcaRunOptions,
): Promise<T> {
  const out = await runner.run(args, options);
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    // Command arguments and output can contain direct-input resolution text. Diagnostics at this
    // shared boundary must identify the failure class without copying either private payload.
    throw new SyntaxError('orca command 출력이 JSON이 아니다');
  }
  return unwrap<T>(raw);
}

/** Strict `orca repo list --json` boundary used by O1 discovery. */
export async function listRepositories(
  runner: OrcaRunner,
  options?: OrcaRunOptions,
): Promise<RepositoryDiscoverySnapshot> {
  let out: string;
  try {
    out = await runner.run(['repo', 'list', '--json'], options);
  } catch {
    throw new OrcaRepositoryContractError('ORCA_REPOSITORY_COMMAND_FAILED');
  }
  return parseOrcaRepositoryListJson(out);
}

export type OrcaRun = {
  readonly id: string;
  readonly objective: string;
  readonly coordinatorHandle: string | null;
  readonly coordinatorPaneKey: string | null;
  /**
   * 현재 소유자 세대. `run-use` 인수마다 올라간다.
   *
   * OD-020이 live/stale 판정의 권위로 삼은 값이다. 정수가 아니면 `requireInt`가 던진다. 0으로
   * 메우면 모든 Run이 "한 번도 소유된 적 없음"으로 보여 판정이 조용히 뒤집힌다.
   *
   * **그 실패를 이 칸 하나에 가둔다**(OD-079). `run-list`에 필터가 없어 관측 1회가 이 호스트의
   * 모든 Run을 훑으므로, 이 칸이 깨진 Run 하나가 던지면 run-list 전체가 죽고 카드가 통째로
   * 사라진다. 읽지 못한 Run의 live/stale은 `unknown`이다 — `stale`은 "인수됐다"는 적극적
   * 주장이고 읽지 못한 것은 그 주장의 근거가 될 수 없다.
   *
   * **[미검증 가정]** 이 증가 동작을 Orca 플랫폼이 문서화하지 않았다.
   * `docs/platform-capabilities.md` §7.2에 미검증으로 기록돼 있다. 플랫폼이 바뀌면
   * `run/liveness.ts`의 판정이 깨진다.
   */
  readonly consumerGeneration: Read<number>;
  readonly legacy: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

/**
 * row의 한 칸을 읽은 결과.
 *
 * 합타입으로 둔다. 값 하나로 두고 실패를 기본값(null·빈 배열)으로 접으면 "값이 없다"와 "읽지
 * 못했다"가 같은 값이 되어 소비자가 후자를 빠뜨린다. `PrProjection`이 "카드를 만들지 않았다"를
 * 반환값에서 빠뜨릴 수 없게 하는 것과 같은 이유다(OD-079).
 *
 * 봉쇄가 필요한 칸이 넷이고 넷이 이 한 모양을 쓴다. 칸마다 다른 표현을 만들면 보고와 소비자가
 * 칸마다 갈라진다.
 */
export type Read<T> =
  /** 읽었다. */
  | { readonly kind: 'value'; readonly value: T }
  /** 읽지 못했다. `reason`은 엄격 parser가 만든 메시지 그대로다. */
  | { readonly kind: 'unreadable'; readonly reason: string };

/** task row의 `result` 한 칸. `value`가 null이면 result가 없는 정상 row다. */
export type TaskResult = Read<unknown>;

/**
 * 엄격 parser 한 번을 이 칸 하나에 가둔다(OD-079).
 *
 * `parse`에는 **파싱과 shape 검사만** 넣는다. 네트워크·프로세스 호출을 이 안에 넣으면 진짜
 * 장애가 degraded 한 줄로 축소되어 관측이 조용히 관대해진다.
 */
function read<T>(parse: () => T): Read<T> {
  try {
    return { kind: 'value', value: parse() };
  } catch (e) {
    return { kind: 'unreadable', reason: e instanceof Error ? e.message : String(e) };
  }
}

export type OrcaTask = {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly status: string;
  /** 선행 task id. 읽지 못한 row는 `unreadable`이며 그것도 관측 결과다(OD-079). */
  readonly deps: Read<readonly string[]>;
  /**
   * 구조화 결과. reviewer verdict가 여기 실린다(DL-016).
   *
   * 읽지 못한 row는 `unreadable`이며 그것도 관측 결과다. 버리지 않는다(OD-079).
   */
  readonly result: TaskResult;
  /** created_by_process_incarnation에서 뽑은 작업 디렉터리. 형식이 다르면 null. */
  readonly worktreePath: string | null;
  /**
   * created_by_process_incarnation의 `::` 앞부분. Orca repository id다. 형식이 다르면 null.
   *
   * 설정에 수동 등록한 repository id와 exact 비교해 Run을 repository에 연결한다(OD-078).
   * Git remote를 읽지 않는다 — 자동 발견은 O1 범위다(OD-068).
   */
  readonly repositoryId: string | null;
  /** Distinguishes an absent binding from a non-empty binding whose identity grammar changed. */
  readonly repositoryIdReadability?: 'absent' | 'readable' | 'unreadable';
  /**
   * 이 Task를 만든 binding. Run row의 현재 소유자와 대조해 live/stale을 가른다(OD-020).
   *
   * 실측(2026-08-24, `task-list --run run_36d28e6e947a`): 63행 중 39행이
   * `created_by_run_generation: 1` + `term_29548394…`, 24행이 `2` + `term_6354ef22…`였고
   * 뒤쪽이 같은 시점 Run row의 `consumer_generation: 2` · `coordinator_handle`과 일치했다.
   * 즉 한 Run 안에 여러 세대의 binding이 남고, 어느 것이 현재 소유자인지는 Run row가 정한다.
   *
   * `created_by_run_generation`이 정수가 아니면 `requireInt`가 던지고 **그 실패를 이 칸 하나에
   * 가둔다**(OD-079). 가두지 않으면 row 하나가 그 Run의 task 축 전체를 없앤다. 읽지 못한 row는
   * binding 관측에서 빠지고 `unreadableTaskFields`가 그 사실을 싣는다 — 관측되지 않은 것을
   * generation 0으로 메우면 그 Run이 조용히 stale로 뒤집힌다.
   */
  readonly createdBy: Read<RunBindingFacts>;
  readonly createdAt: Date;
  /**
   * 완료 시각. 완료 전이면 null.
   *
   * 실측: 같은 응답 안에서 형식이 두 가지다. worker_done으로 완료된 task는 타임존 없는
   * `2026-08-22 11:44:43`, `task-update --result`로 완료된 task는 밀리초까지 있는
   * `2026-08-22T11:39:33.963Z`다. `parseOrcaTimestamp`가 둘 다 받는다.
   */
  readonly completedAt: Date | null;
};

/**
 * 한 Run에 대한 소유자 binding 한 벌.
 *
 * Run row에서 읽으면 **현재 소유자**이고, Task row에서 읽으면 그 Task를 만든 소유자다.
 * 두 값을 비교하는 것이 `run/liveness.ts`의 전부다.
 */
export type RunBindingFacts = {
  readonly handle: string | null;
  readonly paneKey: string | null;
  readonly generation: number;
};

export type OrcaGate = {
  readonly id: string;
  readonly runId: string;
  readonly taskId: string;
  readonly question: string;
  /** 선택지. 읽지 못한 row는 `unreadable`이며 그것도 관측 결과다(OD-079). */
  readonly options: Read<readonly string[]>;
  readonly status: string;
  readonly resolution: string | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
/** 정수를 요구한다. 어긋나면 던진다. 판정의 근거가 되는 값을 기본값으로 메우지 않는다. */
function requireInt(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) {
    throw new TypeError(`${at}이(가) 정수가 아니다: ${String(v)}`);
  }
  return v;
}
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function repositoryIdReadability(
  source: string,
): 'absent' | 'readable' | 'unreadable' {
  if (source === '') return 'absent';
  const separator = source.indexOf('::');
  if (separator <= 0 || repositoryIdFromWorktreeId(source) === null) return 'unreadable';
  const suffix = source.slice(separator + 2);
  const incarnation = suffix.indexOf('@@');
  const path = incarnation < 0 ? suffix : suffix.slice(0, incarnation);
  return path.trim() === '' ? 'unreadable' : 'readable';
}

export async function listRuns(
  runner: OrcaRunner,
  options?: OrcaRunOptions,
): Promise<OrcaRun[]> {
  const r = await call<{ runs?: unknown }>(
    runner,
    ['orchestration', 'run-list', '--json'],
    options,
  );
  if (!Array.isArray(r.runs)) {
    throw new TypeError('Orca Run list does not contain a runs array');
  }
  return r.runs.map((row) => {
    const o = row as Record<string, unknown>;
    return {
      id: str(o['id']),
      objective: str(o['objective']),
      coordinatorHandle: strOrNull(o['coordinator_handle']),
      coordinatorPaneKey: strOrNull(o['coordinator_pane_key']),
      consumerGeneration: read(() =>
        requireInt(o['consumer_generation'], `run ${str(o['id'])}의 consumer_generation`),
      ),
      legacy: o['legacy'] === 1 || o['legacy'] === true,
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      updatedAt: parseOrcaTimestamp(str(o['updated_at'])),
    };
  });
}

/**
 * 읽지 못한 칸 하나. **어느 Run의 어느 row의 어느 칸이 왜 실패했는지** 그대로 남긴다(OD-079).
 */
export type UnreadableField = {
  readonly runId: string;
  /** row 종류. 아래 `id`가 무엇의 id인지 정한다. */
  readonly subject: 'run' | 'task' | 'gate' | 'worker_done' | 'question' | 'escalation';
  /**
   * 그 row의 id. run id · task id · gate id · message id다.
   *
   * `runId`와 함께 실패한 자리를 특정한다. gate와 message에는 taskId가 없으므로 이 값이 그
   * 자리를 대신한다. run row는 `runId`와 같은 값이다. 잃으면 degraded 한 줄이 어디를 가리키는지
   * 알 수 없다.
   */
  readonly id: string;
  /** 읽지 못한 칸. */
  readonly field: UnreadableFieldName;
  readonly reason: string;
};

/** 봉쇄 대상인 칸의 이름. */
export type UnreadableFieldName =
  /** run row의 `consumer_generation`. 없으면 그 Run의 live/stale이 `unknown`이다(OD-020). */
  | 'consumer_generation'
  | 'deps'
  | 'result'
  /** `result`는 읽었지만 OD-073 reviewer_result shape가 어긋났다. */
  | 'result.reviewer_result'
  /** task row의 `created_by_*` 한 벌. 없으면 그 task가 binding 관측에서 빠진다(OD-020). */
  | 'created_by'
  | 'options'
  | 'payload';

/** 관측한 Run 중 `consumer_generation`을 읽지 못한 것만 사실로 모은다(OD-079). */
export function unreadableRunFields(runs: readonly OrcaRun[]): readonly UnreadableField[] {
  const out: UnreadableField[] = [];
  for (const r of runs) {
    if (r.consumerGeneration.kind !== 'unreadable') continue;
    out.push({
      runId: r.id,
      subject: 'run',
      id: r.id,
      field: 'consumer_generation',
      reason: r.consumerGeneration.reason,
    });
  }
  return out;
}

/**
 * 관측한 task 중 읽지 못한 칸만 사실로 모은다.
 *
 * 별도 채널로 세지 않고 관측된 row에서 그대로 파생한다. 두 곳에 두면 서로 어긋난다.
 *
 * `result`를 읽지 못한 row는 reviewer_result shape를 보지 않는다. 같은 실패를 두 줄로 세면
 * degraded 건수가 실제 실패한 칸 수보다 커져 보고가 규모를 잘못 말한다.
 *
 * 여기 넘어온 task 전부를 본다. `pickReviewerResult`는 correlated Run의 task만 판정하지만,
 * `kind`가 `reviewer_result`인 row가 OD-073 v1 shape를 어기는 것은 어느 Run에 있든 관측된
 * 사실이다. 판정 범위에 맞춰 수집을 좁히면 사실을 세는 곳이 둘로 갈라진다(OD-079).
 */
export function unreadableTaskFields(tasks: readonly OrcaTask[]): readonly UnreadableField[] {
  const out: UnreadableField[] = [];
  for (const t of tasks) {
    const at = (field: UnreadableFieldName, reason: string): UnreadableField => ({
      runId: t.runId,
      subject: 'task',
      id: t.id,
      field,
      reason,
    });
    if (t.deps.kind === 'unreadable') out.push(at('deps', t.deps.reason));
    if (t.createdBy.kind === 'unreadable') out.push(at('created_by', t.createdBy.reason));
    if (t.result.kind === 'unreadable') {
      out.push(at('result', t.result.reason));
      continue;
    }
    const reviewer = readReviewerResult(t);
    if (reviewer.kind === 'unreadable') out.push(at('result.reviewer_result', reviewer.reason));
  }
  return out;
}

/** 관측한 gate 중 `options`를 읽지 못한 것만 사실로 모은다. gate id가 taskId 자리다(OD-079). */
export function unreadableGateFields(gates: readonly OrcaGate[]): readonly UnreadableField[] {
  const out: UnreadableField[] = [];
  for (const g of gates) {
    if (g.options.kind !== 'unreadable') continue;
    out.push({
      runId: g.runId,
      subject: 'gate',
      id: g.id,
      field: 'options',
      reason: g.options.reason,
    });
  }
  return out;
}

/** `listTaskPage`에서 행만 꺼낸다. 분모(`count`)가 필요 없는 소비자용이다. */
export async function listTasks(runner: OrcaRunner, runId: string): Promise<OrcaTask[]> {
  return (await listTaskPage(runner, runId)).tasks;
}

/**
 * task row를 읽는다. **파싱 실패를 그 칸 하나에 가둔다**(OD-079).
 *
 * `parseJsonField`는 그대로 던진다. 파싱 실패를 fallback으로 덮으면 데이터 손실을 조용히
 * 넘기기 때문이고, 그 계약은 여기서 바꾸지 않는다. 여기서 하는 것은 **실패의 범위를 좁히는
 * 것**이다.
 *
 * 좁혀야 하는 이유는 조회 표면이 정한다. `run-list`에 필터가 없어 관측 1회가 이 호스트의 모든
 * Run을 훑으므로, 카드와 아무 관계 없는 Run의 row가 같은 목록에 섞여 온다. 실측(2026-08-24,
 * 로컬 Orca DB Run 16개 전수): 따옴표 없는 JSON이 든 row가 `run_59bccb319e7f`의
 * `task_5694362d24f8` 하나였고, 그 row 때문에 `digest --pr 25 --dry-run`이 stdout 0바이트에
 * exit 1로 끝났다. 관측을 중단하는 것은 OD-072가 정한 "degraded를 숨기지 않는다"가 아니라
 * 무관한 row 하나가 나머지 관측을 없애는 것이다.
 *
 * 봉쇄는 **칸 단위**다. `deps`를 읽지 못해도 같은 row의 `result`는 그대로 읽고 그 반대도 같다.
 * 이 파일에서 감싸는 것은 파싱·shape 검사 호출뿐이다 — `parseOrcaTimestamp`도 CLI 호출도
 * 감싸지 않는다. 범위를 넓히면 진짜 장애까지 degraded 한 줄로 축소된다(OD-079).
 *
 * ## 분모
 *
 * Task 행과 함께 `task-list.result.count`를 돌려준다. D1의 분모가 이 `count`다(OD-069). 행 수로
 * 대체하지 않는다 — 지금은 두 값이 같지만 원천이 말하는 분모는 `count`이고, 행이 잘리는 조회
 * 계약이 생기면 행 수가 조용히 작아진다. 실측(2026-08-24, `run_36d28e6e947a`): `count: 63`, 행 63개.
 */
export async function listTaskPage(
  runner: OrcaRunner,
  runId: string,
): Promise<{
  tasks: OrcaTask[];
  count: number;
  /** False when the repository-bearing row set may be omitted or truncated. */
  repositoryEvidenceComplete: boolean;
}> {
  const r = await call<{ tasks?: unknown; count?: unknown }>(runner, [
    'orchestration', 'task-list', '--run', runId, '--json',
  ]);
  const hasTaskArray = Array.isArray(r.tasks);
  const taskRows: unknown[] = hasTaskArray ? r.tasks as unknown[] : [];
  const tasks = taskRows.map((row) => {
    const o = row as Record<string, unknown>;
    const inc = str(o['created_by_process_incarnation']);
    return {
      id: str(o['id']),
      runId: str(o['run_id']),
      title: str(o['task_title']) || str(o['display_name']),
      status: str(o['status']),
      deps: read(() =>
        parseStringArrayField(o['deps'], [], `task ${str(o['id'])}의 deps`),
      ),
      result: read(() => parseJsonField<unknown>(o['result'], null)),
      worktreePath: inc === '' ? null : worktreePathFromIncarnation(inc),
      repositoryId: inc === '' ? null : repositoryIdFromWorktreeId(inc),
      repositoryIdReadability: repositoryIdReadability(inc),
      createdBy: read(() => ({
        handle: strOrNull(o['created_by_terminal_handle']),
        paneKey: strOrNull(o['created_by_pane_key']),
        generation: requireInt(
          o['created_by_run_generation'],
          `task ${str(o['id'])}의 created_by_run_generation`,
        ),
      })),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      completedAt: (() => {
        const v = strOrNull(o['completed_at']);
        return v === null ? null : parseOrcaTimestamp(v);
      })(),
    };
  });
  const count = r.count;
  const hasReliableCount = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0;
  return {
    tasks,
    count: hasReliableCount ? count : tasks.length,
    repositoryEvidenceComplete: hasTaskArray && hasReliableCount && count === tasks.length,
  };
}

export type StrictResumeTask = {
  readonly id: string;
  readonly runId: string;
  readonly status: string;
  readonly deps: readonly string[];
  readonly currentDispatchId: string | null;
};

const STRICT_RESUME_TASK_STATUSES = new Set([
  'pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked',
]);

const STRICT_RESUME_DISPATCH_STATUSES = new Set([
  'dispatched', 'completed', 'failed', 'circuit_broken',
]);

function strictBoundedString(value: unknown, at: string, cap = 500): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > cap) {
    throw new TypeError(`${at}이(가) 1..${cap}자의 string이 아니다`);
  }
  return value;
}

function strictResumeStatus(
  value: unknown,
  allowed: ReadonlySet<string>,
  at: string,
): string {
  const status = strictBoundedString(value, at, 80);
  if (!allowed.has(status)) throw new TypeError(`${at}이(가) 알려진 Orca status가 아니다`);
  return status;
}

/** Fail-closed Task reread used only by the targeted D3 resume observer. */
export async function readStrictResumeTasks(
  runner: OrcaRunner,
  runId: string,
  options?: OrcaRunOptions,
): Promise<readonly StrictResumeTask[]> {
  const result = await call<unknown>(
    runner,
    ['orchestration', 'task-list', '--run', runId, '--json'],
    options,
  );
  if (!isRecord(result)) throw new TypeError('resume task-list result가 object가 아니다');
  exactObjectKeys(result, ['runId', 'tasks', 'count', 'legacyReadOnly'], 'resume task-list result');
  if (
    result['runId'] !== runId ||
    !Array.isArray(result['tasks']) ||
    result['count'] !== result['tasks'].length ||
    typeof result['legacyReadOnly'] !== 'boolean'
  ) {
    throw new TypeError('resume task-list result correlation/count가 어긋난다');
  }
  const seen = new Set<string>();
  return result['tasks'].map((raw, index) => {
    if (!isRecord(raw)) throw new TypeError(`resume task-list.tasks[${index}]가 object가 아니다`);
    const id = strictBoundedString(raw['id'], `resume task-list.tasks[${index}].id`);
    if (seen.has(id)) throw new TypeError(`resume task-list에 중복 Task ${id}가 있다`);
    seen.add(id);
    if (raw['run_id'] !== runId) {
      throw new TypeError(`resume task ${id}의 Run correlation이 어긋난다`);
    }
    if (raw['deps'] === null || raw['deps'] === undefined) {
      throw new TypeError(`resume task ${id}.deps가 없다`);
    }
    const deps = parseStringArrayField(raw['deps'], [], `resume task ${id}.deps`);
    if (new Set(deps).size !== deps.length || deps.some((dep) => dep.length === 0 || dep.length > 500)) {
      throw new TypeError(`resume task ${id}.deps identity가 어긋난다`);
    }
    const status = strictResumeStatus(
      raw['status'],
      STRICT_RESUME_TASK_STATUSES,
      `resume task ${id}.status`,
    );
    const currentDispatch = raw['dispatch_id'] ?? null;
    if (currentDispatch !== null && typeof currentDispatch !== 'string') {
      throw new TypeError(`resume task ${id}.dispatch_id가 string/null이 아니다`);
    }
    if (status === 'dispatched' && currentDispatch === null) {
      throw new TypeError(`resume task ${id}.dispatch_id가 dispatched 상태에서 없다`);
    }
    return {
      id,
      runId,
      status,
      deps,
      currentDispatchId:
        currentDispatch === null ? null : strictBoundedString(currentDispatch, `resume task ${id}.dispatch_id`),
    };
  });
}

/** gate row를 읽는다. `options` 파싱 실패를 그 gate 하나에 가둔다. 근거는 `listTasks`와 같다. */
export async function listGates(runner: OrcaRunner, runId: string): Promise<OrcaGate[]> {
  const r = await call<{ gates?: unknown[] }>(runner, [
    'orchestration', 'gate-list', '--run', runId, '--json',
  ]);
  return (r.gates ?? []).map((row) => {
    const o = row as Record<string, unknown>;
    const resolvedAt = strOrNull(o['resolved_at']);
    return {
      id: str(o['id']),
      runId: str(o['run_id']),
      taskId: str(o['task_id']),
      question: str(o['question']),
      options: read(() =>
        parseStringArrayField(o['options'], [], `gate ${str(o['id'])}의 options`),
      ),
      status: str(o['status']),
      resolution: strOrNull(o['resolution']),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      resolvedAt: resolvedAt === null ? null : parseOrcaTimestamp(resolvedAt),
    };
  });
}

export type ExactGateIdentity = {
  readonly gateId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly options: readonly string[];
};

function exactObjectKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  at: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    throw new TypeError(`${at}의 structured output shape가 어긋난다`);
  }
}

/** Read the current coordinator immediately before a write; `run-use` can replace it at any time. */
export async function readExactRunCoordinatorHandle(
  runner: OrcaRunner,
  runId: string,
  options?: OrcaRunOptions,
): Promise<string> {
  const result = await call<unknown>(
    runner,
    ['orchestration', 'run-show', '--id', runId, '--json'],
    options,
  );
  if (!isRecord(result)) throw new TypeError('run-show result가 object가 아니다');
  exactObjectKeys(result, ['run'], 'run-show result');
  const run = result['run'];
  if (!isRecord(run)) throw new TypeError('run-show run이 object가 아니다');
  exactObjectKeys(
    run,
    [
      'id',
      'objective',
      'home_database',
      'coordinator_handle',
      'coordinator_pane_key',
      'consumer_generation',
      'legacy',
      'created_at',
      'updated_at',
    ],
    'run-show run',
  );
  if (run['id'] !== runId) throw new TypeError('run-show run id가 요청과 어긋난다');
  const handle = run['coordinator_handle'];
  if (typeof handle !== 'string' || handle.trim() === '') {
    throw new TypeError('run-show run에 현재 coordinator handle이 없다');
  }
  return handle;
}

function strictGateSnapshot(raw: unknown, identity: ExactGateIdentity, at: string): GateSnapshot {
  if (!isRecord(raw)) throw new TypeError(`${at}이(가) object가 아니다`);
  exactObjectKeys(
    raw,
    ['id', 'run_id', 'task_id', 'question', 'options', 'status', 'resolution', 'created_at', 'resolved_at'],
    at,
  );
  const id = raw['id'];
  const runId = raw['run_id'];
  const taskId = raw['task_id'];
  const question = raw['question'];
  if (id !== identity.gateId || runId !== identity.runId || taskId !== identity.taskId) {
    throw new TypeError(`${at}의 Gate/run/task correlation이 어긋난다`);
  }
  if (typeof question !== 'string') throw new TypeError(`${at}.question이 string이 아니다`);
  if (typeof raw['created_at'] !== 'string') throw new TypeError(`${at}.created_at이 string이 아니다`);
  parseOrcaTimestamp(raw['created_at']);
  const options = parseStringArrayField(raw['options'], [], `${at}.options`);
  if (
    options.length !== identity.options.length ||
    !options.every((option, index) => option === identity.options[index])
  ) {
    throw new TypeError(`${at}.options가 durable sidecar identity와 어긋난다`);
  }
  const status = raw['status'];
  if (status !== 'pending' && status !== 'resolved') {
    throw new TypeError(`${at}.status가 pending/resolved가 아니다`);
  }
  const resolution = raw['resolution'];
  const resolvedAt = raw['resolved_at'];
  if (resolution !== null && typeof resolution !== 'string') {
    throw new TypeError(`${at}.resolution이 string/null이 아니다`);
  }
  if (resolvedAt !== null && typeof resolvedAt !== 'string') {
    throw new TypeError(`${at}.resolved_at이 string/null이 아니다`);
  }
  if (status === 'pending' && (resolution !== null || resolvedAt !== null)) {
    throw new TypeError(`${at}의 pending 상태와 resolution/resolved_at이 모순된다`);
  }
  if (
    status === 'resolved' &&
    (typeof resolution !== 'string' || resolution === '' || typeof resolvedAt !== 'string')
  ) {
    throw new TypeError(`${at}의 resolved 상태에 resolution/resolved_at이 없다`);
  }
  if (typeof resolution === 'string' && resolution.length > 3000) {
    throw new TypeError(`${at}.resolution이 durable 상한을 넘었다`);
  }
  return {
    gateId: identity.gateId,
    runId: identity.runId,
    taskId: identity.taskId,
    options,
    status,
    resolution,
    resolvedAt: resolvedAt === null ? null : parseOrcaTimestamp(resolvedAt).toISOString(),
  };
}

/** Exact pre/post read used by the resolver; it rejects missing, duplicate, and extra Gate rows. */
export async function readExactGate(
  runner: OrcaRunner,
  identity: ExactGateIdentity,
  options?: OrcaRunOptions,
): Promise<GateSnapshot> {
  const result = await call<unknown>(
    runner,
    ['orchestration', 'gate-list', '--run', identity.runId, '--json'],
    options,
  );
  if (!isRecord(result)) throw new TypeError('gate-list result가 object가 아니다');
  exactObjectKeys(result, ['runId', 'gates', 'count'], 'gate-list result');
  if (result['runId'] !== identity.runId || !Array.isArray(result['gates'])) {
    throw new TypeError('gate-list result의 runId/gates가 어긋난다');
  }
  if (!Number.isSafeInteger(result['count']) || result['count'] !== result['gates'].length) {
    throw new TypeError('gate-list result의 count가 gates 길이와 어긋난다');
  }
  const matches = result['gates'].filter(
    (candidate) => isRecord(candidate) && candidate['id'] === identity.gateId,
  );
  if (matches.length !== 1) {
    throw new TypeError(`gate-list result에 ${identity.gateId}가 정확히 한 건이 아니다`);
  }
  return strictGateSnapshot(matches[0], identity, 'gate-list Gate');
}

/** Official mutation boundary with strict Gate and mutation output parsing. */
export async function resolveExactGate(
  runner: OrcaRunner,
  identity: ExactGateIdentity,
  resolution: string,
  retryRequestId: string,
  options?: OrcaRunOptions,
): Promise<GateResolveResult> {
  let result: unknown;
  try {
    const coordinatorHandle = await readExactRunCoordinatorHandle(runner, identity.runId, options);
    result = await call<unknown>(runner, [
      'orchestration', 'gate-resolve',
      '--from', coordinatorHandle,
      '--id', identity.gateId,
      '--resolution', resolution,
      '--retry-request', retryRequestId,
      '--json',
    ], options);
  } catch {
    // Orca/runner diagnostics may echo argv or response data. The resolver treats every mutation
    // failure as response-unknown, so a fixed error preserves the safety semantics without leaking
    // free-form modal input through message, cause, data, or stack text.
    throw new Error('Orca gate-resolve failed');
  }
  if (!isRecord(result)) throw new TypeError('gate-resolve result가 object가 아니다');
  exactObjectKeys(result, ['gate', 'mutation'], 'gate-resolve result');
  const mutation = result['mutation'];
  if (!isRecord(mutation)) throw new TypeError('gate-resolve mutation이 object가 아니다');
  exactObjectKeys(mutation, ['requestId', 'replayed'], 'gate-resolve mutation');
  if (mutation['requestId'] !== retryRequestId || typeof mutation['replayed'] !== 'boolean') {
    throw new TypeError('gate-resolve mutation requestId/replayed가 어긋난다');
  }
  const gate = strictGateSnapshot(result['gate'], identity, 'gate-resolve Gate');
  if (gate.status !== 'resolved' || gate.resolution !== resolution) {
    throw new TypeError('gate-resolve Gate가 요청한 resolution으로 resolved되지 않았다');
  }
  return {
    gate,
    mutation: { requestId: retryRequestId, replayed: mutation['replayed'] },
  };
}

/**
 * 한 Dispatch 행. Task 하나에 여러 행이 남는다.
 *
 * **Task 수를 세는 데 쓰지 않는다.** OD-069가 retry Dispatch를 새 Task로 세지 못하게 했다.
 * 실측(2026-08-24, `worker-list --run run_36d28e6e947a`): Task 63건에 Dispatch 71행이었고
 * 8개 Task가 2행씩이었다. 이 행들은 attempt 이력으로만 쓴다.
 */
export type OrcaWorker = {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly runId: string;
  /**
   * Dispatch 상태. 실측 값은 `completed`·`failed`·`dispatched`이고
   * docs/evidence/t3-*.md §(b)에서 `circuit_broken`도 관측됐다. enum으로 좁히지 않는다 —
   * 모르는 값이 오면 그대로 badge에 실려야 하고, 던지면 카드가 통째로 사라진다.
   */
  readonly dispatchStatus: string;
  /** `resource.worktreeId`의 `::` 앞부분. 형식이 다르거나 resource가 없으면 null. */
  readonly repositoryId: string | null;
  /** Distinguishes a missing resource from a present but unreadable worktree identity. */
  readonly repositoryIdReadability?: 'absent' | 'readable' | 'unreadable';
};

/**
 * Run의 Dispatch 행 전부를 읽는다.
 *
 * `worker-list`는 terminal resource accounting 표면이라 historical·released worker도 함께 준다.
 * **liveness 근거로 쓰지 않는다**(docs/contracts §5). 여기서 쓰는 것은 attempt 수와
 * repository 후보 두 가지뿐이다.
 */
export async function listWorkerPage(
  runner: OrcaRunner,
  runId: string,
): Promise<{ workers: OrcaWorker[]; repositoryEvidenceComplete: boolean }> {
  const r = await call<{ workers?: unknown; count?: unknown; counts?: unknown }>(runner, [
    'orchestration', 'worker-list', '--run', runId, '--json',
  ]);
  const hasWorkerArray = Array.isArray(r.workers);
  const workerRows: unknown[] = hasWorkerArray ? r.workers as unknown[] : [];
  const workers = workerRows.map((row) => {
    const o = row as Record<string, unknown>;
    const resource = isRecord(o['resource']) ? o['resource'] : {};
    const worktreeId = str(resource['worktreeId']);
    return {
      dispatchId: str(o['dispatchId']),
      taskId: str(o['taskId']),
      runId: str(o['runId']),
      dispatchStatus: str(o['dispatchStatus']),
      repositoryId: worktreeId === '' ? null : repositoryIdFromWorktreeId(worktreeId),
      repositoryIdReadability: repositoryIdReadability(worktreeId),
    };
  });
  let countMatches = false;
  if ('count' in r) {
    countMatches = typeof r.count === 'number' && Number.isSafeInteger(r.count) &&
      r.count >= 0 && r.count === workers.length;
  }
  if ('counts' in r) {
    if (!isRecord(r.counts)) {
      countMatches = false;
    } else {
      let total = 0;
      let bucketCountsValid = true;
      for (const value of Object.values(r.counts)) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          bucketCountsValid = false;
          break;
        }
        total += value;
        if (!Number.isSafeInteger(total)) {
          bucketCountsValid = false;
          break;
        }
      }
      const bucketsMatch = bucketCountsValid && total === workers.length;
      countMatches = 'count' in r ? countMatches && bucketsMatch : bucketsMatch;
    }
  }
  return { workers, repositoryEvidenceComplete: hasWorkerArray && countMatches };
}

export async function listWorkers(runner: OrcaRunner, runId: string): Promise<OrcaWorker[]> {
  return (await listWorkerPage(runner, runId)).workers;
}

export type StrictResumeWorker = {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly dispatchStatus: string;
};

/** Fail-closed worker history reread used only for normalized D3 correlation evidence. */
export async function readStrictResumeWorkers(
  runner: OrcaRunner,
  runId: string,
  options?: OrcaRunOptions,
): Promise<readonly StrictResumeWorker[]> {
  const result = await call<unknown>(
    runner,
    ['orchestration', 'worker-list', '--run', runId, '--json'],
    options,
  );
  if (!isRecord(result)) throw new TypeError('resume worker-list result가 object가 아니다');
  exactObjectKeys(result, ['workers', 'counts'], 'resume worker-list result');
  if (!Array.isArray(result['workers']) || !isRecord(result['counts'])) {
    throw new TypeError('resume worker-list workers/counts shape가 어긋난다');
  }
  let countedWorkers = 0;
  for (const [bucket, value] of Object.entries(result['counts'])) {
    if (bucket.length === 0 || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`resume worker-list.counts.${bucket}이(가) non-negative safe integer가 아니다`);
    }
    countedWorkers += value;
    if (!Number.isSafeInteger(countedWorkers)) {
      throw new TypeError('resume worker-list.counts 합계가 safe integer가 아니다');
    }
  }
  if (countedWorkers !== result['workers'].length) {
    throw new TypeError('resume worker-list workers/counts 합계가 어긋난다');
  }
  const seen = new Set<string>();
  return result['workers'].map((raw, index) => {
    if (!isRecord(raw)) throw new TypeError(`resume worker-list.workers[${index}]가 object가 아니다`);
    const dispatchId = strictBoundedString(
      raw['dispatchId'],
      `resume worker-list.workers[${index}].dispatchId`,
    );
    if (seen.has(dispatchId)) {
      throw new TypeError(`resume worker-list에 중복 Dispatch ${dispatchId}가 있다`);
    }
    seen.add(dispatchId);
    if (raw['runId'] !== runId) {
      throw new TypeError(`resume Dispatch ${dispatchId}의 Run correlation이 어긋난다`);
    }
    return {
      dispatchId,
      taskId: strictBoundedString(raw['taskId'], `resume Dispatch ${dispatchId}.taskId`),
      runId,
      dispatchStatus: strictResumeStatus(
        raw['dispatchStatus'],
        STRICT_RESUME_DISPATCH_STATUSES,
        `resume Dispatch ${dispatchId}.dispatchStatus`,
      ),
    };
  });
}

export type StrictResumeDispatch = {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly status: string;
};

/** Strictly read the current Dispatch selected by Orca for one exact Task. */
export async function readStrictResumeTaskDispatch(
  runner: OrcaRunner,
  identity: { readonly runId: string; readonly taskId: string },
  options?: OrcaRunOptions,
): Promise<StrictResumeDispatch> {
  const result = await call<unknown>(
    runner,
    ['orchestration', 'dispatch-show', '--task', identity.taskId, '--json'],
    options,
  );
  if (!isRecord(result)) throw new TypeError('resume dispatch-show result가 object가 아니다');
  exactObjectKeys(result, ['dispatch'], 'resume dispatch-show result');
  const row = result['dispatch'];
  if (!isRecord(row)) throw new TypeError('resume dispatch-show.dispatch가 object가 아니다');
  const dispatchId = strictBoundedString(row['id'], 'resume dispatch-show.dispatch.id');
  if (row['task_id'] !== identity.taskId || row['run_id'] !== identity.runId) {
    throw new TypeError('resume dispatch-show correlation이 어긋난다');
  }
  return {
    dispatchId,
    taskId: identity.taskId,
    runId: identity.runId,
    status: strictResumeStatus(
      row['status'],
      STRICT_RESUME_DISPATCH_STATUSES,
      'resume dispatch-show.dispatch.status',
    ),
  };
}

/** Final targeted Dispatch confirmation for a provisional positive witness. */
export async function readExactResumeDispatch(
  runner: OrcaRunner,
  identity: { readonly runId: string; readonly taskId: string; readonly dispatchId: string },
  options?: OrcaRunOptions,
): Promise<StrictResumeDispatch> {
  const dispatch = await readStrictResumeTaskDispatch(runner, identity, options);
  if (dispatch.dispatchId !== identity.dispatchId) {
    throw new TypeError('resume dispatch-show correlation이 어긋난다');
  }
  return dispatch;
}

/**
 * 한 Dispatch의 agent 대기 관측. 없으면 null.
 *
 * `worker-show.result.observation.agentWait`만 읽는다. 실측(t3 §(b))에서 permission 확인 화면은
 * `{source:"prompt-text", reason:"codex-interactive-prompt"}`로 나타났고 permission 전용 enum은
 * 없었다. 그래서 이 값을 permission으로 단정하지 않고 넓은 "interaction 대기"로만 싣는다(OD-067).
 */
export type OrcaAgentWait = {
  readonly source: string;
  readonly reason: string;
};

/** 활성 Dispatch 하나의 `agentWait`를 읽는다. Dispatch 수만큼 호출되므로 호출자가 좁힌다. */
export async function showAgentWait(
  runner: OrcaRunner,
  dispatchId: string,
): Promise<OrcaAgentWait | null> {
  const r = await call<{ observation?: unknown }>(runner, [
    'orchestration', 'worker-show', '--dispatch', dispatchId, '--json',
  ]);
  const observation = isRecord(r.observation) ? r.observation : {};
  const wait = observation['agentWait'];
  if (!isRecord(wait)) return null;
  return { source: str(wait['source']), reason: str(wait['reason']) };
}

/**
 * docs/contracts §6의 `reviewer_result`.
 *
 * reviewer가 `orca orchestration task-update --id <review_task> --result <json>`으로
 * 기록하므로 **review task의 `result`에 JSON 문자열로** 들어 있다. `listTasks`가 이미
 * `parseJsonField`로 풀어 주므로 여기서는 풀린 객체를 검사한다.
 *
 * 실측(run_7804be5a654f, `orca orchestration task-list --run <id> --json`): review task 5건이
 * 모두 이 형태였고, `pr`은 `{ repo, number }` 중첩 객체, `reviewedHeadSha`는 40자 sha,
 * `findings`는 `severity`/`file`/`line`/`summary` 객체 배열이었다. `gates`도 함께 오지만
 * `ProjectedPr`에 자리가 없어 읽지 않는다. 카드의 CI 결론 source는 GitHub check다(OD-032).
 */
export type OrcaReviewerResult = {
  readonly verdict: 'approve' | 'request_changes';
  /** `owner/name`. 표시용 문자열이므로 대소문자를 구분하지 않고 비교한다. */
  readonly repo: string;
  readonly prNumber: number;
  /** 없으면 null. `ProjectedPr.headSha`와 대조할 대상이다. */
  readonly reviewedHeadSha: string | null;
  /** 상한을 적용하지 않은 전부. 상한 10건은 카드를 만들 때 건다(OD-033). */
  readonly findings: readonly FindingFacts[];
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** OD-073이 정의한 유일한 `reviewer_result` 버전. */
export const REVIEWER_RESULT_SCHEMA_VERSION = 1;

/** 비어 있지 않은 문자열을 **강제하지 않고 요구한다**. 어긋나면 던진다. */
function requireText(raw: unknown, at: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new TypeError(`${at}이(가) 비어 있지 않은 문자열이 아니다: ${String(raw)}`);
  }
  return raw.trim();
}

function finding(raw: unknown, at: string): FindingFacts {
  if (!isRecord(raw)) throw new TypeError(`${at}이(가) 객체가 아니다`);
  const severity = raw['severity'];
  if (severity !== 'blocker' && severity !== 'major' && severity !== 'minor') {
    throw new TypeError(`${at}.severity가 blocker/major/minor가 아니다: ${String(severity)}`);
  }
  // `line`은 없어도 된다. `FindingFacts.line`이 `number | null`이므로 파일 단위 finding을
  // 표현할 수 있다. 없는 것과 값이 깨진 것은 다르므로 후자만 던진다.
  const rawLine = raw['line'];
  let line: number | null = null;
  if (rawLine !== undefined && rawLine !== null) {
    if (typeof rawLine !== 'number' || !Number.isSafeInteger(rawLine) || rawLine <= 0) {
      throw new TypeError(`${at}.line이 양의 정수가 아니다: ${String(rawLine)}`);
    }
    line = rawLine;
  }
  return {
    severity,
    file: requireText(raw['file'], `${at}.file`),
    line,
    summary: requireText(raw['summary'], `${at}.summary`),
  };
}

/**
 * task result가 `reviewer_result`면 **OD-073 v1 shape를 엄격히 검증해** 읽고, 아니면 null.
 *
 * "없음"과 "malformed"를 가른다. `result`가 null이거나 `kind`가 `reviewer_result`가 아니면
 * (실측: worker_done으로 끝난 task의 result에는 `provenance: "worker_report"` JSON이 들어 있다)
 * 이 task는 review task가 아니라는 정상 출력이므로 null이다. `kind`가 맞는데 shape가 어긋나면
 * 던진다.
 *
 * **관대한 강제를 하지 않는다.** 부재를 빈 배열로, 잘못된 값을 빈 문자열이나 null로 바꿔
 * 받으면 malformed한 result도 verdict가 카드에 그려진다. 카드가 리뷰 상태를 조용히 잘못
 * 말하게 된다. `summarize/validate.ts`가 LLM 출력에 같은 자세를 취하는 이유와 같다.
 *
 * `schemaVersion`이 1이 아니면 높은 쪽도 던진다. 근거는 `store/schema.ts`의 `SCHEMA_DDL`과
 * 같다. C1은 reviewer_result migration을 만들지 않으므로, 모르는 버전을 아는 버전처럼
 * 추측해 읽지 않는 것이 migration이 생기기 전까지의 계약이다.
 *
 * `reviewedHeadSha`는 없어도 된다. merge된 `ReviewedHeadMatch`에 "없어서 대조하지 못했다"는
 * `unknown` 값이 있으므로 부재는 표현 가능한 v1 상태다. 타입이 어긋나는 것만 던진다.
 * `gates`는 읽지 않으므로 검증하지도 않는다.
 *
 * @param taskId 오류 메시지에 실어 어느 task의 result가 깨졌는지 즉시 알게 한다.
 */
export function parseReviewerResult(result: unknown, taskId: string): OrcaReviewerResult | null {
  if (!isRecord(result) || result['kind'] !== 'reviewer_result') return null;
  const at = `${taskId}의 reviewer_result`;

  const schemaVersion = result['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion)) {
    throw new TypeError(`${at}.schemaVersion이 정수가 아니다: ${String(schemaVersion)}`);
  }
  if (schemaVersion !== REVIEWER_RESULT_SCHEMA_VERSION) {
    throw new TypeError(
      `${at}.schemaVersion ${schemaVersion}을(를) 이 Bridge가 읽을 수 없다. ` +
        `아는 버전은 ${REVIEWER_RESULT_SCHEMA_VERSION}뿐이고 모르는 버전을 추측해 읽지 않는다`,
    );
  }

  const verdict = result['verdict'];
  if (verdict !== 'approve' && verdict !== 'request_changes') {
    throw new TypeError(`${at}.verdict가 approve/request_changes가 아니다: ${String(verdict)}`);
  }
  const pr = result['pr'];
  if (!isRecord(pr)) throw new TypeError(`${at}.pr이 객체가 아니다: ${String(pr)}`);
  const number = pr['number'];
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
    throw new TypeError(`${at}.pr.number가 양의 정수가 아니다: ${String(number)}`);
  }
  const sha = result['reviewedHeadSha'];
  const findings = result['findings'];
  if (!Array.isArray(findings)) {
    throw new TypeError(`${at}.findings가 배열이 아니다: ${String(findings)}`);
  }
  return {
    verdict,
    repo: requireText(pr['repo'], `${at}.pr.repo`),
    prNumber: number,
    reviewedHeadSha:
      sha === undefined || sha === null ? null : requireText(sha, `${at}.reviewedHeadSha`),
    findings: findings.map((f, i) => finding(f, `${at}.findings[${i}]`)),
  };
}

/**
 * task 하나의 `result`를 reviewer_result로 읽는다. **shape 실패를 이 task에 가둔다**(OD-079).
 *
 * `parseReviewerResult`의 엄격한 throw 계약은 그대로다. 관대한 강제를 하면 malformed한 result의
 * verdict가 카드에 그려진다. 여기서 하는 것은 범위를 좁히는 것뿐이다. 좁히지 않으면 correlated
 * Run의 row 하나가 이 PR뿐 아니라 **모든 repository의 모든 카드**를 없앤다.
 *
 * review task가 아니면 `value`가 null이다. 그것은 정상 출력이지 실패가 아니다.
 *
 * `result` 자체를 읽지 못했으면 그 사실을 그대로 넘긴다. 그 row의 degraded 사실은 `result` 칸이
 * 이미 싣고 있으므로 `unreadableTaskFields`가 여기서 다시 세지 않는다.
 *
 * 판정과 degraded 수집이 이 함수를 각각 부른다. `parseReviewerResult`가 순수 함수여서 같은 row에
 * 항상 같은 결과를 내므로 두 값이 어긋날 수 없다.
 */
export function readReviewerResult(task: OrcaTask): Read<OrcaReviewerResult | null> {
  if (task.result.kind === 'unreadable') return task.result;
  const value = task.result.value;
  return read(() => parseReviewerResult(value, task.id));
}

/**
 * worker가 보낸 `worker_done` 메시지.
 *
 * 실측(`orca orchestration inbox --limit 200 --json`): row는 `type`이 `worker_done`이고
 * 본문은 `body`, taskId/dispatchId/outcome/filesModified는 `payload`에 **JSON 문자열로**
 * 들어 있다. `to_handle`은 `run:<run id>` 형태고 `thread_id`는 null이다.
 */
export type WorkerDoneMessage = {
  readonly messageId: string;
  readonly runId: string;
  /** payload에 없으면 null. 이 값이 PR correlation의 task와 이어진다. */
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  /** Orca CLI가 두 값만 받는다. 다른 값이 오면 던진다. */
  readonly outcome: 'succeeded' | 'failed';
  readonly subject: string;
  /** 3문장 계약 본문. */
  readonly body: string;
  readonly createdAt: Date;
};

/**
 * `inbox` 한 번의 결과.
 *
 * 메시지와 **부재를 증명할 수 있는지**를 한 값으로 묶어 넘긴다. 둘을 따로 넘기면 호출자가
 * 포화 사실을 빠뜨린 채 "worker_done 없음"으로 판정할 수 있다.
 */
export type WorkerDoneInbox = {
  /** 상한 안에서 관찰된 `worker_done` 전부. 모든 Run이 섞여 있다. */
  readonly messages: readonly WorkerDoneMessage[];
  /**
   * `payload`를 읽지 못해 `messages`에 넣지 못한 row 전부(OD-079).
   *
   * `messages`와 나란히 둔다. 읽지 못한 row를 목록에서 그냥 빼면 "그런 메시지가 없었다"와 같은
   * 값이 되어 봉쇄가 조용한 관용이 된다. `payload`가 없으면 taskId를 모르므로 이 row는 Task에
   * 붙일 수 없고, 그래서 message id가 그 자리를 대신한다.
   */
  readonly unreadable: readonly UnreadableField[];
  /**
   * 반환 행 수가 요청 상한과 같았다. 더 오래된 행이 잘렸을 수 있다는 뜻이다.
   *
   * 참이면 **부재를 증명할 수 없다.** 찾은 것은 여전히 사실이지만, 못 찾은 것은 "없다"가
   * 아니라 "판정 불가"다. 판정은 `digest/project.ts`의 `pickWorkerReport`가 한다.
   */
  readonly saturated: boolean;
  /** 요청한 `--limit`. 포화 오류가 손잡이로 싣는다. */
  readonly limit: number;
};

/**
 * `inbox --limit`의 기본값.
 *
 * 실측(2026-08-22, 이 호스트의 전체 inbox): 55행 99,446바이트로 행당 평균 1.8KB다.
 * 5000행이면 약 9MB로 `OrcaCli.run`의 `maxBuffer` 32MB 안에 든다. 같은 실측에서
 * `--limit 100000`까지 CLI가 요청을 잘라내지 않고 그대로 55행을 돌려줬다.
 *
 * 이 값이 부족해도 카드가 거짓을 말하지는 않는다. 포화를 감지해 판정 불가를 던진다.
 */
export const INBOX_LIMIT = 5000;

/**
 * `worker_done` row의 `payload`를 읽는다. 엄격하게 검사하고 어긋나면 던진다.
 *
 * 파싱과 outcome shape 검사를 한 함수에 둔다. 둘 다 "이 row를 `WorkerDoneMessage`로 읽지
 * 못했다"는 같은 실패이고, 계약은 **읽지 못한 것을 읽은 것처럼 만들지 않는 것**이다. 호출부가
 * 그 실패를 row 하나에 가둔다(OD-079).
 */
function readWorkerDonePayload(
  raw: unknown,
  messageId: string,
): {
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  readonly outcome: 'succeeded' | 'failed';
} {
  const payload = parseJsonField<unknown>(raw, null);
  const p = isRecord(payload) ? payload : {};
  const outcome = p['outcome'];
  if (outcome !== 'succeeded' && outcome !== 'failed') {
    throw new TypeError(
      `worker_done ${messageId}의 outcome이 succeeded/failed가 아니다: ${String(outcome)}`,
    );
  }
  return { taskId: strOrNull(p['taskId']), dispatchId: strOrNull(p['dispatchId']), outcome };
}

/**
 * `worker_done`을 **소비하지 않고** 읽는다.
 *
 * `orca orchestration check`는 기본 동작이 배치를 읽음 처리하고 `--ack`가 그것을 확정하므로
 * coordinator가 받아야 할 배치를 삼킨다. `inbox`는 recipient 전체의 메시지를 그대로 보여주는
 * 조회 명령이다. 실측으로 확인했다: 같은 인자로 세 번 연속 호출해 33 row의
 * `read`/`delivered_at`/`sequence`/`body` 길이가 하나도 바뀌지 않았다.
 *
 * `inbox`에는 `--run` 필터가 없어 모든 Run의 메시지가 온다. Run 구분은 호출자가 한다.
 * heartbeat·question·status도 같은 목록에 섞여 온다(실측 55행 중 worker_done은 19행).
 *
 * `--full`은 쓰지 않는다. 실측에서 `--full` 유무로 `body` 길이가 달라진 row가 0건이었다.
 *
 * `payload`를 읽지 못한 row는 **그 row 하나에 가둔다**(OD-079). `inbox`도 모든 Run의 메시지를
 * 한 목록으로 주므로 무관한 Run의 row 하나가 관측 전체를 없앨 이유가 없다. 읽지 못한 row는
 * `messages`가 아니라 `unreadable`로 간다. taskId를 모르므로 Task 판정에 쓸 수 없고, 그 사실을
 * 버리면 "그런 메시지가 없었다"와 구분되지 않기 때문이다.
 *
 * ## 남는 한계 — C1이 닫지 않는다
 *
 * CLI 표면이 `orca orchestration inbox [--limit <n>] [--terminal <handle>] [--full] [--json]`
 * 뿐이라 `--run` 필터도 cursor도 pagination도 없다. **`--limit`이 유일한 손잡이다.** 그래서
 * "누적 메시지가 상한을 넘으면 오래된 `worker_done`을 못 본다"는 성질 자체는 남는다. 여기서
 * 하는 것은 그 상태를 **감지해서 거짓말을 막는 것**이지 없애는 것이 아니다.
 *
 * 감지 방법도 완전하지 않다. 판정은 `반환 행 수 >= 요청 상한`인데, CLI가 요청보다 낮은 값으로
 * 조용히 clamp하면 반환 행 수가 상한에 닿지 않아 포화를 놓친다. 위 실측은 전체가 55행인
 * 상태에서 한 것이라 clamp의 부재를 증명하지 못한다.
 *
 * 이 한계를 닫으려면 관찰 방식 자체가 정해져야 한다. `OD-023`(ingestion 방식)이 C1을
 * "`digest` 1회 실행 = 관찰 1회"로 두었고, 얼마나 오래된 메시지까지 봐야 하는지는
 * `OD-062`(허용 지연·비용 한도)와 `OD-065`(초기 동시 repository/Run 규모)가 정해지기 전에는
 * 근거 없이 고를 수 없다. 세 항목이 닫히기 전까지 C1은 상한을 올리고 포화를 드러낸다.
 */
export async function listWorkerDone(
  runner: OrcaRunner,
  limit = INBOX_LIMIT,
  handle?: string,
): Promise<WorkerDoneInbox> {
  return workerDoneFrom(await readInbox(runner, limit, handle));
}

/**
 * `inbox` 한 번의 원본 행.
 *
 * `worker_done`(C1)과 ask/escalation(D1)이 같은 목록에서 나온다. 두 소비자가 각자 `inbox`를
 * 부르면 관찰 1회가 2회가 되고 두 결과의 시점이 어긋난다. 조회는 한 번 하고 거르기는 순수
 * 함수로 나눈다.
 */
export type OrcaInbox = {
  readonly rows: readonly Record<string, unknown>[];
  /** 반환 행 수가 요청 상한과 같았다. 참이면 **부재를 증명할 수 없다.** */
  readonly saturated: boolean;
  readonly limit: number;
};

export async function readInbox(
  runner: OrcaRunner,
  limit = INBOX_LIMIT,
  handle?: string,
): Promise<OrcaInbox> {
  /*
   * `handle`은 수신자다. `inbox`에 `--run`은 없지만 `--terminal`이 수신자로 거르고, 실측에서
   * `worker_done` 563행 전부가 `run:<run_id>`로 배달돼 있었다(불일치 0). 그러므로 Run 키를
   * 수신자로 넘기면 그 Run의 `worker_done`을 하나도 잃지 않고 좁힐 수 있다.
   *
   * 좁히는 이유는 포화다. 전역 inbox는 모든 Run과 heartbeat까지 한 배열로 오므로 상한에 닿고,
   * 그 순간 부재를 증명할 수 없어 digest가 통째로 멈춘다. 실측(2026-09-04)에서 전역 6,220행
   * 중 heartbeat가 4,736행이었고 가장 큰 Run도 3,785행이었다. 상한을 올리는 것은 `maxBuffer`
   * 32MB라는 다음 벽으로 옮기는 것일 뿐이고, Run 단위로 나누면 포화 판정도 Run 안에 갇힌다.
   */
  const r = await call<{ messages?: unknown[] }>(runner, [
    'orchestration', 'inbox',
    ...(handle === undefined ? [] : ['--terminal', handle]),
    '--limit', String(limit), '--json',
  ]);
  const rows = (r.messages ?? []).map((row) => row as Record<string, unknown>);
  // 포화 판정은 걸러낸 결과가 아니라 **반환된 전체 행 수**로 한다.
  return { rows, saturated: rows.length >= limit, limit };
}

/** 읽은 inbox에서 `worker_done`만 고른다. */
export function workerDoneFrom(inbox: OrcaInbox): WorkerDoneInbox {
  const out: WorkerDoneMessage[] = [];
  const unreadable: UnreadableField[] = [];
  for (const o of inbox.rows) {
    if (o['type'] !== 'worker_done') continue;
    const messageId = str(o['id']);
    const runId = str(o['run_id']);
    // 봉쇄 범위는 `payload` 한 칸이다. `run_id`는 payload가 아니라 row의 칸이므로 읽지 못한
    // row도 어느 Run의 것인지는 남는다. `parseOrcaTimestamp`는 감싸지 않는다.
    const payload = read(() => readWorkerDonePayload(o['payload'], messageId));
    if (payload.kind === 'unreadable') {
      unreadable.push({
        runId,
        subject: 'worker_done',
        id: messageId,
        field: 'payload',
        reason: payload.reason,
      });
      continue;
    }
    out.push({
      messageId,
      runId,
      taskId: payload.value.taskId,
      dispatchId: payload.value.dispatchId,
      outcome: payload.value.outcome,
      subject: str(o['subject']),
      body: str(o['body']),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
    });
  }
  return { messages: out, unreadable, saturated: inbox.saturated, limit: inbox.limit };
}

/**
 * worker가 보낸 ask 한 건과 그 답변 여부.
 *
 * 실측(2026-08-24, `inbox --limit 5000`): `question` 14행 전부가 `thread_id`를 자기 message ID로
 * 두었고, coordinator 답변은 같은 `thread_id`를 가진 `type:"status"` 행으로 같은 목록에 있었다.
 * 14건 모두 답변 행을 찾았다. `orca orchestration`에는 question record를 직접 읽는 명령이 없으므로
 * (`--help` 목록에 `question-*`이 없다) 답변 여부는 이 thread 대조로만 판정한다.
 */
export type OrcaAsk = {
  readonly messageId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  readonly subject: string;
  readonly createdAt: Date;
  /**
   * 같은 thread에 뒤따르는 메시지를 관찰했는가.
   *
   * 거짓이고 inbox가 포화가 아니면 **미답 ask**다. 포화면 판정 불가이므로 호출자가 degraded로
   * 싣는다(OD-072). 여기서 포화를 answered로 접지 않는다.
   */
  readonly answered: boolean;
};

/** worker가 보낸 escalation 한 건. `thread_id`가 null이라 ask와 자동으로 이어지지 않는다. */
export type OrcaEscalation = {
  readonly messageId: string;
  readonly runId: string;
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  readonly subject: string;
  readonly createdAt: Date;
};

export type AskInbox = {
  readonly asks: readonly OrcaAsk[];
  readonly escalations: readonly OrcaEscalation[];
  /**
   * `payload`를 읽지 못해 `asks`·`escalations`에 넣지 못한 row 전부(OD-079).
   *
   * `WorkerDoneInbox.unreadable`과 같은 이유로 나란히 둔다. 목록에서 그냥 빼면 "그런 ask가
   * 없었다"와 같은 값이 되어 blocker badge가 조용히 작아진다. taskId를 모르므로 message id가
   * 그 자리를 대신한다.
   */
  readonly unreadable: readonly UnreadableField[];
  readonly saturated: boolean;
  readonly limit: number;
};

/**
 * 읽은 inbox에서 ask와 escalation을 고르고 ask의 답변 여부를 판정한다.
 *
 * ask와 escalation을 **합치지 않는다.** 실측에서 같은 `taskId`·`dispatchId`에 둘이 동시에
 * 존재했고, 둘을 한 수로 접으면 한 원인이 두 번 셈된다(OD-067).
 *
 * `payload` 파싱 실패는 **그 row 하나에 가둔다**(OD-079). `inbox`도 필터 없이 이 호스트의 모든
 * Run의 메시지를 한 목록으로 주므로, 무관한 row 하나가 던지면 이 Run의 ask·escalation 축이
 * 통째로 사라진다. 읽지 못한 row는 `unreadable`로 간다.
 */
export function askThreadsFrom(inbox: OrcaInbox): AskInbox {
  const replied = new Set<string>();
  for (const o of inbox.rows) {
    const thread = strOrNull(o['thread_id']);
    // 자기 자신을 thread로 여는 question 행은 답변이 아니다.
    if (thread !== null && thread !== str(o['id'])) replied.add(thread);
  }
  const asks: OrcaAsk[] = [];
  const escalations: OrcaEscalation[] = [];
  const unreadable: UnreadableField[] = [];
  for (const o of inbox.rows) {
    const type = o['type'];
    if (type !== 'question' && type !== 'escalation') continue;
    const messageId = str(o['id']);
    const runId = str(o['run_id']);
    // 봉쇄 범위는 `payload` 한 칸이다. `run_id`·`subject`는 row의 칸이라 읽지 못한 row도 어느
    // Run의 것인지는 남는다. `parseOrcaTimestamp`는 감싸지 않는다.
    const payload = read(() => {
      const parsed = parseJsonField<unknown>(o['payload'], null);
      const pp = isRecord(parsed) ? parsed : {};
      return { taskId: strOrNull(pp['taskId']), dispatchId: strOrNull(pp['dispatchId']) };
    });
    if (payload.kind === 'unreadable') {
      unreadable.push({
        runId,
        subject: type,
        id: messageId,
        field: 'payload',
        reason: payload.reason,
      });
      continue;
    }
    const common = {
      messageId,
      runId,
      taskId: payload.value.taskId,
      dispatchId: payload.value.dispatchId,
      subject: str(o['subject']),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
    };
    if (type === 'question') {
      asks.push({ ...common, answered: replied.has(common.messageId) });
    } else {
      escalations.push(common);
    }
  }
  return { asks, escalations, unreadable, saturated: inbox.saturated, limit: inbox.limit };}
