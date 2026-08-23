import type { Correlation } from '../correlate/resolve.js';
import type { PullRequestFacts } from '../github/pull-request.js';
import { runKey, taskKey } from '../identity/keys.js';
import type { RepositoryIdentity } from '../identity/repository.js';
import {
  parseReviewerResult,
  type OrcaReviewerResult,
  type OrcaTask,
  type WorkerDoneInbox,
} from '../orca/client.js';
import { projectForRepository, type BridgeConfig } from '../project/config.js';
import { CAPS, type FindingFacts } from '../summarize/contract.js';
import { prepareSummaryBody } from './facts.js';
import { deriveMergePolicy, deriveTerminal } from './state.js';
import type {
  CorrelatedOrigin,
  PrProjection,
  ProjectedPr,
  ReviewedHeadMatch,
  ReviewerResult,
  WorkerReport,
} from './types.js';

/**
 * correlated PR 하나를 `ProjectedPr`로 만든다.
 *
 * LLM을 부르지 않는다. 여기서 나오는 값은 전부 관찰 사실에서 결정적으로 파생된다.
 * 같은 입력이 항상 같은 카드를 낸다(DL-020).
 */

/** projection이 보는 Orca 사실. 한 Run 범위다. */
export type OrcaFacts = {
  /** correlation이 가리키는 Run의 task 전부. reviewer_result와 Task 목적의 source다. */
  readonly tasks: readonly OrcaTask[];
  /**
   * `inbox` 한 번의 결과 전체.
   *
   * 메시지 배열이 아니라 `WorkerDoneInbox`를 받는다. 포화 사실이 함께 와야 "worker_done이
   * 없다"와 "충분히 멀리 보지 못했다"를 가를 수 있다. 배열만 받으면 호출자가 그 사실을
   * 떨어뜨린 채 부재로 판정할 수 있다.
   *
   * `listWorkerDone`이 모든 Run의 메시지를 주므로 Run 필터는 `pickWorkerReport`가 건다.
   * `worker-read` fallback은 쓰지 않는다(OD-025).
   */
  readonly workerDone: WorkerDoneInbox;
};

/**
 * `correlated`이면서 `task`까지 있는지.
 *
 * 속성 검사만으로는 객체가 좁혀지지 않아 타입 술어를 쓴다(`digest/types.ts`).
 */
export function isCorrelatedOrigin(c: Correlation): c is CorrelatedOrigin {
  return c.kind === 'correlated' && c.task !== null;
}

const SEVERITY_RANK: Record<FindingFacts['severity'], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

/**
 * severity 내림차순 상한 10건(OD-033).
 *
 * `Array.prototype.sort`는 안정 정렬이므로 같은 severity 안에서는 reviewer가 기록한 순서가
 * 그대로 남는다. 같은 입력이 같은 목록을 낸다.
 */
export function capFindings(findings: readonly FindingFacts[]): readonly FindingFacts[] {
  return [...findings]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, CAPS.findings);
}

function headMatch(reviewedHeadSha: string | null, headSha: string): ReviewedHeadMatch {
  if (reviewedHeadSha === null || headSha === '') return 'unknown';
  return reviewedHeadSha === headSha ? 'same' : 'different';
}

/**
 * 이 PR을 가리키는 reviewer_result 중 **가장 최근에 완료된 것 하나**를 고른다.
 *
 * 실측(run_7804be5a654f)에서 한 PR에 reviewer_result가 3건까지 있었다. 재리뷰 사이클이라
 * 마지막 판정이 관찰 시점의 사실이고, 이전 판정을 싣으면 이미 해소된 결과를 현재 상태로
 * 표시하게 된다(PR #2는 request_changes 뒤 approve였다).
 *
 * 이것은 "여러 reviewer의 상충 verdict"(docs/contracts §6 TBD)를 판정하는 것이 아니고,
 * 새 commit 이후 approval이 아직 유효한지(OD-031)를 판정하는 것도 아니다. 뒤쪽은
 * `ReviewerResult.headMatch`가 사실로만 싣는다.
 *
 * 결정적이어야 하므로 `completedAt`이 같거나 없을 때는 task id 사전순으로 정렬해 마지막을
 * 고른다. 임의 순서에 의존하면 같은 입력이 다른 카드를 내고 지문이 흔들린다.
 *
 * **이것이 OD-044가 요구하는 review reconcile이다.** 각 resource(Orca review task)의 자기
 * timestamp(`completedAt`)와 자기 id로 고른다. PR `updated_at` 같은 상위 timestamp로 바꾸지
 * 마라. 실측에서 review·check·mergeability가 바뀌어도 PR `updated_at`은 그대로였고, 같은
 * `updated_at`의 두 응답이 서로 다른 head를 보였다. 전역 last-write-wins는 기각됐다.
 */
export function pickReviewerResult(
  tasks: readonly OrcaTask[],
  repository: RepositoryIdentity,
  prNumber: number,
): OrcaReviewerResult | null {
  const needle = repository.nameWithOwner.trim().toLowerCase();
  const matches: { task: OrcaTask; result: OrcaReviewerResult }[] = [];
  for (const task of tasks) {
    const result = parseReviewerResult(task.result, task.id);
    if (result === null) continue;
    if (result.prNumber !== prNumber) continue;
    if (result.repo.toLowerCase() !== needle) continue;
    matches.push({ task, result });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => {
    const at = a.task.completedAt?.getTime() ?? 0;
    const bt = b.task.completedAt?.getTime() ?? 0;
    return at === bt ? a.task.id.localeCompare(b.task.id) : at - bt;
  });
  return matches[matches.length - 1]?.result ?? null;
}

/**
 * correlation의 Task가 보낸 `worker_done`을 찾는다.
 *
 * Run 필터도 여기서 건다. `inbox`에는 `--run`이 없어 다른 Run의 메시지가 섞여 오고, task id는
 * Run 사이에서 유일하다고 보장되지 않는다.
 *
 * 계약상 Dispatch마다 정확히 한 번이지만 재dispatch가 있으면 같은 Task에 여러 건이 남는다.
 * 그때는 가장 최근 것을 쓴다.
 *
 * 결과가 세 가지다.
 *
 * - **찾음** → 그 보고. inbox가 포화됐어도 찾은 것은 사실이므로 정상이다.
 * - **못 찾음 + 포화 아님** → null. 상한 안에 전부 있었는데 없었으므로 정말 없다.
 *   카드는 "worker 보고 없음"을 표시한다(OD-070).
 * - **못 찾음 + 포화** → 던진다. OD-070의 "없음"은 정말로 없을 때의 규칙이고, 충분히 멀리
 *   보지 못한 것을 없음으로 표시하면 카드가 거짓을 말한다. 판정 불가는 `workerReport: null`로
 *   내려보내지 않는다.
 */
export function pickWorkerReport(
  inbox: WorkerDoneInbox,
  origin: CorrelatedOrigin,
): WorkerReport | null {
  const matches = inbox.messages.filter(
    (m) => runKey(m.runId) === origin.run && m.taskId !== null && taskKey(m.taskId) === origin.task,
  );
  if (matches.length === 0) {
    if (inbox.saturated) {
      throw new Error(
        `${origin.task}의 worker_done 부재를 증명할 수 없다: ` +
          `inbox가 요청 상한 ${inbox.limit}행에 닿아 더 오래된 메시지가 잘렸을 수 있는데 ` +
          `그 안에서 이 Task의 worker_done을 찾지 못했다. ` +
          `inbox에는 --run 필터도 pagination도 없으므로 --limit을 올려 다시 관찰해라`,
      );
    }
    return null;
  }
  matches.sort((a, b) => {
    const d = a.createdAt.getTime() - b.createdAt.getTime();
    return d === 0 ? a.messageId.localeCompare(b.messageId) : d;
  });
  const latest = matches[matches.length - 1];
  if (latest === undefined) return null;
  return { outcome: latest.outcome, body: latest.body };
}

export function projectPullRequest(
  repository: RepositoryIdentity,
  pr: PullRequestFacts,
  correlation: Correlation,
  orca: OrcaFacts,
  config: BridgeConfig,
): PrProjection {
  if (correlation.kind === 'uncorrelated') {
    return { kind: 'skipped', key: pr.key, reason: 'uncorrelated' };
  }
  if (correlation.kind === 'conflict') {
    return { kind: 'skipped', key: pr.key, reason: 'conflict' };
  }
  // orca-run만 있고 orca-task가 없는 입력이다. 추측으로 Task를 보완하지 않고 degraded로 남긴다(OD-077).
  if (!isCorrelatedOrigin(correlation)) {
    return { kind: 'skipped', key: pr.key, reason: 'run_only_degraded' };
  }

  const headSha = pr.headRefOid;
  const reviewer = pickReviewerResult(orca.tasks, repository, pr.number);
  const review: ReviewerResult | null =
    reviewer === null
      ? null
      : {
          verdict: reviewer.verdict,
          reviewedHeadSha: reviewer.reviewedHeadSha,
          headMatch: headMatch(reviewer.reviewedHeadSha, headSha),
          findings: capFindings(reviewer.findings),
          findingsTotal: reviewer.findings.length,
        };

  const workerReport = pickWorkerReport(orca.workerDone, correlation);

  return {
    kind: 'card',
    pr: {
      key: pr.key,
      repository,
      project: projectForRepository(config, repository.nameWithOwner),
      correlation,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      headSha,
      checksHeadSha: pr.checksHeadOid,
      // terminal 축. `mergedAt` latch가 `state` 문자열을 이긴다(`digest/state.ts`).
      terminal: deriveTerminal(pr.state, pr.mergedAt),
      isDraft: pr.isDraft,
      review,
      checks: pr.checks,
      // mergePolicy 축. base branch required rule과 head rollup의 조인을 접은 값이다.
      // 파생은 `digest/state.ts` 하나만 하고 여기서 다시 판정하지 않는다(OD-032).
      mergePolicy: deriveMergePolicy(pr.requiredRules, pr.requiredChecks),
      workerReport,
      truncation: {
        // summarizer 입력과 같은 계산을 쓴다. 두 값을 따로 계산하지 않는다.
        prBody: prepareSummaryBody(pr.body, config.correlationKeys).truncated,
        // 조회 쪽에서 잘렸다는 뜻이다. Bridge는 읽을 때 목록을 자르지 않는다.
        changedFiles: pr.changedFilesTotal > pr.changedPaths.length,
      },
    },
  };
}
