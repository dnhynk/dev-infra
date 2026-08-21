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

예시의 `[toneandmove]`는 identity 영역을 축약한 표현이다. Project와 Repository를 둘 다 표시할지, 같을 때 하나만 표시할지, Project가 미등록이면 어떤 fallback을 쓸지는 TBD다.

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
🟡 [toneandmove] RUN-42 · Subscription Billing Refactor

상태
실행 중

진행
6 / 10 tasks

PR
#184 ✅ merged
#185 🟢 ready
#186 ⚠️ changes requested

현재 Blocker
1

[상세 보기]
```

표시할 의미:

- project/repository
- Run identity와 사람이 이해할 수 있는 제목
- 실행 상태
- 정의된 규칙에 따른 Task 진행률
- 관련 PR의 핵심 상태
- 확정된 taxonomy에 따른 blocker와 open Gate 수
- 현재 owner 개입 필요 여부

그래픽 progress bar 사용 여부는 Block Kit layout을 확정할 때 결정한다.

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

버튼 label은 짧아야 하지만 resolution에는 선택지의 안정적인 ID와 전체 의미가 연결돼야 한다.

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

구체적인 오류 문구와 owner notification 정책은 `OD-072`에서 확정한다.

## 7. 초기 비허용 UI

- 일반 thread text를 coordinator에게 전달
- bot 또는 비-owner가 Gate를 resolve
- button 한 번으로 merge, force push, main reset, secret 변경, production rollback 실행
- permission prompt 원격 승인

고위험 action을 후속으로 추가한다면 대상·deployment identity를 다시 보여주는 별도 확인 단계가 필요하다.
