import type { SlackBlock } from '../slack/post.js';
import type { RenderedCard } from '../digest/render.js';
import type { PrTerminal, ReviewerResult } from '../digest/types.js';
import type { RunPullRequestRecord } from '../store/schema.js';
import type {
  BindingLiveness,
  BlockerBadge,
  BlockerEntry,
  BlockerSource,
  ObservedBinding,
  RunDegraded,
  RunFacts,
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
 * - **degraded는 항상 표시한다**(OD-072). 비어 있어도 절을 지우지 않는다 — 절이 사라지면
 *   "degraded 없음"과 "degraded 절을 만들지 않는 코드"가 같은 카드가 된다.
 * - **미등록 Run 수는 항상 표시한다**(OD-078). 0이어도 그린다. 이 수가 OD-078의 유일한 실패
 *   모드(id 형식·발급이 바뀌어 등록이 통째로 어긋남)를 관측 가능하게 만드는 장치다.
 *
 *   **경계**: 이 수는 컬렉션 수준 사실인데 표시 자리는 Run 카드 안이다. 그래서 등록된 Run이
 *   하나도 없으면 카드도 하나도 없고 이 수가 어디에도 나타나지 않는다. 그 구간이 정확히
 *   "등록이 전부 어긋난" 구간이다. D1-B에는 컬렉션 수준 메시지 표면이 없어 여기서 닫지 않는다.
 *   닫는 자리는 게시 경계를 만드는 D1-C다.
 * - **live·stale·unknown을 서로 다르게 그린다.** `unknown`은 판정 불가이고 `stale`은 "더 높은
 *   generation에 인수됐다"는 판정이다. 같은 모양으로 그리면 판정하지 못한 것을 판정한 것처럼
 *   말하게 된다.
 * - **`failedDispatch`와 `escalation`을 현재 blocker와 분리한다.** 둘은 누적 이력이고 만료가
 *   없다(`run/types.ts`). 실측에서 활성 Dispatch 1건뿐인 정상 Run의 `failedDispatch`가 13이었다.
 *   현재 blocker로 그리면 완주한 Run이 막힌 것으로 읽힌다.
 *
 * ## `digest/render.ts`와 겹치는 helper
 *
 * `esc`·`cut`·`capSectionText`·`section`은 그 파일에도 같은 모양으로 있다. 그 파일은 merge된
 * C1·C2 계약이고 이 slice가 바꾸지 않으므로(그쪽 helper는 export되지 않는다) 여기 다시 적는다.
 * 규칙이 바뀌면 **두 곳을 함께 고쳐야 한다.** 지금 한 곳으로 합치지 않는 이유는 그것이 merge된
 * 파일을 건드리는 리팩터링이기 때문이다.
 *
 * 지문 계산은 `digest/render.ts`의 `renderFingerprint`를 그대로 쓴다. 그 함수는 이미 export돼
 * 있고 렌더 결과 전체를 해싱하므로 카드 종류에 의존하지 않는다. 두 번째 해시 구현을 만들면
 * "지문이 같다"와 "게시할 내용이 같다"가 두 곳에서 갈라진다.
 */

/**
 * section block `text`의 문자 수 상한. Slack이 고정한 값이다(`digest/render.ts` 참고).
 *
 * 넘기면 `chat.postMessage`가 `invalid_blocks`로 거절하고 **카드 전체가 게시되지 않는다.**
 * Run 카드에는 상한이 없는 입력이 여럿이다 — `objective`, blocker `detail`, degraded `detail`.
 */
const SECTION_TEXT_CAP = 3000;

const SECTION_TRUNCATION_MARK = '\n…(표시 한도 3000자를 넘어 잘림)';

/** Run objective 한 줄의 상한. Orca가 상한 없이 받는 자유 문자열이다. */
const OBJECTIVE_CAP = 200;

/** blocker·degraded 한 줄의 상한. 원천 문자열에 상한이 없다. */
const DETAIL_CAP = 160;

/**
 * badge 하나가 카드에 싣는 항목 수 상한.
 *
 * 실측에서 `failedDispatch` 하나가 13건이었고 Dispatch 71행 Run이 있었다. 전부 나열하면 한
 * badge가 section 상한을 먹는다. **자른 사실은 드러낸다** — 조용히 지우지 않는 것이
 * `digest/render.ts`의 findings 규칙과 같다.
 */
const ENTRY_CAP = 5;

/**
 * Slack mrkdwn 예약 문자를 이스케이프한다.
 *
 * Run objective, Task 제목, Gate question은 사람이 자유롭게 쓰는 값이다. 이스케이프하지 않은
 * `<!channel>` 하나가 카드 한 번에 workspace 전체를 깨운다.
 */
function esc(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cut(value: string, cap: number): string {
  const v = value.trim();
  return v.length <= cap ? v : `${v.slice(0, cap)}…`;
}

/**
 * section text를 Slack 상한 안으로 맞춘다. code point 경계에서 자른다.
 *
 * 근거와 경계는 `digest/render.ts`의 같은 이름 함수에 있다. 요약하면 상한은 UTF-16 code unit
 * 단위이고, code unit 가운데에서 자르면 surrogate pair가 갈라져 lone surrogate가 남는다.
 */
function capSectionText(text: string): string {
  if (text.length <= SECTION_TEXT_CAP) return text;
  const budget = SECTION_TEXT_CAP - SECTION_TRUNCATION_MARK.length;
  let end = 0;
  for (const cp of text) {
    if (end + cp.length > budget) break;
    end += cp.length;
  }
  return `${text.slice(0, end)}${SECTION_TRUNCATION_MARK}`;
}

function section(text: string): SlackBlock {
  return { type: 'section', text: { type: 'mrkdwn', text: capSectionText(text) } };
}

function labelled(label: string, lines: readonly string[]): SlackBlock {
  return section([`*${label}*`, ...lines].join('\n'));
}

/**
 * binding liveness 세 값의 표시(OD-020).
 *
 * emoji와 텍스트 라벨과 설명을 **셋 다** 다르게 둔다. 색이나 emoji만으로 상태를 구분하지
 * 않는 것이 UX §1이고, `unknown`을 `stale`처럼 그리지 않는 것이 D1-A에서 확정한 구분이다.
 *
 * run 수준에서는 `stale`이 나오지 않는다(`run/liveness.ts`가 만들지 않는다). 그래도 세 값을
 * 모두 두는 이유는 **binding 한 줄이 같은 map을 쓰기 때문이다.** binding 수준 `stale`은 Run
 * row와 직접 대조한 사실이고 카드가 그것을 그린다.
 */
const LIVENESS: Readonly<
  Record<
    BindingLiveness,
    { readonly emoji: string; readonly label: string; readonly detail: string }
  >
> = {
  live: {
    emoji: '🟢',
    label: 'live',
    detail: 'Run row의 현재 소유자 binding으로 만들어진 Task를 관측했다',
  },
  stale: {
    emoji: '⚫',
    label: 'stale',
    detail: 'generation이 Run row보다 낮다. 더 높은 generation에 인수된 binding이다',
  },
  unknown: {
    emoji: '⚪',
    label: 'unknown',
    detail:
      '판정 불가다. 대조할 binding이 없거나 Run row와 어긋난다. live로도 stale로도 접지 않는다',
  },
};

/** PR terminal 표시. `digest/render.ts`의 상태 라벨과 같은 문구를 쓴다. */
const TERMINAL_LABEL: Readonly<
  Record<PrTerminal, { readonly emoji: string; readonly label: string }>
> = {
  open: { emoji: '🟡', label: '열림' },
  closed: { emoji: '⛔', label: '병합 없이 닫힘' },
  merged: { emoji: '✅', label: '병합 완료' },
};

/**
 * reviewer verdict 표시.
 *
 * `null`은 "reviewer_result가 관찰되지 않았다"이지 "리뷰가 진행 중"이 아니다. 관찰하지 않은
 * 것을 진행 중으로 그리지 않는다(`digest/render.ts`의 `awaiting_review`와 같은 규율).
 */
const VERDICT_LABEL: Readonly<Record<ReviewerResult['verdict'], string>> = {
  approve: '리뷰 통과',
  request_changes: '리뷰에서 수정 요청',
};

/**
 * blocker 원천별 표시 이름(OD-067).
 *
 * `interactionWait`를 **permission이라고 부르지 않는다.** 실측 `reason`은 permission 전용 enum이
 * 아니라 `codex-interactive-prompt`였고, provider별 근거가 더 있을 때만 세분화한다.
 */
const BLOCKER_LABEL: Readonly<Record<BlockerSource, string>> = {
  openGate: 'open Gate',
  blockedTask: 'blocked Task',
  waitingDependency: 'waiting dependency',
  workerAsk: 'worker ask',
  escalation: 'escalation',
  failedDispatch: 'failed Dispatch',
  interactionWait: 'interaction 대기',
};

/**
 * 원천을 시제별로 나눈다. **`run/types.ts`가 정한 세 무리 그대로다.**
 *
 * 일곱 원천이 같은 시제를 말하지 않는다. 한 절에 몰아 그리면 소비자가 그 구분을 지우게 되고,
 * 그것이 정확히 D1-A가 계약에 적어 둔 금지 사항이다.
 */
const CURRENT_SOURCES: readonly BlockerSource[] = [
  'openGate',
  'blockedTask',
  'waitingDependency',
  'interactionWait',
];
const WINDOWED_SOURCES: readonly BlockerSource[] = ['workerAsk'];
const HISTORY_SOURCES: readonly BlockerSource[] = ['escalation', 'failedDispatch'];

/** 카드 한 장의 입력. 여기 없는 값은 카드에 나타나지 않는다. */
export type RunCardInput = {
  readonly run: RunFacts;
  /**
   * 이 Run에 연결된 PR과 저장된 상태. `RunStore.listRunPullRequests`가 준 값이다.
   *
   * **GitHub을 새로 조회하지 않는다.** 재료는 `pr_task.run_key`(OD-076)와 `pr_state`(OD-044)에
   * 이미 있다. 그래서 이 목록에는 `digest`가 관측하고 correlation에 성공한 PR만 있고, 카드는
   * 그 경계를 문구로 드러낸다.
   */
  readonly pullRequests: readonly RunPullRequestRecord[];
  readonly collection: RunCollectionContext;
};

/**
 * 관찰 1회의 컬렉션 수준 사실. **Run 카드마다 반복 표시한다.**
 *
 * 컬렉션 수준 degraded(`unverified_platform_assumption`, `inbox_saturated`, Run row의 읽지 못한
 * 칸)와 미등록 Run 수는 특정 Run에 귀속되지 않는다. 카드 한 장에만 실으면 그 Run이 사라졌을 때
 * 사실도 함께 사라지므로 모든 카드에 싣는다. 중복은 의도다.
 */
export type RunCollectionContext = {
  /** ISO8601. `RunCollection.observedAt` 그대로다. */
  readonly observedAt: string;
  readonly degraded: readonly RunDegraded[];
  readonly unregistered: UnregisteredRuns;
};

/**
 * 카드 최상단 identity(OD-047).
 *
 * Project와 Repository를 **둘 다** 표시한다. PR 카드가 `[Project] owner/repo #N`을 쓰는 것과
 * 같은 모양이고, Run은 PR 번호 자리에 Run ID가 온다.
 *
 * fallback 순서: 등록 Project가 있으면 `[Project] owner/repo …`, Project는 있는데 등록된
 * repository 목록이 비었으면 `[Project]`, Project가 없으면 관측된 Orca repository id를 그대로
 * 보여준다. **마지막 자리에 빈 문자열을 두지 않는다** — 무엇 때문에 매칭에 실패했는지가
 * 사용자가 설정에 넣어야 할 값이다(OD-078).
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

/** blocker 항목 한 줄. **연결 ID를 함께 노출한다**(OD-067). */
function entryLine(e: BlockerEntry): string {
  const ids = [
    e.gateId === null ? null : `gate ${e.gateId}`,
    e.taskId === null ? null : `task ${e.taskId}`,
    e.dispatchId === null ? null : `dispatch ${e.dispatchId}`,
    e.messageId === null ? null : `message ${e.messageId}`,
  ].filter((v): v is string => v !== null);
  // ID가 하나도 없으면 그 사실을 적는다. 빈 자리를 두면 어느 원천이 ID를 주지 않는지 모른다.
  const head = ids.length === 0 ? '(연결 ID 없음)' : ids.join(' · ');
  return `    ↳ ${esc(head)} — ${esc(cut(e.detail, DETAIL_CAP))}`;
}

/**
 * badge 한 무리를 줄로 만든다.
 *
 * **수를 더하지 않는다.** 각 badge의 `count`를 그대로 적고 무리 합계도 전체 합계도 만들지
 * 않는다(OD-067).
 */
function badgeLines(badges: readonly BlockerBadge[], sources: readonly BlockerSource[]): string[] {
  const lines: string[] = [];
  for (const source of sources) {
    const badge = badges.find((b) => b.source === source);
    if (badge === undefined) continue;
    lines.push(`• ${BLOCKER_LABEL[source]} ${badge.count}`);
    for (const e of badge.entries.slice(0, ENTRY_CAP)) lines.push(entryLine(e));
    if (badge.entries.length > ENTRY_CAP) {
      lines.push(`    ↳ 외 ${badge.entries.length - ENTRY_CAP}건은 카드에 싣지 않았다`);
    }
  }
  return lines;
}

/** 관측된 binding 한 줄. 어느 세대가 이 Run을 실제로 움직였는지 보여준다. */
function bindingLine(b: ObservedBinding): string {
  const { emoji, label } = LIVENESS[b.liveness];
  const handle = b.binding.handle ?? '(handle 없음)';
  return (
    `• ${emoji} ${label} · generation ${b.binding.generation} · ${esc(handle)}` +
    ` · 이 binding이 만든 Task ${b.tasks}`
  );
}

/** PR 한 줄. store에 저장된 값만 옮긴다. */
function pullRequestLine(pr: RunPullRequestRecord): string {
  if (pr.state === null) {
    // 연관은 관측했는데 상태 행이 없다. terminal을 추측해 채우지 않는다.
    return `• #${pr.number} — 상태 기록 없음 (연관만 관측됨, 마지막 관측 ${esc(pr.lastSeenAt)})`;
  }
  const { emoji, label } = TERMINAL_LABEL[pr.state.terminal];
  const verdict =
    pr.state.reviewVerdict === null ? '리뷰 결과 없음' : VERDICT_LABEL[pr.state.reviewVerdict];
  return `• #${pr.number} ${emoji} ${label} · ${verdict} (관측 ${esc(pr.state.observedAt)})`;
}

function degradedLine(d: RunDegraded): string {
  return `• [${d.kind}] ${esc(cut(d.detail, DETAIL_CAP))}`;
}

/**
 * Run 카드를 그린다.
 *
 * 절 순서를 코드가 고정한다. 순서가 흔들리면 렌더 지문이 흔들려 사실이 그대로여도
 * `chat.update`가 발생한다.
 */
export function renderRunCard(input: RunCardInput): RenderedCard {
  const { run, pullRequests, collection } = input;
  const id = run.identity;
  const live = LIVENESS[id.liveness];
  const identity = runIdentityLine(run);
  const objective = cut(id.objective.split('\n')[0] ?? '', OBJECTIVE_CAP);

  const escapedIdentity = esc(identity);
  const escapedObjective = esc(objective === '' ? '(objective 없음)' : objective);

  const blocks: SlackBlock[] = [];
  blocks.push(
    section(`${live.emoji} *${escapedIdentity}* · ${esc(id.runId)} · ${escapedObjective}`),
  );

  // Run identity 절. 판정과 그 판정이 선 근거를 같은 자리에 둔다.
  const identityLines = [
    `Run ID ${esc(id.runId)}`,
    `소유자 binding ${live.emoji} ${live.label} — ${live.detail}`,
  ];
  if (id.legacy) {
    identityLines.push('legacy Run이다. Task·Gate·Dispatch를 조회하지 않았다');
  }
  identityLines.push(
    id.current === null
      ? 'Run row의 현재 소유자를 읽지 못했다 (consumer_generation 읽기 실패)'
      : `Run row의 현재 소유자 generation ${id.current.generation} · ` +
          `${esc(id.current.handle ?? '(handle 없음)')}`,
  );
  if (id.observed.length === 0) {
    identityLines.push('관측된 binding 없음 (binding을 읽은 Task가 없다)');
  } else {
    identityLines.push(...id.observed.map(bindingLine));
  }
  blocks.push(labelled('Run identity', identityLines));

  /*
   * 진행 절(OD-069).
   *
   * 분모(`task-list.count`)와 상태별 수를 **각각 다른 줄에** 적는다. 한 줄에 `a / b`로 붙이면
   * 그 표기가 분수로 읽히고, 그것이 이 결정이 금지한 것이다. 나눗셈도 퍼센트도 없다.
   */
  const taskLines = [`task-list.count ${run.tasks.total}`];
  if (run.tasks.byStatus.length === 0) {
    taskLines.push('관측된 Task 상태 없음');
  } else {
    taskLines.push(...run.tasks.byStatus.map((s) => `${esc(s.status)} ${s.count}`));
  }
  blocks.push(labelled('진행', taskLines));

  /*
   * Dispatch attempts 절(OD-069).
   *
   * **Task 절과 다른 block이다.** retry Dispatch는 같은 Task를 다시 dispatch하므로 이 수를 Task
   * 수에 더하면 같은 작업을 여러 번 센다. 두 절을 붙이면 읽는 사람이 그 덧셈을 한다.
   */
  const dispatchLines = [`attempts ${run.dispatches.total}`];
  if (run.dispatches.byStatus.length > 0) {
    dispatchLines.push(...run.dispatches.byStatus.map((s) => `${esc(s.status)} ${s.count}`));
  }
  dispatchLines.push(`재시도가 있었던 Task ${run.dispatches.retriedTasks}`);
  dispatchLines.push(
    'attempt 이력이다. retry는 Task 수를 늘리지 않으므로 진행 절과 더하지 않는다',
  );
  blocks.push(labelled('Dispatch attempts', dispatchLines));

  // PR 절. 재료는 store에 있는 것뿐이고 그 경계를 같은 자리에서 밝힌다.
  const prLines =
    pullRequests.length === 0 ? ['store에 기록된 PR 없음'] : pullRequests.map(pullRequestLine);
  prLines.push(
    'digest가 관측하고 correlation에 성공한 PR만 여기 있다. 그 밖의 PR은 이 Run이 만들었더라도' +
      ' 카드에 나타나지 않는다',
  );
  blocks.push(labelled('PR', prLines));

  /*
   * blocker 절(OD-067).
   *
   * 원천별 badge를 시제별로 세 무리로 나눈다. **고유 총합을 만들지 않는다.**
   */
  const current = badgeLines(run.blockers.badges, CURRENT_SOURCES);
  blocks.push(labelled('blocker · 현재 상태', current.length === 0 ? ['관측된 원천 없음'] : current));

  const windowed = badgeLines(run.blockers.badges, WINDOWED_SOURCES);
  if (windowed.length > 0) {
    blocks.push(
      labelled('blocker · 관찰 창 안에서만 판정', [
        ...windowed,
        '미답 여부를 inbox 조회 창 안에서만 판정했다. degraded에 inbox_saturated가 있으면 이 수를' +
          ' 확정으로 읽지 않는다',
      ]),
    );
  }

  const history = badgeLines(run.blockers.badges, HISTORY_SOURCES);
  if (history.length > 0) {
    blocks.push(
      labelled('blocker · 누적 이력 (현재 blocker가 아니다)', [
        ...history,
        '만료가 없는 수다. 이미 retry로 완료된 Task의 과거 실패와 이미 해소된 escalation도 계속' +
          ' 셈된다. 지금 막혀 있다는 뜻이 아니다',
      ]),
    );
  }

  // 0건 badge로 그리지 않는다. 0건과 관측 불가는 다르다.
  if (run.blockers.notObservable.length > 0) {
    blocks.push(
      labelled(
        'blocker · 이 관측 표면에서 만들 수 없음',
        run.blockers.notObservable.map(
          (n) => `• ${esc(n.source)} — ${esc(cut(n.reason, DETAIL_CAP))}`,
        ),
      ),
    );
  }

  /*
   * degraded 절(OD-072). **비어 있어도 그린다.**
   *
   * 이 Run의 degraded와 관찰 전체의 degraded를 나눠 적는다. 합치면 어느 것이 이 Run에 귀속되는
   * 사실인지 잃는다.
   */
  const degradedLines: string[] = ['이 Run'];
  degradedLines.push(...(run.degraded.length === 0 ? ['• 없음'] : run.degraded.map(degradedLine)));
  degradedLines.push('관찰 전체');
  degradedLines.push(
    ...(collection.degraded.length === 0 ? ['• 없음'] : collection.degraded.map(degradedLine)),
  );
  blocks.push(labelled('degraded', degradedLines));

  /*
   * 미등록 Run 절(OD-078). **0이어도 그린다.**
   *
   * 이 수가 오르는 것이 "등록 열쇠가 어긋나 Run이 조용히 사라진다"를 관측 가능하게 만드는
   * 유일한 장치다. 절을 조건부로 만들면 그 장치가 조건부가 된다.
   */
  const unregisteredLines = [`${collection.unregistered.count}`];
  if (collection.unregistered.count > 0) {
    unregisteredLines.push(
      ...collection.unregistered.runs
        .slice(0, ENTRY_CAP)
        .map(
          (u) =>
            `• ${esc(u.runId)} — 관측된 Orca repository id: ` +
            `${u.repositoryIds.length === 0 ? '없음' : esc(u.repositoryIds.join(', '))}`,
        ),
    );
    if (collection.unregistered.runs.length > ENTRY_CAP) {
      unregisteredLines.push(
        `• 외 ${collection.unregistered.runs.length - ENTRY_CAP}건은 카드에 싣지 않았다`,
      );
    }
    unregisteredLines.push(
      '설정의 projects[].orcaRepositoryIds에 없는 Run이다. 등록해야 표시 대상이 된다',
    );
  }
  blocks.push(labelled('등록되지 않은 Run', unregisteredLines));

  blocks.push(labelled('관측 시각', [esc(collection.observedAt)]));

  // blocks를 그리지 못하는 자리에서도 identity·Run ID·판정이 남아야 한다. 그 자리도 mrkdwn으로
  // 해석되므로 blocks와 같은 이스케이프를 거친 값을 쓴다.
  const text =
    `${live.emoji} ${escapedIdentity} · ${esc(id.runId)} · ${escapedObjective}` +
    ` — 소유자 binding ${live.label}`;

  return { text, blocks };
}
