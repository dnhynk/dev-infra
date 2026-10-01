import { randomUUID } from 'node:crypto';
import type { GateKey } from '../identity/keys.js';
import type { SlackConfig } from '../project/config.js';
import type { GateStore } from '../store/schema.js';
import type { SocketSlackEvent } from '../slack/socket.js';
import type { GateResolutionEngine } from './resolve.js';
import type { GateResolutionIntent } from './resolution-types.js';

export type SlackSocketEvent = SocketSlackEvent;

export type GateActionFault = 'before_local_cas' | 'after_local_cas_before_ack';

export type GateActionHandlerOptions = {
  readonly config: SlackConfig;
  readonly store: GateStore;
  readonly engine: Pick<GateResolutionEngine, 'resolveAndProject'>;
  readonly now?: () => Date;
  readonly monotonic?: () => number;
  readonly requestId?: () => string;
  readonly schedule?: (job: () => Promise<void>) => void;
  readonly fault?: (point: GateActionFault) => void;
  /** Daemon shutdown aborts only local SQLITE_BUSY sleeps; the one Slack ACK is still attempted. */
  readonly abortSignal?: AbortSignal;
  /** Test seams may shorten, but never extend, Slack's production three-second ingress budget. */
  readonly localCasDeadlineMs?: number;
  readonly slackAckDeadlineMs?: number;
  readonly sqliteBusyRetryMs?: number;
};

export type GateActionOutcome =
  | 'claimed'
  | 'duplicate'
  | 'lost'
  | 'rejected'
  | 'ignored'
  | 'store_failed'
  | 'ack_failed';

const LOCAL_CAS_START_DEADLINE_MS = 2_000;
const SLACK_ACK_DEADLINE_MS = 3_000;
const SQLITE_BUSY_RETRY_MS = 10;
const MAX_SQLITE_BUSY_RETRIES = 512;

type StoreRetryStop = 'deadline' | 'aborted' | 'clock_failed' | 'attempt_limit';

type AckPersistence =
  | { readonly intent: GateResolutionIntent; readonly reason: null }
  | { readonly intent: null; readonly reason: string };

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

function abortableDelay(delayMs: number, signal: AbortSignal | undefined): Promise<boolean> {
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
    const timer = setTimeout(() => finish(true), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type ParsedAction = {
  readonly teamId: string;
  readonly ownerUserId: string;
  readonly apiAppId: string | null;
  readonly channelId: string;
  readonly threadTs: string;
  readonly messageTs: string;
  readonly blockId: string;
  readonly actionId: string;
  readonly actionValue: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function boundedText(value: unknown, cap: number): string | null {
  const parsed = text(value);
  return parsed !== null && parsed.length <= cap ? parsed : null;
}

function parseAction(body: unknown): { readonly value: ParsedAction } | { readonly reason: string } {
  const root = record(body);
  if (root === null || root['type'] !== 'block_actions') return { reason: 'not_block_actions' };
  const allowedRootKeys = new Set([
    'type', 'api_app_id', 'team', 'user', 'container', 'trigger_id', 'channel', 'message',
    'response_url', 'actions', 'state', 'enterprise', 'is_enterprise_install', 'token', 'hash',
  ]);
  if (Object.keys(root).some((key) => !allowedRootKeys.has(key))) {
    return { reason: 'unknown_payload_field' };
  }
  if (root['state'] !== undefined) {
    const state = record(root['state']);
    const values = state === null ? null : record(state['values']);
    if (
      state === null ||
      Object.keys(state).length !== 1 ||
      values === null ||
      Object.keys(values).length !== 0
    ) {
      return { reason: 'unsupported_input_state' };
    }
  }
  const team = record(root['team']);
  const user = record(root['user']);
  const container = record(root['container']);
  const channel = record(root['channel']);
  const message = record(root['message']);
  const actions = root['actions'];
  if (team === null || user === null || container === null || channel === null || message === null) {
    return { reason: 'missing_identity_object' };
  }
  if (!Array.isArray(actions) || actions.length !== 1) return { reason: 'ambiguous_actions' };
  const action = record(actions[0]);
  if (action === null || action['type'] !== 'button') return { reason: 'unsupported_action_type' };
  const allowedActionKeys = new Set([
    'action_id', 'block_id', 'text', 'type', 'value', 'action_ts', 'style', 'confirm',
  ]);
  if (Object.keys(action).some((key) => !allowedActionKeys.has(key))) {
    return { reason: 'unknown_action_field' };
  }
  const teamId = boundedText(team['id'], 32);
  const userId = boundedText(user['id'], 32);
  const userTeamId = user['team_id'] === undefined ? null : boundedText(user['team_id'], 32);
  const apiAppId = root['api_app_id'] === undefined ? null : boundedText(root['api_app_id'], 32);
  if (root['api_app_id'] !== undefined && apiAppId === null) {
    return { reason: 'invalid_api_app_id' };
  }
  const channelId = boundedText(channel['id'], 32);
  const containerChannelId = boundedText(container['channel_id'], 32);
  const containerMessageTs = boundedText(container['message_ts'], 32);
  const containerThreadTs =
    container['thread_ts'] === undefined ? null : boundedText(container['thread_ts'], 32);
  const messageTs = boundedText(message['ts'], 32);
  /*
   * 최상위 메시지에는 `thread_ts`가 없다.
   *
   * Slack에서 최상위 메시지는 **자기 자신이 스레드 루트**다. 그래서 그 자리를 자기 ts로
   * 채운다. 카드 매핑을 저장할 때 쓴 규약과 같은 규약이고, 그래야 claim의 신원 비교가
   * 맞는다. 이 처리가 없으면 답할 카드 채널에 최상위로 놓은 Gate의 버튼이 전부
   * `missing_identity_value`로 거절된다 — 실제로 그렇게 됐다.
   *
   * 필드가 **있는데** 형식이 어긋나는 것은 여전히 거절이다. 없는 것과 잘못된 것은 다르다.
   */
  const messageThreadProvided = message['thread_ts'] !== undefined;
  const parsedMessageThreadTs = messageThreadProvided
    ? boundedText(message['thread_ts'], 32)
    : null;
  const blockId = boundedText(action['block_id'], 255);
  const actionId = boundedText(action['action_id'], 255);
  const actionValue = boundedText(action['value'], 64);
  if (
    teamId === null || userId === null || channelId === null ||
    containerChannelId === null || containerMessageTs === null ||
    messageTs === null || (messageThreadProvided && parsedMessageThreadTs === null) ||
    blockId === null || actionId === null || actionValue === null
  ) {
    return { reason: 'missing_identity_value' };
  }
  if (user['team_id'] !== undefined && (userTeamId === null || userTeamId !== teamId)) {
    return { reason: 'user_team_mismatch' };
  }
  const messageThreadTs = parsedMessageThreadTs ?? messageTs;
  if (
    container['type'] !== 'message' ||
    container['is_ephemeral'] !== false ||
    channelId !== containerChannelId ||
    messageTs !== containerMessageTs ||
    (containerThreadTs !== null && messageThreadTs !== containerThreadTs)
  ) {
    return { reason: 'container_identity_mismatch' };
  }
  return {
    value: {
      teamId,
      ownerUserId: userId,
      apiAppId,
      channelId,
      threadTs: messageThreadTs,
      messageTs,
      blockId,
      actionId,
      actionValue,
    },
  };
}

/** ACK-once fixed-option consumer. Every remote operation is scheduled strictly after ACK success. */
/**
 * Gate 카드가 놓일 수 있는 채널인가.
 *
 * 답할 카드는 `decisions` 채널로 옮겼지만, 그 전에 만들어진 카드는 `agentRuns`에 남아 있다.
 * 한 쪽만 인정하면 다른 쪽 카드의 버튼이 전부 거절된다 — 실제로 옮긴 직후 `channel_mismatch`로
 * 그렇게 됐다.
 *
 * **아무 채널이나 받는 것이 아니다.** 설정에 있는 두 채널만 인정한다. 그 밖의 채널에서 온
 * 클릭은 우리가 카드를 놓은 적이 없는 자리이므로 여전히 거절이다.
 */
function isGateCardChannel(config: SlackConfig, channelId: string): boolean {
  return channelId === config.channels.agentRuns || channelId === config.channels.decisions;
}

export class GateActionHandler {
  private readonly now: () => Date;
  private readonly monotonic: () => number;
  private readonly requestId: () => string;
  private readonly schedule: (job: () => Promise<void>) => void;
  private readonly localCasDeadlineMs: number;
  private readonly slackAckDeadlineMs: number;
  private readonly sqliteBusyRetryMs: number;

  constructor(private readonly options: GateActionHandlerOptions) {
    this.now = options.now ?? (() => new Date());
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.requestId = options.requestId ?? randomUUID;
    this.slackAckDeadlineMs = boundedTiming(
      options.slackAckDeadlineMs,
      SLACK_ACK_DEADLINE_MS,
      10,
      SLACK_ACK_DEADLINE_MS,
      'slackAckDeadlineMs',
    );
    this.localCasDeadlineMs = boundedTiming(
      options.localCasDeadlineMs,
      LOCAL_CAS_START_DEADLINE_MS,
      1,
      this.slackAckDeadlineMs - 1,
      'localCasDeadlineMs',
    );
    this.sqliteBusyRetryMs = boundedTiming(
      options.sqliteBusyRetryMs,
      SQLITE_BUSY_RETRY_MS,
      1,
      this.localCasDeadlineMs,
      'sqliteBusyRetryMs',
    );
    this.schedule =
      options.schedule ??
      ((job) => {
        queueMicrotask(() => void job().catch(() => undefined));
      });
  }

  async handle(event: SlackSocketEvent): Promise<GateActionOutcome> {
    let started: number | null = null;
    const hardStarted = performance.now();
    const elapsedSinceIngress = (): number | null => {
      if (started === null) return null;
      try {
        const elapsed = this.monotonic() - started;
        const hardElapsed = performance.now() - hardStarted;
        return Number.isFinite(elapsed) && elapsed >= 0 && Number.isFinite(hardElapsed)
          ? Math.max(elapsed, hardElapsed)
          : null;
      } catch {
        return null;
      }
    };
    let acknowledged = false;
    const ack = async (): Promise<boolean> => {
      if (acknowledged) return true;
      acknowledged = true;
      const beforeAckElapsed = elapsedSinceIngress();
      const timeoutMs =
        beforeAckElapsed === null ? 0 : Math.max(0, this.slackAckDeadlineMs - beforeAckElapsed);
      let result: void | Promise<void>;
      try {
        result = event.ack();
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
        const timer = setTimeout(() => finish(false), Math.trunc(timeoutMs));
        Promise.resolve(result).then(
          () => {
            const completedElapsed = elapsedSinceIngress();
            finish(completedElapsed !== null && completedElapsed < this.slackAckDeadlineMs);
          },
          () => finish(false),
        );
      });
    };
    try {
      started = this.monotonic();
      if (!Number.isFinite(started)) throw new TypeError('non-finite monotonic start');
    } catch {
      return (await ack()) ? 'store_failed' : 'ack_failed';
    }

    // @slack/socket-mode exposes the Socket envelope type (`interactive`) separately from
    // `body.type` (`block_actions`). Both must match the one supported D2-C ingress.
    if (event.type !== 'interactive') {
      return (await ack()) ? 'ignored' : 'ack_failed';
    }
    const parsed = parseAction(event.body);
    if ('reason' in parsed) {
      const acked = await ack();
      this.audit(null, 'rejected', parsed.reason);
      return acked ? 'rejected' : 'ack_failed';
    }
    const action = parsed.value;
    const identityReason =
      action.teamId !== this.options.config.teamId
        ? 'team_mismatch'
        : !this.options.config.ownerUserIds.includes(action.ownerUserId)
          ? 'unauthorized_owner'
          : this.options.config.apiAppId !== undefined &&
              action.apiAppId !== this.options.config.apiAppId
            ? 'api_app_mismatch'
            : !isGateCardChannel(this.options.config, action.channelId)
              ? 'channel_mismatch'
              : null;
    if (identityReason !== null) {
      const acked = await ack();
      this.audit(null, 'rejected', identityReason);
      return acked ? 'rejected' : 'ack_failed';
    }
    // Leave enough room for the synchronous SQLite transaction and the ACK call itself. No remote
    // read is attempted to rescue a request that reached this local deadline.
    let elapsed: number;
    try {
      elapsed = this.monotonic() - started;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new TypeError('invalid monotonic elapsed');
    } catch {
      return (await ack()) ? 'store_failed' : 'ack_failed';
    }
    if (elapsed >= this.localCasDeadlineMs) {
      const acked = await ack();
      this.audit(null, 'rejected', 'local_deadline_exceeded');
      return acked ? 'rejected' : 'ack_failed';
    }

    if (this.options.abortSignal?.aborted) {
      const acked = await ack();
      this.audit(null, 'store_failed', 'ingress_aborted');
      return acked ? 'store_failed' : 'ack_failed';
    }

    let claimed: ReturnType<GateStore['claimGateResolution']> | null = null;
    try {
      this.options.fault?.('before_local_cas');
      const retryRequestId = this.requestId();
      let busyAttempts = 0;
      for (;;) {
        try {
          claimed = this.options.store.claimGateResolution({
            ...action,
            retryRequestId,
            at: this.now().toISOString(),
          });
          break;
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
          busyAttempts += 1;
          const stopped = await this.waitForSqliteBusy(
            this.localCasDeadlineMs,
            busyAttempts,
            elapsedSinceIngress,
          );
          if (stopped !== null) {
            const acked = await ack();
            this.audit(null, 'store_failed', `claim_sqlite_busy_${stopped}`);
            return acked ? 'store_failed' : 'ack_failed';
          }
        }
      }
      this.options.fault?.('after_local_cas_before_ack');
    } catch {
      const acked = await ack();
      // TypeScript does not carry a loop assignment into a catch even though the injected
      // after-CAS fault can run only after `claimed` was assigned.
      const faultClaim = claimed as ReturnType<GateStore['claimGateResolution']> | null;
      if (faultClaim?.kind === 'claimed' || faultClaim?.kind === 'duplicate') {
        const persisted = await this.persistAck(
          faultClaim.intent,
          acked ? 'acked' : 'failed',
          elapsedSinceIngress,
        );
        if (persisted.intent === null) {
          this.audit(faultClaim.intent.gateKey, 'store_failed', persisted.reason);
        }
      }
      return acked ? 'store_failed' : 'ack_failed';
    }
    let postCasElapsed: number | null = null;
    try {
      postCasElapsed = this.monotonic() - started;
      if (!Number.isFinite(postCasElapsed) || postCasElapsed < 0) postCasElapsed = null;
    } catch {
      // ACK immediately. A clock failure cannot authorize either remote boundary.
    }
    const acked = await ack();
    if (!acked) {
      if (claimed.kind === 'claimed' || claimed.kind === 'duplicate') {
        const persisted = await this.persistAck(claimed.intent, 'failed', elapsedSinceIngress);
        if (persisted.intent === null) {
          this.audit(claimed.intent.gateKey, 'store_failed', persisted.reason);
        }
      }
      return 'ack_failed';
    }
    let afterAckElapsed: number | null = null;
    if (postCasElapsed !== null) {
      try {
        afterAckElapsed = this.monotonic() - started;
        if (!Number.isFinite(afterAckElapsed) || afterAckElapsed < 0) afterAckElapsed = null;
      } catch {
        afterAckElapsed = null;
      }
    }
    const deadlineFailure =
      postCasElapsed === null || afterAckElapsed === null
        ? 'post_cas_clock_failed'
        : afterAckElapsed >= this.slackAckDeadlineMs
          ? 'post_cas_ack_deadline_miss'
          : null;
    if (deadlineFailure !== null) {
      this.audit(
        claimed.kind === 'claimed' || claimed.kind === 'duplicate'
          ? claimed.intent.gateKey
          : null,
        'deadline',
        deadlineFailure,
      );
      if (claimed.kind === 'claimed' || claimed.kind === 'duplicate') {
        const persisted = await this.persistAck(claimed.intent, 'failed', elapsedSinceIngress);
        if (persisted.intent === null) {
          this.audit(claimed.intent.gateKey, 'store_failed', persisted.reason);
        }
      }
      return 'rejected';
    }
    if (claimed.kind === 'claimed' || claimed.kind === 'duplicate') {
      const persisted = await this.persistAck(claimed.intent, 'acked', elapsedSinceIngress);
      const ready = persisted.intent;
      if (ready === null || ready.ackState !== 'acked') {
        this.audit(claimed.intent.gateKey, 'store_failed', persisted.reason ?? 'ack_not_durable');
        return 'store_failed';
      }
      const gateKey: GateKey = ready.gateKey;
      this.schedule(() => this.options.engine.resolveAndProject(gateKey));
    }
    return claimed.kind;
  }

  private audit(gateKey: GateKey | null, event: string, reason: string): void {
    try {
      this.options.store.recordGateAudit(gateKey, event, reason, this.now().toISOString());
    } catch {
      // Audit storage failure must not consume Slack's ACK deadline or trigger a remote fallback.
    }
  }

  private async waitForSqliteBusy(
    deadlineMs: number,
    busyAttempts: number,
    elapsedSinceIngress: () => number | null,
  ): Promise<StoreRetryStop | null> {
    if (busyAttempts >= MAX_SQLITE_BUSY_RETRIES) return 'attempt_limit';
    if (this.options.abortSignal?.aborted) return 'aborted';
    const elapsed = elapsedSinceIngress();
    if (elapsed === null) return 'clock_failed';
    const remaining = deadlineMs - elapsed;
    if (remaining <= 0) return 'deadline';
    const slept = await abortableDelay(
      Math.max(1, Math.min(this.sqliteBusyRetryMs, Math.trunc(remaining))),
      this.options.abortSignal,
    );
    if (!slept) return 'aborted';
    const afterSleep = elapsedSinceIngress();
    if (afterSleep === null) return 'clock_failed';
    return afterSleep < deadlineMs ? null : 'deadline';
  }

  private async persistAck(
    initial: GateResolutionIntent,
    ackState: 'acked' | 'failed',
    elapsedSinceIngress: () => number | null,
  ): Promise<AckPersistence> {
    let current = initial;
    let revisionAttempts = 0;
    let busyAttempts = 0;
    while (revisionAttempts < 8) {
      // ACK success is terminal-dominant: a later failing duplicate may never downgrade it.
      if (current.ackState === 'acked') return { intent: current, reason: null };
      if (ackState === 'failed' && current.ackState === 'failed') {
        return { intent: current, reason: null };
      }
      try {
        const updated = this.options.store.markGateResolutionAck(
          current.gateKey,
          current.revision,
          ackState,
          this.now().toISOString(),
        );
        if (updated !== null) return { intent: updated, reason: null };
        const latest = this.options.store.findGateResolution(current.gateKey);
        if (latest === null) return { intent: null, reason: 'ack_intent_missing' };
        current = latest;
        revisionAttempts += 1;
      } catch (error) {
        if (!isSqliteBusy(error)) return { intent: null, reason: 'ack_store_error' };
        busyAttempts += 1;
        const stopped = await this.waitForSqliteBusy(
          this.slackAckDeadlineMs,
          busyAttempts,
          elapsedSinceIngress,
        );
        if (stopped !== null) {
          return { intent: null, reason: `ack_sqlite_busy_${stopped}` };
        }
      }
    }
    return { intent: null, reason: 'ack_revision_exhausted' };
  }
}
