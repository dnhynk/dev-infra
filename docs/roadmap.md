# 구현 로드맵과 Size Gate

상태: **Draft · Size 확인 전 잠정 분할 가설**

이 문서는 세부 기술을 미리 고정하지 않고, 각 단계에서 실제 Orca·Claude Code·Slack·GitHub 계약을 관측한 뒤 작업 크기를 산정하고 쪼개기 위한 순서를 정의한다.

아래 S0/C1/C2/D1/D2/D3 이름과 경계는 확정 구현 계획이 아니다. Bridge 사전 Size Gate 결과를 보고 사용자가 합의한 뒤 유지·병합·재분할한다.

## 1. 공통 진행 규칙

각 workstream 또는 slice를 시작하기 전에 다음을 수행한다.

1. 대상 문서와 적용할 작업 규약을 다시 읽는다.
2. 실제 버전의 공식 인터페이스와 sample payload를 관측한다.
3. 무엇을 왜 바꾸는지, 영향 파일·호출자·외부 상태를 제시한다.
4. 작업 크기, 위험, 독립 검증 경계를 보고한다.
5. 추가로 쪼갤지 사용자와 합의한다.
6. 합의 후 최소 diff로 구현한다.
7. 명시한 수용 테스트를 실행하고 명령·출력을 남긴다.

TBD는 이 과정에서만 확정한다. 구현자가 편의상 먼저 채우지 않는다.

## 2. Workstream AB · Bootstrap & Continuity

`/init-orchestrate`와 컨텍스트 열화·handoff lifecycle은 하나의 문제로 묶어 처리한다.

이 workstream 내부에서 구현 단계를 나눌 수는 있지만, A만 구현하고 B까지 해결됐다고 선언하지 않는다.

### AB-0 · 현재 환경과 lifecycle 계약 확인

- skill/package 배치 방식
- `/orchestration`과 호출 순서
- authoritative spec 발견 규칙
- Orca Run/session/worktree identity
- successor 세션 생성 가능한 공식 수단
- context 열화 관측 가능성
- handoff 저장·archive·redaction
- coordinator single-writer 보장 가능성
- reviewer verdict의 durable 관찰 위치
- worker ask/reply와 사람용 Gate 승격 계약

출구 조건:

- Fresh boot와 Resume boot의 입력·출력·실패 조건이 fixture로 표현됨
- 자동 rollover에서 검증 불가능한 구간이 명시됨
- 실제 구현 크기와 분할 제안에 사용자 동의

### AB-1 · Bootstrap + durable handoff contract

- `/init-orchestrate` 표준 운영 계약
- run-specific 추가 지시
- worker/reviewer/PR metadata/Gate 규칙 전파
- handoff 의미 schema
- 수동으로 유발한 resume와 live-state reconciliation

### AB-2 · Context degradation과 successor handover

- 열화 trigger
- checkpoint와 durable handoff
- successor 생성·부팅
- predecessor fencing과 successor 권한 이관
- 실패·재시작 복구

AB 완료 기준은 [통합 스펙의 수용 기준](specs/orchestration-bootstrap-and-continuity.md#10-수용-기준)을 따른다.

## 3. Bridge 사전 Size Gate

Bridge의 C/D 구현 전에 다음 sample을 확보한다.

- 실제 Orca run/task/worker/gate JSON
- 실제 `worker_done`과 release 후 `worker-read`
- live/stale coordinator와 terminal/worktree mapping
- 대표 GitHub PR review/check/merge 조합
- Slack Socket Mode와 interaction payload
- 로컬 Claude Code custom Channel smoke test

이 자료를 바탕으로 아래 각 slice의 작업량과 coupling을 재평가한다. 특히 Channel이 현재 로컬 버전에서 동작하지 않으면 D3을 다른 slice와 묶어 구현하지 않는다.

실제 빌드 단계의 Slack/GitHub/Orca 통합 write는 사용자에게 원칙적으로 허용받았다. 다만 정확한 workspace·repository·Run·owner와 test 격리는 첫 외부 write 전에 확정한다.

### 외부 운영 prerequisite

- GitHub 공식 Slack App 설치 여부와 `#github` 대상 channel을 확인한다.
- repository별 pulls/reviews/workflows/commits 구독 범위를 결정한다.
- 이는 Bridge의 GitHub source adapter와 별도인 Slack 운영 설정으로 추적한다.

## 4. Bridge Slice S0 · 관찰·상관관계 기반

범위:

- Orca/GitHub read-only fact 수집
- Run/Task/Dispatch/PR identity와 correlation
- Project↔Repository mapping과 routing identity
- canonical projection의 최소 골격
- durable entity↔Slack mapping 개념

외부 write:

- 없음

출구 조건:

- 같은 입력을 반복해도 같은 entity로 인식됨
- 누락된 correlation을 추측하지 않고 오류로 식별함
- 실제 sample schema가 문서와 fixture에 반영됨

## 5. Bridge Slice C1 · PR Digest 첫 수직 슬라이스

범위:

- 한 repository의 한 PR 발견
- Orca Task/`worker_done` correlation
- structured summarizer contract
- deterministic renderer
- `#pr-digest` 루트 생성과 동일 메시지 update

출구 조건:

- **PR 카드가 정확히 하나 생성됨** — T5가 이 Run의 correlated PR에 실제 `#pr-digest` 카드 1회를 게시했고, durable store의 `pr_message` 행은 1건이었다.
- **재관찰로 루트가 중복되지 않음** — T5가 같은 `digest` 명령을 재실행했을 때 `chat.postMessage`는 호출되지 않고 기존 message ts를 `chat.update`했으며 `pr_message` 행은 1건으로 남았다.
- **repository identity와 PR 링크가 항상 표시됨** — T5의 실제 두 카드 blocks 비교에서 identity와 action button은 byte 단위로 같았고, renderer·digest 통합 테스트가 identity와 PR link를 고정한다.
- **LLM이 layout/action을 만들지 않음** — T4 renderer 테스트와 T5 실제 재실행 비교에서 모델 문자열만 달랐고 identity·상태·리뷰·risk·CI·worker 보고·action은 deterministic renderer가 유지했다.

## 6. Bridge Slice C2 · Review·CI·Merge lifecycle

범위:

- changes requested, 수정, 재검토, approval
- required check와 merge-ready 정책
- merge 완료
- 중요한 transition thread
- 중복·역순·재시작 복구

출구 조건:

- 대표 lifecycle이 같은 루트에서 갱신됨
- transition이 thread에 한 번만 기록됨
- 오래된 상태가 merged를 되돌리지 않음
- GitHub Slack 메시지를 입력으로 사용하지 않음

## 7. Bridge Slice D1 · Run Observer

범위:

- Run당 루트 메시지 하나
- Task 진행률, PR 상태, blocker 수
- 수동으로 등록한 여러 repository/Run identity 표시
- 현재 owner 개입 필요 여부

출구 조건:

- Slack 표시가 확정된 Orca 집계 규칙과 일치함
- live/stale Run을 구분함
- 재시작 뒤 같은 Run root를 재사용함

## 8. Bridge Slice D2 · Gate UI와 Orca Resolution

범위:

- Gate 질문·선택지·권장·영향 projection
- 버튼과 직접 입력 modal
- Slack ACK, owner/workspace/action 검증
- Gate open 재확인과 `gate-resolve`
- 중복·경합 action 처리
- resolution audit

출구 조건:

- 유효한 owner action만 정확한 Gate를 한 번 resolve함
- 비-owner, stale, duplicate action은 Orca를 변경하지 않음
- 일반 Slack 텍스트는 coordinator에 전달되지 않음
- Channel 없이도 resolution이 durable하게 남음

## 9. Bridge Slice D3 · Channel Adapter와 재개 관찰

범위:

- daemon↔Channel Adapter localhost 계약
- resolved Gate pending delivery
- 현재 Run과 coordinator session routing
- coordinator session별 Adapter spawn/binding과 channel opt-in 검증
- 연결 복구와 재시도
- coordinator application receipt/status 반환 경로
- coordinator가 Orca Gate를 재조회하도록 알림
- 실제 후속 Task 재개 관찰

출구 조건:

- Channel 미연결 중에도 Gate resolution을 잃지 않음
- 재연결 뒤 pending event를 다시 시도할 수 있음
- transport write와 coordinator 처리 완료를 구분함
- 실제 Orca 변화가 관찰된 뒤에만 Slack에 재개를 표시함
- Fresh/Resume coordinator가 올바른 Adapter를 활성화했고 pending Gate를 재조회함

Claude Channels가 research preview이므로 이 slice는 구현 직전 로컬 smoke test를 다시 통과해야 한다.

## 10. Bridge Slice O1 · 운영 자동화

후속 범위:

- PC 시작 시 daemon 자동 실행
- 새 Orca Run 자동 발견
- Git remote 기반 repository 자동 등록
- 자동 발견된 다중 repository routing
- health/status/log와 pending delivery 관측

핵심 C/D 수직 슬라이스 이후 크기를 다시 산정한다.

## 11. 별도 후속 workstream

- `#deploys`
- `#prod-alerts`
- 고위험 action 이중 확인
- Claude Code permission relay
- standard Slack MCP를 통한 Slack 과거 논의 검색
- 다중 owner/팀 운영

이 항목은 C/D 완료 기준에 포함하지 않는다.
