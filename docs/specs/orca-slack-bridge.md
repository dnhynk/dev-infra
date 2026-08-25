# `orca-slack-bridge` Umbrella 스펙

상태: **Draft · C1~D3 offline 구현됨, D3 live acceptance 미검증**
해결 대상: **C + D**  
예정 위치: `dev-infra/apps/orca-slack-bridge`

## 1. 제품 역할

`orca-slack-bridge`는 기존 Orca orchestration workflow를 방해하지 않고 관찰하며 다음 두 기능을 제공하는 로컬 백그라운드 인프라다.

- **C · PR Digest:** PR의 의미 있는 상태 변화를 `#pr-digest`에 사람이 빠르게 이해할 수 있는 형태로 표시한다.
- **D · Run Control Plane:** Orca Run과 사람의 결정이 필요한 Gate를 `#agent-runs`에 표시하고, owner의 명시적 Slack action을 Orca의 정식 Gate resolution으로 기록한 뒤 기존 coordinator 세션의 재개를 돕는다.

Bridge는 worker나 coordinator를 대신하는 Agent가 아니다. 기본 역할은 Observer이며, Gate 처리에서만 제한된 Control Plane이 된다.

## 2. 필수 원칙

1. Agent 대화 전체를 지속적으로 수집·요약하지 않는다.
2. PR, review, CI, merge, Run, Task, Gate의 의미 있는 상태 변화를 다룬다.
3. `worker_done`과 구조화된 Orca/GitHub 사실을 우선 사용한다.
4. 장문 transcript는 기본 입력이 아니며 명시된 fallback 조건에서만 제한적으로 읽는다.
5. LLM은 의미 압축만 담당하고 Slack UI는 deterministic renderer가 만든다.
6. GitHub 공식 Slack 앱이 렌더링한 메시지를 파싱하지 않는다.
7. Slack과 Channel은 source of truth가 아니다.
8. Gate 결정은 Orca에 먼저 기록하고 durable delivery 상태를 남긴 뒤 coordinator를 깨운다.
9. PR와 Run마다 루트 메시지를 하나만 유지하고 중요한 상태 변화만 thread에 남긴다.
10. Bridge 장애·재시작·Channel 미연결이 Orca와 GitHub의 상태를 손상시키면 안 된다.
11. 초기 원격 입력은 Bridge가 발행한 버튼과 Gate 전용 modal만 허용한다.
12. 한 Gate 때문에 그 결정과 무관한 ready task까지 멈추게 하지 않는다.

## 3. 전체 데이터 흐름

PR/Run 관찰:

```text
Orca read model ─┐
                 ├─ facts → correlation → state projection
GitHub source ───┘                         → optional summarizer
                                           → schema validation
                                           → deterministic renderer
                                           → Slack create/update/thread
```

Gate 결정:

```text
Slack button/modal
  → 고정 선택지는 즉시 ack
  → 직접 입력은 즉시 ack하고 3초 안에 modal open
  → 실제 sender와 action correlation 검증
  → Orca에서 Gate 최신 상태 확인
  → Orca gate-resolve
  → durable delivery record
  → Channel wake-up 시도
  → coordinator가 Orca Gate를 다시 읽음
  → dependent task 재개
```

Slack의 3초 acknowledgement 제한 때문에 네트워크 요청 ACK와 Gate resolution 완료를 같은 시점으로 취급하지 않는다.

## 4. Source of truth

| 정보 | Source of truth | Bridge 책임 |
|---|---|---|
| Run·Task·Dispatch·Worker 상태 | Orca orchestration | 읽고 projection |
| worker 완료 요약 | Orca `worker_done` | 우선 요약 입력으로 사용 |
| 상세 worker transcript | Orca `worker-read` | C1에서는 읽지 않음; fallback은 후속 범위 |
| Gate 질문·선택지·상태·결정 | Orca Gate | 표시하고 제한적으로 resolve |
| Gate option metadata와 ask↔Gate mapping | Bridge durable store | Gate ID에 연결해 기계 판정과 correlation에 사용 |
| PR·check·merge 상태 | GitHub API 또는 `gh` 원본 | 읽고 projection |
| reviewer verdict | correlated Orca Task의 `task.result`에 기록된 `reviewer_result` | 읽고 projection |
| Slack 메시지 위치·표시 이력 | Bridge durable store | create/update/thread bookkeeping |
| coordinator 통지 상태 | Bridge durable store | pending/attempt/확인 상태 관리 |
| Slack 카드 문구 | derived view | authoritative 상태로 사용하지 않음 |

Bridge DB는 Orca Gate 결정이나 GitHub PR 상태를 대신하는 저장소가 아니다.

## 5. C · PR Digest

### 5.1 관심 lifecycle

```text
Worker 구현 완료와 PR 생성
Review → 승인 또는 수정 요청
Worker 수정 → 재검토
CI/check → 통과 또는 실패
Review + CI + merge 조건 → Merge Ready
Coordinator merge → 완료
```

worker는 PR을 만든 뒤 `worker_done`을 보낸다. C1의 관찰은 `digest` 명령 1회 실행당 1회이며 polling하지 않는다. Bridge가 관찰할 후보 변화:

- PR opened/discovered
- 연결된 `worker_done`
- review requested
- changes requested
- 수정 commit 또는 worker 재완료
- re-review requested
- approved
- CI/check passed 또는 failed
- merge-ready 조건 충족
- merged

canonical PR state는 terminal `open | closed | merged`와 직교 축 `draft`, `review`, `checks`,
`mergePolicy`를 보존하고 UI 의미 상태를 파생한다. `mergedAt != null`을 `merged` terminal latch로 쓴다.

`headMatch`는 계속 사실로 표시하지만 Bridge는 이전 approval의 유효·무효를 판정하지 않는다. 새 head마다
재리뷰를 강제하지 않고 GitHub repository의 stale-review 설정도 따라가지 않는다.

merge-ready는 required check만으로 판정한다. base branch의 effective required rule과 current head rollup을
조인해 `mergePolicy` 축 하나를 만들며 optional check 실패는 merge를 막지 않는다. 조인 결과는 context별 상태
중 가장 무거운 `failing | missing | indeterminate | pending | passing` 다섯이고, rule source의 상태인
`no_required_rules`(정상이며 이 축이 merge를 막지 않지만 `병합 준비 완료`도 아니다)와
`rules_unreadable`(degraded)이 조인 결과보다 앞선다. 값별 뜻과 `indeterminate`를 어느 쪽으로도 접지 않는
근거는 [관찰·상관관계 계약](../contracts/observation-and-correlation.md) §6과 DL-051에 있다.

이 축은 required check 축 하나이지 merge 가능 여부의 최종 답이 아니다. merge queue, required reviews,
up-to-date(strict), conversation resolution은 C2 범위 밖이고 이 축이 판정하지 않는다(OD-030~032).

### 5.2 입력 사실

Orca에서:

- Task 목적
- Run/Task/Dispatch/Worker identity
- Run mailbox의 `worker_done`: `orca orchestration inbox --terminal "run:<run_id>" --limit <n> --json`
- correlated Task의 `task.result`에 기록된 `reviewer_result`; `task.result`를 `worker_done`의 권위로 쓰지 않는다
- C1에서는 transcript를 읽지 않는다

GitHub에서:

- repository, PR number, title, body, URL
- source/target branch와 head commit
- changed files와 diff stats
- CI/check 상태
- mergeability와 merge 상태

review 핵심 요약은 Orca `reviewer_result.findings`에서 만들며 GitHub review를 verdict source로 사용하지 않는다. `Merge Ready`는 GitHub의 단일 필드가 아니라 Bridge가 명시적으로 정의해야 하는 derived 의미다.

### 5.3 의미 압축

Summarizer 입력인 `SummaryFacts`는 Task 목적, `worker_done`, PR title, correlation metadata를 제거하고 상한을 적용한 PR body, 변경 파일 경로, `reviewer_result`의 findings, CI 결론, 입력 잘림 여부로 고정한다. PR state·merge 상태는 `SummaryFacts`에 없으며 worker transcript, diff 본문, GitHub review 원문 전체도 보내지 않는다.

LLM structured output은 다음 네 필드뿐이다.

```json
{
  "title": "결제 중복 처리 방지",
  "what": "같은 결제 요청이 여러 번 들어와도 한 번만 처리되도록 수정했습니다.",
  "why": "네트워크 재시도 시 동일 결제가 중복 처리될 가능성이 있었습니다.",
  "reviewGist": "응답 지연 후 재시도되는 예외 상황을 추가 보완해야 합니다."
}
```

`status`는 관찰한 PR·Orca 사실에서 코드가 파생하고, `risk`는 `reviewer_result.findings[].severity`를 코드가 집계해 파생한다. 모델에 두 판정을 맡기지 않는다. provider는 OpenAI API, 기본 모델은 설정으로 교체 가능한 `gpt-5.6-luna`, 출력 언어는 한국어다. 출력은 strict JSON Schema로 검증하며 검증 실패는 한 번 재시도하고, 재시도도 실패하면 요약 없이 사실만 담은 축소 카드를 만들고 "요약 실패"를 표시한다(OD-034~037, DL-026~027).

Renderer는 다음을 보장해야 한다.

- validation된 structured result만 사용한다.
- 상태별 layout과 action을 코드로 결정한다.
- source fact에 없는 성공·안전성·검증을 주장하지 않는다.
- summarizer가 실패해도 Orca/GitHub 상태를 변경하지 않는다.
- 모델이 임의 버튼·링크·명령을 생성하지 않는다.

### 5.4 Slack projection

- C1의 대상은 correlated PR뿐이다. uncorrelated 또는 conflict PR에는 카드를 만들지 않는다.
- `orca-run`은 있고 필수 `orca-task`가 없는 PR은 invalid/degraded input이며 Task 카드를 만들지 않는다.
  별도 `run_correlated` kind는 Run-level 제품 의미가 필요해질 때만 도입한다(OD-077).
- C1의 첫 외부 write는 실제 `#pr-digest`에 한다.
- 모든 카드 상단은 Project가 등록됐으면 `[Project] owner/repo #N`, 아니면 `owner/repo #N`으로 표시한다.
- PR 하나당 루트 메시지 하나를 만든다.
- 상태가 바뀌면 Bridge 자신이 작성한 같은 메시지를 `chat.update`로 갱신한다.
- 저장된 Slack 메시지를 갱신할 수 없으면 GitHub current snapshot, Orca facts, Bridge store identity로
  current 카드만 재생성한다. 과거 thread의 semantic transition은 재생하지 않는다(OD-046).
- C1은 thread transition을 만들지 않는다. 중요한 상태 변화의 thread는 C2다.
- 모바일에서 무엇을, 왜, 현재 어떤 상태로 바꾸는지와 위험·검증·PR 링크를 짧게 파악할 수 있어야 한다.

구체적인 문구와 layout은 [Slack 메시지 UX](../ux/slack-surfaces.md)를 따른다.

## 6. D · Run Observer

### 6.1 기본 단위

Orca Run 하나를 Slack 루트 메시지 하나에 대응시킨다.

루트 메시지는 현재 상태를 보여준다.

- project/repository
- Run identity와 제목
- 실행 중·결정 필요·완료 등 현재 상태
- 현재 `task-list.count`와 Task 상태별 수
- Task 진행 상태와 분리된 Dispatch attempt 이력
- 관련 PR과 핵심 상태
- 원천별 blocker badge와 correlation ID
- 현재 사람 개입 필요 여부

Task를 분모 단위로 삼아 `현재 Task 상태별 수 / 현재 task-list.count`를 표시하고 실행 중 추가된 Task를
즉시 반영한다. Dispatch는 attempt 이력으로 분리한다. 완료율·성공률 공식은 만들지 않으며 Orca 원천에는
`cancelled` Task 상태가 없다(OD-069).

`blocker`, open Gate, Gate에 blocked된 Task, dependency waiting, worker ask, CI failure, interaction 대기는
서로 다른 원천 badge로 표시하고 `taskId`·`dispatchId`·Gate ID·message ID를 함께 노출한다. 고유 blocker
총합은 dedup 정책이 확정되기 전에는 표시하지 않는다. `agentWait`는 provider별 근거가 더 있을 때만
permission 등으로 세분화한다(OD-067).

D1은 설정 파일에 수동 등록한 repository만 관찰한다. 자동 발견, Git remote 기반 자동 등록, 자동 발견된
다중 repository routing은 O1 범위다(OD-068).

`#agent-runs`에는 Run 루트 말고 **컬렉션 루트 메시지가 하나 더 있다.** Run 하나에 귀속되지 않는
사실 — 이번 관찰의 Run 카드 수, 미등록 Run 수와 목록, 컬렉션 수준 degraded — 을 싣고 **등록된 Run
수와 무관하게 항상 게시한다.** 등록 열쇠가 통째로 어긋나면 Run 루트가 하나도 없는데, 미등록 수가
보여야 하는 구간이 바로 그때이기 때문이다(OD-080). layout은 UX §3.2에 있다.

### 6.2 Gate 표시

coordinator가 코드와 문서만으로 결정할 수 없는 사항을 Orca Gate로 만들면 Run thread에 다음 의미를 표시한다.

- 문제
- 선택지와 각 선택지의 의미
- coordinator 권장안과 이유
- 결정 영향
- 이 Gate 때문에 대기하는 Task
- 계속 진행 가능한 독립 Task
- 선택지 버튼
- 직접 입력 modal 버튼

Orca Gate의 `question`과 `options`에는 사람이 읽는 짧은 요약만 둔다. 안정적 option ID, 설명,
recommendation, impact는 Bridge sidecar에 저장하고 Gate ID로 연결한다. button·modal의 기계 판정은 이
metadata를 사용하며 question/options 자유 텍스트를 parsing하지 않는다(OD-050).

ask를 사람용 Gate로 승격할 때 Bridge는 `{askMessageId, questionThreadId, dispatchId, taskId, gateId}`를
durable하게 저장하고 이를 권위 correlation으로 쓴다. Gate question은 표시용이며 correlation source가 아니다(OD-019).

### 6.3 결정 이후

Gate가 해결되면 thread에서 다음을 구분해 보여준다.

- Orca Gate에 결정이 기록됨
- 누가 언제 어떤 결정을 했는가
- coordinator 통지 상태
- 실제 Orca 상태로 관찰된 후속 작업 재개

Channel transport write만 성공했다고 “작업 재개”로 표시하지 않는다.

카드에는 degraded 상태를 항상 표시한다. Channel pending·미해결 Gate·correlation 실패처럼 owner 개입 없이는
진행되지 않는 상태만 thread에 알리고, summarizer 실패·source stale처럼 자가 복구되는 상태는 badge만
표시한다. C1의 기존 degraded 표현은 유지한다(OD-072).

## 7. Slack Control Plane

### 7.1 초기 허용 입력

- Bridge가 생성한 Gate 선택지 버튼
- 해당 Gate에 연결된 직접 입력 modal

일반 channel/thread 메시지, 다른 bot 메시지, room membership만을 근거로 coordinator에 prompt를 전달하지 않는다.

Slack inbound는 `@slack/socket-mode`를 쓴다. daemon은 연결 직전 WebSocket URL을 발급하고
`hello.connection_info.app_id`를 확인하며 `warning`/`refresh_requested` 때 연결을 overlap한다.
exponential backoff을 적용하고 reconnect 단절 구간의 event replay는 보장하지 않는다(OD-041).
사전 인증된 Socket 위에서는 HTTP signing secret 검증을 적용하지 않는다(OD-042).

### 7.2 처리 순서

1. Slack 요청을 3초 안에 ACK하고 ACK 처리와 Orca 업무 처리를 분리한다.
2. 인증된 Socket Mode envelope의 `team.id`와 exact `user.id`를 모두 검사하고, 설정됐으면 `api_app_id`도 대조한다.
3. action ID, Gate ID, 안정적 option ID를 서버 측 sidecar 기록과 대조한다.
4. Orca에서 Gate가 아직 open인지 읽는다.
5. 중복·경합 응답 여부를 확인한다.
6. Orca의 공식 `gate-resolve` interface로 resolution을 기록한다.
7. Gate별 직렬화, 같은 논리 요청의 retry request ID 재사용과 `mutation.replayed` 처리, resolve 전후 재조회로
   결과를 확정하고 durable outbox와 reconcile한다. Orca 내부 transaction 원자성은 가정하지 않는다.
8. 기존 coordinator에 Channel notification을 시도한다.
9. coordinator는 Orca Gate source of truth를 다시 읽고 후속 orchestration을 진행한다.

Slack payload를 바로 Claude prompt로 보내거나 Slack을 결정 저장소로 사용하지 않는다.

직접 입력 action은 예외적인 fast path를 가진다. sender/action을 빠르게 검증하고 button payload의 `trigger_id`가 만료되기 전에 ACK와 `views.open`을 3초 안에 끝낸다. 비-owner에게 modal을 열지 않는다. modal submission의 로컬 형식·필수값 오류는 3초 안에 input `block_id`별 `response_action=errors`로 ACK해 modal을 유지한다. 유효한 제출은 ACK한 뒤 원격 Orca 작업을 비동기로 수행한다(OD-071).

## 8. Channel Adapter

Channel은 새 Web session이나 새 clone을 만드는 수단이 아니라 이미 열린 기존 로컬 coordinator 세션에 외부 이벤트를 push하는 수단이다.

Custom Channel Adapter는 Claude Code가 coordinator session별 subprocess로 실행하고 stdio MCP로 통신한다.
daemon은 Windows named pipe를 listen하고 Adapter가 재시도 client로 연결하므로 기동 순서에 의존하지 않는다(OD-052).
등록만으로는 충분하지 않고 각 session에서 channel opt-in과 적용되는 조직 policy를 통과해야 한다.

개념 notification:

```xml
<channel source="orca-slack" gate_id="gate_84"></channel>
```

payload에는 `gate_id`만 싣고 coordinator가 자기 Orca 권한으로 Gate를 다시 읽는다. binding은 인증하지 않으며
`CLAUDE_CODE_SESSION_ID`는 routing 식별자로도 신뢰 근거로는 쓰지 않는다. 잘못 라우팅되거나 위조된 Adapter가
받아도 ID 외 내용을 노출하지 않는다(OD-053).

반드시 고려할 현재 제약:

- Claude Code Channels는 research preview다.
- 열린 세션에서 명시적으로 channel이 활성화된 동안만 event가 도착한다.
- notification write에는 Claude가 실제 처리했다는 ACK가 없다.
- policy나 세션 설정에 따라 notification이 silent drop될 수 있다.
- custom Channel은 현재 development flag가 유일한 경로이고 매 기동 확인이 필요하며, research preview라 버전별 재검증이 필요하다.

따라서 최소한 다음 상태를 구분한다.

- Gate가 Orca에서 resolved됨
- coordinator notification이 pending임
- transport write를 시도함
- application receipt를 받음
- Orca 효과를 관찰해 consumed됨
- coordinator의 실제 후속 Task 상태가 아직 관찰되지 않음

transport write 성공은 전달을 증명하지 않고 application receipt만 전달 신호다(OD-054). 관측된 반환 경로는
Adapter reply tool 왕복이며 유일한 로컬 반환 경로라고 규정하지 않는다(OD-059). Orca 효과는 대상 Gate의
`pending`→`resolved` 전이로 정의한다(OD-055).

복구는 두 경로를 가진다.

- daemon은 durable outbox의 pending/receipted notification을 Adapter 재연결 시 다시 시도한다.
- daemon은 startup dead window를 피한 end-to-end probe receipt만으로 session opt-in을 판정한다. argv·env·MCP
  initialize·parent process command line은 판정 계약으로 쓰지 않는다(OD-058).
- coordinator는 notification의 `gate_id`로 Orca를 항상 다시 읽고 이미 resolved이며 효과가 반영됐으면 no-op으로 처리한다.
- delivery는 `receipted`→`consumed` 두 단계다. receipt는 retry backoff를 늦출 뿐 재조회를 막지 않고,
  Orca 효과를 확인한 `consumed`에서만 재조회를 억제한다(OD-057, OD-066).

이 D3 계약은 schema v12 sidecar와 daemon-owned pipe, session Adapter, exact Run/generation routing,
delivery/receipt/consume, post-baseline Task/Dispatch evidence, existing-card projection으로 구현됐다.
구현은 새 Task/Dispatch를 만들지 않고 실제 Orca 상태를 관찰한다. development flag의 매 기동 확인과
research-preview 변동성은 자동화하지 않으며 allowlist plugin 등재도 범위가 아니다(OD-056).
actual Claude Code 2.1.243 opt-in과 실제 Task resume는 `LIVE_CHANNEL_UNVERIFIED`로 남는다.

## 9. Durability와 멱등성

로컬 durable store는 최소한 다음 의미를 보존해야 한다.

- canonical repository identity
- Project↔Repository mapping과 Slack routing identity
- PR number와 Slack channel/message identity
- PR body의 primary/latest Task와 별도로 보존하는 PR↔Task N 연관
- 현재 projected PR state
- Orca Run/Task/Dispatch identity
- Run의 Slack message identity
- 이미 기록한 thread transition
- Gate와 Slack action correlation
- Orca resolution 결과
- coordinator notification pending/transport-attempted/receipted/consumed 상태
- 마지막 성공 관찰 cursor 또는 snapshot

C1 durable store는 `node:sqlite`다. 기본 경로는 Windows에서 `%APPDATA%\\orca-slack-bridge\\state.db`이며 명시적 경로 또는 환경변수로 override할 수 있다. `--state`는 cwd 기준 상대경로를 허용하고, cwd가 다른 프로세스에 상속될 수 있는 `ORCA_SLACK_BRIDGE_STATE`만 대상 platform의 절대경로를 요구한다. WAL과 `schema_version` 테이블을 사용하고, C1은 daemon이나 동시 writer가 없다는 단일 프로세스 가정으로 파일 lock을 만들지 않는다.

전체 Bridge가 지향하는 필수 성질과 C1에서 검증한 범위를 구분한다.

- C1 store는 repository+PR마다 매핑 행을 하나만 보존하며 두 PR이 같은 Slack message identity를 가리키지 못하게 한다.
- `chat.postMessage` 성공 뒤 매핑 행까지 남은 PR은 재관찰 시 기존 루트를 찾아 `chat.update`한다. T5가 검증한 중복 방지는 이 범위다.
- 같은 Run에 루트 메시지가 중복 생성되지 않는다.
- 같은 action이 Gate를 두 번 resolve하지 않는다.
- 재시작 후 기존 메시지를 찾아 update할 수 있다.
- Channel이 꺼져 있어도 Orca Gate resolution은 남는다.
- 오래된 event가 최신 카드를 과거 상태로 되돌리지 않는다.
- 재전송이 coordinator의 후속 작업을 중복 실행하게 하지 않는다.

그러나 C1은 Slack 루트가 PR당 절대 하나임을 보장하지 않는다. `chat.postMessage` 성공 뒤 `insertPrMessage` 전에 crash하면 매핑 행이 없고, 게시 성공 여부를 알 수 없는 delivery failure에서도 매핑 행을 남길 수 없어 다음 관찰이 새 루트를 만들 수 있다. 두 창의 atomicity·outbox·요청 idempotency 계약은 아직 열려 있다.

OD-043이 확정한 범위는 `node:sqlite`, 경로 우선순위와 platform별 기본값, WAL, `schema_version`, 덧붙이기 migration, C1 단일 프로세스에서 파일 lock을 만들지 않는다는 계약이다. future multi-writer locking, retention, backup, corruption recovery와 위 두 게시 창은 후속 범위다.

PR event reconciliation은 `(repository databaseId, PR number)`를 identity로, `mergedAt`을 terminal latch로,
`headSha`를 review/check scope로 쓴다. `merged` downgrade 금지는 timestamp 비교가 아니라 terminal dominance
rule이며, 동일 head 안의 review/check는 각 resource timestamp와 id로 reconcile한다(OD-044).

## 10. 보안 경계

초기 필수 요구:

- 실제 Slack sender user ID allowlist
- workspace/team과 Bridge가 발급한 action correlation 검증
- stale·resolved Gate action 거부
- GitHub 접근은 read-only
- Orca write는 식별된 Gate의 resolution으로 제한
- Slack/GitHub/LLM token과 Channel endpoint 로그 마스킹
- 모든 원격 결정의 audit 기록
- GitHub/PR/review/transcript를 untrusted input으로 취급
- summarizer output을 schema 검증하고 executable instruction으로 사용하지 않음

초기 원격 결정 후보:

- 제품 로직 선택
- API 동작 선택
- UI 방향 선택
- migration 전략 선택
- worker 질문에 대한 제품·구현 결정

초기 제외:

- production DB 삭제
- secret 변경
- force push·main reset
- production rollback
- 보안 설정 변경
- merge 또는 임의 shell command 실행
- Claude Code tool permission relay

고위험 action의 이중 확인과 permission relay는 후속 범위다.

## 11. 다중 프로젝트 정보 구조

제안된 목표 구조이며 최종 channel topology는 TBD다.

- Slack Workspace 하나
- GitHub 공식 App 하나
- Orca Bridge Slack App 하나
- 공통 채널에 여러 repository를 모음
- 각 메시지에 project/repository/Run/PR identity 표시

채널 역할:

- `#github`: GitHub 공식 앱의 operational notifications
- `#pr-digest`: 모든 repo의 semantic PR 상태
- `#agent-runs`: 모든 repo의 Run 상태와 remote decision
- `#deploys`: 후속 배포 상태
- `#prod-alerts`: 후속 운영 장애

## 12. 전체 제품의 최종 운영 UX

- PC 시작 시 Bridge 자동 실행
- Orca Run 시작 시 자동 발견
- Git remote를 통해 GitHub repository 확인
- Slack Run thread 자동 등록
- PR lifecycle 자동 projection
- owner의 모바일 Gate 결정
- 기존 coordinator와 worktree·worker·Run context 유지

Windows startup, systemd, PM2 등 실제 운영 방식은 실행 환경과 기술 스택을 정한 뒤 선택한다.

이 절은 core C/D 완료 기준이 아니라 O1 운영 자동화까지 포함한 전체 제품 목표다. 수동으로 등록한 여러 repository의 표시는 D1에서 검증할 수 있지만, repository 자동 발견·등록·routing은 O1 범위다.

## 13. Core C/D 수용 기준

S0, C1, C2, D1, D2, D3를 구현한 core C/D 상태는 다음 end-to-end 증거를 가져야 한다.

1. 연결된 worker 작업과 PR을 발견해 `#pr-digest` 루트 메시지 하나를 만든다.
2. changes request, 수정, approval, CI, merge가 같은 루트와 thread에 반영된다.
3. 재수집과 Bridge 재시작 뒤에도 중복 루트·transition이 생기지 않는다.
4. Orca Run이 `#agent-runs` 루트 하나로 표시되고 Task·PR·blocker 변화에 따라 갱신된다.
5. owner의 유효한 버튼/modal action만 최신 open Gate를 한 번 resolve한다.
6. 비-owner, 중복 action, 닫힌 Gate는 Orca 상태를 변경하지 않는다.
7. Channel 미연결 상태에서도 Gate resolution과 pending notification이 보존된다.
8. 재연결 후 기존 coordinator로 notification을 다시 시도할 수 있다.
9. notification 유실과 무관하게 coordinator가 Orca의 resolved Gate를 다시 조회해 복구할 수 있다.
10. 실제 Task 재개를 관찰한 뒤에만 Slack에 재개 상태를 표시한다.
11. raw Agent transcript와 GitHub Slack 메시지를 기본 데이터 pipeline에 포함하지 않는다.
12. 독립 Task는 한 Gate 때문에 Bridge에 의해 중단되지 않는다.

C1의 통합 테스트 경계는 대역 멱등성 테스트와 실제 `#pr-digest` 게시 1회 및 재실행 관측으로 확정했다(OD-060/061). 후속 slice는 실행 명령과 출력 없이 완료를 선언하지 않는다.

PC 자동 시작, 새 Run/repository 자동 발견과 자동 routing까지 검증해야 [전체 제품의 최종 운영 UX](#12-전체-제품의-최종-운영-ux) 완료를 선언할 수 있다.

## 14. 명시적 Out of Scope

- Agent 대화 전체의 실시간 수집·지속 요약
- GitHub 공식 앱의 operational notification 재구현
- 일반 Slack 메시지를 coordinator prompt로 전달
- `@Claude`로 새 cloud/web session 생성
- standard Slack MCP만으로 기존 coordinator wake-up 구현
- Bridge가 review나 merge를 대신 결정
- Bridge가 전체 Run을 pause/resume하는 정책 변경
- permission relay와 고위험 원격 명령
- `#deploys`, `#prod-alerts`

`/init-orchestrate`와 handoff 자동화는 별도 workstream이지만 correlation·Gate·resume 계약을 공유한다.
