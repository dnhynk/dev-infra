import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GateActionHandler,
  type SlackSocketEvent,
} from '../src/gate/action-handler.js';
import {
  GateDirectInputHandler,
  type GateDirectInputFault,
} from '../src/gate/direct-input-handler.js';
import { GATE_DIRECT_OPTION_ID } from '../src/gate/direct-input-types.js';
import {
  gateActionId,
  gateBlockId,
  gateDirectActionId,
  gateDirectActionValue,
  gateDirectBlockId,
  gateDirectCallbackId,
  gateDirectInputActionId,
  gateDirectInputBlockId,
} from '../src/gate/actions.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { SlackConfig } from '../src/project/config.js';
import type { SocketSlackEvent } from '../src/slack/socket.js';
import type {
  OpenedSlackView,
  OpenSlackViewInput,
  SlackViewOpener,
} from '../src/slack/views.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const GATE = gateKey('gate_direct');
const RUN = runKey('run_direct');
const TASK = taskKey('task_direct');
const TEAM = 'T0TEAM';
const APP = 'A0APP';
const OWNER = 'U0OWNER';
const OTHER_OWNER = 'U0SECOND';
const CHANNEL = 'C0AGENTRUNS';
const THREAD_TS = '1787554800.000001';
const MESSAGE_TS = '1787554800.000002';
const VIEW_ID = 'V0DIRECTMODAL';
const AT = '2026-08-25T10:00:00.000Z';
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const REQUEST_IDS = [
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
];
const INPUT_ERROR = '1~3000자의 유효한 결정 내용을 입력하세요.';

const CONFIG: SlackConfig = {
  teamId: TEAM,
  apiAppId: APP,
  ownerUserIds: [OWNER, OTHER_OWNER],
  channels: { prDigest: 'C0PRDIGEST', agentRuns: CHANNEL },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-gate-direct-handler-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(
  store: SqliteDigestStore,
  over: {
    readonly status?: 'pending' | 'resolved' | 'unsupported';
    readonly metadataState?: 'matched' | 'missing' | 'mismatched';
    readonly mappingState?: 'matched' | 'missing' | 'mismatched';
  } = {},
): void {
  store.insertGateMetadata({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    dispatchKey: dispatchKey('ctx_direct'),
    askMessageId: 'msg_direct',
    questionThreadId: 'thread_direct',
    options: [
      { id: 'keep', label: '현행 유지', description: '호환성', resolution: '현행 유지' },
      { id: 'change', label: '변경', description: '새 경로', resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', reason: '호환성' },
    impact: '후속 방향',
    registeredAt: AT,
  });
  store.insertGateMessage({
    gateKey: GATE,
    runKey: RUN,
    channelId: CHANNEL,
    threadTs: THREAD_TS,
    messageTs: MESSAGE_TS,
    renderFingerprint: 'fp-direct',
    at: AT,
  });
  const status = over.status ?? 'pending';
  store.saveGateLocalObservation({
    gateKey: GATE,
    runKey: RUN,
    taskKey: TASK,
    status,
    resolution: status === 'resolved' ? '외부 결정' : null,
    resolvedAt: status === 'resolved' ? AT : null,
    metadataState: over.metadataState ?? 'matched',
    mappingState: over.mappingState ?? 'matched',
    observedAt: AT,
  });
}

function buttonBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'block_actions',
    api_app_id: APP,
    team: { id: TEAM, domain: 'workspace-name-is-not-an-identity' },
    user: {
      id: OWNER,
      team_id: TEAM,
      username: 'owner-human-name',
      name: 'owner-human-name',
    },
    container: {
      type: 'message',
      channel_id: CHANNEL,
      message_ts: MESSAGE_TS,
      thread_ts: THREAD_TS,
      is_ephemeral: false,
    },
    channel: { id: CHANNEL, name: 'agent-runs-human-name' },
    message: {
      type: 'message',
      ts: MESSAGE_TS,
      thread_ts: THREAD_TS,
      text: 'NEVER PARSE THIS GATE PROSE',
      blocks: [],
    },
    actions: [{
      type: 'button',
      block_id: gateDirectBlockId(GATE),
      action_id: gateDirectActionId(GATE),
      value: gateDirectActionValue(GATE),
      action_ts: '1787554900.000001',
      text: { type: 'plain_text', text: 'ignored human label', emoji: true },
    }],
    response_url: 'https://hooks.slack.invalid/DO-NOT-USE',
    trigger_id: 'TRIGGER-IS-EPHEMERAL-AND-MUST-NOT-BE-STORED',
    ...over,
  };
}

function fixedButtonBody(optionId = 'keep'): Record<string, unknown> {
  return {
    ...buttonBody(),
    actions: [{
      type: 'button',
      block_id: gateBlockId(GATE),
      action_id: gateActionId(GATE, optionId),
      value: optionId,
      action_ts: optionId === 'keep' ? '1787554900.000010' : '1787554900.000011',
      text: { type: 'plain_text', text: 'ignored human label' },
    }],
  };
}

function submissionBody(
  value: unknown,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'view_submission',
    api_app_id: APP,
    team: { id: TEAM, domain: 'workspace-name-is-not-an-identity' },
    user: { id: OWNER, team_id: TEAM, username: 'owner-human-name' },
    trigger_id: 'A-DIFFERENT-EPHEMERAL-TRIGGER',
    view: {
      id: VIEW_ID,
      team_id: TEAM,
      app_id: APP,
      bot_id: 'B0BOT',
      type: 'modal',
      callback_id: gateDirectCallbackId(GATE),
      private_metadata: SESSION_ID,
      hash: '1787555000.hash',
      root_view_id: VIEW_ID,
      previous_view_id: null,
      state: {
        values: {
          [gateDirectInputBlockId(GATE)]: {
            [gateDirectInputActionId(GATE)]: {
              type: 'plain_text_input',
              value,
            },
          },
        },
      },
    },
    ...over,
  };
}

function event(
  body: unknown,
  ack: (response?: unknown) => void | Promise<void>,
): SocketSlackEvent {
  return { type: 'interactive', body, ack };
}

class FakeOpener implements SlackViewOpener {
  readonly calls: OpenSlackViewInput[] = [];

  constructor(
    private readonly result?: (
      input: OpenSlackViewInput,
    ) => OpenedSlackView | Promise<OpenedSlackView>,
  ) {}

  async open(input: OpenSlackViewInput): Promise<OpenedSlackView> {
    this.calls.push(input);
    if (this.result !== undefined) return await this.result(input);
    return {
      id: VIEW_ID,
      teamId: TEAM,
      appId: APP,
      callbackId: input.view.callback_id ?? '',
      privateMetadata: input.view.private_metadata ?? '',
    };
  }
}

type DirectOptions = ConstructorParameters<typeof GateDirectInputHandler>[0];

function directHandler(
  store: SqliteDigestStore,
  opener: SlackViewOpener,
  engineCalls: string[],
  jobs: Array<() => Promise<void>>,
  over: Partial<DirectOptions> = {},
): GateDirectInputHandler {
  let request = 0;
  return new GateDirectInputHandler({
    config: CONFIG,
    store,
    opener,
    engine: {
      resolveAndProject: async (key) => {
        engineCalls.push(key);
      },
    },
    now: () => new Date(AT),
    sessionId: () => SESSION_ID,
    requestId: () => REQUEST_IDS[request++] ?? REQUEST_IDS[2]!,
    schedule: (job) => jobs.push(job),
    ...over,
  });
}

async function openModal(
  store: SqliteDigestStore,
  opener: FakeOpener,
  over: Partial<DirectOptions> = {},
): Promise<{
  readonly handler: GateDirectInputHandler;
  readonly engineCalls: string[];
  readonly jobs: Array<() => Promise<void>>;
}> {
  const engineCalls: string[] = [];
  const jobs: Array<() => Promise<void>> = [];
  const handler = directHandler(store, opener, engineCalls, jobs, over);
  const acks: unknown[] = [];
  expect(await handler.handle(event(buttonBody(), (response) => { acks.push(response); }))).toBe(
    'modal_opened',
  );
  expect(acks).toEqual([undefined]);
  expect(store.findGateDirectModal(SESSION_ID)?.state).toBe('opened');
  return { handler, engineCalls, jobs };
}

describe('Gate direct-input Socket Mode boundary', () => {
  it('bounds a never-settling ACK promise and attempts it exactly once', async () => {
    const store = new SqliteDigestStore(join(dir, 'hanging-ack.db'));
    seed(store);
    const opener = new FakeOpener();
    const engineCalls: string[] = [];
    const jobs: Array<() => Promise<void>> = [];
    const handler = directHandler(store, opener, engineCalls, jobs, {
      ingressDeadlineMs: 15,
      localStoreDeadlineMs: 5,
      sqliteBusyRetryMs: 1,
    });
    let ackAttempts = 0;
    const started = performance.now();

    expect(await handler.handle(event(
      buttonBody({ user: { id: 'U0INTRUDER', team_id: TEAM } }),
      () => {
        ackAttempts += 1;
        return new Promise<void>(() => undefined);
      },
    ))).toBe('ack_failed');

    expect(performance.now() - started).toBeLessThan(500);
    expect(ackAttempts).toBe(1);
    expect(opener.calls).toEqual([]);
    expect(engineCalls).toEqual([]);
    expect(store.findGateDirectModal(SESSION_ID)).toBeNull();
    store.close();
  });

  it('opens the exact Gate-linked modal after one ACK inside the shared remaining budget', async () => {
    const store = new SqliteDigestStore(join(dir, 'valid-button.db'));
    seed(store);
    let clock = 0;
    const opener = new FakeOpener();
    const engineCalls: string[] = [];
    const jobs: Array<() => Promise<void>> = [];
    const handler = directHandler(store, opener, engineCalls, jobs, {
      monotonic: () => clock,
    });
    const acks: unknown[] = [];

    expect(await handler.handle(event(buttonBody(), (response) => {
      acks.push(response);
      expect(opener.calls).toHaveLength(0);
      expect(store.findGateDirectModal(SESSION_ID)).toMatchObject({ state: 'prepared' });
      clock = 275;
    }))).toBe('modal_opened');

    expect(acks).toEqual([undefined]);
    expect(opener.calls).toHaveLength(1);
    const call = opener.calls[0]!;
    expect(call.triggerId).toBe('TRIGGER-IS-EPHEMERAL-AND-MUST-NOT-BE-STORED');
    expect(call.timeoutMs).toBeGreaterThan(2_500);
    expect(call.timeoutMs).toBeLessThanOrEqual(2_725);
    expect(call.view).toEqual({
      type: 'modal',
      callback_id: gateDirectCallbackId(GATE),
      private_metadata: SESSION_ID,
      title: { type: 'plain_text', text: 'Gate 직접 결정', emoji: true },
      submit: { type: 'plain_text', text: '결정', emoji: true },
      close: { type: 'plain_text', text: '취소', emoji: true },
      blocks: [{
        type: 'input',
        block_id: gateDirectInputBlockId(GATE),
        label: { type: 'plain_text', text: '결정 내용', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: gateDirectInputActionId(GATE),
          multiline: true,
          min_length: 1,
          max_length: 3_000,
          focus_on_load: true,
        },
      }],
    });
    expect(store.findGateDirectModal(SESSION_ID)).toMatchObject({
      gateKey: GATE,
      teamId: TEAM,
      ownerUserId: OWNER,
      apiAppId: APP,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      messageTs: MESSAGE_TS,
      blockId: gateDirectBlockId(GATE),
      actionId: gateDirectActionId(GATE),
      actionValue: gateDirectActionValue(GATE),
      callbackId: gateDirectCallbackId(GATE),
      inputBlockId: gateDirectInputBlockId(GATE),
      inputActionId: gateDirectInputActionId(GATE),
      state: 'opened',
      viewId: VIEW_ID,
    });
    expect(store.findGateResolution(GATE)).toBeNull();
    expect(engineCalls).toEqual([]);
    expect(jobs).toEqual([]);
    store.close();
  });

  it('pins the authenticated payload App ID when apiAppId is intentionally not configured', async () => {
    const store = new SqliteDigestStore(join(dir, 'optional-app-id.db'));
    seed(store);
    const opener = new FakeOpener();
    const jobs: Array<() => Promise<void>> = [];
    const config: SlackConfig = {
      teamId: TEAM,
      ownerUserIds: [OWNER, OTHER_OWNER],
      channels: CONFIG.channels,
    };
    const handler = directHandler(store, opener, [], jobs, { config });
    expect(await handler.handle(event(buttonBody(), () => undefined))).toBe('modal_opened');
    expect(store.findGateDirectModal(SESSION_ID)?.apiAppId).toBe(APP);
    expect(await handler.handle(event(submissionBody('optional app 결정'), () => undefined))).toBe(
      'claimed',
    );
    expect(jobs).toHaveLength(1);
    store.close();
  });

  it('rejects an already-open modal after the configured Agent Runs channel changes', async () => {
    const store = new SqliteDigestStore(join(dir, 'changed-channel.db'));
    seed(store);
    await openModal(store, new FakeOpener());
    const acks: unknown[] = [];
    const changed: SlackConfig = {
      ...CONFIG,
      channels: { ...CONFIG.channels, agentRuns: 'C0OTHERCHANNEL' },
    };
    expect(await directHandler(store, new FakeOpener(), [], [], { config: changed }).handle(
      event(submissionBody('stale channel 결정'), (response) => { acks.push(response); }),
    )).toBe('rejected');
    expect(acks).toEqual([undefined]);
    expect(store.findGateResolution(GATE)).toBeNull();
    store.close();
  });

  it('ACKs invalid button identities, containers, actions, triggers, and sidecars once without opening', async () => {
    const mutations: readonly ((raw: Record<string, unknown>) => void)[] = [
      (raw) => { raw['team'] = { id: 'TOTHER' }; },
      (raw) => { raw['user'] = { id: 'UOTHER', team_id: TEAM }; },
      (raw) => { raw['user'] = { id: OWNER, team_id: 'TOTHER' }; },
      (raw) => { raw['api_app_id'] = 'AOTHER'; },
      (raw) => { delete raw['api_app_id']; },
      (raw) => { raw['channel'] = { id: 'COTHER' }; },
      (raw) => { (raw['container'] as Record<string, unknown>)['channel_id'] = 'COTHER'; },
      (raw) => { (raw['container'] as Record<string, unknown>)['message_ts'] = '1787554800.9'; },
      (raw) => { (raw['container'] as Record<string, unknown>)['thread_ts'] = '1787554800.9'; },
      (raw) => { (raw['container'] as Record<string, unknown>)['type'] = 'view'; },
      (raw) => { (raw['container'] as Record<string, unknown>)['is_ephemeral'] = true; },
      (raw) => { (raw['message'] as Record<string, unknown>)['ts'] = '1787554800.9'; },
      (raw) => { (raw['message'] as Record<string, unknown>)['thread_ts'] = '1787554800.9'; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['block_id'] = 'wrong'; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['action_id'] = 'wrong'; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['value'] = 'wrong'; },
      (raw) => { (raw['actions'] as Record<string, unknown>[])[0]!['type'] = 'static_select'; },
      (raw) => { raw['actions'] = []; },
      (raw) => { raw['actions'] = [
        ...(raw['actions'] as unknown[]),
        ...(raw['actions'] as unknown[]),
      ]; },
      (raw) => { delete raw['trigger_id']; },
      (raw) => { raw['trigger_id'] = ''; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const store = new SqliteDigestStore(join(dir, `invalid-button-${index}.db`));
      seed(store);
      const raw = structuredClone(buttonBody());
      mutate(raw);
      const opener = new FakeOpener();
      const engineCalls: string[] = [];
      let acks = 0;
      const result = await directHandler(store, opener, engineCalls, []).handle(
        event(raw, () => { acks += 1; }),
      );
      expect(result, `invalid mutation ${index}`).toBe('rejected');
      expect(acks, `invalid mutation ${index}`).toBe(1);
      expect(opener.calls, `invalid mutation ${index}`).toEqual([]);
      expect(engineCalls, `invalid mutation ${index}`).toEqual([]);
      expect(store.findGateResolution(GATE), `invalid mutation ${index}`).toBeNull();
      store.close();
    }

    for (const [name, observation] of [
      ['resolved', { status: 'resolved' as const }],
      ['unsupported', { status: 'unsupported' as const }],
      ['stale-sidecar', { metadataState: 'mismatched' as const }],
      ['stale-mapping', { mappingState: 'mismatched' as const }],
    ] as const) {
      const store = new SqliteDigestStore(join(dir, `${name}.db`));
      seed(store, observation);
      const opener = new FakeOpener();
      let acks = 0;
      expect(await directHandler(store, opener, [], []).handle(
        event(buttonBody(), () => { acks += 1; }),
      )).toBe('rejected');
      expect(acks).toBe(1);
      expect(opener.calls).toEqual([]);
      expect(store.findGateResolution(GATE)).toBeNull();
      store.close();
    }

    const missing = new SqliteDigestStore(join(dir, 'missing-sidecar.db'));
    missing.insertGateMessage({
      gateKey: GATE,
      runKey: RUN,
      channelId: CHANNEL,
      threadTs: THREAD_TS,
      messageTs: MESSAGE_TS,
      renderFingerprint: 'fp',
      at: AT,
    });
    missing.saveGateLocalObservation({
      gateKey: GATE,
      runKey: RUN,
      taskKey: TASK,
      status: 'pending',
      resolution: null,
      resolvedAt: null,
      metadataState: 'missing',
      mappingState: 'matched',
      observedAt: AT,
    });
    const opener = new FakeOpener();
    let acks = 0;
    expect(await directHandler(missing, opener, [], []).handle(
      event(buttonBody(), () => { acks += 1; }),
    )).toBe('rejected');
    expect(acks).toBe(1);
    expect(opener.calls).toEqual([]);
    expect(missing.findGateResolution(GATE)).toBeNull();
    missing.close();
  });

  it('opens a button delivery at most once across exact duplicate and concurrent redelivery', async () => {
    const store = new SqliteDigestStore(join(dir, 'button-redelivery.db'));
    seed(store);
    const opener = new FakeOpener();
    const handler = directHandler(store, opener, [], []);
    const ackBodies: unknown[] = [];
    const outcomes = await Promise.all([
      handler.handle(event(buttonBody(), (response) => { ackBodies.push(response); })),
      handler.handle(event(buttonBody(), (response) => { ackBodies.push(response); })),
    ]);
    expect(outcomes.sort()).toEqual(['duplicate', 'modal_opened']);
    expect(ackBodies).toEqual([undefined, undefined]);
    expect(opener.calls).toHaveLength(1);
    expect(store.findGateDirectModal(SESSION_ID)?.state).toBe('opened');
    store.close();
  });

  it('uses Slack response_action errors keyed to the exact input block for every local format failure', async () => {
    const store = new SqliteDigestStore(join(dir, 'invalid-submissions.db'));
    seed(store);
    const opener = new FakeOpener();
    const { handler, engineCalls, jobs } = await openModal(store, opener);
    const invalidBodies: Record<string, unknown>[] = [
      submissionBody(''),
      submissionBody('   \n\t  '),
      submissionBody('x'.repeat(3_001)),
      submissionBody('valid\u0000invalid'),
      submissionBody(null),
      submissionBody('valid', {
        view: {
          ...(submissionBody('valid')['view'] as Record<string, unknown>),
          state: { values: {} },
        },
      }),
      submissionBody('valid', {
        view: {
          ...(submissionBody('valid')['view'] as Record<string, unknown>),
          state: {
            values: {
              [gateDirectInputBlockId(GATE)]: {
                [gateDirectInputActionId(GATE)]: { type: 'plain_text_input', value: 'valid' },
              },
              injected: { input: { type: 'plain_text_input', value: 'coordinator prompt' } },
            },
          },
        },
      }),
    ];
    for (const [index, raw] of invalidBodies.entries()) {
      const responses: unknown[] = [];
      expect(await handler.handle(event(raw, (response) => { responses.push(response); })),
        `invalid submission ${index}`).toBe('rejected');
      expect(responses, `invalid submission ${index}`).toEqual([{
        response_action: 'errors',
        errors: { [gateDirectInputBlockId(GATE)]: INPUT_ERROR },
      }]);
      expect(store.findGateResolution(GATE)).toBeNull();
    }
    expect(engineCalls).toEqual([]);
    expect(jobs).toEqual([]);
    expect(store.findGateDirectModal(SESSION_ID)?.state).toBe('opened');
    store.close();
  });

  it('claims before ACK, preserves valid whitespace/newlines, then schedules only after durable ACK promotion', async () => {
    const store = new SqliteDigestStore(join(dir, 'valid-submission.db'));
    seed(store);
    const opener = new FakeOpener();
    const { handler, engineCalls, jobs } = await openModal(store, opener);
    const resolution = '  첫 줄\n\n둘째 줄\t마침  ';
    const original = store.claimGateDirectResolution.bind(store);
    let acked = false;
    vi.spyOn(store, 'claimGateDirectResolution').mockImplementation((input) => {
      expect(acked).toBe(false);
      expect(engineCalls).toEqual([]);
      expect(jobs).toEqual([]);
      return original(input);
    });
    const responses: unknown[] = [];

    expect(await handler.handle(event(submissionBody(resolution), (response) => {
      responses.push(response);
      expect(store.findGateResolution(GATE)).toMatchObject({
        optionId: GATE_DIRECT_OPTION_ID,
        optionResolution: resolution,
        ackState: 'pending',
        blockId: gateDirectInputBlockId(GATE),
        actionId: gateDirectInputActionId(GATE),
        actionValue: SESSION_ID,
      });
      expect(store.findGateResolutionOutbox(GATE)).toMatchObject({
        cardState: 'resolving',
        cardPending: true,
        notificationState: 'pending',
      });
      expect(engineCalls).toEqual([]);
      expect(jobs).toEqual([]);
      acked = true;
    }))).toBe('claimed');

    expect(responses).toEqual([undefined]);
    expect(acked).toBe(true);
    expect(store.findGateResolution(GATE)).toMatchObject({
      optionResolution: resolution,
      ackState: 'acked',
    });
    expect(store.findGateDirectModal(SESSION_ID)).toMatchObject({
      state: 'accepted',
      resolutionText: resolution,
    });
    expect(jobs).toHaveLength(1);
    expect(engineCalls).toEqual([]);
    await jobs[0]!();
    expect(engineCalls).toEqual([GATE]);
    store.close();
  });

  it('accepts exactly 3000 code units and rejects 3001 without changing the accepted text', async () => {
    for (const [name, text, accepted] of [
      ['exact', 'x'.repeat(3_000), true],
      ['too-long', 'x'.repeat(3_001), false],
    ] as const) {
      const store = new SqliteDigestStore(join(dir, `${name}-boundary.db`));
      seed(store);
      const opener = new FakeOpener();
      const { handler, jobs } = await openModal(store, opener);
      const responses: unknown[] = [];
      const outcome = await handler.handle(event(submissionBody(text), (response) => {
        responses.push(response);
      }));
      expect(outcome).toBe(accepted ? 'claimed' : 'rejected');
      if (accepted) {
        expect(responses).toEqual([undefined]);
        expect(store.findGateResolution(GATE)?.optionResolution).toBe(text);
        expect(jobs).toHaveLength(1);
      } else {
        expect(responses).toEqual([{
          response_action: 'errors',
          errors: { [gateDirectInputBlockId(GATE)]: INPUT_ERROR },
        }]);
        expect(store.findGateResolution(GATE)).toBeNull();
        expect(jobs).toEqual([]);
      }
      store.close();
    }
  });

  it('rejects every mismatched submission envelope or modal correlation with one empty ACK', async () => {
    const mutations: readonly ((raw: Record<string, unknown>) => void)[] = [
      (raw) => { raw['team'] = { id: 'TOTHER' }; },
      (raw) => { raw['user'] = { id: 'UOTHER', team_id: TEAM }; },
      (raw) => { raw['user'] = { id: OWNER, team_id: 'TOTHER' }; },
      (raw) => { raw['api_app_id'] = 'AOTHER'; },
      (raw) => { delete raw['api_app_id']; },
      (raw) => { (raw['view'] as Record<string, unknown>)['id'] = 'VOTHER'; },
      (raw) => { (raw['view'] as Record<string, unknown>)['team_id'] = 'TOTHER'; },
      (raw) => { (raw['view'] as Record<string, unknown>)['app_id'] = 'AOTHER'; },
      (raw) => { (raw['view'] as Record<string, unknown>)['type'] = 'home'; },
      (raw) => { (raw['view'] as Record<string, unknown>)['callback_id'] = 'wrong'; },
      (raw) => { (raw['view'] as Record<string, unknown>)['private_metadata'] = 'wrong'; },
      (raw) => { delete (raw['view'] as Record<string, unknown>)['private_metadata']; },
    ];
    const store = new SqliteDigestStore(join(dir, 'submission-identity.db'));
    seed(store);
    const opener = new FakeOpener();
    const { handler, engineCalls, jobs } = await openModal(store, opener);
    for (const [index, mutate] of mutations.entries()) {
      const raw = structuredClone(submissionBody('결정'));
      mutate(raw);
      const responses: unknown[] = [];
      expect(await handler.handle(event(raw, (response) => { responses.push(response); })),
        `identity mutation ${index}`).toBe('rejected');
      expect(responses, `identity mutation ${index}`).toEqual([undefined]);
      expect(store.findGateResolution(GATE)).toBeNull();
    }
    expect(engineCalls).toEqual([]);
    expect(jobs).toEqual([]);
    store.close();
  });

  it('fails closed on ACK failure and recovers only through an exact durable redelivery after restart', async () => {
    const path = join(dir, 'submission-ack-restart.db');
    const first = new SqliteDigestStore(path);
    seed(first);
    const firstOpener = new FakeOpener();
    const opened = await openModal(first, firstOpener);
    let ackAttempts = 0;
    expect(await opened.handler.handle(event(submissionBody('restart 결정'), () => {
      ackAttempts += 1;
      throw new Error('Socket response lost');
    }))).toBe('ack_failed');
    expect(ackAttempts).toBe(1);
    expect(opened.jobs).toEqual([]);
    expect(opened.engineCalls).toEqual([]);
    expect(first.findGateResolution(GATE)).toMatchObject({
      ackState: 'failed',
      optionResolution: 'restart 결정',
    });
    expect(first.listNonterminalGateResolutions()).toEqual([]);
    first.close();

    const restarted = new SqliteDigestStore(path);
    const engineCalls: string[] = [];
    const jobs: Array<() => Promise<void>> = [];
    const handler = directHandler(restarted, new FakeOpener(), engineCalls, jobs);
    const responses: unknown[] = [];
    expect(await handler.handle(event(submissionBody('restart 결정'), (response) => {
      responses.push(response);
    }))).toBe('duplicate');
    expect(responses).toEqual([undefined]);
    expect(restarted.findGateResolution(GATE)).toMatchObject({
      ackState: 'acked',
      retryRequestId: REQUEST_IDS[0],
    });
    expect(jobs).toHaveLength(1);
    await jobs[0]!();
    expect(engineCalls).toEqual([GATE]);
    restarted.close();
  });

  it('does not call views.open after button ACK failure and an exact restart redelivery opens once', async () => {
    const path = join(dir, 'button-ack-restart.db');
    const first = new SqliteDigestStore(path);
    seed(first);
    const firstOpener = new FakeOpener();
    let acks = 0;
    expect(await directHandler(first, firstOpener, [], []).handle(
      event(buttonBody(), () => {
        acks += 1;
        throw new Error('ACK transport failed');
      }),
    )).toBe('ack_failed');
    expect(acks).toBe(1);
    expect(firstOpener.calls).toEqual([]);
    expect(first.findGateDirectModal(SESSION_ID)?.state).toBe('prepared');
    first.close();

    const restarted = new SqliteDigestStore(path);
    const secondOpener = new FakeOpener();
    let restartAcks = 0;
    expect(await directHandler(restarted, secondOpener, [], []).handle(
      event(buttonBody(), () => { restartAcks += 1; }),
    )).toBe('modal_opened');
    expect(restartAcks).toBe(1);
    expect(secondOpener.calls).toHaveLength(1);
    expect(restarted.findGateDirectModal(SESSION_ID)?.state).toBe('opened');
    restarted.close();
  });

  it('keeps every views.open failure or response-identity mismatch non-submittable', async () => {
    const cases: readonly [string, FakeOpener][] = [
      ['transport-loss', new FakeOpener(() => { throw new Error('contains SECRET-TRIGGER'); })],
      ['team-mismatch', new FakeOpener((input) => ({
        id: VIEW_ID,
        teamId: 'TOTHER',
        appId: APP,
        callbackId: input.view.callback_id ?? '',
        privateMetadata: input.view.private_metadata ?? '',
      }))],
      ['app-mismatch', new FakeOpener((input) => ({
        id: VIEW_ID,
        teamId: TEAM,
        appId: 'AOTHER',
        callbackId: input.view.callback_id ?? '',
        privateMetadata: input.view.private_metadata ?? '',
      }))],
      ['callback-mismatch', new FakeOpener((input) => ({
        id: VIEW_ID,
        teamId: TEAM,
        appId: APP,
        callbackId: `${input.view.callback_id ?? ''}:wrong`,
        privateMetadata: input.view.private_metadata ?? '',
      }))],
      ['metadata-mismatch', new FakeOpener((input) => ({
        id: VIEW_ID,
        teamId: TEAM,
        appId: APP,
        callbackId: input.view.callback_id ?? '',
        privateMetadata: 'wrong',
      }))],
    ];
    for (const [name, opener] of cases) {
      const store = new SqliteDigestStore(join(dir, `${name}.db`));
      seed(store);
      let acks = 0;
      expect(await directHandler(store, opener, [], []).handle(
        event(buttonBody(), () => { acks += 1; }),
      )).toBe('open_failed');
      expect(acks).toBe(1);
      expect(opener.calls).toHaveLength(1);
      const failed = store.findGateDirectModal(SESSION_ID);
      expect(failed).toMatchObject({ state: 'failed' });
      expect(JSON.stringify(failed)).not.toContain('SECRET-TRIGGER');
      expect(JSON.stringify(failed)).not.toContain('TRIGGER-IS-EPHEMERAL');
      const submitAcks: unknown[] = [];
      expect(await directHandler(store, opener, [], []).handle(
        event(submissionBody('must not resolve'), (response) => { submitAcks.push(response); }),
      )).toBe('rejected');
      expect(submitAcks).toEqual([undefined]);
      expect(store.findGateResolution(GATE)).toBeNull();
      store.close();
    }
  });

  it('keeps the pre-ACK prepared sidecar unACKed and recoverable when the process boundary faults', async () => {
    const path = join(dir, 'prepared-before-ack-fault.db');
    const first = new SqliteDigestStore(path);
    seed(first);
    const firstOpener = new FakeOpener();
    let acks = 0;
    let injected = false;
    await expect(directHandler(first, firstOpener, [], [], {
      fault: (point) => {
        if (point === 'after_modal_prepare_before_ack' && !injected) {
          injected = true;
          throw new Error('injected before ACK');
        }
      },
    }).handle(event(buttonBody(), () => { acks += 1; }))).rejects.toThrow('injected before ACK');
    expect(injected).toBe(true);
    expect(acks).toBe(0);
    expect(firstOpener.calls).toEqual([]);
    expect(first.findGateDirectModal(SESSION_ID)?.state).toBe('prepared');
    first.close();

    const restarted = new SqliteDigestStore(path);
    const restartOpener = new FakeOpener();
    expect(await directHandler(restarted, restartOpener, [], []).handle(
      event(buttonBody(), () => undefined),
    )).toBe('modal_opened');
    expect(restartOpener.calls).toHaveLength(1);
    restarted.close();
  });

  it('documents modal-open crash edges: prepared can redeliver, opening cannot replay a trigger', async () => {
    for (const point of [
      'after_button_ack_before_open_edge',
      'after_open_edge_before_api',
      'after_open_response_before_persist',
    ] as const satisfies readonly GateDirectInputFault[]) {
      const path = join(dir, `${point}.db`);
      const first = new SqliteDigestStore(path);
      seed(first);
      const firstOpener = new FakeOpener();
      let injected = false;
      await expect(directHandler(first, firstOpener, [], [], {
        fault: (current) => {
          if (current === point && !injected) {
            injected = true;
            throw new Error(`crash:${point}`);
          }
        },
      }).handle(event(buttonBody(), () => undefined))).rejects.toThrow(`crash:${point}`);
      expect(injected).toBe(true);
      const state = first.findGateDirectModal(SESSION_ID)?.state;
      expect(state).toBe(point === 'after_button_ack_before_open_edge' ? 'prepared' : 'opening');
      first.close();

      const restarted = new SqliteDigestStore(path);
      const restartOpener = new FakeOpener();
      const outcome = await directHandler(restarted, restartOpener, [], []).handle(
        event(buttonBody(), () => undefined),
      );
      if (point === 'after_button_ack_before_open_edge') {
        expect(outcome).toBe('modal_opened');
        expect(restartOpener.calls).toHaveLength(1);
      } else {
        expect(outcome).toBe('duplicate');
        expect(restartOpener.calls).toEqual([]);
        expect(restarted.findGateDirectModal(SESSION_ID)?.state).toBe('opening');
      }
      restarted.close();
    }
  });

  it('does not open a prepared redelivery after a fixed winner makes the Gate stale', async () => {
    const store = new SqliteDigestStore(join(dir, 'prepared-then-fixed.db'));
    seed(store);
    await expect(directHandler(store, new FakeOpener(), [], [], {
      fault: (point) => {
        if (point === 'after_button_ack_before_open_edge') throw new Error('crash before open edge');
      },
    }).handle(event(buttonBody(), () => undefined))).rejects.toThrow('crash before open edge');
    expect(store.findGateDirectModal(SESSION_ID)).toMatchObject({ state: 'prepared' });

    const fixedJobs: Array<() => Promise<void>> = [];
    const fixed = new GateActionHandler({
      config: CONFIG,
      store,
      engine: { resolveAndProject: async () => undefined },
      now: () => new Date(AT),
      requestId: () => REQUEST_IDS[1]!,
      schedule: (job) => fixedJobs.push(job),
    });
    expect(await fixed.handle({
      type: 'interactive',
      body: fixedButtonBody(),
      ack: () => undefined,
    })).toBe('claimed');
    expect(fixedJobs).toHaveLength(1);

    const redeliveryOpener = new FakeOpener();
    expect(await directHandler(store, redeliveryOpener, [], []).handle(
      event(buttonBody(), () => undefined),
    )).toBe('duplicate');
    expect(redeliveryOpener.calls).toEqual([]);
    store.close();
  });

  it('leaves a pre-ACK process crash unACKed and recovers the pending winner by exact restart redelivery', async () => {
    const path = join(dir, 'claim-before-ack-fault.db');
    const first = new SqliteDigestStore(path);
    seed(first);
    const opened = await openModal(first, new FakeOpener());
    let faulted = false;
    let acks = 0;
    await expect(directHandler(first, new FakeOpener(), [], [], {
      fault: (point) => {
        if (point === 'after_submission_claim_before_ack' && !faulted) {
          faulted = true;
          throw new Error('injected process boundary');
        }
      },
    }).handle(event(submissionBody('fault 결정'), () => { acks += 1; }))).rejects.toThrow(
      'injected process boundary',
    );
    expect(opened.jobs).toEqual([]);
    expect(faulted).toBe(true);
    expect(acks).toBe(0);
    expect(first.findGateResolution(GATE)).toMatchObject({
      ackState: 'pending',
      optionResolution: 'fault 결정',
    });
    first.close();

    const restarted = new SqliteDigestStore(path);
    const jobs: Array<() => Promise<void>> = [];
    const calls: string[] = [];
    expect(await directHandler(restarted, new FakeOpener(), calls, jobs).handle(
      event(submissionBody('fault 결정'), () => undefined),
    )).toBe('duplicate');
    expect(restarted.findGateResolution(GATE)?.ackState).toBe('acked');
    expect(jobs).toHaveLength(1);
    await jobs[0]!();
    expect(calls).toEqual([GATE]);
    restarted.close();
  });

  it('quarantines the irreducible physical-ACK/storage crash gap until exact redelivery', async () => {
    const path = join(dir, 'ack-before-persist-fault.db');
    const first = new SqliteDigestStore(path);
    seed(first);
    await openModal(first, new FakeOpener());
    let acks = 0;
    await expect(directHandler(first, new FakeOpener(), [], [], {
      fault: (point) => {
        if (point === 'after_submission_ack_before_persist') {
          throw new Error('crash after physical ACK');
        }
      },
    }).handle(event(submissionBody('ACK gap 결정'), () => { acks += 1; }))).rejects.toThrow(
      'crash after physical ACK',
    );
    expect(acks).toBe(1);
    expect(first.findGateResolution(GATE)).toMatchObject({
      ackState: 'pending',
      optionResolution: 'ACK gap 결정',
    });
    expect(first.listNonterminalGateResolutions()).toEqual([]);
    first.close();

    const restarted = new SqliteDigestStore(path);
    const jobs: Array<() => Promise<void>> = [];
    expect(await directHandler(restarted, new FakeOpener(), [], jobs).handle(
      event(submissionBody('ACK gap 결정'), () => undefined),
    )).toBe('duplicate');
    expect(restarted.findGateResolution(GATE)?.ackState).toBe('acked');
    expect(jobs).toHaveLength(1);
    restarted.close();
  });

  it('leaves an ACK-confirmed durable winner visible to startup reconcile after scheduling crashes', async () => {
    const path = join(dir, 'acked-before-schedule-fault.db');
    const first = new SqliteDigestStore(path);
    seed(first);
    await openModal(first, new FakeOpener());
    let acks = 0;
    await expect(directHandler(first, new FakeOpener(), [], [], {
      fault: (point) => {
        if (point === 'after_submission_ack_persist_before_schedule') {
          throw new Error('crash after durable ACK');
        }
      },
    }).handle(event(submissionBody('재시작 reconcile 결정'), () => { acks += 1; }))).rejects.toThrow(
      'crash after durable ACK',
    );
    expect(acks).toBe(1);
    expect(first.findGateResolution(GATE)?.ackState).toBe('acked');
    first.close();

    const restarted = new SqliteDigestStore(path);
    expect(restarted.listNonterminalGateResolutions()).toHaveLength(1);
    expect(restarted.listNonterminalGateResolutions()[0]).toMatchObject({
      gateKey: GATE,
      optionResolution: '재시작 reconcile 결정',
      ackState: 'acked',
    });
    restarted.close();
  });

  it('gives one durable winner to concurrent fixed-option versus free-form resolution', async () => {
    for (const firstKind of ['direct', 'fixed'] as const) {
      const store = new SqliteDigestStore(join(dir, `concurrent-${firstKind}.db`));
      seed(store);
      const directJobs: Array<() => Promise<void>> = [];
      const fixedJobs: Array<() => Promise<void>> = [];
      const engineCalls: string[] = [];
      const direct = directHandler(store, new FakeOpener(), engineCalls, directJobs);
      expect(await direct.handle(event(buttonBody(), () => undefined))).toBe('modal_opened');
      const fixed = new GateActionHandler({
        config: CONFIG,
        store,
        engine: { resolveAndProject: async (key) => { engineCalls.push(key); } },
        now: () => new Date(AT),
        requestId: () => REQUEST_IDS[1]!,
        schedule: (job) => fixedJobs.push(job),
      });
      const directCall = () => direct.handle(event(submissionBody('직접 승자'), () => undefined));
      const fixedCall = () => fixed.handle({
        type: 'interactive',
        body: fixedButtonBody(),
        ack: () => undefined,
      } satisfies SlackSocketEvent);
      const results = firstKind === 'direct'
        ? await Promise.all([directCall(), fixedCall()])
        : await Promise.all([fixedCall(), directCall()]);
      expect(results).toContain('lost');
      expect(results).toContain('claimed');
      expect(store.findGateResolution(GATE)?.optionId).toBe(
        firstKind === 'direct' ? GATE_DIRECT_OPTION_ID : 'keep',
      );
      expect(directJobs.length + fixedJobs.length).toBe(1);
      for (const job of [...directJobs, ...fixedJobs]) await job();
      expect(engineCalls).toEqual([GATE]);
      store.close();
    }
  });
});
