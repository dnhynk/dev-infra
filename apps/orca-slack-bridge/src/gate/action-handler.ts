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
  const messageThreadTs = boundedText(message['thread_ts'], 32);
  const blockId = boundedText(action['block_id'], 255);
  const actionId = boundedText(action['action_id'], 255);
  const actionValue = boundedText(action['value'], 64);
  if (
    teamId === null || userId === null || channelId === null ||
    containerChannelId === null || containerMessageTs === null ||
    messageTs === null || messageThreadTs === null || blockId === null || actionId === null ||
    actionValue === null
  ) {
    return { reason: 'missing_identity_value' };
  }
  if (user['team_id'] !== undefined && (userTeamId === null || userTeamId !== teamId)) {
    return { reason: 'user_team_mismatch' };
  }
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
export class GateActionHandler {
  private readonly now: () => Date;
  private readonly monotonic: () => number;
  private readonly requestId: () => string;
  private readonly schedule: (job: () => Promise<void>) => void;

  constructor(private readonly options: GateActionHandlerOptions) {
    this.now = options.now ?? (() => new Date());
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.requestId = options.requestId ?? randomUUID;
    this.schedule =
      options.schedule ??
      ((job) => {
        queueMicrotask(() => void job().catch(() => undefined));
      });
  }

  async handle(event: SlackSocketEvent): Promise<GateActionOutcome> {
    let started: number | null = null;
    const elapsedSinceIngress = (): number | null => {
      if (started === null) return null;
      try {
        const elapsed = this.monotonic() - started;
        return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
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
        beforeAckElapsed === null ? 0 : Math.max(0, SLACK_ACK_DEADLINE_MS - beforeAckElapsed);
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
            finish(completedElapsed !== null && completedElapsed < SLACK_ACK_DEADLINE_MS);
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
            : action.channelId !== this.options.config.channels.agentRuns
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
    if (elapsed >= LOCAL_CAS_START_DEADLINE_MS) {
      const acked = await ack();
      this.audit(null, 'rejected', 'local_deadline_exceeded');
      return acked ? 'rejected' : 'ack_failed';
    }

    let claimed: ReturnType<GateStore['claimGateResolution']> | null = null;
    try {
      this.options.fault?.('before_local_cas');
      claimed = this.options.store.claimGateResolution({
        ...action,
        retryRequestId: this.requestId(),
        at: this.now().toISOString(),
      });
      this.options.fault?.('after_local_cas_before_ack');
    } catch {
      const acked = await ack();
      if (claimed?.kind === 'claimed' || claimed?.kind === 'duplicate') {
        this.persistAck(claimed.intent, acked ? 'acked' : 'failed');
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
        this.persistAck(claimed.intent, 'failed');
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
        : afterAckElapsed >= SLACK_ACK_DEADLINE_MS
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
        this.persistAck(claimed.intent, 'failed');
      }
      return 'rejected';
    }
    if (claimed.kind === 'claimed' || claimed.kind === 'duplicate') {
      const ready = this.persistAck(claimed.intent, 'acked');
      if (ready === null || ready.ackState !== 'acked') return 'store_failed';
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

  private persistAck(
    initial: GateResolutionIntent,
    ackState: 'acked' | 'failed',
  ): GateResolutionIntent | null {
    let current = initial;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      // ACK success is terminal-dominant: a later failing duplicate may never downgrade it.
      if (current.ackState === 'acked') return current;
      if (ackState === 'failed' && current.ackState === 'failed') return current;
      try {
        const updated = this.options.store.markGateResolutionAck(
          current.gateKey,
          current.revision,
          ackState,
          this.now().toISOString(),
        );
        if (updated !== null) return updated;
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
