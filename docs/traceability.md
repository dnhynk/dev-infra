# 요구사항 추적표

상태: **Draft audit**  
목적: 사용자가 전달한 비전과 운영 규칙이 어느 문서에 보존됐는지 확인한다.

| 원문 요구/아이디어 | 분류 | 기준 문서 |
|---|---|---|
| Orca IDE에서 병렬 Agent로 풀스택 개발하는 1인 개발자용 인프라 | 확정 | [제품 정의](product-vision.md#1-제품-정의) |
| `dev-infra` monorepo와 첫 앱 `apps/orca-slack-bridge` | 확정 | [제품 정의](product-vision.md#1-제품-정의), [Bridge 역할](specs/orca-slack-bridge.md#1-제품-역할) |
| LLM 브레인스토밍 후 spec 확정, 그 뒤 orchestration 구현 | 확정 workflow | [현재 workflow](product-vision.md#2-현재-workflow), [부팅 전제](specs/orchestration-bootstrap-and-continuity.md#31-공통-전제) |
| coordinator가 spec과 resume 시 `HANDOFF.md`를 완전히 읽음 | 확정 | [Fresh/Resume boot](specs/orchestration-bootstrap-and-continuity.md#3-부팅-계약) |
| 흐릿한 부분을 추측하지 않고 질문 또는 공인 자료로 해소 | 확정 | [부팅 계약](specs/orchestration-bootstrap-and-continuity.md#31-공통-전제), [작업 규약](process/working-agreement.md) |
| worker를 branch가 checkout된 worktree에 배정하고 PR 생성 | 확정 | [Coordinator 계약](specs/orchestration-bootstrap-and-continuity.md#4-coordinator-운영-계약) |
| review 전담 Codex `sol high fast` | 확정, mapping 완료 | [Agent 배치 정책](specs/orchestration-bootstrap-and-continuity.md#42-agent-배치-정책), [배치 표면](platform-capabilities.md#28-agent-배치-표면) |
| 작업 종류·난이도별 brand/model/effort 동적 배치 | 사용자 확정 | [Agent 배치 정책](specs/orchestration-bootstrap-and-continuity.md#42-agent-배치-정책) |
| coordinator가 review를 확인하고 merge·다음 작업까지 무인 진행 | 확정 | [Coordinator 계약](specs/orchestration-bootstrap-and-continuity.md#4-coordinator-운영-계약) |
| A: 장문 부팅 prompt 복사·붙여넣기 제거 | 확정 | [A 문제](product-vision.md#a-반복되는-부팅-프롬프트), [통합 스펙](specs/orchestration-bootstrap-and-continuity.md) |
| `/orchestration` + `/init-orchestrate 데모까지만 구현` UX | 확정 목표, 패키징 확정 (OD-010) | [목적](specs/orchestration-bootstrap-and-continuity.md#1-목적) |
| B: context 열화 감지·handoff·새 session 부팅 자동화 | 확정 목표, 감지·승계 수단 확정 (OD-014, OD-015, DL-017) | [B 문제](product-vision.md#b-수동-컨텍스트-승계), [승계 lifecycle](specs/orchestration-bootstrap-and-continuity.md#6-컨텍스트-승계-lifecycle) |
| A와 B를 하나의 workstream으로 처리 | 사용자 확정 | [로드맵 AB](roadmap.md#2-workstream-ab--bootstrap--continuity) |
| C: Agent 대화가 아니라 상태 변화를 요약 | 확정 | [설계 철학](product-vision.md#상태-변화가-중심이다), [Bridge 원칙](specs/orca-slack-bridge.md#2-필수-원칙) |
| worker 완료→PR, review→수정/승인, CI→ready, merge→완료 lifecycle | canonical state·stale approval·required-check 판정 확정 (OD-030~032) | [PR Digest lifecycle](specs/orca-slack-bridge.md#51-관심-lifecycle), [상관관계 계약](contracts/observation-and-correlation.md#6-pr-canonical-state) |
| `worker_done`을 정확히 한 번, 3문장 의미 요약 | 확정 | [Worker 계약](specs/orchestration-bootstrap-and-continuity.md#5-worker와-pr-관찰-계약), [관찰 계약](contracts/observation-and-correlation.md#3-worker-완료-계약) |
| Bridge는 `worker_done`을 Run mailbox에서, `reviewer_result`를 `task.result`에서 읽고 `worker-read`하지 않음 | 확정 (OD-025, OD-075) | [Worker 완료 계약](contracts/observation-and-correlation.md#3-worker-완료-계약) |
| PR 카드 하나를 상태마다 update | 확정 | [Slack projection](specs/orca-slack-bridge.md#54-slack-projection), [PR UX](ux/slack-surfaces.md#2-pr-digest) |
| PR 카드의 what/why/current/impact/review/risk/validation | 확정 의미 | [PR UX](ux/slack-surfaces.md#2-pr-digest) |
| `#github`과 `#pr-digest` 역할 분리 | 확정, `raw` 용어 정정 | [제품 철학](product-vision.md#운영-사실과-사람용-의미를-분리한다), [플랫폼 검증](platform-capabilities.md#5-github) |
| coordinator에게 Slack 요약 책임을 추가하지 않고 별도 Observer 사용 | 확정 | [제품 역할](specs/orca-slack-bridge.md#1-제품-역할) |
| Orca run/task/worker/gate read-only 관찰 | C1은 명령 1회 관찰, polling은 O1 | [Orca Collector](architecture/orca-slack-bridge.md#orca-collector), [OD-023](open-decisions.md#확정-기록) |
| GitHub title/body/branch/commit/files/stats/review/comments/CI/merge 직접 조회 | 확정 방향 | [Bridge 입력](specs/orca-slack-bridge.md#52-입력-사실), [GitHub 검증](platform-capabilities.md#52-원본-상태-조회) |
| GitHub Slack 메시지를 파싱하지 않음 | 확정 | [Bridge 원칙](specs/orca-slack-bridge.md#2-필수-원칙) |
| PR body의 Orca Run/Task/Dispatch HTML metadata | 형식 확정; primary/latest Task만 body에 두고 PR↔Task N은 store에 보존, run-only는 degraded (OD-021, OD-076, OD-077) | [Correlation 계약](contracts/observation-and-correlation.md#2-pr-correlation-metadata) |
| 최소 facts→LLM structured JSON→deterministic renderer | 확정 | [의미 압축](specs/orca-slack-bridge.md#53-의미-압축) |
| transcript 50,000자를 기본 입력으로 보내지 않음 | 확정 | [Bridge 원칙](specs/orca-slack-bridge.md#2-필수-원칙) |
| repo+PR와 Slack message ts, PR↔Task N, Run/Task 상태를 durable store에 보관 | C1은 node:sqlite; C2 association·reconciliation 확정 (OD-043, OD-044, OD-046, OD-076) | [Durability](specs/orca-slack-bridge.md#9-durability와-멱등성), [PR projection 일관성](architecture/orca-slack-bridge.md#6-pr-projection의-일관성) |
| Root=current, thread=중요 상태 변화 이력 | 확정 | [공통 UX](ux/slack-surfaces.md#1-공통-원칙) |
| D: Orca Run 하나=Slack root 하나 | 확정; Run row identity와 `consumer_generation`이 권위 (OD-020) | [Run Observer](specs/orca-slack-bridge.md#6-d--run-observer), [Run identity 계약](contracts/observation-and-correlation.md#5-runrepositorycoordinator-연결), [Run UX](ux/slack-surfaces.md#3-agent-runs) |
| Task/PR/blocker 현재 상태와 사람 개입 필요 여부 표시 | current Task 상태/분모와 Dispatch attempts 분리, 원천별 blocker badge 확정 (OD-067, OD-069) | [Run Observer](specs/orca-slack-bridge.md#61-기본-단위), [Run progress 계약](contracts/observation-and-correlation.md#7-run-progress) |
| Worker ask와 사람 결정용 Orca Gate를 구분 | 확정 운영 방향 | [Coordinator 계약](specs/orchestration-bootstrap-and-continuity.md#4-coordinator-운영-계약), [Gate 생성 계약](contracts/observation-and-correlation.md#4-gate-생성-계약) |
| Worker `ask`/coordinator `reply`, coordinator만 사람용 Gate 생성 | 확정 | [질문과 Gate](specs/orchestration-bootstrap-and-continuity.md#41-worker-질문과-사람용-gate), [Gate 계약](contracts/observation-and-correlation.md#4-gate-생성-계약) |
| Gate question/options/recommendation/reason/impact 표시 | 사람용 요약은 Gate, 기계 판정 metadata는 Gate ID 연결 sidecar (OD-050) | [Gate 표시](specs/orca-slack-bridge.md#62-gate-표시), [Gate UX](ux/slack-surfaces.md#32-gate-결정-카드) |
| ask/reply와 사람용 Gate correlation | sidecar의 message/thread/dispatch/task/gate mapping이 권위 (OD-019) | [Gate 생성 계약](contracts/observation-and-correlation.md#4-gate-생성-계약) |
| 버튼 클릭 시 owner/open/duplicate 검증 후 `gate-resolve` | Gate별 직렬화·retry replay·전후 재조회·durable outbox 확정 (OD-051) | [Control Plane](specs/orca-slack-bridge.md#7-slack-control-plane) |
| Slack 결정을 Claude prompt로 바로 보내지 않고 Orca Gate에 먼저 기록 | 확정 | [처리 순서](specs/orca-slack-bridge.md#72-처리-순서) |
| 기존 로컬 coordinator를 Channel로 깨움 | 기본 E2E 재검증, 구현은 별도 D3 Run으로 분리 (OD-056) | [Channel Adapter](specs/orca-slack-bridge.md#8-channel-adapter), [D3 로드맵](roadmap.md#9-bridge-slice-d3--channel-adapter와-재개-관찰) |
| `@Claude`의 새 cloud session/clone과 기존 coordinator push를 구분 | 확정 | [플랫폼 비교](platform-capabilities.md#35-claude와의-차이) |
| Standard Slack MCP는 외부→현재 session push 해결책이 아님 | 확정 일반 원리, 특정 plugin 명령 미검증 | [Channels 검증](platform-capabilities.md#33-channels-계약) |
| Slack Socket Mode로 공개 endpoint 없이 개인 PC 연결 | `@slack/socket-mode`, reconnect/ACK 계약 확정 (OD-041) | [시스템 컨텍스트](architecture/orca-slack-bridge.md#1-시스템-컨텍스트) |
| Slack owner/workspace/App authorization | team+exact user+optional api_app_id, Socket signing secret 불필요 (OD-042) | [Control Plane](specs/orca-slack-bridge.md#7-slack-control-plane) |
| Gate resolve→durable storage→Channel wake-up | 직렬화·retry replay·outbox reconciliation 확정 (OD-051) | [Gate 순서](architecture/orca-slack-bridge.md#4-gate-처리-순서와-crash-경계) |
| daemon과 Channel Adapter 분리 | named pipe client 계약 확정, 구현은 별도 D3 Run (OD-052, OD-056) | [프로세스 경계](architecture/orca-slack-bridge.md#3-프로세스-경계) |
| coordinator reply/status가 Adapter를 통해 daemon으로 돌아오는 경로 | reply tool을 관측된 반환 경로로 채택, 유일성은 규정하지 않음 (OD-059) | [Channel Adapter](architecture/orca-slack-bridge.md#channel-adapter) |
| Channel delivery 단계 | transport write는 신호 아님, application receipt와 Gate pending→resolved 효과를 분리 (OD-054, OD-055) | [Delivery 상태](architecture/orca-slack-bridge.md#5-개념-delivery-상태) |
| Channel opt-in·중복·재조회 | dead-window-safe probe, Orca-state no-op, receipted→consumed 경계 확정 (OD-057, OD-058, OD-066) | [Channel Adapter](specs/orca-slack-bridge.md#8-channel-adapter) |
| custom Channel 배포 | development flag만 가능하고 매 기동 확인 필요; 별도 D3 Run (OD-056) | [D3 로드맵](roadmap.md#9-bridge-slice-d3--channel-adapter와-재개-관찰) |
| Gate가 있어도 독립 Task 계속 실행 | 확정 | [Coordinator 계약](specs/orchestration-bootstrap-and-continuity.md#4-coordinator-운영-계약) |
| Gate 선택지 button과 직접 입력 modal | 로컬 validation은 3초 내 errors, 원격 Orca 작업은 post-ACK (OD-071) | [Gate UX](ux/slack-surfaces.md#32-gate-결정-카드), [Modal UX](ux/slack-surfaces.md#33-자유형-결정-modal) |
| 일반 thread text는 coordinator로 전달하지 않음 | 확정 | [초기 허용 입력](specs/orca-slack-bridge.md#71-초기-허용-입력) |
| `Slack USER_ID == OWNER_SLACK_USER_ID` 성격의 sender allowlist | 확정 | [Control Plane](specs/orca-slack-bridge.md#72-처리-순서), [공식 검증](platform-capabilities.md#block-kit과-interaction) |
| merge·production DB·secret·force push·rollback 등 위험 action 제한 | 확정 초기 제외 | [보안 경계](specs/orca-slack-bridge.md#10-보안-경계) |
| 고위험 action은 후속 이중 확인 | 후속 | [Slack UX 비허용](ux/slack-surfaces.md#7-초기-비허용-ui) |
| Claude tool permission relay는 가능하지만 V1 비활성화 | 확정 후속 | [Channels 검증](platform-capabilities.md#33-channels-계약), [Out of Scope](specs/orca-slack-bridge.md#14-명시적-out-of-scope) |
| 새 Run 자동 발견→Git remote→Slack thread | O1 범위; D1은 설정에 수동 등록한 repository만 관찰하고 Orca repository id로 연결 (OD-068, OD-078) | [최종 운영 UX](specs/orca-slack-bridge.md#12-전체-제품의-최종-운영-ux), [O1](roadmap.md#10-bridge-slice-o1--운영-자동화) |
| degraded owner 알림 | 카드는 항상 표시, owner action 필수 상태만 thread 알림 (OD-072) | [Degraded UX](ux/slack-surfaces.md#6-error와-degraded-ux) |
| Windows startup/systemd/PM2 등 상시 실행 | 최종 목표, 방식 TBD | [최종 운영 UX](specs/orca-slack-bridge.md#12-전체-제품의-최종-운영-ux) |
| 하나의 workspace, 통합 `#github/#pr-digest/#agent-runs/#deploys/#prod-alerts` | 권장 목표, 최종 topology TBD | [제안된 Slack 구조](product-vision.md#5-제안된-slack-정보-구조), [OD-048](open-decisions.md#slack과-durable-store) |
| 모든 메시지에 repository/project identity | 확정 | [공통 UX](ux/slack-surfaces.md#1-공통-원칙) |
| 하드코딩 대신 설정/DB의 Project↔Repository mapping | 확정 방향, cardinality TBD | [Entity 계약](contracts/observation-and-correlation.md#1-entity-identity), [OD-027](open-decisions.md#orcagithub-관찰과-correlation) |
| GitHub App workspace당 한 번 설치, 여러 repo 구독 | 공식 확인 | [GitHub Slack App](platform-capabilities.md#51-공식-slack-app) |
| Orca Bridge Slack App 하나가 여러 채널 담당 | 목표 구조 | [다중 프로젝트 구조](specs/orca-slack-bridge.md#11-다중-프로젝트-정보-구조) |
| C1에서 실제 빌드와 제한된 외부 write를 검증함 | 완료 | [문서 인덱스](README.md#현재-산출물-경계), [로드맵](roadmap.md#5-bridge-slice-c1--pr-digest-첫-수직-슬라이스) |
| 실제 빌드에서는 대상 확정 후 Slack/GitHub/Orca 통합 write 허용 | 사용자 확정 | [DL-008](decision-log.md#dl-008--현재-세션-권한), [로드맵](roadmap.md#3-bridge-사전-size-gate) |
| 나머지 Bridge 범위는 size 확인 후 분할 | 사용자 확정 | [로드맵](roadmap.md#3-bridge-사전-size-gate) |
| 구체 기술·계약은 빌드 과정에서 확정 | 사용자 확정 | [미결정 장부](open-decisions.md) |

## 감사 결과

원문에 등장한 A–D 문제, 상태 변화 중심 요약, PR/Run Slack UX, Gate Control Plane, Channel 내구성, 보안 경계, 다중 repository 정보 구조, 자동 발견·자동 시작·후속 permission/deploy 범위가 문서에 연결돼 있다.

현재까지 식별한 미확정 항목은 [미결정 사항](open-decisions.md)에 남겼다. 이후 감사나 빌드 관측에서 새 항목이 발견되면 새 ID와 영향을 받는 문서를 함께 갱신한다.
