import type { BranchRequiredRules } from '../github/branch-rules.js';
import type { CheckFact } from '../github/pull-request.js';
import { joinRequiredChecks, type RequiredCheckFact } from '../github/required-checks.js';
import type { PrStateSnapshot } from '../store/schema.js';
import { deriveMergePolicy, reconcileTerminal } from './state.js';
import type { ProjectedPr } from './types.js';

/**
 * 관측 **사이**의 변화.
 *
 * 지금까지의 digest 모듈은 한 시점의 사실을 카드로 그렸다. 이 모듈이 다루는 것은 두 관측을
 * 잇는 것이고 하는 일이 둘이다.
 *
 * 1. **reconcile.** 직전 관측(`PrStateSnapshot`)과 이번 관측을 합쳐 이번 카드가 쓸 사실을
 *    만든다. 오래된 snapshot이 `merged`나 완료된 check를 되돌리지 못하게 한다(OD-044).
 * 2. **전이 후보.** reconcile된 상태에서 thread에 남길 만한 사실을 뽑는다.
 *
 * 이 모듈은 순수하다. GitHub·Orca·Slack·durable store를 읽지 않는다. store 조회와 게시는
 * `digest/digest.ts`가 한다.
 *
 * **전이 후보는 diff가 아니라 "지금 참인 사실"에서 나온다.** 이 선택에는 이유가 있다.
 *
 * diff로 내면 전이는 두 관측 사이에서 한 번 생겼다 사라지는 값이 된다. 그 한 번을 놓치는
 * 경로가 실제로 있다. 게시에 실패한 경우, 게시 경계가 아직 배선되지 않은 경우(C2-4 전),
 * 그리고 게시는 됐는데 상태 저장 전에 죽은 경우다. 앞의 둘에서 전이는 영영 사라지고, 마지막
 * 경우에는 같은 전이가 다시 게시된다.
 *
 * 후보를 현재 상태에서 만들면 그 셋이 모두 `pr_thread_event` 하나로 정리된다. 아직 기록하지
 * 않았고 지금도 참인 사실은 다음 관측에서 다시 후보가 되고, 이미 기록한 사실은 몇 번을 다시
 * 관측해도 후보에서 걸러진다. **그래서 dedupe key가 예외 경로가 아니라 정상 경로에서 일한다.**
 *
 * 대신 잃는 것을 적어 둔다. 참이었다가 다시 거짓이 된 사실은 다음 관측에서 후보가 아니므로
 * 기록되지 않는다. 이 모듈은 과소보고 쪽으로 안전하며, 그 방향은 로드맵 §6의 출구 조건
 * "transition이 thread에 한 번만 기록됨"이 요구하는 방향과 같다.
 *
 * **첫 관측에서 무엇을 하는지는 여기서 정하지 않는다.** 이전 상태가 없으면 `previous`가
 * null이고, 그때 후보를 게시하지 않고 기준선으로만 남기는 것은 `digest/digest.ts`의 배선이다
 * (OD-046).
 */

/**
 * thread에 남기는 전이의 종류.
 *
 * `docs/contracts/observation-and-correlation.md` §8의 PR 후보 목록과
 * `docs/ux/slack-surfaces.md` §2.5의 예시에서 골랐다. `docs/ux/slack-surfaces.md` §5는 thread
 * event의 최소 필드를 transition type, occurred/observed time, 짧은 설명으로 정했고
 * `PrTransition`이 그 셋을 싣는다.
 *
 * **§8의 후보 중 둘은 의도적으로 빼고, 예시에 있는 하나도 뺐다.** 다음 구현자가 누락으로
 * 오해하지 않도록 근거를 남긴다.
 *
 * - **`PR 생성`**(§2.5 예시의 첫 줄). Bridge는 PR을 polling으로 처음 본다. 사흘 전에 만들어진
 *   PR을 지금 처음 관측하면 이 전이는 사흘 전 시각으로 나가고, 그것이 OD-046이 금지한 **과거
 *   재생**이다. 첫 관측에서 전이를 쏟아내지 않는다는 이 slice의 제약과도 직접 부딪힌다.
 *   `gh pr list --json createdAt`으로 생성 시각을 읽을 수는 있으므로 "시각을 모른다"가 이유가
 *   아니다. 더해서 thread가 매달리는 루트 카드 자체가 PR의 등장을 이미 알린다.
 *   `docs/README.md`가 "예시 Slack 문구는 별도로 `확정 계약`이라고 표시되지 않은 한 문구 자체를
 *   고정하지 않는다"고 적으므로 §2.5 예시에서 벗어나는 것이 계약 위반이 아니다.
 * - **`수정 완료 및 재검토`**(§8, §2.5). 이 의미의 source fact는 §6이 "changes requested 이후
 *   새 head + 재검토 상태"로 적었는데 `재검토 상태`가 관측되지 않는다. `digest/state.ts`의
 *   `deriveDigestStatus` 주석이 이미 그렇게 확정했고 그 코드는 merge됐다. 없는 사실로 전이를
 *   만들면 그것이 추측이다.
 * - **`닫힘(unmerged)`**. `docs/roadmap.md` §6의 C2 범위 열거에 없다. 그리고 `closed`는 latch가
 *   아니라 reopen이 지나가므로(OD-044, `PrTerminal`) 내용에서 파생한 key 하나로는
 *   close→reopen→close 사이클을 첫 번째만 기록하고 만다. **넣으려면 내용이 아닌 다른 identity가
 *   필요하다.** C2 범위 밖으로 둔다.
 *
 * degraded 상태도 여기 없다. OD-072는 correlation 실패만 thread에 알리라고 했는데, correlation
 * 실패 PR은 카드를 만들지 않으므로(`docs/ux/slack-surfaces.md` §6) 매달릴 thread 자체가 없다.
 * summarizer 실패와 source stale은 자가 복구되므로 badge만이다.
 *
 * `headRefOid ≠ checksHeadOid`도 전이가 아니다. 상태 변화가 아니라 관측 품질이고 카드의 CI
 * 절이 이미 사실로 표시한다(`digest/render.ts`).
 */
export type PrTransitionKind =
  /** reviewer 판정이 `request_changes`다. §8의 `review에서 문제 발견`. */
  | 'review_changes_requested'
  /** reviewer 판정이 `approve`다. §8의 `review 통과`. */
  | 'review_approved'
  /** `mergePolicy` 축이 `failing`이다. §8의 `CI 핵심 실패`. */
  | 'checks_failing'
  /** `mergePolicy` 축이 `passing`이다. §8의 `CI 핵심 통과`. */
  | 'checks_passing'
  /** terminal이 `merged`다. §8의 `merge 완료`. */
  | 'merged';

/**
 * 전이 하나.
 *
 * `dedupeKey`는 **전이의 내용**에서 파생한다. 관측 순서나 시각을 넣지 않는다. 넣으면 같은
 * 사실이 관측마다 다른 key를 얻어 dedupe가 아무것도 막지 못한다.
 *
 * key에 scope를 함께 넣는 이유는 같은 종류의 전이가 다른 사실일 수 있어서다. head가 움직인
 * 뒤의 `required check 통과`는 앞선 head의 통과와 다른 사실이므로 다시 알려야 한다. 그래서
 * review는 `reviewedHeadSha`로, check 축은 `checksHeadSha`로 scope를 건다(OD-044: review/check
 * scope는 headSha다). `merged`는 latch이고 PR당 한 번뿐이므로 scope가 없다.
 *
 * `occurredAt`은 **그 사실 자체가 싣고 있는 시각**이다. 없으면 null이고, 그때 thread는 관측
 * 시각만 말한다. 관측 시각을 발생 시각인 척하지 않는다.
 */
export type PrTransition = {
  readonly kind: PrTransitionKind;
  readonly dedupeKey: string;
  readonly occurredAt: string | null;
};

/** reconcile 결과. 이번 관측이 카드·store·thread에 쓸 값 전부다. */
export type ReconciledObservation = {
  /** 카드가 그릴 사실. `terminal`·`checks`·`mergePolicy`가 reconcile된 `ProjectedPr`이다. */
  readonly pr: ProjectedPr;
  /** 다음 관측이 읽을 상태. 그대로 `savePrState`에 넘긴다. */
  readonly state: PrStateSnapshot;
  /** thread 후보. 이미 기록한 것을 거르는 일은 호출자가 한다. */
  readonly candidates: readonly PrTransition[];
};

/** `reviewedHeadSha`가 없을 때 review key가 쓰는 scope 자리. */
const UNKNOWN_HEAD = 'unknown';

/**
 * check resource 하나의 진행 단계.
 *
 * OD-044는 동일 head 안의 check를 각 resource의 timestamp와 id로 reconcile하라고 확정했다.
 * timestamp만으로는 부족하다. 완료된 row와 진행 중인 row가 같은 `startedAt`을 갖기 때문이다.
 * 그래서 단계를 먼저 보고 같은 단계일 때만 시각을 본다.
 */
function stage(c: CheckFact): number {
  if (c.completedAt !== null) return 2;
  if (c.startedAt !== null) return 1;
  return 0;
}

/** 그 단계를 지배하는 시각. 완료했으면 완료 시각, 아니면 시작 시각이다. */
function resourceTime(c: CheckFact): string | null {
  return c.completedAt ?? c.startedAt;
}

/**
 * 같은 id의 두 row 중 **나중 것**을 고른다.
 *
 * 단계가 다르면 앞선 단계가 이기지 못한다. **완료 snapshot 뒤에 늦게 도착한 진행 snapshot이
 * 완료를 되돌리지 않는다**는 것이 이 규칙이다.
 *
 * 같은 단계면 지배 시각을 비교한다. 시각을 못 읽거나(파싱 실패) 같으면 이번 관측을 쓴다.
 * 같은 resource의 같은 단계이므로 되돌아갈 것이 없고, 그때는 방금 읽은 값이 더 최신이다.
 *
 * 문자열 순서로 비교하지 않는다. GitHub이 늘 같은 형식의 UTC ISO8601을 준다는 보장이 이
 * 계약에 없고, 형식이 섞이면 문자열 순서는 시간 순서가 아니다.
 */
function later(previous: CheckFact, observed: CheckFact): CheckFact {
  const ps = stage(previous);
  const os = stage(observed);
  if (os !== ps) return os > ps ? observed : previous;
  const pt = resourceTime(previous);
  const ot = resourceTime(observed);
  if (pt === null || ot === null) return observed;
  const pms = Date.parse(pt);
  const oms = Date.parse(ot);
  if (Number.isNaN(pms) || Number.isNaN(oms) || oms === pms) return observed;
  return oms > pms ? observed : previous;
}

/** 목록 순서를 고정한다. 정하지 않으면 같은 사실이 실행마다 다른 카드를 낸다. */
function byNameThenId(a: CheckFact, b: CheckFact): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * 같은 head의 두 check 관측을 resource 단위로 합친다(OD-044).
 *
 * 합집합이다. 이번 관측에 없는 row도 남긴다. 응답이 어긋난 순서로 도착하면 완료된 row가 통째로
 * 빠진 snapshot이 뒤늦게 올 수 있고, 그것을 그대로 받으면 required 조인이 `passing`에서
 * `missing`으로 떨어져 카드가 거짓을 말한다.
 *
 * **id가 빈 row는 이전 관측 쪽을 버린다.** 같은 resource인지 확정할 근거가 없어 합칠 대상이
 * 아니다(`github/rollup.ts`의 `CheckFact.id`). 이번 관측의 것만 그대로 싣는다.
 *
 * 남는 것: 같은 head에서 workflow가 삭제돼 row가 진짜로 사라진 경우, 그 row는 head가 움직일
 * 때까지 남는다. head가 움직이면 scope가 달라져 이 함수를 타지 않는다.
 */
export function reconcileChecks(
  previous: readonly CheckFact[],
  observed: readonly CheckFact[],
): readonly CheckFact[] {
  const byId = new Map<string, CheckFact>();
  for (const c of previous) {
    if (c.id !== '') byId.set(c.id, c);
  }
  const unidentified: CheckFact[] = [];
  for (const c of observed) {
    if (c.id === '') {
      unidentified.push(c);
      continue;
    }
    const before = byId.get(c.id);
    byId.set(c.id, before === undefined ? c : later(before, c));
  }
  return [...byId.values(), ...unidentified].sort(byNameThenId);
}

/**
 * required 조인 결과에서 축이 움직인 시각을 읽는다.
 *
 * `passing`은 마지막 required가 끝난 시각에 참이 되고, `failing`은 첫 required 실패가 난
 * 시각에 참이 된다. 그 시각을 만들 수 없는 row가 하나라도 있으면 null이다 — 일부만으로 계산한
 * 값을 발생 시각으로 내보내면 카드가 관측하지 않은 것을 말한다.
 */
function axisOccurredAt(
  required: readonly RequiredCheckFact[],
  pick: 'passing' | 'failing',
): string | null {
  const rows =
    pick === 'passing'
      ? required.map((r) => r.observed)
      : required.filter((r) => r.state === 'failing').map((r) => r.observed);
  if (rows.length === 0) return null;
  const times: number[] = [];
  for (const row of rows) {
    const t = row === null ? null : resourceTime(row);
    if (t === null) return null;
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) return null;
    times.push(ms);
  }
  const chosen = pick === 'passing' ? Math.max(...times) : Math.min(...times);
  return new Date(chosen).toISOString();
}

/**
 * reconcile된 상태에서 thread 후보를 뽑는다.
 *
 * 순서를 고정한다. 한 관측이 여러 전이를 내면 thread에 그 순서로 남고, 순서가 흔들리면 같은
 * 사실이 실행마다 다른 thread를 만든다.
 */
function candidatesOf(
  pr: ProjectedPr,
  required: readonly RequiredCheckFact[],
  mergedAt: string | null,
): readonly PrTransition[] {
  const out: PrTransition[] = [];

  if (pr.review !== null) {
    // scope는 reviewer가 본 commit이다. 같은 판정이라도 다른 commit에 대한 것이면 다른 사실이다.
    // `reviewedHeadSha`가 없으면 scope를 지어내지 않고 그 사실을 key에 남긴다.
    const scope = pr.review.reviewedHeadSha ?? UNKNOWN_HEAD;
    const approved = pr.review.verdict === 'approve';
    out.push({
      kind: approved ? 'review_approved' : 'review_changes_requested',
      dedupeKey: `review:${pr.review.verdict}@${scope}`,
      // Orca review task의 완료 시각은 `ProjectedPr`에 실리지 않는다. 관측 시각을 발생
      // 시각인 척하지 않고 없다고 말한다(`docs/ux/slack-surfaces.md` §5의 occurred/observed).
      occurredAt: null,
    });
  }

  // 축의 다섯 값 중 둘만 전이다. `pending`은 결론이 아니고, `missing`·`indeterminate`·
  // `no_required_rules`·`rules_unreadable`은 §8의 `CI 핵심 실패 또는 통과`가 아니라 판정
  // 근거의 상태다. 카드는 그 넷을 모두 표시한다(`digest/render.ts`).
  if (pr.mergePolicy === 'passing' || pr.mergePolicy === 'failing') {
    const passing = pr.mergePolicy === 'passing';
    out.push({
      kind: passing ? 'checks_passing' : 'checks_failing',
      dedupeKey: `mergePolicy:${pr.mergePolicy}@${pr.checksHeadSha}`,
      occurredAt: axisOccurredAt(required, passing ? 'passing' : 'failing'),
    });
  }

  if (pr.terminal === 'merged') {
    // latch이므로 PR당 한 번뿐이고 scope가 없다(OD-030).
    out.push({ kind: 'merged', dedupeKey: 'terminal:merged', occurredAt: mergedAt });
  }

  return out;
}

/**
 * 직전 관측과 이번 관측을 합쳐 이번 카드·store·thread가 쓸 값을 만든다.
 *
 * **`previous`가 null이면 이전 관측이 없다는 뜻이고 이번 관측이 그대로 결과다.** store를
 * 잃었을 때도 같다. GitHub history로 과거 상태를 채우지 않는다 — check는 400일 뒤 archive되고
 * 다시 10일 뒤 삭제되어 완전 재생을 보장하지 못한다(OD-046).
 *
 * reconcile하는 축은 둘이다.
 *
 * - **terminal**: `reconcileTerminal`이 정한다(`digest/state.ts`). timestamp를 비교하지 않는다.
 *   `merged`는 내려가지 않는다는 규칙 하나이며 OD-044가 그렇게 확정했다.
 * - **checks**: `checksHeadSha`가 같을 때만 resource 단위로 합친다. 다르면 두 관측은 서로 다른
 *   commit의 사실이라 합칠 대상이 아니고 이번 관측이 그대로 결과다. 두 head 중 어느 쪽이
 *   나중인지는 SHA로 알 수 없다 — SHA 문자열 순서를 시간 순서로 쓰는 것은 OD-044가 기각했다.
 *
 * `mergePolicy`는 reconcile하지 않고 **reconcile된 check로 다시 파생한다.** 축을 직접 합치면
 * 규칙이 `deriveMergePolicy` 밖에 하나 더 생긴다. 조인도 파생도 merge된 계약 그대로 부른다
 * (`joinRequiredChecks`, `deriveMergePolicy`).
 *
 * `isDraft`와 `review`는 reconcile하지 않는다. 둘 다 dominance가 없는 축이고, review는 이미
 * 각 resource의 timestamp와 id로 고른 결과다(`digest/project.ts`의 `pickReviewerResult`).
 *
 * `mergedAt`은 이번 관측의 값이며 없으면 직전 값을 유지한다. `merged` latch의 occurred time
 * 이므로 오래된 snapshot의 null이 지우게 두지 않는다.
 */
export function reconcileObservation(
  previous: PrStateSnapshot | null,
  observed: ProjectedPr,
  rules: BranchRequiredRules,
  mergedAt: string | null,
): ReconciledObservation {
  const terminal = reconcileTerminal(previous?.terminal ?? null, observed.terminal);
  const sameScope = previous !== null && previous.checksHeadSha === observed.checksHeadSha;
  const checks = sameScope
    ? reconcileChecks(previous.checks, observed.checks)
    : observed.checks;
  const required = joinRequiredChecks(rules, checks);
  const mergePolicy = deriveMergePolicy(rules, required);
  const pr: ProjectedPr = { ...observed, terminal, checks, mergePolicy };
  const latchedMergedAt = mergedAt ?? previous?.mergedAt ?? null;

  return {
    pr,
    state: {
      terminal,
      mergedAt: latchedMergedAt,
      reviewVerdict: pr.review?.verdict ?? null,
      reviewedHeadSha: pr.review?.reviewedHeadSha ?? null,
      headSha: pr.headSha,
      checksHeadSha: pr.checksHeadSha,
      checks,
    },
    candidates: candidatesOf(pr, required, latchedMergedAt),
  };
}
