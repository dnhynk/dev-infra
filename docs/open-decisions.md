# 미결정 사항 장부

상태: **Open**

사용자는 구체 기술 결정을 빌드 과정의 관측과 논의를 통해 확정한다. 아래 항목을 구현자가 추측으로 닫지 않는다.

상태 값:

- `OPEN`: 아직 결정하지 않음
- `INVESTIGATING`: 실제 자료를 수집 중
- `DECIDED`: 사용자와 합의하고 근거·날짜를 기록함
- `SUPERSEDED`: 후속 결정으로 대체됨

## 플랫폼과 monorepo

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-001 | 언어와 런타임 | 첫 코드 작성 전 | DECIDED |
| OD-002 | package manager와 monorepo 도구 | monorepo scaffold 전 | DECIDED |
| OD-003 | 테스트 framework와 CI | 첫 slice 구현 전 | DECIDED |
| OD-004 | 지원 Windows/Orca/Claude Code/Slack/GitHub 버전 | adapter 계약 확정 전 | OPEN |
| OD-005 | 설정 파일 형식과 secret 주입 방식 | 실제 통합 전 | DECIDED |

## Bootstrap & Continuity

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-010 | `/init-orchestrate` 패키징과 `/orchestration` 호출 계약 | AB 구현 전 | DECIDED |
| OD-011 | authoritative spec 발견·우선순위 규칙 | AB 구현 전 | DECIDED |
| OD-012 | fresh/resume 자동 판별 또는 명시 옵션 | AB 구현 전 | DECIDED |
| OD-013 | `HANDOFF.md` 위치·schema·archive·atomic write | AB-1 전 | DECIDED |
| OD-014 | context 열화 신호와 threshold | AB-2 전 | DECIDED |
| OD-015 | successor 세션 생성·부팅·ACK 공식 수단 | AB-2 전 | DECIDED |
| OD-016 | coordinator single-writer와 권한 이관 | AB-2 전 | DECIDED |
| OD-017 | `sol high fast`의 실제 model/effort/tier mapping | reviewer dispatch 전 | DECIDED |
| OD-074 | supervised worker 경로에서 service tier를 지정할 수단 | reviewer dispatch 전 | OPEN |
| OD-018 | handoff redaction과 transcript 포함 범위 | AB-1 전 | OPEN |
| OD-019 | worker ask/escalation↔coordinator reply↔사람용 Gate correlation | AB-1/D1 전 | OPEN |

## Orca·GitHub 관찰과 correlation

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-020 | Run↔repo cardinality와 Run↔worktree↔coordinator session identity | S0 전 | OPEN |
| OD-021 | PR HTML metadata 최종 형식과 작성 주체 | AB-1/S0 전 | DECIDED |
| OD-022 | metadata 누락·불일치·변조 정책 | S0 전 | DECIDED |
| OD-023 | Orca polling/event/reconciliation 방식과 주기 | S0 전 | DECIDED |
| OD-024 | GitHub API와 `gh` adapter, 인증, 갱신 방식 | S0 전 | DECIDED |
| OD-025 | `worker-read` fallback 조건과 최대 범위 | C1 전 | DECIDED |
| OD-026 | repository canonicalization, rename/fork/multiple remote | S0 전 | DECIDED |
| OD-027 | Project↔Repository cardinality, 등록 주체, 설정/DB mapping과 routing | S0 전 | DECIDED |
| OD-028 | reviewer verdict를 GitHub formal review와 Orca 중 어디에 durable하게 남길지 | C1/C2 전 | DECIDED |
| OD-029 | PR 생성과 `worker_done` 전송의 ordering 및 PR identity 포함 방식 | AB-1/S0 전 | DECIDED |
| OD-069 | Run 진행률 분모와 dynamic/cancelled/failed/retried Task·multiple Dispatch 집계 | D1 전 | OPEN |
| OD-070 | `worker_done` 누락·중복·불완전 payload의 상태와 recovery | S0/C1 전 | DECIDED |
| OD-073 | Orca reviewer-result의 필드·enum·작성 주체와 task status 전이 규칙 | AB-1/C1 전 | DECIDED |
| OD-075 | `task.result`가 덮어쓴 `worker_report`의 durable 조회·pagination 계약 | C2 전 | DECIDED |
| OD-076 | PR 1 : Task N correlation metadata와 cardinality | AB-1/C2 전 | DECIDED |
| OD-077 | run만 있고 task가 없는 PR의 correlation kind와 처리 정책 | S0/C2 전 | DECIDED |

## PR state와 요약

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-030 | canonical PR state와 transition | C2 전 | DECIDED |
| OD-031 | review verdict 축약과 새 commit 후 approval | C2 전 | DECIDED |
| OD-032 | required/optional check와 merge-ready 정책 | C2 전 | DECIDED |
| OD-033 | review 핵심 comment 선택 규칙 | C1/C2 전 | DECIDED |
| OD-034 | summarizer provider/model/schema/language | C1 전 | DECIDED |
| OD-035 | summarizer 실패 fallback, cache, 호출 상한 | C1 전 | DECIDED |
| OD-036 | code/review/transcript의 LLM·Slack 전송 경계 | C1 전 | DECIDED |
| OD-037 | risk 산정 근거와 표시 조건 | C1 전 | DECIDED |

## Slack과 durable store

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-040 | Slack App manifest, scopes, 채널 ID 설정 | C1/D2 전 | DECIDED |
| OD-041 | Socket Mode 최종 채택과 reconnect 정책 | 실제 Slack 통합 전 | OPEN |
| OD-042 | owner/workspace allowlist 관리 | D2 전 | OPEN |
| OD-043 | durable store 기술·경로·migration·locking | C1 전 | DECIDED |
| OD-044 | event idempotency와 out-of-order 우선순위 | C2 전 | DECIDED |
| OD-045 | retention, backup, corruption recovery | 운영 자동화 전 | OPEN |
| OD-046 | Slack message 삭제·archive·channel 변경 복구 | C2/D1 전 | DECIDED |
| OD-047 | Slack identity 영역에서 Project와 Repository를 둘 다 표시할지와 fallback | C1/D1 전 | DECIDED |
| OD-048 | 공통 channel topology의 최종 채택 여부 | 첫 Slack 설정 전 | OPEN |
| OD-049 | GitHub 공식 Slack App 설치와 repo별 review/workflow 구독 범위 | 운영 환경 준비 전 | OPEN |
| OD-071 | modal submission validation error를 modal에 유지·표시하는 UX | D2 전 | OPEN |
| OD-072 | correlation/summarizer/source stale/Channel pending 등 degraded owner 알림 정책 | C1/D1/D2 전 | DECIDED (C1 범위만. D1/D2 알림 정책은 계속 열려 있음) |

## Gate와 Channel

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-050 | Gate option·recommendation·impact metadata | D1/D2 전 | OPEN |
| OD-051 | Gate 처리 crash window와 outbox atomicity | D2 전 | OPEN |
| OD-052 | daemon↔Channel Adapter IPC | D3 전 | OPEN |
| OD-053 | Run↔현재 coordinator Channel routing | D3 전 | OPEN |
| OD-054 | pending/attempted/delivered/processed/resumed 정의 | D3 전 | OPEN |
| OD-055 | coordinator 처리 ACK 또는 효과 관찰 기준 | D3 전 | OPEN |
| OD-056 | Channel custom 개발·allowlist·배포 경로 | D3 전 | OPEN |
| OD-057 | notification 중복 시 coordinator 멱등성 | D3 전 | OPEN |
| OD-058 | Fresh/Resume에서 Adapter 등록·session opt-in을 자동 검증하는 책임 | D3 전 | OPEN |
| OD-059 | coordinator application receipt/status를 daemon에 반환하는 reply/IPC 계약 | D3 전 | OPEN |
| OD-066 | Channel 유실 시 coordinator Gate 재조회의 trigger와 consumed marker | D3 전 | OPEN |
| OD-067 | blocker/open Gate/blocked Task/ask/CI/permission pause 집계 taxonomy | D1 전 | OPEN |

## 운영과 검증

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-060 | 실제 Slack/GitHub/Orca 통합 테스트 범위 | 첫 외부 write 전 | DECIDED |
| OD-061 | 테스트 workspace/repository/Run과 owner identity | 첫 외부 write 전 | DECIDED |
| OD-062 | 허용 지연, polling/API/LLM 비용 한도 | 운영 전 | OPEN |
| OD-063 | daemon 자동 시작 방식 | O1 전 | OPEN |
| OD-064 | health/log/audit format과 secret 마스킹 | 실제 통합 전 | OPEN |
| OD-065 | 초기 동시 repository/Run 규모 | S0 전 | OPEN |
| OD-068 | D1의 수동 등록 다중 repo 범위와 O1 자동 발견/routing 경계 | D1/O1 전 | OPEN |

## 결정 기록 형식

항목을 닫을 때 다음을 남긴다.

```text
ID:
상태: DECIDED
결정:
근거:
대안과 기각 이유:
영향 문서/파일:
검증 방법:
결정일:
```

빌드 중 새 결정이 생기면 기존 항목에 억지로 합치지 말고 새 ID로 추가한다.

## 확정 기록

```text
ID: OD-001
상태: DECIDED
결정: TypeScript on Node.js 26.x
근거:
  - platform-capabilities가 Socket Mode를 공식 확인한 구현은 Bolt for JavaScript다.
  - Channel Adapter는 Claude Code가 stdio로 spawn하는 MCP server이며 MCP는 TypeScript SDK가 레퍼런스 구현이다.
  - node:sqlite가 런타임에 내장되어 Windows에서 네이티브 모듈 빌드 없이 durable store를 쓸 수 있다(로컬 실행으로 확인).
  - daemon과 Channel Adapter를 한 언어로 유지하면 프로세스 분리 시점을 나중에 정해도 코드 이동 비용이 없다.
대안과 기각 이유:
  - Python 3.13 + slack_bolt + MCP Python SDK: 동작 가능하나 문서가 검증한 경로가 아니고 Windows 패키징과 SQLite 의존이 하나 더 늘어난다. 더 낫다고 볼 근거가 없어 기각.
영향 문서/파일: architecture/orca-slack-bridge.md, roadmap.md, 향후 apps/orca-slack-bridge
검증 방법: node -e 로 node:sqlite CRUD 실행 확인(2026-08-21). Bolt/MCP SDK 실제 통합은 각 slice에서 검증.
결정일: 2026-08-21
```

```text
ID: OD-002
상태: DECIDED
결정: pnpm workspaces. 빌드 오케스트레이터(Turborepo/Nx)는 도입하지 않는다.
근거: 현재 워크스페이스가 사실상 1~2개이므로 task graph/캐싱 계층은 작업 규약의 조기 일반화 금지에 해당한다.
대안과 기각 이유: Turborepo/Nx는 필요해지는 시점에 근거와 함께 재검토한다. npm/yarn workspaces 대비 pnpm은 로컬에 이미 설치되어 있고 monorepo 링크 동작이 명시적이다.
영향 문서/파일: 루트 pnpm-workspace.yaml, package.json (미생성)
검증 방법: pnpm 11.22.0 설치 확인(2026-08-21). 실제 workspace 해석은 scaffold 시 검증.
결정일: 2026-08-21
```

```text
ID: OD-003
상태: DECIDED
결정: Vitest. CI는 GitHub Actions로 하되 remote 생성 이후에 붙인다. 그전까지는 로컬 테스트 통과를 게이트로 쓴다.
근거: S0/C1/C2의 핵심 로직이 fixture 기반 projection·transition 판정이라 fixture/스냅샷·mocking 편의가 검증 속도를 좌우한다.
대안과 기각 이유: node:test는 의존성이 더 적지만 fixture/mock 편의가 떨어진다. 이 프로젝트의 테스트 형태에는 이점이 작다.
영향 문서/파일: roadmap.md 각 slice 출구 조건, 향후 .github/workflows
검증 방법: 첫 slice에서 실제 pnpm test 실행 명령과 출력을 남긴다. 현재 미실행.
결정일: 2026-08-21
```

## 2026-08-21 관측이 바꾼 항목

아직 닫지 않았지만 제약이 좁혀졌다. 근거는 [플랫폼 검증 §2.4](platform-capabilities.md#24-gate).

- **OD-050** (Gate option/recommendation/impact metadata): 실측 결과 Orca Gate schema에 권장안·이유·영향·선택지 설명·선택지 ID·임의 metadata 필드가 **전혀 없다**. "제공되는지 확인"이 아니라 "Bridge 또는 coordinator가 반드시 만들어야 한다"로 성격이 바뀌었다. 남은 선택지는 `question`/`options` 문자열 인코딩, Bridge sidecar store, 카드 축소 셋 중 하나다.
- **OD-051** (crash window와 outbox atomicity): `--retry-request`가 같은 요청의 재시도를 멱등화하고 `mutation.replayed`로 재생을 판정할 수 있다. 그러나 **이미 resolved된 Gate를 다른 요청이 조용히 덮어쓴다.** 따라서 (1) resolve 직전 status 재확인은 필수이고, (2) status 확인과 resolve 사이 TOCTOU를 막을 Gate 단위 직렬화가 Bridge 측에 필요하다.
- **OD-067** (blocker taxonomy): `gate-create`가 task를 `blocked`로, `gate-resolve`가 `ready`로 자동 전이시키는 것을 관측했다. `blocked Task`는 Bridge가 계산하지 않고 Orca status를 그대로 쓸 수 있다. `permission pause`는 `worker-show`의 `observation.agentWait`가 source 후보다.
- **OD-023** (ingestion 방식): Gate 생성·해결이 `inbox`에 메시지를 만들지 않는다. Gate 변화는 push로 오지 않으므로 polling 또는 재조회가 필요하다. 또한 Observer는 `check --ack`를 호출하면 coordinator의 배치를 소비하므로 `inbox` 또는 `check --peek/--all`로 제한해야 한다.
- **OD-020** (Run↔repository↔coordinator identity): Task row의 `created_by_process_incarnation`에 작업 디렉터리(`D:/dev-infra`)가 포함되고, `run-create` 시 `coordinator_handle`·`coordinator_pane_key`가 자동으로 채워진다. 두 경로 모두 후보이며 파싱 안정성은 미검증이다.

## 2026-08-22 Channel 검증이 바꾼 항목

근거는 [플랫폼 검증 §3.4](platform-capabilities.md#34-검증된-동작과-운영-제약).

- **OD-056** (Channel custom 개발·allowlist·배포 경로): 로컬 2.1.238에서 `--dangerously-load-development-channels server:<name>` + `--mcp-config` 절대경로 조합으로 custom channel이 실제 등록·전달됨을 확인했다. preview 동안은 이 경로가 유일하며 `--channels`는 Anthropic allowlist plugin만 받는다. plugin 패키징으로 옮기는 시점은 여전히 OPEN이다.
- **OD-059** (coordinator application receipt 반환 계약): reply tool이 실제 receipt 경로로 동작함을 관측했다. 서버가 이벤트 상태를 추적하고 Claude가 tool을 호출해 수신을 보고하는 구조가 성립한다. payload와 멱등성 설계는 여전히 OPEN이다.
- **OD-054** (pending/attempted/delivered/processed/resumed 정의): `TRANSPORT_WRITE_ATTEMPTED`(서버의 `PUSHED` 기록)와 `APPLICATION_RECEIPT_RECEIVED`(reply tool 호출)를 실제로 구분해 관측했다. 두 상태의 물리적 근거가 확보됐다.
- **OD-062** (허용 지연): push부터 Claude가 receipt를 호출하기까지 약 7~10초를 관측했다. 유휴 세션·단일 이벤트 조건의 값이며 모델 턴 시간을 포함한다.
- **OD-063** (daemon 자동 시작 방식): **channel 이벤트는 대화형 세션에만 도달한다.** `-p` 비대화형 세션에서는 같은 구성으로 4회 모두 미도달이었다. 따라서 wake-up 대상 coordinator 세션은 대화형으로 유지돼야 하며, daemon 자동 시작 설계는 coordinator를 headless로 대체하는 방향을 취할 수 없다.
- **OD-057** (notification 중복 시 coordinator 멱등성): 이번 관측에서는 유실 0·중복 0이었고 큐 순서도 보존됐다. 다만 세션 재시작과 장시간 운용은 검증하지 않았으므로 항목은 OPEN을 유지한다.

## 2026-08-22 GitHub 실측이 바꾼 항목

근거는 [플랫폼 검증 §5.3](platform-capabilities.md#53-대상-repository-실측).

- **OD-028** (reviewer verdict의 durable source): 성격이 바뀌었다. 사용자 repository 4곳 전부에서 `reviewDecision`이 null이고, review가 존재하는 1곳도 전부 `COMMENTED`다. PR author와 review author가 같은 계정이라 GitHub이 self-approve를 막으므로 **현재 workflow에서는 formal verdict가 원리적으로 불가능하다.** "GitHub과 Orca 중 어디를 계약으로 삼을지"가 아니라 "workflow를 어떻게 바꿀지"의 문제이며, 이는 Bridge 단독 결정이 아니라 AB workstream(`/init-orchestrate`의 reviewer 계약)과 함께 정해야 한다.
- **OD-033** (review 핵심 comment 선택 규칙): `vertical-live` 규약의 `## Findings` 아래 `[blocker]`/`[major]`/`[minor]` 태그가 추출 대상으로 직접 쓰인다. 다만 이 규약은 4개 repo 중 1곳에만 존재하므로 전역 계약으로 만들어야 의존할 수 있다.
- **OD-037** (risk 산정 근거): `[blocker]`/`[major]`/`[minor]` 개수를 집계하면 risk를 LLM 추정이 아니라 사실로 산정할 수 있다. 규약이 전역화되는 것이 전제다.
- **OD-032** (required/optional check와 merge-ready 정책): repository별 check 개수가 0~2개로 제각각이고 CI가 아예 없는 repo도 있다. merge-ready 판정에 CI 통과를 무조건 전제할 수 없다.
- **OD-021** (PR correlation metadata): `vertical-live` PR body에 `## Task`/`T-ID` 규약이 이미 있으나 Orca Run/Task/Dispatch ID는 없다. 새 metadata를 기존 규약과 공존시키는 형식을 정해야 한다.

```text
ID: OD-028
상태: DECIDED
결정: reviewer verdict의 durable source는 Orca다. reviewer가 coordinator에게 반환한 결과를 Orca에 구조화해 기록하고, Bridge는 GitHub review 본문이 아니라 Orca를 읽는다.
근거:
  - 사용자 repository 4곳 전부에서 GitHub `reviewDecision`이 null이다.
  - PR author와 review author가 같은 계정이라 GitHub이 self-approve를 막으므로 현재 workflow에서 formal verdict는 원리적으로 불가능하다.
  - `orca orchestration task-update --result <json>`이 중첩 객체·배열을 손실 없이 보존함을 실측으로 확인했다.
  - Gate도 이미 Orca에서 읽으므로 orchestration 사실의 source가 하나로 모인다.
  - GitHub review 본문은 신뢰 경계상 untrusted content이며, 이를 상태 source로 삼으면 형식이 깨질 때 fallback이 필요하다.
대안과 기각 이유:
  - reviewer용 별도 GitHub 계정/PAT: `reviewDecision`이 살아나고 GitHub 의미론과 정확히 일치하지만, 계정·토큰 관리가 늘고 모든 repository 설정을 바꿔야 한다. 기각.
  - review 본문 규약(`## Verdict:`) 전역화 후 파싱: 기존 자산을 쓸 수 있으나 untrusted 본문을 상태 source로 삼는 문제가 남는다. 표시용 보조 사실로만 활용한다.
영향 문서/파일: contracts/observation-and-correlation.md §6, specs/orca-slack-bridge.md §5, specs/orchestration-bootstrap-and-continuity.md §4, architecture/orca-slack-bridge.md
검증 방법: throwaway Run에서 task-update --result 왕복 실측(2026-08-22). 실제 reviewer 경로 통합은 AB-1/C1에서 검증한다.
결정일: 2026-08-22
후속: 기록 형식·필드·enum·작성 주체와 task status 전이 규칙은 OD-073에서 AB workstream과 함께 확정한다.
```

## 2026-08-22 AB-0 환경 관측이 바꾼 항목

근거는 [플랫폼 검증 §2.7](platform-capabilities.md#27-run--coordinator-session--repository-identity).

- **OD-020** (Run↔repo↔coordinator session identity): 실측 경로가 확보됐다. coordinator 세션의 `ORCA_TERMINAL_HANDLE`/`ORCA_PANE_KEY`가 Run row의 `coordinator_handle`/`coordinator_pane_key`와 동일 값이고, `ORCA_WORKTREE_ID`가 로컬 경로를 담아 Git remote를 거쳐 GitHub repository로 이어진다. 남은 미결은 (1) 환경변수를 어느 신뢰 수준으로 취급할지, (2) `<uuid>::<path>` 형식의 안정성, (3) coordinator 재시작 시 handle 유지 여부다.
- **OD-053** (Run↔현재 coordinator Channel routing): Channel Adapter가 MCP 서브프로세스로서 위 identity를 그대로 상속하고 `CLAUDE_CODE_SESSION_ID`는 자기 세션 값으로 받는 것을 실측했다. Adapter 자기소개 payload의 재료가 확정 가능하다. 단 coordinator pane 안의 자식 세션도 같은 `ORCA_*`를 상속하므로 세션 구분에는 `CLAUDE_CODE_SESSION_ID`가 필요하다. `CLAUDE_PID`는 조상 값이 상속되므로 사용 금지.
- **OD-010** (`/init-orchestrate` 패키징과 호출 계약): 이 환경의 skill은 `~/.agents/skills/<name>/SKILL.md`에 있고 `~/.claude/skills`는 존재하지 않는다. `orchestration` skill은 discovery stub이고 실제 가이드는 `orca skills get orchestration --full`이 서빙한다. 같은 stub+런타임조회 패턴이 `/init-orchestrate`의 후보다. 실제 배치 위치는 coordinator 세션이 발견하는지 실측한 뒤 확정한다.
- **OD-015** (successor 세션 생성 공식 수단): `orchestration coordinator-start`가 은퇴해 Orca orchestration 표면에는 없다(§7.2). 남은 후보는 `orca-cli`의 terminal/worktree 생성 계열이며 아직 조사하지 않았다.
- **OD-016** (coordinator single-writer와 권한 이관): `run-use --takeover-legacy`가 "live coordinator agent terminal에서 실행, 기존 worker 배정 보존"이라는 실제 메커니즘으로 존재한다(§7.2). pane/terminal handle이 세션 identity와 연결되므로 fencing 판정의 재료도 있다. 절차 설계는 미결이다.

## 2026-08-22 AB-0 부팅·롤오버 실측이 바꾼 항목

근거는 [플랫폼 검증 §3](platform-capabilities.md#3-claude-code).

- **OD-016** (single-writer와 권한 이관): 승계 절차의 골격이 정해졌다. predecessor가 임계값에서 스스로 신규 dispatch·merge를 멈추고(self-fence) → handoff를 확정한 뒤 → `terminal create`로 successor를 만들고 → successor가 그 터미널에서 `run-use --takeover-legacy`를 실행한다. predecessor가 successor 생성 **이전에** 자기 fence를 걸므로 두 coordinator의 mutation 구간이 시간적으로 겹치지 않는다. 남은 미결은 (1) `run-use`가 `consumer_generation`을 증가시켜 predecessor가 자신이 밀려났음을 **감지**할 fencing token이 되는지, (2) predecessor가 successor 생성 직후·인수 확인 전에 죽었을 때의 복구 주체다. 사용자는 자가증식 방식을 택했고 이 실패 구간은 (D)에서 도입될 daemon으로 나중에 덮기로 했다(DL-017).
- **OD-013** (`HANDOFF.md` 위치·schema): OD-012의 fresh/resume 자동 판별이 `HANDOFF.md`에서 `run_id`를 읽는 것을 전제하므로, schema에 Orca Run ID가 기계적으로 읽히는 필드로 포함돼야 한다는 제약이 추가됐다.
- **OD-004** (지원 버전): 이번 검증은 Claude Code `2.1.238`, Orca `1.4.187`에서 수행했다. Stop hook의 `decision: "block"`·`stop_hook_active` 의미론과 transcript `message.usage` 필드는 버전 의존 사실이므로 지원 버전 범위를 정할 때 재확인 대상이다.
- **OD-005** (설정과 주입 방식): 호스트 전제조건(§12.6)이 설정 항목으로 드러났다. skill 설치 대상, git 커밋 identity, `NVM_HOME`/`NVM_SYMLINK`는 저장소가 아니라 호스트 준비 절차로 다뤄야 한다.

```text
ID: OD-010
상태: DECIDED
결정: `/init-orchestrate`는 `~/.claude/skills/init-orchestrate/SKILL.md`에 user-level skill로 배치한다.
      skill 본문에는 repository 무관하게 불변인 운영 계약만 담고, repository별 계약은 대상 repository의
      authoritative spec을 읽으라는 지시로 위임한다(`orchestration` skill의 discovery stub 패턴).
      `/orchestration`의 선행 입력을 필수 전제로 삼지 않는다. 필요한 Orca 사용법은
      `orca skills get orchestration --full`로 직접 조회한다.
근거:
  - 프로브 실측 결과 Claude Code가 discovery하는 user-level skill home은 `~/.claude/skills/`뿐이고
    `~/.agents/skills/`는 읽지 않는다(§12.1).
  - coordinator는 임의의 대상 repository에서 실행되므로 repo-local 설치는 repository마다 반복이 필요하다.
  - 실측 과정에서 `orchestration` skill이 이 호스트의 Claude Code 세션에 로드된 적이 없음이 드러났다.
    부팅 계약이 다른 skill의 선행 로드에 의존하면 같은 무증상 실패가 반복된다.
  - `orchestration` skill 자체가 stub + 런타임 조회 패턴을 쓰므로 버전 의존 계약을 파일에 고정하지 않는다.
대안과 기각 이유:
  - `~/.agents/skills/` 배치: 여러 에이전트가 공유하는 디렉터리지만 Claude Code가 읽지 않는다. 실측으로 기각.
  - repo-local `.claude/skills/`: 대상 repository마다 설치가 필요해 A의 목표와 충돌. 기각.
  - plugin marketplace 패키징: 배포 경로가 늘고 preview 제약이 있다. 단일 개인 호스트에는 이점이 없어 보류.
영향 문서/파일: specs/orchestration-bootstrap-and-continuity.md §3, 향후 ~/.claude/skills/init-orchestrate/SKILL.md
검증 방법: 두 skill home에 프로브 skill을 심고 헤드리스 세션에서 목록 조회(2026-08-22).
          `~/.claude/skills/init-orchestrate/` 배치 후 새 세션 목록에서 발견됨을 확인(2026-08-22).
          실제 부팅 동작은 첫 Run에서 검증한다.
결정일: 2026-08-22
```

```text
ID: OD-012
상태: DECIDED
결정: fresh/resume는 자동 판별한다. `HANDOFF.md`가 존재하고 그 안에 기록된 `run_id`가
      `orca orchestration run-list`에 살아 있으면 Resume, 아니면 Fresh다.
      `--fresh` / `--resume <run_id>` 명시 override를 두고, 판별 결과는 mutation 전에 사용자에게 제시한다.
근거:
  - 사용자 진입점이 Fresh와 Resume에서 동일한 한 줄이어야 B가 해결된 것으로 본다(스펙 §6).
  - 두 신호 모두 live source(파일 시스템과 Orca)에서 읽으므로 세션 기억에 의존하지 않는다.
  - `HANDOFF.md` 존재만으로 판별하면 이미 종료된 Run의 잔재가 잘못된 Resume을 유발한다.
대안과 기각 이유:
  - 명시 옵션 필수: 사용자가 매번 Run 상태를 기억해야 하므로 A의 목표와 충돌. 기각.
  - `run-current` 바인딩으로 판별: 바인딩되지 않은 새 터미널에서 `run_required`를 반환한다(§7.2). 단독 신호로 부적합.
영향 문서/파일: specs/orchestration-bootstrap-and-continuity.md §3.2/§3.3, OD-013(schema에 run_id 요구)
검증 방법: 미실행. 배치 후 Fresh·Resume 두 경로를 실제 Run으로 검증한다.
결정일: 2026-08-22
```

```text
ID: OD-014
상태: DECIDED
결정: 열화 감지 주체는 Claude Code Stop hook이다. 신호는 transcript의 마지막 assistant 레코드
      `message.usage`의 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`다.
      임계 정책은 점유율(%)이 아니라 **남은 여유 토큰 절대값**으로 표현한다.
      창 크기는 transcript로 판정할 수 없으므로 coordinator가 부팅 시 Run 마커에 기록하고
      monitor는 그 값을 읽는다. 마커에 창 크기가 없으면 발동하지 않는다(fail-safe).
      초기 임계값은 미검증 값으로 두고 1차 실제 rollover 관측에서 재보정한다.
근거:
  - `message.usage` 필드가 transcript에 실재하고 hook이 `transcript_path`를 받는 것을 실측했다(§3.6).
  - 같은 레코드의 `model`은 창 크기를 알려주지 않는다. 1M 창 세션의 transcript에도
    `claude-opus-5`만 기록되고 변형 표기가 없다. 창 크기를 아는 주체는 세션 자신뿐이다.
  - Stop hook의 `{"decision":"block","reason":...}` 주입이 실제로 동작하고 `stop_hook_active`가
    무한 루프를 막는 것을 실측했다(§3.6). 턴 종료는 무인 coordinator의 자연스러운 안전 checkpoint다.
  - rollover 절차 자체(handoff 확정·successor 생성·인수 확인)는 거의 고정 비용이므로,
    창 크기가 달라져도 필요한 여유분은 비슷하다. 따라서 비율이 아니라 절대값이 맞다.
  - fail-safe를 "발동하지 않음"으로 두는 이유: 잘못된 rollover는 진행 중 작업을 끊지만,
    발동하지 않으면 최악의 경우 기존 수동 절차로 되돌아갈 뿐이다.
대안과 기각 이유:
  - PreCompact hook: 컨텍스트가 이미 찬 뒤라 늦고, 압축 자체가 열화다. 가장 못 믿을 상태의 coordinator에게
    handoff 작성을 맡기게 되므로 기각.
  - 모델의 자기 판단: 토큰 점유에 대한 자기 관측이 부정확하고, 하필 열화 시점에 가장 신뢰도가 낮다.
    보조 신호로만 둔다.
영향 문서/파일: specs/orchestration-bootstrap-and-continuity.md §8, 향후 rollover-monitor hook과 ~/.claude/settings.json
검증 방법: 격리 프로젝트에서 Stop hook block/reason 왕복과 usage 필드 존재를 실측(2026-08-22).
          transcript의 model 계열 키 전수 조회로 창 크기 판정 불가를 확인(2026-08-22).
          throwaway Run `run_ebd0bb4592d2`에서 감지→주입→자율 승계→인수 전 구간을 완주(2026-08-22).
          coordinator가 사람 지시 없이 successor를 만들고 물러났고 generation이 3 → 4로 올랐다.
          monitor가 마커에 남긴 `rollover` 기록(`last_remaining_tokens: 924950`)이 발동 주체의
          증거가 되어, successor가 "누가 주입했는가"를 스스로 판정할 수 있었다.
          두 세션의 transcript에서 실제 비용을 측정했다(1M 창, 작업 없는 Run, 관측치 1건).
              부팅 완료      50,480   (skill 로드 + 스펙 읽기)
              발동 시점      76,627
              종료 시점      95,155
              롤오버 절차    18,528 (46턴)
          auto-compact 임계값은 측정하지 못했다. 이 호스트의 31개 transcript·1,879턴에
          압축 이력이 0건이고 관측된 최대 점유량은 571,283이다.
          다만 발동 이후 coordinator는 새 작업을 받지 않아 컨텍스트 증가가 절차 비용으로
          묶이므로, reserve가 절차 비용보다 충분히 크면 압축 임계값을 몰라도 창 끝에 닿지 않는다.
결정일: 2026-08-22
후속: 초기 임계값 확정과 재보정은 첫 실제 rollover 관측에서 수행한다.
```

```text
ID: OD-015
상태: DECIDED
결정: successor 세션은 predecessor가 Orca terminal 표면으로 만든다.
      생성 `terminal create --worktree current --command "claude"` →
      부팅 `terminal send --terminal <handle> --text <부팅 프롬프트> --enter` →
      대기 `terminal wait --for tui-idle --timeout-ms <n>` →
      ACK  `terminal read --terminal <handle> --screen`.
근거:
  - `coordinator-start` 은퇴는 기능 제거가 아니라 표면 이동이었다. `terminal create`의 스키마 note가
    "Use this, not `worktree create`, for a fresh agent in the current checkout"라고 명시한다(§12.5).
  - `run-use --takeover-legacy`가 "live coordinator agent terminal에서 실행"을 요구하는데,
    이 경로로 만든 터미널이 정확히 그 조건을 만족한다.
  - ACK 확인에 `--screen`이 필요하다. 기본 읽기는 escape sequence가 제거된 누적 스트림이라
    TUI 화면 판정에 부적합하다는 note가 있다.
대안과 기각 이유:
  - `worktree create`: 현재 checkout에 fresh agent를 띄우는 용도가 아니라고 note가 명시. 기각.
  - `orchestration send`/`inbox`: durable inbox이지 세션 생성 수단이 아니다. 기각.
  - 외부 프로세스로 `claude` 직접 spawn: Orca가 관리하지 않는 터미널이므로 `takeover-legacy`의
    "live coordinator agent terminal" 전제를 만족한다는 증거가 없다. 기각.
영향 문서/파일: specs/orchestration-bootstrap-and-continuity.md §6, OD-016(권한 이관 절차)
검증 방법: throwaway Run `run_ebd0bb4592d2`에서 생성→준비 확인→주입→제출 확인→인수까지
          실제로 완주(2026-08-22). `--worktree current` 셀렉터가 유효함을 확인했다.
          제출 확인이 셸 경로 변환으로 `/init-orchestrate`가 치환된 것을 잡아냈다.
결정일: 2026-08-22
후속: fencing 판정은 OD-016에서 닫았다.
```

```text
ID: OD-011
상태: DECIDED
결정: `/init-orchestrate`는 repository별 문서 구조를 알지 못한다. 대상 repository의
      **권위 선언 문서**(충돌 시 무엇이 우선하는지 스스로 밝힌 문서)를 찾아 그 선언을 그대로 따른다.
      흔한 위치는 `docs/README.md`, `AGENTS.md`, `CONTRIBUTING.md`다.
      권위 선언이 없으면 스펙을 추측해 고르지 않고 후보 목록을 제시해 사용자에게 묻는다.
      적용한 스펙 경로와 작업 규약은 부팅 시 사용자에게 명시한다.
근거:
  - OD-010이 skill 본문에 repository 무관한 계약만 담기로 했으므로 발견 규칙도 특정 구조에 의존할 수 없다.
  - 이 repository는 이미 `docs/README.md`의 문서 권위 절로 우선순위를 선언한다.
    규칙이 그 선언을 읽게 하면 문서 구조가 바뀌어도 skill을 고칠 필요가 없다.
  - 선언이 없는 repository에서 skill이 스펙을 고르면 그것이 곧 근거 없는 추측이며 작업 규약 위반이다.
  - 부팅 시 적용 문서를 명시하면 이후 모든 판단의 근거를 사용자가 검증할 수 있다.
대안과 기각 이유:
  - 고정 경로 규약(`docs/specs/**` 등) 강제: repository마다 구조가 달라 유지 비용이 skill로 넘어온다. 기각.
  - 파일명 휴리스틱으로 스펙 추정: 근거 없는 추측이며 조용히 틀린다. 기각.
  - 매번 사용자에게 질의: 선언이 있는 repository에서 불필요한 왕복이다. 선언 부재 시 fallback으로만 둔다.
영향 문서/파일: skills/init-orchestrate/SKILL.md §2, specs/orchestration-bootstrap-and-continuity.md §3.1
검증 방법: skill 배치 후 새 세션 목록에서 발견 확인(2026-08-22).
          실제 발견 규칙의 동작은 첫 Run에서 검증한다.
결정일: 2026-08-22
```

```text
ID: OD-017
상태: DECIDED
결정: `sol high fast`는 model `gpt-5.6-sol` + reasoning effort `high` + service tier `priority`(표시명 Fast)의 세 축 조합이다.
      supervised worker 배치는 worker-start --agent codex --model gpt-5.6-sol --effort high 로 표현한다.
근거:
  - `~/.codex/config.toml`의 `model = "gpt-5.6-sol"`이 `sol`의 실제 slug다.
  - codex-cli 0.149.0의 models_cache.json이 모델별 `supported_reasoning_levels`와 `service_tiers`를 정의한다.
  - `gpt-5.6-sol`의 service_tiers는 `{"id":"priority","name":"Fast"}` 하나이고 additional_speed_tiers는 `["fast"]`다.
영향 문서/파일: specs/orchestration-bootstrap-and-continuity.md §4.2, platform-capabilities.md §12
검증 방법: codex 설정과 models_cache 직접 조회(2026-08-22). 실제 dispatch 시 receipt의 launch.effective로 재확인한다.
결정일: 2026-08-22
후속: service tier는 worker-start로 표현할 수 없다. OD-074에서 다룬다.
```

```text
ID: OD-024
상태: DECIDED
결정: GitHub 사실 조회는 `gh` CLI를 `--json`으로 호출한다. REST API와 토큰 직접 관리는 쓰지 않는다.
근거:
  - `gh`가 이미 인증돼 있고(scopes repo/workflow/read:org/gist) 자격증명이 Windows Credential Manager에 있다.
  - 저장소가 public이므로 토큰을 저장소나 설정 파일에 두지 않는 편이 DL-015의 전제와 맞는다.
  - `--json`이 필요한 필드만 선택해 반환하므로 응답 파싱이 좁아진다.
대안과 기각 이유:
  - REST + 토큰: 프로세스 spawn이 없어 빠르고 rate limit 제어가 쉬우나 토큰 주입·보관 경로(OD-005)를 먼저 닫아야 한다. 필요해지면 어댑터 경계에서 교체한다.
영향 문서/파일: apps/orca-slack-bridge의 github 어댑터
검증 방법: S0 live snapshot 실행으로 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-026
상태: DECIDED
결정: Repository의 canonical key는 GitHub의 숫자 databaseId다. `owner/name`은 표시용이며 key로 쓰지 않는다.
      취득 경로는 `gh api repos/<owner>/<repo>`의 `.id`다. `gh repo view --json id`는 GraphQL node ID
      문자열을 주므로 쓰지 않는다.
근거:
  - repository rename과 owner 이전에도 숫자 id는 유지되므로 같은 repository를 같은 entity로 인식한다는 S0 출구 조건을 만족한다.
  - fork는 별도 id를 가지므로 자동으로 구분된다.
대안과 기각 이유:
  - `owner/name` 문자열 key: rename 시 같은 repository가 새 entity로 갈라진다. 기각.
  - Git remote URL: 여러 remote와 SSH/HTTPS 표기 차이로 정규화 부담이 크다. remote는 로컬 worktree에서 repository를 **찾는** 입력으로만 쓰고 key로 쓰지 않는다.
영향 문서/파일: contracts/observation-and-correlation.md §1, identity 모듈
검증 방법: fixture 테스트에서 rename 전후 동일 id가 동일 entity로 축약되는지 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-027
상태: DECIDED (배치와 주체만. cardinality 세부는 S0 구현 중 확정)
결정: Project↔Repository mapping은 저장소 밖 설정 파일에 둔다. 저장소에는 예시 파일만 커밋한다.
근거:
  - 저장소가 public이므로 Slack workspace/channel/owner ID와 project mapping을 저장소 파일로 두지 않는다(DL-015).
  - 수동 등록이 D1 범위이고 자동 발견은 O1이므로, 설정 파일이 두 단계를 모두 수용한다.
대안과 기각 이유:
  - 저장소 내 파일 + secret만 분리: mapping 자체는 민감하지 않으나 channel/owner ID와 한 파일에 모이게 되어 경계가 흐려진다.
  - Git remote에서 자동 파생: 사람이 보는 Project 이름을 표현할 수 없다. O1의 자동 발견 입력으로는 유효하다.
영향 문서/파일: apps/orca-slack-bridge의 project 모듈, config 예시 파일
검증 방법: S0 snapshot이 설정에 없는 repository를 `repo_unmapped`로 보고하는지 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-016
상태: DECIDED
결정: 승계는 predecessor의 자기 fence가 successor 생성보다 먼저 일어나는 순서로 보장한다.
      successor는 자기 terminal에서 `orca orchestration run-use --id <run_id>`를 실행해 인수한다.
      `--takeover-legacy`는 플랫폼이 자동 채택한 legacy Run 전용이며 일반 Run에는 거부된다.
      인수 여부의 판정 근거는 Run row의 `consumer_generation`이다. 값이 올라가면 이전 coordinator는
      밀려난 것이다.
근거:
  - throwaway Run `run_ebd0bb4592d2`로 실제 승계를 완주하며 관측했다(2026-08-22).
      coordinator_handle   term_ea1ab528... → term_e9b76901...
      coordinator_pane_key d6bf920b:579f6115 → 4b2cc0a8:bcb81716
      consumer_generation  1 → 2
  - `--takeover-legacy`는 같은 Run에서 거부됐다.
      `{"ok":false,"error":{"code":"invalid_argument",
        "message":"Legacy takeover is only available for the automatically adopted Run."}}`
    successor가 "bash 서브셸이 terminal identity를 못 가진다"는 가설을 먼저 세웠다가
    환경에 `ORCA_TERMINAL_HANDLE`·`ORCA_PANE_KEY`가 정상 존재함을 확인해 반증했고,
    실제 원인이 Run의 `legacy: 0`임을 밝혔다.
  - 시간적 배제로 single-writer를 보장한다. predecessor가 successor를 만들기 전에 스스로
    신규 dispatch·merge를 멈추므로 두 coordinator의 mutation 구간이 겹치지 않는다.
대안과 기각 이유:
  - 잠금 파일이나 별도 lease: Orca가 이미 generation으로 소유권을 표현하므로 두 번째 진실이 생긴다. 기각.
  - predecessor가 successor 인수를 기다렸다가 종료: 인수 확인까지 살아 있어야 하므로 열화가
    더 진행된다. 자기 fence가 먼저이면 기다릴 이유가 없다.
영향 문서/파일: skills/init-orchestrate/SKILL.md §5·§11, specs/orchestration-bootstrap-and-continuity.md §6.2
검증 방법: 위 실측(2026-08-22). predecessor가 generation 변화를 실제로 감지해 행동을 바꾸는
          경로는 미구현이며 미검증이다.
결정일: 2026-08-22
후속: predecessor가 successor 생성과 인수 확인 사이에 죽는 구간은 DL-017대로 (D)의 daemon이 덮는다.
```

```text
ID: OD-013
상태: DECIDED
결정: orchestration handoff는 `handoff` 스킬의 템플릿과 증거 규율을 상속하고 orchestration
      필수 필드를 더한 것이다. 별도 형식을 새로 정의하지 않는다.

      위치: 대상 repository의 계약을 따르고, 없으면 repository 루트 `HANDOFF.md`.
      커밋하지 않는다(`.gitignore`). 세션 로컬 운영 상태이며 successor는 같은 호스트에서 돈다.

      상속하는 절: 목표(검증 가능한 완료 기준 포함) / 현재 상태 / 변경 사항 /
      검증(`통과`·`실패`·`보고됨(미검증)`·`미실행` 4분류, 명령과 핵심 결과 동반) /
      결정과 근거 / 남은 위험(`[확인 필요]`·`[추론]` 표기) / 다음 작업(첫 작업은 완료 기준 동반).

      추가하는 orchestration 필수 필드:
      - `run_id` (기계적으로 읽히는 형태). OD-012의 fresh/resume 판별이 이 값에 의존한다.
      - repository 경로, predecessor session id, rollover 사유
      - Task DAG 상태와 의존, worker/dispatch 상태, worktree·branch·PR·review·CI 상태
      - open Gate와 사용자 응답 대기 사항, 독립적으로 계속할 수 있는 Task
      - 진행 중이던 외부 효과 또는 비멱등 작업

      archive: 승계마다 덮어쓴다. 이전 handoff를 보존하지 않으며 Run 종료 시 삭제한다.
      atomic write: 임시 파일에 쓰고 rename한다.
근거:
  - `handoff` 스킬은 `disable-model-invocation: true`라 coordinator가 호출할 수 없고,
    allowed-tools가 읽기 전용이며 경로를 받지 않으면 파일을 만들지 않는다. 무인 롤오버 경로에서
    실행할 수 없으므로 호출이 아니라 규칙 상속으로 재사용한다.
  - 그 템플릿에는 `run_id`가 없다. 그대로 쓰면 fresh/resume 판별이 끊긴다.
  - 4분류 검증 표기와 `[확인 필요]`/`[추론]`은 작업 규약의 "실행하지 않았으면 그렇게 적는다"를
    문서 형식으로 구현한 것이다. 두 경로가 같은 규율을 쓰면 사람이 만든 handoff와 coordinator가
    만든 handoff를 같은 기준으로 읽을 수 있다.
  - "관련 없는 기존 워킹트리 변경을 이번 세션 작업으로 귀속하지 않는다"는 이 저장소처럼 여러
    세션이 동시에 같은 워킹트리를 만지는 환경에서 오귀속을 막는다.
  - 커밋하지 않는 이유: successor가 같은 호스트에서 돌므로 로컬 파일로 충분하고, public
    저장소에 세션 운영 상태를 남길 이유가 없으며, 동시 세션이 서로의 handoff를 커밋하는 충돌이 생긴다.
  - atomic write가 필요한 이유: 승계 도중 predecessor가 죽으면 반쯤 쓰인 handoff가 남고
    successor가 그것을 완전한 상태로 신뢰한다.
대안과 기각 이유:
  - 롤오버 경로에서 `/handoff` 호출: 모델이 호출할 수 없고 파일도 쓰지 않는다. 불가능해서 기각.
  - 독자 형식 신규 정의: 같은 목적의 형식이 둘이 되어 갈라진다. 기각.
  - handoff를 커밋: 이력이 남지만 동시 세션 충돌과 public 저장소 오염이 크다. 기각.
영향 문서/파일: skills/init-orchestrate/SKILL.md §10, .gitignore
검증 방법: `handoff` 스킬의 frontmatter와 template.md를 직접 읽어 상속 가능 범위와 결손 필드를
          확인(2026-08-22). 실제 Run에서 이 형식으로 승계가 성립하는지는 다음 실 Run에서 검증한다.
결정일: 2026-08-22
```

```text
ID: OD-021
상태: DECIDED
결정: PR body 맨 끝의 HTML comment 블록으로 correlation ID를 싣는다.
      <!-- orca-run: <run_id> -->      필수
      <!-- orca-task: <task_id> -->    필수
      <!-- orca-dispatch: <id> -->     선택
      작성 주체는 worker다. cardinality는 task 1 : PR N이다.
근거:
  - 화면에 거의 영향을 주지 않으면서 기계적으로 읽히는 형식이라는 방향이 확정돼 있었다.
  - Orca가 dispatch preamble로 task/dispatch id를 worker에 주입하므로 worker가 자기 값을 안다.
  - body 맨 끝에 두면 사람이 읽는 내용을 밀어내지 않는다.
  - 값 이름은 S0 구현의 기본값과 일치하며 설정으로 override할 수 있다.
대안과 기각 이유:
  - coordinator가 PR body를 사후 수정: worker가 PR을 만드는 시점과 어긋나 창이 생긴다. 기각.
  - branch 이름 규약: 계약이 "branch 이름으로 조용히 확정하지 않는다"를 금지한다. 기각.
영향 문서/파일: contracts/observation-and-correlation.md §2, apps/orca-slack-bridge/src/correlate
검증 방법: 첫 Run의 PR에서 snapshot이 correlated로 보고하는지 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-022
상태: DECIDED
결정: metadata가 없으면 `uncorrelated(no_metadata)`, run만 없으면 `run_missing`,
      가리키는 Run이 없으면 `run_not_found`, 값이 모순되거나 task가 다른 Run에 속하면 `conflict`로 보고한다.
      어느 경우에도 branch 이름·PR 제목으로 추측해 확정하지 않으며, 자동으로 한쪽을 덮지 않는다.
근거: 관찰·상관관계 계약이 추측 확정을 금지한다. uncorrelated는 실패가 아니라 정상 출력이다.
영향 문서/파일: apps/orca-slack-bridge/src/correlate/resolve.ts
검증 방법: S0 테스트 13건과 live snapshot에서 확인했다(2026-08-22).
결정일: 2026-08-22
```

```text
ID: OD-029
상태: DECIDED
결정: worker는 PR을 만든 뒤에 `worker_done`을 보낸다. PR identity는 `worker_done`에 싣지 않는다.
      PR과 Orca의 유일한 연결점은 PR body의 correlation metadata(OD-021)다.
근거:
  - `worker_done`은 완료 신호인데 PR이 없으면 coordinator가 리뷰를 걸 수 없다.
  - 연결 방향이 PR → task이므로 task 쪽에 PR을 실을 필요가 없다.
  - orchestration 가이드가 worker 명령에서 raw `--payload` JSON을 피하라고 경고한다.
    PowerShell이 JSON 따옴표를 쉽게 깨뜨리기 때문이다.
대안과 기각 이유:
  - `--payload`에 PR URL 포함: 위 quoting 위험이 있고 연결에 불필요하다. 기각.
  - `worker_done` 먼저, PR 나중: 완료 보고와 리뷰 대상 사이에 창이 생긴다. 기각.
영향 문서/파일: specs/orchestration-bootstrap-and-continuity.md §5, contracts/observation-and-correlation.md §3
검증 방법: 첫 Run에서 PR 생성 시각이 worker_done보다 앞서는지 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-073
상태: DECIDED
결정: reviewer는 판정하고 자기 `worker_done` 본문에 다음 `reviewer_result` JSON을 싣는다.
      {
        "kind": "reviewer_result", "schemaVersion": 1,
        "verdict": "approve" | "request_changes",
        "pr": { "repo": "<owner/name>", "number": <n> },
        "reviewedHeadSha": "<sha>",
        "findings": [{ "severity": "blocker"|"major"|"minor", "file": "<path>", "line": <n>, "summary": "<text>" }],
        "gates": { "<name>": "pass"|"fail" }
      }
      reviewer Dispatch가 settle된 뒤 coordinator가
      `orca orchestration task-update --id <review_task> --status completed --result <json>`으로 기록한다.
      Dispatch가 살아 있을 때 기록하면 `task_not_startable`이므로 이 순서를 바꾸지 않는다.
      verdict가 request_changes여도 review task 자체는 completed다. 리뷰라는 작업은 끝났기 때문이다.
근거:
  - reviewer terminal은 Run에 바인딩되지 않아 직접 `task-update`할 권한이 없다.
  - reviewer의 세 시도가 다음처럼 거부됐다. 이 거부가 coordinator single-writer를 보존하는 올바른 동작이다.
    - `task-update --id <task> --status completed --result <json>` → `run_required`
    - 위 명령 + `--run <run> --from <coordinator_handle>` → `consumer_fenced`
    - 위 명령 + `--from <worker_handle>` → `consumer_fenced`
  - worker가 `run-use`를 실행하면 Run의 coordinator 소유권을 가져가 기존 coordinator를 fence하므로 절대 실행하지 않는다.
  - Windows에서 중첩 객체·배열·한글·백틱을 포함한 `reviewer_result`를 coordinator가 기록하고
    `task-list --json`으로 읽어 무손실 왕복을 확인했다.
  - GitHub `reviewDecision`이 모든 대상 repository에서 null이므로 Orca가 유일한 durable source다(DL-016).
  - severity taxonomy는 `vertical-live` reviewer가 이미 쓰는 값을 그대로 쓴다.
  - `reviewedHeadSha`는 현재 head와 같은지를 드러내는 사실이다. OD-031은 이 사실만 표시하고 이전
    approval의 유효·무효를 Bridge가 판정하지 않는 것으로 확정됐다.
영향 문서/파일: contracts/observation-and-correlation.md §6, specs/orchestration-bootstrap-and-continuity.md §4
검증 방법: 실제 reviewer terminal의 권한 거부 3건과 coordinator 기록, task-list JSON 왕복을 확인했다(2026-08-23).
결정일: 2026-08-23
```

```text
ID: OD-005
상태: DECIDED
결정: 설정은 저장소 밖 JSON 파일, secret은 앱 이름을 접두로 붙인 환경변수로 주입한다.
      설정 파일: %APPDATA%\orca-slack-bridge\config.json (ORCA_SLACK_BRIDGE_CONFIG 또는 --config로 override)
      secret: ORCA_SLACK_BRIDGE_BOT_TOKEN, ORCA_SLACK_BRIDGE_APP_TOKEN
근거:
  - 저장소가 public이므로 secret과 workspace/channel/owner ID를 저장소에 두지 않는다(DL-015).
  - `SLACK_BOT_TOKEN`·`SLACK_APP_TOKEN`은 Bolt for JavaScript의 관례 이름이다. 사용자 환경변수는
    같은 사용자의 모든 프로세스가 상속하므로, 관례 이름을 쓰면 나중에 만든 다른 Slack 앱이
    이 Bridge의 토큰을 조용히 집어간다. 이름 충돌이 아니라 잘못된 토큰이 소리 없이 쓰이는 사고다.
  - 설정 파서가 값 어디에서든 `xoxb-`/`xapp-` 문자열을 발견하면 거부해, secret을 설정 파일에
    붙여넣는 사고를 막는다.
대안과 기각 이유:
  - 관례 이름 사용: 위 사고 때문에 기각. Bridge는 관례 이름을 읽지 않고, 설정돼 있으면 옮기라고 안내한다.
  - 관례 이름을 fallback으로 허용: 같은 사고를 그대로 남긴다. 기각.
  - Windows Credential Manager: 격리는 낫지만 단일 사용자 머신에서 agent도 같은 사용자로 실행되므로
    실질적 격리 이득이 작고 코드가 늘어난다. 필요해지면 재검토한다.
영향 문서/파일: docs/ops/slack-app-setup.md, apps/orca-slack-bridge/src/project/config.ts, src/slack/verify.ts
검증 방법: verify-slack이 관례 이름만 설정된 경우를 실패로 보고하는지 테스트로 확인했다(2026-08-22).
결정일: 2026-08-22
```

```text
ID: OD-034
상태: DECIDED
결정: summarizer는 OpenAI API만 사용한다. 기본 모델은 `gpt-5.6-luna`이며 설정으로 교체할 수 있다.
      구조화 출력은 `response_format`의 JSON Schema strict 모드로 강제한다. 출력 언어는 한국어다.
      provider는 인터페이스 뒤에 두어 교체 비용을 낮춘다.
근거:
  - 실측 가격: luna $0.20/$1.20 per MTok. 린 프롬프트 기준 호출당 약 $0.0016,
    월 30 PR × 5회 = 150 호출에 약 $0.24다.
  - `codex exec` CLI 경로는 추가 과금이 없지만 호출당 16,245 input 토큰의 에이전트 스캐폴딩을
    싣고(실측) Codex 구독 할당량을 PR 리뷰어와 공유한다. Bridge가 할당량을 소모하면
    리뷰어가 throttle되어 orchestration이 멈춘다. 월 몇 센트보다 비싼 대가다.
  - API 경로는 스캐폴딩이 없어 호출당 토큰이 약 30배 줄고 할당량 경합이 없다.
대안과 기각 이유:
  - `codex exec -m gpt-5.6-luna --output-schema`: 동작을 실측으로 확인했으나(8초, 유효 JSON)
    위 할당량 경합과 스캐폴딩 때문에 기각.
  - Anthropic API(haiku/opus): 동작하지만 luna 대비 5~25배 비싸고 이점이 없다. 기각.
영향 문서/파일: apps/orca-slack-bridge/src/summarize
검증 방법: 실제 OpenAI API로 호출해 확인했다(2026-08-22).
  - review 사실 없음 → reviewGist null, risk null. 3.0초
  - review 사실 있음(blocker 1건) → reviewGist 채워짐, risk high. 2.2초
  - 사실 지문이 같으면 재호출하지 않음(0ms)
  스키마 필드 설명과 시스템 프롬프트를 넣은 뒤로는 review 입력 없이 reviewGist를 채우는
  현상이 재현되지 않았다. 검증 계층은 그래도 유지한다.
결정일: 2026-08-22
```

```text
ID: OD-037
상태: DECIDED
결정: risk는 LLM이 산정하지 않는다. reviewer-result의 `findings[].severity`를 집계해 파생한다.
      blocker ≥ 1 → 높음, major ≥ 1 → 보통, 그 외 → 낮음. reviewer-result가 없으면 risk를 표시하지 않는다.
근거:
  - OD-073으로 severity가 구조화 사실이 됐으므로 추정할 이유가 없다.
  - 스펙이 "source fact에 없는 성공·안전성·검증을 주장하지 않는다"를 요구한다.
  - LLM 출력 스키마에서 아예 제거하면 잘못된 주장이 원천적으로 불가능하다.
영향 문서/파일: src/summarize/contract.ts, renderer
결정일: 2026-08-22
```

```text
ID: OD-036
상태: DECIDED
결정: summarizer에 보내는 것은 Task 목적, `worker_done` 본문, PR title, PR body(correlation
      metadata 블록 제거 후 상한 적용), 변경 파일 **경로 목록**, reviewer-result의 findings,
      CI 결론뿐이다.
      보내지 않는 것: diff 본문, worker transcript, GitHub review 원문 전체, 환경변수·토큰·설정 값.
      상한 초과로 잘린 경우 그 사실을 결과에 남기고 조용히 자르지 않는다.
근거:
  - 스펙이 transcript를 기본 입력으로 쓰지 않는다고 규정한다.
  - 실측된 PR body가 15KB급이라 상한이 필요하다.
  - 파일 경로만 보내면 변경 범주를 전달하면서 코드 본문 유출을 피한다.
영향 문서/파일: src/summarize/contract.ts
결정일: 2026-08-22
```

```text
ID: OD-035
상태: DECIDED
결정:
  - 게이트 A(요약 호출): PR key는 cache row를 식별하고, 실제 요약 입력인 Task 목적, `worker_done`,
    PR 제목·본문, 변경 파일 경로, reviewer-result, CI 결론으로 사실 지문을 만든다. 지문이 같으면
    저장된 요약을 재사용하고 입력이 바뀔 때만 호출한다. head sha 자체는 요약 입력이 아니므로
    사실 지문에 넣지 않는다.
    schema v2가 보존하는 것은 `facts_fingerprint`와 `summary_json`뿐이다. `summary_json`에는
    `SummaryDraft`의 `title`·`what`·`why`·`reviewGist`와 파생한 `risk`·`truncated`만 들어가며,
    PR body·changed paths·worker report 같은 입력 원문은 저장하지 않는다. 요약이 실패한 관찰은
    `summary_json`을 null로 남기므로 다음 관찰에서 다시 시도한다.
  - 게이트 B(게시): 매 관찰마다 카드를 렌더하고 렌더 지문이 다를 때만 갱신한다.
    사실 지문 하나로 게시 여부까지 판정하지 않는다. `SummaryFacts`에 PR `state`가 없어서
    그렇게 하면 요약 입력은 그대로인 채 merge된 PR의 카드가 갱신되지 않음을 실행으로 확인했다.
  - 검증 실패 시: 1회 재시도한다. 재시도도 실패하면 요약 없이 사실만으로 축소 카드를 만들고
    "요약 실패"를 표시한다.
  - 어떤 실패도 Orca/GitHub 상태를 변경하지 않으며 실패를 성공처럼 숨기지 않는다.
근거:
  - 제목·본문·변경 파일·review·CI가 그대로인 채 head만 움직이면 요약 문구가 달라질 이유가 없고,
    이때 호출하는 것은 OD-035가 줄이려던 낭비다.
  - 요약 호출과 카드 게시의 입력 집합은 다르므로 두 게이트가 필요하다.
  - UX 문서가 summarizer 실패를 드러내도록 요구하고, 스펙이 실패 시 상태 불변을 요구한다.
영향 문서/파일: src/summarize/index.ts, renderer
결정일: 2026-08-22
정정일: 2026-08-23
```

```text
ID: OD-040
상태: DECIDED
결정: Slack App manifest·scope·채널 설정은 docs/ops/slack-app-setup.md를 확정 계약으로 쓴다.
근거: 2026-08-22에 verify-slack의 전 항목 통과를 기록했다.
대안과 기각 이유: 별도 계약을 병행 — manifest·scope·설정의 기준이 갈라진다. 기각.
영향 문서/파일: docs/ops/slack-app-setup.md, apps/orca-slack-bridge/src/slack/verify.ts
검증 방법: verify-slack 전 항목 통과 기록(2026-08-22).
결정일: 2026-08-22
```

```text
ID: OD-043
상태: DECIDED
결정:
  - durable store는 node:sqlite를 쓴다. 경로 우선순위는 `--state` → `ORCA_SLACK_BRIDGE_STATE` →
    platform 기본값이다. DB 절대경로는 머신마다 의미가 달라지므로 `config.json`에 두지 않는다.
  - win32 기본값은 `%APPDATA%\orca-slack-bridge\state.db`다. `APPDATA`가 없으면 던진다.
  - 비win32 base는 절대경로인 `XDG_DATA_HOME`, 없거나 상대경로면 `~/.local/share`이며 그 아래
    `orca-slack-bridge/state.db`를 쓴다. DB는 설정이 아니라 state이므로 `XDG_CONFIG_HOME`을 쓰지 않는다.
  - 절대경로 여부는 실행 호스트가 아니라 대상 platform 규칙으로 판정한다. 상대 `XDG_DATA_HOME`은
    XDG 명세대로 invalid로 보고 무시하지만, 상대 `ORCA_SLACK_BRIDGE_STATE`는 실행 cwd에 따라 서로 다른
    DB를 조용히 열 수 있으므로 던진다. 반면 `--state`는 cwd 기준 상대경로를 허용한다. 매 실행에서
    호출자가 직접 보고 넘기는 인자와 cwd가 다른 프로세스에 상속되는 환경변수는 값의 수명이 다르기 때문이다.
  - WAL과 `schema_version` 테이블을 쓰고, C1은 단일 프로세스이므로 파일 lock을 만들지 않는다.
    WAL 전환 실패와 접근 불가 store는 던진다.
  - schema migration은 `ALTER TABLE ADD COLUMN`처럼 덧붙이는 변경만 허용한다. 기존 파일을 열지 못하게
    하는 파괴적 변경은 살아 있는 카드 mapping을 잃고 루트 메시지를 중복시키므로 이 방식으로 다루지 않는다.
    현재 `SCHEMA_VERSION`은 2다.
근거:
  - DL-018에서 이 호스트의 node:sqlite 동작을 재확인했고 외부 의존성이 늘지 않는다. C1에는 daemon이 없어 동시 writer가 없다.
  - 설정 파일은 머신 간에 옮겨도 의미가 유지되는 값을 담지만 DB 절대경로는 그렇지 않다.
대안과 기각 이유:
  - 별도 DB 의존성 추가 — 조기 일반화다. 기각.
  - `XDG_CONFIG_HOME` 사용 — state와 config의 XDG 의미를 섞으므로 기각.
  - 파괴적 migration — 기존 message identity를 잃어 Slack 루트를 중복시킬 수 있으므로 기각.
영향 문서/파일: docs/specs/orca-slack-bridge.md §9, apps/orca-slack-bridge/src/store/schema.ts, src/store/sqlite.ts
검증 방법: node:sqlite 파일 DB의 WAL, schema_version, 재시작 뒤 message identity 재사용을 테스트와 실제 DB로 확인했다.
결정일: 2026-08-22
보강일: 2026-08-23
```

```text
ID: OD-023
상태: DECIDED
결정: C1에는 polling이 없다. digest 명령 1회 실행이 관찰 1회다. 주기 실행은 O1에서 정한다.
근거: DL-022의 S0 방침을 잇고, 출구 조건의 재관찰은 명령 재실행으로 충족한다.
대안과 기각 이유: C1 polling — daemon·주기·reconciliation 계약을 조기에 도입한다. 기각.
영향 문서/파일: docs/specs/orca-slack-bridge.md §5, apps/orca-slack-bridge/src/cli.ts, src/digest/digest.ts
검증 방법: T5가 digest를 두 번 명시적으로 실행해 최초 게시과 재관찰을 관측했다.
결정일: 2026-08-22
```

```text
ID: OD-025
상태: DECIDED
결정: C1은 worker-read fallback을 쓰지 않고 worker_done만 쓴다.
근거: 스펙 §5.3이 transcript를 기본 입력에서 배제하므로 redaction 경계(OD-018/064)를 열 필요가 없다.
대안과 기각 이유: worker-read fallback — transcript의 읽기 범위·redaction·외부 전송 계약을 선결해야 한다. 기각.
영향 문서/파일: docs/contracts/observation-and-correlation.md §3, apps/orca-slack-bridge/src/orca/client.ts, src/digest/project.ts
검증 방법: T3의 Orca 조회 구현과 projection 테스트가 inbox의 worker_done만 사용함을 확인했다.
결정일: 2026-08-22
```

```text
ID: OD-033
상태: DECIDED
결정: reviewer_result.findings는 severity 내림차순으로 최대 10건만 카드와 요약 입력에 쓴다.
근거: OD-073이 findings를 구조화 사실로 만들었고 CAPS.findings = 10이 이미 구현돼 있다.
대안과 기각 이유: 전체 findings 표시 — 카드와 입력의 상한이 없어져 C1의 짧은 digest 목적과 맞지 않는다. 기각.
영향 문서/파일: apps/orca-slack-bridge/src/digest/project.ts, src/summarize/contract.ts
검증 방법: project 테스트가 severity 정렬과 10건 상한을 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-070
상태: DECIDED
결정: C1에서 `worker_done`이 정말 누락됐으면 카드는 막지 않고 worker 보고 없음으로 표시한다.
      다만 inbox 반환 행 수가 요청 상한과 같아 전역 최신 N건 안에서 찾지 못한 경우는 누락이 아니라
      판정 불가이므로 던진다. 중복·불완전 payload 정책은 C2로 넘긴다.
근거: UX §6이 degraded 상태를 숨기지 말라고 요구한다.
대안과 기각 이유: worker_done이 없으면 카드 생성 중단 — 관찰된 PR 사실까지 숨긴다. 기각.
영향 문서/파일: docs/contracts/observation-and-correlation.md §3, docs/ux/slack-surfaces.md §6, apps/orca-slack-bridge/src/digest/types.ts
검증 방법: project 테스트가 worker_done 부재를 ProjectedPr에 남기고 inbox 포화는 예외로 중단하는 것을 확인한다.
결정일: 2026-08-22
보강일: 2026-08-23
```

```text
ID: OD-047
상태: DECIDED
결정: identity 표시는 [Project] owner/repo #N이고, Project 미등록이면 owner/repo #N이다.
근거: 사용자 확정.
대안과 기각 이유: Project 또는 repository 하나만 표시 — 다중 repository 공용 surface에서 식별이 부족하다. 기각.
영향 문서/파일: docs/ux/slack-surfaces.md §1, apps/orca-slack-bridge/src/digest/render.ts
검증 방법: renderer 테스트가 Project 등록·미등록의 두 표현을 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-060
상태: DECIDED
결정: 첫 외부 write는 실제 #pr-digest에 한다. 통합 테스트 경계는 대역으로 하는 멱등성 테스트와 실제 게시 1회 및 재실행 관측이다.
근거: 사용자 확정.
대안과 기각 이유: 대역만으로 종료 — 실제 Slack write 경로를 검증하지 못한다. 기각.
영향 문서/파일: docs/roadmap.md §5, apps/orca-slack-bridge/test/digest.test.ts
검증 방법: T5가 실제 게시 1회와 동일 명령 재실행을 기록했고, 대역 통합 테스트를 통과했다.
결정일: 2026-08-22
```

```text
ID: OD-061
상태: DECIDED
결정: 실제 대상 repository는 dnhynk/dev-infra이며, 대상 PR은 이 Run이 만든 correlated PR이다. 실제 channel ID·team ID·user ID는 문서에 기록하지 않는다.
근거: 사용자 확정과 public repository 제약(DL-015).
대안과 기각 이유: 실제 식별자를 문서화 — public 저장소에 비공개 운영 식별자를 남긴다. 기각.
영향 문서/파일: docs/ops/slack-app-setup.md, docs/roadmap.md §5
검증 방법: T5의 실제 게시 결과와 PR body의 correlation metadata를 확인했다.
결정일: 2026-08-22
```

```text
ID: OD-072
상태: DECIDED (C1 범위만. D1/D2 알림 정책은 계속 열려 있음)
결정: C1은 summarizer 실패 시 축소 카드와 요약 실패, 입력 상한 초과 시 잘림, worker_done 없음 시 worker 보고 없음을 표시한다.
      correlation 실패는 카드를 만들지 않으므로 Slack에 표시하지 않는다.
근거: C1은 degraded 사실을 숨기지 않는 UX §6을 따른다.
대안과 기각 이유: C1에서 owner 알림까지 정함 — D1/D2의 owner·Channel 정책을 선결한다. 기각.
영향 문서/파일: docs/ux/slack-surfaces.md §6, apps/orca-slack-bridge/src/digest/render.ts
검증 방법: renderer·project·digest 테스트가 각 C1 degraded 표현 또는 skip을 확인한다.
결정일: 2026-08-22
```

```text
ID: OD-030
상태: DECIDED
결정: terminal을 `open | closed | merged`로 두고 `draft`·`review`·`checks`·`mergePolicy`를 직교 축으로
      보존한 뒤 UI 의미 상태를 파생한다. `merged`는 `mergedAt != null`을 terminal latch로 쓴다.
근거:
  - docs/evidence/t1-github-lifecycle.md §OD-030에서 GraphQL state는 OPEN/CLOSED/MERGED였지만 draft와
    reviewDecision은 별도 축이었고, mergeable인 PR도 draft·review·required check 때문에 BLOCKED였다.
  - 같은 절에서 merged PR은 `mergedAt`이 있었고 closed-unmerged는 `mergedAt=null`이었다.
대안과 기각 이유:
  - REST state 단독: merged와 closed-unmerged를 구분하지 못해 기각.
  - GraphQL state 단독 또는 원본 축 없이 draft/review/check를 한 enum에 접기: 직교 사실과 전이를 잃어 기각.
영향 문서/파일: docs/specs/orca-slack-bridge.md §5, docs/contracts/observation-and-correlation.md §6,
                docs/architecture/orca-slack-bridge.md §6, docs/traceability.md
검증 방법: docs/evidence/t1-github-lifecycle.md §OD-030의 open/draft/review/merged/closed 표본으로 축과 latch를 대조한다.
결정일: 2026-08-23
```

```text
ID: OD-031
상태: DECIDED
결정: 사실만 표시하고 판정하지 않는다. `headMatch`를 계속 싣되 이전 approval의 유효·무효를 Bridge가
      판정하지 않는다. 새 head마다 재리뷰를 강제하지 않고, GitHub repository의 stale-review 설정을 따라가지도 않는다.
근거:
  - docs/evidence/t1-github-lifecycle.md §OD-031에서 approval commit과 현재 head가 달라도 APPROVED가 유지된
    사례와, 새 head 뒤 같은 review가 DISMISSED되어 REVIEW_REQUIRED가 된 사례가 모두 관측됐다.
  - 같은 절은 API에 별도 staleApproval fact가 없고 commit/head 불일치는 오래된 head를 봤다는 사실만 준다고 확인했다.
대안과 기각 이유:
  - head 불일치 approval을 무조건 무효화: approval이 유지된 실제 표본과 충돌해 기각.
  - repository stale-review 설정 추종: 같은 head mismatch가 APPROVED 유지와 DISMISSED로 갈렸고 기존 durable
    verdict source는 Orca이므로, repository별 GitHub 정책을 Bridge의 approval 유효성 source로 추가하지 않는다.
영향 문서/파일: docs/specs/orca-slack-bridge.md §5, docs/contracts/observation-and-correlation.md §6,
                docs/traceability.md
검증 방법: docs/evidence/t1-github-lifecycle.md §OD-031의 유지·dismiss 두 표본에서 `headMatch` 사실만 동일하게 노출되는지 확인한다.
결정일: 2026-08-23
```

```text
ID: OD-032
상태: DECIDED
결정: required check만으로 판정한다. base branch의 effective required rule과 head rollup을 조인해
      missing/pending/failing/passing을 파생한다. optional check 실패는 merge를 막지 않는다.
      merge queue·required reviews·up-to-date(strict)·conversation resolution은 C2 범위 밖이다.
근거:
  - docs/evidence/t1-github-lifecycle.md §OD-032에서 required 여부는 rollup row가 아니라 base protection에 있었고,
    미보고 required context는 rollup과 `gh pr checks --required`에 나타나지 않았다.
  - 같은 절의 독립 재현에서 optional failure가 남아도 실제 merge는 성공했고, 미보고 required가 있으면 405로 거절됐다.
대안과 기각 이유:
  - head rollup 또는 `gh pr checks --required` 단독: 미보고 required를 놓쳐 기각.
  - 모든 check success 또는 `mergeStateStatus=CLEAN` 단독: optional failure 상태의 실제 merge에 반해 기각.
  - merge queue·review·strict·conversation까지 C2 판정에 포함: 실측은 required/optional check 경계만
    독립 재현했고 이 조건들은 별도 policy/API이므로 C2 판정 근거에 포함하지 않는다.
영향 문서/파일: docs/specs/orca-slack-bridge.md §5, docs/contracts/observation-and-correlation.md §6,
                docs/architecture/orca-slack-bridge.md §6, docs/traceability.md
검증 방법: docs/evidence/t1-github-lifecycle.md §OD-032의 missing required 405와 optional failure merge 200을 재현한다.
결정일: 2026-08-23
```

```text
ID: OD-044
상태: DECIDED
결정: identity는 `(repository databaseId, PR number)`, terminal latch는 `mergedAt`, review/check scope는
      `headSha`다. merged downgrade 금지는 timestamp 비교가 아니라 terminal dominance rule로 명시한다.
      동일 head 안의 review/check는 각 resource의 timestamp와 id로 reconcile한다.
근거:
  - docs/evidence/t1-github-lifecycle.md §OD-044에서 같은 `updated_at`의 응답이 서로 다른 head를 보였고,
    mergeability와 check 변화는 PR `updated_at`을 바꾸지 않아 전역 last-write-wins가 성립하지 않았다.
  - 같은 절에서 PR id는 안정적 identity, head SHA는 version scope였으며 review/check id는 resource identity로 관측됐다.
대안과 기각 이유:
  - PR `updated_at` 단독 last-write-wins: review/check/mergeability의 엄격한 version이 아니어서 기각.
  - id 또는 SHA 문자열 순서 사용: identity일 뿐 시간 순서를 표현하지 않아 기각.
  - 전체 상태 선형 rank: closed PR의 reopen을 막아 기각.
영향 문서/파일: docs/specs/orca-slack-bridge.md §9, docs/contracts/observation-and-correlation.md §8,
                docs/architecture/orca-slack-bridge.md §6, docs/traceability.md
검증 방법: docs/evidence/t1-github-lifecycle.md §OD-044의 stale head, 동일 resource 진행→완료, merged 재조회 표본으로 규칙을 대조한다.
결정일: 2026-08-23
```

```text
ID: OD-046
상태: DECIDED
결정: current 카드만 재생성한다. GitHub current snapshot + Orca facts + Bridge store identity로 현재 상태
      카드를 다시 만들고, 과거 thread의 semantic transition 재생은 하지 않는다.
근거:
  - docs/evidence/t1-github-lifecycle.md §OD-046에서 merged PR의 current facts와 history는 조회됐지만 check는
    400일 뒤 archive되고 다시 10일 뒤 삭제되어 과거 semantic transition의 완전 재생을 보장하지 못했다.
  - docs/evidence/t4-slack-inbound.md §(d)에서 Slack 오류는 삭제·archive·channel 변경을 단독 확정하지 못하고,
    현재 App에는 history/read scope와 event subscription이 없음을 확인했다.
대안과 기각 이유:
  - GitHub history로 과거 thread 완전 재생: pagination과 retention 때문에 완전성을 보장하지 못해 기각.
  - Slack history에서 기존 메시지 탐색: 현재 scope로 불가능하고 text·bot identity로 원본을 확정할 수 없어 기각.
영향 문서/파일: docs/specs/orca-slack-bridge.md §5.4·§9, docs/architecture/orca-slack-bridge.md §6,
                docs/traceability.md
검증 방법: 저장된 Slack coordinate를 유실한 fixture에서 세 current source로 루트만 재생성하고 과거 thread가 생기지 않는지 확인한다.
결정일: 2026-08-23
```

```text
ID: OD-075
상태: DECIDED
결정: `task.result`를 권위로 쓰지 않는다. `worker_done`은
      `orca orchestration inbox --terminal "run:<run_id>" --limit <n> --json`에서 읽고,
      `reviewer_result`는 `task.result`에서 읽는다.
근거:
  - docs/evidence/t2-orca-worker-done-retrieval.md §(a)에서 `task-update --result`가 worker_report 10개 필드를
    전부 덮어썼고 실제 Run 38개 Task 중 15개가 reviewer_result로 대체된 상태였다.
  - 같은 문서 §(c)에서 Run mailbox 조회는 권한 없이 성공하고 소비하지 않았으며, worker_done 전부가
    `run:*` 주소로 라우팅됨을 전역 표본과 Orca send handler에서 확인했다.
대안과 기각 이유:
  - `task.result`에서 두 사실을 함께 읽기: reviewer_result 기록이 worker_report를 대체해 기각.
  - `check --run --all`: coordinator 권한이 필요하고 100행 고정 상한·cursor 부재가 있어 기각.
  - `worker-read`: 원시 transcript이고 settled+exited Dispatch에서 빈 결과여서 기각.
영향 문서/파일: docs/specs/orca-slack-bridge.md §5.2, docs/contracts/observation-and-correlation.md §3,
                docs/traceability.md
검증 방법: docs/evidence/t2-orca-worker-done-retrieval.md §(c)의 Run mailbox 조회를 반복해 body/payload와 비소비 상태를 대조한다.
결정일: 2026-08-23
```

```text
ID: OD-076
상태: DECIDED
결정: PR body는 primary/latest Task 하나만 유지하고, PR↔Task N 연관은 Bridge durable store에 별도로 저장한다.
      OD-021의 body metadata 형식과 parser 계약은 개정하지 않는다.
근거:
  - docs/evidence/t1-github-lifecycle.md §OD-076에서 current body는 한 Task만 가리켰고, 서로 다른 Task
    comment를 중복하면 현 parser가 conflict로 처리함을 확인했다.
  - 같은 절에서 commit trailer와 GraphQL body edit history는 단서를 남겼지만 authoritative correlation에
    필요한 신뢰성과 retention 계약은 없었다.
대안과 기각 이유:
  - current body의 단일 task로 전체 이력 복원: 이전 Task를 잃어 기각.
  - 여러 `orca-task` comment 누적 또는 body schema 개정: 현 parser 계약을 깨뜨리므로 기각.
  - commit trailer/body edit history를 권위로 사용: 누락·force-push·보존 불확실성 때문에 기각.
영향 문서/파일: docs/contracts/observation-and-correlation.md §2, docs/specs/orca-slack-bridge.md §9,
                docs/architecture/orca-slack-bridge.md §7, docs/traceability.md
검증 방법: 한 PR을 두 Task가 갱신하는 fixture에서 body는 latest 하나이고 store association은 둘 다 남는지 확인한다.
결정일: 2026-08-23
```

```text
ID: OD-077
상태: DECIDED
결정: `orca-run`은 있고 `orca-task`가 없는 PR은 invalid/degraded input으로 명시한다. OD-021이 task를
      필수로 이미 정했기 때문이다. 별도 `run_correlated` kind는 Run-level 제품 의미가 필요해질 때만 도입한다.
근거:
  - docs/evidence/t1-github-lifecycle.md §OD-077에서 GitHub는 run-only body를 허용했지만 실제 정상 PR 9개에는
    사례가 없었고, 현재 downstream은 Task 목적과 worker_done을 찾지 못해 `task_missing`으로 skip했다.
  - 같은 절에서 정상 경로의 partial-write window는 관측되지 않았고 실제 경로는 누락·수동 편집 같은 partial input이었다.
대안과 기각 이유:
  - 완전한 Task correlation로 취급: Task 목적과 report를 추측해야 하므로 기각.
  - branch/title/author로 Task 보완: no-guessing 계약에 반해 기각.
  - 즉시 `run_correlated` kind 도입: 현재 Task 카드 범위에 Run-level 제품 의미가 없어 기각.
영향 문서/파일: docs/contracts/observation-and-correlation.md §2, docs/specs/orca-slack-bridge.md §5.4,
                docs/traceability.md
검증 방법: run-only fixture가 invalid/degraded로 명시되고 Task 카드를 만들지 않으며 추측 보완하지 않는지 확인한다.
결정일: 2026-08-23
```
