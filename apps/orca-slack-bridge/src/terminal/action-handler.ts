import type { SlackConfig } from '../project/config.js';
import type { SocketSlackEvent } from '../slack/socket.js';
import { isPromptActionId, parsePromptActionValue } from './actions.js';
import type { TerminalPromptClaim } from './types.js';

/**
 * 터미널 프롬프트 버튼 한 번을 durable하게 확정한다.
 *
 * ## 여기서 터미널에 쓰지 않는 이유
 *
 * Slack은 3초 안에 ACK를 요구한다. 실제 전송은 화면 읽기 → 이동 → 재확인 → Enter로 Orca를 네
 * 번 부르고, 그 사이 TUI가 다시 그려지기를 기다린다. 3초 안에 끝난다는 보장이 없다.
 *
 * 그래서 클릭은 "이 선택을 확정한다"까지만 하고, 전송은 daemon job이 한다. Gate 해결이 outbox를
 * 쓰는 것과 같은 이유이고 같은 모양이다.
 */

export type TerminalPromptClaimStore = {
  claimTerminalPromptAnswer(input: {
    readonly handle: string;
    readonly fingerprint: string;
    readonly optionIndex: number;
    readonly owner: string;
    readonly at: string;
  }): TerminalPromptClaim;
};

export type TerminalPromptActionHandlerOptions = {
  readonly config: SlackConfig;
  readonly store: TerminalPromptClaimStore;
  readonly now?: () => Date;
  /** 확정 직후 다음 pass를 앞당긴다. 없으면 다음 정기 pass가 처리한다. */
  readonly wake?: () => void;
  readonly onOutcome?: (outcome: string) => void;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, cap: number): string | null {
  return typeof value === 'string' && value !== '' && value.length <= cap ? value : null;
}

/** 이 이벤트가 터미널 프롬프트 버튼인지. 다른 표면의 클릭을 가져오지 않는다. */
export function isTerminalPromptEvent(event: SocketSlackEvent): boolean {
  const root = record(event.body);
  if (root === null || root['type'] !== 'block_actions') return false;
  const actions = root['actions'];
  if (!Array.isArray(actions) || actions.length !== 1) return false;
  const action = record(actions[0]);
  const actionId = action === null ? null : action['action_id'];
  return typeof actionId === 'string' && isPromptActionId(actionId);
}

export class TerminalPromptActionHandler {
  private readonly now: () => Date;

  constructor(private readonly options: TerminalPromptActionHandlerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async handle(event: SocketSlackEvent): Promise<void> {
    const outcome = this.claim(event);
    this.options.onOutcome?.(outcome);
    // ACK는 판정과 무관하게 한 번 한다. ACK하지 않으면 Slack이 같은 클릭을 재전송하고, 재전송은
    // 이미 확정된 선택을 다시 확정하려 한다.
    await event.ack();
    if (outcome === 'claimed') this.options.wake?.();
  }

  private claim(event: SocketSlackEvent): string {
    const root = record(event.body);
    if (root === null || root['type'] !== 'block_actions') return 'not_block_actions';

    // team/app identity는 Gate 경로와 같은 기준으로 본다. 다른 워크스페이스의 클릭을 받지 않는다.
    const team = record(root['team']);
    const teamId = team === null ? null : text(team['id'], 40);
    if (teamId === null || teamId !== this.options.config.teamId) return 'team_mismatch';
    const apiAppId = text(root['api_app_id'], 40);
    if (this.options.config.apiAppId !== undefined && apiAppId !== this.options.config.apiAppId) {
      return 'app_mismatch';
    }

    const user = record(root['user']);
    const owner = user === null ? null : text(user['id'], 40);
    if (owner === null) return 'missing_user';

    const actions = root['actions'];
    if (!Array.isArray(actions) || actions.length !== 1) return 'ambiguous_actions';
    const action = record(actions[0]);
    if (action === null || action['type'] !== 'button') return 'unsupported_action_type';
    const actionId = text(action['action_id'], 255);
    const actionValue = text(action['value'], 255);
    if (actionId === null || actionValue === null || !isPromptActionId(actionId)) {
      return 'unknown_action';
    }
    const parsed = parsePromptActionValue(actionValue);
    if (parsed === null) return 'unparsable_value';

    try {
      const claim = this.options.store.claimTerminalPromptAnswer({
        handle: parsed.handle,
        fingerprint: parsed.fingerprint,
        optionIndex: parsed.optionIndex,
        owner,
        at: this.now().toISOString(),
      });
      // `stale`은 고장이 아니다. 카드를 그린 뒤 화면이 바뀌었거나 누군가 먼저 답한 것이고,
      // 그때 보내지 않는 것이 이 기능의 안전성이다.
      return claim.kind === 'stale' ? `stale_${claim.reason}` : claim.kind;
    } catch {
      return 'claim_failed';
    }
  }
}
