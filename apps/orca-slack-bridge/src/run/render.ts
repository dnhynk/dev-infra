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
 * ## 관측 시각을 카드에 그리지 않는다
 *
 * `store/schema.ts`가 정한 규칙이다 — 렌더 지문은 카드에 실제로 표시하는 값에서만 계산한다.
 * 관찰 시각은 사실이 그대로여도 관찰마다 움직이므로, 카드에 두면 지문이 매번 달라져
 * `publish.ts`의 `skip`이 실운영에서 영원히 발화하지 않는다. 그래서 `RunCollectionContext`에
 * 관측 시각을 두지 않는다 — 입력에 없어야 다시 그려지지 않는다.
 *
 * 지문에서만 빼고 카드에는 남기는 것은 답이 아니다. 그러면 `skip`된 관찰에서 카드가 낡은
 * 시각을 표시하게 되어 신선도를 거짓말한다.
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
 *   **경계**: 이 수는 컬렉션 수준 사실인데 이 절의 표시 자리는 Run 카드 안이다. 그래서 등록된
 *   Run이 하나도 없으면 Run 카드도 하나도 없고 이 수가 여기서는 나타나지 않는다. 그 구간이
 *   정확히 "등록이 전부 어긋난" 구간이라 그대로 두면 완화 장치가 하필 그때 사라진다. 그 구간을
 *   `renderRunCollectionCard`가 닫는다 — 등록 Run 수와 무관하게 항상 게시되는 컬렉션 카드가
 *   같은 절을 싣는다(OD-080). **두 자리의 중복은 의도다.**
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

/** Slack accepts at most 50 blocks in a message. Fixed entry/ref caps keep cards below it. */
const MESSAGE_BLOCK_CAP = 50;

/** O1's supported maximum: 16 canonical repositories × 16 exact Orca IDs. */
const STRUCTURED_REF_CAP = 256;

/** Keeps a packed ref line comfortably below a section after its label and summaries are added. */
const REFERENCE_LINE_CAP = 2_600;

/** Source failure kinds are finite; this only fences malformed hand-built renderer input. */
const UNREGISTERED_DEGRADED_CAP = 16;

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
 * 작은 글씨 한 줄.
 *
 * binding 계보나 attempt 이력처럼 **운영자가 추적할 때 필요하지만 상태를 훑을 때는 앞에 오면
 * 안 되는** 사실을 담는다. 사실을 지우는 것이 아니라 무게를 낮춘다.
 */
function context(lines: readonly string[]): SlackBlock {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: capSectionText(lines.join('  ·  ')) }],
  };
}

/** Splits logical lines across section blocks without ever slicing a structured ref token. */
function labelledSections(label: string, lines: readonly string[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  let blockIndex = 0;
  let current = [`*${label}*`];
  for (const line of lines) {
    const candidate = [...current, line].join('\n');
    if (candidate.length <= SECTION_TEXT_CAP) {
      current.push(line);
      continue;
    }
    blocks.push(section(current.join('\n')));
    blockIndex += 1;
    current = [`*${label} · 계속 ${blockIndex}*`, line];
  }
  blocks.push(section(current.join('\n')));
  return blocks;
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

/**
 * PR 한 줄. store에 저장된 값만 옮긴다.
 *
 * **관측 시각을 적지 않는다.** `pr_state.observed_at`과 `pr_task.last_seen_at`은 `digest`가 돌 때마다
 * 갱신된다 — `digest/digest.ts`가 그 관찰의 시각을 그대로 넣는다. 그 값을 카드에 그리면 **Run 사실이
 * 하나도 바뀌지 않아도 `digest`를 돌렸다는 이유만으로** 이 Run 카드의 지문이 바뀌고 매번
 * `chat.update`가 나간다. 상대 시간이나 날짜만 적는 것도 같은 이유로 안 된다 — 결국 움직인다.
 * 근거는 `store/schema.ts`의 지문 규칙이고 같은 이유로 이 파일은 관측 시각 절도 두지 않는다.
 */
function pullRequestLine(pr: RunPullRequestRecord): string {
  if (pr.state === null) {
    // 연관은 관측했는데 상태 행이 없다. terminal을 추측해 채우지 않고 그 경계를 적는다.
    return `• #${pr.number} — 상태 기록 없음 (연관만 관측됨. digest가 이 PR의 상태를 아직 관측하지 않았다)`;
  }
  const { emoji, label } = TERMINAL_LABEL[pr.state.terminal];
  const verdict =
    pr.state.reviewVerdict === null ? '리뷰 결과 없음' : VERDICT_LABEL[pr.state.reviewVerdict];
  return `• #${pr.number} ${emoji} ${label} · ${verdict}`;
}

function structuredDegradedSuffix(d: RunDegraded): string {
  const parts: string[] = [];
  if (d.counts !== undefined) {
    const counts = Object.entries(d.counts)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${esc(key)}=${value}`)
      .join(', ');
    parts.push(`counts ${counts || '없음'}`);
  }
  if (d.entityRefs !== undefined) {
    parts.push(`refs ${[...d.entityRefs].sort().map(esc).join(', ') || '없음'}`);
  }
  return parts.length === 0 ? '' : ` · ${parts.join(' · ')}`;
}

/**
 * 구조화 count를 사람이 읽는 절로 옮긴다.
 *
 * `counts blockingReasons=1, observedRepositories=1, resolvedProjects=0`은 값은 맞지만 읽는
 * 사람에게 아무 말도 하지 않는다. 알려진 key는 우리말 이름을 주고, 모르는 key는 원문 그대로
 * 남긴다 — 이름이 없다고 사실을 지우지는 않는다.
 */
const COUNT_LABEL: Readonly<Record<string, string>> = {
  observedRepositories: '관측된 repository',
  resolvedProjects: '확정된 Project',
  blockingReasons: '막은 사유',
  observedRuns: '관측된 Run',
};

function structuredCountsSuffix(d: RunDegraded): string {
  if (d.counts === undefined) return '';
  const counts = Object.entries(d.counts)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${esc(COUNT_LABEL[key] ?? key)} ${value}`)
    .join(', ');
  return counts === '' ? '' : ` · ${counts}`;
}

function degradedLine(d: RunDegraded): string {
  return `• [${d.kind}] ${esc(cut(d.detail, DETAIL_CAP))}${structuredDegradedSuffix(d)}`;
}

/**
 * 미등록 Run 한 건에 따라붙는 degraded 한 줄(OD-078, OD-072).
 *
 * **이 줄이 없으면 "조회에 실패해서 판정할 수 없다"와 "조회했더니 등록에 없다"가 바이트
 * 동일한 카드가 된다.** 그러면 OD-078의 완화 장치가 거짓을 말한다 — 그 결정이 "id 재생성으로
 * Run이 조용히 사라진다"는 위험을 감수한 유일한 근거가 "등록에 맞지 않는 Run을 세어 노출한다"인데,
 * 조회에 실패한 Run이 미등록으로 둔갑하면 그 수가 다른 사건을 함께 센다.
 *
 * 가르는 일은 `collect.ts`가 이미 했다 — `repository_unobservable` detail이 "조회가 실패했다"와
 * "Task도 worker도 없다"를 나눈다. 여기서는 그것을 그린다.
 */
function unregisteredDegradedLine(d: RunDegraded): string {
  return `    ↳ [${d.kind}] ${esc(cut(d.detail, DETAIL_CAP))}${structuredDegradedSuffix(d)}`;
}

/** Mandatory route-zero summary; potentially large ref detail is emitted afterwards. */
function unregisteredDegradedSummaryLine(d: RunDegraded): string {
  // counts는 파생 상태다. 왜 빠졌는지는 kind와 detail이 답하고, 무엇을 고칠지는 refs가 답한다.
  // `blockingReasons=1, observedRepositories=1, resolvedProjects=0`은 둘 다 아니다.
  return `    ↳ [${d.kind}] ${esc(cut(d.detail, DETAIL_CAP))}${structuredCountsSuffix(d)}`;
}

function referenceLines(label: string, refs: readonly string[]): string[] {
  const ordered = [...new Set(refs)].sort();
  const visible = ordered.slice(0, STRUCTURED_REF_CAP);
  const omitted = ordered.length - visible.length;
  const summary = `    ↳ ${label} ${ordered.length}건` +
    (omitted === 0 ? '' : ` · ${omitted}건은 싣지 않았다`);
  if (visible.length === 0) return [summary];

  const lines: string[] = [];
  let current = '        ';
  for (const ref of visible) {
    const token = esc(cut(ref, DETAIL_CAP));
    const candidate = current.endsWith('        ') ? `${current}${token}` : `${current}, ${token}`;
    if (candidate.length <= REFERENCE_LINE_CAP) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = `        ${token}`;
  }
  lines.push(current);
  return [summary, ...lines];
}

/**
 * 미등록 Run 절의 줄(OD-078). **Run 카드와 컬렉션 카드가 같은 함수를 쓴다.**
 *
 * 두 곳에 같은 모양을 따로 적으면 한쪽만 고쳐진다. 이 절이 무엇을 드러내야 하는지가
 * 카드 종류에 따라 달라지지 않으므로 함수 하나로 둔다.
 *
 * 첫 줄은 수 하나다. **0이어도 그린다.**
 */
function unregisteredLines(unregistered: UnregisteredRuns): string[] {
  const lines = [`${unregistered.count}`];
  if (unregistered.count === 0) return lines;
  for (const u of unregistered.runs.slice(0, ENTRY_CAP)) {
    const runIdentity = u.runRef ?? u.runId;
    if (u.repositoryRefs !== undefined) {
      // 사람이 먼저 보는 것은 어느 Run이 왜 빠졌는가다. `route-zero structured evidence`는 그
      // 답이 아니라 이 블록의 내부 이름이었다. 사실은 아래 줄들이 이미 싣고 있다.
      lines.push(`• ${esc(runIdentity)}`);
      const visibleDegraded = u.degraded.slice(0, UNREGISTERED_DEGRADED_CAP);
      lines.push(...visibleDegraded.map(unregisteredDegradedSummaryLine));
      if (u.degraded.length > visibleDegraded.length) {
        const omittedDegraded = u.degraded.slice(UNREGISTERED_DEGRADED_CAP);
        const omittedRefs = omittedDegraded.reduce((count, degraded) =>
          count + (degraded.entityRefs ?? []).length, 0);
        lines.push(
          `    ↳ omittedDegraded=${omittedDegraded.length}` +
            (omittedRefs === 0 ? '' : ` · omittedRefs=${omittedRefs}`),
        );
      }

      // repositoryRefs and route-block entityRefs normally name the same set. Emit the set once,
      // then only additional structured refs, so the supported maximum fits in bounded chunks.
      lines.push(...referenceLines('repository 참조', u.repositoryRefs));
      const repositoryRefs = new Set(u.repositoryRefs);
      const additionalRefs = visibleDegraded.flatMap((degraded) =>
        (degraded.entityRefs ?? []).filter((ref) => !repositoryRefs.has(ref)));
      if (additionalRefs.length > 0) {
        lines.push(...referenceLines('추가 참조', additionalRefs));
      }
    } else {
      lines.push(
        `• ${esc(runIdentity)} — 관측된 Orca repository id: ` +
          `${u.repositoryIds.length === 0 ? '없음' : esc(u.repositoryIds.join(', '))}`,
      );
      // Legacy/manual mode intentionally retains its established raw-ID display contract.
      lines.push(...u.degraded.map(unregisteredDegradedLine));
    }
  }
  if (unregistered.runs.length > ENTRY_CAP) {
    const omittedRuns = unregistered.runs.slice(ENTRY_CAP);
    const omittedRefs = omittedRuns.reduce((count, run) => count +
      (run.repositoryRefs ?? []).length + run.degraded.reduce((sum, degraded) =>
        sum + (degraded.entityRefs ?? []).length, 0), 0);
    lines.push(
      `• omittedRuns=${omittedRuns.length}` + (omittedRefs === 0 ? '' : ` · omittedRefs=${omittedRefs}`),
    );
  }
  // 카드가 자기 사용법을 설명하지 않는다. 각 줄의 degraded kind가 이미 판정 근거이고, 그 kind의
  // 뜻은 문서가 가진다. 매 카드에 같은 문단을 붙이면 사실보다 설명이 길어진다.
  return lines;
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
  // 사람이 `#agent-runs`를 훑을 때 Run을 알아보는 것은 id가 아니라 objective다. objective가
  // 본문 첫 줄이고 identity·id·liveness 라벨은 바로 아래 작은 줄로 접힌다. 세 사실 모두 남는다.
  blocks.push(section(`${live.emoji} *${escapedObjective}*`));
  blocks.push(context([escapedIdentity, esc(id.runId), `${live.emoji} ${live.label}`]));

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
  // binding 계보는 소유권을 추적할 때 필요한 사실이지 Run을 훑을 때 먼저 볼 것이 아니다.
  // liveness 판정 자체는 위 헤더 줄에 이미 라벨로 나와 있고, 여기에는 그 판정의 근거가 남는다.
  blocks.push(context(['*Run identity*', ...identityLines]));

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
  // OD-069. 두 수를 더해 읽는 것을 막는 유일한 문구다.
  dispatchLines.push('_retry는 Task 수를 늘리지 않는다_');
  // 작은 글씨로 둔다. 진행 절과 시각적으로도 다른 무게가 되어야 두 수를 더해 읽지 않는다.
  blocks.push(context(['*Dispatch attempts*', ...dispatchLines]));

  // PR 절. 재료는 store에 있는 것뿐이고 그 경계를 같은 자리에서 밝힌다.
  const prLines =
    pullRequests.length === 0 ? ['store에 기록된 PR 없음'] : pullRequests.map(pullRequestLine);
  // 목록의 경계를 밝힌다. 없으면 "이 Run이 만든 PR 전부"로 읽힌다.
  prLines.push('_correlation에 성공한 PR만_');
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
  blocks.push(...labelledSections('등록되지 않은 Run', unregisteredLines(collection.unregistered)));

  // blocks를 그리지 못하는 자리에서도 identity·Run ID·판정이 남아야 한다. 그 자리도 mrkdwn으로
  // 해석되므로 blocks와 같은 이스케이프를 거친 값을 쓴다.
  const text =
    `${live.emoji} ${escapedIdentity} · ${esc(id.runId)} · ${escapedObjective}` +
    ` — 소유자 binding ${live.label}`;

  if (blocks.length > MESSAGE_BLOCK_CAP) {
    throw new RangeError('Run card exceeds the bounded Slack block count');
  }
  return { text, blocks };
}

/**
 * 컬렉션 카드 한 장의 입력(OD-080). 여기 없는 값은 카드에 나타나지 않는다.
 *
 * **관측 시각이 없다.** Run 카드와 같은 이유다 — 카드에 두면 사실이 그대로여도 관찰마다 렌더
 * 지문이 달라져 `publish.ts`의 `skip`이 실운영에서 영원히 발화하지 않는다.
 */
export type RunCollectionCardInput = {
  /** 이번 관찰이 만든 Run 카드 수. `RunCollection.runs`의 길이다. */
  readonly cards: number;
  readonly collection: RunCollectionContext;
};

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
 * 그래서 이 카드는 **등록 Run 수와 무관하게 항상 게시된다.** 등록 Run이 있을 때만 만들거나
 * 없을 때만 만들면 장치가 조건부가 되고, 그것이 이 카드가 닫으려는 구멍과 같은 종류의 구멍이다.
 *
 * ## 중복은 의도다
 *
 * 같은 사실이 Run 카드에도 이 카드에도 있다. Run 카드 쪽은 그 Run을 보는 사람이 컬렉션 사실을
 * 함께 보게 하고, 이 카드 쪽은 Run 카드가 하나도 없어도 그 사실이 남게 한다. 둘 중 하나를
 * 지우면 그 자리의 목적이 사라진다.
 *
 * Run 카드와 달리 이 카드에는 Run identity·진행·blocker가 없다. 컬렉션에 귀속되지 않는
 * 사실이기 때문이다.
 */
export function renderRunCollectionCard(input: RunCollectionCardInput): RenderedCard {
  const { cards, collection } = input;
  const headline = `📋 *관찰 요약* · Run 카드 ${cards}장 · 등록되지 않은 Run ${collection.unregistered.count}건`;

  const blocks: SlackBlock[] = [];
  // headline만 싣는다. 이 메시지가 왜 등록 Run 수와 무관하게 항상 게시되는지(OD-080)는 문서가
  // 답할 일이고, 매 관찰마다 카드에 같은 문단을 다시 그릴 이유가 아니다.
  blocks.push(section(headline));

  // Run 카드와 같은 함수를 쓴다. 0이어도 그린다.
  blocks.push(...labelledSections('등록되지 않은 Run', unregisteredLines(collection.unregistered)));

  /*
   * degraded 절(OD-072). **비어 있어도 그린다.**
   *
   * 여기 싣는 것은 관찰 전체의 degraded뿐이다. Run 하나에 귀속되는 degraded는 그 Run의 카드에
   * 있고, 여기로 옮기면 어느 것이 어느 Run의 사실인지 잃는다.
   */
  // 라벨이 이미 범위를 말한다. Run별 degraded가 어디 있는지는 카드가 설명하지 않는다.
  const degraded = ['관찰 전체'];
  degraded.push(
    ...(collection.degraded.length === 0 ? ['• 없음'] : collection.degraded.map(degradedLine)),
  );
  blocks.push(labelled('degraded', degraded));

  // blocks를 그리지 못하는 자리에서도 두 수가 남아야 한다. 그 자리도 mrkdwn으로 해석되므로
  // blocks와 같은 이스케이프를 거친 값을 쓴다 — 여기 값은 전부 수이므로 이스케이프할 것이 없다.
  const text = `관찰 요약 · Run 카드 ${cards}장 · 등록되지 않은 Run ${collection.unregistered.count}건`;

  if (blocks.length > MESSAGE_BLOCK_CAP) {
    throw new RangeError('Run collection card exceeds the bounded Slack block count');
  }
  return { text, blocks };
}
