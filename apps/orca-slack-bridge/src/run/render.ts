import type { RenderedCard } from '../digest/render.js';
import type { PrTerminal, ReviewerResult } from '../digest/types.js';
import {
  cut,
  esc,
  listText,
  renderCardShell,
  type CardField,
  type CardTone,
} from '../slack/card.js';
import type { RunPullRequestRecord } from '../store/schema.js';
import type {
  BindingLiveness,
  BlockerBadge,
  BlockerSource,
  DegradedKind,
  RunDegraded,
  RunFacts,
  UnregisteredRun,
  UnregisteredRuns,
} from './types.js';

/**
 * Run 카드 renderer(D1-B).
 *
 * **LLM을 호출하지 않는다.** layout, 상태 문구, 표시할 사실의 선택은 전부 이 파일의 코드가
 * 결정한다. `digest/render.ts`가 C1에서 확립한 규율 그대로이며, PR 카드와 달리 Run 카드에는
 * 모델이 만든 문자열이 **하나도** 없다. 요약 provider를 부르지 않으므로 요약 실패 경로도 없다.
 *
 * 카드에 나타나는 사실의 유일한 source는 `RunCardInput`이다. 여기서 Orca·GitHub·Slack을 다시
 * 읽지 않는다. 그래서 같은 입력이면 항상 같은 출력이고 렌더 지문이 의미를 가진다.
 *
 * 껍데기와 시각 문법은 `slack/card.ts`가 정한다(DL-074). 카드는 상태를 훑는 자리이고, Run ID·
 * binding 계보·blocker 연결 ID·degraded kind 같은 추적용 사실은 `runs` 보고
 * (`run/collect.ts`의 `formatRunCollection`)가 싣는다.
 *
 * ## "갱신" 시각
 *
 * footer는 게시 직전에 찍은 갱신 시각을 싣는다. 렌더 지문은 그 시각을 비운 렌더에서 계산한다
 * (`run/publish.ts`). 관찰 시각은 사실이 그대로여도 관찰마다 움직이므로, 지문에 넣으면 `skip`이
 * 실운영에서 영원히 발화하지 않는다. 지문에 넣지 않으므로 `skip`된 관찰은 카드를 건드리지 않고,
 * 카드의 시각은 "마지막으로 내용이 바뀌어 다시 그린 시각"이다. 그래서 동사가 `관측`이 아니라
 * `갱신`이다.
 *
 * ## 이 파일이 만들지 않는 것 — 어기면 실패다
 *
 * - **퍼센트·완료율·성공률.** `total`과 상태별 수를 따로 그리고 둘을 나눈 값을 만들지 않는다.
 *   비율을 전제하는 그래픽 progress bar도 쓰지 않는다(OD-069). 확인 방법: 이 파일에서 `/`
 *   연산자와 `percent`·`rate`·`ratio`를 검색해 나눗셈이 하나도 없어야 한다. 두 수를 `a / b`
 *   모양으로 붙이지도 않는다 — 그 표기 자체가 분수로 읽힌다.
 * - **고유 blocker 총합.** badge 수를 더하지 않는다(OD-067). 신호 집합이 배타적이지 않아
 *   더하면 한 blocker가 여러 번 셈된다.
 *
 * ## 이 파일이 반드시 만드는 것
 *
 * - **degraded는 항상 표시한다**(OD-072). `관측 상태` 칸은 비어 있어도 지우지 않는다 — 칸이
 *   사라지면 "degraded 없음"과 "degraded 칸을 만들지 않는 코드"가 같은 카드가 된다.
 * - **미등록 Run 수는 항상 표시한다**(OD-078). 0이어도 그린다. 이 수가 OD-078의 유일한 실패
 *   모드(id 형식·발급이 바뀌어 등록이 통째로 어긋남)를 관측 가능하게 만드는 장치다.
 *
 *   **경계**: 이 수는 컬렉션 수준 사실인데 이 칸의 자리는 Run 카드 안이다. 그래서 등록된 Run이
 *   하나도 없으면 Run 카드도 하나도 없고 이 수가 여기서는 나타나지 않는다. 그 구간을
 *   `renderRunCollectionCard`가 닫는다 — 등록 Run 수와 무관하게 항상 게시되는 컬렉션 카드가
 *   같은 수와 사유별 내역을 싣는다(OD-080). **두 자리의 중복은 의도다.**
 * - **live·stale·unknown을 서로 다르게 그린다.** `unknown`은 판정 불가이고 `stale`은 "더 높은
 *   generation에 인수됐다"는 판정이다. 같은 문구로 그리면 판정하지 못한 것을 판정한 것처럼
 *   말하게 된다.
 * - **`failedDispatch`와 `escalation`을 현재 blocker와 분리한다.** 둘은 누적 이력이고 만료가
 *   없다(`run/types.ts`). 실측에서 활성 Dispatch 1건뿐인 정상 Run의 `failedDispatch`가 13이었다.
 *   현재 blocker로 그리면 완주한 Run이 막힌 것으로 읽힌다. 그래서 `사람 필요`가 아니라
 *   `Dispatch` 칸에 `이력`으로 싣는다.
 *
 * 지문 계산은 `digest/render.ts`의 `renderFingerprint`를 그대로 쓴다. 두 번째 해시 구현을 만들면
 * "지문이 같다"와 "게시할 내용이 같다"가 두 곳에서 갈라진다.
 */

/** Run objective 한 줄의 상한. Orca가 상한 없이 받는 자유 문자열이다. */
const OBJECTIVE_CAP = 200;

/**
 * Run 소유자 binding 판정의 표시(OD-020).
 *
 * 세 값을 서로 다른 문구로 둔다. 색이나 emoji만으로 상태를 구분하지 않는 것이 UX §1이고,
 * `unknown`을 `stale`처럼 그리지 않는 것이 D1-A에서 확정한 구분이다. run 수준에서는 `stale`이
 * 나오지 않지만(`run/liveness.ts`) 타입이 허용하는 값은 전부 다르게 그린다.
 */
const LIVENESS: Readonly<Record<BindingLiveness, string>> = {
  live: '연결 확인',
  stale: '더 높은 세대로 인수됨',
  unknown: '확인 불가',
};

/** Orca Task status. 모르는 값은 원문 그대로 둔다 — 이름이 없다고 사실을 지우지 않는다. */
const TASK_STATUS: Readonly<Record<string, string>> = {
  pending: '대기',
  ready: '준비',
  dispatched: '진행',
  completed: '완료',
  failed: '실패',
  blocked: '막힘',
};

/** PR terminal 표시. `digest/render.ts`의 상태 머리와 같은 문구를 쓴다. */
const TERMINAL_LABEL: Readonly<Record<PrTerminal, string>> = {
  open: '열림',
  closed: '병합 없이 닫힘',
  merged: '병합 완료',
};

/**
 * reviewer verdict 표시.
 *
 * `null`은 "reviewer_result가 관찰되지 않았다"이지 "리뷰가 진행 중"이 아니다. 관찰하지 않은
 * 것을 진행 중으로 그리지 않는다(`digest/render.ts`의 `awaiting_review`와 같은 규율).
 */
const VERDICT_LABEL: Readonly<Record<ReviewerResult['verdict'], string>> = {
  approve: '리뷰 통과',
  request_changes: '수정 요청',
};

/**
 * degraded 사유의 사람용 이름.
 *
 * `[kind]` 코드는 카드에 싣지 않는다(DL-074). kind와 detail 원문은 `runs` 보고에 있다.
 */
const DEGRADED_REASON: Readonly<Record<DegradedKind, string>> = {
  query_failed: '조회 실패',
  unregistered_repository: '미등록 저장소',
  repository_unobservable: '저장소 관측 불가',
  multiple_project_match: '여러 Project 일치',
  repository_route_blocked: 'Project 확정 불가',
  repository_identity_unreadable: '저장소 판독 불가',
  capacity_deferred: 'Run 수 상한',
  remote_unverified_repository: '원격 저장소 미검증',
  unreadable_field: '읽지 못한 칸',
  liveness_unknown: '세대 판정 불가',
  inbox_saturated: 'inbox 한도 도달 · 미답 질문 판정 보류',
  unverified_platform_assumption: '플랫폼 가정 미검증',
};

/**
 * 미등록 Run의 사유. **Run 하나를 한 번만, 가장 앞선 사유로 센다.**
 *
 * 순서가 우선순위다. 조회가 실패한 Run은 무엇을 관측했든 등록 여부를 판정하지 못한 것이므로
 * 맨 앞이다. 그 구분이 OD-078의 완화 장치를 지킨다 — 조회에 실패한 Run이 미등록으로 둔갑하면
 * 미등록 수가 다른 사건을 함께 센다. 빈 Run(Task도 worker도 없음)과 표시 한도 밖의 Run은 할 일이
 * 없으므로 뒤에 둔다.
 */
const UNREGISTERED_REASONS: readonly {
  readonly label: string;
  readonly kinds: readonly DegradedKind[];
  /** 저장소 등록을 확인하면 풀리는 사유. 설명 문장이 이 수를 센다. */
  readonly actionable: boolean;
}[] = [
  { label: '조회 실패', kinds: ['query_failed'], actionable: false },
  { label: '저장소 판독 불가', kinds: ['repository_identity_unreadable'], actionable: true },
  { label: '여러 Project 일치', kinds: ['multiple_project_match'], actionable: true },
  { label: 'Project 확정 불가', kinds: ['repository_route_blocked'], actionable: true },
  { label: '미등록 저장소', kinds: ['unregistered_repository'], actionable: true },
  { label: '빈 Run · 저장소 없음', kinds: ['repository_unobservable'], actionable: false },
  { label: '표시 한도 밖', kinds: ['capacity_deferred'], actionable: false },
];

/** 사유를 하나도 싣지 않은 미등록 Run. 손으로 만든 입력에서만 나온다. */
const UNKNOWN_UNREGISTERED_REASON = '확인 불가 · 사유 미기록';

/** 카드 종류. 머리와 색 바가 이 값으로 갈린다. 기존 사실에서만 파생한다. */
type RunHead = { readonly tone: CardTone; readonly emoji: string; readonly kind: string };

const RUN_HEAD = {
  decision: { tone: 'attention', emoji: '❓', kind: '결정 필요' },
  blocked: { tone: 'error', emoji: '⛔', kind: '막힘' },
  running: { tone: 'entry', emoji: '🔵', kind: '진행 중' },
  done: { tone: 'success', emoji: '✅', kind: 'Task 완료' },
  unknown: { tone: 'status', emoji: '⚪', kind: '확인 불가' },
} as const satisfies Readonly<Record<string, RunHead>>;

/** 카드 한 장의 입력. 여기 없는 값은 카드에 나타나지 않는다. */
export type RunCardInput = {
  readonly run: RunFacts;
  /**
   * 이 Run에 연결된 PR과 저장된 상태. `RunStore.listRunPullRequests`가 준 값이다.
   *
   * **GitHub을 새로 조회하지 않는다.** 재료는 `pr_task.run_key`(OD-076)와 `pr_state`(OD-044)에
   * 이미 있다. 그래서 이 목록에는 `digest`가 관측하고 correlation에 성공한 PR만 있다.
   */
  readonly pullRequests: readonly RunPullRequestRecord[];
  readonly collection: RunCollectionContext;
  /**
   * 지금 사람의 답을 기다리는 터미널 수.
   *
   * 프롬프트 자체는 결정 채널의 별도 카드로 간다. 여기에는 수만 둔다 — Run 카드를 훑는 사람이
   * "이 Run은 사람이 필요하다"를 다른 카드를 열지 않고 알아야 하기 때문이다.
   */
  readonly waitingPrompts?: number;
};

/**
 * 관찰 1회의 컬렉션 수준 사실. **Run 카드마다 반복 표시한다.**
 *
 * 컬렉션 수준 degraded(`unverified_platform_assumption`, `inbox_saturated`, Run row의 읽지 못한
 * 칸)와 미등록 Run 수는 특정 Run에 귀속되지 않는다. 카드 한 장에만 실으면 그 Run이 사라졌을 때
 * 사실도 함께 사라지므로 모든 카드에 싣는다. 중복은 의도다.
 */
export type RunCollectionContext = {
  readonly degraded: readonly RunDegraded[];
  readonly unregistered: UnregisteredRuns;
};

/**
 * Run identity 한 줄(OD-047). 카드의 대체 텍스트가 쓴다.
 *
 * Project와 Repository를 **둘 다** 쓴다. PR 카드가 `[Project] owner/repo #N`을 쓰는 것과 같은
 * 모양이다. fallback 순서: 등록 Project가 있으면 `[Project] owner/repo …`, Project는 있는데 등록된
 * repository 목록이 비었으면 `[Project]`, Project가 없으면 관측된 Orca repository id를 그대로
 * 보여준다 — 무엇 때문에 매칭에 실패했는지가 사용자가 설정에 넣어야 할 값이다(OD-078). Run 카드는
 * 등록 Project가 있는 Run에만 만들어지므로 마지막 모양은 카드에 나타나지 않는다.
 */
export function runIdentityLine(run: RunFacts): string {
  const repositories = run.repositories.join(', ');
  if (run.project !== null) {
    return repositories === '' ? `[${run.project}]` : `[${run.project}] ${repositories}`;
  }
  return run.observedRepositoryIds.length === 0
    ? '(등록 Project 없음 · 관측된 Orca repository id 없음)'
    : `(등록 Project 없음) orca:${run.observedRepositoryIds.join(', orca:')}`;
}

function badgeOf(run: RunFacts, source: BlockerSource): BlockerBadge | null {
  return run.blockers.badges.find((badge) => badge.source === source) ?? null;
}

function projectValue(run: RunFacts): string {
  if (run.project === null) return '확인 불가 · Project 미등록';
  return [run.project, ...(run.repositories.length === 0 ? ['저장소 미등록'] : run.repositories)]
    .map(esc)
    .join(' · ');
}

function coordinatorValue(run: RunFacts): string {
  const id = run.identity;
  if (id.legacy) return '확인 불가 · legacy Run';
  // 세대 없이 판정하지 않는다. consumer_generation을 읽지 못하면 그 사실을 적는다(OD-079).
  const generation = id.current === null ? '세대 읽기 실패' : `${id.current.generation}세대`;
  return `${LIVENESS[id.liveness]} · ${generation}`;
}

/**
 * Task 상태별 수(OD-069). 분모(`task-list.count`)는 **다른 칸**에 둔다. 한 칸에 `a / b`로 붙이면
 * 그 표기가 분수로 읽히고, 그것이 이 결정이 금지한 것이다.
 */
function taskStatusValue(run: RunFacts): string {
  if (run.tasks.byStatus.length === 0) return '없음';
  return run.tasks.byStatus
    .map((s) => `${TASK_STATUS[s.status] ?? esc(s.status)} ${s.count}`)
    .join('\n');
}

/**
 * 사람이 필요한 현재 원천. **수를 더하지 않는다**(OD-067). 원천마다 한 줄이다.
 *
 * `interactionWait`를 permission이라고 부르지 않는다. 실측 `reason`은 permission 전용 enum이 아니라
 * `codex-interactive-prompt`였다. 의존성 대기(`waitingDependency`)는 사람을 부르는 원천이 아니라
 * Task 상태 `대기`와 같은 수이므로 `Task 상태` 칸이 이미 싣는다.
 */
function needsPersonLines(run: RunFacts, waitingPrompts: number): string[] {
  const gate = badgeOf(run, 'openGate');
  const interaction = badgeOf(run, 'interactionWait');
  const blocked = badgeOf(run, 'blockedTask');
  return [
    gate === null ? null : `Gate 결정 대기 ${gate.count}건`,
    waitingPrompts > 0 ? `터미널 답변 대기 ${waitingPrompts}대` : null,
    interaction === null ? null : `interaction 대기 ${interaction.count}건`,
    blocked === null ? null : `막힌 Task ${blocked.count}개`,
  ].filter((line): line is string => line !== null);
}

/**
 * Dispatch attempt 이력(OD-069)과 지나간 원천.
 *
 * **Task 칸과 다른 칸이다.** retry Dispatch는 같은 Task를 다시 dispatch하므로 이 수를 Task 수에
 * 더하면 같은 작업을 여러 번 센다. 누적 이력(`failedDispatch`·`escalation`)과 관찰 창에 걸린
 * `workerAsk`도 여기 둔다 — 셋 다 지금 사람이 할 일이 아니다.
 */
function dispatchLines(run: RunFacts): string[] {
  const lines = [`시도 ${run.dispatches.total} · 재시도 Task ${run.dispatches.retriedTasks}`];
  const failed = badgeOf(run, 'failedDispatch');
  const escalation = badgeOf(run, 'escalation');
  const history = [
    failed === null ? null : `실패 이력 ${failed.count}`,
    escalation === null ? null : `escalation 이력 ${escalation.count}`,
  ].filter((part): part is string => part !== null);
  if (history.length > 0) lines.push(history.join(' · '));
  const ask = badgeOf(run, 'workerAsk');
  if (ask !== null) {
    // 미답 여부는 inbox 조회 창 안에서만 판정한다. inbox가 포화된 관찰에서는 확정으로 읽지 않는다.
    const saturated = run.degraded.some((d) => d.kind === 'inbox_saturated');
    lines.push(`worker 질문 ${ask.count} · 관찰 창 기준${saturated ? ' · 확정 아님' : ''}`);
  }
  return lines;
}

/**
 * PR 한 줄. store에 저장된 값만 옮긴다.
 *
 * **관측 시각을 적지 않는다.** `pr_state.observed_at`과 `pr_task.last_seen_at`은 `digest`가 돌 때마다
 * 갱신된다. 그 값을 카드에 그리면 Run 사실이 하나도 바뀌지 않아도 `digest`를 돌렸다는 이유만으로
 * 이 Run 카드의 지문이 바뀌고 매번 `chat.update`가 나간다.
 */
function pullRequestLine(pr: RunPullRequestRecord): string {
  // 연관은 관측했는데 상태 행이 없다. terminal을 추측해 채우지 않는다.
  if (pr.state === null) return `#${pr.number} 상태 기록 없음`;
  const verdict =
    pr.state.reviewVerdict === null ? '리뷰 결과 없음' : VERDICT_LABEL[pr.state.reviewVerdict];
  return `#${pr.number} ${TERMINAL_LABEL[pr.state.terminal]} · ${verdict}`;
}

/** 같은 kind를 한 줄로 접는다. 여러 건이면 수를 덧붙인다. 첫 등장 순서를 지킨다. */
function degradedReasonLines(degraded: readonly RunDegraded[]): string[] {
  const counts = new Map<DegradedKind, { first: RunDegraded; count: number }>();
  for (const d of degraded) {
    const seen = counts.get(d.kind);
    if (seen === undefined) counts.set(d.kind, { first: d, count: 1 });
    else seen.count += 1;
  }
  return [...counts.values()].map(({ first, count }) => {
    const deferred = first.kind === 'capacity_deferred' ? first.counts?.['deferredRuns'] : undefined;
    const reason = deferred === undefined
      ? DEGRADED_REASON[first.kind]
      : `${DEGRADED_REASON[first.kind]} · ${deferred}건 미룸`;
    return count > 1 ? `${reason} · ${count}건` : reason;
  });
}

/**
 * 관측 상태 칸(OD-072). **비어 있어도 그린다.**
 *
 * 이 Run의 degraded와 관찰 전체의 degraded를 나눠 센다. 합치면 어느 것이 이 Run에 귀속되는
 * 사실인지 잃는다. 이 Run의 사유는 이름으로 싣고, 관찰 전체의 사유는 컬렉션 카드에 있다.
 */
function observationLines(run: RunFacts, collection: RunCollectionContext): string[] {
  const own = run.degraded.length === 0 ? '이 Run 정상' : `이 Run 주의 ${run.degraded.length}건`;
  const all = collection.degraded.length === 0
    ? '전체 정상'
    : `전체 주의 ${collection.degraded.length}건`;
  return [`${own} · ${all}`, ...degradedReasonLines(run.degraded)];
}

/**
 * 카드 종류를 기존 사실에서만 고른다.
 *
 * 순서가 우선순위다. 사람의 결정을 기다리는 것(open Gate, 답을 기다리는 터미널, interaction 대기)이
 * 가장 앞이고, 막힌 Task가 그다음이다. Task가 하나도 없으면 판정할 근거가 없다.
 */
function runHead(run: RunFacts, waitingPrompts: number): RunHead {
  if (badgeOf(run, 'openGate') !== null || waitingPrompts > 0 ||
      badgeOf(run, 'interactionWait') !== null) {
    return RUN_HEAD.decision;
  }
  if (badgeOf(run, 'blockedTask') !== null) return RUN_HEAD.blocked;
  if (run.tasks.total === 0) return RUN_HEAD.unknown;
  const completed = run.tasks.byStatus.find((s) => s.status === 'completed')?.count ?? 0;
  return completed === run.tasks.total ? RUN_HEAD.done : RUN_HEAD.running;
}

/** 원인 → 행동 한 문장. 카드 종류가 사람을 부를 때만 만든다. */
function runNote(run: RunFacts, waitingPrompts: number): string | null {
  const gate = badgeOf(run, 'openGate');
  if (gate !== null) {
    return `Gate ${gate.count}건이 결정을 기다립니다 → 결정 채널의 카드에서 고르세요.`;
  }
  if (waitingPrompts > 0) {
    return `터미널 ${waitingPrompts}대가 답을 기다립니다 → 결정 채널의 카드에서 고르세요.`;
  }
  const interaction = badgeOf(run, 'interactionWait');
  if (interaction !== null) {
    return `Dispatch ${interaction.count}건이 입력을 기다립니다 → Orca에서 그 터미널을 확인하세요.`;
  }
  const blocked = badgeOf(run, 'blockedTask');
  if (blocked !== null) {
    return `Task ${blocked.count}개가 막혀 있습니다 → runs 명령에서 막힌 Task를 확인하세요.`;
  }
  if (run.identity.legacy) return 'legacy Run이라 Task·Gate·Dispatch를 조회하지 않았습니다.';
  return null;
}

/**
 * Run 카드를 그린다.
 *
 * 칸 순서를 코드가 고정한다. 순서가 흔들리면 렌더 지문이 흔들려 사실이 그대로여도
 * `chat.update`가 발생한다.
 *
 * `refreshedAt`은 게시 직전의 갱신 시각이다. null이면 시각 없이 그린다. 지문은 그 렌더에서
 * 계산한다(`run/publish.ts`).
 */
export function renderRunCard(input: RunCardInput, refreshedAt: string | null = null): RenderedCard {
  const { run, pullRequests, collection } = input;
  const waiting = input.waitingPrompts ?? 0;
  const head = runHead(run, waiting);
  // 사람이 `#agent-runs`를 훑을 때 Run을 알아보는 것은 id가 아니라 objective다.
  const objective = cut(run.identity.objective.split('\n')[0] ?? '', OBJECTIVE_CAP);
  const needs = needsPersonLines(run, waiting);
  const note = runNote(run, waiting);
  const unregistered = collection.unregistered.count;

  const fields: CardField[] = [
    ['Project', projectValue(run)],
    ['코디네이터', coordinatorValue(run)],
    ['Task 상태', taskStatusValue(run)],
    // OD-069. 분모는 상태별 수와 **다른 칸**에 둔다. 실행 중 추가된 Task가 즉시 반영된다.
    ['Task 전체', `${run.tasks.total}개`],
    ['사람 필요', needs.length === 0 ? '없음' : needs.join('\n')],
    // "PR 없음"이 아니라 "기록 없음"이다. 카드가 아는 것은 store에 기록이 없다는 사실뿐이다.
    ['PR', pullRequests.length === 0 ? '기록 없음' : pullRequests.map(pullRequestLine).join('\n')],
  ];
  const dashboard: CardField[] = [
    ['Dispatch', dispatchLines(run).join('\n')],
    // Orca schema에는 CI 전용 상태가 없다(OD-067 관측 불가 원천). 0으로 그리면 "CI 실패 없음"이라는
    // 거짓을 말하므로 판정하는 자리를 가리킨다.
    ['CI', '확인 불가 · PR 카드 기준'],
    ['관측 상태', observationLines(run, collection).join('\n')],
    // OD-078. **0이어도 그린다.** 사유별 내역은 컬렉션 카드에 있다.
    ['미등록 Run', unregistered === 0 ? '0건' : `${unregistered}건 · 관찰 요약 참고`],
  ];

  return renderCardShell({
    tone: head.tone,
    emoji: head.emoji,
    kind: head.kind,
    head: objective === '' ? '확인 불가 · 목표 없음' : objective,
    // blocks를 그리지 못하는 자리에서도 판정·identity·objective가 남아야 한다. 그 자리도 mrkdwn으로
    // 해석되므로 이스케이프한다.
    text: `${head.emoji} ${head.kind} · ${esc(runIdentityLine(run))} · ` +
      `${esc(objective === '' ? '(objective 없음)' : objective)}`,
    fields,
    sections: note === null ? [] : [note],
    dashboard,
    footer: { at: refreshedAt, verb: '갱신', basis: 'Orca 관측 기준' },
  });
}

/**
 * 컬렉션 카드 한 장의 입력(OD-080). 여기 없는 값은 카드에 나타나지 않는다.
 *
 * 관측 시각이 없다. 갱신 시각은 게시 직전에 `renderRunCollectionCard`의 둘째 인자로 찍고, 지문은
 * 그 시각을 비운 렌더에서 계산한다(`run/publish.ts`).
 */
export type RunCollectionCardInput = {
  /** 이번 관찰이 만든 Run 카드 수. `RunCollection.runs`의 길이다. */
  readonly cards: number;
  readonly collection: RunCollectionContext;
};

function unregisteredReason(run: UnregisteredRun): (typeof UNREGISTERED_REASONS)[number] | null {
  const kinds = new Set(run.degraded.map((d) => d.kind));
  return UNREGISTERED_REASONS.find((reason) => reason.kinds.some((kind) => kinds.has(kind))) ?? null;
}

/**
 * 컬렉션 카드를 그린다(OD-080).
 *
 * ## 이 카드가 존재하는 이유
 *
 * 미등록 Run 수와 컬렉션 수준 degraded는 Run 카드에도 실린다. 그런데 **등록된 Run이 하나도
 * 없으면 Run 카드도 하나도 없어 그 사실이 Slack 어디에도 나타나지 않는다.** 그 구간이 정확히
 * OD-078이 감수한 위험 — `<uuid>::<path>` 형식이나 id 발급이 바뀌어 등록이 통째로 어긋나는
 * 구간 — 이다. 완화 장치가 하필 그때 보이지 않으면 완화 장치가 아니다.
 *
 * 그래서 이 카드는 **등록 Run 수와 무관하게 항상 게시된다.**
 *
 * ## 사유별로 센다
 *
 * 미등록 Run은 사유별 수로 접는다. Run마다 한 번, 가장 앞선 사유로 센다(`UNREGISTERED_REASONS`).
 * "조회에 실패해 판정하지 못했다"와 "조회했더니 등록에 없다"는 다른 사유이므로 다른 줄이 되고
 * 렌더 지문도 갈린다. 어느 Run인지와 그 근거(hash ref, degraded detail)는 `runs` 보고에 있다.
 */
export function renderRunCollectionCard(
  input: RunCollectionCardInput,
  refreshedAt: string | null = null,
): RenderedCard {
  const { cards, collection } = input;
  const total = collection.unregistered.count;

  const counts = new Map<string, number>();
  let actionable = 0;
  let queryFailed = 0;
  for (const run of collection.unregistered.runs) {
    const reason = unregisteredReason(run);
    const label = reason?.label ?? UNKNOWN_UNREGISTERED_REASON;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (reason?.actionable === true) actionable += 1;
    if (reason?.label === '조회 실패') queryFailed += 1;
  }
  const reasonLines = [...UNREGISTERED_REASONS.map((r) => r.label), UNKNOWN_UNREGISTERED_REASON]
    .filter((label) => counts.has(label))
    .map((label) => `${label} ${counts.get(label)}건`);

  const sections: string[] = [];
  if (reasonLines.length > 0) sections.push(listText('미등록 사유', reasonLines));
  const note = [
    actionable === 0
      ? null
      : `Project를 확정하지 못한 Run ${actionable}건은 카드가 없습니다 → runs 명령에서 저장소 등록을 확인하세요.`,
    queryFailed === 0
      ? null
      : `조회에 실패한 Run ${queryFailed}건은 등록 여부를 아직 판정하지 못했습니다 → 다음 관찰에서 다시 확인합니다.`,
  ].filter((sentence): sentence is string => sentence !== null);
  if (note.length > 0) sections.push(note.join(' '));

  // 여기 싣는 것은 관찰 전체의 degraded뿐이다. Run 하나에 귀속되는 degraded는 그 Run의 카드에
  // 있고, 여기로 옮기면 어느 것이 어느 Run의 사실인지 잃는다. **비어 있어도 칸을 그린다**(OD-072).
  const observed = degradedReasonLines(collection.degraded);

  return renderCardShell({
    tone: 'status',
    emoji: '📊',
    kind: '관찰 요약',
    head: `Run 카드 ${cards}장 · 미등록 ${total}건`,
    // blocks를 그리지 못하는 자리에서도 두 수가 남아야 한다. 값이 전부 수이므로 이스케이프할 것이 없다.
    text: `관찰 요약 · Run 카드 ${cards}장 · 등록되지 않은 Run ${total}건`,
    fields: [
      ['Run 카드', `${cards}장`],
      // OD-078. **0이어도 그린다.**
      ['미등록 Run', `${total}건`],
    ],
    sections,
    dashboard: [['관측 주의', observed.length === 0 ? '없음' : observed.join('\n')]],
    footer: { at: refreshedAt, verb: '갱신', basis: '등록 Project 기준' },
  });
}
