# `orca-slack-bridge` Umbrella 스펙

상태: **Draft · 구현 전**  
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
| 상세 worker transcript | Orca `worker-read` | 부족할 때만 fallback |
| Gate 질문·선택지·상태·결정 | Orca Gate | 표시하고 제한적으로 resolve |
| PR·check·merge 상태 | GitHub API 또는 `gh` 원본 | 읽고 projection |
| reviewer verdict | GitHub formal review 또는 확정할 Orca reviewer-result source | 읽고 projection |
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

PR 생성과 `worker_done`의 strict ordering은 아직 정하지 않는다. Bridge가 관찰할 후보 변화:

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

정확한 canonical state, 여러 reviewer의 상충 verdict, 새 commit 후 approval 유효성, required check, draft, merge queue, merge conflict, closed-without-merge 처리는 TBD다.

### 5.2 입력 사실

Orca에서:

- Task 목적
- Run/Task/Dispatch/Worker identity
- `worker_done`
- 필요할 때만 제한된 transcript

GitHub에서:

- repository, PR number, title, body, URL
- source/target branch와 head commit
- changed files와 diff stats
- GitHub formal review가 계약인 경우 review verdict와 review body/comment
- 또는 별도로 확정한 Orca reviewer-result
- CI/check 상태
- mergeability와 merge 상태

`review 핵심 comment`와 `Merge Ready`는 GitHub의 단일 필드가 아니라 Bridge가 명시적으로 정의해야 하는 derived 의미다.

### 5.3 의미 압축

Summarizer에는 처음부터 transcript 전체를 보내지 않는다. 기본 입력은 Task 목적, `worker_done`, PR title/body, 변경 파일 범주, review 결과와 핵심 comment, CI·merge 상태다.

예상 structured output의 의미 예시:

```json
{
  "title": "결제 중복 처리 방지",
  "what": "같은 결제 요청이 여러 번 들어와도 한 번만 처리되도록 수정했습니다.",
  "why": "네트워크 재시도 시 동일 결제가 중복 처리될 가능성이 있었습니다.",
  "status": "review_changes_requested",
  "review": "응답 지연 후 재시도되는 예외 상황을 추가 보완해야 합니다.",
  "risk": "low"
}
```

필드명·enum·risk 산정·provider·model·언어·fallback은 아직 계약이 아니다.

Renderer는 다음을 보장해야 한다.

- validation된 structured result만 사용한다.
- 상태별 layout과 action을 코드로 결정한다.
- source fact에 없는 성공·안전성·검증을 주장하지 않는다.
- summarizer가 실패해도 Orca/GitHub 상태를 변경하지 않는다.
- 모델이 임의 버튼·링크·명령을 생성하지 않는다.

### 5.4 Slack projection

- 모든 repository의 semantic PR digest를 하나의 `#pr-digest`에 모을 수 있다.
- 모든 카드 상단에 project/repository/PR identity를 표시한다.
- PR 하나당 루트 메시지 하나를 만든다.
- 상태가 바뀌면 Bridge 자신이 작성한 같은 메시지를 `chat.update`로 갱신한다.
- 중요한 상태 변화만 thread에 한 번 남긴다.
- 모바일에서 무엇을, 왜, 현재 어떤 상태로 바꾸는지와 위험·검증·PR 링크를 짧게 파악할 수 있어야 한다.

구체적인 문구와 layout은 [Slack 메시지 UX](../ux/slack-surfaces.md)를 따른다.

## 6. D · Run Observer

### 6.1 기본 단위

Orca Run 하나를 Slack 루트 메시지 하나에 대응시킨다.

루트 메시지는 현재 상태를 보여준다.

- project/repository
- Run identity와 제목
- 실행 중·결정 필요·완료 등 현재 상태
- Task 전체 수와 완료·진행·대기 수
- 관련 PR과 핵심 상태
- open blocker 수
- 현재 사람 개입 필요 여부

동적으로 추가·취소·실패·재시도된 Task와 여러 Dispatch를 진행률에 반영하는 규칙은 TBD다.

`blocker`, open Gate, Gate에 blocked된 Task, dependency waiting, worker ask, CI failure, permission pause는 서로 다른 상태다. 카드의 blocker 수에 무엇을 포함할지는 별도 taxonomy로 확정한다.

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

이 정보가 Orca Gate의 어떤 필드 또는 별도 metadata에서 오는지는 TBD다.

### 6.3 결정 이후

Gate가 해결되면 thread에서 다음을 구분해 보여준다.

- Orca Gate에 결정이 기록됨
- 누가 언제 어떤 결정을 했는가
- coordinator 통지 상태
- 실제 Orca 상태로 관찰된 후속 작업 재개

Channel transport write만 성공했다고 “작업 재개”로 표시하지 않는다.

## 7. Slack Control Plane

### 7.1 초기 허용 입력

- Bridge가 생성한 Gate 선택지 버튼
- 해당 Gate에 연결된 직접 입력 modal

일반 channel/thread 메시지, 다른 bot 메시지, room membership만을 근거로 coordinator에 prompt를 전달하지 않는다.

### 7.2 처리 순서

1. Slack 요청을 제한 시간 안에 ACK한다.
2. payload의 실제 `user.id`를 owner allowlist와 비교한다.
3. workspace/team, action ID, Gate ID, option을 서버 측 기록과 대조한다.
4. Orca에서 Gate가 아직 open인지 읽는다.
5. 중복·경합 응답 여부를 확인한다.
6. Orca의 공식 `gate-resolve` interface로 resolution을 기록한다.
7. resolution과 coordinator notification 상태를 durable store에 기록한다.
8. 기존 coordinator에 Channel notification을 시도한다.
9. coordinator는 Orca Gate source of truth를 다시 읽고 후속 orchestration을 진행한다.

Slack payload를 바로 Claude prompt로 보내거나 Slack을 결정 저장소로 사용하지 않는다.

직접 입력 action은 예외적인 fast path를 가진다. sender/action을 빠르게 검증하고 button payload의 `trigger_id`가 만료되기 전에 ACK와 `views.open`을 3초 안에 끝낸다. 비-owner에게 modal을 열지 않는다. 실제 Gate resolution은 modal submission을 별도로 ACK한 뒤 수행한다. modal validation error를 화면에 남길 방식은 `OD-071`에서 확정한다.

## 8. Channel Adapter

Channel은 새 Web session이나 새 clone을 만드는 수단이 아니라 이미 열린 기존 로컬 coordinator 세션에 외부 이벤트를 push하는 수단이다.

Custom Channel Adapter는 Claude Code가 coordinator session별 subprocess로 실행하고 stdio MCP로 통신한다. 등록만으로는 충분하지 않고 각 session에서 channel opt-in과 적용되는 조직 policy를 통과해야 한다. 여러 coordinator가 동시에 열리면 Adapter instance도 여러 개일 수 있으므로 각 instance의 Run/session binding 계약이 필요하다.

개념 notification:

```xml
<channel source="orca-slack" gate_id="gate_84" decision="B">
Owner resolved gate gate_84.
</channel>
```

정확한 payload는 TBD다. Channel에서 실제 decision text를 신뢰해 실행하기보다 `gate_id`를 전달하고 coordinator가 Orca에서 resolution을 다시 읽는 방향을 유지한다.

반드시 고려할 현재 제약:

- Claude Code Channels는 research preview다.
- 열린 세션에서 명시적으로 channel이 활성화된 동안만 event가 도착한다.
- notification write에는 Claude가 실제 처리했다는 ACK가 없다.
- policy나 세션 설정에 따라 notification이 silent drop될 수 있다.
- custom Channel 개발·allowlist 경로는 버전별 검증이 필요하다.

따라서 최소한 다음 상태를 구분한다.

- Gate가 Orca에서 resolved됨
- coordinator notification이 pending임
- Channel Adapter에 전달을 시도함
- coordinator의 실제 후속 상태가 아직 관찰되지 않음

`delivered`, `processed`, `resumed`의 정확한 정의와 ACK 방식은 구현 전에 확정한다.

복구는 두 경로를 가진다.

- daemon은 durable outbox의 pending notification을 Adapter 재연결 시 다시 시도한다.
- coordinator는 Fresh/Resume와 확정할 turn/reconciliation trigger에서 resolved됐지만 미처리된 Gate를 다시 확인한다.

Channel reply tool 또는 localhost IPC를 통해 coordinator가 application receipt/status를 daemon에 돌려주는 양방향 경로도 목표 구조에 포함한다. 이 receipt는 실제 후속 Task 재개 증거와 동일하지 않으며 payload·멱등성은 TBD다.

## 9. Durability와 멱등성

로컬 durable store는 최소한 다음 의미를 보존해야 한다.

- canonical repository identity
- Project↔Repository mapping과 Slack routing identity
- PR number와 Slack channel/message identity
- 현재 projected PR state
- Orca Run/Task/Dispatch identity
- Run의 Slack message identity
- 이미 기록한 thread transition
- Gate와 Slack action correlation
- Orca resolution 결과
- coordinator notification pending/attempt 상태
- 마지막 성공 관찰 cursor 또는 snapshot

SQLite는 제시된 후보일 뿐 아직 확정 기술이 아니다.

필수 성질:

- 같은 repository+PR에 루트 메시지가 중복 생성되지 않는다.
- 같은 Run에 루트 메시지가 중복 생성되지 않는다.
- 같은 action이 Gate를 두 번 resolve하지 않는다.
- 재시작 후 기존 메시지를 찾아 update할 수 있다.
- Channel이 꺼져 있어도 Orca Gate resolution은 남는다.
- 오래된 event가 최신 카드를 과거 상태로 되돌리지 않는다.
- 재전송이 coordinator의 후속 작업을 중복 실행하게 하지 않는다.

crash 경계별 atomicity, outbox, DB migration, locking, retention, corruption recovery는 TBD다.

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

실제 Slack·GitHub·Orca 통합 테스트와 fixture 테스트의 경계는 빌드 시작 시 확정한다. 실행 명령과 출력 없이 완료를 선언하지 않는다.

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
