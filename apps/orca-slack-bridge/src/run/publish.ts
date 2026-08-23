import { renderFingerprint, type RenderedCard } from '../digest/render.js';
import type { SlackPoster } from '../slack/post.js';
import type { RunStore } from '../store/schema.js';
import { renderRunCard, type RunCardInput, type RunCollectionContext } from './render.js';
import type { RunCollection, RunFacts } from './types.js';

/**
 * Run 카드 게시 경계(D1-B).
 *
 * **여기서 Slack을 직접 부르지 않는다.** `SlackPoster` 뒤에 있고, 이 slice의 검증은 전부
 * 대역으로 한다. 실제 `#agent-runs` write는 D1-C다. C1·C2가 같은 순서였다(로직 → 게시 분리).
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

export type RunPublishResult = {
  readonly run: RunFacts;
  readonly action: RunPublishAction;
  /** 게시된(또는 기존) 루트의 ts. dry-run에서 아직 루트가 없으면 null이다. */
  readonly messageTs: string | null;
  readonly fingerprint: string;
  readonly card: RenderedCard;
};

export type RunPublishOptions = {
  readonly store: RunStore;
  /**
   * Slack write 경계. **null이면 dry-run이다** — Slack도 store도 건드리지 않고 결정만 돌려준다.
   *
   * `digest`가 `slack: null`을 dry-run 신호로 쓰는 것과 같은 모양이다. 두 경로가 다른 신호를
   * 쓰면 한쪽만 고쳐진다.
   */
  readonly slack: SlackPoster | null;
  /** 대상 채널 ID. 설정의 `slack.channels.agentRuns`에서 온다. */
  readonly channel: string;
  readonly now: () => Date;
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
    // 카드가 그대로다. Slack도 store도 부르지 않는다. 관찰 시각은 카드에 있으므로 사실이
    // 그대로면 지문도 그대로다 — 시각이 움직였다면 지문이 이미 달라 여기 오지 않는다.
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

  const updated = await options.slack.update({
    channel: existing.channelId,
    ts: existing.messageTs,
    text: card.text,
    blocks: card.blocks,
  });
  options.store.updateRunObservation(runKey, fingerprint, at);
  return { ...base, action: 'update', messageTs: updated.ts };
}

/**
 * 관찰 1회의 등록된 Run 전부를 게시한다.
 *
 * 카드 입력을 **여기서 조립한다.** 컬렉션 수준 사실(관측 시각, 컬렉션 degraded, 미등록 Run 수)을
 * 카드마다 싣고, 이 Run에 연결된 PR을 store에서 읽는다. GitHub을 부르지 않는다.
 *
 * `collection.unregistered`의 Run은 카드를 만들지 않는다. 등록 열쇠가 맞지 않는 Run이므로 어느
 * Project의 채널로 보낼지 정할 수 없다. **버리지도 않는다** — 그 수가 모든 카드에 실린다.
 * 등록된 Run이 하나도 없으면 카드도 없어 그 수가 보이지 않는 구간이 남고, 그 경계는
 * `run/render.ts`에 적었다.
 */
export async function publishRunCollection(
  options: RunPublishOptions,
  collection: RunCollection,
): Promise<readonly RunPublishResult[]> {
  const context: RunCollectionContext = {
    observedAt: collection.observedAt,
    degraded: collection.degraded,
    unregistered: collection.unregistered,
  };
  const results: RunPublishResult[] = [];
  for (const run of collection.runs) {
    results.push(
      await publishRunCard(options, {
        run,
        pullRequests: options.store.listRunPullRequests(run.identity.key),
        collection: context,
      }),
    );
  }
  return results;
}
