import { listRuns, listWorkerPage, type OrcaRunner } from '../orca/client.js';
import { runKey, type RunKey } from '../identity/keys.js';
import { listTerminals } from './client.js';
import type { TerminalPromptCandidate } from './observer.js';

/**
 * 이번 pass에서 화면을 읽을 터미널을 고른다.
 *
 * ## 왜 coordinator를 반드시 넣는가
 *
 * 지금까지 이 시스템이 본 대기는 `worker-show`의 `agentWait`뿐이었고, coordinator는 Dispatch가
 * 아니라서 그 조회에 잡히지 않았다. 그래서 coordinator가 프롬프트 앞에 멈추면 Slack 어디에도
 * 나타나지 않았다. 무인 운용에서 그것이 가장 비싼 멈춤인데 유일하게 보이지 않는 멈춤이었다.
 *
 * ## 비용
 *
 * Run 목록 1회 + 터미널 목록 1회 + Run마다 worker 목록 1회. 화면 읽기는 후보 수만큼이다.
 * 실측 환경에서 살아 있는 터미널이 16대였고 그중 후보는 Run에 묶인 것뿐이다.
 */

export type TerminalCandidateStore = {
  findRunMessage(key: RunKey): { readonly channelId: string; readonly messageTs: string } | null;
};

export type TerminalCandidateDeps = {
  readonly orca: OrcaRunner;
  readonly store: TerminalCandidateStore;
  /** 답할 카드를 게시할 채널. 이 채널의 맨 아래가 항상 지금 할 일이다. */
  readonly decisionsChannel: string;
  /** 이 pass에서 볼 최대 터미널 수. 한 pass가 무한정 길어지지 않게 한다. */
  readonly limit?: number;
};

const DEFAULT_LIMIT = 40;

export async function collectTerminalCandidates(
  deps: TerminalCandidateDeps,
): Promise<readonly TerminalPromptCandidate[]> {
  const limit = deps.limit ?? DEFAULT_LIMIT;
  const decisionsChannel = deps.decisionsChannel;
  // 죽은 handle을 읽지 않는다. Run row의 coordinator_handle은 세션이 끝나도 남는다.
  const live = new Set((await listTerminals(deps.orca)).map((terminal) => terminal.handle));
  const runs = await listRuns(deps.orca);

  const candidates: TerminalPromptCandidate[] = [];
  for (const run of runs) {
    if (candidates.length >= limit) break;
    const key = runKey(run.id);
    // 루트 메시지가 없으면 카드를 매달 자리가 없다. 등록되지 않은 Run이 여기 해당한다.
    const root = deps.store.findRunMessage(key);
    if (root === null) continue;
    const runLabel = run.objective.split('\n')[0]?.trim() ?? run.id;

    if (run.coordinatorHandle !== null && live.has(run.coordinatorHandle)) {
      candidates.push({
        handle: run.coordinatorHandle,
        runKey: key,
        role: 'coordinator',
        dispatchId: null,
        runLabel,
        channelId: decisionsChannel,
      });
    }

    let workers: readonly { dispatchId: string; dispatchStatus: string }[] = [];
    try {
      workers = (await listWorkerPage(deps.orca, run.id)).workers;
    } catch {
      // 한 Run의 worker 목록을 읽지 못해도 coordinator 후보는 이미 담겼다.
      continue;
    }
    for (const worker of workers) {
      if (candidates.length >= limit) break;
      if (worker.dispatchStatus !== 'dispatched') continue;
      const handle = await workerTerminalHandle(deps.orca, worker.dispatchId);
      if (handle === null || !live.has(handle)) continue;
      candidates.push({
        handle,
        runKey: key,
        role: 'worker',
        dispatchId: worker.dispatchId,
        runLabel,
        channelId: decisionsChannel,
      });
    }
  }
  return candidates;
}

/** 한 Dispatch가 쓰는 터미널. `worker.agent_terminal_handle`이 정확한 값이다. */
async function workerTerminalHandle(
  runner: OrcaRunner,
  dispatchId: string,
): Promise<string | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await runner.run([
      'orchestration', 'worker-show', '--dispatch', dispatchId, '--json',
    ]));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const result = (raw as Record<string, unknown>)['result'];
  if (typeof result !== 'object' || result === null) return null;
  const worker = (result as Record<string, unknown>)['worker'];
  if (typeof worker !== 'object' || worker === null) return null;
  const handle = (worker as Record<string, unknown>)['agent_terminal_handle'];
  return typeof handle === 'string' && handle.startsWith('term_') ? handle : null;
}
