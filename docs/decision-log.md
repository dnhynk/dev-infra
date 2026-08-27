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
- 정책 표는 [Agent 배치 정책](specs/orchestration-bootstrap-and-continuity.md#42-agent-배치-정책)에 둔다. 각 작업 종류에 대해 agent·model·effort를 지정한다.
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
- `headMatch`는 reviewer가 본 commit과 현재 head가 같은지 여부를 사실로 싣는다. C1은 이전 approval의
  유효성을 판정하지 않았고, C2에서도 이 사실만 표시하고 유효·무효를 판정하지 않기로 확정했다(OD-031).
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
- durable store migration은 `ALTER TABLE ADD COLUMN`처럼 덧붙이는 변경만 허용한다. 기존 DB를 열 수 없게 만드는 파괴적 변경은 message identity를 잃어 Slack 루트 중복을 만들 수 있으므로 이 방식으로 다루지 않는다(OD-043).

## 2026-08-23 · C2 계약 확정

### DL-034 · canonical PR state는 terminal과 직교 축으로 보존한다

- terminal은 `open | closed | merged`이고 `draft`·`review`·`checks`·`mergePolicy`는 직교 축이다. UI 의미 상태는 이 사실들에서 파생한다(OD-030).
- `mergedAt != null`을 `merged` terminal latch로 쓴다.
- 근거: GitHub 표본에서 draft와 review는 open state와 함께 존재했고, merged와 closed-unmerged는 `mergedAt`으로 구분됐다.

### DL-035 · approval은 사실만 표시하고 merge-ready는 required check만 본다

- `headMatch`를 계속 표시하되 이전 approval의 유효·무효는 Bridge가 판정하지 않는다. 새 head마다 재리뷰를 강제하지 않고 repository의 stale-review 설정도 따라가지 않는다(OD-031).
- merge-ready는 base branch의 effective required rule과 current head rollup을 조인해 `missing | pending | failing | passing`을 파생한다. optional check 실패는 merge를 막지 않는다(OD-032). → DL-051에서 열거 보완
- merge queue, required reviews, up-to-date(strict), conversation resolution은 C2 범위 밖이다.
- 근거: stale approval 유지와 dismissal이 모두 관측됐고, 미보고 required는 merge를 막았지만 optional failure가 남은 PR은 실제 merge됐다.

### DL-036 · PR reconciliation은 terminal dominance를 쓴다

- identity는 `(repository databaseId, PR number)`, terminal latch는 `mergedAt`, review/check scope는 `headSha`다(OD-044).
- `merged` downgrade 금지는 timestamp 비교가 아니라 terminal dominance rule이다.
- 동일 head 안의 review/check는 각 resource의 timestamp와 id로 reconcile한다.
- 근거: 같은 PR `updated_at`에서 서로 다른 head가 관측됐고 mergeability와 check run 변화가 PR timestamp를 갱신하지 않아 전역 timestamp last-write-wins가 성립하지 않았다.

### DL-037 · 유실된 Slack 카드는 current 상태만 재생성한다

- GitHub current snapshot, Orca facts, Bridge store identity로 current 카드를 다시 만든다(OD-046).
- 과거 thread의 semantic transition은 재생하지 않는다.
- 근거: GitHub history는 여러 endpoint와 pagination을 합쳐야 하고 status check 보존 기한이 있어 완전 재생을 보장하지 못한다. Slack history 탐색도 현재 scope와 identity만으로 원본을 확정할 수 없다.

### DL-038 · `worker_done`과 `reviewer_result`의 권위를 분리한다

- `worker_done`은 `orca orchestration inbox --terminal "run:<run_id>" --limit <n> --json`에서 읽고, `reviewer_result`는 `task.result`에서 읽는다. `task.result`를 `worker_done`의 권위로 쓰지 않는다(OD-075).
- 근거: `task-update --result`가 기존 worker_report 전체를 대체하지만 Run mailbox에는 원본 `worker_done`이 비소비 상태로 남는 것을 실측했다.

### DL-039 · PR body와 다중 Task 연관을 분리한다

- PR body는 primary/latest Task 하나만 유지하고 PR↔Task N 연관은 Bridge durable store에 따로 저장한다. OD-021 body metadata 형식과 parser 계약은 바꾸지 않는다(OD-076).
- `orca-run`은 있고 필수 `orca-task`가 없는 PR은 invalid/degraded input이다. 별도 `run_correlated` kind는 Run-level 제품 의미가 필요해질 때만 도입한다(OD-077).
- 근거: current body는 다중 Task 이력을 보존하지 못하고 key 누적은 conflict가 되며, run-only 입력은 Task 목적과 `worker_done`을 제공하지 못한다.
- 각 결정의 실측 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-030, OD-031, OD-032, OD-044, OD-046, OD-075, OD-076, OD-077 확정 기록에 있다.

## 2026-08-23 · D1/D2 공통 계약 확정

### DL-040 · ask/reply/Gate correlation과 Gate metadata는 sidecar가 보존한다

- Bridge sidecar의 `{askMessageId, questionThreadId, dispatchId, taskId, gateId}` mapping을 권위 correlation으로 쓰고 Gate question은 표시용으로만 쓴다(OD-019).
- 사람이 읽는 Gate question/options에는 짧은 요약만 두고 안정적 option ID·설명·recommendation·impact는 Orca Gate ID에 연결한 sidecar metadata로 보존한다(OD-050).
- 근거: ask/reply에는 message·thread·dispatch 관계가 있지만 Gate row에는 그 필드가 없고, `--options` 객체 배열은 `runtime_error`로 거부됐다.

### DL-041 · Gate resolve는 Bridge가 직렬화하고 outbox와 reconcile한다

- Gate별 durable lock 또는 CAS, 동일 논리 요청의 retry request ID 재사용과 `mutation.replayed` 처리, resolve 전후 재조회, durable outbox reconciliation을 함께 둔다(OD-051).
- Orca 내부 Gate↔Task transaction 원자성은 보장으로 문서화하지 않는다.
- 근거: 같은 retry ID는 replay됐지만 다른 ID는 resolved Gate를 덮어썼고, Orca 응답에는 version/CAS/outbox 필드가 없었다.

## 2026-08-23 · D1 계약 확정

### DL-042 · Run 집계는 현재 Task와 Dispatch attempt를 분리한다

- `현재 Task 상태별 수 / 현재 task-list.count`와 Dispatch attempts를 분리하고 완료율·성공률 공식은 만들지 않는다. 실행 중 추가 Task는 즉시 분모에 반영하며 Orca에는 `cancelled` 상태가 없다(OD-069).
- blocker는 원천별 badge와 correlation ID로 표시하고 고유 총합은 dedup 정책 뒤로 미룬다. `agentWait`는 interaction 대기로 표시한다(OD-067).
- 모든 degraded 상태는 카드에 표시하되 Channel pending·미해결 Gate·correlation 실패만 thread에 알리고, summarizer failure·source stale은 badge만 표시한다(OD-072).
- 근거: 한 Task의 여러 retry는 한 Task 행과 여러 Dispatch 행으로 남았고, Gate/blocked Task와 question/escalation/Task가 같은 원인을 겹쳐 표현했다. degraded 알림 경계는 실측 없는 제품 판단이다.

### DL-043 · D1은 수동 등록 repository만 관찰한다

- D1은 설정 파일에 수동 등록한 repository만 관찰한다(OD-068).
- 자동 발견, Git remote 기반 자동 등록, 자동 발견된 다중 repository routing은 O1에 남긴다.
- 근거: D1/O1 범위를 나눈 실측 없는 제품 판단이다.

- 각 결정의 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-019, OD-050, OD-051, OD-067, OD-068, OD-069, OD-072 확정 기록에 있다.

## 2026-08-23 · D2 Slack 계약 확정

### DL-044 · Slack inbound는 Socket Mode와 세 겹 identity 검증을 쓴다

- Socket Mode와 `@slack/socket-mode`를 채택한다. 연결 직전 URL 발급, hello App ID 확인, warning/refresh overlap, exponential backoff, ACK/업무 분리를 적용하며 reconnect backlog replay는 보장하지 않는다(OD-041).
- 인증된 Socket에서 `team.id`와 exact `user.id`를 모두 검사하고 설정된 `api_app_id`도 대조한다. 실패 로그에는 token·payload 원문을 남기지 않고 HTTP signing secret 검증은 적용하지 않는다(OD-042).
- 근거: Socket Mode는 현재 로컬 topology에서 공개 endpoint 없이 성립하고, 공식 문서는 3초 ACK·연결 교체 overlap·단절 구간 replay 비보장을 명시한다.

### DL-045 · modal의 로컬 validation은 동기 errors로 돌려준다

- 형식·필수값 오류는 3초 안에 `response_action=errors`로 ACK해 modal을 유지한다(OD-071).
- 원격 Orca resolve는 ACK 전에 기다리지 않는다.
- 근거: Slack의 view submission 계약은 input block ID별 errors를 ACK payload로 받으면 modal을 유지하고, 빈 ACK는 view를 닫는다.

- 각 결정의 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-041, OD-042, OD-071 확정 기록에 있다.

## 2026-08-23 · D3 계약 확정과 별도 Run 분리

### DL-046 · Adapter는 named pipe client이고 Channel payload는 Gate ID뿐이다

- daemon이 named pipe를 listen하고 session별 Adapter가 재시도 client로 연결한다(OD-052).
- binding 자체를 인증하지 않는 대신 Channel payload를 `gate_id`로 제한하고 coordinator가 Orca에서 내용을 다시 읽는다. `CLAUDE_CODE_SESSION_ID`는 routing 식별자일 수 있지만 인증 근거가 아니다(OD-053).
- 근거: Windows named pipe는 daemon 기동 순서 양쪽에서 동작했고, session ID는 env override와 fake hello 두 방향으로 위조됐다.

### DL-047 · application receipt와 Orca 효과를 분리한다

- transport write는 어떤 전달도 증명하지 않고 application receipt만 전달 신호로 쓴다(OD-054).
- Orca 효과는 대상 Gate의 `pending`→`resolved` 전이다(OD-055).
- 세션→daemon 반환은 실제 동작한 reply tool 왕복을 채택하되 이를 유일한 경로라고 규정하지 않는다(OD-059).
- 근거: 네 실패 조건에서는 notification write 성공과 receipt 부재가 갈렸고, 한 성공 조건에서는 둘 다 성립했다. reply tool receipt와 Gate 상태는 각각 독립 조회됐다.

### DL-048 · opt-in과 중복 처리는 probe와 Orca 상태로 판정한다

- session opt-in은 startup dead window를 피한 daemon end-to-end probe만으로 판정한다. parent process command line parsing은 계약으로 채택하지 않는다(OD-058).
- notification마다 `gate_id`로 Orca를 다시 읽고 이미 resolved이며 효과가 반영됐으면 no-op으로 처리한다. 별도 dedup 저장소는 두지 않는다(OD-057).
- delivery는 `receipted`→`consumed` 두 단계로 두고 receipt는 backoff에만 쓰며, consumed 전 event는 재조회 대상으로 남긴다(OD-066).
- 근거: argv/env/initialize는 flag 여부를 구분하지 못했고 startup dead window가 관측됐으며, 플랫폼은 중복을 제거하지 않고 receipt 직후 제거는 효과 전 crash 유실 창을 만들었다.

### DL-049 · D3 구현은 별도 Run으로 분리한다

- development flag가 유일한 배포 경로이고 매 세션 기동 확인이 필요하므로 D3 구현을 이번 Run에서 제외하고 별도 Run으로 산정한다(OD-056).
- allowlist plugin 등재는 이번 결정에 포함하지 않는다.
- 근거: Claude Code 2.1.241에서도 bare server의 `--channels` 등록은 거부됐고 development flag 확인은 기억되지 않았다. Channels는 research preview이며 2.1.238→2.1.241 사이에도 재검증이 필요했다.

- 각 결정의 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-052~OD-059, OD-066 확정 기록에 있다.

## 2026-08-23 · Run identity 계약 확정

### DL-050 · Run row와 consumer generation이 identity의 권위다

- `run-list`가 반환하는 `coordinator_handle`·`coordinator_pane_key`·`consumer_generation`을 권위 있는
  Run/coordinator identity로 쓴다. coordinator 환경변수는 보조 단서일 뿐이다(OD-020).
- repository는 D1의 수동 등록 설정과 연결하고, live/stale Run은 `consumer_generation`으로 구분한다.
  `run-use` 인수 뒤 handle·pane key가 바뀌고 generation이 올라가므로 최초 handle은 유지되지 않는다.
- 근거: Channel Adapter evidence가 env override와 fake hello 두 방향의 위조를 재현했다.
- [문서] 프로젝트의 `~/.claude/skills/init-orchestrate/SKILL.md` §5는 `run-use` 인수 뒤 새 소유자의
  handle·pane key를 기록하고 generation을 올린다고 서술한다.
- [관측] `run-list`에서 승계를 반복한 `run_ebd0bb4592d2`만 generation이 `4`이고, 나머지 일반 Run은
  모두 `1`이다(`run_legacy_local`은 `0`). 이번 Run에서 `run-use` 전후 증가는 직접 관측하지 않았다.
- [추론] 이 분포가 프로젝트 문서와 일치하므로 위 결정을 채택한다. 다만 Orca 플랫폼 가이드에는
  `consumer_generation` 계약이 없으므로, 플랫폼 동작이 바뀌면 live/stale 판정이 깨진다.
- 이 Run에서 `<uuid>::<path>` worktree id가 반복 동작한 것은 관측일 뿐 형식 안정성 보장은 아니며 남은 위험이다.

- 상세 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-020 확정 기록에 있다.

## 2026-08-23 · mergePolicy 축 배선

### DL-051 · mergePolicy 축은 조인 결과 다섯 값과 rule source 상태 두 값을 가진다

- OD-032의 결정은 유지된다. required check만으로 판정하고 optional check 실패는 merge를 막지 않는다.
  바뀐 것은 결정이 아니라 **열거**다. DL-035가 적은 네 값은 구현에서 일곱 값이 됐다.
- 조인 결과는 다섯이다. `failing`·`missing`·`indeterminate`·`pending`·`passing`이며 context별 상태 중
  가장 무거운 것이 축이 된다. `indeterminate`가 DL-035에 없던 값이다.
- rule source의 상태 둘이 조인 결과보다 앞선다. `rules_unreadable`(정책 조회 403)과
  `no_required_rules`(required rule 0개)다. 성격이 달라 조인 결과와 같은 목록에 두지 않는다.
- `indeterminate`의 근거: rule이 GitHub App에 바인딩돼 있고 동명 row는 있으나 보고 주체를 관측할 수 없는
  상태다. `StatusContext`에는 app을 식별하는 field가 GraphQL에 없고 `CheckRun`도 `checkSuite.app`이 null일
  수 있다. `passing`으로 접으면 실측된 false positive(PAT가 만든 동명 status에도 merge는 405)를 통과로
  그리고, `missing`으로 접으면 Expected-App의 정상 보고가 false negative가 된다. 어느 쪽으로도 접지 않는다.
- `no_required_rules`와 `rules_unreadable`을 나누는 근거: 앞은 정상이고 이 축이 merge를 막지 않는다.
  뒤는 rule 집합 자체를 모르므로 관측된 context가 전부 통과해도 충족을 단정할 수 없는 degraded다.
  404는 `rules_unreadable`이 아니다. GitHub이 미보호와 권한 부족에 같은 404를 주어 구분할 사실이 없다.
- `no_required_rules`는 `CI 통과`도 `병합 준비 완료`도 아니다. 통과한 check가 없다. 아무것도 돌지 않은 PR을
  통과로 그리지 않는다.
- 이 축을 headline 다섯 값에 접지 않는다. headline은 PR 전체에 대한 한 줄이고, 거기에 `병합 준비 완료`를
  두면 이 축이 판정하지 않은 merge 조건까지 충족했다는 읽기를 준다. 카드는 축을 자기 자리에서 표시하고
  판정하지 않은 조건을 같은 자리에서 밝힌다.
- 근거는 새로 만들지 않았다. `src/github/required-checks.ts`의 `RequiredCheckState` 주석과
  `src/github/branch-rules.ts`의 `RuleSourceStatus` 주석에 실측과 함께 있고 그 코드는 merge됐다.
- 상세 계약은 [관찰·상관관계 계약](contracts/observation-and-correlation.md) §6에 있다.

## 2026-08-24 · D1 Run↔repository 연결 열쇠

### DL-052 · Run은 설정에 등록한 Orca repository id로 repository에 연결한다

- OD-068은 "설정 파일에 수동 등록한 repository만 관찰한다"까지만 정했고 **무엇으로 Run과 잇는지는
  정하지 않았다.** 그 공백을 채운다. OD-068은 그대로 유효하다.
- 열쇠는 `projects[].orcaRepositoryIds`에 등록하는 Orca repository id다. Task의
  `created_by_process_incarnation`과 worker의 `resource.worktreeId`에 있는 `<id>::<path>`의 `::`
  앞부분과 **exact 문자열 비교**한다. 대소문자를 접지 않는다.
- [관측] Run row에는 repository 필드가 없고, 경로에서 `owner/name`을 얻을 수단도 Orca 조회 표면에
  없다. 관측 가능한 연결점은 저 `<id>::<path>` 하나뿐이다.
- [관측] `worker-list` 전체에서 repository id 하나가 경로 59개를 덮었다. 앞부분은 worktree가 아니라
  repository의 id다. `orca worktree list --json`의 `repoId`가 같은 값이며 같은 행의 `path`와 나란히
  있어 사용자가 등록할 값을 한 번에 찾는다.
- 경로 등록을 기각한 이유: coordinator worktree(`D:/dev-infra`)와 Orca가 만든
  worktree(`C:/Users/dongh/orca/workspaces/dev-infra/<name>`)는 뿌리가 다르다. 한쪽만 등록하면 Run
  절반이 조용히 빠진다. 정규화와 segment 경계 처리도 필요해진다. id 하나가 둘 다 덮는다.
- Git remote는 읽지 않는다. 자동 발견·자동 등록·자동 routing은 O1 범위다(OD-068).
- **남는 위험과 완화책.** `<uuid>::<path>` 형식 안정성은 미검증이고(platform-capabilities §7.1),
  이 id가 Orca 재설치·DB 재생성 뒤에도 유지되는지는 관측하지 않았다. 그래서 등록에 맞지 않는 Run을
  버리지 않고 수와 관측된 id를 함께 노출한다. 카드가 조용히 비는 대신 "등록되지 않은 Run N건"이
  뜬다(OD-072).
- 상세 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-078 확정 기록에 있다.

## 2026-08-24 · 깨진 row 봉쇄

### DL-053 · 파싱·shape 실패는 계속 던지고 호출부가 row 단위로 가둔다

- 엄격 parser의 throw는 유효하다. 파싱 실패를 fallback으로 덮으면 데이터 손실을 조용히 넘기고,
  shape 실패를 관대하게 읽으면 malformed한 값이 카드에 그려진다. 이 결정은 그 선택을 뒤집지 않고
  **실패의 범위만 좁힌다**(OD-079).
- 두 가지를 구분한다. **계약**은 "파싱·shape 실패는 던진다"이고 **범위**는 "row 하나"다. 계약을
  관대하게 바꾸는 것과 범위를 좁히는 것은 같은 일이 아니다.
- 좁히는 지점은 **row 칸에 대한 엄격 parser 호출 전부**다. 확정 시점의 다섯은 task의 `deps`와 `result`,
  그 `result`를 reviewer_result로 읽는 shape 검사(`readReviewerResult`), gate의 `options`,
  `worker_done`의 `payload`였고, D1이 run row의 `consumer_generation`과 task row의 `created_by` 한 벌,
  ask·escalation row의 `payload`를 같은 규칙으로 추가했다. 현재 집합의 권위는
  `orca/client.ts`의 `UnreadableFieldName`이다. 전부 `Read<T>` 한 합타입을 쓰므로 소비자는 "읽지
  못했다"를 "값이 없다"로 접을 수 없다.
- 좁히는 것은 **파싱·shape 검사 호출뿐**이다. `parseOrcaTimestamp`도 CLI 호출도 감싸지 않는다. 감싸는
  범위를 넓히면 진짜 장애가 degraded 한 줄로 축소된다.
- 읽지 못한 것을 없는 것으로 세지 않는다. `digest` 보고와 `--json`이 `degraded`에 runId·row 종류·row
  id·칸 이름·이유를 싣고, `snapshot` 요약은 Run 줄에 `unreadable=<row id>.<칸>`을 붙인다. gate와
  message는 taskId로 자리를 특정할 수 없어 gate id·message id가 그 자리다.
- 카드는 이 사실을 싣지 않는다. degraded를 카드에 항상 표시하는 것은 D1/D2 규칙이고(OD-072),
  C1 카드가 표시하는 degraded는 요약 실패·입력 절단·worker 보고 없음 셋이다. 그래서 같은 관찰에
  읽지 못한 칸이 있는 카드에서 "리뷰 결과 없음"은 **"reviewer_result를 관측하지 못했다"까지만**,
  "worker 보고 없음"은 **"읽은 메시지에는 없었다"까지만** 뜻한다. 그 이상을 뜻하게 하려면
  `ProjectedPr`에 사실을 하나 더 실어야 하고 그것은 이 결정의 범위가 아니다.
- 재현 근거는 [미결정 사항](open-decisions.md)의 OD-079에 있다. 여기서 다시 적지 않는다.

## 2026-08-24 · Run 컬렉션 루트

### DL-054 · 미등록 사실은 Run 카드와 무관하게 도달하는 루트를 따로 갖는다

- OD-078은 "등록 열쇠가 통째로 어긋나 Run이 조용히 사라진다"는 위험을 감수했고, 그 유일한 근거가
  **"미등록 Run을 세어 노출하므로 조용한 실패가 관측 가능해진다"**였다. 그런데 그 수를 표시하는
  자리가 Run 카드 안이라, 등록된 Run이 하나도 없으면 카드도 하나도 없어 수가 어디에도 나타나지
  않았다. **그 구간이 정확히 OD-078이 감수한 실패 모드다.** 이 결정이 그 구멍을 닫는다.
- `#agent-runs`에 컬렉션 루트 메시지를 하나 둔다. **등록된 Run 수와 무관하게 항상 게시한다.**
  조건부로 만들면 완화 장치가 조건부가 되고, 그것이 닫으려는 구멍과 같은 종류의 구멍이다.
- 싣는 것은 이번 관찰의 Run 카드 수, 미등록 Run 수와 목록, 컬렉션 수준 degraded다. 미등록 목록에는
  D1-B가 확정한 구분을 그대로 싣는다 — `unregistered_repository`(조회했더니 등록에 없다)와
  `query_failed`(조회가 실패해 판정할 수 없다)를 한 줄로 접으면 이 카드가 두 사건을 함께 센다.
- **관측 시각을 카드에 싣지 않는다.** 실으면 사실이 그대로여도 관찰마다 렌더 지문이 달라져
  `skip`이 실운영에서 발화하지 않고 매 관찰이 `chat.update`를 낸다. D1-B가 Run 카드에서 확정한
  규칙 그대로다.
- 매핑은 **새 표 `run_collection_message`**(schema v6)에 한 행으로 둔다. `CHECK (id = 1)`이 한 행을
  강제하고, 채널 설정이 바뀌면 새 루트를 만들지 않고 `channel_mismatch`를 드러낸다.
- `run_message` 재사용을 기각한 이유: 그 표의 PRIMARY KEY 컬럼 이름이 `run_key`이고 주석이 "형식은
  `run:<Orca run id>`다"로 못박는다. Run이 아닌 값을 그 칸에 넣으면 컬럼 이름이 거짓이 되는데 컬럼
  rename은 `store/schema.ts`가 금지한 파괴적 변경이라 **되돌릴 수 없는 틀린 이름이 남는다.** 표
  하나의 비용은 일회성이고, 틀린 이름의 비용은 그 파일을 읽는 모든 사람에게 반복된다.
- 루트 재사용·재시작·채널 불일치 판정은 `run_message`와 같고, 닫지 않는 두 창(crash, delivery
  unknown)도 같다. D1은 그 둘을 없앴다고 주장하지 않는다(스펙 §9, OD-051).
- 상세 근거와 기각한 대안은 [미결정 사항](open-decisions.md#확정-기록)의 OD-080 확정 기록에 있다.

## 2026-08-26 · D3 live authority repair와 split-build 관찰

### DL-055 · daemon은 ambient terminal attestation이 아니라 현재 Run coordinator authority를 쓴다

- 별도 프로세스로 실행되는 daemon은 자신을 시작한 terminal의 `ORCA_AGENT_LAUNCH_TOKEN`을 Orca CLI
  child에 전달하지 않는다. 그 token은 daemon identity가 아니라 launching terminal의 attestation이다.
- Gate write 직전에 target Run을 `run-show`로 엄격하게 다시 읽고, 그 시점의
  `coordinator_handle`을 `gate-resolve --from`에 명시한다. `run-use` takeover가 일어날 수 있으므로
  startup 때 잡아 둔 handle을 재사용하지 않는다.
- Run shape가 어긋나거나 current coordinator가 없으면 mutation 전에 fail closed한다. 환경변수
  `ORCA_TERMINAL_HANDLE`은 진단 단서일 뿐 authority가 아니다(DL-050 유지).
- 근거: 사람 승인 live Slack action에서 daemon이 launching terminal attestation을 상속한 채
  `gate-resolve`를 호출하자 authority 충돌이 재현됐다. attestation만 제거하고 current Run handle을
  명시한 동일 retry request는 structured replay로 수렴했으며 중복 mutation을 만들지 않았다.
- 사람이 승인한 Claude Code 2.1.243 interactive session에서 probe receipt, 실제 post-baseline
  Dispatch, 기존 Slack message의 `작업 재개` update, duplicate receipt no-op, daemon restart와
  Adapter reconnect를 관찰했다. 다만 session Adapter는 repair 전 build에서 시작됐고 daemon만 repair
  후 build로 바뀌었으므로 exact immutable build 조건은 충족하지 못했다. 상태는
  `LIVE_CHANNEL_UNVERIFIED`를 유지하고 최종 merged build에서 재수용한다.
- 실제 ID와 payload를 제거한 근거는
  [D3 live Channel acceptance evidence](evidence/d3-live-channel-acceptance.md)에 있다.

## 2026-08-27 · O1 operational closure boundary

### DL-056 · O1 acceptance는 hermetic CI와 disposable Windows 표본을 분리한다

- exact fixed-pipe 경합, durable daemon/job/root intent 복구, outage/backoff, no-repost,
  multi-repository fail-closed, shutdown fence, no-LLM, redaction/status는 하나의 hermetic CI gate로
  실행한다.
- Windows Task-definition 의미 검증은 CI-safe pure test로 유지한다. 실제 Task Scheduler 표본은
  current-user, unique exact target, mock payload, serialized runner만 허용하고 task/process/file 잔존
  aggregate가 모두 0이어야 한다.
- OD-027과 OD-062/063/064/065의 결정은 닫혔다. Windows 표본과 merged-main deployment smoke는
  구현 결정이 아니라 rollout evidence residual로 남긴다.
- O1은 D3 live authority가 아니다. `LIVE_CHANNEL_UNVERIFIED`는 그대로 유지하며 production 설치도
  merged-main startup/status smoke 전에는 완료로 표기하지 않는다.
- redacted 결과와 실행 명령은
  [O1 operational acceptance evidence](evidence/o1-operational-acceptance.md)에 기록한다.

### DL-057 · Windows process-exit recovery는 trigger repetition이 소유한다

- disposable Task에서 action이 시작된 뒤 exit 23을 반환해도 `RestartOnFailure`가 재실행하지 않는
  것을 관찰했다. task/process/file cleanup aggregate는 `0/0/0`이었다.
- MS-TSCH 2.5.4.2에 따라 `RestartOnFailure`는 unmet start condition/action-start failure 경계로
  유지한다. 이미 시작된 daemon process의 종료 복구는 AtLogOn trigger의 duration 없는 PT1M
  repetition으로 분리한다.
- `MultipleInstancesPolicy=IgnoreNew`가 healthy daemon과 repetition의 overlap을 막는다. uninstall은
  exact owned task를 먼저 disable하므로 shutdown fence 뒤 새 외부 work를 시작하지 않는다.
- disposable acceptance는 별도 bounded PT1M TimeTrigger로 exit 23 뒤 두 번째 OS launch와 clean exit
  0을 증명하고, production trigger의 indefinite 의미는 strict pure XML/fingerprint test로 검증한다.

## 2026-08-28 · O1 Task supervisor hotfix

### DL-058 · interactive Task의 PowerShell supervisor window를 hidden으로 고정한다

- exact merged-main production release에서 Task action PowerShell과 `CreateNoWindow` Node daemon 하나가
  시작된 뒤 약 2~4분에 PowerShell만 `0xC000013A`로 끝나 Node가 orphan으로 남았다. 같은 immutable
  inputs와 workload를 Task 밖에서 hidden window로 시작한 control은 240초 동안 parent-owned였고,
  exact-setting 및 단순 parent/child control은 130초를 넘겨 유지됐다.
- managed action에 Windows PowerShell `-WindowStyle Hidden`을 고정하고, action argument를 포함하는
  semantic fingerprint, launcher의 registered Task binding, dynamic `run-now` parser가 omission이나
  non-hidden drift를 모두 거절하게 한다.
- broader console control handler나 별도 native process wrapper는 이 관측된 differentiator를 닫는 데
  필요하지 않아 도입하지 않는다. disposable registered Task가 `Running`인 채 direct PowerShell→Node
  pair 하나를 245초 유지하고 clean exit 뒤 task/process/file residual `0/0/0`을 보여야 한다.
- fixed merged-main release `1eb41697c6c22f51893adbf4e89fdd864bb399d4a6e0fdba8ed4a978cd93fd38`는
  production Task에서 같은 direct pair와 fresh heartbeat를 332초 유지했고 O1 background job 세 개를
  모두 성공시켰다. 이 control로 repair는 accepted하지만, 과거 `0xC000013A`의 특정 console-close
  인과는 직접 관측된 사실이 아니라 근거가 있는 추론으로 남긴다.
- production O1 완료 조건은 hotfix merge 뒤 exact release에서 같은 beyond-boundary ownership을 다시
  관측하는 것이었고, 위 control로 충족됐다. Task가 끝난 뒤 건강한 daemon만 남은 상태는 여전히
  acceptance가 아니다.
