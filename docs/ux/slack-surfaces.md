# Slack 메시지 UX 스펙

상태: **Draft · 문구와 Block Kit layout 미확정**

이 문서는 사용자가 모바일에서 Agent 개발 전체를 빠르게 파악하도록 메시지의 정보 구조와 상태별 의미를 정의한다. 예시는 고정 문구가 아니라 semantic requirement다.

## 1. 공통 원칙

- 최상단에서 어느 project/repository의 어느 PR 또는 Run인지 즉시 보인다.
- 루트 메시지는 현재 상태를 보여준다.
- thread는 중요한 상태 변화의 역사만 보여준다.
- Agent 장문 reasoning이나 transcript를 복사하지 않는다.
- LLM이 Block Kit이나 action을 직접 만들지 않는다.
- 성공, 안전성, 테스트 통과는 source fact가 있을 때만 표시한다.
- 상태 표현은 한국어 중심으로 하되 product/repository/Run/PR identity는 원본 식별자를 보존한다.
- 접근성을 위해 emoji나 색상만으로 상태를 구분하지 않는다.

카드 identity는 Project가 등록됐으면 `[Project] owner/repo #N`, 등록되지 않았으면 `owner/repo #N`이다. 예시의 `[toneandmove] PR #184`는 이 표현을 축약한 것이다.

## 2. `#pr-digest`

### 2.1 PR 최초 발견·리뷰 진행 중

```text
🟡 [toneandmove] PR #184 · 결제 중복 처리 방지

무엇이 바뀌나
같은 결제 요청이 여러 번 들어와도 한 번만 처리되도록 수정했습니다.

왜 필요한가
네트워크 재시도 상황에서 같은 결제가 중복 실행될 가능성이 있었습니다.

현재
구현 완료 · 리뷰 진행 중

영향
결제 서버 변경 / DB 구조 변경 없음

[PR 보기]
```

필요 의미:

- repository와 PR identity
- 사람이 이해할 수 있는 title
- what/why
- 현재 lifecycle 상태
- 확인된 영향
- GitHub 원문 링크

### 2.2 Review changes requested

같은 루트 메시지를 갱신한다.

```text
⚠️ [toneandmove] PR #184 · 결제 중복 처리 방지

현재
리뷰에서 예외 상황 1개 발견 → 수정 중

리뷰 핵심
결제 응답이 지연된 뒤 재시도되는 경우에도
중복 처리가 발생하지 않도록 추가 보완이 필요합니다.

위험도
낮음 — 외부 API 변경 없음

[PR 보기]
```

`예외 상황 1개`, `낮음`, `외부 API 변경 없음`은 실제 review와 changed-files/diff facts로 뒷받침될 때만 표시한다.

### 2.3 Review·CI 통과, merge 준비

```text
🟢 [toneandmove] PR #184 · 결제 중복 처리 방지

현재
리뷰 통과 · CI 통과 · 병합 준비 완료

검증
동시 요청과 재시도 상황을 포함한 회귀 테스트 추가

위험도
낮음

[PR 보기]
```

`병합 준비 완료`의 정확한 판정은 canonical state 계약을 따른다.

### 2.4 Merge 완료

```text
✅ [toneandmove] PR #184 · 결제 중복 처리 방지

병합 완료

결과
네트워크 재시도 상황에서 동일 결제가
두 번 처리될 가능성을 차단했습니다.

검증
Review ✅ · CI ✅ · Merge ✅

[PR 보기]
```

### 2.5 PR thread

```text
[toneandmove] PR #184 · 결제 중복 처리 방지
│
├─ 13:21 PR 생성
├─ 13:39 ⚠️ 리뷰에서 예외 상황 발견
├─ 13:51 수정 완료 및 재검토 요청
├─ 14:04 ✅ 리뷰 통과
└─ 14:09 ✅ main 병합
```

thread 요구:

- 중요한 transition마다 한 번만 기록
- 상태와 시각
- 필요한 경우 핵심 의미 한두 문장
- 동일 snapshot 재관찰이나 Bridge 재시작으로 중복 reply를 만들지 않음

## 3. `#agent-runs`

### 3.1 Run 현재 카드

```text
🟢 *[dev-infra] dnhynk/dev-infra* · run_36d28e6e947a · Slack Bridge D1 Run Observer

*Run identity*
Run ID run_36d28e6e947a
소유자 binding 🟢 live — Run row의 현재 소유자 binding으로 만들어진 Task를 관측했다
Run row의 현재 소유자 generation 2 · term_6354ef22
• ⚫ stale · generation 1 · term_29548394 · 이 binding이 만든 Task 39
• 🟢 live · generation 2 · term_6354ef22 · 이 binding이 만든 Task 24

*진행*
task-list.count 10
completed 6
dispatched 2
blocked 1
ready 1

*Dispatch attempts*
attempts 71
completed 57
failed 13
dispatched 1
재시도가 있었던 Task 4
attempt 이력이다. retry는 Task 수를 늘리지 않으므로 진행 절과 더하지 않는다

*PR*
• #9 🟡 열림 · 리뷰에서 수정 요청
• #10 ⛔ 병합 없이 닫힘 · 리뷰 결과 없음
• #25 ✅ 병합 완료 · 리뷰 통과
digest가 관측하고 correlation에 성공한 PR만 여기 있다. 그 밖의 PR은 이 Run이 만들었더라도 카드에 나타나지 않는다

*blocker · 현재 상태*
• open Gate 2
    ↳ gate gate_a1 · task task_t1 — 구독 취소 시 권한 종료 시점
    ↳ gate gate_a2 — 두 번째 Gate
• blocked Task 3
    ↳ task task_b1 — b1
    ↳ task task_b2 — b2
    ↳ task task_b3 — b3
• interaction 대기 1
    ↳ task task_w1 · dispatch ctx_w1 — agent: codex-interactive-prompt

*blocker · 관찰 창 안에서만 판정*
• worker ask 1
    ↳ task task_q1 · dispatch ctx_q1 · message msg_q1 — 계약을 확인해 달라
미답 여부를 inbox 조회 창 안에서만 판정했다. degraded에 inbox_saturated가 있으면 이 수를 확정으로 읽지 않는다

*blocker · 누적 이력 (현재 blocker가 아니다)*
• escalation 1
    ↳ task task_e1 · dispatch ctx_e1 · message msg_e1 — Blocked: gh 인증
• failed Dispatch 13
    ↳ task task_f0 · dispatch ctx_f0 — failed
    ↳ task task_f1 · dispatch ctx_f1 — failed
    ↳ task task_f2 · dispatch ctx_f2 — failed
    ↳ task task_f3 · dispatch ctx_f3 — failed
    ↳ task task_f4 · dispatch ctx_f4 — failed
    ↳ 외 8건은 카드에 싣지 않았다
만료가 없는 수다. 이미 retry로 완료된 Task의 과거 실패와 이미 해소된 escalation도 계속 셈된다. 지금 막혀 있다는 뜻이 아니다

*blocker · 이 관측 표면에서 만들 수 없음*
• ciFailure — Orca schema에 CI 전용 상태가 없다

*degraded*
이 Run
• [liveness_unknown] Task가 없어 Run row와 대조할 binding이 없다
관찰 전체
• [unverified_platform_assumption] live/stale 판정은 run-use가 consumer_generation을 올린다는 미검증 가정 위에 있다

*등록되지 않은 Run*
1
• run_aaa — 관측된 Orca repository id: other-id
    ↳ [unregistered_repository] 관측된 Orca repository id가 설정에 없다: other-id
각 Run의 등록 판정 근거는 그 줄의 degraded에 있다. unregistered_repository는 설정의 projects[].orcaRepositoryIds에 등록해야 표시 대상이 되고, query_failed는 조회가 실패해 등록 여부를 아직 판정하지 못한 것이다
```

위 블록은 `apps/orca-slack-bridge/test/run-render.test.ts`의 fixture로 `renderRunCard`를 돌린
출력을 손대지 않고 옮긴 것이다 — 그 파일의 `facts()` 기본값에, 같은 파일이 쓰는 PR 3행(`#9`
open·request_changes, `#10` closed·verdict 없음, `#25` merged·approve)과 미등록 Run 1건
(`run_aaa`, `unregistered_repository`)을 넣었다. fixture 자체는 실측 Run `run_36d28e6e947a`
(2026-08-24 관측)의 수에 맞춰 만든 것이다. 블록 사이 빈 줄은 Slack section block 경계이고
`*…*`는 mrkdwn 굵게 표기다. Slack 알림용 fallback `text`는 이 블록에 없다.

렌더러가 무조건 찍는 설명 줄(Dispatch attempts의 retry 주석, PR 절의 관측 경계, worker ask의
관찰 창 한정, 누적 이력의 만료 없음, 미등록 절의 판정 근거)을 예시에서 빼지 않는다. 그 줄들이
카드가 자기 경계를 말하는 자리이고, 빼면 예시가 계약을 축소해 보여준다.

표시할 의미:

- project/repository
- Run identity와 사람이 이해할 수 있는 제목
- 실행 상태
- 정의된 규칙에 따른 Task 진행률
- 관련 PR의 핵심 상태
- 원천별 blocker badge와 open Gate 수
- 현재 owner 개입 필요 여부

진행 표시는 `현재 Task 상태별 수 / 현재 task-list.count`이며 실행 중 추가된 Task를 즉시 반영한다.
Dispatch retry는 `Dispatch attempts` 이력으로 따로 보이고 완료율·성공률 퍼센트는 만들지 않는다(OD-069).

blocker는 open Gate, blocked Task, waiting dependency, worker ask, CI failure, interaction 대기 등 원천별 badge와
연결 ID로 표시한다. 고유 blocker 총합은 dedup 정책 전에는 표시하지 않고 `agentWait`는 provider별 근거 없이
permission으로 단정하지 않는다(OD-067).

비율을 전제하는 그래픽 progress bar는 사용하지 않는다(OD-069).

### 3.2 Gate 결정 카드

Run thread에 표시한다.

```text
⚠️ 결정 필요

문제
사용자가 구독을 취소했을 때 서비스 이용 권한을
언제 종료할지 결정이 필요합니다.

A · 즉시 종료
취소 순간부터 유료 기능을 사용할 수 없음

B · 결제 기간 종료 시 종료
이미 결제한 기간까지 계속 사용 가능

Coordinator 권장
B

이유
일반적인 구독 서비스 동작과 맞고,
이미 결제한 사용 기간을 보장할 수 있습니다.

영향
이 결정이 나올 때까지 Backend와 Billing 작업 2개가 대기합니다.
다른 작업은 계속 진행 중입니다.

[A 즉시 종료] [B 기간 종료] [직접 입력]
```

버튼 label은 짧게 유지한다. 사람이 읽는 question/options 요약과 별도로 안정적 option ID·설명·recommendation·impact를
Bridge sidecar에 저장해 Gate ID와 연결하고, action은 이 metadata로 판정한다(OD-050).

### 3.3 자유형 결정 modal

`[직접 입력]`은 해당 Gate에 연결된 modal을 연다.

```text
직접 결정

┌─────────────────────────────┐
│ B로 가되, enterprise 플랜은 │
│ 즉시 취소 옵션도 유지해.    │
└─────────────────────────────┘

[결정 전송]
```

modal 제출 text는 해당 Gate의 `resolution`으로 저장한다. 일반 Slack message 입력으로 대체하지 않는다.
필수값·형식 오류는 3초 안에 해당 input block에 `response_action=errors`로 표시해 modal을 유지한다.
원격 Orca 작업이 끝나기를 ACK 전에 기다리지 않는다(OD-071).

### 3.4 결정 기록과 작업 재개

Orca resolution 성공 뒤:

```text
✅ 결정됨 · B

결제 기간이 끝날 때 권한을 종료합니다.

14:23 · 김동현
```

coordinator notification 이후 실제 후속 상태를 관찰한 뒤:

```text
▶️ 작업 재개

결정이 Coordinator에 전달되었고 후속 Task가 시작됐습니다.

다시 시작:
- Backend Task #7
- Billing Task #8
```

Channel write만 성공했으면 `작업 재개`라고 쓰지 않는다. 그때는 `Coordinator 통지 대기` 또는 확정될 pending 표현을 사용한다.
application receipt가 전달 신호이고, 대상 Gate의 `pending`→`resolved` 전이가 Orca 효과다. receipt 뒤에도
실제 Task 재개는 별도 상태로 계속 구분한다(OD-054, OD-055).

## 4. 다중 repository 예시

```text
#pr-digest

🟢 [toneandmove] PR #184 · 결제 중복 처리 방지
리뷰와 CI가 통과해 병합 준비가 끝났습니다.

⚠️ [letter] PR #52 · 이메일 인증 개선
리뷰에서 예외 상황 하나가 발견되어 수정 중입니다.
```

```text
#agent-runs

⚠️ [letter] RUN-27 · 결정 필요
편지를 삭제한 뒤 수신자에게 기존 알림을 유지할지 결정이 필요합니다.

[A 유지] [B 제거] [직접 입력]
```

repository마다 채널을 새로 만들지 않고 identity와 thread로 구분하는 것이 기본 방향이다.

## 5. 상태별 최소 필드

| Surface | 최소 필드 |
|---|---|
| PR root | Project/Repository identity, PR number, title, current status, PR URL |
| PR semantic detail | what, why, 검증된 impact/risk/review/validation 중 해당 항목 |
| PR thread event | transition type, occurred/observed time, 짧은 설명 |
| Run root | Project/Repository identity, Run ID/title, status, Task summary, blocker/Gate summary |
| Gate card | Gate ID 연결, question, options, impact, action controls |
| Gate resolution | resolution, Slack owner identity, timestamp, Orca result |
| Resume event | notification 상태와 실제 재개 증거를 구분 |

## 6. Error와 degraded UX

다음 상태를 성공처럼 숨기지 않는다.

- Orca↔PR correlation 실패
- summarizer 실패 또는 schema invalid
- GitHub/Orca/Slack 데이터가 일시적으로 오래됨
- Slack 원본 메시지가 삭제돼 다시 연결이 필요함
- Gate는 해결됐지만 coordinator notification이 pending임
- coordinator 세션이 닫혀 있음
- Channel delivery는 시도했지만 처리 여부를 모름

카드에는 모든 degraded 상태를 표시한다. owner 개입 없이는 진행되지 않는 Channel pending, 미해결 Gate,
correlation 실패만 thread에 알린다. summarizer 실패와 source stale처럼 자가 복구되는 상태는 badge만 표시하고
thread 알림을 보내지 않는다(OD-072).

C1 카드에서만 확정한 degraded 표시:

- summarizer가 실패하면 축소 카드에 `요약 실패`를 표시한다.
- 입력 상한을 넘겨 일부만 관측했으면 잘림을 표시한다.
- 연결된 `worker_done`이 없으면 `worker 보고 없음`을 표시한다.
- correlation 실패 PR은 카드를 만들지 않으므로 Slack에 degraded 표시도 없다.

D1/D2에서 thread 알림 여부와 무관하게 degraded badge 자체는 항상 유지한다.

## 7. 초기 비허용 UI

- 일반 thread text를 coordinator에게 전달
- bot 또는 비-owner가 Gate를 resolve
- button 한 번으로 merge, force push, main reset, secret 변경, production rollback 실행
- permission prompt 원격 승인

고위험 action을 후속으로 추가한다면 대상·deployment identity를 다시 보여주는 별도 확인 단계가 필요하다.
