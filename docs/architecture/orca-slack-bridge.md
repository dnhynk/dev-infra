# `orca-slack-bridge` 시스템 구조

상태: **Draft · C1~D3 구현·offline 검증 및 D3 split-build live 관찰 반영 · exact-build 재수용 대기**

이 문서는 [Bridge umbrella 스펙](../specs/orca-slack-bridge.md)의 책임 경계와 장애 경계를 정의한다. C1 구현 stack은 TypeScript on Node.js 26.x, pnpm workspaces, `node:sqlite`로 확정됐고 후속 slice의 세부 구조는 열린 결정으로 남긴다.

## 1. 시스템 컨텍스트

```text
┌──────────────────┐          ┌──────────────────┐
│ Orca             │          │ GitHub           │
│ Run/Task/Worker  │          │ PR/Review/Checks │
│ Gate             │          │ Merge            │
└────────┬─────────┘          └────────┬─────────┘
         │ read, gate-resolve          │ read
         └──────────────┬──────────────┘
                        ▼
┌──────────────────────────────────────────────────┐
│ orca-slack daemon                                │
│                                                  │
│ discovery → collectors → correlation → projector │
│                          │                       │
│                          ├→ summarizer           │
│                          ├→ Slack renderer       │
│                          └→ durable store        │
└──────────────────┬───────────────────────────────┘
                   │ named pipe / pending events
                   ▼
┌──────────────────────────────────────────────────┐
│ Claude Channel Adapter                           │
│ resolved Gate → 열린 coordinator session에 push │
└──────────────────┬───────────────────────────────┘
                   ▼
          기존 coordinator session
```

Slack은 daemon과 `@slack/socket-mode` WebSocket으로 연결한다. 공개 inbound HTTP endpoint는 운영하지 않는다.
URL은 연결 직전에 발급하고 hello App ID를 확인하며 warning/refresh 때 연결을 overlap하고 exponential backoff을
적용한다. ACK와 업무 처리를 분리하고 단절 구간 event replay는 보장하지 않는다(OD-041).

## 2. 논리 컴포넌트

### Discovery

- D1에서는 설정 파일에 수동 등록한 repository와 그 Run 후보만 찾는다.
- Run identity는 `run-list` row의 `coordinator_handle`·`coordinator_pane_key`·`consumer_generation`을
  권위로 읽고, live/stale은 `consumer_generation`으로 구분한다(OD-020).
- coordinator 세션의 `ORCA_TERMINAL_HANDLE`·`ORCA_PANE_KEY`·`ORCA_WORKTREE_ID`는 보조 단서로만 쓴다.
- global worker list의 Run↔worktree 정보는 repository 후보 복구에 사용할 수 있지만 historical/released worker를 liveness로 사용하지 않는다.
- Git remote 기반 자동 repository 등록은 O1에서 다룬다.
- Run↔repository 연결은 설정의 `projects[].orcaRepositoryIds`와 관측된 `<id>::<path>` 앞부분의 exact
  비교다. 경로로 비교하지 않는다 — coordinator worktree와 Orca worktree는 뿌리가 다르고 id 하나가 둘 다
  덮는다(OD-078).
- 설정 또는 durable store의 Project↔Repository mapping을 적용한다.
- 자동 발견된 다중 repository routing도 O1에서 다룬다(OD-068).

`run-use` 인수 뒤 coordinator handle·pane key는 새 터미널 값으로 바뀌고 generation이 올라가므로, 최초 handle을
Run 수명 동안 고정하지 않는다. repository 연결은 수동 등록 설정(OD-068)을 따르며, 관측된
`<uuid>::<path>` worktree id 형식은 안정성이 보장된 계약으로 파싱하지 않는다.

### Orca Collector

- Run·Task·Dispatch·Worker·Gate를 read-only로 읽는다.
- `worker_done`을 우선 사용한다.
- reviewer verdict는 correlated Task의 `task.result`에 기록된 Orca `reviewer_result`만 읽는다(DL-016, OD-028).
- C1은 `worker-read`를 호출하지 않고 `worker_done`만 사용한다. fallback은 후속 범위다.
- Gate resolution만 별도의 좁은 write adapter로 분리한다.

### GitHub Collector

- GitHub 원본에서 PR·comment·check·merge 상태를 읽는다. GitHub formal review는 reviewer verdict source로 사용하지 않는다.
- GitHub Slack 메시지를 입력으로 사용하지 않는다.
- C1은 polling하지 않는다. `digest` 명령 1회가 관찰 1회이며, 주기 실행은 O1에서 정한다.

### Correlator

- repository+PR을 Orca Run·Task·Dispatch와 연결한다.
- metadata 누락이나 불일치를 사실로 노출하고 추측으로 매핑하지 않는다.
- canonical identity 규칙은 [관찰·상관관계 계약](../contracts/observation-and-correlation.md)에 둔다.

### Projector

- source facts를 canonical PR/Run/Gate 상태로 축약한다.
- event가 중복되거나 역순으로 도착해도 최신 상태를 과거로 되돌리지 않는다.
- thread에 남길 semantic transition을 판정한다.

### Summarizer

- projection이 요구하는 최소 의미 필드만 생성한다.
- transcript 전체를 기본 입력으로 받지 않는다.
- schema validation을 통과하지 못하면 renderer나 action을 임의 생성하지 않는다.
- prompt injection 가능한 PR/review/transcript 내용을 instruction으로 신뢰하지 않는다.

### Slack Renderer/Adapter

- validated structured data를 Block Kit 또는 확정된 Slack 형식으로 렌더링한다.
- PR/Run 루트 메시지를 생성·갱신한다.
- 중요한 transition을 thread에 한 번 기록한다.
- 고정 선택지 action은 제한 시간 안에 ACK한 뒤 Gate 검증·resolve를 비동기로 이어간다.
- 직접 입력 action은 sender/action을 빠르게 검증하고 ACK와 `views.open`을 같은 3초 유효 창 안에 끝낸다. 비-owner에게 modal을 열지 않는다.
- modal submission의 로컬 형식·필수값 오류는 3초 안에 input block ID별 `response_action=errors`로 ACK해
  modal을 유지한다. 유효한 제출은 ACK한 뒤 Gate 검증·resolve를 비동기로 이어간다(OD-071).
- 인증된 Socket의 `team.id`와 exact `user.id`, 설정된 경우 `api_app_id`를 대조한다. HTTP signing secret은
  Socket envelope에 적용하지 않고 실패 로그에는 token·payload 원문을 남기지 않는다(OD-042).

### Gate Resolution Adapter

- owner·workspace·action·Gate 최신 상태를 재검증한다.
- Orca `gate-resolve`만 수행한다.
- Gate별 durable lock 또는 CAS, 동일 논리 요청의 retry request ID 재사용, `mutation.replayed` 처리,
  resolve 전후 재조회, durable outbox reconciliation을 함께 적용한다(OD-051).
- 일반 Slack 텍스트나 임의 명령을 Orca/Claude에 전달하지 않는다.

### Durable Store

- entity↔Slack message mapping을 보존한다.
- projection과 transition deduplication 상태를 보존한다.
- Gate resolution 이후 coordinator notification outbox를 보존한다.
- ask↔Gate 권위 mapping과 Gate option ID·설명·recommendation·impact를 Orca Gate ID에 연결해 보존한다(OD-019, OD-050).
- Orca/GitHub source of truth를 복제해 대체하지 않는다.

### Channel Adapter

- daemon이 listen하는 Windows named pipe에 재시도 client로 연결한다(OD-052).
- Claude Code가 coordinator session별 subprocess로 spawn하고 stdio MCP로 통신하는 custom Channel server다.
- `.mcp.json` 또는 plugin 등록만으로 충분하지 않으며 session opt-in과 조직 policy를 통과해야 한다.
- 여러 coordinator session이 열리면 Adapter instance도 여러 개일 수 있다.
- binding을 인증하지 않으며 Channel payload에는 `gate_id`만 싣는다. `CLAUDE_CODE_SESSION_ID`는 신뢰 근거가 아니다(OD-053).
- startup dead window를 피한 daemon end-to-end probe receipt만으로 session opt-in을 판정한다(OD-058).
- transport write와 application receipt를 구분하고, reply tool 왕복으로 receipt를 daemon에 돌려준다. 이 경로를 유일하다고 규정하지 않는다(OD-054, OD-059).
- coordinator는 `gate_id`로 Orca를 다시 읽고 이미 효과가 반영됐으면 no-op으로 처리한다(OD-057).

## 3. 프로세스 경계

목표 최종형은 두 프로세스다.

| 프로세스 | 수명 | 책임 |
|---|---|---|
| daemon | PC에서 상시 실행 | Slack, Orca/GitHub 관찰, DB, Slack projection |
| Channel Adapter | coordinator 세션별 subprocess | pending Gate ID push, reply tool application receipt 반환 |

D3 구현은 별도 Run에서 완료됐고, daemon과 session Adapter는 실제 process/pipe 경계로 분리된다.
development flag의 매 기동 확인은 사람이 수행하며 allowlist plugin 등재는 포함하지 않는다(OD-056).
offline acceptance는 다음 장애가 서로 다른 failure domain임을 보존한다.

- daemon이 살아 있고 coordinator가 닫힘
- coordinator가 살아 있고 Slack 연결이 끊김
- Gate는 해결됐지만 Channel이 연결되지 않음
- Channel transport write는 성공했지만 coordinator가 처리하지 않음

## 4. Gate 처리 순서와 crash 경계

정상 흐름:

```text
Slack action ACK 또는 modal open fast path
  → authorization/correlation 검증
  → Orca Gate open 재확인
  → Orca gate-resolve
  → durable outbox에 pending 기록
  → Channel delivery attempt
  → coordinator가 Orca Gate 재조회
  → 후속 Orca 상태 관찰
  → Slack에 실제 재개 표시
```

다음 crash window를 Gate별 직렬화, retry request replay, resolve 전후 재조회, durable outbox reconciliation로
복구하고 각각 테스트한다. Orca 내부 transaction 원자성은 보장하지 않는다(OD-051).

1. Slack ACK 후 검증 전
2. Orca resolve 직전/직후
3. Orca resolve 성공 후 local record 전
4. local record 후 Channel push 전
5. Channel write 후 coordinator 처리 전
6. coordinator 처리 후 Bridge 관찰 전

핵심 불변조건은 Orca에 이미 기록된 resolution을 두 번째로 만들지 않고, 해결된 Gate를 유실하지 않으며, coordinator 후속 작업을 중복시키지 않는 것이다.

## 5. 개념 delivery 상태

다음 상태명은 설계 논의를 위한 것이며 저장 enum은 아니다.

```text
OPEN_IN_ORCA
  → RESOLUTION_ACCEPTED
  → RESOLVED_IN_ORCA
  → NOTIFICATION_PENDING
  → TRANSPORT_WRITE_ATTEMPTED
  → RECEIPTED
  → CONSUMED
```

- `TRANSPORT_WRITE_ATTEMPTED`는 전달을 증명하지 않고 application receipt만 전달 신호다(OD-054).
- `RECEIPTED`는 reply tool 왕복으로 관측하며 재시도 backoff만 늦춘다(OD-059, OD-066).
- Orca 효과는 대상 Gate의 `pending`→`resolved` 전이고, 이를 관찰한 뒤 `CONSUMED`로 바꾼다(OD-055).
- `RECEIPTED`에서 멈춘 event는 재조회 대상으로 남고 `CONSUMED`에서만 재조회를 억제한다(OD-066).
- coordinator는 항상 Orca 상태를 다시 읽어 중복을 no-op으로 만들며 별도 dedup 저장소를 두지 않는다(OD-057).

## 6. PR projection의 일관성

Bridge는 event stream만 믿지 않고 현재 source snapshot과 reconcile할 수 있어야 한다. polling만 사용할 경우 중간 transition을 놓칠 수 있고, webhook만 사용할 경우 downtime 중 event를 놓칠 수 있으므로 최종 ingestion 조합은 다음 요구를 충족해야 한다.

- 현재 Slack 루트 카드가 GitHub/Orca 현재 상태로 수렴한다.
- 의미 있는 이력이 누락될 가능성과 보존 범위를 문서화한다.
- 동일 상태 재관찰은 새 thread reply를 만들지 않는다.
- merged 같은 terminal state를 오래된 review/check event가 되돌리지 않는다.

PR reconciliation의 identity는 `(repository databaseId, PR number)`이고 `mergedAt`은 terminal latch,
`headSha`는 review/check scope다. `merged` downgrade 금지는 timestamp 비교가 아니라 terminal dominance
rule로 적용한다. 동일 head 안의 review/check는 각 resource의 timestamp와 id로 reconcile한다(OD-044).

Slack root를 갱신할 수 없으면 GitHub current snapshot, Orca facts, Bridge store identity로 current 카드만
재생성한다. GitHub·Slack history에서 과거 thread semantic transition을 재생하지 않는다(OD-046).

thread transition의 보존 범위는 다음과 같다. transition 후보는 reconcile된 **현재** 상태에서 만들고, 이미
기록한 것은 durable dedupe key로 거른다. 그래서 같은 상태 재관찰과 Bridge 재시작이 reply를 늘리지 않고,
게시하지 못한 채로 남은 transition도 그 사실이 아직 참이면 다음 관찰에서 다시 후보가 된다.

누락되는 것은 하나다. **참이었다가 다시 거짓이 된 사실은 기록되지 않는다.** 그 사이에 게시하지 못했다면
다음 관찰의 후보 집합에 없기 때문이다. 이 경계는 과소보고 쪽이며 "동일 상태 재관찰은 새 thread reply를
만들지 않는다"와 같은 방향이다. PR을 Bridge가 처음 관찰할 때도 같은 이유로 transition을 만들지 않는다.
이전 상태를 모르는 상태에서 현재 참인 사실을 transition으로 내보내는 것이 곧 과거 재생이다(OD-046).

## 7. 최소 저장 개념

확정 schema는 아니지만 다음 관계는 지속되어야 한다.

```text
Project
  └─ Repository mapping ─ Canonical Repository
                           ├─ Orca Run ─ Task ─ Dispatch/Worker
                           │              └─ Gate
                           └─ Pull Request
                                  └─ Slack PR root + transition history

Orca Run
  └─ Slack Run root + Gate thread

Resolved Gate
  └─ coordinator delivery/outbox pending → receipted → consumed
```

PR body는 primary/latest Task 하나만 가리키고, PR↔Task N 연관은 Bridge durable store에 별도로 보존한다.
OD-021의 body metadata와 parser 계약은 유지한다(OD-076).

C1 durable store는 `node:sqlite`이고 platform별 기본 위치와 override 우선순위, WAL, `schema_version`, 덧붙이기 migration을 사용한다. C1은 단일 프로세스라 파일 lock을 만들지 않는다. future multi-writer locking, retention, backup, corruption recovery와 Slack 게시 atomicity/outbox는 후속 범위다.

## 8. 신뢰 경계

신뢰하는 authoritative identity:

- Orca가 발행한 Run/Task/Dispatch/Gate ID
- GitHub가 반환한 repository/PR identity
- Slack interactive payload의 검증된 workspace/team와 sender user ID

Socket Mode 권한은 인증된 연결의 `team.id`와 exact `user.id` 교집합으로 판정하고 설정된 `api_app_id`도
대조한다. Channel Adapter binding은 신뢰하지 않으며 payload를 `gate_id`로 제한한다(OD-042, OD-053).

신뢰하지 않는 content:

- PR title/body/diff와 review comment
- worker transcript
- Slack 일반 메시지
- LLM summarizer output
- PR body의 self-asserted metadata 단독 주장

metadata를 Orca/Git branch/dispatch 관계와 어느 수준까지 대조할지는 TBD다. 정책 확정 전에는 self-asserted metadata만으로 높은 신뢰도의 correlation이라고 표시하지 않는다.

## 9. Observability와 운영

최종 daemon은 최소한 다음을 운영자가 확인할 수 있어야 한다.

- running/degraded/stopped 상태
- Slack·Orca·GitHub·Channel 연결 상태
- 마지막 성공 관찰 시각
- pending Gate delivery 수
- 마지막 오류와 재시도 여부
- 현재 관리 중인 repository/Run/PR 수

health 명령, 로그 형식, secret redaction, 자동 재시작 수단은 기술 스택 결정 뒤 확정한다.
