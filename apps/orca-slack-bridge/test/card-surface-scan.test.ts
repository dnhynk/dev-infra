import { describe, expect, it } from 'vitest';

import { renderCard, renderThreadEvent, type RenderedCard } from '../src/digest/render.js';
import type { ProjectedPr } from '../src/digest/types.js';
import type { PrTransitionKind } from '../src/digest/transition.js';
import { GATE_DIRECT_OPTION_ID } from '../src/gate/direct-input-types.js';
import { renderGateDecisionCard } from '../src/gate/render.js';
import { renderGateResolutionCard } from '../src/gate/resolution-render.js';
import type {
  GateCardState,
  GateChannelDelivery,
  GateResolutionIntent,
  GateResolutionOutbox,
  GateResumeObservation,
} from '../src/gate/resolution-types.js';
import type { GateDecisionFacts } from '../src/gate/types.js';
import { gateKey, pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import { repositoryIdentity } from '../src/identity/repository.js';
import { fatalAlertCard } from '../src/operational/fatal-alert.js';
import { renderRunCard, renderRunCollectionCard } from '../src/run/render.js';
import type { RunFacts, UnregisteredRun } from '../src/run/types.js';
import { CARD_COLOR } from '../src/slack/card.js';
import type { SummaryResult } from '../src/summarize/index.js';
import { renderTerminalPromptCard } from '../src/terminal/render.js';
import type { TerminalPromptRecord, TerminalPromptState } from '../src/terminal/types.js';
import { visibleTexts } from './card-text.js';

/**
 * 모든 카드 표면을 한 번에 훑는다(DL-074).
 *
 * 입력에는 일부러 내부 ID(`run_`·`task_`·`gate_`·`ctx_`·`term_`), 12자 이상 hex hash, 파일 경로,
 * 오류 코드, Slack user ID를 넣는다. 카드가 그중 하나라도 보이면 실패다. 보는 것은 사람이 보는
 * 문자열(대체 텍스트, 머리, 칸, section, footer, 버튼 label)뿐이다. 버튼의 action_id·value와 PR
 * 버튼의 URL은 기계가 읽는 칸이므로 훑지 않는다.
 */

const AT = '2026-10-01T05:23:05.000Z';
const HASH = '9fdac6566fcc0a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123';

/** 보이면 안 되는 모양. 이름이 실패 메시지에 그대로 나온다. */
const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'internal id', pattern: /\b(?:run|task|gate|ctx|term)_[A-Za-z0-9]/ },
  { name: '12+ hex hash', pattern: /[0-9a-f]{12,}/i },
  { name: 'code span', pattern: /`/ },
  { name: 'mention', pattern: /<@/ },
  { name: 'mrkdwn link', pattern: /<http/ },
  { name: 'snake_case code', pattern: /\[[a-z]+(?:_[a-z]+)+\]/ },
];

function scan(name: string, card: RenderedCard, allow: readonly string[] = []): void {
  for (const text of visibleTexts(card)) {
    for (const { name: rule, pattern } of FORBIDDEN) {
      if (allow.includes(rule)) continue;
      expect(pattern.test(text), `${name}: ${rule} in ${JSON.stringify(text)}`).toBe(false);
    }
  }
  // 모양: 머리 하나, 그 뒤에는 버튼만. 본문은 색 바 attachment 하나에 있고 버튼이 없다.
  expect(card.blocks[0]?.['type'], name).toBe('header');
  for (const block of card.blocks.slice(1)) expect(block['type'], name).toBe('actions');
  expect(card.attachments, name).toHaveLength(1);
  expect(Object.values(CARD_COLOR), name).toContain(card.attachments?.[0]?.color);
  expect(JSON.stringify(card.attachments), name).not.toContain('"type":"actions"');
}

// ---- Run ----------------------------------------------------------------------------------------

const RUN_ID = 'run_36d28e6e947a';

function runFacts(over: Partial<RunFacts> = {}): RunFacts {
  const entry = {
    gateId: 'gate_a1b2c3d4e5f6',
    taskId: 'task_0a1b2c3d4e5f',
    dispatchId: 'ctx_96790c4e404e',
    messageId: 'msg_q1',
    detail: 'gate gate_a1b2c3d4e5f6 · C:/work/src/run/render.ts',
  };
  return {
    identity: {
      key: runKey(RUN_ID),
      runId: RUN_ID,
      objective: 'Slack 카드 개편',
      legacy: false,
      current: { handle: 'term_6354ef22-0000', paneKey: 'pane:now', generation: 2 },
      observed: [{
        binding: { handle: 'term_6354ef22-0000', paneKey: 'pane:now', generation: 2 },
        liveness: 'live',
        tasks: 3,
      }],
      liveness: 'live',
    },
    project: 'dev-infra',
    repositories: ['dnhynk/dev-infra'],
    observedRepositoryIds: ['ccb3c8ee-6d9e-42af-af36-9fdac6566fcc'],
    tasks: { total: 3, byStatus: [{ status: 'completed', count: 2 }, { status: 'blocked', count: 1 }] },
    dispatches: {
      total: 5,
      byStatus: [{ status: 'completed', count: 4 }, { status: 'failed', count: 1 }],
      retriedTasks: 1,
    },
    blockers: {
      badges: (['openGate', 'blockedTask', 'workerAsk', 'escalation', 'failedDispatch',
        'interactionWait'] as const).map((source) => ({ source, count: 1, entries: [entry] })),
      notObservable: [{ source: 'ciFailure', reason: 'Orca schema에 CI 전용 상태가 없다' }],
    },
    gates: [],
    degraded: [
      { kind: 'query_failed', detail: 'task-list 실패: run_36d28e6e947a', entityRefs: [HASH.slice(0, 12)] },
      { kind: 'inbox_saturated', detail: 'inbox 상한' },
    ],
    ...over,
  };
}

const UNREGISTERED: readonly UnregisteredRun[] = (
  ['query_failed', 'repository_identity_unreadable', 'multiple_project_match',
    'repository_route_blocked', 'unregistered_repository', 'repository_unobservable',
    'capacity_deferred'] as const
).map((kind, index) => ({
  runId: `run_${index}0a1b2c3d4e5`,
  runRef: HASH.slice(index, index + 12),
  repositoryIds: ['ccb3c8ee-6d9e-42af-af36-9fdac6566fcc'],
  repositoryRefs: [HASH.slice(index + 1, index + 13)],
  degraded: [{
    kind,
    detail: `${kind} for run_${index}0a1b2c3d4e5 at C:/private/path`,
    entityRefs: [HASH.slice(index + 2, index + 14)],
    counts: { observedRepositories: 1, deferredRuns: 3 },
  }],
}));

const COLLECTION = {
  degraded: [
    { kind: 'unverified_platform_assumption' as const, detail: 'run-use 가정' },
    { kind: 'unreadable_field' as const, detail: 'task task_0a1b2c3d4e5f.deps', entityRefs: [HASH.slice(3, 15)] },
    { kind: 'capacity_deferred' as const, detail: '상한', counts: { deferredRuns: 2, oldestDeferredAgeSeconds: 77 } },
  ],
  unregistered: { count: UNREGISTERED.length, runs: UNREGISTERED },
};

// ---- Gate ---------------------------------------------------------------------------------------

function gateFacts(over: Partial<GateDecisionFacts> = {}): GateDecisionFacts {
  return {
    key: gateKey('gate_a1b2c3d4e5f6'),
    gateId: 'gate_a1b2c3d4e5f6',
    runId: RUN_ID,
    taskId: 'task_0a1b2c3d4e5f',
    question: '어느 경로를 선택할까?',
    status: 'pending',
    resolution: null,
    resolvedAt: null,
    metadataState: 'matched',
    correlation: {
      askMessageId: 'msg_ask',
      questionThreadId: 'thread_question',
      dispatchId: 'ctx_96790c4e404e',
      taskId: 'task_0a1b2c3d4e5f',
      gateId: 'gate_a1b2c3d4e5f6',
    },
    options: [
      { id: 'keep', label: '기존 유지', description: '호환성을 유지한다', resolution: '기존 유지' },
      { id: 'orca_0a1b2c3d4e5f6a7b', label: '변경', description: null, resolution: '변경' },
    ],
    recommendation: { optionId: 'keep', label: '기존 유지', reason: '사용자를 보호한다' },
    impact: '후속 Task 두 개의 방향이 정해진다',
    waitingTasks: [{ taskId: 'task_1a2b3c4d5e6f', title: '후속 구현', status: 'blocked' }],
    independentTasks: [{ taskId: 'task_2a3b4c5d6e7f', title: '독립 작업', status: 'ready' }],
    unclassifiedTasks: [{ taskId: 'task_3a4b5c6d7e8f', title: '판정 불가', status: 'ready' }],
    degraded: ['Task task_3a4b5c6d7e8f의 deps를 읽지 못해 waiting/independent를 판정할 수 없다'],
    ...over,
  };
}

const GATE_CONTEXT = { runObjective: 'Slack 카드 개편', project: 'dev-infra' };

function intent(over: Partial<GateResolutionIntent> = {}): GateResolutionIntent {
  return {
    gateKey: gateKey('gate_a1b2c3d4e5f6'),
    revision: 1,
    ackState: 'acked',
    leaseOwner: null,
    leaseExpiresAt: null,
    retryRequestId: HASH,
    optionId: 'keep',
    optionResolution: '기존 유지',
    askMessageId: 'msg_ask',
    questionThreadId: 'thread_question',
    dispatchId: 'ctx_96790c4e404e',
    taskId: 'task_0a1b2c3d4e5f',
    teamId: 'T0TEAM',
    ownerUserId: 'U0OWNER',
    apiAppId: null,
    channelId: 'C0CHANNEL',
    threadTs: '1787554800.000001',
    messageTs: '1787554800.000002',
    blockId: 'orca_gate_fixed_options_v1',
    actionId: 'orca_gate_resolve_v1',
    actionValue: 'keep',
    lifecycle: 'resolved',
    mutationOwnership: 'structured',
    preRead: null,
    resolveResult: {
      gate: {
        gateId: 'gate_a1b2c3d4e5f6',
        runId: RUN_ID,
        taskId: 'task_0a1b2c3d4e5f',
        options: ['기존 유지'],
        status: 'resolved',
        resolution: '기존 유지',
        resolvedAt: AT,
      },
      mutation: { requestId: HASH, replayed: true },
    },
    postRead: null,
    lastErrorCode: 'mutation_ownership_ambiguous',
    lastErrorDetail: 'C:/private/path',
    createdAt: AT,
    updatedAt: AT,
    ...over,
  };
}

function outbox(cardState: GateCardState): GateResolutionOutbox {
  return {
    gateKey: gateKey('gate_a1b2c3d4e5f6'),
    revision: 1,
    cardState,
    cardPending: true,
    notificationState: 'pending',
    projectedAt: null,
    lastErrorCode: 'slack_failed',
    createdAt: AT,
    updatedAt: AT,
  };
}

const DELIVERY: GateChannelDelivery = {
  gateKey: gateKey('gate_a1b2c3d4e5f6'),
  runKey: runKey(RUN_ID),
  taskKey: taskKey('task_0a1b2c3d4e5f'),
  sourceDispatchId: 'ctx_96790c4e404e',
  revision: 1,
  deferredOutboxRevision: 1,
  resumeBaselineState: 'recorded',
  state: 'receipted',
  attemptCount: 1,
  lastAttemptAt: AT,
  nextAttemptAt: null,
  receiptedAt: AT,
  consumedAt: null,
  leaseOwner: null,
  leaseExpiresAt: null,
  lastErrorCode: null,
  createdAt: AT,
  updatedAt: AT,
};

const SNAPSHOT = {
  schemaVersion: 1 as const,
  sourceTaskId: 'task_0a1b2c3d4e5f',
  sourceDispatchId: 'ctx_96790c4e404e',
  candidates: [],
};

const RESUME: GateResumeObservation = {
  gateKey: gateKey('gate_a1b2c3d4e5f6'),
  revision: 1,
  baseline: SNAPSHOT,
  latest: SNAPSHOT,
  evidence: {
    kind: 'status_transition',
    taskId: 'task_1a2b3c4d5e6f',
    dispatchId: 'ctx_1a2b3c4d5e6f',
    fromStatus: 'pending',
    toStatus: 'dispatched',
  },
  nextObservationAt: null,
  observedAt: AT,
  leaseOwner: null,
  leaseExpiresAt: null,
  lastErrorCode: null,
  createdAt: AT,
  updatedAt: AT,
};

// ---- PR -----------------------------------------------------------------------------------------

const PR: ProjectedPr = {
  key: pullRequestKey(42, 184),
  repository: repositoryIdentity(42, 'dnhynk/dev-infra'),
  project: 'dev-infra',
  correlation: {
    kind: 'correlated',
    run: runKey(RUN_ID),
    task: taskKey('task_0a1b2c3d4e5f'),
    dispatch: null,
  },
  number: 184,
  title: '결제 중복 처리 방지',
  url: 'https://github.com/dnhynk/dev-infra/pull/184',
  headSha: HASH.slice(0, 40),
  checksHeadSha: HASH.slice(1, 41),
  terminal: 'open',
  isDraft: true,
  review: {
    verdict: 'request_changes',
    reviewedHeadSha: HASH.slice(2, 42),
    headMatch: 'different',
    findings: [
      { severity: 'blocker', file: 'src/payment/retry.ts', line: 88, summary: '재시도 경로에서 중복 처리가 남는다' },
      { severity: 'minor', file: 'src/payment/log.ts', line: null, summary: '로그 문구 오타' },
    ],
    findingsTotal: 3,
  },
  checks: [{ kind: 'checkRun', id: 'CR_x', appId: null, startedAt: null, completedAt: null, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', state: null }],
  mergePolicy: 'failing',
  workerReport: { outcome: 'succeeded', body: '재시도 경로를 고쳤다. 회귀 테스트를 추가했다. 리뷰를 기다린다.' },
  truncation: { prBody: true, changedFiles: true },
};

const SUMMARIES: readonly SummaryResult[] = [
  {
    kind: 'ok',
    draft: {
      title: '결제 중복 처리 방지',
      what: '같은 결제 요청이 여러 번 와도 한 번만 처리한다.',
      why: '네트워크 재시도에서 중복 결제가 날 수 있었다.',
      reviewGist: '재시도 경로를 한 번 더 막아야 한다.',
    },
    risk: 'high',
    truncated: true,
    fingerprint: HASH,
  },
  { kind: 'failed', reason: 'daemon facts-only mode', risk: 'high', fingerprint: HASH },
];

// ---- Terminal -----------------------------------------------------------------------------------

function prompt(state: TerminalPromptState): TerminalPromptRecord {
  return {
    terminalHandle: 'term_0bb89f84-bd61-4ffe-9dce-1c05d9e197f0',
    runKey: runKey(RUN_ID),
    role: 'coordinator',
    dispatchId: 'ctx_96790c4e404e',
    fingerprint: HASH,
    title: 'Windows 빌드',
    question: '이 머신에 무엇을 설치할지 결정해 주세요.',
    options: [
      { index: 1, label: '고정 Perl 설치 (권장)', description: '레포 밖 고정 경로', selected: true },
      { index: 2, label: '설치하지 않음', description: null, selected: false },
      { index: 3, label: 'Type something.', description: null, selected: false },
    ],
    cursorIndex: 1,
    channelId: 'C0DECISIONS',
    threadTs: '1788000000.000100',
    messageTs: '1788000000.000100',
    renderFingerprint: HASH.slice(0, 32),
    state,
    claimedOption: state === 'open' ? null : 2,
    claimedBy: state === 'open' ? null : 'U0OWNER',
    claimedAt: state === 'open' ? null : AT,
    settledAt: state === 'open' || state === 'claimed' ? null : AT,
    lastErrorCode: state === 'failed' ? 'screen_changed_after_move' : null,
    createdAt: AT,
    updatedAt: AT,
  };
}

describe('카드 표면 전체 스캔 (DL-074)', () => {
  // 가드가 공허하지 않은지 같은 자리에서 확인한다. 패턴이 위반을 실제로 잡고, 스캔이 attachment의
  // 칸까지 읽어야 한다. 이것이 없으면 패턴이나 helper가 망가져도 아래 테스트가 통과한다.
  it('금지 패턴은 위반을 잡고 스캔은 attachment 칸까지 읽는다', () => {
    const samples = [RUN_ID, HASH, '`code`', '<@U0OWNER>', '<https://x.example|x>', '[query_failed]'];
    for (const [index, { pattern }] of FORBIDDEN.entries()) {
      expect(pattern.test(samples[index] ?? '')).toBe(true);
    }
    expect(FORBIDDEN.some(({ pattern }) => pattern.test('10-01 14:23:05 KST 갱신 · Orca 관측 기준'))).toBe(false);
    const card = renderRunCard({ run: runFacts(), pullRequests: [], collection: COLLECTION }, AT);
    const texts = visibleTexts(card);
    expect(texts).toContain('*Project*\ndev-infra · dnhynk/dev-infra');
    expect(texts).toContain('orca-slack-bridge · 10-01 14:23:05 KST 갱신 · Orca 관측 기준');
  });

  it('Run 카드와 컬렉션 카드는 내부 ID·hash·진단 코드를 보이지 않는다', () => {
    const quiet = { badges: [], notObservable: [] };
    const variants: Record<string, RunFacts> = {
      decision: runFacts(),
      blocked: runFacts({
        blockers: { badges: runFacts().blockers.badges.filter((b) => b.source === 'blockedTask'), notObservable: [] },
      }),
      done: runFacts({ blockers: quiet, tasks: { total: 1, byStatus: [{ status: 'completed', count: 1 }] } }),
      running: runFacts({ blockers: quiet }),
      legacy: runFacts({
        blockers: quiet,
        tasks: { total: 0, byStatus: [] },
        identity: { ...runFacts().identity, legacy: true, current: null, liveness: 'unknown' },
      }),
    };
    for (const [name, run] of Object.entries(variants)) {
      scan(`run ${name}`, renderRunCard({
        run,
        pullRequests: [{
          prKey: pullRequestKey(42, 184),
          number: 184,
          firstSeenAt: AT,
          lastSeenAt: AT,
          state: { terminal: 'open', mergedAt: null, reviewVerdict: 'request_changes', observedAt: AT },
        }],
        collection: COLLECTION,
        waitingPrompts: 1,
      }, AT));
    }
    scan('collection', renderRunCollectionCard({ cards: 5, collection: COLLECTION }, AT));
  });

  it('Gate 결정 카드는 Gate·Task·Run ID와 correlation을 보이지 않는다', () => {
    const variants: Record<string, GateDecisionFacts> = {
      registered: gateFacts(),
      derived: gateFacts({ recommendation: null, impact: null }),
      missing: gateFacts({
        metadataState: 'missing',
        correlation: null,
        options: [{ id: null, label: '원문 선택지', description: null, resolution: null }],
        recommendation: null,
        impact: null,
      }),
      resolved: gateFacts({ status: 'resolved', resolution: '기존 유지', resolvedAt: AT }),
    };
    for (const [name, gate] of Object.entries(variants)) {
      scan(`gate ${name}`, renderGateDecisionCard(gate, GATE_CONTEXT));
    }
  });

  it('결정 기록 카드는 owner·mutation·correlation ID를 보이지 않는다', () => {
    for (const state of ['resolving', 'resolved', 'conflict', 'degraded'] as const) {
      scan(`resolution ${state}`, renderGateResolutionCard(intent(), outbox(state), DELIVERY, null));
    }
    scan('resolution resumed', renderGateResolutionCard(intent(), outbox('resolved'), DELIVERY, RESUME));
    scan('resolution direct', renderGateResolutionCard(
      intent({ optionId: GATE_DIRECT_OPTION_ID, optionResolution: '직접 정한 결정' }),
      outbox('resolved'),
    ));
  });

  it('PR 카드와 thread 전이는 SHA·파일 경로·링크 문법을 보이지 않는다', () => {
    for (const terminal of ['open', 'closed', 'merged'] as const) {
      for (const summary of SUMMARIES) {
        const card = renderCard({ pr: { ...PR, terminal }, summary }, AT);
        scan(`pr ${terminal} ${summary.kind}`, card);
        expect(JSON.stringify(card.attachments)).not.toContain('src/payment');
        // 카드의 유일한 링크는 버튼의 URL 칸이다.
        const button = (card.blocks[1]?.['elements'] as readonly Record<string, unknown>[])[0];
        expect(button?.['url']).toBe(PR.url);
      }
    }
    const kinds: readonly PrTransitionKind[] = [
      'review_changes_requested', 'review_approved', 'checks_failing', 'checks_passing', 'merged',
    ];
    for (const kind of kinds) {
      scan(`thread ${kind}`, renderThreadEvent({
        pr: PR,
        transition: { kind, dedupeKey: `${kind}@${HASH.slice(0, 40)}`, occurredAt: kind === 'merged' ? AT : null },
        observedAt: AT,
      }));
    }
  });

  it('터미널 카드는 handle·화면 지문·고른 사람·오류 코드를 보이지 않는다', () => {
    for (const state of ['open', 'claimed', 'answered', 'failed', 'gone'] as const) {
      scan(`terminal ${state}`, renderTerminalPromptCard({ prompt: prompt(state), runLabel: 'Slack 카드 개편' }));
    }
  });

  it('치명 종료 알림만 owner mention을 싣는다', () => {
    const now = new Date(AT);
    const owned = fatalAlertCard('discovery.schema_drift', 'U0OWNER', now);
    scan('fatal owner', owned, ['mention']);
    expect(visibleTexts(owned).filter((text) => text.includes('<@U0OWNER>'))).toHaveLength(2);
    scan('fatal anonymous', fatalAlertCard('observer.unknown_failure', null, now));
  });
});
