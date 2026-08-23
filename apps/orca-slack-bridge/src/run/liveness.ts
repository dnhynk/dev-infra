import { runKey } from '../identity/keys.js';
import type { OrcaRun, OrcaTask, RunBindingFacts } from '../orca/client.js';
import type { BindingLiveness, ObservedBinding, RunIdentityFacts } from './types.js';

/**
 * Run 소유자 binding의 live/stale 판정(OD-020).
 *
 * ## 무엇을 판정하는가
 *
 * **프로세스의 생존이 아니라 binding의 현재성이다.** Orca를 read-only로 읽어 coordinator
 * 프로세스가 살아 있는지 알 방법은 없다. `worker-list`의 terminal resource는 historical·released
 * worker도 포함하므로 liveness 근거가 아니다(docs/contracts §5).
 *
 * ## 어떤 사실 위에 서는가
 *
 * - Run row의 `consumer_generation`이 현재 소유자의 세대다. **이것이 권위다.**
 * - Task row의 `created_by_run_generation`·`created_by_terminal_handle`이 그 Task를 만든 binding이다.
 *
 * 실측(2026-08-24, `run_36d28e6e947a`): Run row는 `consumer_generation: 2` ·
 * `coordinator_handle: term_6354ef22…`였고, Task 63행 중 39행이 generation 1 + `term_29548394…`,
 * 24행이 generation 2 + `term_6354ef22…`였다. 즉 한 Run 안에 두 세대의 binding이 남아 있고
 * 뒤쪽만 Run row와 일치한다.
 *
 * ## [미검증 가정] — 플랫폼이 바뀌면 이 판정이 깨진다
 *
 * `run-use` 인수가 `consumer_generation`을 올린다는 것은 **Orca 플랫폼이 문서화하지 않은
 * 동작이다.** `docs/platform-capabilities.md` §7.2가 이 가정을 미검증으로 기록했고, 근거는
 * 프로젝트 스킬 문서의 서술과 `run-list` generation 분포를 연결한 추론이다. `run-use` 전후의
 * 증가를 직접 관측한 기록은 없다.
 *
 * 그래서 `collect.ts`가 이 판정을 쓸 때마다 `unverified_platform_assumption` degraded를 함께
 * 싣는다. 판정을 숨기지도, 확정 사실처럼 말하지도 않는다(OD-072).
 *
 * 환경변수(`ORCA_TERMINAL_HANDLE` 등)는 여기서 읽지 않는다. 위조가 두 방향으로 재현됐으므로
 * 보조 단서 이상으로 쓰지 않는다(OD-020).
 */
export function classifyBinding(run: OrcaRun, binding: RunBindingFacts): BindingLiveness {
  if (binding.generation < run.consumerGeneration) return 'stale';
  // Run row보다 높은 세대는 설명할 수 없다. 앞선 것을 live로 부르지 않는다.
  if (binding.generation > run.consumerGeneration) return 'unknown';
  const handleMatches =
    binding.handle === run.coordinatorHandle && binding.paneKey === run.coordinatorPaneKey;
  return handleMatches ? 'live' : 'unknown';
}

/** binding 하나를 map key로 접는다. 세 축이 모두 같아야 같은 binding이다. */
function bindingKey(b: RunBindingFacts): string {
  return `${b.generation}\u0000${b.handle ?? ''}\u0000${b.paneKey ?? ''}`;
}

/**
 * Run row와 Task binding을 대조해 Run identity 사실을 만든다.
 *
 * Run 수준 판정은 관측된 binding 중 하나라도 `live`면 `live`, 관측된 binding이 있는데 하나도
 * live가 아니면 `stale`, 관측된 binding이 없으면 `unknown`이다.
 *
 * 마지막 경우를 stale로 접지 않는다. legacy Run과 갓 만들어진 빈 Run은 "인수됐다"가 아니라
 * "비교할 사실이 없다"이고, 둘을 접으면 카드가 없는 사실을 말한다.
 */
export function runIdentity(run: OrcaRun, tasks: readonly OrcaTask[]): RunIdentityFacts {
  const current: RunBindingFacts = {
    handle: run.coordinatorHandle,
    paneKey: run.coordinatorPaneKey,
    generation: run.consumerGeneration,
  };
  const grouped = new Map<string, { binding: RunBindingFacts; tasks: number }>();
  for (const t of tasks) {
    const key = bindingKey(t.createdBy);
    const found = grouped.get(key);
    if (found === undefined) grouped.set(key, { binding: t.createdBy, tasks: 1 });
    else found.tasks += 1;
  }
  const observed: ObservedBinding[] = [...grouped.values()]
    .map((g) => ({ ...g, liveness: classifyBinding(run, g.binding) }))
    .sort((a, b) => a.binding.generation - b.binding.generation);

  const liveness: BindingLiveness =
    observed.length === 0
      ? 'unknown'
      : observed.some((o) => o.liveness === 'live')
        ? 'live'
        : observed.every((o) => o.liveness === 'stale')
          ? 'stale'
          : 'unknown';

  return {
    key: runKey(run.id),
    runId: run.id,
    objective: run.objective,
    legacy: run.legacy,
    current,
    observed,
    liveness,
  };
}
