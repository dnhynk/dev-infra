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
| 가리키는 Run이 Orca에 없음 | `uncorrelated(run_not_found)` |
| 같은 key가 서로 다른 값으로 중복 | `conflict` |
| metadata의 task가 다른 Run에 속함 | `conflict` |

`uncorrelated`는 실패가 아니라 **정상 출력**이다. Bridge는 branch 이름이나 PR 제목으로 추측해 확정하지 않고, 모순을 자동으로 한쪽으로 덮지 않는다. C1은 `uncorrelated` 또는 `conflict` PR에 Slack 카드를 만들지 않는다.

## 3. Worker 완료 계약

- worker는 배정된 Dispatch 완료 시 `worker_done`을 정확히 한 번 보낸다.
- body는 장문 transcript가 아니라 정확히 세 문장이다.
  - 첫 문장: 무엇을 했는가
  - 둘째 문장: 무엇을 발견했는가
  - 셋째 문장: 무엇이 남았는가
- **PR을 만든 뒤에 `worker_done`을 보낸다.** 완료 신호가 리뷰 대상보다 먼저 도착하지 않게 한다.
- **PR identity를 `worker_done`에 싣지 않는다.** 연결 방향이 PR → task이고 PR body의 correlation metadata가 유일한 연결점이다. worker 명령에서 raw `--payload` JSON은 PowerShell이 따옴표를 깨뜨릴 수 있어 쓰지 않는다.
- `--files-modified`는 사용한다.
- C1에서 `worker_done`이 없으면 카드는 계속 만들고 `worker 보고 없음`을 표시한다. 중복·불완전 payload의 recovery는 C2에서 정한다.
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
- ask/escalation과 Gate의 correlation, Gate 생성 command/payload는 실제 Orca sample을 확인한 뒤 확정한다.

Slack Gate 카드에는 다음 의미가 필요하다.

- 질문
- 선택지와 각 선택지 설명
- coordinator 권장안
- 권장 이유
- 결정 영향
- 이 Gate에 의존해 대기하는 Task
- 독립적으로 계속할 수 있는 Task

현재 Orca Gate schema가 이 의미를 모두 직접 제공하는지는 검증되지 않았다. 부족한 정보가 있다면 다음 중 어떤 방식으로 표현할지 빌드 중 확정한다.

- Gate 필드 확장
- 구조화된 Gate metadata
- Task/Run 상태에서 파생
- Bridge가 표시 가능한 축소 UI

Bridge가 coordinator의 장문 reasoning을 수집해 임의로 권장안이나 영향을 만들어내서는 안 된다.

## 5. Run↔repository↔coordinator 연결

자동 발견에는 최소한 다음 연결이 필요하다.

```text
Orca Run
  → coordinator handle/session
  → live terminal 또는 Run에 속한 Worker resource
  → worktree/folder/repository
  → Git remote
  → GitHub repository
```

Orca Run은 repository-bound entity가 아니라 durable namespace/coordinator inbox다. Bridge가 Run 하나를 repository 하나에 제한할지, 여러 repository를 허용할지는 지원 정책으로 정해야 한다. 로컬 Orca 1.4.179 관측상 `run-list` row만으로 repository/worktree와 실제 coordinator liveness를 판정할 수 없다. global `worker-list`의 `runId`와 `resource.worktreeId`를 통해 일부 Run의 repository 후보를 복구할 수 있지만 historical/released worker도 포함되므로 liveness 증거는 아니며 worker가 없는 Run에는 적용되지 않는다. 따라서 다음이 TBD다.

- live terminal을 authoritative하게 판정하는 방법
- coordinator 재시작 후 같은 Run과 새 session을 연결하는 방법
- 여러 live Run이 같은 repository를 사용할 때 routing
- stale run/coordinator handle 처리
- 자동 발견 실패 시 수동 등록 형식

## 6. PR canonical state

**review verdict의 durable source는 Orca다.** 대상 repository 전부에서 GitHub `reviewDecision`이 null이고, PR author와 review author가 같은 계정이라 GitHub이 self-approve를 막으므로 formal verdict가 원리적으로 불가능하다(DL-016).

reviewer는 자기 review task에 결과를 기록한다.

```text
orca orchestration task-update --id <review_task> --status completed --result <json>
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

`reviewedHeadSha`는 새 commit 이후 이전 approval이 유효한지 판정할 근거다.

GitHub review 본문의 `## Verdict` / `## Gates` / `## Findings` 규약은 표시용 보조 사실로만 쓰고 상태 source로 삼지 않는다. 신뢰 경계상 untrusted content다.

다음은 사용자에게 보여줄 의미 상태 후보이며 최종 enum이 아니다.

| 의미 | 필요한 source fact 후보 |
|---|---|
| 구현 완료·리뷰 진행 중 | PR 존재 + worker 완료 + review 미완료 |
| 리뷰에서 수정 필요 | 유효한 changes-requested verdict |
| 수정 후 재검토 중 | changes requested 이후 새 head + 재검토 상태 |
| 리뷰 통과 | 현재 head에 대해 요구되는 review 조건 충족 |
| CI 통과 | 현재 head의 required checks 충족 |
| 병합 준비 완료 | draft 아님 + review/CI/merge 조건 충족 |
| 병합 완료 | GitHub merged fact |

정식 상태 전이 전에 다음을 결정한다.

- 여러 reviewer의 상충 verdict
- 새 commit 이후 이전 approval 유효성
- required/optional check
- failed, cancelled, skipped, neutral, pending 처리
- draft PR과 ready-for-review
- merge conflict와 merge queue
- reopened와 closed-without-merge
- force-push로 사라진 head의 transition

`Merge Ready`는 GitHub 단일 필드가 아니라 명시적으로 정의할 derived state다.

## 7. Run progress

Run 카드의 `완료/전체` 진행률에 포함할 Task 집합이 필요하다.

미결정 항목:

- 동적으로 추가된 Task
- cancelled/failed Task
- retry된 Task
- 한 Task의 여러 Dispatch
- Gate에 blocked된 Task와 dependency waiting Task
- 완료 뒤 다시 열린 Task

숫자가 Orca source와 어떤 규칙으로 일치하는지 `OD-069`에서 확정하기 전에는 진행률을 “정확하다”고 주장하지 않는다.

### Blocker taxonomy

`blocker`, `open Gate`, `blocked Task`, `waiting dependency`, `worker ask`, `CI failure`, `permission pause`는 같은 개념이 아니다. `#agent-runs`의 blocker 수에 무엇을 포함하고 각각을 어떻게 표시할지는 TBD다. 최소한 사람 결정용 open Gate와 그 Gate 때문에 대기하는 Task 수를 서로 다른 값으로 구분할 수 있어야 한다.

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

같은 snapshot을 반복 관찰해도 동일 transition을 다시 만들지 않아야 한다. event key, state version, source timestamp, out-of-order 우선순위는 TBD다.

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
