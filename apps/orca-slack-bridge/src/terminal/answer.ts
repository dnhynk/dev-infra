import {
  KEY_DOWN,
  KEY_UP,
  type TerminalScreen,
  readTerminalScreen,
  sendTerminalInput,
} from './client.js';
import { cursorDelta, isFreeTextAffordance, parseTerminalPrompt } from './prompt.js';
import type { TerminalPromptRecord } from './types.js';
import type { OrcaRunner } from '../orca/client.js';

/**
 * 확정된 선택 하나를 살아 있는 터미널에 넣는다.
 *
 * ## 순서가 안전성 전부다
 *
 * 1. 화면을 다시 읽어 지문을 대조한다. 다르면 **보내지 않는다.**
 * 2. 커서를 목표까지 옮긴다. 이동은 선택이 아니라 되돌릴 수 있다.
 * 3. 다시 읽어 커서가 목표에 있는지 확인한다. 아니면 **여기서 멈춘다.**
 * 4. 확인된 뒤에만 Enter를 보낸다.
 *
 * Enter만 커밋이고 그 앞은 전부 관측 가능하다. 1단계를 건너뛰면 카드를 그린 뒤 프롬프트가 바뀐
 * 경우에 같은 답이 다른 질문으로 들어가고, 3단계를 건너뛰면 이동이 실패했을 때 엉뚱한 선택지가
 * 확정된다. 둘 다 조용히 잘못되는 종류라 반드시 관측으로 막는다.
 */

export type TerminalAnswerOutcome =
  /** Enter까지 보냈다. */
  | { readonly kind: 'answered' }
  /** 보내지 않았다. 상태가 어긋났을 뿐 고장이 아니다. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** 보내려다 실패했다. 일부 입력이 들어갔을 수 있다. */
  | { readonly kind: 'failed'; readonly reason: string };

export type TerminalAnswerDeps = {
  readonly orca: OrcaRunner;
  /**
   * 커서를 옮긴 뒤 화면이 다시 그려질 때까지 기다린다.
   *
   * 기다리지 않고 곧바로 읽으면 옮기기 전 화면을 읽어 확인이 실패한다. 테스트가 이 값을
   * 즉시 반환하도록 바꿔 실제 대기 없이 순서만 검증한다.
   */
  readonly settle: () => Promise<void>;
};

/** 한 번에 보내는 이동 키의 상한. 선택지 상한과 같아 이보다 멀리 갈 일이 없다. */
const MAX_STEPS = 25;

export async function answerTerminalPrompt(
  deps: TerminalAnswerDeps,
  record: TerminalPromptRecord,
): Promise<TerminalAnswerOutcome> {
  const target = record.claimedOption;
  if (target === null) return { kind: 'refused', reason: 'no_claimed_option' };

  const before = await readPrompt(deps.orca, record.terminalHandle);
  if (before.kind !== 'ok') return before.outcome;
  if (before.screen.status !== 'running') {
    return { kind: 'refused', reason: 'terminal_not_running' };
  }
  if (before.prompt.fingerprint !== record.fingerprint) {
    // 카드를 그린 뒤 프롬프트가 바뀌었다. 이 답은 지금 화면의 질문에 대한 답이 아니다.
    return { kind: 'refused', reason: 'screen_changed' };
  }

  const chosen = before.prompt.options.find((option) => option.index === target);
  if (chosen === undefined) return { kind: 'refused', reason: 'unknown_option' };
  // 카드가 버튼을 만들지 않는 항목이다. 옛 카드나 재전송으로 도달할 수 있으므로 여기서도 막는다.
  if (isFreeTextAffordance(chosen.label)) {
    return { kind: 'refused', reason: 'free_text_option' };
  }

  const delta = cursorDelta(before.prompt, target);
  if (delta === null) return { kind: 'refused', reason: 'unknown_option' };
  if (Math.abs(delta) > MAX_STEPS) return { kind: 'refused', reason: 'cursor_too_far' };

  if (delta !== 0) {
    const key = delta > 0 ? KEY_DOWN : KEY_UP;
    const moved = await sendTerminalInput(deps.orca, record.terminalHandle, {
      text: key.repeat(Math.abs(delta)),
    });
    if (!moved) return { kind: 'failed', reason: 'move_rejected' };
    await deps.settle();

    const after = await readPrompt(deps.orca, record.terminalHandle);
    if (after.kind !== 'ok') return after.outcome;
    // 지문이 유지되어야 같은 질문이고, 커서가 목표에 있어야 Enter가 그 선택지를 고른다.
    if (after.prompt.fingerprint !== record.fingerprint) {
      return { kind: 'refused', reason: 'screen_changed_after_move' };
    }
    if (after.prompt.cursorIndex !== target) {
      return { kind: 'refused', reason: 'cursor_not_confirmed' };
    }
  }

  const committed = await sendTerminalInput(deps.orca, record.terminalHandle, { enter: true });
  if (!committed) return { kind: 'failed', reason: 'enter_rejected' };
  return { kind: 'answered' };
}

type ReadResult =
  | { readonly kind: 'ok'; readonly screen: TerminalScreen; readonly prompt: NonNullable<ReturnType<typeof parseTerminalPrompt>> }
  | { readonly kind: 'stop'; readonly outcome: TerminalAnswerOutcome };

async function readPrompt(orca: OrcaRunner, handle: string): Promise<ReadResult> {
  let screen: TerminalScreen | null;
  try {
    screen = await readTerminalScreen(orca, handle);
  } catch {
    // 화면 내용을 진단에 옮기지 않는다. 사용자 결정 본문이 그대로 있는 자리다.
    return { kind: 'stop', outcome: { kind: 'failed', reason: 'screen_read_failed' } };
  }
  if (screen === null) return { kind: 'stop', outcome: { kind: 'refused', reason: 'screen_unreadable' } };
  const prompt = parseTerminalPrompt(screen.rows);
  if (prompt === null) {
    // 프롬프트가 사라졌다. 사람이 터미널에서 직접 답했을 때가 대부분이다.
    return { kind: 'stop', outcome: { kind: 'refused', reason: 'prompt_gone' } };
  }
  return { kind: 'ok', screen, prompt };
}
