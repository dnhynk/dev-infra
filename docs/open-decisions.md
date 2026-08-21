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
| OD-005 | 설정 파일 형식과 secret 주입 방식 | 실제 통합 전 | OPEN |

## Bootstrap & Continuity

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-010 | `/init-orchestrate` 패키징과 `/orchestration` 호출 계약 | AB 구현 전 | DECIDED |
| OD-011 | authoritative spec 발견·우선순위 규칙 | AB 구현 전 | DECIDED |
| OD-012 | fresh/resume 자동 판별 또는 명시 옵션 | AB 구현 전 | DECIDED |
| OD-013 | `HANDOFF.md` 위치·schema·archive·atomic write | AB-1 전 | OPEN |
| OD-014 | context 열화 신호와 threshold | AB-2 전 | DECIDED |
| OD-015 | successor 세션 생성·부팅·ACK 공식 수단 | AB-2 전 | DECIDED |
| OD-016 | coordinator single-writer와 권한 이관 | AB-2 전 | OPEN |
| OD-017 | `sol high fast`의 실제 model/effort/tier mapping | reviewer dispatch 전 | OPEN |
| OD-018 | handoff redaction과 transcript 포함 범위 | AB-1 전 | OPEN |
| OD-019 | worker ask/escalation↔coordinator reply↔사람용 Gate correlation | AB-1/D1 전 | OPEN |

## Orca·GitHub 관찰과 correlation

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-020 | Run↔repo cardinality와 Run↔worktree↔coordinator session identity | S0 전 | OPEN |
| OD-021 | PR HTML metadata 최종 형식과 작성 주체 | AB-1/S0 전 | OPEN |
| OD-022 | metadata 누락·불일치·변조 정책 | S0 전 | OPEN |
| OD-023 | Orca polling/event/reconciliation 방식과 주기 | S0 전 | OPEN |
| OD-024 | GitHub API와 `gh` adapter, 인증, 갱신 방식 | S0 전 | OPEN |
| OD-025 | `worker-read` fallback 조건과 최대 범위 | C1 전 | OPEN |
| OD-026 | repository canonicalization, rename/fork/multiple remote | S0 전 | OPEN |
| OD-027 | Project↔Repository cardinality, 등록 주체, 설정/DB mapping과 routing | S0 전 | OPEN |
| OD-028 | reviewer verdict를 GitHub formal review와 Orca 중 어디에 durable하게 남길지 | C1/C2 전 | DECIDED |
| OD-029 | PR 생성과 `worker_done` 전송의 ordering 및 PR identity 포함 방식 | AB-1/S0 전 | OPEN |
| OD-069 | Run 진행률 분모와 dynamic/cancelled/failed/retried Task·multiple Dispatch 집계 | D1 전 | OPEN |
| OD-070 | `worker_done` 누락·중복·불완전 payload의 상태와 recovery | S0/C1 전 | OPEN |
| OD-073 | Orca reviewer-result의 필드·enum·작성 주체와 task status 전이 규칙 | AB-1/C1 전 | OPEN |

## PR state와 요약

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-030 | canonical PR state와 transition | C2 전 | OPEN |
| OD-031 | review verdict 축약과 새 commit 후 approval | C2 전 | OPEN |
| OD-032 | required/optional check와 merge-ready 정책 | C2 전 | OPEN |
| OD-033 | review 핵심 comment 선택 규칙 | C1/C2 전 | OPEN |
| OD-034 | summarizer provider/model/schema/language | C1 전 | OPEN |
| OD-035 | summarizer 실패 fallback, cache, 호출 상한 | C1 전 | OPEN |
| OD-036 | code/review/transcript의 LLM·Slack 전송 경계 | C1 전 | OPEN |
| OD-037 | risk 산정 근거와 표시 조건 | C1 전 | OPEN |

## Slack과 durable store

| ID | 결정 | 필요한 시점 | 상태 |
|---|---|---|---|
| OD-040 | Slack App manifest, scopes, 채널 ID 설정 | C1/D2 전 | OPEN |
| OD-041 | Socket Mode 최종 채택과 reconnect 정책 | 실제 Slack 통합 전 | OPEN |
| OD-042 | owner/workspace allowlist 관리 | D2 전 | OPEN |
| OD-043 | durable store 기술·경로·migration·locking | C1/D2 전 | OPEN |
| OD-044 | event idempotency와 out-of-order 우선순위 | C2 전 | OPEN |
| OD-045 | retention, backup, corruption recovery | 운영 자동화 전 | OPEN |
| OD-046 | Slack message 삭제·archive·channel 변경 복구 | C2/D1 전 | OPEN |
| OD-047 | Slack identity 영역에서 Project와 Repository를 둘 다 표시할지와 fallback | C1/D1 전 | OPEN |
| OD-048 | 공통 channel topology의 최종 채택 여부 | 첫 Slack 설정 전 | OPEN |
| OD-049 | GitHub 공식 Slack App 설치와 repo별 review/workflow 구독 범위 | 운영 환경 준비 전 | OPEN |
| OD-071 | modal submission validation error를 modal에 유지·표시하는 UX | D2 전 | OPEN |
| OD-072 | correlation/summarizer/source stale/Channel pending 등 degraded owner 알림 정책 | C1/D1/D2 전 | OPEN |

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
| OD-060 | 실제 Slack/GitHub/Orca 통합 테스트 범위 | 첫 외부 write 전 | OPEN |
| OD-061 | 테스트 workspace/repository/Run과 owner identity | 첫 외부 write 전 | OPEN |
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

아직 닫지 않았지만 제약이 좁혀졌다. 근거는 [플랫폼 검증 §8](platform-capabilities.md#8-gate-계약-실측-2026-08-21).

- **OD-050** (Gate option/recommendation/impact metadata): 실측 결과 Orca Gate schema에 권장안·이유·영향·선택지 설명·선택지 ID·임의 metadata 필드가 **전혀 없다**. "제공되는지 확인"이 아니라 "Bridge 또는 coordinator가 반드시 만들어야 한다"로 성격이 바뀌었다. 남은 선택지는 `question`/`options` 문자열 인코딩, Bridge sidecar store, 카드 축소 셋 중 하나다.
- **OD-051** (crash window와 outbox atomicity): `--retry-request`가 같은 요청의 재시도를 멱등화하고 `mutation.replayed`로 재생을 판정할 수 있다. 그러나 **이미 resolved된 Gate를 다른 요청이 조용히 덮어쓴다.** 따라서 (1) resolve 직전 status 재확인은 필수이고, (2) status 확인과 resolve 사이 TOCTOU를 막을 Gate 단위 직렬화가 Bridge 측에 필요하다.
- **OD-067** (blocker taxonomy): `gate-create`가 task를 `blocked`로, `gate-resolve`가 `ready`로 자동 전이시키는 것을 관측했다. `blocked Task`는 Bridge가 계산하지 않고 Orca status를 그대로 쓸 수 있다. `permission pause`는 `worker-show`의 `observation.agentWait`가 source 후보다.
- **OD-023** (ingestion 방식): Gate 생성·해결이 `inbox`에 메시지를 만들지 않는다. Gate 변화는 push로 오지 않으므로 polling 또는 재조회가 필요하다. 또한 Observer는 `check --ack`를 호출하면 coordinator의 배치를 소비하므로 `inbox` 또는 `check --peek/--all`로 제한해야 한다.
- **OD-020** (Run↔repository↔coordinator identity): Task row의 `created_by_process_incarnation`에 작업 디렉터리(`D:/dev-infra`)가 포함되고, `run-create` 시 `coordinator_handle`·`coordinator_pane_key`가 자동으로 채워진다. 두 경로 모두 후보이며 파싱 안정성은 미검증이다.

## 2026-08-22 Channel 검증이 바꾼 항목

근거는 [플랫폼 검증 §9.6~9.8](platform-capabilities.md#96-대화형-세션에서-end-to-end-전달-검증-성공).

- **OD-056** (Channel custom 개발·allowlist·배포 경로): 로컬 2.1.238에서 `--dangerously-load-development-channels server:<name>` + `--mcp-config` 절대경로 조합으로 custom channel이 실제 등록·전달됨을 확인했다. preview 동안은 이 경로가 유일하며 `--channels`는 Anthropic allowlist plugin만 받는다. plugin 패키징으로 옮기는 시점은 여전히 OPEN이다.
- **OD-059** (coordinator application receipt 반환 계약): reply tool이 실제 receipt 경로로 동작함을 관측했다. 서버가 이벤트 상태를 추적하고 Claude가 tool을 호출해 수신을 보고하는 구조가 성립한다. payload와 멱등성 설계는 여전히 OPEN이다.
- **OD-054** (pending/attempted/delivered/processed/resumed 정의): `TRANSPORT_WRITE_ATTEMPTED`(서버의 `PUSHED` 기록)와 `APPLICATION_RECEIPT_RECEIVED`(reply tool 호출)를 실제로 구분해 관측했다. 두 상태의 물리적 근거가 확보됐다.
- **OD-062** (허용 지연): push부터 Claude가 receipt를 호출하기까지 약 7~10초를 관측했다. 유휴 세션·단일 이벤트 조건의 값이며 모델 턴 시간을 포함한다.
- **OD-063** (daemon 자동 시작 방식): **channel 이벤트는 대화형 세션에만 도달한다.** `-p` 비대화형 세션에서는 같은 구성으로 4회 모두 미도달이었다. 따라서 wake-up 대상 coordinator 세션은 대화형으로 유지돼야 하며, daemon 자동 시작 설계는 coordinator를 headless로 대체하는 방향을 취할 수 없다.
- **OD-057** (notification 중복 시 coordinator 멱등성): 이번 관측에서는 유실 0·중복 0이었고 큐 순서도 보존됐다. 다만 세션 재시작과 장시간 운용은 검증하지 않았으므로 항목은 OPEN을 유지한다.

## 2026-08-22 GitHub 실측이 바꾼 항목

근거는 [플랫폼 검증 §10](platform-capabilities.md#10-github-pr-실측-2026-08-22).

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

근거는 [플랫폼 검증 §11](platform-capabilities.md#11-ab-0-환경identity-관측-2026-08-22).

- **OD-020** (Run↔repo↔coordinator session identity): 실측 경로가 확보됐다. coordinator 세션의 `ORCA_TERMINAL_HANDLE`/`ORCA_PANE_KEY`가 Run row의 `coordinator_handle`/`coordinator_pane_key`와 동일 값이고, `ORCA_WORKTREE_ID`가 로컬 경로를 담아 Git remote를 거쳐 GitHub repository로 이어진다. 남은 미결은 (1) 환경변수를 어느 신뢰 수준으로 취급할지, (2) `<uuid>::<path>` 형식의 안정성, (3) coordinator 재시작 시 handle 유지 여부다.
- **OD-053** (Run↔현재 coordinator Channel routing): Channel Adapter가 MCP 서브프로세스로서 위 identity를 그대로 상속하고 `CLAUDE_CODE_SESSION_ID`는 자기 세션 값으로 받는 것을 실측했다. Adapter 자기소개 payload의 재료가 확정 가능하다. 단 coordinator pane 안의 자식 세션도 같은 `ORCA_*`를 상속하므로 세션 구분에는 `CLAUDE_CODE_SESSION_ID`가 필요하다. `CLAUDE_PID`는 조상 값이 상속되므로 사용 금지.
- **OD-010** (`/init-orchestrate` 패키징과 호출 계약): 이 환경의 skill은 `~/.agents/skills/<name>/SKILL.md`에 있고 `~/.claude/skills`는 존재하지 않는다. `orchestration` skill은 discovery stub이고 실제 가이드는 `orca skills get orchestration --full`이 서빙한다. 같은 stub+런타임조회 패턴이 `/init-orchestrate`의 후보다. 실제 배치 위치는 coordinator 세션이 발견하는지 실측한 뒤 확정한다.
- **OD-015** (successor 세션 생성 공식 수단): `orchestration coordinator-start`가 은퇴해 Orca orchestration 표면에는 없다(§7.2). 남은 후보는 `orca-cli`의 terminal/worktree 생성 계열이며 아직 조사하지 않았다.
- **OD-016** (coordinator single-writer와 권한 이관): `run-use --takeover-legacy`가 "live coordinator agent terminal에서 실행, 기존 worker 배정 보존"이라는 실제 메커니즘으로 존재한다(§7.2). pane/terminal handle이 세션 identity와 연결되므로 fencing 판정의 재료도 있다. 절차 설계는 미결이다.

## 2026-08-22 AB-0 부팅·롤오버 실측이 바꾼 항목

근거는 [플랫폼 검증 §12](platform-capabilities.md#12-ab-0-부팅롤오버-메커니즘-실측-2026-08-22).

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
      모델별 창 크기는 같은 레코드의 `model`로 판정하고, 모르는 모델이면 발동하지 않는다(fail-safe).
      초기 임계값은 미검증 값으로 두고 1차 실제 rollover 관측에서 재보정한다.
근거:
  - `message.usage` 필드가 transcript에 실재하고 hook이 `transcript_path`를 받는 것을 실측했다(§12.4).
  - Stop hook의 `{"decision":"block","reason":...}` 주입이 실제로 동작하고 `stop_hook_active`가
    무한 루프를 막는 것을 실측했다(§12.2). 턴 종료는 무인 coordinator의 자연스러운 안전 checkpoint다.
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
          임계값 숫자와 handoff 절차의 실제 토큰 비용은 미측정.
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
검증 방법: `orca agent-context --json`에서 명령 스키마와 note 확인(2026-08-22).
          실제 세션 생성·부팅 프롬프트 주입·ACK 왕복은 미실행.
결정일: 2026-08-22
후속: `run-use`가 `consumer_generation`을 증가시켜 fencing token이 되는지는 OD-016에서 확인한다.
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
