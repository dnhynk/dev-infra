import { createHash, randomUUID } from 'node:crypto';
import type { GateKey } from '../identity/keys.js';
import type { SlackConfig } from '../project/config.js';
import {
  SlackViewOpenError,
  type SlackModalView,
  type SlackViewOpener,
} from '../slack/views.js';
import type { GateStore } from '../store/schema.js';
import type { SocketSlackEvent } from '../slack/socket.js';
import type { GateResolutionEngine } from './resolve.js';
import {
  isGateDirectActionId,
  isGateDirectCallbackId,
} from './actions.js';
import type { GateResolutionIntent } from './resolution-types.js';
import type { GateDirectModalSession } from './direct-input-types.js';

const SLACK_INGRESS_DEADLINE_MS = 3_000;
const LOCAL_STORE_DEADLINE_MS = 1_750;
const SQLITE_BUSY_RETRY_MS = 10;
const MAX_SQLITE_BUSY_RETRIES = 512;
const RESOLUTION_CAP = 3_000;
const INPUT_ERROR = '1~3000자의 유효한 결정 내용을 입력하세요.';

export type GateDirectInputOutcome =
  | 'modal_opened'
  | 'claimed'
  | 'duplicate'
  | 'lost'
  | 'rejected'
  | 'ignored'
  | 'store_failed'
  | 'ack_failed'
  | 'open_failed';

export type GateDirectInputFault =
  | 'after_modal_prepare_before_ack'
  | 'after_button_ack_before_open_edge'
  | 'after_open_edge_before_api'
  | 'after_open_response_before_persist'
  | 'after_submission_claim_before_ack'
  | 'after_submission_ack_before_persist'
  | 'after_submission_ack_persist_before_schedule';

export type GateDirectInputHandlerOptions = {
  readonly config: SlackConfig;
  readonly store: GateStore;
  readonly opener: SlackViewOpener;
  readonly engine: Pick<GateResolutionEngine, 'resolveAndProject'>;
  readonly now?: () => Date;
  readonly monotonic?: () => number;
  readonly requestId?: () => string;
  readonly sessionId?: () => string;
  readonly schedule?: (job: () => Promise<void>) => void;
  readonly fault?: (point: GateDirectInputFault) => void | Promise<void>;
  readonly abortSignal?: AbortSignal;
  readonly ingressDeadlineMs?: number;
  readonly localStoreDeadlineMs?: number;
  readonly sqliteBusyRetryMs?: number;
};

type ParsedButton = {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly actionValue: string;
  readonly actionTs: string;
  readonly triggerId: string;
};

type ParsedSubmissionIdentity = {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string;
  readonly viewId: string;
  readonly viewTeamId: string;
  readonly viewAppId: string;
  readonly callbackId: string;
  readonly privateMetadata: string;
  readonly state: unknown;
};

type Budget = {
  readonly elapsed: () => number | null;
  readonly remaining: () => number;
};

type Ack = (response?: unknown) => Promise<boolean>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function boundedText(value: unknown, cap: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= cap ? value : null;
}

function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const sqlite = error as { readonly code?: unknown; readonly errcode?: unknown };
  return sqlite.code === 'ERR_SQLITE_ERROR' && sqlite.errcode === 5;
}

function boundedTiming(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} must be a finite number between ${minimum} and ${maximum}`);
  }
  return Math.trunc(candidate);
}

function delay(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(completed);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function budgetFor(monotonic: () => number, deadlineMs: number): Budget {
  let start: number | null = null;
  try {
    const candidate = monotonic();
    if (Number.isFinite(candidate)) start = candidate;
  } catch {
    // The independent hard monotonic clock still keeps the one ACK attempt bounded.
  }
  const hardStart = performance.now();
  const elapsed = (): number | null => {
    try {
      const hard = performance.now() - hardStart;
      if (!Number.isFinite(hard) || hard < 0) return null;
      if (start === null) return hard;
      const injected = monotonic() - start;
      return Number.isFinite(injected) && injected >= 0 ? Math.max(injected, hard) : hard;
    } catch {
      const hard = performance.now() - hardStart;
      return Number.isFinite(hard) && hard >= 0 ? hard : null;
    }
  };
  return {
    elapsed,
    remaining: () => {
      const spent = elapsed();
      return spent === null ? 0 : Math.max(0, Math.trunc(deadlineMs - spent));
    },
  };
}

function ackOnce(event: SocketSlackEvent, budget: Budget, deadlineMs: number): Ack {
  let attempted = false;
  return async (response?: unknown): Promise<boolean> => {
    if (attempted) return false;
    attempted = true;
    const remaining = budget.remaining();
    let operation: void | Promise<void>;
    try {
      operation = event.ack(response);
    } catch {
      return false;
    }
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, remaining));
      Promise.resolve(operation).then(
        () => {
          const elapsed = budget.elapsed();
          finish(elapsed !== null && elapsed < deadlineMs);
        },
        () => finish(false),
      );
    });
  };
}

function parseButton(body: unknown): ParsedButton | null {
  const root = record(body);
  if (root === null || root['type'] !== 'block_actions') return null;
  const allowedRoot = new Set([
    'type', 'api_app_id', 'team', 'user', 'container', 'trigger_id', 'channel', 'message',
    'response_url', 'actions', 'state', 'enterprise', 'is_enterprise_install', 'token', 'hash',
  ]);
  if (Object.keys(root).some((key) => !allowedRoot.has(key))) return null;
  if (root['state'] !== undefined) {
    const state = record(root['state']);
    const values = state === null ? null : record(state['values']);
    if (state === null || Object.keys(state).length !== 1 || values === null || Object.keys(values).length !== 0) {
      return null;
    }
  }
  const team = record(root['team']);
  const user = record(root['user']);
  const container = record(root['container']);
  const channel = record(root['channel']);
  const message = record(root['message']);
  const actions = root['actions'];
  if (
    team === null || user === null || container === null || channel === null || message === null ||
    !Array.isArray(actions) || actions.length !== 1
  ) return null;
  const action = record(actions[0]);
  if (action === null || action['type'] !== 'button') return null;
  const allowedAction = new Set([
    'action_id', 'block_id', 'text', 'type', 'value', 'action_ts', 'style', 'confirm',
  ]);
  if (Object.keys(action).some((key) => !allowedAction.has(key))) return null;
  const teamId = boundedText(team['id'], 32);
  const ownerUserId = boundedText(user['id'], 32);
  const userTeamId = user['team_id'] === undefined ? teamId : boundedText(user['team_id'], 32);
  const apiAppId = boundedText(root['api_app_id'], 32);
  const channelId = boundedText(channel['id'], 32);
  const containerChannelId = boundedText(container['channel_id'], 32);
  const containerMessageTs = boundedText(container['message_ts'], 32);
  const containerThreadTs = container['thread_ts'] === undefined
    ? null
    : boundedText(container['thread_ts'], 32);
  const messageTs = boundedText(message['ts'], 32);
  /*
   * 최상위 메시지에는 `thread_ts`가 없다. 그 메시지가 곧 스레드 루트이므로 자기 ts로 채운다.
   * 카드 매핑을 저장할 때 쓴 규약과 같아야 신원 비교가 맞는다(`action-handler.ts` 주석 참고).
   *
   * 필드가 있는데 형식이 어긋나는 것은 여전히 거절이다.
   */
  const threadProvided = message['thread_ts'] !== undefined;
  const parsedThreadTs = threadProvided ? boundedText(message['thread_ts'], 32) : null;
  const threadTs = parsedThreadTs ?? messageTs;
  const blockId = boundedText(action['block_id'], 255);
  const actionId = boundedText(action['action_id'], 255);
  const actionValue = boundedText(action['value'], 255);
  const actionTs = boundedText(action['action_ts'], 32);
  const triggerId = boundedText(root['trigger_id'], 255);
  if (
    teamId === null || ownerUserId === null || userTeamId !== teamId || apiAppId === null ||
    channelId === null || containerChannelId !== channelId || containerMessageTs === null ||
    messageTs !== containerMessageTs || (threadProvided && parsedThreadTs === null) ||
    threadTs === null || blockId === null || actionId === null ||
    actionValue === null || actionTs === null || triggerId === null ||
    container['type'] !== 'message' || container['is_ephemeral'] !== false ||
    (containerThreadTs !== null && containerThreadTs !== threadTs)
  ) return null;
  return {
    teamId,
    ownerUserId,
    apiAppId,
    channelId,
    threadTs,
    messageTs,
    blockId,
    actionId,
    actionValue,
    actionTs,
    triggerId,
  };
}

function parseSubmissionIdentity(body: unknown): ParsedSubmissionIdentity | null {
  const root = record(body);
  if (root === null || root['type'] !== 'view_submission') return null;
  const allowedRoot = new Set([
    'type', 'api_app_id', 'team', 'user', 'view', 'trigger_id', 'response_urls',
    'enterprise', 'is_enterprise_install', 'token',
  ]);
  if (Object.keys(root).some((key) => !allowedRoot.has(key))) return null;
  const team = record(root['team']);
  const user = record(root['user']);
  const view = record(root['view']);
  if (team === null || user === null || view === null) return null;
  const teamId = boundedText(team['id'], 32);
  const ownerUserId = boundedText(user['id'], 32);
  const userTeamId = user['team_id'] === undefined ? teamId : boundedText(user['team_id'], 32);
  const apiAppId = boundedText(root['api_app_id'], 32);
  const viewId = boundedText(view['id'], 64);
  const viewTeamId = boundedText(view['team_id'], 32);
  const viewAppId = boundedText(view['app_id'], 32);
  const callbackId = boundedText(view['callback_id'], 255);
  const privateMetadata = boundedText(view['private_metadata'], 64);
  if (
    view['type'] !== 'modal' || teamId === null || ownerUserId === null || userTeamId !== teamId ||
    apiAppId === null || viewId === null || viewTeamId === null || viewAppId === null ||
    callbackId === null || privateMetadata === null
  ) return null;
  return {
    teamId,
    ownerUserId,
    apiAppId,
    viewId,
    viewTeamId,
    viewAppId,
    callbackId,
    privateMetadata,
    state: view['state'],
  };
}

function directButtonEventKey(button: ParsedButton): string {
  return createHash('sha256').update([
    button.teamId,
    button.ownerUserId,
    button.apiAppId,
    button.channelId,
    button.threadTs,
    button.messageTs,
    button.blockId,
    button.actionId,
    button.actionValue,
    button.actionTs,
  ].join('\0'), 'utf8').digest('hex');
}

function modalView(session: GateDirectModalSession): SlackModalView {
  return {
    type: 'modal',
    callback_id: session.callbackId,
    private_metadata: session.sessionId,
    title: { type: 'plain_text', text: 'Gate 직접 결정', emoji: true },
    submit: { type: 'plain_text', text: '결정', emoji: true },
    close: { type: 'plain_text', text: '취소', emoji: true },
    blocks: [{
      type: 'input',
      block_id: session.inputBlockId,
      label: { type: 'plain_text', text: '결정 내용', emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: session.inputActionId,
        multiline: true,
        min_length: 1,
        max_length: RESOLUTION_CAP,
        focus_on_load: true,
      },
    }],
  };
}

function submittedText(
  stateValue: unknown,
  session: GateDirectModalSession,
): { readonly value: string } | { readonly error: string } {
  const state = record(stateValue);
  const values = state === null ? null : record(state['values']);
  const block = values === null ? null : record(values[session.inputBlockId]);
  const input = block === null ? null : record(block[session.inputActionId]);
  if (
    state === null || Object.keys(state).some((key) => key !== 'values') || values === null ||
    Object.keys(values).length !== 1 || block === null || Object.keys(block).length !== 1 ||
    input === null || Object.keys(input).some((key) => key !== 'type' && key !== 'value') ||
    input['type'] !== 'plain_text_input' || typeof input['value'] !== 'string'
  ) return { error: INPUT_ERROR };
  const value = input['value'];
  if (
    value.length === 0 || value.length > RESOLUTION_CAP || value.trim() === '' ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
  ) return { error: INPUT_ERROR };
  return { value };
}

/** Assign exactly one handler before either consumer attempts the Socket Mode ACK. */
export function isGateDirectInputEvent(event: SocketSlackEvent): boolean {
  if (event.type !== 'interactive') return false;
  const root = record(event.body);
  if (root?.['type'] === 'block_actions') {
    const actions = root['actions'];
    if (!Array.isArray(actions) || actions.length !== 1) return false;
    const action = record(actions[0]);
    return typeof action?.['action_id'] === 'string' && isGateDirectActionId(action['action_id']);
  }
  if (root?.['type'] === 'view_submission') {
    const view = record(root['view']);
    return typeof view?.['callback_id'] === 'string' && isGateDirectCallbackId(view['callback_id']);
  }
  return false;
}

/**
 * Gate 카드가 놓일 수 있는 채널인가.
 *
 * 답할 카드는 `decisions` 채널로 옮겼지만 그 전에 만들어진 카드는 `agentRuns`에 남아 있다.
 * 한 쪽만 인정하면 다른 쪽 카드의 버튼이 전부 거절된다 — 옮긴 직후 `channel_mismatch`로 실제로
 * 그렇게 됐다.
 *
 * **아무 채널이나 받는 것이 아니다.** 설정에 있는 두 채널만 인정한다. 그 밖의 채널에서 온
 * 클릭은 우리가 카드를 놓은 적이 없는 자리이므로 여전히 거절이다.
 */
function isGateCardChannel(config: SlackConfig, channelId: string): boolean {
  return channelId === config.channels.agentRuns || channelId === config.channels.decisions;
}

export class GateDirectInputHandler {
  private readonly now: () => Date;
  private readonly monotonic: () => number;
  private readonly requestId: () => string;
  private readonly sessionId: () => string;
  private readonly schedule: (job: () => Promise<void>) => void;
  private readonly ingressDeadlineMs: number;
  private readonly localStoreDeadlineMs: number;
  private readonly sqliteBusyRetryMs: number;

  constructor(private readonly options: GateDirectInputHandlerOptions) {
    this.now = options.now ?? (() => new Date());
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.requestId = options.requestId ?? randomUUID;
    this.sessionId = options.sessionId ?? randomUUID;
    this.ingressDeadlineMs = boundedTiming(
      options.ingressDeadlineMs,
      SLACK_INGRESS_DEADLINE_MS,
      10,
      SLACK_INGRESS_DEADLINE_MS,
      'ingressDeadlineMs',
    );
    this.localStoreDeadlineMs = boundedTiming(
      options.localStoreDeadlineMs,
      LOCAL_STORE_DEADLINE_MS,
      1,
      this.ingressDeadlineMs - 1,
      'localStoreDeadlineMs',
    );
    this.sqliteBusyRetryMs = boundedTiming(
      options.sqliteBusyRetryMs,
      SQLITE_BUSY_RETRY_MS,
      1,
      this.localStoreDeadlineMs,
      'sqliteBusyRetryMs',
    );
    this.schedule = options.schedule ?? ((job) => queueMicrotask(() => void job().catch(() => undefined)));
  }

  async handle(event: SocketSlackEvent): Promise<GateDirectInputOutcome> {
    const budget = budgetFor(this.monotonic, this.ingressDeadlineMs);
    const ack = ackOnce(event, budget, this.ingressDeadlineMs);
    if (event.type !== 'interactive') return (await ack()) ? 'ignored' : 'ack_failed';
    const root = record(event.body);
    if (root?.['type'] === 'block_actions') return await this.handleButton(event.body, ack, budget);
    if (root?.['type'] === 'view_submission') return await this.handleSubmission(event.body, ack, budget);
    return (await ack()) ? 'ignored' : 'ack_failed';
  }

  private async handleButton(
    body: unknown,
    ack: Ack,
    budget: Budget,
  ): Promise<GateDirectInputOutcome> {
    const button = parseButton(body);
    const configAppId = this.options.config.apiAppId;
    if (
      button === null || button.teamId !== this.options.config.teamId ||
      (configAppId !== undefined && button.apiAppId !== configAppId) ||
      !this.options.config.ownerUserIds.includes(button.ownerUserId) ||
      !isGateCardChannel(this.options.config, button.channelId)
    ) return (await ack()) ? 'rejected' : 'ack_failed';
    if (this.options.abortSignal?.aborted || (budget.elapsed() ?? Infinity) >= this.localStoreDeadlineMs) {
      return (await ack()) ? 'store_failed' : 'ack_failed';
    }
    let prepared;
    try {
      prepared = await this.retryStore(
        () => this.options.store.prepareGateDirectModal({
          sessionId: this.sessionId(),
          buttonEventKey: directButtonEventKey(button),
          teamId: button.teamId,
          ownerUserId: button.ownerUserId,
          apiAppId: button.apiAppId,
          channelId: button.channelId,
          threadTs: button.threadTs,
          messageTs: button.messageTs,
          blockId: button.blockId,
          actionId: button.actionId,
          actionValue: button.actionValue,
          at: this.now().toISOString(),
        }),
        budget,
      );
      if (prepared === null) return (await ack()) ? 'store_failed' : 'ack_failed';
    } catch {
      return (await ack()) ? 'store_failed' : 'ack_failed';
    }
    if (prepared.kind === 'rejected') return (await ack()) ? 'rejected' : 'ack_failed';
    // This injected boundary represents process death, so it intentionally sits outside the
    // recoverable store-error catch and leaves the prepared sidecar unACKed for Slack redelivery.
    await this.options.fault?.('after_modal_prepare_before_ack');
    const acked = await ack();
    if (!acked) return 'ack_failed';
    await this.options.fault?.('after_button_ack_before_open_edge');
    const opening = await this.retryStore(
      () => this.options.store.beginGateDirectModalOpen(
        prepared.session.sessionId,
        prepared.session.revision,
        this.now().toISOString(),
      ),
      budget,
    );
    if (opening === null) {
      const current = this.options.store.findGateDirectModal(prepared.session.sessionId);
      return current === null ? 'store_failed' : 'duplicate';
    }
    await this.options.fault?.('after_open_edge_before_api');
    const remaining = budget.remaining();
    if (remaining <= 0) {
      this.finishOpenFailure(opening, 'deadline_exceeded');
      return 'open_failed';
    }
    let opened;
    try {
      opened = await this.options.opener.open({
        triggerId: button.triggerId,
        view: modalView(opening),
        timeoutMs: remaining,
      });
    } catch (error) {
      const code = error instanceof SlackViewOpenError
        ? `view_${error.code}`
        : 'view_open_failed';
      this.finishOpenFailure(opening, code);
      return 'open_failed';
    }
    await this.options.fault?.('after_open_response_before_persist');
    let finished: GateDirectModalSession | null = null;
    try {
      finished = this.options.store.finishGateDirectModalOpen(
        opening.sessionId,
        opening.revision,
        {
          kind: 'opened',
          viewId: opened.id,
          teamId: opened.teamId,
          apiAppId: opened.appId,
          callbackId: opened.callbackId,
          privateMetadata: opened.privateMetadata,
        },
        this.now().toISOString(),
      );
    } catch {
      return 'store_failed';
    }
    return finished?.state === 'opened' ? 'modal_opened' : 'open_failed';
  }

  private async handleSubmission(
    body: unknown,
    ack: Ack,
    budget: Budget,
  ): Promise<GateDirectInputOutcome> {
    const parsed = parseSubmissionIdentity(body);
    const configAppId = this.options.config.apiAppId;
    if (
      parsed === null || parsed.teamId !== this.options.config.teamId ||
      (configAppId !== undefined && parsed.apiAppId !== configAppId) ||
      parsed.viewTeamId !== parsed.teamId ||
      parsed.viewAppId !== parsed.apiAppId ||
      !this.options.config.ownerUserIds.includes(parsed.ownerUserId)
    ) return (await ack()) ? 'rejected' : 'ack_failed';
    let session: GateDirectModalSession | null;
    try {
      session = this.options.store.findGateDirectModal(parsed.privateMetadata);
    } catch {
      return (await ack()) ? 'store_failed' : 'ack_failed';
    }
    if (
      session === null || session.state !== 'opened' ||
      !isGateCardChannel(this.options.config, session.channelId) ||
      session.teamId !== parsed.teamId ||
      session.ownerUserId !== parsed.ownerUserId || session.apiAppId !== parsed.apiAppId ||
      session.viewId !== parsed.viewId || session.callbackId !== parsed.callbackId
    ) {
      // An accepted exact redelivery is allowed through to the atomic winner comparison below.
      if (
        session === null || session.state !== 'accepted' ||
        !isGateCardChannel(this.options.config, session.channelId) ||
        session.teamId !== parsed.teamId ||
        session.ownerUserId !== parsed.ownerUserId || session.apiAppId !== parsed.apiAppId ||
        session.viewId !== parsed.viewId || session.callbackId !== parsed.callbackId
      ) return (await ack()) ? 'rejected' : 'ack_failed';
    }
    const resolution = submittedText(parsed.state, session);
    if ('error' in resolution) {
      return (await ack({
        response_action: 'errors',
        errors: { [session.inputBlockId]: resolution.error },
      })) ? 'rejected' : 'ack_failed';
    }
    if (this.options.abortSignal?.aborted || (budget.elapsed() ?? Infinity) >= this.localStoreDeadlineMs) {
      return (await ack()) ? 'store_failed' : 'ack_failed';
    }
    let claimed;
    try {
      claimed = await this.retryStore(
        () => this.options.store.claimGateDirectResolution({
          sessionId: session.sessionId,
          teamId: parsed.teamId,
          ownerUserId: parsed.ownerUserId,
          apiAppId: parsed.apiAppId,
          viewId: parsed.viewId,
          callbackId: parsed.callbackId,
          privateMetadata: parsed.privateMetadata,
          inputBlockId: session.inputBlockId,
          inputActionId: session.inputActionId,
          resolutionText: resolution.value,
          retryRequestId: this.requestId(),
          at: this.now().toISOString(),
        }),
        budget,
      );
      if (claimed === null) return (await ack()) ? 'store_failed' : 'ack_failed';
    } catch {
      return (await ack()) ? 'store_failed' : 'ack_failed';
    }
    if (claimed.kind === 'claimed' || claimed.kind === 'duplicate') {
      // Faults after the winner transaction model a process boundary: unlike a recoverable store
      // exception, a real crash cannot send an ACK or mutate the ACK fence on its way down.
      await this.options.fault?.('after_submission_claim_before_ack');
    }
    const acked = await ack();
    if (!acked) {
      if (claimed.kind === 'claimed' || claimed.kind === 'duplicate') {
        await this.persistAck(claimed.intent, 'failed', budget);
      }
      return 'ack_failed';
    }
    if (claimed.kind === 'claimed' || claimed.kind === 'duplicate') {
      // Slack ACK and the durable ack_state bit cannot be one atomic commit. This fault leaves the
      // winner pending and therefore quarantined until an exact Slack redelivery repairs it.
      await this.options.fault?.('after_submission_ack_before_persist');
      const ready = await this.persistAck(claimed.intent, 'acked', budget);
      if (ready === null || ready.ackState !== 'acked') return 'store_failed';
      // Once ack_state=acked is durable, the ordinary D2-C startup reconcile owns recovery.
      await this.options.fault?.('after_submission_ack_persist_before_schedule');
      const gateKey: GateKey = ready.gateKey;
      this.schedule(() => this.options.engine.resolveAndProject(gateKey));
    }
    return claimed.kind;
  }

  private finishOpenFailure(session: GateDirectModalSession, code: string): void {
    try {
      this.options.store.finishGateDirectModalOpen(
        session.sessionId,
        session.revision,
        { kind: 'failed', code },
        this.now().toISOString(),
      );
    } catch {
      // The opening state itself is fail-closed and never authorizes a submission.
    }
  }

  private async retryStore<T>(operation: () => T, budget: Budget): Promise<T | null> {
    let attempts = 0;
    for (;;) {
      try {
        return operation();
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        attempts += 1;
        const elapsed = budget.elapsed();
        if (
          attempts >= MAX_SQLITE_BUSY_RETRIES || elapsed === null ||
          elapsed >= this.localStoreDeadlineMs || this.options.abortSignal?.aborted
        ) return null;
        const slept = await delay(
          Math.max(1, Math.min(this.sqliteBusyRetryMs, this.localStoreDeadlineMs - elapsed)),
          this.options.abortSignal,
        );
        if (!slept) return null;
      }
    }
  }

  private async persistAck(
    initial: GateResolutionIntent,
    state: 'acked' | 'failed',
    budget: Budget,
  ): Promise<GateResolutionIntent | null> {
    let current = initial;
    for (let revision = 0; revision < 8; revision += 1) {
      if (current.ackState === 'acked') return current;
      if (state === 'failed' && current.ackState === 'failed') return current;
      const updated = await this.retryStore(
        () => this.options.store.markGateResolutionAck(
          current.gateKey,
          current.revision,
          state,
          this.now().toISOString(),
        ),
        budget,
      );
      if (updated !== null) return updated;
      try {
        const latest = this.options.store.findGateResolution(current.gateKey);
        if (latest === null) return null;
        current = latest;
      } catch {
        return null;
      }
    }
    return null;
  }
}
