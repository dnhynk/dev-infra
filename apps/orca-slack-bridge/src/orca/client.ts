import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unwrap } from './envelope.js';
import { parseJsonField, parseOrcaTimestamp, worktreePathFromIncarnation } from './coerce.js';
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
  readonly subject: 'task' | 'gate' | 'worker_done';
  /**
   * 그 row의 id. task id · gate id · message id다.
   *
   * `runId`와 함께 실패한 자리를 특정한다. gate와 message에는 taskId가 없으므로 이 값이 그
   * 자리를 대신한다. 잃으면 degraded 한 줄이 어디를 가리키는지 알 수 없다.
   */
  readonly id: string;
  /** 읽지 못한 칸. */
  readonly field: UnreadableFieldName;
  readonly reason: string;
};

/** 봉쇄 대상인 칸의 이름. */
export type UnreadableFieldName =
  | 'deps'
  | 'result'
  /** `result`는 읽었지만 OD-073 reviewer_result shape가 어긋났다. */
  | 'result.reviewer_result'
  | 'options'
  | 'payload';

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
 * `parseOrcaTimestamp`는 `read`로 감싸지 않는다. 봉쇄 대상은 OD-079가 정한 네 칸이고, 감싸는
 * 범위를 넓히면 진짜 장애까지 degraded 한 줄로 축소된다.
 */
export async function listTasks(runner: OrcaRunner, runId: string): Promise<OrcaTask[]> {
  const r = await call<{ tasks?: unknown[] }>(runner, [
    'orchestration', 'task-list', '--run', runId, '--json',
  ]);
  return (r.tasks ?? []).map((row) => {
    const o = row as Record<string, unknown>;
    const inc = str(o['created_by_process_incarnation']);
    return {
      id: str(o['id']),
      runId: str(o['run_id']),
      title: str(o['task_title']) || str(o['display_name']),
      status: str(o['status']),
      deps: read(() => parseJsonField<readonly string[]>(o['deps'], [])),
      result: read(() => parseJsonField<unknown>(o['result'], null)),
      worktreePath: inc === '' ? null : worktreePathFromIncarnation(inc),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      completedAt: (() => {
        const v = strOrNull(o['completed_at']);
        return v === null ? null : parseOrcaTimestamp(v);
      })(),
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
      options: read(() => parseJsonField<readonly string[]>(o['options'], [])),
      status: str(o['status']),
      resolution: strOrNull(o['resolution']),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      resolvedAt: resolvedAt === null ? null : parseOrcaTimestamp(resolvedAt),
    };
  });
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
): Promise<WorkerDoneInbox> {
  const r = await call<{ messages?: unknown[] }>(runner, [
    'orchestration', 'inbox', '--limit', String(limit), '--json',
  ]);
  const rows = r.messages ?? [];
  const out: WorkerDoneMessage[] = [];
  const unreadable: UnreadableField[] = [];
  for (const row of rows) {
    const o = row as Record<string, unknown>;
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
  // 포화 판정은 worker_done 수가 아니라 **반환된 전체 행 수**로 한다. 잘린 것은 목록이지
  // 목록에서 걸러낸 결과가 아니다.
  return { messages: out, unreadable, saturated: rows.length >= limit, limit };
}
