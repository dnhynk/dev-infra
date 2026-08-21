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
| OD-010 | `/init-orchestrate` 패키징과 `/orchestration` 호출 계약 | AB 구현 전 | OPEN |
| OD-011 | authoritative spec 발견·우선순위 규칙 | AB 구현 전 | OPEN |
| OD-012 | fresh/resume 자동 판별 또는 명시 옵션 | AB 구현 전 | OPEN |
| OD-013 | `HANDOFF.md` 위치·schema·archive·atomic write | AB-1 전 | OPEN |
| OD-014 | context 열화 신호와 threshold | AB-2 전 | OPEN |
| OD-015 | successor 세션 생성·부팅·ACK 공식 수단 | AB-2 전 | OPEN |
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
| OD-028 | reviewer verdict를 GitHub formal review와 Orca 중 어디에 durable하게 남길지 | C1/C2 전 | OPEN |
| OD-029 | PR 생성과 `worker_done` 전송의 ordering 및 PR identity 포함 방식 | AB-1/S0 전 | OPEN |
| OD-069 | Run 진행률 분모와 dynamic/cancelled/failed/retried Task·multiple Dispatch 집계 | D1 전 | OPEN |
| OD-070 | `worker_done` 누락·중복·불완전 payload의 상태와 recovery | S0/C1 전 | OPEN |

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
