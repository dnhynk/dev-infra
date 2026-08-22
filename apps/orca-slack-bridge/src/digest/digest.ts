import { parseCorrelationMetadata } from '../correlate/metadata.js';
import { resolveCorrelation } from '../correlate/resolve.js';
import { listPullRequests, type PullRequestFacts } from '../github/pull-request.js';
import { fetchRepositoryIdentity } from '../github/repository.js';
import type { GhRunner } from '../github/runner.js';
import { runKey, taskKey, type PullRequestKey } from '../identity/keys.js';
import { listWorkerDone, type OrcaRunner, type OrcaTask } from '../orca/client.js';
import type { BridgeConfig } from '../project/config.js';
import type { SlackPoster } from '../slack/post.js';
import { buildCorrelationView, collectRuns } from '../snapshot/snapshot.js';
import type { DigestStore } from '../store/schema.js';
import {
  summarize,
  type SummaryCache,
  type SummaryProvider,
  type SummaryResult,
} from '../summarize/index.js';
import { buildSummaryFacts } from './facts.js';
import { projectPullRequest } from './project.js';
import { identityLine, renderCard, renderFingerprint, type RenderedCard } from './render.js';
import type { PrSkipReason, ProjectedPr } from './types.js';

/**
 * digest 1회 실행.
 *
 * C1은 polling하지 않는다. 이 함수를 한 번 부르는 것이 관찰 한 번이다(OD-023).
 *
 * ```text
 * Orca/GitHub 관찰 → correlation → ProjectedPr → SummaryFacts → summarize → renderCard
 *   → store 조회 ─┬─ 매핑 없음      → chat.postMessage → insertPrMessage
 *                 ├─ 지문 다름      → chat.update      → updateRenderFingerprint
 *                 └─ 지문 같음      → 아무것도 하지 않음
 * ```
 *
 * 이 파일은 위 순서만 담는다. 사실 수집·파생·렌더는 각 모듈에 있고 여기서 다시 판정하지 않는다.
 */

/** 카드 하나에 대해 이번 실행이 한 일(dry-run이면 했을 일). */
export type DigestAction =
  /** 매핑 행이 없어 루트를 새로 만든다. */
  | 'create'
  /** 매핑 행이 있고 렌더 지문이 달라 같은 메시지를 갱신한다. */
  | 'update'
  /** 매핑 행이 있고 지문이 같다. Slack을 호출하지 않는다. */
  | 'skip'
  /**
   * 매핑 행의 채널이 설정의 대상 채널과 다르다. Slack에도 store에도 쓰지 않는다.
   *
   * 예전 채널의 ts로 update하면 사람이 보는 채널이 아닌 곳을 갱신하고, 새로 게시하면 루트가
   * 둘이 된다. 어느 쪽도 조용히 고르지 않고 불일치를 드러낸다(UX §6).
   */
  | 'channel_mismatch';

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
      readonly fingerprint: string;
      readonly summary: SummaryResult;
      /**
       * 이 카드가 가리키는 Slack 메시지의 ts. 없으면 null.
       *
       * 채널 ID는 싣지 않는다. 이 값이 사람이 읽는 출력과 로그로 나가는데 대상 채널은 설정에서만
       * 오는 값이므로, 출력이 그 값을 다시 퍼뜨릴 이유가 없다.
       */
      readonly messageTs: string | null;
    }
  | { readonly kind: 'skipped'; readonly key: PullRequestKey; readonly reason: PrSkipReason };

export type DigestReport = {
  readonly observedAt: string;
  /** Slack과 store에 쓰지 않았다는 사실. 출력이 실제 게시처럼 읽히지 않게 한다. */
  readonly dryRun: boolean;
  readonly results: readonly DigestResult[];
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
  readonly provider: SummaryProvider;
  readonly cache: SummaryCache;
  readonly prLimit: number;
  /**
   * 이 번호의 PR만 처리한다. null이면 전부.
   *
   * 설정의 **모든** repository에서 그 번호를 찾는다. repository가 여럿이면 대상도 여럿일 수
   * 있다. 첫 실제 게시의 범위를 좁히는 손잡이이지 단일 PR을 보장하는 장치가 아니다.
   */
  readonly onlyPr: number | null;
  readonly now: () => Date;
};

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
  for (const name of config.projects.flatMap((p) => p.repositories)) {
    const repository = await fetchRepositoryIdentity(gh, name);
    for (const source of await listPullRequests(gh, repository, options.prLimit)) {
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

  return { observedAt: options.now().toISOString(), dryRun: options.slack === null, results };
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
  pr: ProjectedPr,
  source: PullRequestFacts,
  tasks: readonly OrcaTask[],
  options: DigestOptions,
): Promise<DigestResult> {
  const facts = buildSummaryFacts(
    pr,
    source,
    taskPurpose(tasks, pr),
    options.config.correlationKeys,
  );
  const summary = await summarize(facts, { provider: options.provider, cache: options.cache });
  const card = renderCard({ pr, summary });
  const fingerprint = renderFingerprint(card);
  const base = {
    kind: 'card',
    key: pr.key,
    identity: identityLine(pr),
    url: pr.url,
    card,
    fingerprint,
    summary,
  } as const;

  const existing = options.store.findPrMessage(pr.key);
  if (existing !== null && existing.channelId !== options.channel) {
    return { ...base, action: 'channel_mismatch', messageTs: existing.messageTs };
  }
  if (existing !== null && existing.renderFingerprint === fingerprint) {
    return { ...base, action: 'skip', messageTs: existing.messageTs };
  }

  if (options.slack === null) {
    return {
      ...base,
      action: existing === null ? 'create' : 'update',
      messageTs: existing?.messageTs ?? null,
    };
  }

  const at = options.now().toISOString();
  if (existing === null) {
    const posted = await options.slack.post({
      channel: options.channel,
      text: card.text,
      blocks: card.blocks,
    });
    // channel은 Slack이 돌려준 값을 쓴다. 그것이 이후 update가 쓸 canonical ID다.
    options.store.insertPrMessage({
      prKey: pr.key,
      channelId: posted.channel,
      messageTs: posted.ts,
      renderFingerprint: fingerprint,
      at,
    });
    return { ...base, action: 'create', messageTs: posted.ts };
  }

  const updated = await options.slack.update({
    channel: existing.channelId,
    ts: existing.messageTs,
    text: card.text,
    blocks: card.blocks,
  });
  options.store.updateRenderFingerprint(pr.key, fingerprint, at);
  return { ...base, action: 'update', messageTs: updated.ts };
}

/** 요약 실패 사유가 길어질 수 있어 사람이 읽는 줄에서만 자른다. `--json`은 전문을 싣는다. */
const REASON_CAP = 200;

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
  for (const r of report.results) {
    if (r.kind === 'skipped') {
      lines.push(`${r.key}  카드 없음: ${r.reason}`);
      continue;
    }
    lines.push(`${r.identity}  ${r.action}`);
    lines.push(`  fingerprint ${r.fingerprint}`);
    lines.push(
      `  summary ${
        r.summary.kind === 'ok'
          ? 'ok'
          : `failed: ${r.summary.reason.slice(0, REASON_CAP)}`
      }`,
    );
    lines.push(`  ts ${r.messageTs ?? '(없음)'}`);
    lines.push(`  text ${r.card.text}`);
    if (report.dryRun) {
      lines.push('  blocks');
      lines.push(JSON.stringify(r.card.blocks, null, 2));
    }
    lines.push('');
  }
  const cards = report.results.filter((r) => r.kind === 'card').length;
  lines.push(`카드 ${cards}건 / 관찰 ${report.results.length}건`);
  return lines.join('\n');
}
