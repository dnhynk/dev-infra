import type { RunKey } from '../identity/keys.js';
import type { RunBindingFacts } from '../orca/client.js';
import type { GateDecisionFacts } from '../gate/types.js';

/**
 * D1 Run 카드의 입력 계약.
 *
 * ```text
 * run-list ─┬─→ RunIdentityFacts   (OD-020 live/stale)
 * task-list ─┼─→ TaskAggregate      (OD-069 분모와 상태별 수)
 * worker-list┼─→ DispatchAttempts   (OD-069 attempt 이력)
 * gate-list ─┼─→ BlockerFacts       (OD-067 원천별 badge)
 * inbox     ─┘   RunDegraded[]      (OD-072 degraded를 사실로)
 * ```
 *
 * **여기에 비율이 없다.** 완료율·성공률 공식과 비율 progress bar를 만들지 않는다(OD-069).
 * `TaskAggregate`는 분모(`total`)와 상태별 수를 따로 싣고, 둘을 나눈 값은 어디에도 두지 않는다.
 *
 * **여기에 고유 blocker 총합이 없다.** dedup 정책이 확정되기 전에는 원천별 수만 싣는다(OD-067).
 * 실측에서 open Gate와 blocked Task가, 그리고 ask와 escalation과 dispatched Task가 같은 원인을
 * 두 번 표현했다. 합치면 한 blocker가 여러 번 셈된다.
 *
 * 이 파일의 범위: Orca 사실을 카드가 쓸 수 있는 값까지 만든다. Slack 렌더링은 `run/render.ts`,
 * 게시는 `run/publish.ts`, CLI 배선은 `cli.ts`의 `runs` 명령이다.
 */

/**
 * Run 소유자 binding의 live/stale 판정(OD-020).
 *
 * 판정 대상은 **프로세스가 아니라 binding**이다. Orca를 read-only로 읽어 coordinator 프로세스의
 * 생존을 알 방법은 없다. `live`는 "이 binding이 Run row의 현재 소유자다"이고 `stale`은
 * "이 binding은 더 높은 generation에 인수됐다"이다.
 */
export type BindingLiveness =
  /** Run row의 현재 소유자와 handle·pane key·generation이 모두 같다. */
  | 'live'
  /** generation이 Run row보다 낮다. `run-use` 인수로 대체된 binding이다. */
  | 'stale'
  /**
   * 판정 불가. generation이 같은데 handle이 다르거나, Run row보다 높거나, 비교할 binding이
   * 관측되지 않았다. degraded이며 live로도 stale로도 접지 않는다.
   */
  | 'unknown';

/** 관측된 binding 하나와 그 판정. */
export type ObservedBinding = {
  readonly binding: RunBindingFacts;
  readonly liveness: BindingLiveness;
  /** 이 binding으로 만들어진 Task 수. 어느 세대가 이 Run을 실제로 움직였는지 보여준다. */
  readonly tasks: number;
};

export type RunIdentityFacts = {
  readonly key: RunKey;
  readonly runId: string;
  readonly objective: string;
  readonly legacy: boolean;
  /**
   * Run row가 말하는 현재 소유자. **이 값이 권위다**(OD-020).
   *
   * `consumer_generation`을 읽지 못하면 null이다. 세대 없이 binding을 만들면 없는 세대가
   * 생기고 판정이 그 위에 선다(OD-079).
   */
  readonly current: RunBindingFacts | null;
  /** Task row에서 관측된 binding 전부. generation 오름차순. binding을 읽지 못한 Task는 빠진다. */
  readonly observed: readonly ObservedBinding[];
  /**
   * Run 수준 판정. **두 값뿐이다.**
   *
   * - `live`: 현재 소유자 binding으로 만들어진 Task를 관측했다. 이것만이 적극적 사실이다.
   * - `unknown`: 그 외 전부 — 비교할 Task가 없다(legacy Run, 빈 Run, 조회 실패), 관측된
   *   binding이 전부 더 낮은 generation이다, Run row와 어긋난다, `consumer_generation`을 읽지
   *   못했다.
   * - `stale`: **run 수준에서는 나오지 않는다.** binding 하나에만 쓴다.
   *
   * run 수준 `stale`을 만들지 않는 이유는 `liveness.ts`의 `runIdentity` 주석에 있다. 요약하면
   * "관측된 binding이 전부 낮은 세대다"는 정상 handoff 구간에서도 참이므로 "이 Run은
   * 버려졌다"의 근거가 되지 못한다. 세대 분포는 `observed`가 그대로 보여준다.
   */
  readonly liveness: BindingLiveness;
};

/**
 * Task 집계(OD-069).
 *
 * `total`이 분모이고 `byStatus`가 분자 후보다. **둘을 나눈 값을 만들지 않는다.** failed와
 * blocked를 어느 분자에 넣을지 원천이 정하지 않으므로 완료율·성공률 공식은 만들지 않는다.
 *
 * `total`은 `task-list.result.count`다. 실행 중 Task가 추가되면 즉시 늘어난다 — 시작 시점
 * 값을 고정하지 않는다. 실측에서 실행 중 추가로 count가 1에서 3이 됐다.
 *
 * `byStatus`는 관측된 status를 그대로 싣는다. Orca enum은 `pending`·`ready`·`dispatched`·
 * `completed`·`failed`·`blocked` 여섯이고 **`cancelled`는 없다.**
 */
export type TaskAggregate = {
  readonly total: number;
  readonly byStatus: readonly StatusCount[];
};

export type StatusCount = {
  readonly status: string;
  readonly count: number;
};

/**
 * Dispatch attempt 이력(OD-069).
 *
 * **Task 집계와 분리한다.** retry Dispatch는 같은 Task ID를 다시 쓰므로 Dispatch 행을 분모에
 * 더하면 같은 작업을 여러 번 센다. 실측에서 한 Task의 네 실패와 한 성공은 Task 한 행과
 * Dispatch 다섯 행으로 남았다.
 *
 * `retriedTasks`는 attempt가 둘 이상인 Task 수다. Task 수가 아니라 **재시도가 있었다는 사실**을
 * 센다. 원 Dispatch를 가리키는 계보는 싣지 않는다 — `--retry-of`는 입력으로만 받고 어느 조회
 * 출력에도 남지 않는다(t3 §(c) 실측).
 */
export type DispatchAttempts = {
  /** Dispatch 행 수. Task 수가 아니다. */
  readonly total: number;
  readonly byStatus: readonly StatusCount[];
  readonly retriedTasks: number;
};

/**
 * blocker 원천(OD-067).
 *
 * 각 값이 **별도 badge**다. 서로 배타적이지 않으며 같은 Task/Dispatch가 여러 원천에 나타난다.
 * 그래서 고유 총합을 만들지 않는다.
 *
 * ## 현재 상태와 누적 이력을 구분한다
 *
 * 일곱 원천이 같은 시제를 말하지 않는다. **소비자가 이 구분을 지워서는 안 된다.**
 *
 * - **현재 상태** — `openGate`·`blockedTask`·`waitingDependency`·`interactionWait`. 원천 행의
 *   현재 status에서 나오므로 해소되면 다음 관찰에서 사라진다.
 * - **누적 이력** — `failedDispatch`·`escalation`. **만료가 없다.** 원천이 과거 행을 지우지
 *   않으므로 이미 retry로 완료된 Task의 실패도, 이미 해소된 escalation도 계속 셈된다.
 *   실측(2026-08-24, `run_36d28e6e947a`): 활성 Dispatch가 1건뿐인 Run에서
 *   `failedDispatch = 13`이었고 13건 전부 retry로 완료된 Task의 과거 실패 행이었다.
 *   **이 수를 "지금 막혀 있다"로 그리면 완주한 Run이 막힌 것으로 읽힌다.**
 * - **판정 시점이 관찰 창에 걸림** — `workerAsk`. 미답 여부를 inbox 조회 창 안에서만 판정한다.
 *   `inbox_saturated` degraded가 붙은 관찰에서는 이 수를 확정으로 읽지 않는다.
 *
 * 집계에서 누적 이력을 잘라내지 않는다. 값은 사실이고, 자르려면 만료 기준이 필요한데 원천이
 * 그 기준을 주지 않는다. 구분은 여기 계약으로 전달하고 표현은 소비자가 정한다.
 */
export type BlockerSource =
  /** `gate-list.status === 'pending'`. */
  | 'openGate'
  /** `task-list.status === 'blocked'`. */
  | 'blockedTask'
  /** `task-list.status === 'pending'`. 의존성이 남아 아직 ready가 아니다. */
  | 'waitingDependency'
  /** 답변이 관측되지 않은 `question` 메시지. */
  | 'workerAsk'
  /**
   * `escalation` 메시지. ask와 별개다 — 같은 Dispatch에 둘이 동시에 존재했다.
   *
   * **누적 이력이다.** 메시지에는 해소 표시가 없으므로 이미 해결된 escalation도 계속 셈된다.
   */
  | 'escalation'
  /**
   * `worker-list.dispatchStatus`가 `completed`·`dispatched`가 아닌 행.
   *
   * **누적 이력이다.** retry로 이미 완료된 Task의 과거 실패 행이 그대로 남는다. 현재 blocker가
   * 아니다.
   */
  | 'failedDispatch'
  /**
   * `worker-show.observation.agentWait`가 있는 활성 Dispatch.
   *
   * **permission이라고 부르지 않는다.** 실측 `reason`은 permission 전용 enum이 아니라
   * `codex-interactive-prompt`였다. provider별 근거가 더 있을 때만 세분화한다(OD-067).
   */
  | 'interactionWait';

/**
 * badge 항목 하나. **correlation ID를 함께 싣는다**(OD-067).
 *
 * 네 ID를 한 타입에 두고 해당 없는 것은 null이다. 원천마다 따로 타입을 두면 소비자가 원천을
 * 알아야 ID를 꺼낼 수 있고, 새 원천이 생길 때마다 소비자가 깨진다.
 */
export type BlockerEntry = {
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  readonly gateId: string | null;
  readonly messageId: string | null;
  /** 사람이 읽는 한 줄. 원천이 준 값만 쓴다. */
  readonly detail: string;
};

export type BlockerBadge = {
  readonly source: BlockerSource;
  readonly count: number;
  readonly entries: readonly BlockerEntry[];
};

/**
 * blocker 집계(OD-067).
 *
 * **`total`이 없다.** 고유 blocker 총합은 dedup 정책이 확정된 뒤에만 추가한다. badge 수를
 * 더해 총합을 만드는 소비자가 있으면 그것이 이 결정을 어기는 것이다.
 */
export type BlockerFacts = {
  /** 항목이 하나 이상인 badge만. 원천 순서는 `BLOCKER_ORDER`로 고정한다. */
  readonly badges: readonly BlockerBadge[];
  /**
   * taxonomy에는 있으나 이 관측 표면에서 만들 수 없는 원천.
   *
   * 현재 `CI failure` 하나다. t3 §(b) 실측에서 Orca Task/Gate/Dispatch/message schema 어디에도
   * CI 전용 상태나 필드가 없었다. **비어 있는 badge로 0을 그리지 않는다** — 0건과 관측 불가는
   * 다르다. GitHub 축을 조인하는 쪽이 이 자리를 채운다.
   */
  readonly notObservable: readonly NotObservableSource[];
};

export type NotObservableSource = {
  readonly source: 'ciFailure';
  readonly reason: string;
};

/**
 * degraded 사실(OD-072).
 *
 * 카드는 이 값을 **항상 표시한다.** 조회 실패, 파싱 실패, 미검증 가정에 걸린 판정을 성공처럼
 * 숨기지 않는다. thread 알림 여부는 D1-B가 정한다 — owner 개입이 필요한 것만 알린다.
 */
export type RunDegraded = {
  readonly kind: DegradedKind;
  readonly detail: string;
  /** Hashed correlation only; raw Orca repository IDs are not emitted by effective routing. */
  readonly entityRefs?: readonly string[];
  /** Bounded structured counts used by status/renderers without parsing prose. */
  readonly counts?: Readonly<Record<string, number>>;
};

export type DegradedKind =
  /** 이 Run의 Orca 조회 하나가 실패했다. 그 축의 사실이 없다는 뜻이다. */
  | 'query_failed'
  /** 관측된 Orca repository id가 설정 어디에도 등록되지 않았다(OD-078). */
  | 'unregistered_repository'
  /**
   * repository id 자체를 관측하지 못했다.
   *
   * **원인이 둘이다.** Task도 worker도 없는 빈 Run이거나, 그 축의 조회가 실패했거나다. 어느
   * 쪽인지는 `detail`이 말하고, 후자면 같은 목록에 `query_failed`가 함께 있다.
   */
  | 'repository_unobservable'
  /**
   * 관측된 repository id가 서로 다른 두 등록 Project에 걸쳐 있다(OD-078).
   *
   * 등록은 Project 하나를 고르는 열쇠인데 열쇠가 둘을 가리킨다. 어느 쪽이 맞는지 원천이
   * 정하지 않으므로 아무 Project도 고르지 않고 route zero 사실을 드러낸다.
   */
  | 'multiple_project_match'
  /** Effective routing rejected an incomplete, conflicting, or globally blocked identity set. */
  | 'repository_route_blocked'
  /** A non-empty Orca worktree identity could not be parsed, so the Run cannot be routed. */
  | 'repository_identity_unreadable'
  /** A bounded Run working set omitted older rows deterministically. */
  | 'capacity_deferred'
  /** Explicit manual-ID routing proceeded without a supported live remote. */
  | 'remote_unverified_repository'
  /**
   * Orca row의 한 칸을 읽지 못했다(OD-079).
   *
   * 그 칸이 만들던 사실이 이 관찰에 없다는 뜻이다. `client.ts`의 `UnreadableField`가 어느
   * row의 어느 칸이 왜 실패했는지를 싣고 여기 `detail`이 그것을 한 줄로 옮긴다.
   */
  | 'unreadable_field'
  /** live/stale을 판정할 binding이 없거나 Run row와 어긋난다. */
  | 'liveness_unknown'
  /** inbox가 요청 상한에 닿아 ask 답변 부재를 증명할 수 없다. */
  | 'inbox_saturated'
  /** 판정이 플랫폼 미검증 가정 위에 서 있다. `docs/platform-capabilities.md` §7. */
  | 'unverified_platform_assumption';

export type RunFacts = {
  readonly identity: RunIdentityFacts;
  /** 등록 설정에서 온 Project 이름. 미등록이면 null. */
  readonly project: string | null;
  /** 그 Project에 등록된 `owner/name` 목록. 미등록이면 빈 배열. */
  readonly repositories: readonly string[];
  /** 이 Run에서 관측된 Orca repository id 전부. 사전순. */
  readonly observedRepositoryIds: readonly string[];
  readonly tasks: TaskAggregate;
  readonly dispatches: DispatchAttempts;
  readonly blockers: BlockerFacts;
  /** Raw Gate/Task facts joined with exact sidecar metadata; rendered as Run-thread replies. */
  readonly gates: readonly GateDecisionFacts[];
  readonly degraded: readonly RunDegraded[];
};

/**
 * 관찰 1회의 결과.
 *
 * 미등록 Run을 **버리지 않는다.** 등록 열쇠(OD-078)가 어긋나면 카드가 조용히 비는 대신
 * `unregistered`가 그 수를 드러낸다. 이것이 OD-078의 유일한 실패 모드를 관측 가능하게 만든다.
 */
export type RunCollection = {
  readonly observedAt: string;
  /** 등록된 repository에 연결된 Run만. */
  readonly runs: readonly RunFacts[];
  readonly unregistered: UnregisteredRuns;
  /** 컬렉션 수준 degraded. Run 하나에 귀속되지 않는 사실이다. */
  readonly degraded: readonly RunDegraded[];
};

export type UnregisteredRuns = {
  readonly count: number;
  readonly runs: readonly UnregisteredRun[];
};

/**
 * 등록 Project를 찾지 못한 Run 하나.
 *
 * **`degraded`를 함께 싣는다.** 이것이 없으면 "조회했더니 등록에 없다"와 "조회가 실패해서
 * 판정할 수 없다"가 같은 출력이 된다. 후자는 `repositoryIds`가 비고 `degraded`에
 * `query_failed`가 있는 모습이고, 전자는 `repositoryIds`에 값이 있고 `unregistered_repository`가
 * 있는 모습이다.
 *
 * 구분이 없으면 OD-078의 완화 장치가 거짓을 말한다. 그 결정이 "id 재생성으로 Run이 조용히
 * 사라진다"는 위험을 감수한 근거가 **"등록에 맞지 않는 Run을 세어 노출하므로 조용한 실패가
 * 관측 가능해진다"**인데, 조회에 실패한 Run이 미등록으로 둔갑하면 그 수가 다른 사건을 센다.
 */
export type UnregisteredRun = {
  readonly runId: string;
  /** Effective routing renders this digest instead of exposing the unregistered raw Run ID. */
  readonly runRef?: string;
  /** Legacy manual mode의 관측 ID. Effective mode는 이 배열을 비우고 repositoryRefs만 싣는다. */
  readonly repositoryIds: readonly string[];
  /** Effective routing exposes only these digests; legacy manual mode retains repositoryIds. */
  readonly repositoryRefs?: readonly string[];
  /** 이 Run의 degraded 전부. 등록 판정을 신뢰할 수 있는지가 여기 있다. */
  readonly degraded: readonly RunDegraded[];
};
