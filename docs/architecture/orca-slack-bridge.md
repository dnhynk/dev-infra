# `orca-slack-bridge` 시스템 구조

상태: **Draft · C1 구현·검증 반영, 후속 slice 경계 미정**

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
                   │ localhost IPC / pending events
                   ▼
┌──────────────────────────────────────────────────┐
│ Claude Channel Adapter                           │
│ resolved Gate → 열린 coordinator session에 push │
└──────────────────┬───────────────────────────────┘
                   ▼
          기존 coordinator session
```

Slack은 daemon과 Socket Mode WebSocket으로 연결하는 방향이다. 공개 inbound HTTP endpoint를 운영하지 않는 것이 개인 PC 환경의 목표다.

## 2. 논리 컴포넌트

### Discovery

- Orca Run 후보를 찾는다.
- Run과 live coordinator terminal/worktree/repository를 연결한다.
- global worker list의 Run↔worktree 정보는 repository 후보 복구에 사용할 수 있지만 historical/released worker를 liveness로 사용하지 않는다.
- Git remote에서 canonical GitHub repository를 식별한다.
- 설정 또는 durable store의 Project↔Repository mapping을 적용한다.
- 수동 등록과 자동 발견의 우선순위를 적용한다.

현재 로컬 Orca의 `run-list`만으로 repository와 coordinator liveness를 알 수 없으므로 terminal/worktree 상관관계 또는 추가 등록 계약이 필요하다.

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
- modal submission은 3초 안에 ACK하고 Gate 검증·resolve를 비동기로 이어간다. modal validation error UX는 `OD-071`에서 확정한다.

### Gate Resolution Adapter

- owner·workspace·action·Gate 최신 상태를 재검증한다.
- Orca `gate-resolve`만 수행한다.
- 일반 Slack 텍스트나 임의 명령을 Orca/Claude에 전달하지 않는다.

### Durable Store

- entity↔Slack message mapping을 보존한다.
- projection과 transition deduplication 상태를 보존한다.
- Gate resolution 이후 coordinator notification outbox를 보존한다.
- Orca/GitHub source of truth를 복제해 대체하지 않는다.

### Channel Adapter

- daemon과 localhost로 통신한다.
- Claude Code가 coordinator session별 subprocess로 spawn하고 stdio MCP로 통신하는 custom Channel server다.
- `.mcp.json` 또는 plugin 등록만으로 충분하지 않으며 session opt-in과 조직 policy를 통과해야 한다.
- 여러 coordinator session이 열리면 Adapter instance도 여러 개일 수 있다.
- 각 Adapter는 daemon에 자신이 어느 Run/coordinator session에 binding됐는지 증명해야 한다.
- pending Gate event를 열린 세션에 push한다.
- transport write와 coordinator 처리 완료를 구분한다.
- coordinator의 명시적 application receipt 또는 status reply를 daemon에 되돌리는 양방향 경로를 제공할 수 있어야 한다. reply tool/IPC의 정확한 계약은 TBD다.

## 3. 프로세스 경계

목표 최종형은 두 프로세스다.

| 프로세스 | 수명 | 책임 |
|---|---|---|
| daemon | PC에서 상시 실행 | Slack, Orca/GitHub 관찰, DB, Slack projection |
| Channel Adapter | coordinator 세션별 subprocess | pending decision push, 선택적 application receipt/status 반환 |

첫 구현부터 물리적으로 분리할지는 size 조사 후 결정한다. 다만 코드 구조와 데이터 계약은 다음 장애가 서로 다른 failure domain임을 보존해야 한다.

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

구현 전에 다음 crash window의 복구 규칙을 각각 결정하고 테스트해야 한다.

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
  → APPLICATION_RECEIPT_RECEIVED (optional)
  → COORDINATOR_EFFECT_OBSERVED
```

- `TRANSPORT_WRITE_ATTEMPTED`는 Claude가 읽거나 처리했다는 뜻이 아니다.
- `APPLICATION_RECEIPT_RECEIVED`는 별도 reply/IPC 계약이 실제로 구현된 경우에만 존재한다.
- `COORDINATOR_EFFECT_OBSERVED`는 어떤 Orca 변화가 충분한 증거인지 TBD다.
- 세션이 다시 연결되면 `NOTIFICATION_PENDING` 또는 재시도 가능한 event를 복구할 수 있어야 한다.
- daemon의 outbox 재시도와 coordinator의 Fresh/Resume/turn-boundary Gate reconciliation은 독립 복구 경로다. 정확한 trigger와 consumed marker는 TBD다.

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
  └─ coordinator delivery/outbox state
```

PR body는 primary/latest Task 하나만 가리키고, PR↔Task N 연관은 Bridge durable store에 별도로 보존한다.
OD-021의 body metadata와 parser 계약은 유지한다(OD-076).

C1 durable store는 `node:sqlite`이고 platform별 기본 위치와 override 우선순위, WAL, `schema_version`, 덧붙이기 migration을 사용한다. C1은 단일 프로세스라 파일 lock을 만들지 않는다. future multi-writer locking, retention, backup, corruption recovery와 Slack 게시 atomicity/outbox는 후속 범위다.

## 8. 신뢰 경계

신뢰하는 authoritative identity:

- Orca가 발행한 Run/Task/Dispatch/Gate ID
- GitHub가 반환한 repository/PR identity
- Slack interactive payload의 검증된 workspace/team와 sender user ID

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
