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
  readonly options: readonly string[];
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
      deps: parseJsonField<string[]>(o['deps'], []),
      result: o['result'] === null || o['result'] === undefined
        ? null
        : parseJsonField<unknown>(o['result'], null),
      worktreePath: inc === '' ? null : worktreePathFromIncarnation(inc),
      createdAt: parseOrcaTimestamp(str(o['created_at'])),
      completedAt: (() => {
        const v = strOrNull(o['completed_at']);
        return v === null ? null : parseOrcaTimestamp(v);
      })(),
    };
  });
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

function finding(raw: unknown, at: string): FindingFacts {
  if (!isRecord(raw)) throw new TypeError(`${at}이(가) 객체가 아니다`);
  const severity = raw['severity'];
  if (severity !== 'blocker' && severity !== 'major' && severity !== 'minor') {
    throw new TypeError(`${at}.severity가 blocker/major/minor가 아니다: ${String(severity)}`);
  }
  const line = raw['line'];
  return {
    severity,
    file: str(raw['file']),
    line: typeof line === 'number' && Number.isFinite(line) ? line : null,
    summary: str(raw['summary']),
  };
}

/**
 * task result가 `reviewer_result`면 읽고, 아니면 null.
 *
 * null은 "이 task는 review task가 아니다"라는 정상 출력이다. 반대로 `kind`가
 * `reviewer_result`인데 모양이 다르면 던진다. 계약이 깨진 것을 조용히 "리뷰 없음"으로
 * 덮으면 카드가 리뷰 결과를 통째로 빠뜨린 채 그려진다.
 */
export function parseReviewerResult(result: unknown): OrcaReviewerResult | null {
  if (!isRecord(result) || result['kind'] !== 'reviewer_result') return null;
  const verdict = result['verdict'];
  if (verdict !== 'approve' && verdict !== 'request_changes') {
    throw new TypeError(`reviewer_result.verdict가 approve/request_changes가 아니다: ${String(verdict)}`);
  }
  const pr = result['pr'];
  if (!isRecord(pr)) throw new TypeError('reviewer_result.pr이 객체가 아니다');
  const repo = pr['repo'];
  const number = pr['number'];
  if (typeof repo !== 'string' || repo.trim() === '') {
    throw new TypeError('reviewer_result.pr.repo가 비어 있다');
  }
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new TypeError(`reviewer_result.pr.number가 정수가 아니다: ${String(number)}`);
  }
  const findings = result['findings'];
  if (findings !== undefined && findings !== null && !Array.isArray(findings)) {
    throw new TypeError('reviewer_result.findings가 배열이 아니다');
  }
  return {
    verdict,
    repo: repo.trim(),
    prNumber: number,
    reviewedHeadSha: strOrNull(result['reviewedHeadSha']),
    findings: (findings ?? []).map((f, i) => finding(f, `reviewer_result.findings[${i}]`)),
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
 * `worker_done`을 **소비하지 않고** 읽는다.
 *
 * `orca orchestration check`는 기본 동작이 배치를 읽음 처리하고 `--ack`가 그것을 확정하므로
 * coordinator가 받아야 할 배치를 삼킨다. `inbox`는 recipient 전체의 메시지를 그대로 보여주는
 * 조회 명령이다. 실측으로 확인했다: 같은 인자로 세 번 연속 호출해 33 row의
 * `read`/`delivered_at`/`sequence`/`body` 길이가 하나도 바뀌지 않았다.
 *
 * `inbox`에는 `--run` 필터가 없어 모든 Run의 메시지가 온다. Run 구분은 호출자가 `runId`로 한다.
 * `--limit`이 필요한 이유도 같다. heartbeat까지 섞여 오므로 Run의 worker_done 수보다 넉넉히 잡는다.
 *
 * `--full`은 쓰지 않는다. 실측에서 `--full` 유무로 `body` 길이가 달라진 row가 0건이었다.
 */
export async function listWorkerDone(runner: OrcaRunner, limit = 200): Promise<WorkerDoneMessage[]> {
  const r = await call<{ messages?: unknown[] }>(runner, [
    'orchestration', 'inbox', '--limit', String(limit), '--json',
  ]);
  const out: WorkerDoneMessage[] = [];
  for (const row of r.messages ?? []) {
    const o = row as Record<string, unknown>;
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
  return out;
}
