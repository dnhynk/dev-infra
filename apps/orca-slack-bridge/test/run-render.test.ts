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

/**
 * D1-B Run 카드 renderer.
 *
 * 확정 계약을 고정한다. **여기서 깨지는 것은 표현이 아니라 결정이다.**
 *
 * - OD-069 퍼센트·완료율·비율 progress bar가 출력 어디에도 없다.
 * - OD-069 `Dispatch attempts`가 Task 수와 분리돼 나온다.
 * - OD-067 고유 blocker 총합이 없고 원천별 badge에 연결 ID가 함께 나온다.
 * - `run/types.ts` `failedDispatch`·`escalation`이 현재 blocker와 구분돼 나온다.
 * - OD-020 live/stale/unknown 세 값이 서로 다르게 그려진다.
 * - OD-072 degraded가, OD-078 미등록 Run 수가 카드에 나온다.
 * - OD-078 미등록 Run 항목이 degraded를 함께 싣어 "조회 실패"와 "등록에 없음"이 다른 카드가 된다.
 * - 관측 시각을 카드 어디에도 그리지 않는다(`store/schema.ts` 지문 규칙).
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

/** 카드가 실제로 표시하는 문자열 전부. fallback text와 모든 section text를 합친다. */
function cardText(card: { text: string; blocks: readonly Record<string, unknown>[] }): string {
  const sections = card.blocks.map((b) => {
    const t = b['text'] as { text?: string } | undefined;
    return t?.text ?? JSON.stringify(b);
  });
  return [card.text, ...sections].join('\n');
}

/**
 * 라벨로 block 하나를 고른다. 절이 서로 다른 block인지 보는 데 쓴다.
 *
 * section과 context를 모두 본다. 두 절이 서로 다른 block이어야 한다는 요구(OD-069)는 block
 * **종류**가 아니라 block이 나뉘어 있느냐의 요구다.
 */
function sectionWith(
  card: { blocks: readonly Record<string, unknown>[] },
  label: string,
): string {
  const found = card.blocks
    .map((b) => {
      const direct = (b['text'] as { text?: string } | undefined)?.text;
      if (direct !== undefined) return direct;
      const elements = b['elements'];
      return Array.isArray(elements)
        ? (elements as readonly Record<string, unknown>[])
          .map((e) => String(e['text'] ?? '')).join('\n')
        : '';
    })
    .filter((t) => t.startsWith(`*${label}*`));
  expect(found).toHaveLength(1);
  return found[0] as string;
}

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

  it('분모와 상태별 수를 각각 다른 줄에 적는다', () => {
    const progress = sectionWith(renderRunCard(input()), '진행');
    expect(progress).toContain('task-list.count 10');
    expect(progress).toContain('completed 6');
    expect(progress).toContain('blocked 1');
  });

  it('실행 중 추가된 Task가 분모에 즉시 반영된다', () => {
    // 집계는 D1-A가 하고 renderer는 그 값을 옮기기만 한다. 값이 늘면 카드가 늘어야 한다.
    const grown = facts({ tasks: { total: 12, byStatus: [{ status: 'ready', count: 12 }] } });
    expect(sectionWith(renderRunCard(input({ run: grown })), '진행')).toContain(
      'task-list.count 12',
    );
  });

  it('Task 상태가 하나도 없어도 분모는 그린다', () => {
    const empty = facts({ tasks: { total: 0, byStatus: [] } });
    const progress = sectionWith(renderRunCard(input({ run: empty })), '진행');
    expect(progress).toContain('task-list.count 0');
    expect(progress).toContain('관측된 Task 상태 없음');
  });
});

describe('Dispatch attempts 분리 (OD-069)', () => {
  it('Task 절과 다른 block이고 서로의 수를 섞지 않는다', () => {
    const card = renderRunCard(input());
    const progress = sectionWith(card, '진행');
    const attempts = sectionWith(card, 'Dispatch attempts');

    expect(progress).not.toBe(attempts);
    // Task 절에 attempt 수가 없다.
    expect(progress).not.toContain('attempts');
    expect(progress).not.toContain('71');
    // attempt 절에 Task 분모가 없다.
    expect(attempts).not.toContain('task-list.count');
    expect(attempts).toContain('attempts 71');
    expect(attempts).toContain('재시도가 있었던 Task 4');
  });

  it('retry가 Task 수를 늘리지 않는다는 것을 카드가 말한다', () => {
    expect(sectionWith(renderRunCard(input()), 'Dispatch attempts')).toContain(
      'retry는 Task 수를 늘리지 않는다',
    );
  });

  it('Task 분모와 attempt 수를 더한 값이 카드에 없다', () => {
    // 10 + 71 = 81. 두 축을 더하는 소비자가 있으면 그것이 OD-069 위반이다.
    expect(cardText(renderRunCard(input()))).not.toMatch(/\b81\b/);
  });
});

describe('blocker badge (OD-067)', () => {
  it('원천별 badge에 연결 ID가 함께 나온다', () => {
    // 현재 시제 blocker는 카드 맨 위 "사람이 필요하다" 절로 올라갔다. 절 이름이 바뀌었을 뿐
    // 원천별 badge와 연결 ID를 함께 싣는다는 요구는 그대로다.
    const current = sectionWith(renderRunCard(input()), '사람이 필요하다');

    expect(current).toContain('open Gate 2');
    expect(current).toContain('gate gate_a1');
    expect(current).toContain('task task_t1');
    expect(current).toContain('blocked Task 3');
    expect(current).toContain('task task_b2');
  });

  it('ask badge는 message ID와 dispatch ID까지 노출한다', () => {
    const windowed = sectionWith(renderRunCard(input()), 'blocker · 관찰 창 안에서만 판정');
    expect(windowed).toContain('worker ask 1');
    expect(windowed).toContain('message msg_q1');
    expect(windowed).toContain('dispatch ctx_q1');
  });

  it('고유 blocker 총합을 만들지 않는다', () => {
    const text = cardText(renderRunCard(input()));

    // openGate 2 + blockedTask 3 = 5. 어떤 badge 줄도 이 합을 말하지 않는다.
    expect(text).not.toMatch(/blocker[^\n]*\b5\b/);
    expect(text).not.toMatch(/총합|합계|blocker 총|전체 blocker/);
    // 일곱 원천 전부를 더한 21도 없다.
    expect(text).not.toMatch(/\b21\b/);
  });

  it('agentWait를 permission으로 단정하지 않는다', () => {
    const text = cardText(renderRunCard(input()));
    expect(text).toContain('interaction 대기 1');
    expect(text).not.toMatch(/permission/i);
    expect(text).not.toMatch(/권한 승인|권한 요청/);
  });

  it('항목이 많은 badge는 자른 사실을 드러낸다', () => {
    const history = sectionWith(renderRunCard(input()), 'blocker · 누적 이력 (현재 blocker가 아니다)');
    expect(history).toContain('failed Dispatch 13');
    // 누적 이력은 원천당 한 건만 보인다. 잘린 사실을 드러낸다는 요구는 그대로다.
    expect(history).toContain('외 12건은 카드에 싣지 않았다');
  });

  it('관측 불가는 0건 badge로 그리지 않는다', () => {
    const card = renderRunCard(input());
    const notObservable = sectionWith(card, 'blocker · 이 관측 표면에서 만들 수 없음');
    expect(notObservable).toContain('ciFailure');
    // CI failure를 0으로 그리면 "CI 실패 없음"이라는 거짓을 말한다.
    expect(cardText(card)).not.toMatch(/CI failure 0|ciFailure 0/);
  });

  it('원천이 하나도 없으면 그 사실을 적고 0 badge를 만들지 않는다', () => {
    const clean = facts({ blockers: { badges: [], notObservable: [] } });
    const card = renderRunCard(input({ run: clean }));
    expect(sectionWith(card, 'blocker · 현재 상태')).toContain('관측된 원천 없음');
    expect(cardText(card)).not.toContain('open Gate 0');
  });
});

describe('누적 이력과 현재 blocker 구분 (run/types.ts)', () => {
  it('failedDispatch와 escalation이 현재 상태 절에 나오지 않는다', () => {
    const card = renderRunCard(input());
    const current = sectionWith(card, '사람이 필요하다');

    expect(current).not.toContain('failed Dispatch');
    expect(current).not.toContain('escalation');
    expect(current).not.toContain('13');
  });

  it('누적 이력 절이 그 성격을 문구로 말한다', () => {
    const history = sectionWith(
      renderRunCard(input()),
      'blocker · 누적 이력 (현재 blocker가 아니다)',
    );
    expect(history).toContain('failed Dispatch 13');
    expect(history).toContain('escalation 1');
    // 요구는 이 수가 현재 blocker가 아님을 카드가 말하는 것이다. 절 라벨이 그 말을 하고 있으면
    // 같은 내용을 문단으로 반복할 필요가 없다.
    expect(history).toContain('현재 blocker가 아니다');
  });

  it('ask는 관찰 창 절에 있고, inbox 포화일 때만 확정으로 읽지 말라고 적는다', () => {
    const base = input();

    // 포화가 관측된 Run에서만 경고가 붙는다. 이 수를 확정으로 읽으면 안 되는 조건이 그때 성립한다.
    const saturated = renderRunCard({
      ...base,
      run: {
        ...base.run,
        degraded: [{ kind: 'inbox_saturated', detail: 'inbox가 상한에 닿았다' }],
      },
    });
    const windowed = sectionWith(saturated, 'blocker · 관찰 창 안에서만 판정');
    expect(windowed).toContain('inbox_saturated');
    expect(windowed).toContain('확정으로 읽지 않는다');

    // 포화가 아니면 붙이지 않는다. 해당되지 않는 카드에서 사실을 밀어내지 않기 위해서다.
    const clean = renderRunCard({ ...base, run: { ...base.run, degraded: [] } });
    expect(sectionWith(clean, 'blocker · 관찰 창 안에서만 판정'))
      .not.toContain('확정으로 읽지 않는다');
  });
});

describe('live / stale / unknown (OD-020)', () => {
  const rendered = (liveness: BindingLiveness): string =>
    cardText(renderRunCard(input({ run: facts({ identity: identity({ liveness }) }) })));

  it('세 값이 서로 다른 emoji·라벨·설명으로 그려진다', () => {
    const live = rendered('live');
    const stale = rendered('stale');
    const unknown = rendered('unknown');

    expect(live).not.toEqual(stale);
    expect(stale).not.toEqual(unknown);
    expect(live).not.toEqual(unknown);

    expect(live).toContain('🟢 live');
    expect(stale).toContain('⚫ stale');
    expect(unknown).toContain('⚪ unknown');
  });

  it('unknown을 stale처럼 그리지 않는다. 판정 불가라고 적는다', () => {
    const unknown = rendered('unknown');
    expect(unknown).toContain('판정 불가');
    expect(unknown).toContain('live로도 stale로도 접지 않는다');
    // stale의 근거 문구가 unknown 카드의 Run 판정 줄에 새지 않는다.
    expect(unknown).not.toContain('소유자 binding ⚫ stale');
  });

  it('관측된 binding마다 세대와 그 세대가 만든 Task 수를 그린다', () => {
    const id = sectionWith(renderRunCard(input()), 'Run identity');
    // binding 계보는 한 줄로 접혔다. 세대와 그 세대가 만든 Task 수를 함께 그린다는 요구는 그대로다.
    expect(id).toContain('⚫ stale gen 1 term_29548394 · Task 39');
    expect(id).toContain('🟢 live gen 2 term_6354ef22 · Task 24');
    expect(id).toContain('현재 소유자 generation 2');
  });

  it('generation을 읽지 못하면 읽지 못했다고 적는다', () => {
    const card = renderRunCard(
      input({ run: facts({ identity: identity({ current: null, liveness: 'unknown' }) }) }),
    );
    expect(sectionWith(card, 'Run identity')).toContain(
      'Run row의 현재 소유자를 읽지 못했다',
    );
  });

  it('binding을 하나도 관측하지 못하면 그 사실을 적는다', () => {
    const card = renderRunCard(
      input({ run: facts({ identity: identity({ observed: [], liveness: 'unknown' }) }) }),
    );
    expect(sectionWith(card, 'Run identity')).toContain('관측된 binding 없음');
  });
});

describe('identity 표시 (OD-047)', () => {
  it('Project와 Repository를 둘 다 표시한다', () => {
    expect(runIdentityLine(facts())).toBe('[dev-infra] dnhynk/dev-infra');
    expect(cardText(renderRunCard(input()))).toContain('[dev-infra] dnhynk/dev-infra');
  });

  it('등록된 repository가 여럿이면 모두 표시한다', () => {
    const many = facts({ repositories: ['dnhynk/dev-infra', 'dnhynk/other'] });
    expect(runIdentityLine(many)).toBe('[dev-infra] dnhynk/dev-infra, dnhynk/other');
  });

  it('Project는 있는데 등록 repository가 없으면 Project만 표시한다', () => {
    expect(runIdentityLine(facts({ repositories: [] }))).toBe('[dev-infra]');
  });

  it('Project가 없으면 관측된 Orca repository id를 그대로 보여준다', () => {
    const orphan = facts({ project: null, repositories: [] });
    expect(runIdentityLine(orphan)).toBe(`(등록 Project 없음) orca:${REPO_ID}`);
  });

  it('Project도 관측된 id도 없으면 둘 다 없다고 적는다', () => {
    const blank = facts({ project: null, repositories: [], observedRepositoryIds: [] });
    expect(runIdentityLine(blank)).toContain('관측된 Orca repository id 없음');
  });

  it('Run ID와 objective가 headline과 fallback text에 함께 있다', () => {
    const card = renderRunCard(input());
    expect(card.text).toContain(RUN_ID);
    expect(card.text).toContain('Slack Bridge D1 Run Observer');
    expect(card.text).toContain('[dev-infra] dnhynk/dev-infra');
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
    const section = sectionWith(renderRunCard(input({ pullRequests: [pr()] })), 'PR');
    expect(section).toContain('#25 ✅ 병합 완료 · 리뷰 통과');
  });

  it('terminal 세 값과 verdict 두 값을 서로 다르게 그린다', () => {
    const rows = [
      pr({ prKey: pullRequestKey(1057758478, 9), number: 9, state: { terminal: 'open', mergedAt: null, reviewVerdict: 'request_changes', observedAt: OBSERVED_AT } }),
      pr({ prKey: pullRequestKey(1057758478, 10), number: 10, state: { terminal: 'closed', mergedAt: null, reviewVerdict: null, observedAt: OBSERVED_AT } }),
      pr(),
    ];
    const section = sectionWith(renderRunCard(input({ pullRequests: rows })), 'PR');
    expect(section).toContain('#9 🟡 열림 · 리뷰에서 수정 요청');
    expect(section).toContain('#10 ⛔ 병합 없이 닫힘 · 리뷰 결과 없음');
    expect(section).toContain('#25 ✅ 병합 완료 · 리뷰 통과');
    // 번호 오름차순이다. `pr_key` 사전순이면 #10이 #9보다 앞선다.
    expect(section.indexOf('#9')).toBeLessThan(section.indexOf('#10'));
  });

  it('pr_state 행이 없으면 terminal을 추측하지 않는다', () => {
    const section = sectionWith(
      renderRunCard(input({ pullRequests: [pr({ state: null })] })),
      'PR',
    );
    expect(section).toContain('#25 — 상태 기록 없음');
    expect(section).not.toContain('열림');
  });

  it('목록이 비면 "PR 없음"이 아니라 "store에 기록된 PR 없음"이라고 적는다', () => {
    const section = sectionWith(renderRunCard(input()), 'PR');
    expect(section).toContain('store에 기록된 PR 없음');
  });

  it('관측 경계를 카드가 숨기지 않는다', () => {
    const section = sectionWith(renderRunCard(input({ pullRequests: [pr()] })), 'PR');
    expect(section).toContain('correlation에 성공한 PR만');
  });
});

describe('degraded와 미등록 Run (OD-072, OD-078)', () => {
  it('이 Run의 degraded와 관찰 전체의 degraded를 모두 그린다', () => {
    const section = sectionWith(renderRunCard(input()), 'degraded');
    expect(section).toContain('[liveness_unknown]');
    expect(section).toContain('[unverified_platform_assumption]');
  });

  it('degraded가 없어도 절을 지우지 않는다', () => {
    const clean = renderRunCard(
      input({
        run: facts({ degraded: [] }),
        collection: {
          degraded: [],
          unregistered: { count: 0, runs: [] },
        },
      }),
    );
    const section = sectionWith(clean, 'degraded');
    expect(section).toContain('이 Run');
    expect(section).toContain('관찰 전체');
    // 비었을 때는 범위 이름과 같은 줄에 적는다. 두 범위를 합치지 않는 것이 요구다.
    expect(section).toContain('이 Run · 없음');
    expect(section).toContain('관찰 전체 · 없음');
  });

  it('D1-A가 싣는 degraded 종류가 카드에서 사라지지 않는다', () => {
    const kinds: RunDegraded[] = [
      { kind: 'query_failed', detail: 'task-list 실패' },
      { kind: 'repository_unobservable', detail: 'Task도 worker도 없다' },
      { kind: 'unregistered_repository', detail: '설정에 없다' },
      { kind: 'multiple_project_match', detail: '두 Project에 걸쳐 있다' },
      { kind: 'unreadable_field', detail: 'task task_1의 deps를 읽지 못했다' },
      { kind: 'liveness_unknown', detail: '대조할 binding이 없다' },
      { kind: 'inbox_saturated', detail: 'inbox가 상한에 닿았다' },
      { kind: 'unverified_platform_assumption', detail: '미검증 가정' },
    ];
    const section = sectionWith(
      renderRunCard(input({ run: facts({ degraded: kinds }) })),
      'degraded',
    );
    for (const d of kinds) expect(section).toContain(`[${d.kind}]`);
  });

  it('미등록 Run 수가 0이어도 그린다', () => {
    expect(sectionWith(renderRunCard(input()), '등록되지 않은 Run')).toContain('0');
  });

  it('미등록 Run이 있으면 수와 관측된 id를 함께 그린다', () => {
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
    const section = sectionWith(card, '등록되지 않은 Run');
    expect(section).toContain('run_aaa');
    expect(section).toContain('other-id');
    expect(section).toContain('run_bbb');
    // 요구는 수와 관측된 id가 함께 드러나는 것이다. 설정 key 이름을 카드가 가르치는 것이 아니다.
    expect(section).toContain('2');
    expect(section).toContain('관측된 Orca repository id');
  });

  it('구조화 ref가 지원 상한을 넘으면 누락 수를 밝히고 Slack 한계를 지킨다', () => {
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

    // 요구는 전체 규모와 누락 수를 숨기지 않는 것이다. 표기는 사람이 읽는 우리말 절이다.
    expect(text).toContain('관측된 repository 257');
    expect(text).toContain('1건은 싣지 않았다');
    expect(text).toContain(refs[255]);
    expect(text).not.toContain(refs[256]);
    expect(text.indexOf('관측된 repository 257')).toBeLessThan(text.indexOf(refs[0] as string));
    expect(card.blocks.length).toBeLessThanOrEqual(50);
    for (const block of card.blocks) {
      const sectionText = (block['text'] as { text?: string } | undefined)?.text;
      if (sectionText !== undefined) expect(sectionText.length).toBeLessThanOrEqual(3_000);
    }
  });
  /*
   * 이것이 회귀 방지다. 이 절이 degraded를 버리던 동안 아래 세 경우는 **바이트 동일한 카드**였고
   * 셋 다 "등록하라"고 지시했다. 그러면 OD-078의 완화 장치가 다른 사건을 함께 세게 되고,
   * 그 수가 조용한 실패를 관측 가능하게 만든다는 근거가 무너진다(OD-072).
   */
  it('조회 실패·빈 Run·미등록이 서로 다른 카드가 된다', () => {
    const card = (run: UnregisteredRun) =>
      renderRunCard(
        input({
          collection: {
            degraded: COLLECTION_DEGRADED,
            unregistered: { count: 1, runs: [run] },
          },
        }),
      );
    // 조회가 실패해 등록 여부를 판정할 수 없다.
    const unjudged = card({
      runId: 'run_aaa',
      repositoryIds: [],
      degraded: [
        { kind: 'query_failed', detail: 'task-list 실패: orca가 비정상 종료했다' },
        {
          kind: 'repository_unobservable',
          detail: 'Orca 조회가 실패해 repository id를 관측하지 못했다. 등록 여부를 판정할 수 없다',
        },
      ],
    });
    // 조회에는 성공했고 Task도 worker도 없어 id가 관측되지 않았다.
    const empty = card({
      runId: 'run_aaa',
      repositoryIds: [],
      degraded: [
        {
          kind: 'repository_unobservable',
          detail: 'Task도 worker도 없어 Orca repository id를 관측하지 못했다',
        },
      ],
    });
    // 조회했더니 등록에 없다.
    const missing = card({
      runId: 'run_aaa',
      repositoryIds: ['other-id'],
      degraded: [
        { kind: 'unregistered_repository', detail: '관측된 Orca repository id가 설정에 없다: other-id' },
      ],
    });

    const label = '등록되지 않은 Run';
    const [a, b, c] = [unjudged, empty, missing].map((x) => sectionWith(x, label));
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
    // 지문까지 갈린다. 갈리지 않으면 게시 경계에서도 두 사건이 한 카드로 접힌다.
    expect(new Set([unjudged, empty, missing].map(renderFingerprint)).size).toBe(3);

    expect(a).toContain('[query_failed]');
    expect(a).toContain('등록 여부를 판정할 수 없다');
    expect(b).not.toContain('[query_failed]');
    expect(b).toContain('Task도 worker도 없어');
    expect(c).toContain('[unregistered_repository]');
  });

  // 조회에 실패한 Run에게 "등록하라"고 지시하면 판정하지 못한 것을 판정한 것처럼 말한다.
  it('미등록 절이 모든 항목에 등록을 지시하지 않는다', () => {
    const section = sectionWith(
      renderRunCard(
        input({
          collection: {
            degraded: COLLECTION_DEGRADED,
            unregistered: {
              count: 1,
              runs: [
                { runId: 'run_aaa', repositoryIds: [], degraded: [{ kind: 'query_failed', detail: 'task-list 실패' }] },
              ],
            },
          },
        }),
      ),
      '등록되지 않은 Run',
    );
    // 요구는 조회 실패를 미등록으로 단정하지 않는 것이다. 각 줄이 자기 kind를 밝히면 족하고,
    // 카드가 kind의 뜻을 설명할 필요는 없다.
    expect(section).toContain('query_failed');
    expect(section).not.toContain('등록해야');
    expect(section).not.toContain('등록하라');
  });
});

/*
 * 관측 시각(OD-072가 아니라 `store/schema.ts`의 지문 규칙).
 *
 * 렌더 지문은 카드에 실제로 표시하는 값에서만 계산한다. 관찰마다 움직이는 값을 카드에 두면
 * 사실이 그대로여도 매 실행이 `chat.update`를 만들고 `publish.ts`의 `skip`이 실운영에서
 * 영원히 발화하지 않는다.
 */
describe('관측 시각을 카드에 두지 않는다', () => {
  const pr = (at: string): RunPullRequestRecord => ({
    prKey: pullRequestKey(1057758478, 27),
    number: 27,
    firstSeenAt: '2026-08-24T01:00:00.000Z',
    lastSeenAt: at,
    state: { terminal: 'open', mergedAt: null, reviewVerdict: null, observedAt: at },
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
    expect(sectionWith(after, 'PR')).toContain('#27 🟡 열림');
  });

  it('pr_state 행이 없을 때도 시각 없이 그 경계를 적는다', () => {
    const section = sectionWith(
      renderRunCard(input({ pullRequests: [{ ...pr(OBSERVED_AT), state: null }] })),
      'PR',
    );
    expect(section).toContain('digest가 이 PR의 상태를 아직 관측하지 않았다');
    expect(section).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
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

  it('mrkdwn 예약 문자를 blocks와 fallback text에서 같게 이스케이프한다', () => {
    const hostile = facts({
      identity: identity({ objective: '<!channel> & <http://x|x>' }),
    });
    const card = renderRunCard(input({ run: hostile }));
    expect(card.text).not.toContain('<!channel>');
    expect(card.text).toContain('&lt;!channel&gt; &amp;');
    expect(cardText(card)).not.toContain('<!channel>');
  });

  it('section text가 Slack 상한을 넘지 않고 잘린 사실을 드러낸다', () => {
    const huge = facts({
      degraded: Array.from({ length: 200 }, (_, i) => ({
        kind: 'query_failed' as const,
        detail: `${i} ${'가'.repeat(150)}`,
      })),
    });
    const card = renderRunCard(input({ run: huge }));
    for (const b of card.blocks) {
      const t = (b['text'] as { text?: string } | undefined)?.text ?? '';
      expect(t.length).toBeLessThanOrEqual(3000);
    }
    expect(sectionWith(card, 'degraded')).toContain('표시 한도 3000자를 넘어 잘림');
  });

  it('objective가 비어도 카드를 만든다', () => {
    const card = renderRunCard(input({ run: facts({ identity: identity({ objective: '' }) }) }));
    expect(card.text).toContain('(objective 없음)');
  });

  it('legacy Run은 조회하지 않았다는 사실을 적는다', () => {
    const card = renderRunCard(
      input({
        run: facts({
          identity: identity({ legacy: true, observed: [], liveness: 'unknown' }),
          tasks: { total: 0, byStatus: [] },
        }),
      }),
    );
    expect(sectionWith(card, 'Run identity')).toContain('legacy Run이다');
  });

  it('action block을 만들지 않는다. D1-B에 interaction handler가 없다', () => {
    const card = renderRunCard(input());
    expect(card.blocks.some((b) => b['type'] === 'actions')).toBe(false);
  });
});
