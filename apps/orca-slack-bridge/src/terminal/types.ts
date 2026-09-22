import type { RunKey } from '../identity/keys.js';
import type { TerminalPromptOption } from './prompt.js';

/** 프롬프트가 뜬 자리. 카드 문구와 스레드 위치가 이 값으로 갈린다. */
export type TerminalRole = 'coordinator' | 'worker';

/**
 * 답변 진행 상태.
 *
 * - `open`: 관측했고 아직 아무도 고르지 않았다.
 * - `claimed`: 사용자가 Slack에서 골랐고 daemon이 아직 보내지 않았다.
 * - `answered`: 화면 재확인까지 마치고 Enter를 보냈다.
 * - `failed`: 보내지 못했다. 이유는 `lastErrorCode`에 있다.
 * - `gone`: 화면에서 사라졌다. 사람이 터미널에서 직접 답했을 때가 대부분이다.
 */
export type TerminalPromptState = 'open' | 'claimed' | 'answered' | 'failed' | 'gone';

/** durable하게 남는 프롬프트 한 건. */
export type TerminalPromptRecord = {
  readonly terminalHandle: string;
  readonly runKey: RunKey;
  readonly role: TerminalRole;
  readonly dispatchId: string | null;
  readonly fingerprint: string;
  readonly title: string | null;
  readonly question: string;
  readonly options: readonly TerminalPromptOption[];
  readonly cursorIndex: number;
  readonly channelId: string | null;
  readonly threadTs: string | null;
  readonly messageTs: string | null;
  readonly renderFingerprint: string | null;
  readonly state: TerminalPromptState;
  readonly claimedOption: number | null;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly settledAt: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

/** 관측 한 번이 남기는 값. 카드 매핑과 답변 상태는 여기 없다 — 관측이 건드리지 않는다. */
export type ObservedTerminalPrompt = {
  readonly terminalHandle: string;
  readonly runKey: RunKey;
  readonly role: TerminalRole;
  readonly dispatchId: string | null;
  readonly fingerprint: string;
  readonly title: string | null;
  readonly question: string;
  readonly options: readonly TerminalPromptOption[];
  readonly cursorIndex: number;
};

export type TerminalPromptAttemptOutcome = 'sent' | 'refused' | 'failed';

/** 답변 claim 결과. `stale`은 화면이 이미 바뀌었다는 뜻이고 실패가 아니다. */
export type TerminalPromptClaim =
  | { readonly kind: 'claimed'; readonly record: TerminalPromptRecord }
  | { readonly kind: 'duplicate'; readonly record: TerminalPromptRecord }
  | { readonly kind: 'stale'; readonly reason: string };
