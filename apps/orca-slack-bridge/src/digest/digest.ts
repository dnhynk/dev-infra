import { parseCorrelationMetadata } from '../correlate/metadata.js';
import { resolveCorrelation } from '../correlate/resolve.js';
import { listPullRequests, type PullRequestFacts } from '../github/pull-request.js';
import { fetchRepositoryIdentity } from '../github/repository.js';
import type { GhRunner } from '../github/runner.js';
import { runKey, taskKey, type PullRequestKey } from '../identity/keys.js';
import {
  listWorkerDone,
  unreadableGateFields,
  unreadableTaskFields,
  type OrcaRunner,
  type OrcaTask,
  type UnreadableField,
} from '../orca/client.js';
import type { BridgeConfig } from '../project/config.js';
import {
  boundedSlackReply,
  boundedSlackUpdate,
  DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
  type SlackPoster,
  type ThreadPoster,
} from '../slack/post.js';
import {
  postSlackRootAtMostOnce,
  type SlackRootIntentRuntime,
} from '../slack/root-intent.js';
import { buildCorrelationView, collectRuns } from '../snapshot/snapshot.js';
import type { DigestStore } from '../store/schema.js';
import { OperationalStoreError, SchemaVersionError } from '../store/sqlite.js';
import { factsFingerprint } from '../summarize/fingerprint.js';
import type { SummaryProvider } from '../summarize/openai.js';
import {
  factsOnlySummary,
  parseSummary,
  serializeSummary,
  type SummaryCache,
  type SummaryResult,
} from '../summarize/result.js';
import { buildSummaryFacts } from './facts.js';
import { projectPullRequest } from './project.js';
import {
  identityLine,
  renderCard,
  renderFingerprint,
  BROADCAST_TRANSITIONS,
  renderThreadEvent,
  type RenderedCard,
} from './render.js';
import { reconcileObservation, type PrTransition } from './transition.js';
import type { PrSkipReason, ProjectedPr } from './types.js';

/**
 * digest 1회 실행.
 *
 * C1은 polling하지 않는다. 이 함수를 한 번 부르는 것이 관찰 한 번이다(OD-023).
 *
 * ```text
 * Orca/GitHub 관찰 → correlation → ProjectedPr
 *   → 직전 관측 조회 → reconcile(terminal dominance, check resource) → SummaryFacts → store 조회
 *   → 게이트 A: 사실 지문이 같으면 저장된 요약 재사용, 다르면 summarize
 *   → renderCard
 *   → 게이트 B ─┬─ 매핑 없음        → chat.postMessage → insertPrMessage
 *               ├─ 렌더 지문 다름   → chat.update      → updateObservation
 *               └─ 렌더 지문 같음   → Slack 호출 없음
 *   → 게이트 C ─┬─ 첫 관측          → 후보를 게시 없이 기준선으로 기록
 *               ├─ 이미 기록한 전이 → 아무것도 하지 않음
 *               └─ 그 밖           → thread reply → recordThreadEvent
 *   → savePrState
 * ```
 *
 * **reconcile이 요약·렌더보다 앞에 있는 것이 의도다.** 뒤에 두면 오래된 snapshot이 만든 카드가
 * 이미 게시된 뒤에 사실이 정정된다. `merged`가 `open`으로 내려간 카드는 되돌려도 사람이 이미
 * 본다(OD-044).
 *
 * **게이트가 셋이고 각각 다른 것을 막는다.**
 *
 * 게이트 A는 **LLM 호출**을 막는다. 기준은 `factsFingerprint`, 즉 요약의 입력이다. 입력이
 * 같으면 문구가 달라질 이유가 없으므로 저장된 문구를 그대로 쓴다(OD-035).
 *
 * 게이트 B는 **Slack 호출**을 막는다. 기준은 카드 자체의 지문이다. 요약을 재사용해도 카드가
 * 달라질 수 있다. `ProjectedPr`이 카드에 그리는 사실 중 PR state, isDraft, headSha,
 * `review.headMatch`, `workerReport.outcome`, `truncation`은 `SummaryFacts`에 없기 때문이다.
 * PR이 merge되기만 한 관찰이 그 예다. 사실 지문은 그대로여서 LLM은 부르지 않고, 렌더 지문은
 * 달라져서 카드는 `병합 완료`로 갱신된다.
 *
 * **게이트를 하나로 합치지 마라.** 사실 지문 하나로 게시까지 판정하면 위 전이에서 카드가
 * 영영 갱신되지 않고, 렌더 지문 하나로 요약까지 판정하면 요약을 하기 전에는 렌더 지문을
 * 알 수 없어 순환한다.
 *
 * OD-035 본문은 지문을 "PR key + head sha + reviewer-result + CI 결론 + 입력 사실 해시"로
 * 열거하지만 그 열거는 계약이 스케치이던 시점의 근사다. 작동하는 원칙은 **요약의 입력이
 * 바뀔 때만 호출한다**이고, 그래서 게이트 A에 head sha를 넣지 않는다. 제목·본문·변경
 * 파일·review·CI가 그대로인 채 head만 움직이면 요약 문구가 달라질 이유가 없고, 그때 다시
 * 부르는 것이 OD-035가 줄이려던 낭비다. head 이동이 카드에 반영돼야 하는 부분은 게이트 B가
 * 렌더 지문으로 잡는다.
 *
 * 게이트 C는 **thread 중복 reply**를 막는다. 기준은 durable dedupe key다. 후보를 만드는 규칙과
 * key의 모양은 `digest/transition.ts`에 있고, 그 key가 보장하는 것과 보장하지 않는 것은
 * `store/schema.ts`의 `PR_THREAD_EVENT_TABLE`에 있다. 프로세스 메모리에 아무것도 두지 않으므로
 * Bridge를 재시작해도 판정이 같다.
 *
 * 이 파일은 위 순서만 담는다. 사실 수집·파생·렌더는 각 모듈에 있고 여기서 다시 판정하지 않는다.
 */

/** 카드 하나에 대해 이번 실행이 한 일(dry-run이면 했을 일). */
export type DigestAction =
  /** 매핑 행이 없어 루트를 새로 만든다. */
  | 'create'
  /** 매핑 행이 있고 렌더 지문이 달라 같은 메시지를 갱신한다. */
  | 'update'
  /** 매핑 행이 있고 렌더 지문이 같다. Slack을 호출하지 않는다. */
  | 'skip'
  /** A definitive no-effect create failure remains eligible for a later observation. */
  | 'deferred'
  /** A possible-effect create is permanently fenced from another post. */
  | 'uncertain'
  /**
   * 매핑 행의 채널이 설정의 대상 채널과 다르다. Slack에도 `pr_message` 매핑에도 쓰지 않는다.
   *
   * 예전 채널의 ts로 update하면 사람이 보는 채널이 아닌 곳을 갱신하고, 새로 게시하면 루트가
   * 둘이 된다. 어느 쪽도 조용히 고르지 않고 불일치를 드러낸다(UX §6).
   *
   * PR↔Task 연관은 그래도 남는다. 그것은 게시 대상 채널과 무관하게 이번 관찰이 관측한
   * 사실이고, 불일치가 풀릴 때까지 버리면 그 사이의 Task를 영영 잃는다(OD-076).
   */
  | 'channel_mismatch';

/**
 * 전이 하나에 대해 이번 관측이 내린 **결정**.
 *
 * 쓴 것이 아니라 정한 것을 적는다. dry-run은 store에도 Slack에도 쓰지 않지만 무엇을 하기로
 * 했는지는 같으므로, 이 값이 두 모드에서 같은 뜻을 갖는다.
 */
export type PrTransitionOutcome =
  /**
   * 첫 관측이라 게시하지 않고 기준선으로만 둔다(OD-046).
   *
   * 이전 상태를 모르는 상태에서 지금 참인 사실을 전이로 쏟아내면 그것이 과거 재생이다.
   * live 실행은 이때 `pr_thread_event`에 `message_ts` 없이 기록해 다시 후보가 되지 않게 한다.
   */
  | 'baseline'
  /** thread에 게시하고 기록했다. */
  | 'posted'
  /**
   * 게시하지 않았다. 기록도 하지 않았으므로 다음 관측에서 다시 후보가 된다.
   *
   * dry-run이거나, 매달 루트를 확정할 수 없거나(channel 불일치), 게시 경계를 받지 못했을 때다.
   * 기록만 하고 게시를 건너뛰면 그 전이가 영영 사라지므로 그렇게 하지 않는다.
   */
  | 'unposted';

/** 이번 관측이 만든 전이 하나와 그 결정. */
export type PrTransitionResult = PrTransition & { readonly outcome: PrTransitionOutcome };

/**
 * PR 하나에 대한 digest 결과.
 *
 * 카드를 만들지 않은 것도 결과다. 조용히 버리지 않고 이유를 남긴다(UX §6).
 */
export type DigestResult =
  | {
      readonly kind: 'card';
      readonly key: PullRequestKey;
      /** `[Project] owner/repo #N` 또는 `owner/repo #N`(OD-047). 사람이 보는 식별자다. */
      readonly identity: string;
      readonly url: string;
      readonly action: DigestAction;
      readonly card: RenderedCard;
      /** 이 카드의 렌더 지문. 게시 여부를 정한 값이다. */
      readonly fingerprint: string;
      readonly summary: SummaryResult;
      /**
       * 이번 관찰이 summarizer를 부르지 않고 저장된 요약을 되살렸는지(게이트 A).
       *
       * 사람이 읽는 보고에 싣는다. OD-035가 줄이려는 것이 이 호출이므로, 줄었는지 아닌지가
       * 출력에 보이지 않으면 확인할 방법이 없다.
       */
      readonly summaryReused: boolean;
      /**
       * 이 카드가 가리키는 Slack 메시지의 ts. 없으면 null.
       *
       * 채널 ID는 싣지 않는다. 이 값이 사람이 읽는 출력과 로그로 나가는데 대상 채널은 설정에서만
       * 오는 값이므로, 출력이 그 값을 다시 퍼뜨릴 이유가 없다.
       */
      readonly messageTs: string | null;
      /**
       * 이번 관측이 만든 전이와 그 결정.
       *
       * 이미 기록한 전이는 여기 없다. 사람이 읽는 보고에서 "이번에 무엇이 thread로 나갔는가"가
       * 보이지 않으면 중복 여부를 확인할 방법이 없다.
       */
      readonly transitions: readonly PrTransitionResult[];
    }
  | { readonly kind: 'skipped'; readonly key: PullRequestKey; readonly reason: PrSkipReason };

export type DigestReport = {
  readonly observedAt: string;
  /** Slack과 store에 쓰지 않았다는 사실. 출력이 실제 게시처럼 읽히지 않게 한다. */
  readonly dryRun: boolean;
  /**
   * 이번 관찰에서 읽지 못한 Orca 칸 전부(OD-079).
   *
   * task의 `deps`·`result`·reviewer_result shape, gate의 `options`, `worker_done`의 `payload`가
   * 한 목록에 들어온다. 칸마다 목록을 나누면 소비자가 하나를 빠뜨린다.
   *
   * 카드별이 아니라 관찰 단위다. `run-list`에도 `inbox`에도 필터가 없어 관측 1회가 이 호스트의
   * 모든 Run을 훑으므로, 여기 실리는 Run이 이번에 카드를 만든 PR과 무관할 수 있다. 그 무관함이
   * 바로 이 목록을 카드 아래가 아니라 보고 위에 두는 이유다.
   *
   * **비어 있지 않은데 카드가 나왔다면 그 카드는 이 실패를 알지 못한 채 그려진 것이다.**
   * 같은 Run의 카드에서 "리뷰 결과 없음"은 "reviewer_result를 관측하지 못했다"까지만,
   * "worker 보고 없음"은 "읽은 메시지에는 없었다"까지만 뜻한다.
   */
  readonly degraded: readonly UnreadableField[];
  readonly results: readonly DigestResult[];
  /** Present only in daemon repository-isolation mode. */
  readonly repositoryFailures?: readonly {
    readonly repository: string;
    readonly reason: 'query_failed' | 'budget_deferred' | 'deadline_deferred';
  }[];
};

export type DigestOptions = {
  readonly config: BridgeConfig;
  /** 게시 대상 채널 ID. 설정에서만 온다. 이 모듈은 값을 만들지 않는다. */
  readonly channel: string;
  readonly store: DigestStore;
  /**
   * Slack write 경계. **null이면 dry-run이다.**
   *
   * dry-run은 store에도 쓰지 않는다. 게시하지 않은 카드의 매핑을 남기면 다음 실제 실행이
   * 존재하지 않는 메시지를 update하려 하고, 루트가 영영 만들어지지 않는다.
   */
  readonly slack: SlackPoster | null;
  /**
   * PR thread write 경계. **null이면 전이를 게시하지 않는다.**
   *
   * `slack`과 따로 받는다. 루트는 알아도 어느 thread에 매달지 확정할 수 없는 관측이 있기
   * 때문이다. null이어도 후보를 버리지 않고 `unposted`로 남기므로, 아직 참인 전이는 다음
   * 관측에서 다시 후보가 된다(`digest/transition.ts`).
   */
  readonly thread: ThreadPoster | null;
  readonly provider?: SummaryProvider;
  readonly cache?: SummaryCache;
  /** Omitted means the existing one-shot model behavior. */
  readonly summaryMode?: 'model' | 'facts_only';
  readonly prLimit: number;
  /**
   * 이 번호의 PR만 처리한다. null이면 전부.
   *
   * 설정의 **모든** repository에서 그 번호를 찾는다. repository가 여럿이면 대상도 여럿일 수
   * 있다. 첫 실제 게시의 범위를 좁히는 손잡이이지 단일 PR을 보장하는 장치가 아니다.
   */
  readonly onlyPr: number | null;
  readonly now: () => Date;
  /** Daemon-selected fair cycle. Omitted means all configured repositories. */
  readonly repositories?: readonly string[];
  /** A failed repository is reported and the next repository still runs. */
  readonly isolateRepositoryFailures?: boolean;
  readonly rootIntent?: SlackRootIntentRuntime;
  readonly slackTimeoutMs?: number;
  /** Observer deadline/shutdown fence carried through every Slack write. */
  readonly signal?: AbortSignal;
};

function isDigestInvariantError(error: unknown): boolean {
  return error instanceof OperationalStoreError || error instanceof SchemaVersionError ||
    error instanceof TypeError || error instanceof SyntaxError || error instanceof RangeError;
}

export async function runDigest(
  orca: OrcaRunner,
  gh: GhRunner,
  options: DigestOptions,
): Promise<DigestReport> {
  const { config } = options;
  const runs = await collectRuns(orca);
  const view = buildCorrelationView(runs);
  // 관찰 1회에 inbox도 1회만 읽는다. 포화 판정은 `pickWorkerReport`가 한다.
  const inbox = await listWorkerDone(orca);
  const tasksByRun = new Map(runs.map((r) => [runKey(r.run.id), r.tasks]));

  const results: DigestResult[] = [];
  const repositoryFailures: NonNullable<DigestReport['repositoryFailures']>[number][] = [];
  const configured = options.repositories ?? config.projects.flatMap((p) => p.repositories);
  const repositories = [...new Map(configured.map((name) => [name.toLowerCase(), name])).values()];
  for (const name of repositories) {
    let repository: Awaited<ReturnType<typeof fetchRepositoryIdentity>>;
    let sources: PullRequestFacts[];
    try {
      repository = await fetchRepositoryIdentity(gh, name);
      // Collection for the entire repository finishes before its first Slack write. A GitHub page,
      // quota, budget, or deadline failure therefore cannot publish only a prefix of this repo.
      sources = await listPullRequests(gh, repository, options.prLimit);
    } catch (error) {
      if (options.isolateRepositoryFailures !== true) throw error;
      if (isDigestInvariantError(error)) throw error;
      const named = error instanceof Error ? error.name : '';
      repositoryFailures.push({
        repository: name,
        reason: named === 'GithubBudgetDeferredError'
          ? 'budget_deferred'
          : named === 'GithubDeadlineDeferredError'
            ? 'deadline_deferred'
            : 'query_failed',
      });
      continue;
    }
    for (const source of sources) {
      if (options.onlyPr !== null && source.number !== options.onlyPr) continue;
      const correlation = resolveCorrelation(
        parseCorrelationMetadata(source.body, config.correlationKeys),
        view,
      );
      // correlated가 아니면 Run을 모른다. projection이 그 경우를 먼저 skip하므로 빈 목록이 맞다.
      const tasks =
        correlation.kind === 'correlated' ? (tasksByRun.get(correlation.run) ?? []) : [];
      const projection = projectPullRequest(
        repository,
        source,
        correlation,
        { tasks, workerDone: inbox },
        config,
      );
      if (projection.kind === 'skipped') {
        results.push({ kind: 'skipped', key: projection.key, reason: projection.reason });
        continue;
      }
      results.push(await digestOne(projection.pr, source, tasks, options));
    }
  }

  return {
    observedAt: options.now().toISOString(),
    dryRun: options.slack === null,
    // 읽지 못한 칸을 버리지 않고 관찰 결과로 싣는다. 파싱·shape 실패는 row 하나에 갇히고
    // 나머지 Run과 나머지 메시지는 그대로 관측된다(OD-079).
    degraded: [
      ...runs.flatMap((r) => [
        ...unreadableTaskFields(r.tasks),
        ...unreadableGateFields(r.gates),
      ]),
      ...inbox.unreadable,
    ],
    results,
    ...(options.isolateRepositoryFailures === true ? { repositoryFailures } : {}),
  };
}

/**
 * Task 목적으로 쓸 제목을 찾는다.
 *
 * Orca Task의 **제목**만 쓴다. dispatch spec은 설정 값과 결정 목록이 그대로 들어 있어 OD-036
 * 경계를 넘는다(`digest/facts.ts`).
 */
function taskPurpose(tasks: readonly OrcaTask[], pr: ProjectedPr): string | null {
  const found = tasks.find((t) => taskKey(t.id) === pr.correlation.task);
  if (found === undefined || found.title.trim() === '') return null;
  return found.title;
}

/**
 * 카드 하나를 만들고 Slack·store를 정해진 순서로 다룬다.
 *
 * summarizer 실패는 여기서 흐름을 끊지 않는다. `summarize`가 실패를 `kind: 'failed'`로
 * 돌려주고 renderer가 사실만 담은 축소 카드를 만든다(OD-035). 그래서 요약 실패가 GitHub·Orca
 * 관찰이나 Slack 게시를 손상시키지 않는다.
 */
async function digestOne(
  observed: ProjectedPr,
  source: PullRequestFacts,
  tasks: readonly OrcaTask[],
  options: DigestOptions,
): Promise<DigestResult> {
  const signal = options.signal ?? options.rootIntent?.signal;
  // 직전 관측을 먼저 읽는다. 없으면 null이고 그것은 "이 PR을 처음 본다"는 정상 출력이다.
  // 이 값이 `reconcileTerminal`의 `previous`이며, 그 함수의 프로덕션 호출자는 여기 하나다.
  const previousState = options.store.findPrState(observed.key);
  // reconcile을 요약·렌더보다 앞에 둔다. 뒤에 두면 오래된 snapshot이 만든 카드가 이미 게시된다.
  const observation = reconcileObservation(
    previousState,
    observed,
    source.requiredRules,
    source.mergedAt,
  );
  const pr = observation.pr;

  const facts = buildSummaryFacts(
    pr,
    source,
    taskPurpose(tasks, pr),
    options.config.correlationKeys,
  );
  const factsFp = factsFingerprint(facts);

  // PR body는 primary/latest Task 하나만 담으므로, 기록하지 않으면 이전 Task와의 연관을
  // 다음 관찰이 복원할 수 없다(OD-076). 이 사실은 카드를 게시하는지·채널이 맞는지와 무관하게
  // 이번 관찰이 관측한 것이므로 아래 Slack 게이트보다 앞에 둔다. dry-run은 store에 쓰지 않는다.
  if (options.slack !== null) {
    options.store.recordPrTask({
      prKey: pr.key,
      taskKey: pr.correlation.task,
      runKey: pr.correlation.run,
      at: options.now().toISOString(),
    });
  }

  const existing = options.store.findPrMessage(pr.key);

  // 게이트 A. 요약 입력이 그대로면 저장된 문구를 되살리고 provider를 부르지 않는다(OD-035).
  const reused =
    options.summaryMode !== 'facts_only' &&
    existing !== null && existing.factsFingerprint === factsFp
      ? parseSummary(existing.summaryJson, factsFp)
      : null;
  let summary: SummaryResult;
  if (options.summaryMode === 'facts_only') {
    summary = factsOnlySummary(facts);
  } else if (reused !== null) {
    summary = reused;
  } else {
    if (options.provider === undefined) {
      throw new TypeError('one-shot digest requires a summary provider');
    }
    // The provider module is imported only on the one-shot model path. A daemon facts-only digest
    // cannot import, construct, or call it even when a model key is present in the environment.
    const { summarize } = await import('../summarize/index.js');
    summary = await summarize(facts, {
      provider: options.provider,
      ...(options.cache === undefined ? {} : { cache: options.cache }),
    });
  }

  const card = renderCard({ pr, summary });
  const fingerprint = renderFingerprint(card);
  // 이름이 `observation`이 아닌 것이 의도다. 위의 `observation`은 reconcile 결과이고 이것은
  // `pr_message` 한 행에 남길 지문 둘과 요약이다. 두 값의 수명과 용도가 다르다.
  const record = {
    renderFingerprint: fingerprint,
    factsFingerprint: factsFp,
    summaryJson: serializeSummary(summary),
  } as const;
  const base = {
    kind: 'card',
    key: pr.key,
    identity: identityLine(pr),
    url: pr.url,
    card,
    fingerprint,
    summary,
    summaryReused: reused !== null,
  } as const;

  /**
   * 게이트 C와 상태 저장. 이 관측이 durable store에 남기는 것 전부다.
   *
   * `threadTs`가 null이면 매달 루트를 확정할 수 없다는 뜻이므로 게시하지 않는다. 그래도 후보는
   * 버리지 않는다 — 아직 참인 사실이면 다음 관측에서 다시 후보가 된다.
   *
   * 순서가 중요하다. **게시한 뒤에 기록한다.** 먼저 기록하면 게시에 실패한 전이가 기록된
   * 것으로 남아 영영 나가지 않는다. 반대 순서의 대가(게시 뒤 기록 전에 죽으면 다음 관측이
   * 다시 게시한다)는 `pr_message`가 이미 안고 있는 창과 같은 것이고, 그 창을 여기서 닫지
   * 않는다(스펙 §9, OD-051).
   *
   * dry-run은 아무것도 쓰지 않는다. 결정만 돌려준다.
   */
  const settle = async (threadTs: string | null): Promise<readonly PrTransitionResult[]> => {
    const recorded = new Set(options.store.listThreadEvents(pr.key).map((e) => e.dedupeKey));
    const fresh = observation.candidates.filter((t) => !recorded.has(t.dedupeKey));
    const at = options.now().toISOString();
    const live = options.slack !== null;

    // 첫 관측이다. 이전 상태를 모르므로 지금 참인 사실을 전이로 내지 않는다(OD-046).
    if (previousState === null) {
      if (live) {
        for (const t of fresh) {
          options.store.recordThreadEvent({
            prKey: pr.key,
            dedupeKey: t.dedupeKey,
            kind: t.kind,
            // 게시하지 않았다는 사실을 행에 남긴다.
            messageTs: null,
            at,
          });
        }
        options.store.savePrState(pr.key, observation.state, at);
      }
      return fresh.map((t): PrTransitionResult => ({ ...t, outcome: 'baseline' }));
    }

    const out: PrTransitionResult[] = [];
    for (const t of fresh) {
      if (!live || options.thread === null || threadTs === null) {
        out.push({ ...t, outcome: 'unposted' });
        continue;
      }
      const event = renderThreadEvent({ pr, transition: t, observedAt: at });
      const posted = await boundedSlackReply(options.thread, {
        channel: options.channel,
        threadTs,
        text: event.text,
        blocks: event.blocks,
        ...(BROADCAST_TRANSITIONS.has(t.kind) ? { broadcast: true } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS);
      options.store.recordThreadEvent({
        prKey: pr.key,
        dedupeKey: t.dedupeKey,
        kind: t.kind,
        messageTs: posted.ts,
        at,
      });
      out.push({ ...t, outcome: 'posted' });
    }
    if (live) options.store.savePrState(pr.key, observation.state, at);
    return out;
  };

  if (existing !== null && existing.channelId !== options.channel) {
    // 채널이 어긋난 동안에도 관측한 사실은 남긴다(`recordPrTask`와 같은 근거). thread에는
    // 쓰지 않는다 — 어느 채널의 어느 루트에 매달지 확정할 수 없다.
    const transitions = await settle(null);
    return { ...base, action: 'channel_mismatch', messageTs: existing.messageTs, transitions };
  }

  // 게이트 B. 게시 여부는 렌더 지문이 정한다. 사실이 그대로여도 카드에만 있는 사실(PR state,
  // headMatch 등)이 움직이면 여기서 잡히고, 요약을 재사용한 채 chat.update로 간다.
  if (existing !== null && existing.renderFingerprint === fingerprint) {
    // 카드는 그대로다. Slack은 부르지 않는다. 다만 이번에 새로 요약했다면 그 결과는 남긴다.
    // 남기지 않으면 이 사실 조합이 관찰마다 다시 요약된다. dry-run은 아무것도 쓰지 않는다.
    if (options.slack !== null && reused === null) {
      options.store.updateObservation(pr.key, record, options.now().toISOString());
    }
    const transitions = await settle(existing.messageTs);
    return { ...base, action: 'skip', messageTs: existing.messageTs, transitions };
  }

  if (options.slack === null) {
    return {
      ...base,
      action: existing === null ? 'create' : 'update',
      messageTs: existing?.messageTs ?? null,
      transitions: await settle(existing?.messageTs ?? null),
    };
  }

  const at = options.now().toISOString();
  if (existing === null) {
    const created = await postSlackRootAtMostOnce({
      store: options.store,
      entity: { kind: 'pr', key: pr.key },
      channel: options.channel,
      renderFingerprint: fingerprint,
      message: { text: card.text, blocks: card.blocks },
      mapping: {
        kind: 'pr',
        factsFingerprint: factsFp,
        summaryJson: serializeSummary(summary),
      },
      slack: options.slack,
      now: options.now,
      ...(options.rootIntent === undefined ? {} : { runtime: options.rootIntent }),
    });
    if (created.kind === 'blocked') {
      const transitions = await settle(null);
      return {
        ...base,
        action: created.state === 'pending' ? 'deferred' : 'uncertain',
        messageTs: created.messageTs,
        transitions,
      };
    }
    const transitions = await settle(created.message.ts);
    return { ...base, action: 'create', messageTs: created.message.ts, transitions };
  }

  const updated = await boundedSlackUpdate(options.slack, {
    channel: existing.channelId,
    ts: existing.messageTs,
    text: card.text,
    blocks: card.blocks,
    ...(signal === undefined ? {} : { signal }),
  }, options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS);
  options.store.updateObservation(pr.key, record, at);
  return {
    ...base,
    action: 'update',
    messageTs: updated.ts,
    transitions: await settle(updated.ts),
  };
}

/** 요약 실패 사유가 길어질 수 있어 사람이 읽는 줄에서만 자른다. `--json`은 전문을 싣는다. */
const REASON_CAP = 200;

/**
 * skip 이유마다 그것이 정상 출력인지 degraded 입력인지 한 줄로 말한다.
 *
 * reason 문자열만 찍으면 셋이 같은 무게로 보인다. `uncorrelated`는 정상 출력이고(OD-022)
 * `run_only_degraded`는 계약을 어긴 입력이므로(OD-077) 사람이 그 차이를 봐야 한다.
 */
const SKIP_NOTE: Record<PrSkipReason, string> = {
  uncorrelated: '실패가 아니라 정상 출력이다(OD-022)',
  conflict: '모순을 자동으로 한쪽으로 덮지 않는다(OD-022)',
  run_only_degraded:
    'invalid/degraded input이다. orca-run은 있고 필수 orca-task가 없다(OD-021, OD-077). ' +
    'branch 이름·제목·author로 Task를 보완하지 않는다',
};

/**
 * 사람이 읽는 보고.
 *
 * dry-run에서는 게시할 blocks를 그대로 출력한다. 실제 게시 전에 내용을 눈으로 확인하는 것이
 * dry-run의 목적이므로 결정만 요약하면 쓸모가 없다.
 */
export function formatReport(report: DigestReport): string {
  const lines: string[] = [
    `observed ${report.observedAt}  mode=${report.dryRun ? 'dry-run' : 'live'}`,
    '',
  ];
  // 카드보다 위에 둔다. dry-run은 카드마다 blocks 전문을 찍으므로 아래에 두면 묻힌다.
  if (report.degraded.length > 0) {
    lines.push(
      `degraded: Orca 관측에서 ${report.degraded.length}칸을 읽지 못했다. ` +
        '실패를 그 row에 가두고 나머지는 관측했다(OD-079)',
    );
    for (const d of report.degraded) {
      lines.push(
        `  ${d.runId} / ${d.id} · ${d.subject}.${d.field}: ${d.reason.slice(0, REASON_CAP)}`,
      );
    }
    lines.push('');
  }
  for (const r of report.results) {
    if (r.kind === 'skipped') {
      lines.push(`${r.key}  카드 없음: ${r.reason} — ${SKIP_NOTE[r.reason]}`);
      continue;
    }
    lines.push(`${r.identity}  ${r.action}`);
    lines.push(`  fingerprint ${r.fingerprint}`);
    lines.push(
      `  summary ${
        r.summary.kind === 'ok'
          ? r.summaryReused
            ? 'ok (재사용, summarizer 호출 없음)'
            : 'ok'
          : `failed: ${r.summary.reason.slice(0, REASON_CAP)}`
      }`,
    );
    lines.push(`  ts ${r.messageTs ?? '(없음)'}`);
    // 이번 관측이 thread에 무엇을 냈는지 보이지 않으면 중복 여부를 확인할 방법이 없다.
    // 이미 기록한 전이는 여기 나오지 않는다. 그것이 게이트 C가 일하고 있다는 뜻이다.
    for (const t of r.transitions) lines.push(`  transition ${t.kind} ${t.outcome} ${t.dedupeKey}`);
    lines.push(`  text ${r.card.text}`);
    if (report.dryRun) {
      lines.push('  blocks');
      lines.push(JSON.stringify(r.card.blocks, null, 2));
    }
    lines.push('');
  }
  const cards = report.results.filter((r) => r.kind === 'card').length;
  lines.push(
    `카드 ${cards}건 / 관찰 ${report.results.length}건 / ` +
      `읽지 못한 칸 ${report.degraded.length}건`,
  );
  return lines.join('\n');
}
