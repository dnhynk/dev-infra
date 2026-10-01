import { describe, expect, it } from 'vitest';
import {
  renderRunCard,
  renderRunCollectionCard,
  runIdentityLine,
  type RunCardInput,
} from '../src/run/render.js';
import { renderFingerprint } from '../src/digest/render.js';
import { pullRequestKey, runKey } from '../src/identity/keys.js';
import type { RunPullRequestRecord } from '../src/store/schema.js';
import type {
  BindingLiveness,
  BlockerBadge,
  RunDegraded,
  RunFacts,
  RunIdentityFacts,
  UnregisteredRun,
} from '../src/run/types.js';
import {
  allBlocks,
  cardText,
  fieldValue,
  footerText,
  headerText,
  sectionTexts,
} from './card-text.js';

/**
 * D1-B Run 카드 renderer.
 *
 * 확정 계약을 고정한다. **여기서 깨지는 것은 표현이 아니라 결정이다.**
 *
 * - OD-069 퍼센트·완료율·비율 progress bar가 출력 어디에도 없다.
 * - OD-069 Task 상태별 수와 분모가 다른 칸이고, Dispatch attempts가 Task 수와 분리돼 나온다.
 * - OD-067 고유 blocker 총합이 없고 원천별 수가 따로 나온다. 연결 ID는 `runs` 보고에 있다(DL-074).
 * - `run/types.ts` `failedDispatch`·`escalation`이 현재 blocker와 구분돼 나온다.
 * - OD-020 live/stale/unknown 세 값이 서로 다르게 그려진다.
 * - OD-072 degraded가, OD-078 미등록 Run 수가 카드에 나온다.
 * - OD-078 미등록 사유가 컬렉션 카드에서 "조회 실패"와 "등록에 없음"을 가른다.
 * - 갱신 시각은 입력으로만 받는다. 지문은 시각을 비운 렌더에서 계산한다(DL-074).
 */

const RUN_ID = 'run_36d28e6e947a';
const REPO_ID = 'ccb3c8ee-6d9e-42af-af36-9fdac6566fcc';
const OBSERVED_AT = '2026-08-24T05:00:00.000Z';

function identity(over: Partial<RunIdentityFacts> = {}): RunIdentityFacts {
  return {
    key: runKey(RUN_ID),
    runId: RUN_ID,
    objective: 'Slack Bridge D1 Run Observer',
    legacy: false,
    current: { handle: 'term_6354ef22', paneKey: 'pane:now', generation: 2 },
    observed: [
      {
        binding: { handle: 'term_29548394', paneKey: 'pane:old', generation: 1 },
        liveness: 'stale',
        tasks: 39,
      },
      {
        binding: { handle: 'term_6354ef22', paneKey: 'pane:now', generation: 2 },
        liveness: 'live',
        tasks: 24,
      },
    ],
    liveness: 'live',
    ...over,
  };
}

/**
 * 실측(2026-08-24, `run_36d28e6e947a`)에 맞춘 fixture.
 *
 * 활성 Dispatch가 1건뿐인 정상 Run인데 `failedDispatch`가 13이다. 이 수를 현재 blocker로 그리면
 * 완주한 Run이 막힌 것으로 읽힌다 — 그것이 이 fixture가 잡는 실패다.
 *
 * **badge 수를 일부러 2와 3으로 둔다.** 둘을 더한 5가 카드 어디에도 나오면 안 된다(OD-067).
 */
function badges(): BlockerBadge[] {
  return [
    {
      source: 'openGate',
      count: 2,
      entries: [
        {
          gateId: 'gate_a1',
          taskId: 'task_t1',
          dispatchId: null,
          messageId: null,
          detail: '구독 취소 시 권한 종료 시점',
        },
        {
          gateId: 'gate_a2',
          taskId: null,
          dispatchId: null,
          messageId: null,
          detail: '두 번째 Gate',
        },
      ],
    },
    {
      source: 'blockedTask',
      count: 3,
      entries: [
        { gateId: null, taskId: 'task_b1', dispatchId: null, messageId: null, detail: 'b1' },
        { gateId: null, taskId: 'task_b2', dispatchId: null, messageId: null, detail: 'b2' },
        { gateId: null, taskId: 'task_b3', dispatchId: null, messageId: null, detail: 'b3' },
      ],
    },
    {
      source: 'workerAsk',
      count: 1,
      entries: [
        {
          gateId: null,
          taskId: 'task_q1',
          dispatchId: 'ctx_q1',
          messageId: 'msg_q1',
          detail: '계약을 확인해 달라',
        },
      ],
    },
    {
      source: 'escalation',
      count: 1,
      entries: [
        {
          gateId: null,
          taskId: 'task_e1',
          dispatchId: 'ctx_e1',
          messageId: 'msg_e1',
          detail: 'Blocked: gh 인증',
        },
      ],
    },
    {
      source: 'failedDispatch',
      count: 13,
      entries: Array.from({ length: 13 }, (_, i) => ({
        gateId: null,
        taskId: `task_f${i}`,
        dispatchId: `ctx_f${i}`,
        messageId: null,
        detail: 'failed',
      })),
    },
    {
      source: 'interactionWait',
      count: 1,
      entries: [
        {
          gateId: null,
          taskId: 'task_w1',
          dispatchId: 'ctx_w1',
          messageId: null,
          detail: 'agent: codex-interactive-prompt',
        },
      ],
    },
  ];
}

function facts(over: Partial<RunFacts> = {}): RunFacts {
  return {
    identity: identity(),
    project: 'dev-infra',
    repositories: ['dnhynk/dev-infra'],
    observedRepositoryIds: [REPO_ID],
    tasks: {
      total: 10,
      byStatus: [
        { status: 'completed', count: 6 },
        { status: 'dispatched', count: 2 },
        { status: 'blocked', count: 1 },
        { status: 'ready', count: 1 },
      ],
    },
    dispatches: {
      total: 71,
      byStatus: [
        { status: 'completed', count: 57 },
        { status: 'failed', count: 13 },
        { status: 'dispatched', count: 1 },
      ],
      retriedTasks: 4,
    },
    blockers: {
      badges: badges(),
      notObservable: [{ source: 'ciFailure', reason: 'Orca schema에 CI 전용 상태가 없다' }],
    },
    gates: [],
    degraded: [
      { kind: 'liveness_unknown', detail: 'Task가 없어 Run row와 대조할 binding이 없다' },
    ],
    ...over,
  };
}

const COLLECTION_DEGRADED: RunDegraded[] = [
  {
    kind: 'unverified_platform_assumption',
    detail: 'live/stale 판정은 run-use가 consumer_generation을 올린다는 미검증 가정 위에 있다',
  },
];

function input(over: Partial<RunCardInput> = {}): RunCardInput {
  return {
    run: facts(),
    pullRequests: [],
    collection: {
      degraded: COLLECTION_DEGRADED,
      unregistered: { count: 0, runs: [] },
    },
    ...over,
  };
}

/** blocker 원천이 하나도 없는 정상 Run. */
const QUIET = facts({ blockers: { badges: [], notObservable: [] } });

describe('진행률 표현 (OD-069)', () => {
  it('퍼센트도 완료율도 비율 progress bar도 만들지 않는다', () => {
    const text = cardText(renderRunCard(input()));

    // 퍼센트 기호와 단어.
    expect(text).not.toMatch(/%/);
    // 영어 단어는 단어 경계로 감싼다. degraded kind `inbox_saturated`가 `rate`를 부분
    // 문자열로 담고 있어, 경계 없는 패턴은 관계없는 사실을 위반으로 잡는다.
    expect(text).not.toMatch(/퍼센트|완료율|성공률|비율/);
    expect(text).not.toMatch(/\bpercent\b|\bratio\b|\brate\b/i);
    // 가드가 공허하지 않은지 같은 자리에서 확인한다. 위 패턴이 위반 문구를 실제로 잡고,
    // `inbox_saturated`는 잡지 않아야 한다. 이것이 없으면 패턴이 망가져도 테스트가 통과한다.
    expect('success rate 60').toMatch(/\bpercent\b|\bratio\b|\brate\b/i);
    expect('inbox_saturated').not.toMatch(/\bpercent\b|\bratio\b|\brate\b/i);
    expect('완료율 60').toMatch(/퍼센트|완료율|성공률|비율/);
    // `6 / 10` 같은 분수 표기. 그 표기 자체가 비율로 읽힌다.
    expect(text).not.toMatch(/\d\s*\/\s*\d/);
    // 비율을 전제하는 그래픽 bar.
    expect(text).not.toMatch(/[█▓▒░■□▰▱]/);
  });

  it('상태별 수와 분모를 서로 다른 칸에 적는다', () => {
    const card = renderRunCard(input());
    expect(fieldValue(card, 'Task 상태')).toBe('완료 6\n진행 2\n막힘 1\n준비 1');
    expect(fieldValue(card, 'Task 전체')).toBe('10개');
  });

  it('실행 중 추가된 Task가 분모에 즉시 반영된다', () => {
    // 집계는 D1-A가 하고 renderer는 그 값을 옮기기만 한다. 값이 늘면 카드가 늘어야 한다.
    const grown = facts({ tasks: { total: 12, byStatus: [{ status: 'ready', count: 12 }] } });
    expect(fieldValue(renderRunCard(input({ run: grown })), 'Task 전체')).toBe('12개');
  });

  it('Task 상태가 하나도 없어도 분모는 그리고 모르는 status는 원문으로 둔다', () => {
    const empty = renderRunCard(input({ run: facts({ tasks: { total: 0, byStatus: [] } }) }));
    expect(fieldValue(empty, 'Task 상태')).toBe('없음');
    expect(fieldValue(empty, 'Task 전체')).toBe('0개');
    const odd = renderRunCard(
      input({ run: facts({ tasks: { total: 1, byStatus: [{ status: 'paused<x>', count: 1 }] } }) }),
    );
    expect(fieldValue(odd, 'Task 상태')).toBe('paused&lt;x&gt; 1');
  });
});

describe('Dispatch attempts 분리 (OD-069)', () => {
  it('Task 칸과 다른 칸이고 서로의 수를 섞지 않는다', () => {
    const card = renderRunCard(input());
    const dispatch = fieldValue(card, 'Dispatch') ?? '';
    expect(dispatch.split('\n')[0]).toBe('시도 71 · 재시도 Task 4');
    // Task 칸에 attempt 수가 없다.
    expect(fieldValue(card, 'Task 상태')).not.toContain('71');
    expect(fieldValue(card, 'Task 전체')).not.toContain('71');
    // attempt 칸에 Task 분모가 없다.
    expect(dispatch).not.toContain('10개');
  });

  it('Task 분모와 attempt 수를 더한 값이 카드에 없다', () => {
    // 10 + 71 = 81. 두 축을 더하는 소비자가 있으면 그것이 OD-069 위반이다.
    expect(cardText(renderRunCard(input()))).not.toMatch(/\b81\b/);
  });
});

describe('blocker 원천 (OD-067)', () => {
  it('사람이 필요한 현재 원천을 원천별 수로 싣는다', () => {
    const card = renderRunCard(input({ waitingPrompts: 1 }));
    expect(fieldValue(card, '사람 필요')).toBe(
      'Gate 결정 대기 2건\n터미널 답변 대기 1대\ninteraction 대기 1건\n막힌 Task 3개',
    );
  });

  it('blocker 연결 ID와 binding handle을 카드에 싣지 않는다', () => {
    const text = cardText(renderRunCard(input()));
    for (const id of ['gate_a1', 'task_t1', 'task_b2', 'ctx_q1', 'msg_q1', 'task_f0', 'term_6354ef22',
      'term_29548394', RUN_ID, REPO_ID]) {
      expect(text).not.toContain(id);
    }
  });

  it('고유 blocker 총합을 만들지 않는다', () => {
    const text = cardText(renderRunCard(input()));

    // openGate 2 + blockedTask 3 = 5. 어떤 줄도 이 합을 말하지 않는다.
    expect(text).not.toMatch(/\b5\b/);
    expect(text).not.toMatch(/총합|합계|blocker 총|전체 blocker/);
    // 일곱 원천 전부를 더한 21도 없다.
    expect(text).not.toMatch(/\b21\b/);
  });

  it('agentWait를 permission으로 단정하지 않는다', () => {
    const text = cardText(renderRunCard(input()));
    expect(text).toContain('interaction 대기 1건');
    expect(text).not.toMatch(/permission/i);
    expect(text).not.toMatch(/권한 승인|권한 요청/);
  });

  it('CI는 0건으로 그리지 않고 판정하는 자리를 가리킨다', () => {
    const card = renderRunCard(input());
    // CI failure를 0으로 그리면 "CI 실패 없음"이라는 거짓을 말한다.
    expect(fieldValue(card, 'CI')).toBe('확인 불가 · PR 카드 기준');
    expect(cardText(card)).not.toMatch(/CI failure 0|ciFailure/);
  });

  it('원천이 하나도 없으면 없다고 적고 0 badge를 만들지 않는다', () => {
    const card = renderRunCard(input({ run: QUIET }));
    expect(fieldValue(card, '사람 필요')).toBe('없음');
    expect(cardText(card)).not.toContain('Gate 결정 대기 0');
  });
});

describe('누적 이력과 현재 blocker 구분 (run/types.ts)', () => {
  it('failedDispatch와 escalation은 사람 필요가 아니라 Dispatch 칸의 이력이다', () => {
    const card = renderRunCard(input());
    const needs = fieldValue(card, '사람 필요') ?? '';
    expect(needs).not.toContain('실패');
    expect(needs).not.toContain('escalation');
    expect(needs).not.toContain('13');
    expect((fieldValue(card, 'Dispatch') ?? '').split('\n')).toContain(
      '실패 이력 13 · escalation 이력 1',
    );
  });

  it('worker 질문은 관찰 창 기준이고, inbox 포화일 때만 확정이 아니라고 적는다', () => {
    const base = input();
    const saturated = renderRunCard({
      ...base,
      run: {
        ...base.run,
        degraded: [{ kind: 'inbox_saturated', detail: 'inbox가 상한에 닿았다' }],
      },
    });
    expect(fieldValue(saturated, 'Dispatch')).toContain('worker 질문 1 · 관찰 창 기준 · 확정 아님');

    // 포화가 아니면 붙이지 않는다. 해당되지 않는 카드에서 사실을 밀어내지 않기 위해서다.
    const clean = renderRunCard({ ...base, run: { ...base.run, degraded: [] } });
    expect(fieldValue(clean, 'Dispatch')).toContain('worker 질문 1 · 관찰 창 기준');
    expect(fieldValue(clean, 'Dispatch')).not.toContain('확정 아님');
  });
});

describe('카드 종류', () => {
  it('Gate가 열려 있으면 결정 필요이고 결정 채널을 가리킨다', () => {
    const card = renderRunCard(input());
    expect(headerText(card)).toBe('❓  결정 필요 · Slack Bridge D1 Run Observer');
    expect(card.attachments?.[0]?.color).toBe('#bf8700');
    expect(sectionTexts(card)).toEqual([
      'Gate 2건이 결정을 기다립니다 → 결정 채널의 카드에서 고르세요.',
    ]);
  });

  it('답을 기다리는 터미널이나 interaction 대기도 결정 필요다', () => {
    const prompts = renderRunCard(input({ run: QUIET, waitingPrompts: 2 }));
    expect(headerText(prompts).startsWith('❓  결정 필요')).toBe(true);
    expect(sectionTexts(prompts)).toEqual([
      '터미널 2대가 답을 기다립니다 → 결정 채널의 카드에서 고르세요.',
    ]);
    const waiting = renderRunCard(input({
      run: facts({ blockers: { badges: badges().filter((b) => b.source === 'interactionWait'), notObservable: [] } }),
    }));
    expect(headerText(waiting).startsWith('❓  결정 필요')).toBe(true);
  });

  it('막힌 Task만 있으면 막힘이다', () => {
    const card = renderRunCard(input({
      run: facts({ blockers: { badges: badges().filter((b) => b.source === 'blockedTask'), notObservable: [] } }),
    }));
    expect(headerText(card).startsWith('⛔  막힘')).toBe(true);
    expect(card.attachments?.[0]?.color).toBe('#cf222e');
    expect(sectionTexts(card)).toEqual([
      'Task 3개가 막혀 있습니다 → runs 명령에서 막힌 Task를 확인하세요.',
    ]);
  });

  it('Task가 전부 완료면 Task 완료, 아니면 진행 중, Task가 없으면 확인 불가다', () => {
    const done = renderRunCard(input({
      run: facts({ ...QUIET, tasks: { total: 1, byStatus: [{ status: 'completed', count: 1 }] } }),
    }));
    expect(headerText(done).startsWith('✅  Task 완료')).toBe(true);
    expect(done.attachments?.[0]?.color).toBe('#1a7f37');

    const running = renderRunCard(input({ run: QUIET }));
    expect(headerText(running).startsWith('🔵  진행 중')).toBe(true);
    expect(running.attachments?.[0]?.color).toBe('#2f81f7');
    expect(sectionTexts(running)).toEqual([]);

    const unknown = renderRunCard(input({
      run: facts({ ...QUIET, tasks: { total: 0, byStatus: [] } }),
    }));
    expect(headerText(unknown).startsWith('⚪  확인 불가')).toBe(true);
    expect(unknown.attachments?.[0]?.color).toBe('#6e7781');
  });
});

describe('live / stale / unknown (OD-020)', () => {
  const rendered = (liveness: BindingLiveness): string | undefined =>
    fieldValue(
      renderRunCard(input({ run: facts({ identity: identity({ liveness }) }) })),
      '코디네이터',
    );

  it('세 값이 서로 다른 문구로 그려진다', () => {
    expect(rendered('live')).toBe('연결 확인 · 2세대');
    expect(rendered('stale')).toBe('더 높은 세대로 인수됨 · 2세대');
    expect(rendered('unknown')).toBe('확인 불가 · 2세대');
  });

  it('generation을 읽지 못하면 읽지 못했다고 적는다', () => {
    const card = renderRunCard(
      input({ run: facts({ identity: identity({ current: null, liveness: 'unknown' }) }) }),
    );
    expect(fieldValue(card, '코디네이터')).toBe('확인 불가 · 세대 읽기 실패');
  });

  it('판정 불가의 이유는 관측 상태 칸이 이름으로 싣는다', () => {
    const card = renderRunCard(input());
    expect(fieldValue(card, '관측 상태')).toBe('이 Run 주의 1건 · 전체 주의 1건\n세대 판정 불가');
  });
});

describe('identity 표시 (OD-047)', () => {
  it('Project와 Repository를 둘 다 표시한다', () => {
    expect(runIdentityLine(facts())).toBe('[dev-infra] dnhynk/dev-infra');
    const card = renderRunCard(input());
    expect(fieldValue(card, 'Project')).toBe('dev-infra · dnhynk/dev-infra');
    expect(card.text).toContain('[dev-infra] dnhynk/dev-infra');
  });

  it('등록된 repository가 여럿이면 모두 표시한다', () => {
    const many = facts({ repositories: ['dnhynk/dev-infra', 'dnhynk/other'] });
    expect(runIdentityLine(many)).toBe('[dev-infra] dnhynk/dev-infra, dnhynk/other');
    expect(fieldValue(renderRunCard(input({ run: many })), 'Project')).toBe(
      'dev-infra · dnhynk/dev-infra · dnhynk/other',
    );
  });

  it('Project는 있는데 등록 repository가 없으면 그 사실을 적는다', () => {
    expect(runIdentityLine(facts({ repositories: [] }))).toBe('[dev-infra]');
    expect(fieldValue(renderRunCard(input({ run: facts({ repositories: [] }) })), 'Project')).toBe(
      'dev-infra · 저장소 미등록',
    );
  });

  it('Project가 없으면 관측된 Orca repository id를 그대로 보여준다', () => {
    const orphan = facts({ project: null, repositories: [] });
    expect(runIdentityLine(orphan)).toBe(`(등록 Project 없음) orca:${REPO_ID}`);
  });

  it('Project도 관측된 id도 없으면 둘 다 없다고 적는다', () => {
    const blank = facts({ project: null, repositories: [], observedRepositoryIds: [] });
    expect(runIdentityLine(blank)).toContain('관측된 Orca repository id 없음');
  });

  it('objective가 머리이고 대체 텍스트에 판정·identity와 함께 있다. Run ID는 없다', () => {
    const card = renderRunCard(input());
    expect(card.text).toBe(
      '❓ 결정 필요 · [dev-infra] dnhynk/dev-infra · Slack Bridge D1 Run Observer',
    );
    expect(card.text).not.toContain(RUN_ID);
  });
});

describe('관련 PR 상태', () => {
  const pr = (over: Partial<RunPullRequestRecord> = {}): RunPullRequestRecord => ({
    prKey: pullRequestKey(1057758478, 25),
    number: 25,
    firstSeenAt: '2026-08-24T01:00:00.000Z',
    lastSeenAt: '2026-08-24T04:00:00.000Z',
    state: {
      terminal: 'merged',
      mergedAt: '2026-08-24T03:00:00.000Z',
      reviewVerdict: 'approve',
      observedAt: '2026-08-24T04:00:00.000Z',
    },
    ...over,
  });

  it('store에 저장된 terminal과 review verdict를 그린다', () => {
    expect(fieldValue(renderRunCard(input({ pullRequests: [pr()] })), 'PR')).toBe(
      '#25 병합 완료 · 리뷰 통과',
    );
  });

  it('terminal 세 값과 verdict 두 값을 서로 다르게 그린다', () => {
    const rows = [
      pr({ prKey: pullRequestKey(1057758478, 9), number: 9, state: { terminal: 'open', mergedAt: null, reviewVerdict: 'request_changes', observedAt: OBSERVED_AT } }),
      pr({ prKey: pullRequestKey(1057758478, 10), number: 10, state: { terminal: 'closed', mergedAt: null, reviewVerdict: null, observedAt: OBSERVED_AT } }),
      pr(),
    ];
    // 순서는 store가 정한 번호 오름차순 그대로다. `pr_key` 사전순이면 #10이 #9보다 앞선다.
    expect(fieldValue(renderRunCard(input({ pullRequests: rows })), 'PR')).toBe(
      '#9 열림 · 수정 요청\n#10 병합 없이 닫힘 · 리뷰 결과 없음\n#25 병합 완료 · 리뷰 통과',
    );
  });

  it('pr_state 행이 없으면 terminal을 추측하지 않는다', () => {
    const value = fieldValue(renderRunCard(input({ pullRequests: [pr({ state: null })] })), 'PR');
    expect(value).toBe('#25 상태 기록 없음');
  });

  it('목록이 비면 "PR 없음"이 아니라 "기록 없음"이라고 적는다', () => {
    expect(fieldValue(renderRunCard(input()), 'PR')).toBe('기록 없음');
  });
});

describe('degraded와 미등록 Run (OD-072, OD-078)', () => {
  it('degraded가 없어도 칸을 지우지 않는다', () => {
    const clean = renderRunCard(
      input({
        run: facts({ degraded: [] }),
        collection: {
          degraded: [],
          unregistered: { count: 0, runs: [] },
        },
      }),
    );
    // 두 범위를 합치지 않는 것이 요구다.
    expect(fieldValue(clean, '관측 상태')).toBe('이 Run 정상 · 전체 정상');
  });

  it('D1-A가 싣는 degraded 종류가 이름으로 남고 [kind] 코드는 싣지 않는다', () => {
    const kinds: RunDegraded[] = [
      { kind: 'query_failed', detail: 'task-list 실패' },
      { kind: 'repository_unobservable', detail: 'Task도 worker도 없다' },
      { kind: 'unregistered_repository', detail: '설정에 없다' },
      { kind: 'multiple_project_match', detail: '두 Project에 걸쳐 있다' },
      { kind: 'unreadable_field', detail: 'task task_1의 deps를 읽지 못했다' },
      { kind: 'unreadable_field', detail: 'task task_2의 deps를 읽지 못했다' },
      { kind: 'liveness_unknown', detail: '대조할 binding이 없다' },
      { kind: 'inbox_saturated', detail: 'inbox가 상한에 닿았다' },
      { kind: 'unverified_platform_assumption', detail: '미검증 가정' },
    ];
    const card = renderRunCard(input({ run: facts({ degraded: kinds }) }));
    expect(fieldValue(card, '관측 상태')).toBe([
      '이 Run 주의 9건 · 전체 주의 1건',
      '조회 실패',
      '저장소 관측 불가',
      '미등록 저장소',
      '여러 Project 일치',
      '읽지 못한 칸 · 2건',
      '세대 판정 불가',
      'inbox 한도 도달 · 미답 질문 판정 보류',
      '플랫폼 가정 미검증',
    ].join('\n'));
    expect(cardText(card)).not.toMatch(/\[[a-z]+(?:_[a-z]+)+\]/);
    expect(cardText(card)).not.toContain('task_1');
  });

  it('미등록 Run 수가 0이어도 그린다', () => {
    expect(fieldValue(renderRunCard(input()), '미등록 Run')).toBe('0건');
  });

  it('미등록 Run이 있으면 수와 관찰 요약을 가리키고 ID는 싣지 않는다', () => {
    const card = renderRunCard(
      input({
        collection: {
          degraded: COLLECTION_DEGRADED,
          unregistered: {
            count: 2,
            runs: [
              { runId: 'run_aaa', repositoryIds: ['other-id'], degraded: [] },
              { runId: 'run_bbb', repositoryIds: [], degraded: [] },
            ],
          },
        },
      }),
    );
    expect(fieldValue(card, '미등록 Run')).toBe('2건 · 관찰 요약 참고');
    expect(cardText(card)).not.toContain('run_aaa');
    expect(cardText(card)).not.toContain('other-id');
  });
});

describe('컬렉션 카드 (OD-080)', () => {
  const collection = (runs: readonly UnregisteredRun[], degraded: readonly RunDegraded[] = []) =>
    renderRunCollectionCard({
      cards: 1,
      collection: { degraded, unregistered: { count: runs.length, runs } },
    });

  it('미등록 Run을 사유별 수로 접고 Run마다 가장 앞선 사유로 한 번만 센다', () => {
    const run = (kinds: RunDegraded['kind'][]): UnregisteredRun => ({
      runId: '',
      runRef: 'aaaaaaaaaaaa',
      repositoryIds: [],
      repositoryRefs: ['bbbbbbbbbbbb'],
      degraded: kinds.map((kind) => ({ kind, detail: kind })),
    });
    const card = collection([
      run(['repository_unobservable']),
      run(['repository_unobservable']),
      // 조회가 실패했으면 무엇을 관측했든 조회 실패로 센다.
      run(['query_failed', 'repository_unobservable']),
      run(['repository_route_blocked']),
      run(['unregistered_repository']),
      run([]),
    ], [{ kind: 'inbox_saturated', detail: 'x' }]);

    expect(headerText(card)).toBe('📊  관찰 요약 · Run 카드 1장 · 미등록 6건');
    expect(card.text).toBe('관찰 요약 · Run 카드 1장 · 등록되지 않은 Run 6건');
    expect(card.attachments?.[0]?.color).toBe('#6e7781');
    expect(fieldValue(card, 'Run 카드')).toBe('1장');
    expect(fieldValue(card, '미등록 Run')).toBe('6건');
    expect(sectionTexts(card)).toEqual([
      [
        '*미등록 사유*',
        '조회 실패 1건',
        'Project 확정 불가 1건',
        '미등록 저장소 1건',
        '빈 Run · 저장소 없음 2건',
        '확인 불가 · 사유 미기록 1건',
      ].join('\n'),
      'Project를 확정하지 못한 Run 2건은 카드가 없습니다 → runs 명령에서 저장소 등록을 확인하세요. ' +
        '조회에 실패한 Run 1건은 등록 여부를 아직 판정하지 못했습니다 → 다음 관찰에서 다시 확인합니다.',
    ]);
    expect(fieldValue(card, '관측 주의')).toBe('inbox 한도 도달 · 미답 질문 판정 보류');
    // hash ref는 카드에 없다. `runs` 보고가 싣는다.
    expect(cardText(card)).not.toContain('aaaaaaaaaaaa');
    expect(cardText(card)).not.toContain('bbbbbbbbbbbb');
  });

  /*
   * 이것이 회귀 방지다. 미등록 절이 degraded를 버리던 동안 아래 세 경우는 **바이트 동일한 카드**였고
   * 셋 다 "등록하라"고 지시했다. 그러면 OD-078의 완화 장치가 다른 사건을 함께 세게 되고,
   * 그 수가 조용한 실패를 관측 가능하게 만든다는 근거가 무너진다(OD-072).
   */
  it('조회 실패·빈 Run·미등록이 서로 다른 카드가 된다', () => {
    const unjudged = collection([{
      runId: 'run_aaa',
      repositoryIds: [],
      degraded: [
        { kind: 'query_failed', detail: 'task-list 실패: orca가 비정상 종료했다' },
        {
          kind: 'repository_unobservable',
          detail: 'Orca 조회가 실패해 repository id를 관측하지 못했다. 등록 여부를 판정할 수 없다',
        },
      ],
    }]);
    const empty = collection([{
      runId: 'run_aaa',
      repositoryIds: [],
      degraded: [{
        kind: 'repository_unobservable',
        detail: 'Task도 worker도 없어 Orca repository id를 관측하지 못했다',
      }],
    }]);
    const missing = collection([{
      runId: 'run_aaa',
      repositoryIds: ['other-id'],
      degraded: [
        { kind: 'unregistered_repository', detail: '관측된 Orca repository id가 설정에 없다: other-id' },
      ],
    }]);

    // 지문까지 갈린다. 갈리지 않으면 게시 경계에서도 두 사건이 한 카드로 접힌다.
    expect(new Set([unjudged, empty, missing].map(renderFingerprint)).size).toBe(3);
    expect(sectionTexts(unjudged)[0]).toContain('조회 실패 1건');
    expect(sectionTexts(empty)[0]).toContain('빈 Run · 저장소 없음 1건');
    expect(sectionTexts(missing)[0]).toContain('미등록 저장소 1건');
    // 조회에 실패한 Run에게 "등록을 확인하라"고 지시하면 판정하지 못한 것을 판정한 것처럼 말한다.
    expect(cardText(unjudged)).not.toContain('저장소 등록을 확인하세요');
    expect(cardText(missing)).toContain('저장소 등록을 확인하세요');
    // 빈 Run은 할 일이 없다.
    expect(sectionTexts(empty)).toHaveLength(1);
  });

  it('미등록이 없어도 수를 그리고 관측 주의가 없으면 없다고 적는다', () => {
    const card = renderRunCollectionCard({
      cards: 0,
      collection: { degraded: [], unregistered: { count: 0, runs: [] } },
    });
    expect(fieldValue(card, '미등록 Run')).toBe('0건');
    expect(sectionTexts(card)).toEqual([]);
    expect(fieldValue(card, '관측 주의')).toBe('없음');
  });

  it('구조화 ref가 지원 상한을 넘어도 ref를 싣지 않고 Slack 한계를 지킨다', () => {
    const refs = Array.from({ length: 257 }, (_, index) => index.toString(16).padStart(12, '0'));
    const card = renderRunCollectionCard({
      cards: 0,
      collection: {
        degraded: [],
        unregistered: {
          count: 1,
          runs: [
            {
              runId: '',
              runRef: 'run-ref',
              repositoryIds: [],
              repositoryRefs: refs,
              degraded: [
                {
                  kind: 'multiple_project_match',
                  detail: 'route zero',
                  counts: {
                    observedRepositories: 257,
                    resolvedProjects: 2,
                    blockingReasons: 1,
                  },
                  entityRefs: refs,
                },
              ],
            },
          ],
        },
      },
    });
    const text = cardText(card);
    expect(text).toContain('여러 Project 일치 1건');
    for (const ref of [refs[0], refs[255], refs[256]]) expect(text).not.toContain(ref);
    expect(text).not.toContain('run-ref');
    expect(allBlocks(card).length).toBeLessThanOrEqual(50);
  });

  it('Run 수 상한 사유는 미룬 수를 싣고 관찰마다 움직이는 경과 시간은 싣지 않는다', () => {
    const deferred = (age: number): RunDegraded => ({
      kind: 'capacity_deferred',
      detail: `가장 오래 미뤄진 Run은 ${age}초 전 갱신됐다`,
      counts: { totalRuns: 80, deferredRuns: 16, oldestDeferredAgeSeconds: age },
    });
    const a = collection([], [deferred(30)]);
    const b = collection([], [deferred(90)]);
    expect(fieldValue(a, '관측 주의')).toBe('Run 수 상한 · 16건 미룸');
    expect(renderFingerprint(a)).toBe(renderFingerprint(b));
  });
});

/*
 * 갱신 시각(DL-074).
 *
 * 카드는 게시 직전에 찍은 갱신 시각을 싣지만 렌더 지문은 그 시각을 비운 렌더에서 계산한다.
 * 관찰마다 움직이는 값이 지문에 들어가면 사실이 그대로여도 매 실행이 `chat.update`를 만들고
 * `publish.ts`의 `skip`이 실운영에서 영원히 발화하지 않는다.
 */
describe('시각', () => {
  const pr = (at: string): RunPullRequestRecord => ({
    prKey: pullRequestKey(1057758478, 27),
    number: 27,
    firstSeenAt: '2026-08-24T01:00:00.000Z',
    lastSeenAt: at,
    state: { terminal: 'open', mergedAt: null, reviewVerdict: null, observedAt: at },
  });

  it('갱신 시각은 입력으로만 받고 KST로 적는다', () => {
    const stamped = renderRunCard(input(), '2026-10-01T05:23:05.000Z');
    expect(footerText(stamped)).toBe('orca-slack-bridge · 10-01 14:23:05 KST 갱신 · Orca 관측 기준');
    expect(footerText(renderRunCard(input()))).toBe('orca-slack-bridge · 갱신 · Orca 관측 기준');
    const collection = renderRunCollectionCard({
      cards: 0,
      collection: { degraded: [], unregistered: { count: 0, runs: [] } },
    }, '2026-10-01T05:23:05.000Z');
    expect(footerText(collection)).toBe('orca-slack-bridge · 10-01 14:23:05 KST 갱신 · 등록 Project 기준');
  });

  it('ISO8601 시각이 카드 어디에도 없다', () => {
    const text = cardText(renderRunCard(input({ pullRequests: [pr(OBSERVED_AT)] })));
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    // 가드가 공허하지 않은지 같은 자리에서 확인한다.
    expect(OBSERVED_AT).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  /*
   * `pr_state.observed_at`과 `pr_task.last_seen_at`은 **`digest`가 돌 때마다** 갱신된다.
   * 그 값이 카드에 있으면 Run 사실이 하나도 바뀌지 않아도 `digest`를 돌렸다는 이유만으로
   * 이 Run 카드가 갱신된다.
   */
  it('PR의 관측 시각만 움직여도 지문이 같다', () => {
    const before = renderRunCard(input({ pullRequests: [pr('2026-08-24T05:00:00.000Z')] }));
    const after = renderRunCard(input({ pullRequests: [pr('2026-08-24T05:10:00.000Z')] }));
    expect(renderFingerprint(after)).toBe(renderFingerprint(before));
    // PR 자체는 카드에 남아 있어야 한다. 줄을 통째로 지운 것이 아니다.
    expect(fieldValue(after, 'PR')).toBe('#27 열림 · 리뷰 결과 없음');
  });
});

describe('결정성과 안전', () => {
  it('같은 입력이면 같은 카드와 같은 지문이다', () => {
    const a = renderRunCard(input());
    const b = renderRunCard(input());
    expect(b).toEqual(a);
    expect(renderFingerprint(b)).toBe(renderFingerprint(a));
  });

  it('사실이 하나만 바뀌어도 지문이 바뀐다', () => {
    const before = renderFingerprint(renderRunCard(input()));
    const after = renderFingerprint(
      renderRunCard(input({ run: facts({ tasks: { total: 11, byStatus: [] } }) })),
    );
    expect(after).not.toBe(before);
  });

  it('mrkdwn 예약 문자를 대체 텍스트와 칸에서 이스케이프한다', () => {
    const hostile = facts({
      identity: identity({ objective: '<!channel> & <http://x|x>' }),
      project: '<!here>',
    });
    const card = renderRunCard(input({ run: hostile }));
    expect(card.text).not.toContain('<!channel>');
    expect(card.text).toContain('&lt;!channel&gt; &amp;');
    expect(fieldValue(card, 'Project')).toBe('&lt;!here&gt; · dnhynk/dev-infra');
    // 머리는 plain_text라 해석되지 않는다.
    expect((card.blocks[0]!['text'] as Record<string, unknown>)['type']).toBe('plain_text');
  });

  it('objective가 비어도 카드를 만든다', () => {
    const card = renderRunCard(input({ run: facts({ identity: identity({ objective: '' }) }) }));
    expect(card.text).toContain('(objective 없음)');
    expect(headerText(card)).toBe('❓  결정 필요 · 확인 불가 · 목표 없음');
  });

  it('legacy Run은 조회하지 않았다는 사실을 적는다', () => {
    const card = renderRunCard(
      input({
        run: facts({
          ...QUIET,
          identity: identity({ legacy: true, observed: [], liveness: 'unknown' }),
          tasks: { total: 0, byStatus: [] },
        }),
      }),
    );
    expect(fieldValue(card, '코디네이터')).toBe('확인 불가 · legacy Run');
    expect(sectionTexts(card)).toEqual(['legacy Run이라 Task·Gate·Dispatch를 조회하지 않았습니다.']);
  });

  it('action block을 만들지 않는다. D1-B에 interaction handler가 없다', () => {
    const card = renderRunCard(input());
    expect(allBlocks(card).some((b) => b['type'] === 'actions')).toBe(false);
  });
});
