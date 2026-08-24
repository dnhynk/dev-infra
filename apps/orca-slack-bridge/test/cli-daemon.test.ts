import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, runDaemonCommand } from '../src/cli.js';
import { gateActionId, gateBlockId } from '../src/gate/actions.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';
import type { PostMessageInput, PostedMessage, SlackPoster, UpdateMessageInput } from '../src/slack/post.js';
import type { SocketConnectionFactory, SocketConnectionHooks } from '../src/slack/socket.js';
import { APP_TOKEN_VAR } from '../src/slack/verify.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const GATE_ID = 'gate_daemon';
const RUN_ID = 'run_daemon';
const TASK_ID = 'task_daemon';
const GATE = gateKey(GATE_ID);
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const AT = '2026-08-24T10:00:00.000Z';
const CONFIG: BridgeConfig = {
  slack: {
    teamId: 'T0TEAM', apiAppId: 'A0APP', ownerUserIds: ['U0OWNER'],
    channels: { prDigest: 'C0PRDIGEST', agentRuns: CHANNEL },
  },
  projects: [],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

let dir: string;
let statePath: string;
let previousAppToken: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cli-daemon-'));
  statePath = join(dir, 'state.db');
  previousAppToken = process.env[APP_TOKEN_VAR];
  process.env[APP_TOKEN_VAR] = ['xapp', 'FAKE', 'NOTAREALTOKEN'].join('-');
});
afterEach(() => {
  if (previousAppToken === undefined) delete process.env[APP_TOKEN_VAR];
  else process.env[APP_TOKEN_VAR] = previousAppToken;
  rmSync(dir, { recursive: true, force: true });
});

function seed(): void {
  const store = new SqliteDigestStore(statePath);
  store.insertGateMetadata({
    gateKey: GATE, runKey: runKey(RUN_ID), taskKey: taskKey(TASK_ID),
    dispatchKey: dispatchKey('ctx_daemon'), askMessageId: 'msg_daemon',
    questionThreadId: 'thread_daemon',
    options: [{ id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' }],
    recommendation: { optionId: 'keep', reason: '호환성' }, impact: '후속 방향', registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: GATE, runKey: runKey(RUN_ID), channelId: CHANNEL, threadTs: THREAD_TS,
    messageTs: MESSAGE_TS, renderFingerprint: 'fp', at: AT,
  });
  store.saveGateLocalObservation({
    gateKey: GATE, runKey: runKey(RUN_ID), taskKey: taskKey(TASK_ID), status: 'pending',
    resolution: null, resolvedAt: null, metadataState: 'matched', mappingState: 'matched', observedAt: AT,
  });
  store.close();
}

function ownTerminalProjection(): SqliteDigestStore {
  const store = new SqliteDigestStore(statePath);
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
    threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'), actionValue: 'keep',
    retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  const acked = store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT);
  if (acked === null) throw new Error('ACK persistence failed');
  const leased = store.acquireGateResolutionLease(
    GATE,
    't.daemon-terminal-seed',
    AT,
    '2026-08-24T10:01:00.000Z',
  );
  if (leased.kind !== 'acquired') throw new Error(`lease failed: ${leased.kind}`);
  const terminal = store.updateGateResolution(GATE, leased.intent.revision, 't.daemon-terminal-seed', {
    lifecycle: 'degraded', errorCode: 'seeded_degraded', at: AT,
  });
  if (terminal === null) throw new Error('terminal seed failed');
  store.releaseGateResolutionLease(GATE, 't.daemon-terminal-seed');
  const outbox = store.findGateResolutionOutbox(GATE);
  if (outbox === null) throw new Error('outbox seed failed');
  const acquired = store.acquireGateOutboxProjection(
    GATE,
    outbox.revision,
    `p${process.pid}.startup-projector`,
    new Date().toISOString(),
  );
  if (acquired !== 'acquired') throw new Error(`projection seed failed: ${acquired}`);
  return store;
}

function claimPendingIntent(): void {
  const store = new SqliteDigestStore(statePath);
  const claim = store.claimGateResolution({
    teamId: 'T0TEAM', ownerUserId: 'U0OWNER', apiAppId: 'A0APP', channelId: CHANNEL,
    threadTs: THREAD_TS, messageTs: MESSAGE_TS, blockId: gateBlockId(GATE),
    actionId: gateActionId(GATE, 'keep'), actionValue: 'keep',
    retryRequestId: '11111111-1111-4111-8111-111111111111', at: AT,
  });
  if (claim.kind !== 'claimed') throw new Error(`claim failed: ${claim.kind}`);
  if (store.markGateResolutionAck(GATE, claim.intent.revision, 'acked', AT) === null) {
    throw new Error('ACK persistence failed');
  }
  store.close();
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for reconciliation');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeOrca implements OrcaRunner {
  resolved = false;
  blockFirstList = false;
  readonly calls: string[][] = [];
  private releaseBlockedList!: () => void;
  private readonly blockedList = new Promise<void>((resolve) => { this.releaseBlockedList = resolve; });
  protected gate(): Record<string, unknown> {
    return {
      id: GATE_ID, run_id: RUN_ID, task_id: TASK_ID, question: '표시용',
      options: '["현행 유지"]', status: this.resolved ? 'resolved' : 'pending',
      resolution: this.resolved ? '현행 유지' : null,
      created_at: '2026-08-24T09:00:00.000Z', resolved_at: this.resolved ? AT : null,
    };
  }
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[1] === 'gate-list') {
      const response = JSON.stringify({ id: 'x', ok: true, result: { runId: RUN_ID, gates: [this.gate()], count: 1 } });
      if (this.blockFirstList && this.calls.filter((call) => call[1] === 'gate-list').length === 1) {
        return this.blockedList.then(() => response);
      }
      return Promise.resolve(response);
    }
    if (args[1] === 'gate-resolve') {
      this.resolved = true;
      const request = args[args.indexOf('--retry-request') + 1];
      return Promise.resolve(JSON.stringify({
        id: 'x', ok: true,
        result: { gate: this.gate(), mutation: { requestId: request, replayed: false } },
      }));
    }
    return Promise.reject(new Error('unexpected command'));
  }

  releaseList(): void {
    this.releaseBlockedList();
  }
}

class FakeSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  post(_input: PostMessageInput): Promise<PostedMessage> { return Promise.reject(new Error('unused')); }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return Promise.resolve({ channel: input.channel, ts: input.ts });
  }
}

class NeverSettlingOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    return new Promise<string>(() => undefined);
  }
}

class NeverSettlingSlack implements SlackPoster {
  readonly updates: UpdateMessageInput[] = [];
  post(_input: PostMessageInput): Promise<PostedMessage> {
    return Promise.reject(new Error('unused'));
  }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return new Promise(() => undefined);
  }
}

describe('daemon production wiring', () => {
  it('Socket event → ACK → durable CAS → Orca resolve → existing card update를 실제 CLI path로 잇는다', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    let hooks: SocketConnectionHooks | null = null;
    let closed = 0;
    let acks = 0;
    const connectionFactory: SocketConnectionFactory = (received) => {
      hooks = received;
      return {
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => { closed += 1; return Promise.resolve(); },
      };
    };

    const code = await runDaemonCommand(parsed, CONFIG, {
      orca,
      slack,
      connectionFactory,
      waitForStop: async () => {
        const event = hooks?.event;
        if (event === undefined) throw new Error('Socket event consumer was not wired');
        await event({
          type: 'interactive',
          ack: () => { acks += 1; },
          body: {
            type: 'block_actions', api_app_id: 'A0APP', team: { id: 'T0TEAM' }, user: { id: 'U0OWNER' },
            channel: { id: CHANNEL },
            container: { type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false },
            message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
            actions: [{
              type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
              value: 'keep', action_ts: '1787554900.000001', text: { type: 'plain_text', text: '현행 유지' },
            }],
          },
        });
      },
    });

    expect(code).toBe(0);
    expect(acks).toBe(1);
    expect(closed).toBe(1);
    expect(orca.calls.map((call) => call[1])).toEqual(['gate-list', 'gate-list', 'gate-resolve', 'gate-list']);
    expect(slack.updates).toHaveLength(2);
    expect(JSON.stringify(slack.updates[0])).toContain('resolving');
    expect(JSON.stringify(slack.updates.at(-1))).toContain('Coordinator 통지 대기');
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    expect(reopened.listPendingGateOutboxes()).toEqual([]);
    reopened.close();
  });

  it('Socket close failure still drains an already-ACKed resolve before closing SQLite', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    orca.blockFirstList = true;
    const slack = new FakeSlack();
    let hooks: SocketConnectionHooks | null = null;
    let closed = 0;
    const connectionFactory: SocketConnectionFactory = (received) => {
      hooks = received;
      return {
        start: () => Promise.resolve({ appId: 'A0APP' }),
        close: () => {
          closed += 1;
          orca.releaseList();
          return new Promise<void>(() => undefined);
        },
      };
    };
    const code = await runDaemonCommand(parsed, CONFIG, {
      orca,
      slack,
      connectionFactory,
      socketTimeouts: { closeMs: 1 },
      waitForStop: async () => {
        const consume = hooks?.event;
        if (consume === undefined) throw new Error('Socket event consumer was not wired');
        await consume({
          type: 'interactive', ack: () => undefined,
          body: {
            type: 'block_actions', api_app_id: 'A0APP', team: { id: 'T0TEAM' }, user: { id: 'U0OWNER' },
            channel: { id: CHANNEL },
            container: { type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false },
            message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
            actions: [{
              type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
              value: 'keep', action_ts: '1787554900.000001', text: { type: 'plain_text', text: '현행 유지' },
            }],
          },
        });
      },
    });

    expect(code).toBe(1);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(orca.calls.map((call) => call[1])).toEqual(['gate-list', 'gate-list', 'gate-resolve', 'gate-list']);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)?.lifecycle).toBe('resolved');
    reopened.close();
  });

  it('periodic production reconciliation takes over when a live startup projector then dies', async () => {
    seed();
    const blocker = ownTerminalProjection();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    const slack = new FakeSlack();
    let blockerClosed = false;
    let closes = 0;
    try {
      const code = await runDaemonCommand(parsed, CONFIG, {
        orca,
        slack,
        reconcileIntervalMs: 10,
        connectionFactory: () => ({
          start: () => Promise.resolve({ appId: 'A0APP' }),
          close: () => { closes += 1; return Promise.resolve(); },
        }),
        waitForStop: async () => {
          // The one-shot startup pass respected the live owner and made no remote call.
          expect(slack.updates).toEqual([]);
          blocker.close();
          blockerClosed = true;
          await waitFor(() => slack.updates.length === 1);
        },
      });
      expect(code).toBe(0);
    } finally {
      if (!blockerClosed) blocker.close();
    }
    expect(closes).toBe(1);
    expect(orca.calls).toEqual([]);
    expect(JSON.stringify(slack.updates[0])).toContain('degraded');
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.listPendingGateOutboxes()).toEqual([]);
    reopened.close();
  });

  it('a never-settling startup Gate read is bounded before Socket acceptance', async () => {
    seed();
    claimPendingIntent();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new NeverSettlingOrca();
    let starts = 0;
    const began = Date.now();
    const code = await runDaemonCommand(parsed, CONFIG, {
      orca,
      slack: new FakeSlack(),
      orcaTimeoutMs: 10,
      connectionFactory: () => ({
        start: () => { starts += 1; return Promise.resolve({ appId: 'A0APP' }); },
        close: () => Promise.resolve(),
      }),
      waitForStop: () => Promise.resolve(),
    });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(code).toBe(0);
    expect(starts).toBe(1);
    expect(orca.calls.map((call) => call[1])).toEqual(['gate-list']);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', lastErrorCode: 'pre_read_failed', leaseOwner: null,
    });
    reopened.close();
  });

  it('never-settling startup Slack projections are bounded and leave a replayable card', async () => {
    seed();
    claimPendingIntent();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new FakeOrca();
    const slack = new NeverSettlingSlack();
    let starts = 0;
    const began = Date.now();
    const code = await runDaemonCommand(parsed, CONFIG, {
      orca,
      slack,
      slackTimeoutMs: 10,
      connectionFactory: () => ({
        start: () => { starts += 1; return Promise.resolve({ appId: 'A0APP' }); },
        close: () => Promise.resolve(),
      }),
      waitForStop: () => Promise.resolve(),
    });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(code).toBe(0);
    expect(starts).toBe(1);
    expect(slack.updates).toHaveLength(3);
    expect(orca.calls.map((call) => call[1])).toEqual([
      'gate-list', 'gate-list', 'gate-resolve', 'gate-list',
    ]);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'resolved', leaseOwner: null,
    });
    expect(reopened.listPendingGateOutboxes()).toHaveLength(1);
    reopened.close();
  });

  it('shutdown drains a never-settling post-ACK Gate read through the same bound', async () => {
    seed();
    const parsed = parseArgs(['daemon', '--state', statePath]);
    if (parsed.kind !== 'run') throw new Error('daemon args failed');
    const orca = new NeverSettlingOrca();
    const slack = new FakeSlack();
    let hooks: SocketConnectionHooks | null = null;
    let acks = 0;
    const began = Date.now();
    const code = await runDaemonCommand(parsed, CONFIG, {
      orca,
      slack,
      orcaTimeoutMs: 10,
      connectionFactory: (received) => {
        hooks = received;
        return {
          start: () => Promise.resolve({ appId: 'A0APP' }),
          close: () => Promise.resolve(),
        };
      },
      waitForStop: async () => {
        const event = hooks?.event;
        if (event === undefined) throw new Error('Socket event consumer was not wired');
        await event({
          type: 'interactive',
          ack: () => { acks += 1; },
          body: {
            type: 'block_actions', api_app_id: 'A0APP', team: { id: 'T0TEAM' },
            user: { id: 'U0OWNER' }, channel: { id: CHANNEL },
            container: {
              type: 'message', channel_id: CHANNEL, message_ts: MESSAGE_TS, is_ephemeral: false,
            },
            message: { ts: MESSAGE_TS, thread_ts: THREAD_TS },
            actions: [{
              type: 'button', block_id: gateBlockId(GATE), action_id: gateActionId(GATE, 'keep'),
              value: 'keep', action_ts: '1787554900.000001',
              text: { type: 'plain_text', text: '현행 유지' },
            }],
          },
        });
      },
    });
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(code).toBe(0);
    expect(acks).toBe(1);
    expect(orca.calls.map((call) => call[1])).toEqual(['gate-list']);
    const reopened = new SqliteDigestStore(statePath);
    expect(reopened.findGateResolution(GATE)).toMatchObject({
      lifecycle: 'uncertain', lastErrorCode: 'pre_read_failed', leaseOwner: null,
    });
    reopened.close();
  });
});
