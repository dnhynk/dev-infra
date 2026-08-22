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

## 2026-08-22 · reviewer verdict source

### DL-016 · reviewer verdict는 Orca에 기록한다

- Bridge가 읽을 reviewer verdict의 durable source는 GitHub formal review가 아니라 Orca다.
- 근거: 사용자 repository 4곳 전부 `reviewDecision`이 null이고, PR author와 review author가 같은 계정이라 GitHub이 self-approve를 막는다. 현재 workflow에서 formal verdict는 원리적으로 남길 수 없다.
- `task-update --result`가 중첩 JSON을 손실 없이 보존함을 실측으로 확인했다.
- GitHub review 본문의 `## Verdict` / `## Gates` / `## Findings` 규약은 표시용 보조 사실로만 쓰고 상태 source로 삼지 않는다.
- 기록 형식과 작성 주체는 AB workstream에서 `/init-orchestrate`의 reviewer 계약과 함께 확정한다 (OD-073).

## 2026-08-22 · AB 부팅과 롤오버 방식

### DL-017 · 컨텍스트 승계는 predecessor 자가증식으로 한다

- 열화를 감지한 predecessor coordinator가 스스로 successor 세션을 만들고 부팅 프롬프트를 주입한 뒤 종료한다. 별도 감시 데몬을 먼저 만들지 않는다.
- 자동 rollover 승인은 **Run 시작 시 1회**다. `/init-orchestrate` 시점에 합의하면 이후 열화마다 사용자에게 묻지 않고 승계한다.
- 근거: 데몬 없이 성립하고, 승계 시점 판단을 Run 상태를 아는 주체가 한다. 매 rollover 승인은 "작업실에 없어도 계속 돈다"는 B의 목표와 충돌한다.
- 이 방식의 약점은 명시한다. **predecessor가 successor 생성과 인수 확인 사이에 죽으면 아무도 되살리지 않는다.** durable `HANDOFF.md`가 남으므로 데이터는 잃지 않지만 그 구간에서 무인성이 깨진다. (D) 범위에서 도입될 daemon에 watchdog을 얹어 이 구간만 나중에 덮는다.
- Run 시작 시 1회 승인은 UX 선택이 아니라 기술적 전제조건이다. rollover 지시를 주입하는 hook은 자기 권위를 주장할 수 없고, 모델이 이를 prompt injection으로 판단해 거부하는 것을 실측했다([플랫폼 검증 §3.6](platform-capabilities.md#36-hook-기반-세션-제어와-컨텍스트-측정)).
- 감지·생성 수단의 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-014, OD-015 확정 기록에 있다.

### DL-018 · 호스트 전제조건을 재현 절차로 관리한다

- 이 워크플로우는 호스트 설정에 의존하며, 머신을 옮기면 조용히 깨진다. 실제로 새 머신에서 세 항목이 깨져 있었다: Claude Code용 skill 미설치, git 커밋 identity 부재, `NVM_HOME`/`NVM_SYMLINK` 미정의로 인한 node 소실.
- 이 항목들은 저장소 파일이 아니라 호스트 준비 절차로 다룬다(DL-015의 public 저장소 방침과 OD-005).
- 확인 방법과 실패 모드는 [플랫폼 검증 §6](platform-capabilities.md#6-호스트-전제조건)에 기록했다.
- `/init-orchestrate` skill 원본은 `skills/init-orchestrate/SKILL.md`에 두고 `~/.claude/skills/`로 설치한다. 홈 디렉터리에만 두면 다음 머신에서 같은 방식으로 사라진다.
- node는 DL-014/OD-001대로 **26.x를 유지**한다. 관측 시점 호스트의 nvm 활성 버전이 24.19.0이었으나 26.7.0으로 되돌렸고, OD-001의 근거였던 `node:sqlite` 동작을 이 호스트에서 재확인했다(2026-08-22).

## 2026-08-22 · Agent 배치

### DL-019 · 작업 종류별 agent 배치를 동적으로 한다

- coordinator는 모든 worker를 같은 기본 agent로 배치하지 않는다. 작업 종류와 난이도에 따라 brand·model·effort를 선택한다.
- 정책 표는 [Agent 배치 정책](specs/orchestration-bootstrap-and-continuity.md#42-agent-배치-정책)에 둔다. 10개 작업 종류에 대해 agent·model·effort를 지정한다.
- `worker-start`의 `--agent`/`--model`/`--effort`로 표현한다. 새 메커니즘이 필요하지 않다.
- 적용 여부는 요청값이 아니라 receipt의 `launch.effective`로 검증한다.
- 배치가 다른 후속 Task에는 terminal을 재사용하지 않는다. `--model`/`--effort`가 `--terminal`과 결합 불가하기 때문이다.
- 상세 정책은 [Agent 배치 정책](specs/orchestration-bootstrap-and-continuity.md#42-agent-배치-정책)에 둔다.

## 2026-08-22 · S0 설계 방향

### DL-020 · S0는 durable store 없이 만든다

- entity key를 전부 결정적으로 파생시킨다: Repository는 GitHub 숫자 `id`, Run/Task/Dispatch/Gate는 Orca 발행 id, PR은 `repoId + number`.
- 따라서 "같은 입력을 반복해도 같은 entity로 인식됨"이라는 S0 출구 조건이 저장소 없이 성립한다.
- durable store(OD-043)는 Slack message identity를 보관해야 하는 C1에서 도입한다.
- 근거: 필요해지기 전에 저장소 기술·migration·locking을 정하지 않는다. 조기 일반화 금지.

### DL-021 · correlation 결과는 합타입이고 uncorrelated는 정상 출력이다

- 결과는 `correlated` / `uncorrelated(reason)` / `conflict(details)` 셋 중 하나다.
- branch 이름이나 PR 제목으로 추측해 확정하지 않는다([관찰·상관관계 계약 §2](contracts/observation-and-correlation.md#2-pr-correlation-metadata)).
- PR metadata 형식(OD-021)은 AB workstream이 소유하므로 S0에는 **설정으로 주입**한다. S0는 파서와 판정만 갖는다.
- 결과적으로 S0의 correlation 동작은 연결된 PR이 하나도 없는 상태에서도 검증할 수 있다.

### DL-022 · S0는 polling하지 않는다

- 호출 1회 = read-only snapshot 1회다. polling·webhook·reconciliation 조합(OD-023)은 상태를 갱신해야 하는 C1/C2에서 정한다.
- `orchestration check --ack`는 어떤 경우에도 호출하지 않는다. coordinator가 받아야 할 배치를 소비하기 때문이다.

### DL-023 · fixture는 합성으로 만든다

- 실측한 스키마 구조는 그대로 유지하되 값은 지어낸다.
- 근거: 저장소가 public이므로 실데이터 fixture는 redaction 규칙(OD-018/036/064)을 먼저 닫아야 하는데, S0 검증에는 구조만 있으면 충분하다.
- rollover-monitor Stop hook을 `~/.claude/settings.json`에 **추가 항목**으로 등록한다. Orca가 같은 이벤트에 등록한 hook을 지우지 않는다. 명령은 nvm symlink 절대경로를 쓴다. Claude Code 세션 PATH에 `node`가 없을 수 있다.

### DL-024 · S0 출구 조건 충족

로드맵의 [Slice S0](roadmap.md#4-bridge-slice-s0--관찰상관관계-기반) 출구 조건을 다음 근거로 충족했다.

- **같은 입력을 반복해도 같은 entity로 인식됨** — key를 관측 입력에서 결정적으로 파생시킨다. 실제 Orca·GitHub에 대해 snapshot을 두 번 실행했고 기존 9개 entity가 동일하게 재파생됐다. 두 실행 사이에 새로 생긴 Run 1건만 증가했다.
- **누락된 correlation을 추측하지 않고 오류로 식별함** — `vertical-live` PR 5건이 모두 `uncorrelated:no_metadata`로 보고됐다. branch 이름과 제목에 단서가 있어도 확정하지 않는다.
- **실제 sample schema가 문서와 fixture에 반영됨** — 테스트가 실측 응답 형태(`run_required` 오류 payload, gate `options` JSON 문자열, task `created_by_process_incarnation`, `statusCheckRollup`)를 그대로 쓴다.

외부 write는 없다. `check`와 `--ack`는 클라이언트에 넣지 않았다.

S0가 열어둔 것: durable store(OD-043)는 Slack message identity가 필요한 C1에서, ingestion 정책(OD-023)은 상태를 갱신해야 하는 C1/C2에서 정한다.

## 2026-08-22 · worker↔Bridge 계약

### DL-025 · 첫 orchestration Run 전에 세 계약을 닫는다

- OD-021 PR correlation metadata 형식, OD-029 PR/`worker_done` ordering, OD-073 reviewer-result 형식을 확정했다. OD-022는 S0 구현이 이미 만족하므로 함께 닫았다.
- 이유: `/init-orchestrate` 스킬이 이 셋을 대상 repository 계약으로 넘기고 "계약이 없으면 묻는다"고 규정한다. 닫지 않으면 첫 Run이 부팅에서 멈춘다.
- 더 중요한 이유: 닫지 않고 돌리면 첫 Run이 만드는 PR이 영구히 uncorrelated로 남는다. S0의 correlation 계층은 구현·검증됐으나 아직 correlated PR을 관측한 적이 없고, 이 Run이 그 첫 기회다.
- 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 각 확정 기록에 있다.

## 2026-08-22 · summarizer 계약

### DL-026 · summarizer는 OpenAI API의 gpt-5.6-luna를 쓴다

- provider를 인터페이스 뒤에 두고 기본 구현은 OpenAI API `gpt-5.6-luna`다. 설정으로 모델을 바꿀 수 있다.
- 근거: luna 실측 단가 $0.20/$1.20 per MTok으로 월 30 PR 기준 약 $0.24다. `codex exec` CLI는 추가 과금이 없지만 호출당 16,245 input 토큰의 스캐폴딩을 싣고 PR 리뷰어와 같은 구독 할당량을 소모한다. 리뷰어가 throttle되면 orchestration이 멈추므로 월 몇 센트보다 비싼 대가다.
- API key는 `ORCA_SLACK_BRIDGE_OPENAI_KEY`로 주입한다. 관례 이름 `OPENAI_API_KEY`를 쓰지 않는 이유는 DL-015/OD-005와 같다.

### DL-027 · LLM이 만드는 필드를 줄인다

- LLM 출력은 `title`, `what`, `why`, `reviewGist` 넷뿐이다.
- `status`는 PR·Orca 사실에서 결정적으로 파생하고, `risk`는 reviewer-result의 severity 집계로 파생한다. 링크·버튼·검증 주장은 스키마에 없다.
- 근거: 스펙이 "상태별 layout과 action을 코드로 결정한다"와 "source fact에 없는 성공·안전성·검증을 주장하지 않는다"를 요구한다. 스키마에서 제거하면 잘못된 주장이 원천적으로 불가능해진다.
- 실측 근거도 있다. 스키마에 필드 설명 없이 luna를 호출했을 때 review 입력이 없는데도 `reviewGist`를 채우고 `why`에 없던 보안 주장을 넣었다. 검증 계층은 모델과 무관하게 필요하다.

## 2026-08-22 · C1 PR Digest

### DL-028 · C1은 관찰 시점의 사실만 렌더한다

- C1 카드는 reviewer verdict, findings 요약, risk, CI 결론, merged 여부처럼 관찰 시점에 존재하는 사실을 표시한다.
- canonical state machine, transition 정의, merge-ready 판정, 새 commit 뒤 approval 유효성, transition thread는 C2다.
- uncorrelated PR은 정상 관찰 결과지만 카드로 만들지 않는다. branch·제목으로 correlation을 추측하지 않는 DL-021의 결과다.

### DL-029 · C1 durable store를 node:sqlite로 도입한다

- DL-020이 C1에서 도입하겠다고 예고한 durable store를 `node:sqlite`로 실제 도입한다.
- Windows 기본 경로는 `%APPDATA%\orca-slack-bridge\state.db`이고 override를 허용한다. WAL, `schema_version`, 단일 프로세스 가정을 사용하며 파일 lock은 만들지 않는다.
- 외부 DB 의존성을 추가하지 않고, 재시작 뒤 repository+PR의 Slack message identity를 찾아 갱신할 수 있게 한다.

## 2026-08-23 · C1 실측 계약 보강

### DL-030 · 사실은 노출하고 판정은 하지 않는다

- C1은 source fact를 조합해 보여주되 C2에 남겨 둔 정책을 대신 판정하지 않는다.
- `headMatch`는 reviewer가 본 commit과 현재 head가 같은지 여부를 사실로 싣는다. 이전 approval의 유효성은 OD-031의 미결정 범위이므로 C1이 판정하지 않는다.
- 실제 게시 카드가 `병합 완료`, 리뷰 판정 `request_changes`, `reviewer가 본 commit이 현재 head와 다르다`를 함께 표시했다. 서로 다른 source fact를 불편하다는 이유로 숨기거나 하나의 결론으로 덮지 않는다.

### DL-031 · 조용한 실패를 만들지 않는다

- `import.meta.main` 부재, win32의 `APPDATA` 부재, WAL 전환 실패, 상대 store 환경변수, 접근 불가 store, inbox 포화는 모두 던진다.
- 유일한 예외는 상대 `XDG_DATA_HOME`이다. XDG 명세가 상대경로를 invalid로 보고 무시하라고 규정하므로 기본값으로 돌아간다.
- 오류를 빈 결과·기본 성공·`worker_done` 없음으로 바꾸지 않는다. 서로 다른 DB를 열거나 기존 카드 mapping을 잃는 실패는 즉시 드러내야 한다.

### DL-032 · 다중 reviewer_result는 결정적으로 하나를 고른다

- 여러 `reviewer_result`가 있으면 `completedAt`이 가장 최신인 1건을 사용한다.
- `completedAt`이 동률이거나 없으면 task id 사전순으로 고른다. 관찰 순서나 inbox 반환 순서에 의존하지 않는다.

### DL-033 · 요약 호출과 게시를 분리하고 migration은 덧붙인다

- 게이트 A는 요약 입력의 사실 지문으로 summarizer 호출 여부를 정한다. 지문이 같으면 저장된 요약을 재사용하고, head sha처럼 요약 입력이 아닌 값만 움직였을 때는 호출하지 않는다(OD-035).
- 게이트 B는 매번 렌더한 결과의 지문으로 Slack 게시 여부를 정한다. 사실 지문으로 게시까지 막으면 `SummaryFacts`에 없는 PR `state` 변화, 특히 merge가 카드에 반영되지 않는다.
- durable store migration은 `ALTER TABLE ADD COLUMN`처럼 덧붙이는 변경만 허용한다. 기존 DB를 열 수 없게 만드는 파괴적 변경은 message identity를 잃어 Slack 루트 중복을 만들 수 있으므로 이 방식으로 다루지 않는다(OD-043). 현재 `SCHEMA_VERSION`은 2다.
