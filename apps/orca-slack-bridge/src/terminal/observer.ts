import { createHash } from 'node:crypto';

import type { OrcaRunner } from '../orca/client.js';
import type { SlackPoster } from '../slack/post.js';
import type { RunKey } from '../identity/keys.js';
import { answerTerminalPrompt } from './answer.js';
import { readTerminalScreen } from './client.js';
import { hasPromptAnchor, parseTerminalPrompt } from './prompt.js';
import { renderTerminalPromptCard } from './render.js';
import type { ObservedTerminalPrompt, TerminalPromptRecord, TerminalRole } from './types.js';

/**
 * 한 pass에서 막힌 터미널을 찾아 카드로 올리고, 확정된 답을 보낸다.
 *
 * ## 왜 관측과 답변이 같은 job인가
 *
 * 둘 다 같은 터미널의 화면을 만진다. 다른 job으로 나누면 supervisor의 단일 lane 안에서도 두
 * 작업이 서로의 중간 상태를 본다 — 답을 보내는 중에 관측이 "프롬프트가 사라졌다"고 판정하는
 * 식이다. 하나로 두면 그 순서가 코드에 그대로 있다.
 */

export type TerminalPromptCandidate = {
  readonly handle: string;
  readonly runKey: RunKey;
  readonly role: TerminalRole;
  readonly dispatchId: string | null;
  /** 카드 머리글에 쓸 Run 이름. */
  readonly runLabel: string;
  /**
   * 카드를 게시할 채널. 답할 카드만 오는 채널이라 **최상위 메시지로** 게시한다.
   *
   * 스레드 답글이 아니다. 답글은 스레드를 따르지 않는 사람에게 알림이 가지 않고, 알림을 위해
   * broadcast를 켜면 그 복사본이 상태 카드 사이에 섞인다. 답할 카드는 그 채널의 맨 아래에
   * 혼자 있어야 폰에서 열자마자 보인다.
   */
  readonly channelId: string;
};

export type TerminalPromptStore = {
  observeTerminalPrompt(input: ObservedTerminalPrompt, at: string): TerminalPromptRecord;
  markTerminalPromptGone(handle: string, at: string): void;
  findTerminalPrompt(handle: string, fingerprint: string): TerminalPromptRecord | null;
  listTerminalPromptsByState(state: string): readonly TerminalPromptRecord[];
  recordTerminalPromptCard(input: {
    readonly handle: string;
    readonly fingerprint: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly messageTs: string;
    readonly renderFingerprint: string;
    readonly at: string;
  }): void;
  updateTerminalPromptCard(
    handle: string,
    fingerprint: string,
    renderFingerprint: string,
    at: string,
  ): void;
  settleTerminalPromptAnswer(input: {
    readonly handle: string;
    readonly fingerprint: string;
    readonly outcome: 'answered' | 'failed';
    readonly errorCode: string | null;
    readonly at: string;
  }): void;
  recordTerminalPromptAttempt(input: {
    readonly handle: string;
    readonly fingerprint: string;
    readonly optionIndex: number;
    readonly outcome: 'sent' | 'refused' | 'failed';
    readonly reason: string | null;
    readonly at: string;
  }): void;
};

export type TerminalPromptPassDeps = {
  readonly orca: OrcaRunner;
  readonly store: TerminalPromptStore;
  readonly slack: SlackPoster;
  /** 이번 pass에서 볼 터미널. 호출자가 Run과 Dispatch에서 만들어 넘긴다. */
  readonly candidates: readonly TerminalPromptCandidate[];
  readonly now: () => Date;
  /** 커서 이동 뒤 화면이 다시 그려질 때까지의 대기. */
  readonly settle: () => Promise<void>;
  readonly onError?: (code: string) => void;
};

export type TerminalPromptPassReport = {
  readonly observed: number;
  /** 프롬프트가 떠 있는데 화면에서 선택지를 만들지 못한 터미널 수. 사라진 것과 다르다. */
  readonly unreadable: number;
  readonly posted: number;
  readonly updated: number;
  readonly answered: number;
  readonly refused: number;
  readonly failed: number;
};

function renderFingerprint(text: string, blocks: unknown): string {
  return createHash('sha256')
    .update(`${text}\n${JSON.stringify(blocks)}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export async function runTerminalPromptPass(
  deps: TerminalPromptPassDeps,
  signal?: AbortSignal,
): Promise<TerminalPromptPassReport> {
  let observed = 0;
  let unreadable = 0;
  let posted = 0;
  let updated = 0;
  let answered = 0;
  let refused = 0;
  let failed = 0;

  const byHandle = new Map(deps.candidates.map((candidate) => [candidate.handle, candidate]));

  // 1) 관측. 화면을 읽어 프롬프트를 durable하게 남기고 카드를 만든다.
  for (const candidate of deps.candidates) {
    if (signal?.aborted === true) break;
    const at = deps.now().toISOString();
    let rows: readonly string[] | null;
    try {
      const screen = await readTerminalScreen(deps.orca, candidate.handle);
      rows = screen === null || screen.status !== 'running' ? null : screen.rows;
    } catch {
      // 한 터미널을 읽지 못한 것이 pass 전체를 멈추지 않는다.
      deps.onError?.('terminal.screen_read_failed');
      continue;
    }
    const prompt = rows === null ? null : parseTerminalPrompt(rows);
    if (prompt === null) {
      // 프롬프트가 떠 있는데 읽지 못한 경우와 사라진 경우를 구분한다. 앞의 경우를 닫으면
      // 카드가 "이미 처리됨"이라고 말하는데 코디네이터는 그대로 막혀 있다.
      if (rows !== null && hasPromptAnchor(rows)) {
        unreadable += 1;
        deps.onError?.('terminal.prompt_unreadable');
        continue;
      }
      deps.store.markTerminalPromptGone(candidate.handle, at);
      continue;
    }
    observed += 1;
    const record = deps.store.observeTerminalPrompt({
      terminalHandle: candidate.handle,
      runKey: candidate.runKey,
      role: candidate.role,
      dispatchId: candidate.dispatchId,
      fingerprint: prompt.fingerprint,
      title: prompt.title,
      question: prompt.question,
      options: prompt.options,
      cursorIndex: prompt.cursorIndex,
    }, at);
    const publishOutcome = await publishCard(deps, candidate, record, at);
    if (publishOutcome === 'posted') posted += 1;
    if (publishOutcome === 'updated') updated += 1;
  }

  // 2) 답변. 사용자가 고른 것만 여기 있다.
  for (const claimed of deps.store.listTerminalPromptsByState('claimed')) {
    if (signal?.aborted === true) break;
    const at = deps.now().toISOString();
    const outcome = await answerTerminalPrompt(
      { orca: deps.orca, settle: deps.settle },
      claimed,
    );
    const attempt = outcome.kind === 'answered' ? 'sent' : outcome.kind;
    deps.store.recordTerminalPromptAttempt({
      handle: claimed.terminalHandle,
      fingerprint: claimed.fingerprint,
      optionIndex: claimed.claimedOption ?? 0,
      outcome: attempt,
      reason: outcome.kind === 'answered' ? null : outcome.reason,
      at,
    });
    deps.store.settleTerminalPromptAnswer({
      handle: claimed.terminalHandle,
      fingerprint: claimed.fingerprint,
      outcome: outcome.kind === 'answered' ? 'answered' : 'failed',
      errorCode: outcome.kind === 'answered' ? null : outcome.reason,
      at,
    });
    if (outcome.kind === 'answered') answered += 1;
    else if (outcome.kind === 'refused') refused += 1;
    else failed += 1;
    if (outcome.kind !== 'answered') deps.onError?.(`terminal.answer_${outcome.reason}`);

    const settled = deps.store.findTerminalPrompt(claimed.terminalHandle, claimed.fingerprint);
    const candidate = byHandle.get(claimed.terminalHandle);
    if (settled !== null && candidate !== undefined) {
      await publishCard(deps, candidate, settled, at);
    }
  }

  return { observed, unreadable, posted, updated, answered, refused, failed };
}

/**
 * 카드를 만들거나 갱신한다.
 *
 * 렌더 지문이 같으면 Slack을 부르지 않는다. 같은 프롬프트를 매 pass마다 다시 그리면 카드가
 * 계속 갱신되고, 그 갱신은 사람에게 아무 것도 알리지 않으면서 rate limit만 쓴다.
 */
async function publishCard(
  deps: TerminalPromptPassDeps,
  candidate: TerminalPromptCandidate,
  record: TerminalPromptRecord,
  at: string,
): Promise<'posted' | 'updated' | 'skipped'> {
  const card = renderTerminalPromptCard({ prompt: record, runLabel: candidate.runLabel });
  const fingerprint = renderFingerprint(card.text, card.blocks);

  if (record.messageTs === null) {
    try {
      const posted = await deps.slack.post({
        channel: candidate.channelId,
        text: card.text,
        blocks: card.blocks,
      });
      deps.store.recordTerminalPromptCard({
        handle: record.terminalHandle,
        fingerprint: record.fingerprint,
        channelId: candidate.channelId,
        // 스레드가 없다. 매핑의 세 값은 함께 있거나 함께 없어야 하므로 자기 자신을 쓴다.
        threadTs: posted.ts,
        messageTs: posted.ts,
        renderFingerprint: fingerprint,
        at,
      });
      return 'posted';
    } catch {
      deps.onError?.('terminal.card_post_failed');
      return 'skipped';
    }
  }

  if (record.renderFingerprint === fingerprint) return 'skipped';
  try {
    await deps.slack.update({
      channel: record.channelId ?? candidate.channelId,
      ts: record.messageTs,
      text: card.text,
      blocks: card.blocks,
    });
    deps.store.updateTerminalPromptCard(
      record.terminalHandle, record.fingerprint, fingerprint, at,
    );
    return 'updated';
  } catch {
    deps.onError?.('terminal.card_update_failed');
    return 'skipped';
  }
}
