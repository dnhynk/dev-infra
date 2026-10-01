# Slack 메시지 UX 스펙

상태: **Draft · O1 background update/no-repost 계약 구현, 카드 시각 문법 확정(DL-074)**

이 문서는 사용자가 모바일에서 Agent 개발 전체를 빠르게 파악하도록 메시지의 정보 구조와 상태별 의미를 정의한다. §2, §3.4, §4의 예시는 고정 문구가 아니라 semantic requirement다. §3.1~§3.3과 §3.5의 카드 예시는 실제 renderer 출력이다.

## 1. 공통 원칙

- 카드 머리와 첫 칸에서 어느 Project·저장소의 어느 PR 또는 Run인지 즉시 보인다.
- 루트 메시지는 현재 상태를 보여준다.
- thread는 중요한 상태 변화의 역사만 보여준다.
- Agent 장문 reasoning이나 transcript를 복사하지 않는다.
- LLM이 Block Kit이나 action을 직접 만들지 않는다.
- 성공, 안전성, 테스트 통과는 source fact가 있을 때만 표시한다.
- 상태 표현은 한국어 중심으로 하되 Project·repository·PR 번호는 원본 이름을 보존한다. Run·Task·Gate·Dispatch·터미널
  ID와 hash는 카드에 싣지 않는다. 추적에 필요한 ID는 `runs` 명령의 사실 보고, store의 결정 기록, 운영 로그에 있다.
- 접근성을 위해 emoji나 색상만으로 상태를 구분하지 않는다. 머리의 종류 라벨이 상태를 말한다.

PR identity는 Project가 등록됐으면 `[Project] owner/repo #N`, 등록되지 않았으면 `owner/repo #N`이다. 알림용 대체 텍스트가
이 모양을 그대로 싣고, 카드 본문은 같은 사실을 `저장소`(`owner/repo · #N`)와 `Project` 칸으로 나눠 싣는다. §2 예시의
`[toneandmove] PR #184`는 이 identity를 축약한 것이다.

### 1.1 카드 시각 문법

모든 카드(Run·컬렉션·Gate 결정·결정 기록·PR·PR thread 전이·터미널 프롬프트·치명 종료 알림)는 같은 껍데기를 쓴다.
구현은 `apps/orca-slack-bridge/src/slack/card.ts` 하나다(DL-074).

```text
{emoji}  {종류} · {제목}                 ← header. 카드의 유일한 emoji
[버튼] [버튼]                             ← action block. 있을 때만
┃{색}                                     ← 아래는 색 바 attachment 안이다
┃ 라벨  값                                ← section fields, 두 열, section당 10칸
┃ 원인 → 행동 한두 문장                   ← 선택
┃ *목록 제목*                             ← 선택, 항목은 한 줄에 하나
┃ ───                                     ← divider
┃ 라벨  값                                ← 두 번째 fields(계기판)
┃ orca-slack-bridge · MM-DD HH:MM:SS KST <동사> · <기준>
```

- 색 바: blue `#2f81f7` 접수·진행 중, green `#1a7f37` 성공, red `#cf222e` 오류·막힘, amber `#bf8700` 결정·주의
  필요, purple `#8250df` 변경(병합), gray `#6e7781` 상태·판정 불가.
- 칸 값 안의 한정어는 ` · `로 잇고 목록은 한 줄에 하나씩 쓴다. 값이 없으면 빈칸 대신 `계산 불가`나 `확인 불가 · …`를 쓴다.
- 머리와 버튼은 최상위 `blocks`에, 본문은 `attachments[0].blocks`에 둔다. attachment 안의 버튼 클릭은
  `container.type: "message_attachment"`로 오고 Gate·직접 입력 handler는 `message`만 받기 때문이다. 버튼의 block·action
  ID는 store가 클릭마다 다시 계산해 대조한다.
- 카드에 싣지 않는 것: 링크(PR 버튼의 URL만 예외), code span, mention, raw JSON, 내부 ID와 12자 이상 hash, 경로,
  `[snake_case]` 진단 코드. mention은 치명 종료 알림의 owner mention만 예외다.
- 시각: 살아 있는 카드(Run·컬렉션·PR 루트)는 게시 직전 시각을 `갱신`으로 싣고, 렌더 지문은 그 시각을 비운 렌더에서
  계산한다. 시각만 바뀐 관찰은 카드를 갱신하지 않으므로 카드의 시각은 마지막으로 내용이 바뀐 시각이다. Gate 결정·결정
  기록·터미널 카드는 현재 시각을 읽지 않고 저장된 사실의 시각만 쓴다. 열린 Gate 카드에는 시각이 없다.
- 알림용 대체 텍스트(`text`)는 블록을 그리지 못하는 자리를 위해 종류 라벨과 identity를 싣는다. mrkdwn으로 해석되므로
  본문과 같은 이스케이프를 거친다. 머리는 plain_text라 이스케이프하지 않는다.

예시의 `┃` 아래는 색 바 안이고, `라벨  값`은 칸 하나, 값의 다음 줄은 같은 칸의 다음 줄이다. `[버튼 · primary]`는
권장 선택지의 강조 버튼이다.

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
❓  결정 필요 · Slack Bridge D1 Run Observer
┃amber
┃ Project  dev-infra · dnhynk/dev-infra
┃ 코디네이터  연결 확인 · 2세대
┃ Task 상태  완료 6
┃            진행 2
┃            막힘 1
┃            준비 1
┃ Task 전체  10개
┃ 사람 필요  Gate 결정 대기 2건
┃            interaction 대기 1건
┃            막힌 Task 3개
┃ PR  #9 열림 · 수정 요청
┃     #10 병합 없이 닫힘 · 리뷰 결과 없음
┃     #25 병합 완료 · 리뷰 통과
┃ Gate 2건이 결정을 기다립니다 → 결정 채널의 카드에서 고르세요.
┃ ───
┃ Dispatch  시도 71 · 재시도 Task 4
┃           실패 이력 13 · escalation 이력 1
┃           worker 질문 1 · 관찰 창 기준
┃ CI  확인 불가 · PR 카드 기준
┃ 관측 상태  이 Run 주의 1건 · 전체 주의 1건
┃            세대 판정 불가
┃ 미등록 Run  1건 · 관찰 요약 참고
┃ orca-slack-bridge · 10-01 14:23:05 KST 갱신 · Orca 관측 기준
```

위 블록은 `apps/orca-slack-bridge/test/run-render.test.ts`의 `facts()` 기본값(실측 Run 2026-08-24 관측의 수에 맞춘
fixture)에 PR 3행(`#9` open·request_changes, `#10` closed·verdict 없음, `#25` merged·approve), 미등록 Run 1건,
컬렉션 degraded 1건, 갱신 시각 `2026-10-01T05:23:05Z`를 넣어 `renderRunCard`를 돌린 출력이다. 알림용 대체 텍스트는
`❓ 결정 필요 · [dev-infra] dnhynk/dev-infra · Slack Bridge D1 Run Observer`다.

표시할 의미:

- Project와 등록 저장소
- Run 제목(objective 첫 줄)
- 카드 종류(아래)와 coordinator 소유 binding 판정·세대
- Task 상태별 수와 `task-list.count`
- 관련 PR의 핵심 상태(store에 기록된 PR만)
- 사람이 필요한 원천별 수
- Dispatch attempt 이력, 누적 이력, 관찰 창 기준 worker 질문
- 이 Run과 관찰 전체의 degraded, 미등록 Run 수

카드 종류는 기존 사실에서만 고르고 앞의 것이 이긴다.

| 종류 | 색 | 조건 | 설명 문장 |
|---|---|---|---|
| ❓ 결정 필요 | amber | open Gate, 답을 기다리는 터미널, interaction 대기 | `Gate N건이 결정을 기다립니다 → 결정 채널의 카드에서 고르세요.` 등 |
| ⛔ 막힘 | red | blocked Task | `Task N개가 막혀 있습니다 → runs 명령에서 막힌 Task를 확인하세요.` |
| ✅ Task 완료 | green | Task 전부 completed | 없음 |
| ⚪ 확인 불가 | gray | Task 0개(legacy Run 포함) | legacy Run이면 조회하지 않았다고 말한다 |
| 🔵 진행 중 | blue | 그 밖 | 없음 |

`Task 상태`와 `Task 전체`는 다른 칸이다. 한 칸에 `a / b`로 붙이면 분수로 읽힌다. 실행 중 추가된 Task는 즉시 분모에
반영되고, Dispatch retry는 `Dispatch` 칸의 attempt 이력으로 따로 보이며 완료율·성공률 퍼센트와 비율 progress bar는
만들지 않는다(OD-069).

blocker는 원천별 수로 표시하고 고유 총합은 dedup 정책 전에는 표시하지 않는다. `agentWait`는 provider별 근거 없이
permission으로 단정하지 않는다. 연결 ID(`taskId`·`dispatchId`·Gate ID·message ID)는 카드가 아니라 `runs` 명령의 사실
보고에 남는다(OD-067, DL-074). 누적 이력(`failedDispatch`·`escalation`)은 만료가 없으므로 `사람 필요`가 아니라
`Dispatch` 칸에 `이력`으로 싣는다. 의존성 대기(`waitingDependency`)는 `Task 상태`의 `대기`와 같은 수다.

degraded는 `[kind]` 코드 대신 사람이 읽는 사유로 싣는다. `관측 상태` 칸은 비어 있어도 `이 Run 정상 · 전체 정상`으로
남는다. 미등록 Run 수는 0이어도 그리고, 사유별 내역은 §3.2의 컬렉션 카드에 있다.

### 3.2 컬렉션 루트

`#agent-runs`에는 Run 카드 말고 **컬렉션 루트가 하나 더 있다.** 관찰마다 갱신되는 메시지 하나이고
**등록된 Run 수와 무관하게 항상 게시된다**(OD-080). 등록 열쇠(Orca repository id)가 통째로 어긋나면
Run 카드가 하나도 없는데, 미등록 수를 보여야 하는 구간이 바로 그때이기 때문이다.

```text
📊  관찰 요약 · Run 카드 1장 · 미등록 7건
┃gray
┃ Run 카드  1장
┃ 미등록 Run  7건
┃ *미등록 사유*
┃ Project 확정 불가 2건
┃ 빈 Run · 저장소 없음 5건
┃ Project를 확정하지 못한 Run 2건은 카드가 없습니다 → runs 명령에서 저장소 등록을 확인하세요.
┃ ───
┃ 관측 주의  inbox 한도 도달 · 미답 질문 판정 보류
┃ orca-slack-bridge · 10-01 14:23:05 KST 갱신 · 등록 Project 기준
```

위 블록은 `renderRunCollectionCard`를 `cards: 1`, 미등록 Run 7건(`repository_unobservable` 5건,
`repository_route_blocked` 2건), 컬렉션 degraded `inbox_saturated` 1건, 갱신 시각 `2026-10-01T05:23:05Z`로 돌린
출력이다. 알림용 대체 텍스트는 `관찰 요약 · Run 카드 1장 · 등록되지 않은 Run 7건`이다.

미등록 Run은 사유별 수로 접는다. Run 하나는 한 번만, 다음 순서에서 가장 앞선 사유로 센다: 조회 실패, 저장소 판독 불가,
여러 Project 일치, Project 확정 불가, 미등록 저장소, 빈 Run · 저장소 없음, 표시 한도 밖. 조회 실패를 맨 앞에 두는 이유는
조회에 실패한 Run이 미등록으로 둔갑하면 미등록 수가 다른 사건을 함께 세기 때문이다(OD-078). 저장소 등록으로 풀리는
사유가 있으면 설명 문장이 `runs` 명령을 가리키고, 조회 실패는 다음 관찰이 다시 판정한다고 말한다. 어느 Run인지와 그
근거(hash ref, degraded detail)는 `runs` 명령의 사실 보고에 있다.

이 카드에는 Run 진행·blocker가 없다. 컬렉션에 귀속되지 않는 사실이기 때문이다.
미등록 Run 수와 컬렉션 수준 degraded는 Run 카드에도 실린다 — **중복은 의도다.** Run 카드 쪽은
그 Run을 보는 사람이 컬렉션 사실을 함께 보게 하고, 이 카드 쪽은 Run 카드가 하나도 없어도 그
사실이 남게 한다.

**이 채널에 무엇을 덧붙이든 이 루트가 이미 있다는 것을 전제한다.** Run 하나에 귀속되지 않는
표면을 새로 만들기 전에 이 카드에 실을 수 있는지 먼저 본다.

### 3.3 Gate 결정 카드

daemon은 결정 채널(`slack.channels.decisions`, 설정하지 않으면 `agentRuns`)에 최상위 메시지로 놓는다. 결정 채널을
넘기지 않는 one-shot `runs` 명령은 Run 루트 아래 답글로 놓는다.

```text
❓  결정 필요 · 구독을 취소하면 유료 기능 권한을 언제 끝낼까?
[A 즉시 종료] [B 기간 종료 · primary]
[직접 입력]
┃amber
┃ Run  Slack Bridge D1 Run Observer
┃ Project  dev-infra
┃ 권장  B 기간 종료
┃ 대기 Task  2개
┃ 영향  Backend와 Billing 작업 2개가 이 결정을 기다린다
┃ 계속 가능  1개
┃ 권장 이유: 일반적인 구독 동작과 맞고 결제한 기간을 보장한다
┃ *선택지*
┃ A 즉시 종료 — 취소 순간부터 유료 기능을 쓸 수 없다
┃ B 기간 종료 — 이미 결제한 기간까지 계속 쓸 수 있다
┃ ───
┃ 대기 중  Backend 권한 종료 처리
┃          Billing 환불 규칙
┃ 판정 제한  없음
┃ orca-slack-bridge · Coordinator 질문 · 등록 상세 기준
```

위 블록은 sidecar를 등록한 pending Gate(선택지 2개, 권장 B, 대기 Task 2개, 독립 Task 1개)를 Run 목표·Project와 함께
`renderGateDecisionCard`에 넣은 출력이다. 알림용 대체 텍스트는 `❓ 결정 필요 · {질문}`이다.

버튼 label은 짧게 유지한다. 사람이 읽는 question/options 요약과 별도로 안정적 option ID·설명·recommendation·impact를
Bridge sidecar에 저장해 Gate ID와 연결하고, action은 이 metadata로 판정한다(OD-050). Gate·Task·Run ID, correlation,
option ID는 카드에 싣지 않는다. 버튼의 ID는 store가 클릭마다 sidecar로 다시 계산해 대조한다.

sidecar를 등록하지 않은 Gate에도 버튼은 나온다. 이때 카드에는 Orca `options` label과 버튼만 있고 `권장`·`영향` 칸은
`확인 불가 · 상세 미등록`이며 footer 기준이 `Orca 기록 기준`이다(OD-083). `options`를 읽지 못한 Gate는 버튼 없이
`선택지를 Orca 기록과 맞추지 못해 버튼을 만들지 않았습니다 → Orca에서 직접 결정하세요.`를 싣는다. `판정 제한` 칸은
degraded 사유의 수와 dependency를 판정하지 못한 Task 수만 싣는다. 사유 문장은 Task·Gate ID를 담고 있어 `runs` 명령의
게시 보고가 출력한다.

열린 카드에는 시각이 없다. Orca에서 직접 결정된 Gate는 green `✅  결정됨` 카드가 되고 `결정` 칸과 Orca `resolvedAt`
시각(`… KST 결정 · Orca Gate 기준`)을 싣는다.

버튼 클릭이 일시적으로 거부되면(관측 job이 카드를 갱신하는 중 등) ACK한 뒤 누른 사람에게만 보이는
안내를 카드 자리에 놓는다. 카드가 thread 답글이면 그 thread에, 최상위 카드면 채널에 놓는다.

```text
⏳ 이번 선택은 반영되지 않았습니다. 잠시 후 같은 버튼을 다시 눌러 주세요.
```

다시 눌러도 결과가 같은 거부(이미 결정된 Gate, 다른 선택이 먼저 이긴 경우, 권한·신원 불일치)에는
안내하지 않는다(DL-073).

### 3.4 자유형 결정 modal

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

제출이 일시적으로 거부되면 같은 방식으로 input block에 아래 문구를 표시하고 modal을 유지한다. 세션도
그대로 열려 있어 잠시 뒤 다시 제출할 수 있다(DL-073).

```text
이번 제출은 반영되지 않았습니다. 잠시 후 다시 결정을 눌러 주세요.
```

### 3.5 결정 기록과 작업 재개

버튼이나 직접 입력이 이기면 같은 결정 카드를 결정 기록 카드로 바꾼다. Orca resolution 성공 뒤:

```text
✅  결정됨 · 결제 기간 종료 시 종료
┃green
┃ 결정  결제 기간 종료 시 종료
┃ Orca 반영  확인됨
┃ 후속 Task  Coordinator 통지 대기
┃ 선택 방식  버튼
┃ orca-slack-bridge · 10-01 14:23:05 KST 선택 · Orca Gate 기준
```

coordinator notification 이후 실제 후속 상태를 관찰한 뒤:

```text
▶️  작업 재개 · 결제 기간 종료 시 종료
┃green
┃ 결정  결제 기간 종료 시 종료
┃ Orca 반영  확인됨
┃ 후속 Task  재개 관찰 · 새 Dispatch 시작
┃ 선택 방식  버튼
┃ orca-slack-bridge · 10-01 14:23:05 KST 선택 · Orca Gate 기준
```

위 두 블록은 `renderGateResolutionCard`에 resolved 결정(선택 시각 `2026-10-01T05:23:05Z`)을 넣고, 둘째에는 재개 증거
(`new_dispatch`)를 더한 출력이다. 알림용 대체 텍스트는 `{cardState} · {결정} · {후속 Task 라벨}`이고 후속 Task 라벨은
`Coordinator 통지 대기`, `Coordinator 확인됨 · 후속 Task 재개 미관찰`, `▶️ 작업 재개` 셋이다.

| 상태 | 머리 | 색 | 설명 문장 |
|---|---|---|---|
| 반영 중 | ⏳ 반영 중 | blue | 없음 |
| 결정됨 | ✅ 결정됨 | green | 없음 |
| 충돌 | ⛔ 충돌 | red | `다른 결정이 먼저 기록됐습니다 → Orca에서 확인하세요.` |
| 확인 필요 | ⚠️ 확인 필요 | amber | 원격 결과 미확정, 요청 소유 불명, sidecar·매핑 미확인 중 해당하는 원인과 할 일 |

footer 시각은 선택 시각이다. 카드는 현재 시각을 읽지 않는다 — 결정 기록 카드가 바뀌면 투영이 다시 걸리므로 움직이는
값을 그리면 투영이 끝나지 않는다. 누가 결정했는지(Slack user), Orca mutation request ID와 replay 여부, ask·thread·
Dispatch·Task ID는 카드에 싣지 않는다. 그 값은 store의 결정 기록(`gate_resolution` row)에 남는다.

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
| PR root | Project/Repository identity, PR number, title, current status, CI·병합 준비 판정, PR 버튼, 갱신 시각 |
| PR semantic detail | what, why, 검증된 impact/risk/review/validation 중 해당 항목 |
| PR thread event | transition type, occurred/observed time, 짧은 판정 |
| Run root | Project/Repository identity, Run title, 카드 종류, Task 상태별 수와 전체, 사람 필요 원천별 수, 갱신 시각 |
| Run collection root | Run 카드 수, 미등록 Run 수와 사유별 수, 관찰 전체 degraded, 갱신 시각 |
| Gate card | Run과 Project, question, options, recommendation, impact, 대기·독립 Task 수, action controls |
| Gate resolution | resolution, Orca 반영 결과, 후속 Task 상태, 선택 방식, 선택 시각 |
| Resume event | notification 상태와 실제 재개 증거를 구분 |
| Terminal prompt | question, Run, 위치, 선택지, action controls, 상태 시각 |

Gate ID와 Run ID는 카드가 아니라 버튼 ID(기계 판정), `runs` 명령의 사실 보고, store에 있다. Slack owner identity는
store의 결정 기록(`gate_resolution` row)에 있다.

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
correlation 실패만 thread에 알린다. summarizer 실패와 source stale처럼 자가 복구되는 상태는 칸에만 표시하고
thread 알림을 보내지 않는다(OD-072).

degraded는 `[kind]` 코드가 아니라 사람이 읽는 사유와 수로 싣는다. 코드와 원문 detail은 `runs` 명령의 사실 보고와 운영
로그에 있다.

| 카드 | 자리 |
|---|---|
| Run | `관측 상태` 칸: `이 Run 정상` 또는 `이 Run 주의 N건`과 사유, `전체 정상` 또는 `전체 주의 N건`. 비어 있어도 남는다 |
| 컬렉션 | `관측 주의` 칸: 관찰 전체 degraded의 사유. 없으면 `없음` |
| Gate 결정 | `판정 제한` 칸: degraded 수와 dependency를 판정하지 못한 Task 수 |
| 결정 기록 | `⚠️ 확인 필요` 머리, `Orca 반영` 칸의 원인, 원인 → 행동 문장 |
| 터미널 | `⚠️ 전송 실패` 머리와 원인 → 행동 문장. 오류 코드는 싣지 않는다 |
| 치명 종료 | `원인` 칸. 원인 코드는 싣지 않는다 |

C1 카드에서만 확정한 degraded 표시:

- summarizer가 실패하면 `요약` 칸에 `실패 · {사유}`를 표시하고 worker 보고 본문을 사실 텍스트로 싣는다.
- 입력 상한을 넘겨 일부만 관측했으면 `관측 범위` 칸에 잘린 지점을 표시한다.
- 연결된 `worker_done`이 없으면 `worker 보고` 칸에 `없음`을 표시한다.
- correlation 실패 PR은 카드를 만들지 않으므로 Slack에 degraded 표시도 없다.

D1/D2에서 thread 알림 여부와 무관하게 degraded 표시 자체는 항상 유지한다.

## 7. 초기 비허용 UI

- 일반 thread text를 coordinator에게 전달
- bot 또는 비-owner가 Gate를 resolve
- button 한 번으로 merge, force push, main reset, secret 변경, production rollback 실행
- permission prompt 원격 승인

고위험 action을 후속으로 추가한다면 대상·deployment identity를 다시 보여주는 별도 확인 단계가 필요하다.
