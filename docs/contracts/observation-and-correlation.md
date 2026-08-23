# Orchestration 관찰·상관관계 계약

상태: **Draft · 일부 형식 TBD**

이 문서는 `/init-orchestrate`, worker, coordinator, Orca, GitHub, Bridge 사이에서 관찰 가능해야 하는 의미를 정의한다. 구현자가 ID 연결을 추측하지 않게 하는 것이 목적이다.

## 1. Entity identity

Bridge가 구분해야 하는 기본 entity:

- Project: 사람이 인식하는 제품/프로젝트 이름
- Repository: GitHub의 canonical owner/name
- Orca Run
- Orca Task
- Orca Dispatch
- Orca Worker
- Orca Gate
- GitHub Pull Request
- coordinator session/terminal
- Slack PR root message
- Slack Run root message

같은 이름, 여러 Git remote, fork, repository rename, 여러 Run이 같은 repository에서 동작하는 경우의 canonicalization은 TBD다.

Project↔Repository 관계도 아직 확정하지 않았다. 최소한 설정 또는 durable store가 사람이 보는 Project identity와 GitHub repository identity를 연결하고 Slack routing에 제공해야 한다. cardinality, 자동 발견 시 생성 규칙, rename 처리, 수동 등록 주체는 TBD다.

## 2. PR correlation metadata

worker는 PR body **맨 끝**에 다음 블록을 붙인다. 사람이 읽는 내용을 밀어내지 않는 위치다.

```html
<!-- orca-run: run_abc -->
<!-- orca-task: task_xyz -->
<!-- orca-dispatch: dispatch_123 -->
```

- `orca-run`, `orca-task`는 **필수**, `orca-dispatch`는 선택이다.
- 작성 주체는 **worker**다. Orca가 dispatch preamble로 id를 주입하므로 worker가 자기 값을 안다.
- cardinality는 task 1 : PR N이다. 한 Task가 PR을 여러 개 만들면 각 PR에 같은 task id가 붙는다.
- 여러 Task가 한 PR을 이어서 갱신하면 PR body는 primary/latest Task 하나만 유지한다. PR↔Task N 연관은
  Bridge durable store에 별도로 저장한다. body metadata 형식과 parser 계약은 바꾸지 않는다(OD-076).
- key 이름은 Bridge 설정으로 override할 수 있다.

연결 방향:

```text
canonical repository + PR number
  → Orca Run → Task → Dispatch/Worker → worker_done
```

Bridge는 매 관찰 시 현재 PR body를 읽는다. 값이 바뀌면 그 시점 body가 기준이다.

### 누락·불일치 정책

| 상황 | 보고 |
|---|---|
| metadata 없음 | `uncorrelated(no_metadata)` |
| task/dispatch만 있고 run 없음 | `uncorrelated(run_missing)` |
| run은 있고 task 없음 | invalid/degraded input. Task 카드를 만들지 않음 |
| 가리키는 Run이 Orca에 없음 | `uncorrelated(run_not_found)` |
| 같은 key가 서로 다른 값으로 중복 | `conflict` |
| metadata의 task가 다른 Run에 속함 | `conflict` |

`uncorrelated`는 실패가 아니라 **정상 출력**이다. Bridge는 branch 이름이나 PR 제목으로 추측해 확정하지 않고, 모순을 자동으로 한쪽으로 덮지 않는다. C1은 `uncorrelated` 또는 `conflict` PR에 Slack 카드를 만들지 않는다.

`orca-run`만 있고 필수 `orca-task`가 없는 입력은 OD-021 위반인 invalid/degraded input이다. 별도
`run_correlated` kind는 Run-level 제품 의미가 필요해질 때만 도입한다(OD-077).

## 3. Worker 완료 계약

- worker는 배정된 Dispatch 완료 시 `worker_done`을 정확히 한 번 보낸다.
- body의 executive summary는 장문 transcript가 아니라 정확히 세 문장이다.
  - 첫 문장: 무엇을 했는가
  - 둘째 문장: 무엇을 발견했는가
  - 셋째 문장: 무엇이 남았는가
- reviewer Dispatch는 같은 body에 §6의 `reviewer_result` JSON도 싣는다. reviewer가 판정을 전달하고
  coordinator가 durable result를 기록한다.
- **PR을 만든 뒤에 `worker_done`을 보낸다.** 완료 신호가 리뷰 대상보다 먼저 도착하지 않게 한다.
- **PR identity를 `worker_done`에 싣지 않는다.** 연결 방향이 PR → task이고 PR body의 correlation metadata가 유일한 연결점이다. worker 명령에서 raw `--payload` JSON은 PowerShell이 따옴표를 깨뜨릴 수 있어 쓰지 않는다.
- `--files-modified`는 사용한다.
- `task.result`는 `worker_done`의 권위가 아니다. `task-update --result`가 기존 `worker_report`를 통째로
  대체하기 때문이다. Bridge는 `worker_done`을 Run별
  `orca orchestration inbox --terminal "run:<run_id>" --limit <n> --json`에서 읽고,
  `reviewer_result`만 `task.result`에서 읽는다(OD-075).
- `worker_done`이 정말 없으면 카드는 계속 만들고 `worker 보고 없음`을 표시한다. 다만 Run mailbox 반환
  행 수가 요청 상한과 같아 최신 N건 안에서 못 찾은 경우는 없음이 아니라 판정 불가이므로 던진다.
- C1은 `worker-read` fallback을 사용하지 않는다. 따라서 transcript는 summarizer 입력도 Slack 카드 입력도 아니다.

## 4. Gate 생성 계약

질문의 승격 경계:

```text
Worker ask/escalation
  → Coordinator가 spec/code/live state/공인 자료로 판단 가능
      → Worker reply
  → Coordinator도 owner 판단 없이는 결정 불가
      → 해당 Task에 연결된 Orca Gate 생성
```

- worker의 모든 질문이 Gate가 되는 것은 아니다.
- 사람에게 올릴 Gate는 coordinator가 생성한다.
- Bridge는 일반 ask/reply를 Slack에 표시하지 않고 open Gate만 관찰한다.
- ask를 Gate로 승격할 때 Bridge는 `{askMessageId, questionThreadId, dispatchId, taskId, gateId}` mapping을
  durable하게 저장하고 권위 correlation으로 쓴다. Gate question 문자열은 표시용이다(OD-019).
- escalation은 payload의 Task·Dispatch까지만 연결하고 별도 명시 mapping이 있을 때만 특정 ask/Gate에 귀속한다.

Slack Gate 카드에는 다음 의미가 필요하다.

- 질문
- 선택지와 각 선택지 설명
- coordinator 권장안
- 권장 이유
- 결정 영향
- 이 Gate에 의존해 대기하는 Task
- 독립적으로 계속할 수 있는 Task

Orca Gate의 `question`/`options`에는 사람이 읽는 짧은 요약만 둔다. 안정적 option ID, 설명,
recommendation, impact는 Bridge sidecar에 저장해 Orca Gate ID와 연결하고 기계 판정에 사용한다.
`--options`는 `string[]`만 받으므로 객체 배열이나 자유 텍스트 parsing에 의존하지 않는다(OD-050).

Bridge가 coordinator의 장문 reasoning을 수집해 임의로 권장안이나 영향을 만들어내서는 안 된다.

## 5. Run↔repository↔coordinator 연결

D1의 연결은 다음 권위 경계를 따른다.

```text
설정 파일에 수동 등록한 Repository (OD-068)
  ├─ repositories: owner/name        — GitHub 축이 쓴다
  └─ orcaRepositoryIds: <id>         — Orca 축이 쓴다 (OD-078)
        ↕ exact 문자열 비교
     Task.created_by_process_incarnation  = <id>::<path>@@<hash>:<uuid>
     worker.resource.worktreeId           = <id>::<path>
        ↓
  ↔ Orca Run row
      ├─ coordinator_handle
      ├─ coordinator_pane_key
      └─ consumer_generation
```

Orca Run은 repository-bound entity가 아니라 durable namespace/coordinator inbox다. D1은 설정 파일에 수동 등록한
repository만 관찰하며, repository 연결은 그 설정을 따른다. 자동 발견, Git remote 기반 자동 등록, 자동 발견된
다중 repository routing은 O1 범위다(OD-068).

Run을 등록된 repository에 잇는 열쇠는 설정의 `orcaRepositoryIds`다. Run row에는 repository 필드가 없고 경로에서
`owner/name`을 얻을 수단도 조회 표면에 없으므로, 관측 가능한 연결점은 `<id>::<path>`의 앞부분 하나뿐이다.
이 앞부분은 worktree가 아니라 repository의 id이며 id 하나가 여러 worktree 경로를 덮는다. 경로가 아니라 id로
등록하고 exact 문자열로 비교한다. 등록에 맞지 않는 Run은 버리지 않고 수와 관측된 id를 함께 노출한다 —
id 형식이나 발급이 바뀌었을 때 카드가 조용히 비는 대신 그 사실이 드러나야 한다(OD-078, OD-072).

Run/coordinator identity는 Orca Run row가 권위다. `run-list`가 반환하는 `coordinator_handle`·
`coordinator_pane_key`·`consumer_generation`을 사용하고, coordinator 세션의 `ORCA_TERMINAL_HANDLE`·
`ORCA_PANE_KEY`·`ORCA_WORKTREE_ID` 같은 환경변수는 보조 단서로만 쓴다. `run-use` 인수는 두 coordinator
필드를 인수한 터미널 값으로 바꾸고 `consumer_generation`을 올리므로 handle은 재시작·인수를 거쳐 유지되지
않는다. binding 하나의 live/stale은 현재 `consumer_generation`을 기준으로 구분한다(OD-020).

**Run 수준 rollup은 `live`와 `unknown` 둘뿐이다.** `stale`은 binding 하나에만 쓴다. "관측된 binding이 전부
낮은 세대다"는 Run이 버려졌다는 근거가 되지 못한다 — `run-use` 인수 직후 새 coordinator가 기존 ready task만
dispatch하면 새 세대가 만든 Task가 하나도 없고, 그 정상 handoff 구간 내내 살아 있는 Run이 죽은 것으로 그려진다.
게다가 `run-use`가 `consumer_generation`을 올린다는 것 자체가 `platform-capabilities.md` §7.2에 미검증
가정으로 기록돼 있다. 관측하지 못한 것을 단정하지 않는다 — required check 축의 `indeterminate`가 같은 판단이다.
세대 분포는 관측된 binding 목록이 그대로 보여준다.

global `worker-list`의 `runId`와 `resource.worktreeId`는 repository 후보를 보조할 수 있지만 historical/released
worker도 포함하므로 liveness 증거가 아니다. 이 Run에서 worktree id의 `<uuid>::<path>` 형식을 반복 사용해
모두 동작한 것은 관측일 뿐이며, 그 형식의 안정성은 계약으로 보장되지 않았다.

## 6. PR canonical state

**review verdict의 durable source는 Orca다.** 대상 repository 전부에서 GitHub `reviewDecision`이 null이고, PR author와 review author가 같은 계정이라 GitHub이 self-approve를 막으므로 formal verdict가 원리적으로 불가능하다(DL-016).

reviewer는 판정하고 자기 `worker_done` 본문에 결과를 싣는다. reviewer terminal은 Run에 바인딩되지 않아
`task-update`를 직접 호출할 수 없다.

```text
reviewer 판정 + worker_done(reviewer_result JSON)
  → reviewer Dispatch settle
  → coordinator가 task-update --id <review_task> --status completed --result <json>
```

```json
{
  "kind": "reviewer_result", "schemaVersion": 1,
  "verdict": "approve",
  "pr": { "repo": "owner/name", "number": 31 },
  "reviewedHeadSha": "…",
  "findings": [{ "severity": "blocker", "file": "path.ts", "line": 750, "summary": "…" }],
  "gates": { "lint": "pass", "test": "pass" }
}
```

`verdict`는 `approve` 또는 `request_changes`다. `request_changes`여도 review task 자체는 `completed`다. 리뷰라는 작업은 끝났기 때문이다.

순서를 바꾸지 않는다. reviewer Dispatch가 살아 있는 동안 coordinator가 기록하면 `task_not_startable`이므로
settle된 뒤에만 기록한다. worker는 `run-use`를 실행하지 않는다. Run의 coordinator 소유권을 가져가 기존
coordinator를 fence하기 때문이다. reviewer의 `task-update`가 `run_required` 또는 `consumer_fenced`로 거부되는
것은 coordinator single-writer를 보존하는 올바른 동작이다.

Windows에서도 중첩 객체·배열·한글·백틱을 포함한 `--result` JSON이 `task-list --json`까지 무손실로 왕복됨을
확인했다. 여러 `reviewer_result`가 있으면 `completedAt` 최신 1건을 선택하고, 동률이거나 시각이 없으면 task id
사전순으로 결정한다.

`reviewedHeadSha`와 현재 head의 일치 여부(`headMatch`)는 사실로 노출한다. Bridge는 reviewer가 본 commit과
현재 head가 다르다는 사실을 표시할 뿐, 이전 approval의 유효·무효는 판정하지 않는다. 새 head마다
재리뷰를 강제하지 않고 GitHub repository의 stale-review 설정을 따라가지도 않는다(OD-031).

GitHub review 본문의 `## Verdict` / `## Gates` / `## Findings` 규약은 표시용 보조 사실로만 쓰고 상태 source로 삼지 않는다. 신뢰 경계상 untrusted content다.

canonical PR state는 terminal `open | closed | merged`와 직교 축 `draft`, `review`, `checks`,
`mergePolicy`를 보존하고 UI 의미 상태를 파생한다. `mergedAt != null`을 `merged` terminal latch로 쓴다(OD-030).

다음은 사용자에게 보여줄 파생 의미다.

| 의미 | 필요한 source fact 후보 |
|---|---|
| 구현 완료·리뷰 진행 중 | PR 존재 + worker 완료 + review 미완료 |
| 리뷰에서 수정 필요 | changes-requested verdict 사실 |
| 수정 후 재검토 중 | changes requested 이후 새 head + 재검토 상태 |
| 리뷰 통과 | approval verdict 사실 |
| CI 통과 | current head의 required checks 충족 |
| 병합 준비 완료 | current head의 required checks가 모두 passing |
| 병합 완료 | `mergedAt != null` |

`Merge Ready`는 GitHub 단일 필드가 아니라 required check만으로 판정하는 derived state다. base branch의
effective required rule과 current head rollup을 조인해 `mergePolicy` 축 하나를 만든다. optional check
실패는 merge를 막지 않는다(OD-032).

**이 축은 required check 축 하나이지 merge 가능 여부의 최종 답이 아니다.** merge queue, required reviews,
up-to-date(strict), conversation resolution은 C2 범위 밖이고 이 축이 판정하지 않는다(OD-032). 축이 막지
않는다는 것은 required check가 막지 않는다는 뜻이다.

축 값은 성격이 다른 두 갈래에서 온다.

**조인 결과** — rule을 읽었고 required context가 하나 이상일 때, context별 상태 중 가장 무거운 것이다.

| 값 | 뜻 |
|---|---|
| `failing` | required context 하나 이상이 실패했다 |
| `missing` | required context 하나 이상이 current head rollup에 아예 없다. 이 상태의 merge는 405로 거절된다 |
| `indeterminate` | 동명 row는 있으나 보고 주체를 관측할 수 없어 충족도 불충족도 단정할 수 없다 |
| `pending` | required context 하나 이상이 아직 결론 나지 않았다 |
| `passing` | required context 전부가 충족됐다. `CI 통과`·`병합 준비 완료`가 이 값이다 |

`indeterminate`를 어느 쪽으로도 접지 않는다. `passing`으로 접으면 실측된 false positive(PAT가 만든 동명
status에도 merge는 405였다)를 통과로 그리고, `missing`으로 접으면 Expected-App의 정상 보고가 false
negative가 된다. commit status에는 app을 식별할 field가 GraphQL에 없다는 것이 그 관측의 근거다.

**rule source의 상태** — 조인 결과가 아니라 base branch 정책을 읽은 결과다. 위 다섯 값을 만들 전제가
서지 않는 두 경우이며 조인 결과보다 앞선다.

| 값 | 뜻 |
|---|---|
| `no_required_rules` | required rule이 하나도 없다. degraded가 아니라 정상이고 이 축이 merge를 막지 않는다. 통과한 check가 없으므로 `CI 통과`도 `병합 준비 완료`도 아니다 |
| `rules_unreadable` | 정책 조회가 403이었다. rule 집합 자체를 모르므로 관측된 context가 전부 통과해도 충족을 단정할 수 없다. degraded다 |

404는 `rules_unreadable`이 아니다. GitHub이 미보호와 권한 부족에 같은 404를 주어 구분할 사실이 없다.

이 축은 headline 한 줄로 접히지 않는다. headline은 PR 전체에 대한 한 줄이므로 거기에 `병합 준비 완료`를
두면 판정하지 않은 다른 merge 조건까지 충족했다는 읽기를 준다. 카드는 축을 자기 자리에서 표시하고 판정하지
않은 조건을 같은 자리에서 밝힌다.

## 7. Run progress

Run 카드는 `현재 Task 상태별 수 / 현재 task-list.count`와 Dispatch attempts를 분리한다. Task가 분모 단위이고
실행 중 추가된 Task를 즉시 반영한다. retry Dispatch는 새 Task로 세지 않는다. 완료율·성공률 공식은 만들지
않으며 Orca Task 상태에는 `cancelled`가 없다(OD-069).

### Blocker taxonomy

`blocker`, `open Gate`, `blocked Task`, `waiting dependency`, `worker ask`, `CI failure`, interaction 대기는
같은 개념이 아니다. 각 원천 수를 별도 badge로 표시하고 `taskId`·`dispatchId`·Gate ID·message ID를 함께
노출한다. 고유 blocker 총합은 dedup 정책이 확정된 뒤에만 추가한다. `agentWait`는 interaction 대기로 표시하고
provider별 근거가 더 있을 때만 permission 등으로 세분화한다(OD-067).

degraded 상태는 카드에 항상 표시한다. owner 개입 없이는 진행되지 않는 Channel pending·미해결 Gate·correlation
실패만 thread transition을 만들고, summarizer failure·source stale은 badge만 갱신한다(OD-072).

## 8. 중요한 transition과 중복 제거

thread에는 raw event가 아니라 semantic transition을 기록한다.

PR 후보:

- PR 생성
- review에서 문제 발견
- 수정 완료 및 재검토
- review 통과
- CI 핵심 실패 또는 통과
- merge 완료

Run/Gate 후보:

- Run 시작
- Gate 생성
- owner 결정이 Orca에 기록됨
- coordinator notification pending/attempted
- dependent Task 재개 관찰
- Run 완료

Gate resolution write는 Gate별 durable lock 또는 CAS로 직렬화한다. 같은 논리 요청은 같은 retry request ID를
재사용하고 `mutation.replayed`를 처리하며, resolve 전후 재조회와 durable outbox reconciliation으로 수렴시킨다.
Orca 내부 transaction 원자성은 이 계약의 보장이 아니다(OD-051).

같은 snapshot을 반복 관찰해도 동일 transition을 다시 만들지 않아야 한다. PR identity는
`(repository databaseId, PR number)`, terminal latch는 `mergedAt`, review/check scope는 `headSha`다.
`merged` downgrade 금지는 timestamp 비교가 아니라 terminal dominance rule이다. 동일 head 안의
review/check는 각 resource의 timestamp와 id로 reconcile한다(OD-044).

## 9. Source conflict 규칙

확정된 우선순위:

- Gate 상태·resolution: Orca
- PR/review/check/merge: GitHub
- Slack message identity와 delivery bookkeeping: Bridge durable store
- 제품 의미와 운영 규약: accepted spec

PR metadata가 Orca live state와 모순되면 자동으로 어느 한쪽을 덮어쓰지 않는다. 모순을 명시적 correlation error로 취급하고 해결 정책을 적용한다.

## 10. 계약 확정 전 검증 자료

구현 전에 실제 대상 버전에서 다음 fixture 또는 snapshot이 필요하다.

- 최소 한 개 Run의 run/task/worker JSON
- `worker_done`이 있는 worker와 release된 worker 사례
- open/resolved Gate JSON
- 여러 reviewer와 새 commit이 있는 PR
- required/optional check 조합
- merge conflict, draft, merged PR
- live coordinator와 stale coordinator handle
- correlation metadata 정상·누락·불일치 사례

민감 정보는 redaction하고, 실제 schema를 확인하기 전에는 기억이나 예시 필드로 adapter를 구현하지 않는다.
