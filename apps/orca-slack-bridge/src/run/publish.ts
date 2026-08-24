import { renderFingerprint, type RenderedCard } from '../digest/render.js';
import { publishGateCard, type GatePublishResult } from '../gate/publish.js';
import type { OrcaRunner } from '../orca/client.js';
import type { BridgeConfig } from '../project/config.js';
import {
  boundedSlackUpdate,
  DEFAULT_SLACK_UPDATE_TIMEOUT_MS,
  type SlackPoster,
  type ThreadPoster,
} from '../slack/post.js';
import type { GateStore, RunStore } from '../store/schema.js';
import { collectRunFacts } from './collect.js';
import {
  renderRunCard,
  renderRunCollectionCard,
  type RunCardInput,
  type RunCollectionContext,
} from './render.js';
import type { RunCollection, RunFacts } from './types.js';

/**
 * Run 카드 게시 경계.
 *
 * **여기서 Slack을 직접 부르지 않는다.** `SlackPoster` 뒤에 있고, 이 파일의 검증은 전부
 * 대역으로 한다. 실제 `#agent-runs` write 경계를 만드는 곳은 `cli.ts`의 `runsPoster`이고,
 * 그 배선을 고정하는 테스트는 `test/cli-runs.test.ts`에 있다.
 *
 * ## 무엇을 보장하는가
 *
 * **매핑 행이 남은 뒤의 재관찰과 재시작은 새 루트를 만들지 않는다.** `findRunMessage`가 기존
 * 행을 찾고 렌더 지문이 다르면 `chat.update`로 간다. 판정 근거가 프로세스 메모리가 아니라
 * durable store 파일이므로 재시작이 이 판정을 잃지 않는다. 이것이 로드맵 §7의 "재시작 뒤 같은
 * Run root를 재사용함"이 요구하는 것이다.
 *
 * ## 무엇을 보장하지 않는가 — `pr_message`와 **같은 두 창**이다
 *
 * **Slack 루트가 Run당 하나라는 것을 보장하지 않는다.**
 *
 * 창 1 — crash. `chat.postMessage`가 성공한 뒤 `insertRunMessage` 전에 프로세스가 죽으면 매핑
 * 행이 없으므로 다음 실행이 루트를 하나 더 만든다.
 *
 * 창 2 — delivery unknown. 프로세스가 죽지 않아도 게시 여부를 알 수 없는 실패가 있다. 응답을
 * 받지 못한 경우가 그렇고, 응답을 받았어도 Slack이 부분 성공 가능성을 명시하는
 * 오류(`internal_error`, `fatal_error`)가 그렇다. 판정 기준은 `slack/post.ts`에 있다. 호출자에게는
 * 실패로 보이므로 매핑 행이 남지 않고, 같은 실행의 재시도나 다음 관찰이 루트를 하나 더 만든다.
 *
 * 두 창을 D1에서 닫지 않는다. 스펙 §9가 crash 경계별 atomicity와 outbox를 TBD로 두었고 같은
 * 성격의 미결정 항목이 OD-051이다. 지금 outbox나 2단계 commit이나 요청 idempotency key를
 * 설계하면 미결정 항목을 구현자가 조용히 닫는 것이 된다.
 *
 * **구현자에게**: 이 성질이 보장된 것처럼 쓰지 마라. `SlackPoster.post`가 던진 실패는 "메시지가
 * 만들어지지 않았다"는 뜻이 아니다. 결과를 모르는 실패를 자동 재시도로 덮으면 루트가 늘어난다.
 * `post`의 재시도 정책이 `update`와 반대인 이유가 그것이고 그 판정은 `slack/post.ts`에 있다.
 */

/**
 * 이 관찰이 카드 하나에 대해 내린 결정.
 *
 * `skip`은 실패가 아니다. 렌더 지문이 같아 게시할 것이 없다는 뜻이며 Slack을 부르지 않는다.
 */
export type RunPublishAction = 'create' | 'update' | 'skip' | 'channel_mismatch';

/**
 * 카드 한 장에 대한 결정과 그 결정이 만든 값.
 *
 * Run 카드와 컬렉션 카드가 같은 모양을 쓴다. 다른 것은 카드를 식별하는 값뿐이고, Run 카드는
 * 그 값을 `RunPublishResult.run`으로 싣는다. 컬렉션 카드에는 식별할 것이 없다 — 관찰 하나에
 * 한 장이다.
 */
export type RunPublishOutcome = {
  readonly action: RunPublishAction;
  /** 게시된(또는 기존) 루트의 ts. dry-run에서 아직 루트가 없으면 null이다. */
  readonly messageTs: string | null;
  readonly fingerprint: string;
  readonly card: RenderedCard;
};

export type RunPublishResult = RunPublishOutcome & {
  readonly run: RunFacts;
};

/**
 * 관찰 1회가 게시한 것 전부(OD-080).
 *
 * **컬렉션 카드가 별도 필드다.** Run 카드 목록에 섞으면 등록 Run이 0일 때 "카드가 하나 있다"와
 * "Run 카드가 하나 있다"를 구분할 수 없고, 소비자가 컬렉션 카드를 Run 카드로 세게 된다.
 */
export type RunCollectionPublishResult = {
  /** 컬렉션 루트. **등록 Run 수와 무관하게 항상 있다.** */
  readonly collection: RunPublishOutcome;
  readonly runs: readonly RunPublishResult[];
  /** Replies keyed by Gate; only exactly matched pending sidecars contain fixed-option actions. */
  readonly gates: readonly GatePublishResult[];
};

export type RunPublishOptions = {
  readonly store: RunStore & GateStore;
  /**
   * Slack write 경계. **null이면 dry-run이다** — Slack도 store도 건드리지 않고 결정만 돌려준다.
   *
   * `digest`가 `slack: null`을 dry-run 신호로 쓰는 것과 같은 모양이다. 두 경로가 다른 신호를
   * 쓰면 한쪽만 고쳐진다.
   */
  readonly slack: SlackPoster | null;
  /** Gate thread reply boundary. Null together with `slack` means dry-run. */
  readonly thread: ThreadPoster | null;
  /** 대상 채널 ID. 설정의 `slack.channels.agentRuns`에서 온다. */
  readonly channel: string;
  readonly now: () => Date;
  readonly slackTimeoutMs?: number;
};

/**
 * Run 카드 한 장을 게시하거나 갱신한다.
 *
 * 카드를 **여기서 그린다.** 호출자가 그린 카드를 받으면 게시한 blocks와 지문을 계산한 blocks가
 * 갈라질 수 있고, 그러면 "지문이 같다"가 "게시할 내용이 같다"를 더는 뜻하지 않는다.
 *
 * 순서:
 *
 * ```text
 * findRunMessage → null        → chat.postMessage → insertRunMessage      (create)
 *                → 채널 불일치 → 아무것도 하지 않는다                      (channel_mismatch)
 *                → 지문 같음   → Slack을 부르지 않는다                     (skip)
 *                → 지문 다름   → chat.update → updateRunObservation        (update)
 * ```
 *
 * 채널이 어긋나면 게시하지 않는다. 예전 채널의 ts로 update를 걸면 지금 설정이 가리키는 채널이
 * 아닌 곳의 메시지를 고치고, 새로 post하면 루트가 둘이 된다. 어느 쪽도 이 관찰이 결정할 일이
 * 아니므로 사실만 돌려준다.
 */
export async function publishRunCard(
  options: RunPublishOptions,
  input: RunCardInput,
): Promise<RunPublishResult> {
  const card = renderRunCard(input);
  const fingerprint = renderFingerprint(card);
  const runKey = input.run.identity.key;
  const base = { run: input.run, fingerprint, card } as const;

  // **루트 재사용의 유일한 근거다.** 이 조회를 끊으면 재관찰마다 새 루트가 생긴다.
  const existing = options.store.findRunMessage(runKey);

  if (existing !== null && existing.channelId !== options.channel) {
    return { ...base, action: 'channel_mismatch', messageTs: existing.messageTs };
  }

  if (existing !== null && existing.renderFingerprint === fingerprint) {
    // 카드가 그대로다. Slack도 store도 부르지 않는다. 이 경로가 살아 있으려면 카드에
    // 관찰 시각이 없어야 한다 — 시각을 그리면 사실이 그대로여도 지문이 매번 달라져 `skip`이
    // 실운영에서 발화하지 않는다. 근거는 `store/schema.ts`의 지문 규칙과 `run/render.ts`에 있다.
    return { ...base, action: 'skip', messageTs: existing.messageTs };
  }

  if (options.slack === null) {
    // dry-run. 무엇을 할지만 말하고 아무것도 쓰지 않는다.
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
    options.store.insertRunMessage({
      runKey,
      channelId: posted.channel,
      messageTs: posted.ts,
      renderFingerprint: fingerprint,
      at,
    });
    return { ...base, action: 'create', messageTs: posted.ts };
  }

  const updated = await boundedSlackUpdate(options.slack, {
    channel: existing.channelId,
    ts: existing.messageTs,
    text: card.text,
    blocks: card.blocks,
  }, options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS);
  options.store.updateRunObservation(runKey, fingerprint, at);
  return { ...base, action: 'update', messageTs: updated.ts };
}

/**
 * 컬렉션 카드 한 장을 게시하거나 갱신한다(OD-080).
 *
 * 판정 순서는 `publishRunCard`와 같고 대상 행만 다르다. 그 행은 key가 없다 — 관찰 하나에 루트
 * 하나이고, 그 근거는 `store/schema.ts`의 `RUN_COLLECTION_MESSAGE_TABLE`에 있다.
 *
 * **등록 Run 수를 보지 않는다.** 이 카드가 닫는 구멍이 "등록 Run이 0인 구간"이므로 그 수를
 * 조건으로 쓰면 닫으려던 구멍이 그대로 남는다.
 */
export async function publishRunCollectionCard(
  options: RunPublishOptions,
  collection: RunCollection,
): Promise<RunPublishOutcome> {
  const card = renderRunCollectionCard({
    cards: collection.runs.length,
    collection: { degraded: collection.degraded, unregistered: collection.unregistered },
  });
  const fingerprint = renderFingerprint(card);
  const base = { fingerprint, card } as const;

  // **루트 재사용의 유일한 근거다.** 이 조회를 끊으면 관찰마다 새 루트가 생긴다.
  const existing = options.store.findRunCollectionMessage();

  if (existing !== null && existing.channelId !== options.channel) {
    return { ...base, action: 'channel_mismatch', messageTs: existing.messageTs };
  }

  if (existing !== null && existing.renderFingerprint === fingerprint) {
    return { ...base, action: 'skip', messageTs: existing.messageTs };
  }

  if (options.slack === null) {
    // dry-run. 무엇을 할지만 말하고 아무것도 쓰지 않는다.
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
    options.store.insertRunCollectionMessage({
      channelId: posted.channel,
      messageTs: posted.ts,
      renderFingerprint: fingerprint,
      at,
    });
    return { ...base, action: 'create', messageTs: posted.ts };
  }

  const updated = await boundedSlackUpdate(options.slack, {
    channel: existing.channelId,
    ts: existing.messageTs,
    text: card.text,
    blocks: card.blocks,
  }, options.slackTimeoutMs ?? DEFAULT_SLACK_UPDATE_TIMEOUT_MS);
  options.store.updateRunCollectionObservation(fingerprint, at);
  return { ...base, action: 'update', messageTs: updated.ts };
}

/**
 * 관찰 1회를 게시한다. 컬렉션 카드 한 장과 등록된 Run마다 카드 한 장이다.
 *
 * Run 카드 입력을 **여기서 조립한다.** 컬렉션 수준 사실(컬렉션 degraded, 미등록 Run)을
 * 카드마다 싣고, 이 Run에 연결된 PR을 store에서 읽는다. GitHub을 부르지 않는다.
 *
 * `collection.unregistered`의 Run은 Run 카드를 만들지 않는다. 등록 열쇠가 맞지 않는 Run이므로
 * 어느 Project의 채널로 보낼지 정할 수 없다. **버리지도 않는다** — 그 수가 모든 Run 카드에
 * 실리고, Run 카드가 하나도 없어도 컬렉션 카드에 실린다(OD-080).
 *
 * **컬렉션 카드를 먼저 게시한다.** 뒤에 두면 Run 카드 하나의 게시 실패가 컬렉션 카드까지
 * 막는다. 컬렉션 카드가 싣는 것은 등록 실패를 드러내는 사실이고, 그 사실은 개별 카드의 성패와
 * 무관하게 도달해야 한다.
 */
export async function publishRunCollection(
  options: RunPublishOptions,
  collection: RunCollection,
): Promise<RunCollectionPublishResult> {
  const collectionResult = await publishRunCollectionCard(options, collection);

  // 관측 시각을 싣지 않는다. 카드에 그리지 않기 때문이고, 그 근거는 `run/render.ts`에 있다.
  const context: RunCollectionContext = {
    degraded: collection.degraded,
    unregistered: collection.unregistered,
  };
  const results: RunPublishResult[] = [];
  const gateResults: GatePublishResult[] = [];
  for (const run of collection.runs) {
    const root = await publishRunCard(options, {
      run,
      pullRequests: options.store.listRunPullRequests(run.identity.key),
      collection: context,
    });
    results.push(root);
    const rootMessageTs = root.action === 'channel_mismatch' ? null : root.messageTs;
    for (const gate of run.gates) {
      gateResults.push(
        await publishGateCard(
          {
            store: options.store,
            slack: options.slack,
            thread: options.thread,
            channel: options.channel,
            now: options.now,
            ...(options.slackTimeoutMs === undefined
              ? {}
              : { slackTimeoutMs: options.slackTimeoutMs }),
          },
          run.identity.key,
          rootMessageTs,
          gate,
        ),
      );
    }
  }
  return { collection: collectionResult, runs: results, gates: gateResults };
}

/**
 * `runs` 1회 실행의 옵션.
 *
 * `digest`의 `DigestOptions`와 같은 규율이다. **`slack`이 null이면 dry-run이고**, 그때 store도
 * 읽기 전용이어야 한다(그 판정은 CLI의 `openRunStore`에 있다). dry-run 신호를 두 곳에 두면
 * 한쪽만 고쳐진다.
 */
export type RunObserveOptions = {
  readonly config: BridgeConfig;
  /** 게시 대상 채널 ID. 설정의 `slack.channels.agentRuns`에서만 온다. 여기서 만들지 않는다. */
  readonly channel: string;
  readonly store: RunStore & GateStore;
  /** Slack write 경계. **null이면 dry-run이다.** */
  readonly slack: SlackPoster | null;
  /** Gate thread reply boundary. Null together with `slack` means dry-run. */
  readonly thread: ThreadPoster | null;
  readonly now: () => Date;
  readonly slackTimeoutMs?: number;
};

/**
 * 관찰 1회의 결과. 사실과 결정을 **나눠 싣는다.**
 *
 * 합치면 "무엇을 관측했는가"와 "그래서 무엇을 했는가"가 한 값이 되어, 게시하지 않은 관찰과
 * 게시한 관찰을 같은 모양으로 읽게 된다.
 */
export type RunObserveReport = {
  readonly observedAt: string;
  /** Slack과 store에 쓰지 않았다는 사실. 출력이 실제 게시처럼 읽히지 않게 한다. */
  readonly dryRun: boolean;
  readonly facts: RunCollection;
  readonly published: RunCollectionPublishResult;
};

/**
 * `runs` 1회 실행. **관찰 1회가 게시 1회다**(OD-023의 규율을 D1에도 그대로 쓴다).
 *
 * ```text
 * collectRunFacts → publishRunCollection ─┬─ 컬렉션 카드 1장 (항상)
 *                                         └─ 등록된 Run마다 Run 카드 1장
 * ```
 *
 * GitHub을 부르지 않는다. Run 카드가 그리는 PR은 `digest`가 이미 store에 남긴 것뿐이고, 그
 * 경계는 카드가 문구로 드러낸다(`run/render.ts`).
 *
 * dry-run 여부를 인자로 따로 받지 않는다. `slack === null`이 그 신호다.
 */
export async function runRunObserver(
  orca: OrcaRunner,
  options: RunObserveOptions,
): Promise<RunObserveReport> {
  const facts = await collectRunFacts(orca, options.config, {
    now: options.now,
    gateStore: options.store,
  });
  const published = await publishRunCollection(options, facts);
  return {
    observedAt: facts.observedAt,
    dryRun: options.slack === null,
    facts,
    published,
  };
}

/** 카드 한 장의 결정을 사람이 읽는 줄로 만든다. */
function outcomeLines(
  label: string,
  outcome: {
    readonly action: string;
    readonly messageTs: string | null;
    readonly fingerprint: string;
    readonly card: RenderedCard;
  },
  dryRun: boolean,
): string[] {
  const lines = [
    `${label}  ${outcome.action}`,
    `  fingerprint ${outcome.fingerprint}`,
    `  ts ${outcome.messageTs ?? '(없음)'}`,
    `  text ${outcome.card.text}`,
  ];
  // dry-run은 게시하지 않으므로 만들 blocks를 그 자리에서 볼 수 있어야 한다. `digest`와 같다.
  if (dryRun) {
    lines.push('  blocks');
    lines.push(JSON.stringify(outcome.card.blocks, null, 2));
  }
  return lines;
}

/**
 * 관찰 1회를 사람이 읽는 보고로 만든다.
 *
 * 사실 보고(`formatRunCollection`)와 게시 보고를 **둘 다** 낸다. 사실만 내면 무엇을 게시했는지
 * 모르고, 결정만 내면 그 결정이 어떤 관측 위에 섰는지 모른다.
 *
 * 컬렉션 카드를 Run 카드 수에 더하지 않는다. 두 수가 세는 것이 다르다.
 */
export function formatRunObserveReport(report: RunObserveReport): string {
  const lines: string[] = [
    `observed ${report.observedAt}  mode=${report.dryRun ? 'dry-run' : 'live'}`,
    '',
  ];
  lines.push(...outcomeLines('컬렉션 카드', report.published.collection, report.dryRun));
  lines.push('');
  for (const r of report.published.runs) {
    lines.push(...outcomeLines(r.run.identity.runId, r, report.dryRun));
    lines.push('');
  }
  for (const gate of report.published.gates) {
    lines.push(...outcomeLines(`Gate ${gate.gate.gateId}`, gate, report.dryRun));
    lines.push('');
  }
  lines.push(
    `Run 카드 ${report.published.runs.length}건 / 컬렉션 카드 1건 / ` +
      `Gate thread 카드 ${report.published.gates.length}건 / ` +
      `등록되지 않은 Run ${report.facts.unregistered.count}건`,
  );
  return lines.join('\n');
}
