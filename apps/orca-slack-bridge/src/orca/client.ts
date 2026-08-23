import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unwrap } from './envelope.js';
import {
  parseJsonField,
  parseOrcaTimestamp,
  repositoryIdFromWorktreeId,
  worktreePathFromIncarnation,
} from './coerce.js';
import type { FindingFacts } from '../summarize/contract.js';

const execFileAsync = promisify(execFile);

/**
 * Orca CLI 호출 경계.
 *
 * Observer는 read-only 명령만 쓴다. `check --ack`는 coordinator가 받아야 할
 * batch를 소비하므로 이 클라이언트에 넣지 않는다. `check`는 기본 동작과 `--ack`가
 * 배치를 소비하므로 아예 쓰지 않고, 소비하지 않는 `inbox`만 쓴다(`listWorkerDone`).
 */
export interface OrcaRunner {
  run(args: readonly string[]): Promise<string>;
}

export class OrcaCli implements OrcaRunner {
  constructor(private readonly bin: string) {}
  async run(args: readonly string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, [...args], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  }
}

async function call<T>(runner: OrcaRunner, args: readonly string[]): Promise<T> {
  const out = await runner.run(args);
  let raw: unknown;
  try {
    raw = JSON.parse(out);
  } catch {
    throw new SyntaxError(`orca ${args.join(' ')} 출력이 JSON이 아니다: ${out.slice(0, 200)}`);
  }
  return unwrap<T>(raw);
}

export type OrcaRun = {
  readonly id: string;
  readonly objective: string;
  readonly coordinatorHandle: string | null;
  readonly coordinatorPaneKey: string | null;
  /**
   * 현재 소유자 세대. `run-use` 인수마다 올라간다.
   *
   * OD-020이 live/stale 판정의 권위로 삼은 값이다. 없거나 정수가 아니면 던진다. 0으로 메우면
   * 모든 Run이 "한 번도 소유된 적 없음"으로 보여 판정이 조용히 뒤집힌다.
   *
   * **[미검증 가정]** 이 증가 동작을 Orca 플랫폼이 문서화하지 않았다.
   * `docs/platform-capabilities.md` §7.2에 미검증으로 기록돼 있다. 플랫폼이 바뀌면
   * `run/liveness.ts`의 판정이 깨진다.
   */
  readonly consumerGeneration: number;
  readonly legacy: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type OrcaTask = {
  readonly id: string;
  readonly runId: string;
  readonly title: string;
  readonly status: string;
  readonly deps: readonly string[];
  /** 구조화 결과. reviewer verdict가 여기 실린다(DL-016). */
  readonly result: unknown;
  /** created_by_process_incarnation에서 뽑은 작업 디렉터리. 형식이 다르면 null. */
  readonly worktreePath: string | null;
  /**
   * created_by_process_incarnation의 `::` 앞부분. Orca repository id다. 형식이 다르면 null.
   *
   * 설정에 수동 등록한 repository id와 exact 비교해 Run을 repository에 연결한다(OD-078).
   * Git remote를 읽지 않는다 — 자동 발견은 O1 범위다(OD-068).
   */
  readonly repositoryId: string | null;
  /**
   * 이 Task를 만든 binding. Run row의 현재 소유자와 대조해 live/stale을 가른다(OD-020).
   *
   * 실측(2026-08-24, `task-list --run run_36d28e6e947a`): 63행 중 39행이
   * `created_by_run_generation: 1` + `term_29548394…`, 24행이 `2` + `term_6354ef22…`였고
   * 뒤쪽이 같은 시점 Run row의 `consumer_generation: 2` · `coordinator_handle`과 일치했다.
   * 즉 한 Run 안에 여러 세대의 binding이 남고, 어느 것이 현재 소유자인지는 Run row가 정한다.
   */
  readonly createdBy: RunBindingFacts;
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
  readonly options: readonly string[];
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

export async function listRuns(runner: OrcaRunner): Promise<OrcaRun[]> {
  const r = await call<{ runs?: unknown[] }>(runner, ['orchestration', 'run-list', '--json']);
  return (r.runs ?? []).map((row) => {
    const o = row as Record<string, unknown>;
    return {
      id: str(o['id']),
      objective: str(o['objective']),
      coordinatorHandle: strOrNull(o['coordinator_handle']),
      coordinatorPaneKey: strOrNull(o['coordinator_pane_key']),
      consumerGeneration: requireInt(o['consumer_generation'], `run ${str(o['id'])}의 consumer_generation`),
      legacy: o['legacy'] === 1 || o['legacy'] === true,
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      updatedAt: parseOrcaTimestamp(str(o['updated_at'])),
    };
  });
}

export async function listTasks(runner: OrcaRunner, runId: string): Promise<OrcaTask[]> {
  return (await listTaskPage(runner, runId)).tasks;
}

/**
 * Task 행과 함께 `task-list.result.count`를 돌려준다.
 *
 * D1의 분모가 이 `count`다(OD-069). 행 수로 대체하지 않는다 — 지금은 두 값이 같지만 원천이
 * 말하는 분모는 `count`이고, 행이 잘리는 조회 계약이 생기면 행 수가 조용히 작아진다.
 * 실측(2026-08-24, `run_36d28e6e947a`): `count: 63`, 행 63개.
 */
export async function listTaskPage(
  runner: OrcaRunner,
  runId: string,
): Promise<{ tasks: OrcaTask[]; count: number }> {
  const r = await call<{ tasks?: unknown[]; count?: unknown }>(runner, [
    'orchestration', 'task-list', '--run', runId, '--json',
  ]);
  const tasks = (r.tasks ?? []).map((row) => {
    const o = row as Record<string, unknown>;
    const inc = str(o['created_by_process_incarnation']);
    return {
      id: str(o['id']),
      runId: str(o['run_id']),
      title: str(o['task_title']) || str(o['display_name']),
      status: str(o['status']),
      deps: parseJsonField<string[]>(o['deps'], []),
      result: o['result'] === null || o['result'] === undefined
        ? null
        : parseJsonField<unknown>(o['result'], null),
      worktreePath: inc === '' ? null : worktreePathFromIncarnation(inc),
      repositoryId: inc === '' ? null : repositoryIdFromWorktreeId(inc),
      createdBy: {
        handle: strOrNull(o['created_by_terminal_handle']),
        paneKey: strOrNull(o['created_by_pane_key']),
        generation: requireInt(
          o['created_by_run_generation'],
          `task ${str(o['id'])}의 created_by_run_generation`,
        ),
      },
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      completedAt: (() => {
        const v = strOrNull(o['completed_at']);
        return v === null ? null : parseOrcaTimestamp(v);
      })(),
    };
  });
  const count = r.count;
  return {
    tasks,
    count: typeof count === 'number' && Number.isSafeInteger(count) ? count : tasks.length,
  };
}

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
      options: parseJsonField<string[]>(o['options'], []),
      status: str(o['status']),
      resolution: strOrNull(o['resolution']),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      resolvedAt: resolvedAt === null ? null : parseOrcaTimestamp(resolvedAt),
    };
  });
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
};

/**
 * Run의 Dispatch 행 전부를 읽는다.
 *
 * `worker-list`는 terminal resource accounting 표면이라 historical·released worker도 함께 준다.
 * **liveness 근거로 쓰지 않는다**(docs/contracts §5). 여기서 쓰는 것은 attempt 수와
 * repository 후보 두 가지뿐이다.
 */
export async function listWorkers(runner: OrcaRunner, runId: string): Promise<OrcaWorker[]> {
  const r = await call<{ workers?: unknown[] }>(runner, [
    'orchestration', 'worker-list', '--run', runId, '--json',
  ]);
  return (r.workers ?? []).map((row) => {
    const o = row as Record<string, unknown>;
    const resource = isRecord(o['resource']) ? o['resource'] : {};
    const worktreeId = str(resource['worktreeId']);
    return {
      dispatchId: str(o['dispatchId']),
      taskId: str(o['taskId']),
      runId: str(o['runId']),
      dispatchStatus: str(o['dispatchStatus']),
      repositoryId: worktreeId === '' ? null : repositoryIdFromWorktreeId(worktreeId),
    };
  });
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
): Promise<WorkerDoneInbox> {
  return workerDoneFrom(await readInbox(runner, limit));
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

export async function readInbox(runner: OrcaRunner, limit = INBOX_LIMIT): Promise<OrcaInbox> {
  const r = await call<{ messages?: unknown[] }>(runner, [
    'orchestration', 'inbox', '--limit', String(limit), '--json',
  ]);
  const rows = (r.messages ?? []).map((row) => row as Record<string, unknown>);
  // 포화 판정은 걸러낸 결과가 아니라 **반환된 전체 행 수**로 한다.
  return { rows, saturated: rows.length >= limit, limit };
}

/** 읽은 inbox에서 `worker_done`만 고른다. */
export function workerDoneFrom(inbox: OrcaInbox): WorkerDoneInbox {
  const out: WorkerDoneMessage[] = [];
  for (const o of inbox.rows) {
    if (o['type'] !== 'worker_done') continue;
    const payload = parseJsonField<unknown>(o['payload'], null);
    const p = isRecord(payload) ? payload : {};
    const outcome = p['outcome'];
    if (outcome !== 'succeeded' && outcome !== 'failed') {
      throw new TypeError(
        `worker_done ${str(o['id'])}의 outcome이 succeeded/failed가 아니다: ${String(outcome)}`,
      );
    }
    out.push({
      messageId: str(o['id']),
      runId: str(o['run_id']),
      taskId: strOrNull(p['taskId']),
      dispatchId: strOrNull(p['dispatchId']),
      outcome,
      subject: str(o['subject']),
      body: str(o['body']),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
    });
  }
  return { messages: out, saturated: inbox.saturated, limit: inbox.limit };
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
  readonly saturated: boolean;
  readonly limit: number;
};

/**
 * 읽은 inbox에서 ask와 escalation을 고르고 ask의 답변 여부를 판정한다.
 *
 * ask와 escalation을 **합치지 않는다.** 실측에서 같은 `taskId`·`dispatchId`에 둘이 동시에
 * 존재했고, 둘을 한 수로 접으면 한 원인이 두 번 셈된다(OD-067).
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
  for (const o of inbox.rows) {
    const type = o['type'];
    if (type !== 'question' && type !== 'escalation') continue;
    const payload = parseJsonField<unknown>(o['payload'], null);
    const p = isRecord(payload) ? payload : {};
    const common = {
      messageId: str(o['id']),
      runId: str(o['run_id']),
      taskId: strOrNull(p['taskId']),
      dispatchId: strOrNull(p['dispatchId']),
      subject: str(o['subject']),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
    };
    if (type === 'question') {
      asks.push({ ...common, answered: replied.has(common.messageId) });
    } else {
      escalations.push(common);
    }
  }
  return { asks, escalations, saturated: inbox.saturated, limit: inbox.limit };
}
