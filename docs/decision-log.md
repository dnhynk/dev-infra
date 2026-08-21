# 확정 결정 기록

이 문서는 사용자가 명시적으로 확정한 방향을 시간순으로 기록한다. 기술적으로 아직 정하지 않은 내용은 [미결정 사항](open-decisions.md)에 둔다.

## 2026-08-21 · 초기 제품 방향

### DL-001 · Infrastructure 형태

- 개인 Agentic Development Infrastructure를 `dev-infra` monorepo로 구축한다.
- 첫 구현 앱은 `apps/orca-slack-bridge`다.
- 향후 범위와 프로젝트 크기가 커질 가능성을 고려하되, 요청하지 않은 조기 일반화는 하지 않는다.

### DL-002 · 해결 문제

- A: 반복 orchestration 부팅 prompt를 `/init-orchestrate`로 단축한다.
- B: context 열화 감지, handoff, successor session 부팅과 안전한 resume를 다룬다.
- C: PR의 semantic state change를 `#pr-digest`로 제공한다.
- D: Run/Gate 상태와 remote decision을 `#agent-runs`로 제공한다.

### DL-003 · Bridge 역할

- 전체 Agent 대화를 지속적으로 요약하지 않는다.
- Orca와 GitHub의 의미 있는 상태 변화를 관찰한다.
- Bridge는 Agent가 아니라 Observer이며, Gate resolution에서만 제한된 Control Plane이다.
- GitHub 공식 notification과 사람이 보는 semantic digest의 역할을 분리한다.
- LLM은 structured semantic compression을 담당하고 Slack renderer는 deterministic해야 한다.
- PR와 Run마다 현재 루트 메시지를 하나 유지하고 thread에는 중요한 transition만 남긴다.

### DL-004 · Remote decision 안전성

- Slack 결정은 Orca Gate에 먼저 기록한다.
- durable 상태 뒤 Channel로 기존 coordinator를 깨운다.
- Channel은 source of truth가 아니다.
- 초기 입력은 owner가 조작한 button/modal로 제한한다.
- 일반 Slack thread text와 permission relay, 고위험 명령은 초기 범위에서 제외한다.
- 사람 결정과 무관한 ready task는 계속 실행한다.

## 2026-08-21 · 문서화 세션 방향

### DL-006 · Workstream 분리

- `/init-orchestrate`와 context/handoff lifecycle을 하나의 workstream으로 묶는다.
- 나머지 Bridge 기능은 실제 size를 확인한 뒤 독립적으로 검증 가능한 단위로 나눈다.

### DL-007 · 점진적 구체화

- 언어, runtime, package manager, monorepo tool, summarizer 등 구체 기술은 아직 정하지 않는다.
- correlation, state transition, delivery ACK 같은 세부 계약도 빌드 과정에서 관측과 논의를 통해 확정한다.
- 미정 내용을 구현자가 추측으로 메우지 않는다.

### DL-008 · 현재 세션 권한

- 현재 세션은 문서 작성 세션이다.
- 사용자가 입력한 요구를 spec과 필요한 보조 문서로 명세화한다.
- 애플리케이션 코드와 실제 Slack/GitHub/Orca 상태를 변경하지 않는다.
- 실제 빌드 단계에서는 Slack 메시지 작성, GitHub/Orca 연결, `gate-resolve`를 포함한 필요한 통합 작업 수행이 원칙적으로 허용됐다. 정확한 workspace·repository·Run·owner 대상은 실행 전에 확정한다.

### DL-009 · 문서 위치 — SUPERSEDED (DL-010)

- 문서 루트는 `C:\Users\dongh\dev-infra\docs`다. → DL-010으로 대체됨.

## 2026-08-21 · 저장소 구조 확정

### DL-010 · 실제 문서 루트

- 문서 루트는 `D:\dev-infra\docs`다.
- DL-009의 `C:\Users\dongh\dev-infra\docs`를 대체한다.
- 근거: 실제 작업 트리가 `D:\dev-infra`에 생성되어 있고 DL-009 경로에는 문서가 존재하지 않는다.

### DL-011 · 단일 monorepo 저장소

- Git 저장소는 `D:\dev-infra` 루트 하나만 둔다. 기본 branch는 `main`이다.
- `apps/orca-slack-bridge`에 있던 커밋 0개의 빈 저장소는 제거했다.
- 근거: DL-001의 monorepo 방침과 일치시키고, 앱별 저장소가 공용 `docs/`와 향후 `packages/`를 분리시키는 문제를 피한다.

### DL-012 · 문서 배치 통합

- 모든 기준 문서는 `docs/` 하위 한 트리에 둔다: `specs/`, `architecture/`, `contracts/`, `ux/`, `process/`, `source/`.
- 근거: 문서가 `docs/`와 `apps/orca-slack-bridge/docs/`로 분리되어 `README.md`·`traceability.md`의 하위 링크와 앱 문서의 `../product-vision.md` 계열 링크가 양방향으로 깨져 있었다.

### DL-013 · 근거 없는 scaffold 제거

- `apps/agent-dashboard`, `packages/agent-events`, `packages/github-client`, `packages/orca-client`, `scripts` 빈 디렉터리를 제거했다.
- 근거: 어느 문서에도 정의되지 않은 앱·패키지이며, 작업 규약의 조기 일반화 금지와 DL-007(기술 미확정)에 어긋난다. 필요해지는 시점에 근거와 함께 다시 만든다.

## 2026-08-21 · 기술 스택과 공개 범위

### DL-014 · 기술 스택 확정

- 언어·런타임: TypeScript on Node.js 26.x (OD-001)
- monorepo: pnpm workspaces만 사용하고 빌드 오케스트레이터는 두지 않는다 (OD-002)
- 테스트: Vitest. CI는 remote 생성 이후 GitHub Actions로 붙인다 (OD-003)
- 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 확정 기록에 있다.

### DL-015 · public GitHub remote

- `dev-infra`를 GitHub **public** repository로 공개한다.
- 결과로 다음이 선행 필수 조건이 된다.
  - secret은 저장소에 절대 커밋하지 않는다. 설정은 환경변수 또는 무시 대상 로컬 파일로 주입한다 (OD-005).
  - Size Gate에서 수집하는 Orca/GitHub/Slack fixture는 커밋 전에 redaction 규칙을 먼저 확정한다 (OD-018, OD-036, OD-064).
  - Slack workspace/channel/owner user ID와 Project↔Repository mapping은 공개 저장소 파일이 아니라 로컬 설정으로 다룬다 (OD-027, OD-042).
- 근거: 사용자가 public을 명시적으로 선택했다. 비공개 정보는 저장소가 아니라 주입 경로로 분리해 해결한다.
