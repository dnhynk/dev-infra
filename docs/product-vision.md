# 개인 Agentic Development Infrastructure 제품 비전

상태: **Draft**

## 1. 제품 정의

`dev-infra`는 Orca IDE에서 여러 Agent를 병렬로 운영하는 1인 개발자를 위한 개인 Agentic Development Infrastructure monorepo다. 첫 애플리케이션은 `apps/orca-slack-bridge`이며, 기존 Orca orchestration workflow를 관찰하고 Slack과 연결하는 백그라운드 프로세스를 목표로 한다.

이 인프라는 특정 SaaS 제품의 기능이 아니다. Git, GitHub, Docker, Orca, Claude Code, Codex, Slack과 나란히 개발환경을 구성하는 로컬 운영 계층이다.

## 2. 현재 workflow

1. 사용자와 LLM이 브레인스토밍하여 해당 repository의 스펙 문서를 확정한다.
2. 사용자가 coordinator 세션에 장문의 부팅 프롬프트를 입력한다.
3. coordinator가 스펙과 필요 시 `HANDOFF.md`를 읽는다.
4. coordinator가 Task DAG를 구성하고 각 branch가 checkout된 worktree에 worker를 배정한다.
5. worker가 PR을 만들고 reviewer agent가 검토한다.
6. coordinator가 review 결과를 확인하고 수정·재검토·merge·다음 작업 지시를 무인으로 이어간다.
7. 정말로 사람의 판단이 필요한 경우에만 owner에게 질문하거나 decision gate를 연다.

## 3. 해결할 불편함

### A. 반복되는 부팅 프롬프트

매 Run마다 동일한 장문 orchestration 계약을 복사·붙여넣어야 한다.

목표 UX:

```text
/orchestration
/init-orchestrate 데모까지만 구현
```

### B. 수동 컨텍스트 승계

사용자가 coordinator의 컨텍스트 열화를 직접 감지하고, handoff를 작성하고, 새 세션을 만들고, 부팅 프롬프트를 다시 넣어야 한다.

목표는 기존 Run·worker·worktree·PR·결정 상태를 잃지 않고 successor coordinator가 안전하게 이어받게 하는 것이다.

### C. 모바일에서 이해하기 어려운 PR 현황

GitHub Mobile이나 GitHub Slack 알림만으로는 여러 PR의 의미와 현재 위험을 짧은 시간에 파악하기 어렵다.

목표는 `#pr-digest`에서 Agent 대화 전체가 아니라 PR의 의미 있는 상태 변화만 사람이 이해할 수 있는 말로 보여주는 것이다.

### D. 자리를 비운 동안 멈추는 사람 결정

제품 판단이 필요한 blocker나 Gate가 열렸을 때 사용자가 작업실에 없으면 관련 작업이 계속 멈춘다.

목표는 `#agent-runs`에서 owner가 모바일 버튼 또는 modal로 결정하고, 그 결정을 Orca의 정식 Gate 상태에 먼저 기록한 뒤 기존 coordinator가 같은 로컬 환경에서 이어가게 하는 것이다.

## 4. 확정된 설계 철학

### 상태 변화가 중심이다

전체 worker↔coordinator 대화를 상시 수집·요약하지 않는다. 다음과 같은 의미 있는 상태 변화만 다룬다.

- worker 완료와 PR 생성
- review 승인 또는 수정 요청
- worker 수정과 재검토
- CI 통과 또는 실패
- merge 준비 완료
- coordinator merge
- Run/Task/Gate 상태 변화

### 운영 사실과 사람용 의미를 분리한다

- `#github`: GitHub 공식 앱이 제공하는 operational notification/presentation view
- `#pr-digest`: 사람이 빠르게 이해하기 위한 semantic view

Bridge는 `#github` 메시지를 파싱하지 않고 GitHub API 또는 `gh`에서 원본 상태를 읽는다.

### Agent와 Observer를 분리한다

`orca-slack-bridge`는 worker나 coordinator를 대신하는 Agent가 아니다. orchestration 대화에 끼어들지 않는 Observer이며, 사람의 명시적 Gate 결정에 대해서만 제한된 Control Plane이 된다.

### LLM의 책임을 제한한다

```text
raw facts
  → LLM의 의미 압축
  → 검증된 structured data
  → deterministic renderer
  → Slack
```

LLM은 Slack 레이아웃, 버튼, action, 링크를 임의 생성하지 않는다.

### 하나의 현재 카드와 중요한 이력만 유지한다

- PR 하나당 `#pr-digest` 루트 메시지 하나
- Orca Run 하나당 `#agent-runs` 루트 메시지 하나
- 현재 상태는 기존 루트 메시지에 갱신
- 중요한 상태 변화만 thread에 한 번 기록

### 결정 저장과 wake-up을 분리한다

Slack 결정은 먼저 Orca Gate에 기록한다. durable 상태를 남긴 뒤 Channel notification으로 coordinator를 깨운다. Channel은 source of truth가 아니라 초인종이다.

### blocker는 의존하는 branch만 막는다

사람의 결정이 필요한 Task와 그 의존 Task만 대기한다. 그 Gate와 독립적인 ready task와 worker는 계속 실행한다.

### 초기 원격 입력 표면을 좁힌다

- 허용: Bridge가 생성한 선택지 버튼, 해당 Gate에 연결된 직접 입력 modal
- 금지: Slack thread의 임의 문장을 coordinator prompt로 전달
- 인증: room이나 channel이 아니라 실제 Slack sender user ID allowlist
- 초기 제외: Claude Code tool permission relay, merge 명령, production rollback 등 고위험 명령

## 5. 제안된 Slack 정보 구조

Slack Workspace 하나와 앱 하나씩을 공유하고 메시지 identity로 프로젝트를 구분하는 구성이 강한 목표안으로 제시됐다. 최종 channel topology는 아직 TBD다.

```text
Agent Development Workspace
├─ #github       GitHub 공식 operational notifications
├─ #pr-digest    모든 repo의 사람이 읽기 쉬운 PR 상태
├─ #agent-runs   모든 repo의 Run 상태와 remote decision
├─ #deploys      후속: staging/production deployment
└─ #prod-alerts  후속: 실제 서비스 장애
```

모든 Bridge 메시지는 최소한 project/repository와 PR 또는 Run identity를 명확히 보여야 한다.

## 6. 최종 사용자 경험

1. PC를 켜면 Bridge가 자동 시작된다.
2. 사용자는 Orca에서 평소처럼 orchestration을 시작한다.
3. coordinator session의 Channel Adapter가 별도 사용자 명령 없이 올바른 Run에 binding된다.
4. 새 Run과 repository가 자동으로 발견된다.
5. worker PR이 생기면 `#pr-digest` 카드가 생성된다.
6. review·CI·merge 상태가 같은 카드에 갱신된다.
7. 사람 결정이 필요하면 `#agent-runs`에 Gate UI가 나타난다.
8. owner가 모바일에서 결정한다.
9. 결정은 Orca에 영구 기록된다.
10. 기존 사무실 PC의 coordinator가 같은 Run·context·worker/worktree를 유지한 채 계속 진행한다.

이 흐름에서 사용자가 매번 Bridge 명령을 직접 실행하거나 프로젝트별 Slack 앱·채널을 새로 만들 필요가 없어야 한다.

## 7. 현재 범위와 후속 범위

현재 상세 명세 대상:

- A와 B를 묶은 orchestration bootstrap·continuity
- C의 PR digest
- D의 Run observer·Gate control·coordinator wake-up

후속 범위:

- 자동 Run/repository 발견과 OS 자동 시작의 고도화
- `#deploys`, `#prod-alerts`
- 고위험 action의 이중 확인
- Claude Code permission relay
- Slack 과거 논의를 읽는 standard Slack MCP 연동
- 다중 owner 또는 팀용 SaaS화

## 8. 성공의 상위 기준

- 모바일에서 한 PR의 의미와 현재 상태를 약 10초 안에 이해할 수 있다.
- 전체 Agent 대화가 Slack 소음이나 지속적 요약 비용으로 전환되지 않는다.
- Slack/Channel 장애가 Orca와 GitHub의 authoritative 상태를 잃게 하지 않는다.
- 사람 결정이 필요한 동안에도 독립 작업은 계속된다.
- 원격 입력이 owner가 명시적으로 조작한 Gate UI로 제한된다.
- 실행 근거 없이 “완료” 또는 “안전하다”고 주장하지 않는다.

정량 지연·비용·요약 품질·동시 Run 수는 아직 TBD다.
