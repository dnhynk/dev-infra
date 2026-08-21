import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unwrap } from './envelope.js';
import { parseJsonField, parseOrcaTimestamp, worktreePathFromIncarnation } from './coerce.js';

const execFileAsync = promisify(execFile);

/**
 * Orca CLI 호출 경계.
 *
 * Observer는 read-only 명령만 쓴다. `check --ack`는 coordinator가 받아야 할
 * batch를 소비하므로 이 클라이언트에 넣지 않는다.
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
