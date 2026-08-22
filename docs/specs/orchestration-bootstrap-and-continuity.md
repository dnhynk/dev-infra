# Orchestration Bootstrap & Continuity 스펙

상태: **Draft · 구현 전**  
해결 대상: **A + B**  
관련 문서: [제품 비전](../product-vision.md), [작업 규약](../process/working-agreement.md), [미결정 사항](../open-decisions.md)

## 1. 목적

이 기능 묶음은 다음 수동 작업을 제거하거나 최소화한다.

1. 새 orchestration coordinator를 시작할 때마다 장문의 부팅 프롬프트를 복사·붙여넣는 작업
2. coordinator의 컨텍스트 열화를 사용자가 직접 감지하고, `HANDOFF.md`를 작성하고, 새 세션을 만든 뒤 같은 부팅 프롬프트를 다시 입력하는 작업

사용자가 원하는 진입점은 다음처럼 짧아야 한다.

```text
/orchestration
/init-orchestrate 데모까지만 구현
```

`/init-orchestrate` 뒤의 문자열은 해당 Run의 추가 범위·우선순위·종료 지점이다. 기존 확정 스펙이나 작업 규약과 충돌할 때 어느 쪽이 우선하는지는 조용히 추론하지 않는다.

## 2. 기능 경계

이 workstream에 포함한다.

- 신규 coordinator의 표준 부팅 행동
- 기존 Run을 이어받는 successor coordinator의 부팅 행동
- coordinator·worker·reviewer의 기본 운영 계약
- 컨텍스트 열화 감지와 handoff 생성 lifecycle
- predecessor와 successor 사이의 안전한 권한 이관
- handoff와 Orca/Git/GitHub 실제 상태의 reconciliation
- 후속 Bridge가 관찰할 수 있는 최소 correlation·완료·Gate 운영 계약

이 workstream에서 직접 구현하지 않는다.

- `#pr-digest`, `#agent-runs`, Slack Block Kit, Socket Mode
- Slack에서 Gate를 해결하는 기능
- GitHub 수집기와 summarizer
- Claude Code permission relay
- `#deploys`, `#prod-alerts`

Bridge 관련 기능은 별도 스펙을 따르되, PR metadata와 Gate 생성 규칙은 이 workstream과 함께 확정해야 한다.

## 3. 부팅 계약

### 3.1 공통 전제

- 본격 구현은 repository의 authoritative spec이 준비된 뒤 시작한다.
- coordinator는 기억에 의존하지 않고 적용할 spec과 작업 규약을 다시 읽는다.
- 어느 문서가 authoritative한지 판단할 수 없거나 필수 spec이 없으면 구현을 시작하지 않는다.
- 흐릿한 제품 요구사항을 그럴듯하게 채우지 않는다.
- 기술적 사실로 해소할 수 있는 불확실성은 공인된 1차 자료와 실제 관측을 근거로 처리한다.
- 근거만으로 하나를 고를 수 없는 제품 판단은 사용자가 판단할 수 있는 수준으로 추상화해 질문한다.
- 사용자 판단에 반대할 근거가 있으면 명시한다.
- 코드 작성 전에 접근법, 변경 이유, 영향 파일·호출자를 제시하고 방향을 합의한다.

### 3.2 Fresh boot

1. 사용자가 `/orchestration`과 `/init-orchestrate <추가 지시>`를 실행한다.
2. 기능은 현재 repository, 적용할 작업 규약, authoritative spec, 기존 Run과 handoff의 존재 여부를 확인한다.
3. Channel Adapter 기능이 설치된 환경에서는 현재 Run/session binding과 session별 channel opt-in을 확인한다.
4. 신규 Run이라면 coordinator는 다음을 제시한다.
   - 이해한 목적과 범위
   - 명시적 제외 범위
   - 변경 이유와 영향 범위
   - 제안 Task DAG
   - worker/reviewer 배치
   - 구현 전에 답이 필요한 불확실성
5. 사용자가 방향을 정하기 전에는 coding worker를 dispatch하거나 코드를 수정하지 않는다.
6. 합의 후에는 사용자의 판단이 정말 필요한 사안을 제외하고 review·수정·merge·다음 ready task dispatch를 이어간다.

### 3.3 Resume boot

successor는 `HANDOFF.md`만 읽고 바로 mutation을 시작하지 않는다.

1. authoritative spec과 작업 규약을 다시 읽는다.
2. `HANDOFF.md`에서 직전 세션의 일시적 현황을 읽는다.
3. Orca Run/Task/Dispatch/Worker/Gate, Git worktree, GitHub PR/review/CI의 live 상태를 다시 조회한다.
4. resolved됐지만 coordinator 처리 여부가 확인되지 않은 Gate와 pending Channel delivery를 다시 조회한다.
5. handoff snapshot과 live 상태의 차이를 식별한다.
6. Channel Adapter 기능이 설치된 환경에서는 successor session의 adapter binding과 session opt-in 상태를 확인한다.
7. 기존 합의 범위 안의 안전한 연속 작업은 반복 승인을 요구하지 않는다.
8. spec 충돌, handoff 모호성, coordinator 권한 중복, 민감한 신규 판단만 사용자에게 올린다.
9. 기존 worker·worktree·PR을 재사용하고 같은 Task를 중복 dispatch하거나 같은 PR을 중복 merge하지 않는다.

`HANDOFF.md`는 spec을 대체하지 않으며 live operational state보다 우선하지 않는다.

## 4. Coordinator 운영 계약

- Task DAG를 만들고 독립 작업을 병렬화한다.
- coding worker는 각 branch가 checkout된 별도 worktree에 배정한다.
- worker는 PR을 만들며 최종 merge를 직접 수행하지 않는다.
- PR review는 전담 Codex agent가 맡는다. 배치는 [Agent 배치 정책](#42-agent-배치-정책)을 따른다.
- reviewer는 승인 또는 수정 요청과 근거를 coordinator에게 반환한다.
- Bridge가 review 상태를 관찰하려면 같은 verdict가 GitHub formal review 또는 별도로 확정한 Orca reviewer-result source에 durable하게 남아야 한다. 어느 source를 계약으로 삼을지는 TBD다.
- coordinator는 review 결과를 간단히 최종 확인한 뒤 merge한다.
- 수정 요청은 가능한 한 원 worker에게 돌리고 재검토한다.
- merge 뒤에는 다음 ready task를 자동으로 지시한다.
- 정말 중요하고 민감해 사용자 판단이 필요한 부분 외에는 orchestration을 무인으로 계속한다.
- 한 Task가 사람 결정을 기다려도 그 Gate와 독립적인 ready task와 worker는 계속 실행한다.
- 사람이 결정해야 하는 제품 문제는 임의로 선택하지 않고 Orca decision gate로 표현한다.

### 4.1 Worker 질문과 사람용 Gate

- worker는 작업 중 불명확성을 발견하면 먼저 해당 Task 문맥으로 coordinator에게 `ask` 또는 escalation을 보낸다.
- coordinator가 확정 spec, 코드, live 상태, 공인 자료로 답할 수 있으면 worker에게 `reply`하고 Gate를 만들지 않는다.
- coordinator도 사용자 제품 판단 없이는 결정할 수 없을 때만 해당 Task에 연결된 Orca Gate를 만든다.
- Gate가 열린 뒤에는 그 결정에 의존하는 Task만 blocked/waiting 상태가 되고 독립 Task는 계속된다.
- Bridge는 worker↔coordinator의 일반 ask/reply를 Slack에 중계하지 않고 사람용 open Gate만 `#agent-runs`에 투영한다.
- ask/escalation과 생성된 Gate의 correlation 형식은 구현 전에 확정한다.

### 4.2 Agent 배치 정책

coordinator는 Task를 dispatch할 때 작업 종류와 난이도에 따라 worker의 brand·model·effort를 선택한다. 모든 worker를 같은 기본 agent로 배치하지 않는다.

**정책 표의 원본은 [`/init-orchestrate` 스킬](../../skills/init-orchestrate/SKILL.md)에 있다.** 스킬은 `~/.claude/skills/`에 전역 1부로 설치되어 모든 repository의 coordinator에 적용되므로, 작업 종류 분류처럼 repository와 무관한 정책은 그쪽이 원본이다. 이 repository는 스킬의 기본 배치를 그대로 쓰며 override하지 않는다.

배치는 `worker-start`의 `--agent`, `--model`, `--effort`로 표현한다. 유효 값과 제약은 [플랫폼 검증 §2.8](../platform-capabilities.md#28-agent-배치-표면)을 따른다.

배치 근거:

- 깊은 추론·기본 구현·디버깅에 Claude 우선, 단순 반복에 `gpt-5.6-luna` `medium`, PR 리뷰에 `xhigh`, 문서 작업에 Codex 우선은 **사용자 판단**이다.
- 병렬 리서치의 `ultra`는 벤더가 이 단계를 "Maximum reasoning with **automatic task delegation**"으로 정의하므로 대응한다.
- 단순 반복의 `gpt-5.6-luna`는 벤더 설명이 "Fast and affordable agentic coding model"이다.
- 사실 정리형 문서의 `gpt-5.6-terra`는 벤더 설명이 "Balanced agentic coding model for everyday work"로, 판단이 적은 정리 작업에 대응한다.
- 리뷰 지적 반영 수정이 원 Dispatch 배치를 따르는 것은 [Coordinator 운영 계약](#4-coordinator-운영-계약)의 "수정 요청은 가능한 한 원 worker에게 돌린다"를 따른 결과다.

`codex-auto-review`("Automatic approval review model for Codex")는 PR 리뷰의 대안 후보이나 모델 선택 UI에 노출되지 않고 동작을 검증하지 않았다. 검증 전에는 채택하지 않는다.

## 5. Worker와 PR 관찰 계약

- worker는 자신에게 배정된 Dispatch를 완료할 때 `worker_done`을 정확히 한 번 보낸다.
- 완료 body는 정확히 세 문장으로 작성한다.
  - 첫 문장: 무엇을 했는가
  - 둘째 문장: 무엇을 발견했는가
  - 셋째 문장: 무엇이 남았는가
- worker는 PR을 만든 뒤 `worker_done`을 보낸다. PR identity는 body에 넣지 않고 PR body 맨 끝의 correlation metadata를 유일한 연결점으로 쓴다(OD-021/029).
- worker가 만드는 PR에는 Bridge가 Run·Task·Dispatch를 정확히 연결할 correlation metadata가 필요하다.
- metadata의 최종 형식과 생성 주체는 [관찰·상관관계 계약](../contracts/observation-and-correlation.md)에서 확정한다.
- coordinator는 metadata가 포함되도록 worker에게 규칙을 전달하되, 형식이 확정되기 전에는 임의 문법을 영구 계약으로 만들지 않는다.

## 6. 컨텍스트 승계 lifecycle

목표 흐름은 다음과 같다.

```text
컨텍스트 열화 위험 감지
  → 사용자에게 상태 알림
  → 안전한 checkpoint에서 handoff 생성·검증
  → predecessor가 신규 mutation을 시작하지 않는 상태로 전환
  → successor coordinator 시작
  → successor가 read-only로 동일 Run과 기존 worker/PR 상태 reconciliation
  → predecessor ownership 반납과 successor ownership 획득을 단일 handover로 확정
  → successor의 mutation 권한 확인
  → orchestration 계속
```

사용자가 매번 열화 감지, handoff 작성, 새 세션 생성, 부팅 프롬프트 입력을 반복하지 않아야 B가 완전히 해결된 것으로 본다.

### 6.1 개념 상태

```text
SPEC_READY
  → BOOTSTRAP_READING
  → AWAITING_DIRECTION
  → RUNNING
  → ROLLOVER_NEEDED
  → CHECKPOINTING
  → HANDOFF_READY
  → SUCCESSOR_RECONCILING
  → RUNNING
  → COMPLETED
```

보조 상태:

- `WAITING_FOR_OWNER`: 판단이 필요한 Task만 정지
- `RESUME_AMBIGUOUS`: handoff와 live 상태 또는 spec이 충돌
- `TRANSFER_FAILED`: durable handoff는 남았지만 successor 인수 실패

이 상태명은 설명용이다. 저장 schema와 enum은 구현 시 별도로 확정한다.

### 6.2 안전 불변조건

- 같은 Run에 dispatch·merge mutation 권한을 행사하는 coordinator가 동시에 둘이 되지 않아야 한다.
- predecessor와 successor의 권한 경계가 불명확하면 새 dispatch·merge를 수행하지 않는다.
- predecessor는 handoff checkpoint 이후 신규 mutation을 시작하지 않는다.
- successor는 reconciliation 전에 mutation하지 않는다.
- successor는 predecessor ownership 반납이 확인된 뒤에만 mutation 권한을 획득한다.
- 이미 실행 중인 독립 worker는 명시적으로 중단하지 않는 한 계속될 수 있다.
- successor는 같은 작업을 중복 dispatch하지 않는다.
- handoff 도중 실패해도 durable checkpoint와 실제 Orca/Git 상태를 보존한다.
- 자동 전환을 검증하지 못했으면 “자동 재개됨”이라고 표시하지 않는다.

single-writer를 어떤 기술로 보장할지는 TBD다.

## 7. Handoff가 보존해야 하는 의미

정확한 파일 형식·필드명·위치는 TBD지만, successor가 다음 정보를 복구할 수 있어야 한다.

- repository, Orca Run, predecessor session identity
- 합의된 목표·범위·명시적 제외 범위
- authoritative spec과 적용한 작업 규약
- 사용자가 확정한 결정과 근거
- 기각된 접근과 기각 이유
- Task DAG의 상태와 의존 관계
- active/completed/released worker와 Dispatch 상태
- worktree, branch, PR, review, CI, merge 상태
- 진행 중 변경과 미커밋 파일
- 실행한 검증 명령과 핵심 출력
- 실행하지 않은 검증
- 디버깅 가설, 관측 결과, 연속 실패 횟수
- open Gate, blocker, 사용자 응답 대기 사항
- 독립적으로 계속할 수 있는 Task
- 바로 수행할 다음 행동과 전제조건
- 인계 시 진행 중이던 외부 효과 또는 비멱등 작업
- rollover를 촉발한 이유
- predecessor 권한 반납과 successor delivery 상태
- coordinator Channel/Adapter binding과 pending resolved Gate 상태

secret과 불필요한 장문 transcript는 handoff에 복사하지 않는다. redaction 규칙은 TBD다.

## 8. 컨텍스트 열화 감지 요구

확정된 행동:

- 컨텍스트가 부담스러워지면 상태를 설명할 수 없게 되기 전에 먼저 알리고 handoff를 제안 또는 시작한다.
- 안전한 checkpoint를 우선한다.
- 중간에 멈출 수 없는 외부 효과가 있다면 완료 여부를 명시한다.
- rollover 때문에 전체 Run의 독립 작업을 불필요하게 정지하지 않는다.

아직 정하지 않은 것:

- token/context telemetry 사용 가능 여부
- 정량 threshold
- 모델 자기 판단과 외부 monitor 중 감지 주체
- 자동 rollover에 대한 최초 Run 승인 범위
- successor 세션 생성·초기화·ACK 방법

## 9. Source of truth

| 정보 | 우선 source |
|---|---|
| 제품 요구사항과 작업 규약 | 확정 spec, `AGENTS.md` |
| orchestration 상태 | Orca live Run/Task/Worker/Gate |
| 코드·worktree 상태 | Git working tree/worktree |
| PR·review·CI·merge 상태 | GitHub 원본 |
| reviewer verdict가 GitHub에 기록되지 않는 경우 | 확정할 Orca reviewer-result source |
| 연속성 snapshot | `HANDOFF.md` |
| 세션 대화 기억 | source of truth로 사용하지 않음 |

제품 의도 충돌은 임의 선택하지 않고 질문한다. 단순 상태 차이는 live system을 기준으로 reconcile하고 차이를 기록한다. 사용자의 미커밋 변경은 보존한다.

## 10. 수용 기준

### A. 부팅 단축

- 긴 템플릿 없이 지정된 두 줄로 동일한 운영 계약을 시작할 수 있다.
- 추가 지시가 해당 Run의 실제 범위를 제한한다.
- 적용한 spec과 작업 규약을 식별할 수 있다.
- 접근법 합의 전에 코드 변경이나 coding dispatch가 발생하지 않는다.
- 모호한 요구는 질문되며 추측으로 구현되지 않는다.
- worker/worktree/PR/reviewer/coordinator merge 흐름이 계약대로 실행된다.

### B. Handoff 생성과 Resume

- 강제로 발생시킨 rollover 상황에서 durable handoff가 생성된다.
- successor가 목표, 결정, Task/PR 현황, 검증, blocker, 다음 행동을 handoff와 live 상태만으로 재구성한다.
- handoff 이후 바뀐 PR/worker 상태를 live source와 reconcile한다.
- 기존 Task·worker·PR·merge를 중복 생성하지 않는다.
- 두 번 실패한 디버깅 접근을 rollover 후 다시 시도하지 않는다.
- 미커밋 변경과 진행 중 외부 효과를 누락하지 않는다.
- material conflict만 사용자에게 올리고 독립 작업은 계속한다.

### B. 자동 rollover 완료

- trigger → checkpoint → successor 시작 → reconciliation → 권한 인수 → 작업 재개의 end-to-end 흐름이 재현된다.
- predecessor가 fenced/반납됐다는 증거 없이 successor가 mutation하지 않는다.
- successor 시작 실패, 알림 유실, 프로세스 재시작 뒤에도 handoff가 남고 안전하게 재시도할 수 있다.
- D3이 설치된 환경에서는 successor Channel Adapter가 올바른 Run/session에 binding되고 session별 opt-in을 통과했음을 확인한다.
- 실제 자동 전환까지 검증되지 않았다면 B 해결 완료를 선언하지 않는다.

모든 수용 테스트는 실행 명령과 출력을 남긴다. 실행하지 않은 테스트는 미검증으로 기록한다.

## 11. 구현 전에 확정할 사항

- skill의 실제 패키징과 `/orchestration`과의 호출 순서
- fresh/resume 판별 방식 또는 명시적 옵션
- authoritative spec 발견 규칙
- `HANDOFF.md` 위치, schema, archive/overwrite, atomic write
- context degradation 신호와 threshold
- successor 세션 생성 및 명령 주입의 공식 수단
- coordinator single-writer 보장 방식
- active worker가 있는 동안 권한을 이관하는 절차
- 여러 Run이 같은 repository에 있을 때 선택 규칙
- Run↔repository↔coordinator session identity
- service tier를 supervised worker 경로에서 지정할 수단
- reviewer verdict의 durable 관찰 source
- ask/escalation↔Gate correlation
- PR correlation metadata 형식
- Fresh/Resume 시 Channel Adapter 자동 등록·session opt-in 검증 책임
- handoff redaction과 transcript 포함 범위
- 자동 rollover 실패의 알림 경로

이 항목은 [미결정 사항](../open-decisions.md)에서 추적한다.
