# T3 · Orca Gate와 Run 집계 실측

> [관측] 실측일은 2026-08-23이고, Orca runtime은 `f7140119-fa97-49e8-8d2f-77d1fadcd750`이며 앱 버전은 `1.4.187`이었다.
>
> [관측] 모든 Task/Gate/Dispatch 변경 실험은 별도 `THROWAWAY` Run `run_f039af831871`에서 수행했고, 본 작업 Run `run_36d28e6e947a`와 기존 Run의 Task/Gate/Dispatch는 변경하지 않았다.
>
> [문서] 명령·입력 스키마의 기준은 해당 시점의 `orca skills get orchestration --full`과 `orca agent-context --json` 출력이다.
>
> [관측] 출력 발췌는 필드 이름·타입·상태 전이를 보이는 값만 남겼고, `worker-read`는 dispatch capability를 redacted했다는 warning을 반환했으며 이 문서의 실행 명령도 같은 값을 `<redacted>`로 표기했다.

## 0. 방법과 판정 범위

### [실행 명령]

```powershell
Get-Content -Raw docs/process/working-agreement.md
orca skills get orchestration --full
orca agent-context --json

# 별도 coordinator terminal에서 수행
orca orchestration run-create --objective "THROWAWAY T3 Gate and aggregation observation 2026-08-23" --json
# => run_f039af831871
```

### [출력 발췌]

```text
gate-create  --task <task_id> --question <text> [--options <json_array>]
gate-list    [--task <task_id>] [--status <status>] [--run <run_id>]
gate-resolve --id <gate_id> --resolution <text> [--retry-request <id>]

task status: pending | ready | dispatched | completed | failed | blocked
worker-start ... [--retry-of <dispatch_id>]
ask ... [--options <csv>]
reply --id <msg_id> --body <text>
```

### [관측된 사실]

- [관측] Gate metadata 가설은 “`--options` 객체 배열에 확장 필드를 보존할 수 있다”였고, 객체 배열을 넣어 반증을 시도했다.
- [관측] blocker taxonomy 가설은 “각 blocker 신호가 서로 배타적이라 합계가 곧 고유 blocker 수다”였고, Gate↔blocked Task와 question↔escalation↔dispatched Task라는 두 겹침을 각각 만들어 반증을 시도했다.
- [관측] 진행률 가설은 “Run 시작 뒤 Task 분모가 고정되고 retry가 새 Task로 잡힌다”였고, 실행 중 Task 추가와 한 Task의 다중 Dispatch로 반증을 시도했다.
- [관측] correlation 가설은 “ask의 message/thread/dispatch가 reply와 승격 Gate까지 이어진다”였고, 실제 ask에 reply한 뒤 같은 질문의 Gate를 만들어 필드를 대조했다.
- [관측] crash-window 가설은 “resolved Gate는 Gate ID 기준으로 멱등이고 다시 쓸 수 없다”였고, 동일·상이한 retry request로 두 번 더 resolve해 반증을 시도했다.
- [관측] handler 프로세스 중단을 주입하는 실험은 실행하지 않았으며, 안전하게 특정 `gate-resolve` RPC만 중단시키는 명령이 권위 스키마에 없었다.

### [배제되는 선택지]

- [관측] 기억이나 기존 설계 문서만으로 Orca 동작을 확정하는 방식은 사용하지 않았다.
- [추론] 아래 결과는 이 버전의 로컬 Orca에서 관측한 계약이며, 버전이 바뀌면 같은 명령으로 재검증해야 한다.

### [남는 선택지]

- [추론] D1/D2는 Orca가 직접 반환하는 값과 Bridge가 별도 계산·저장해야 하는 값을 구분해 계약할 수 있다.
- [추론] 이 문서는 OD-019/050/051/067/069를 닫지 않고, 관측으로 배제된 선택지와 남은 선택지만 좁힌다.

## D1이 표시할 수 있는 것과 없는 것

| 표시 요구 | Orca 관측 표면 | 판정 |
|---|---|---|
| 현재 Task 총수와 상태별 수 | [관측] `task-list.result.tasks[]`, `task-list.result.count`, 각 `status` | [추론] D1이 현재 스냅샷을 상태별로 계산해 표시할 수 있다. |
| Task 의존성·결과·시각 | [관측] `deps`·`result`는 JSON 문자열이고 `created_at`·`completed_at`이 있다. | [추론] 파싱·검증 후 표시할 수 있다. |
| Gate 수와 상태·질문·해결문 | [관측] `gate-list.result.gates[]`, `gate-list.result.count`, `status`, `question`, `options`, `resolution`이 있다. | [추론] pending/resolved를 나눠 표시할 수 있다. |
| 질문과 escalation | [관측] `check.result.messages[]`의 `payload`는 JSON 문자열이며, 파싱한 값에 `taskId`·`dispatchId`가 있고 message에는 `type`·`thread_id`가 있다. | [추론] 메시지를 보존하는 observer라면 종류별로 표시할 수 있다. |
| Dispatch 시도 이력 | [관측] `worker-list.result.workers[]`는 Task 하나에 여러 Dispatch 행과 `dispatchStatus`를 반환한다. | [추론] 현재 Task 상태와 별도 attempt 이력으로 표시할 수 있다. |
| 일반적인 agent 대기 | [관측] `worker-show.result.observation.agentWait`가 source·reason·since를 반환했다. | [추론] “agent interaction 대기”로 표시할 수 있다. |
| 진행률 퍼센트와 고정 분모 | [관측] 조회 출력에 progress 또는 denominator 필드는 없고 Task `count`는 실행 중 증가했다. | [추론] 정책 없이는 표시할 수 없다. |
| 권장안·impact·option ID/설명 | [관측] Gate에는 구조화 필드가 없고 options는 문자열 원소만 허용한다. | [추론] 별도 encoding 또는 sidecar 없이는 표시할 수 없다. |
| cancelled Task | [문서] Task status enum에 `cancelled`가 없다. | [추론] Orca 원천 상태로 표시할 수 없다. |
| ask에서 승격된 Gate의 정확한 연결 | [관측] Gate에 message/thread/dispatch 필드가 없다. | [추론] Bridge mapping 없이는 표시할 수 없다. |
| 고유 blocker 한 개의 수 | [관측] Gate↔Task와 question↔escalation↔Task가 각각 겹쳤고, 신호 집합은 서로 배타적이지 않았다. | [추론] dedup 정책 없이는 표시할 수 없다. |
| permission 전용 분류 | [관측] `worker-show.result.observation.agentWait.reason`은 `codex-interactive-prompt`였고 permission enum은 없었다. | [추론] provider별 추가 판정 없이는 “permission”으로 단정할 수 없다. |
| retry의 원 Dispatch ID | [관측] `--retry-of`는 입력으로 받지만 receipt·`worker-list.result.workers[]`·`worker-show.result.worker.startOptions`에 해당 링크가 없었다. | [추론] Bridge가 요청 시점에 저장하지 않으면 정확한 계보를 표시할 수 없다. |
| Gate resolve/outbox 원자성·CAS | [관측] 출력에 transaction/version/outbox 필드가 없고 다른 요청이 resolved Gate를 덮어썼다. | [추론] Orca 조회만으로 보장하거나 표시할 수 없다. |

## (a) OD-050 · Gate metadata

### [실행 명령]

```powershell
orca orchestration gate-create `
  --task task_fdddd3b3f07d `
  --question "Choose mode" `
  --options '[{"id":"fast","label":"Fast","recommended":true,"impact":"higher risk","arbitrary":{"n":1}}]' `
  --json

orca orchestration gate-create `
  --task task_fdddd3b3f07d `
  --question "Recommendation: safe; impact: slower delivery. Choose mode." `
  --options '["fast | impact=higher-risk","safe | recommended=true | impact=slower"]' `
  --json

orca orchestration gate-list --task task_fdddd3b3f07d --json
orca orchestration gate-list --run run_f039af831871 --json

orca orchestration gate-create `
  --task task_3ca8310ee5c7 `
  --question "THROWAWAY free-text decision without options" `
  --json
orca orchestration gate-resolve `
  --id gate_560c94d3ab09 `
  --resolution "arbitrary sentence; no option membership required" `
  --json
```

### [출력 발췌]

```json
{
  "ok": false,
  "error": {
    "code": "runtime_error",
    "message": "Invalid --options: must be a JSON array of strings"
  }
}
```

```text
Gate {
  id: string,
  run_id: string,
  task_id: string,
  question: string,
  options: string,       # JSON-encoded string[]
  status: "pending" | "resolved",
  resolution: null | string,
  created_at: string,
  resolved_at: null | string
}

gate-list.result {
  runId: string,
  gates: Gate[],
  count: number
}
```

```json
{
  "id": "gate_57783bc9ecfe",
  "question": "Recommendation: safe; impact: slower delivery. Choose mode.",
  "options": "[\"fast | impact=higher-risk\",\"safe | recommended=true | impact=slower\"]",
  "status": "resolved",
  "resolution": "second distinct resolution overwrites"
}
```

```json
{
  "id": "gate_560c94d3ab09",
  "options": "[]",
  "status": "resolved",
  "resolution": "arbitrary sentence; no option membership required"
}
```

### [관측된 사실]

- [문서] `gate-create` 입력은 필수 `task:string`, `question:string`과 선택 `options:json_array`, `from:string`, `retry-request:string`, `json:boolean`이다.
- [관측] `--options`의 실제 validator는 JSON 배열이기만 한 값을 받지 않고 `string[]`만 받았으며 객체 원소는 전체 요청을 거부했다.
- [관측] 생성 결과의 `options`는 배열이 아니라 JSON 직렬화된 문자열이고, 원소별 ID·label·recommendation·impact·임의 metadata 필드는 없다.
- [관측] `--options`를 생략하면 저장값은 문자열 `"[]"`였다.
- [관측] `gate-list --task`와 `gate-list --run`은 `runId`, `gates[]`, `count`를 반환했고, 각 Gate의 마지막 resolution과 resolved_at을 재조회할 수 있었다.
- [문서] `gate-list`는 추가로 `--status <status>` 필터를 받는다.
- [관측] 이 실험에서는 `--status` 필터를 실행하지 않아 허용 입력 enum은 관측하지 않았고, Gate 출력값으로는 `pending`과 `resolved`를 관측했다.
- [관측] `gate-resolve --resolution`은 임의 문장을 받았고, options가 비어 있어도 option membership 검증 없이 저장했다.
- [관측] Gate 생성 직후 Gate는 `pending`, Task는 `blocked`가 되었고, resolve 직후 Gate는 `resolved`, 같은 Task는 `ready`가 되었다.

### [배제되는 선택지]

- [관측] option 객체에 `id`, `label`, `recommended`, `impact`를 넣어 Orca가 보존하게 하는 선택지는 배제된다.
- [관측] resolution을 options 중 하나로 제한하거나 구조화 JSON으로 검증해 주는 Orca 계약은 배제된다.
- [추론] recommendation과 impact가 별도 Gate 필드로 이미 존재한다고 가정하는 D1/D2 구현은 배제된다.

### [남는 선택지]

- [추론] `question` 또는 각 option 문자열 안에 recommendation·impact를 직렬화하는 선택지가 남는다.
- [추론] Bridge sidecar에 안정적 option ID·설명·recommendation·impact를 저장하고 Orca Gate ID와 연결하는 선택지가 남는다.
- [추론] Slack 카드의 표현을 Orca 원천 필드만으로 축소하는 선택지가 남는다.
- [추론] **권장(미확정):** 사람이 읽는 `question/options`에는 짧은 요약을 두고, 기계 판정용 metadata는 Bridge sidecar에 두면 자유 텍스트 parsing 의존을 피할 수 있다.

## (b) OD-067 · blocker taxonomy

### [실행 명령]

```powershell
# 실제 저비용 worker: codex / gpt-5.6-luna / medium
orca orchestration worker-start `
  --task task_e104870ce39a `
  --agent codex --model gpt-5.6-luna --effort medium `
  --json

# worker가 자신의 주입된 authority로 실행했으며 capability는 redacted
orca orchestration send `
  --from term_8e2d42b9-de17-47eb-9d21-ceb7b1847757 `
  --dispatch-capability <redacted> `
  --type escalation --subject "THROWAWAY escalation" --body "synthetic blocker" `
  --task-id task_e104870ce39a --dispatch-id ctx_aeee0d54b193
orca orchestration ask `
  --from term_8e2d42b9-de17-47eb-9d21-ceb7b1847757 `
  --dispatch-capability <redacted> `
  --question "THROWAWAY choose alpha or beta" --options "alpha,beta" `
  --timeout-ms 600000

orca orchestration task-list --run run_f039af831871 --json
orca orchestration gate-list --run run_f039af831871 --json
orca orchestration worker-show --dispatch ctx_2d25718d4d31 --json
orca orchestration worker-list --run run_f039af831871 --json
orca orchestration dispatch-show --task task_887575bf004b --json
```

```powershell
# permission 확인 화면에 멈춘 throwaway Codex terminal을 대상으로 한 실제 주입
orca orchestration dispatch --task task_4fd3afb934da --to term_51b2bd39-59ee-416e-877e-2c1f7f7d2a7b --inject --json
orca orchestration worker-show --dispatch ctx_2d25718d4d31 --json
orca orchestration worker-stop --dispatch ctx_2d25718d4d31 --json
orca orchestration worker-show --dispatch ctx_2d25718d4d31 --json
orca orchestration task-list --run run_f039af831871 --json

# agent_prompt_blocked를 같은 Task에 세 번 발생
orca orchestration dispatch --task task_887575bf004b --to term_77c41c37-3f82-4063-877d-728e8c01c323 --inject --json
orca orchestration dispatch --task task_887575bf004b --to term_6b12d1ed-2120-4ec7-a1d0-7b2f42cbf76c --inject --json
orca orchestration dispatch --task task_887575bf004b --to term_6b12d1ed-2120-4ec7-a1d0-7b2f42cbf76c --inject --json
```

### [출력 발췌]

| 신호 | 조회 위치와 발췌 | 같은 시점의 Task 효과 |
|---|---|---|
| Task blocked | [관측] `task-list.result.tasks[].status: "blocked"` | [관측] open Gate 또는 active unsupervised worker stop 뒤 관측했다. |
| open Gate | [관측] `gate-list.result.gates[].status: "pending"`, `gate-list.result.count:number` | [관측] `gate-create`가 같은 Task를 `blocked`로 바꿨다. |
| worker question | [관측] delivery `type:"question"`, self `thread_id`, payload의 `taskId`·`dispatchId` | [관측] ask 대기 중 Task는 `dispatched`였다. |
| escalation | [관측] delivery `type:"escalation"`, `thread_id:null`, payload의 `taskId`·`dispatchId` | [관측] 같은 Dispatch의 question과 함께 존재했고 별도 Task 전이는 없었다. |
| Dispatch failure | [관측] `worker-list.result.workers[].dispatchStatus:"failed"`와 `dispatch-show.result.dispatch.last_failure` | [관측] 원인·lifecycle에 따라 Task가 ready/failed/blocked 중 서로 다르게 관측됐다. |
| circuit break | [관측] `dispatch-show.result.dispatch`의 `status:"circuit_broken"`, `failure_count:3`, `last_failure:"agent_prompt_blocked"` | [관측] Task `task_887575bf004b`는 `failed`가 되었다. |
| permission pause 후보 | [관측] `worker-show.result.observation.agentWait:{source:"prompt-text",reason:"codex-interactive-prompt",since:number}` | [관측] 관측 시 Task와 Dispatch는 `dispatched`였다. |

```json
{
  "observation": {
    "status": "live",
    "exactWorker": true,
    "agentWait": {
      "source": "prompt-text",
      "reason": "codex-interactive-prompt",
      "since": 1787460049061
    }
  }
}
```

```text
attempt 1: dispatchStatus="failed", failure_count=1, last_failure="agent_prompt_blocked", Task="ready"
attempt 2: dispatchStatus="failed", failure_count=2, last_failure="agent_prompt_blocked", Task="ready"
attempt 3: dispatchStatus="circuit_broken", failure_count=3, last_failure="agent_prompt_blocked", Task="failed"
```

```text
worker-stop ctx_2d25718d4d31:
  ok=true
  worker-show.result.dispatch.status="failed"
  worker-show.result.dispatch.last_failure="stopped"
  task-list task_4fd3afb934da.status="blocked"
```

### [관측된 사실]

- [관측] open Gate와 blocked Task는 동일 사건을 두 표면에서 나타내므로 둘을 더하면 한 blocker가 두 번 셈된다.
- [관측] question과 escalation은 같은 `taskId`·`dispatchId`에 동시에 존재했고 Task는 `dispatched`였으므로 이 세 신호도 서로 배타적이지 않다.
- [관측] permission 화면은 `agentWait`로 탐지됐지만 `reason`은 permission 전용 enum이 아니라 일반 `codex-interactive-prompt`였다.
- [관측] Dispatch 실패는 하나의 Task status로 정규화되지 않았고, 최초 두 `agent_prompt_blocked`는 Task를 `ready`로 유지한 반면 세 번째 circuit break는 `failed`로 바꿨다.
- [관측] 다른 active unsupervised Dispatch를 `worker-stop`했을 때 해당 Task `task_4fd3afb934da`는 `blocked`가 되었다.
- [관측] CI failure는 이 Orca 실험에서 실행하지 않았고, 조회한 Orca Task/Gate/Dispatch/message schema에는 CI 전용 상태나 필드가 없었다.

### [배제되는 선택지]

- [관측] 적어도 `blocked Task + pending Gate`와 `unanswered question + escalation + dispatched Task`는 각각 같은 원인을 중복 계산하므로 모든 원천 수를 단순 합산하는 선택지는 배제된다.
- [관측] 모든 Dispatch 실패를 Task `blocked`로 간주하거나, 반대로 모든 blocker를 Task `blocked`에서만 찾는 선택지는 배제된다.
- [추론] `agentWait != null`만으로 permission pause라고 단정하는 선택지는 배제된다.
- [추론] Orca만 조회해 CI blocker까지 완전하게 집계하는 선택지는 배제된다.

### [남는 선택지]

- [추론] 원천별 수치를 별도 badge로 표시하고 같은 `taskId`·`dispatchId`·Gate ID·message ID를 함께 노출하는 선택지가 남는다.
- [추론] 고유 blocker 수가 필요하면 신호 간 우선순위와 dedup key를 제품 정책으로 정하는 선택지가 남는다.
- [추론] permission은 `agentWait`를 넓은 “interaction 대기”로 표시하고 provider별 근거가 더 있을 때만 세분화하는 선택지가 남는다.
- [추론] **권장(미확정):** D1의 1차 화면은 원천별 수를 보존하고, 고유 blocker 총합은 OD-067에서 dedup 정책이 확정된 뒤 추가하는 편이 관측 손실을 줄인다.

## (c) OD-069 · 진행률 분모와 Task/Dispatch 집계

### [실행 명령]

```powershell
# Run에 첫 Task가 있는 동안 두 Task를 추가
orca orchestration task-create --task-title "THROWAWAY dependency root" --spec "THROWAWAY dependency root" --json
# => task_52cb02a2db35, ready
orca orchestration task-create --task-title "THROWAWAY dependent" --spec "THROWAWAY dependent task" --deps '["task_52cb02a2db35"]' --json
# => task_3ca8310ee5c7, pending
orca orchestration task-list --run run_f039af831871 --json

orca orchestration task-update --id task_52cb02a2db35 --status completed --result '{"source":"THROWAWAY manual completion"}' --json
orca orchestration task-list --run run_f039af831871 --ready --json

orca orchestration task-update --id task_3ca8310ee5c7 --status cancelled --json

# 한 Task의 네 failed start와 다섯 번째 성공 retry
orca orchestration worker-start --task task_9d8d868a66a5 --agent codex --model gpt-5.6-luna --effort medium --timeout-ms 1 --json
orca orchestration worker-start --task task_9d8d868a66a5 --agent codex --model gpt-5.6-luna --effort medium --timeout-ms 1 --retry-of ctx_3dbdf6ae0463 --json
orca orchestration worker-start --task task_9d8d868a66a5 --agent codex --model gpt-5.6-luna --effort medium --timeout-ms 1 --retry-of ctx_4fdb9f9a65f9 --json
orca orchestration worker-start --task task_9d8d868a66a5 --agent codex --model gpt-5.6-luna --effort medium --timeout-ms 1 --retry-of ctx_51a574abdff9 --json
orca orchestration worker-start --task task_9d8d868a66a5 --agent codex --model gpt-5.6-luna --effort medium --timeout-ms 120000 --retry-of ctx_c8c3733f2f94 --json

# agent_prompt_stalled 반증 probe: 두 Task spec에 약 8.5KB 반복 padding이 저장돼 있음
orca orchestration worker-start --task task_8b418352aea9 --agent codex --model gpt-5.6-luna --effort medium --timeout-ms 120000 --json
orca orchestration dispatch --task task_4fd3afb934da --to term_51b2bd39-59ee-416e-877e-2c1f7f7d2a7b --inject --json
orca orchestration worker-show --dispatch ctx_92da991815ae --json
orca orchestration worker-show --dispatch ctx_2d25718d4d31 --json

orca orchestration task-list --run run_f039af831871 --json
orca orchestration worker-list --run run_f039af831871 --json
orca orchestration worker-show --dispatch ctx_5a600a29237c --json
```

### [출력 발췌]

```text
Task addition:
  before: count=1
  after root + dependent: count=3
  root: ready -> completed
  dependent: pending -> ready

cancelled update:
  ok=false
  code="invalid_argument"
  message="Invalid --status: expected one of pending, ready, dispatched, completed, failed, blocked"
```

| 실제 자극 | 관측한 Task status 전이 |
|---|---|
| 의존성이 남은 Task 생성 후 root 완료 | [관측] `pending -> ready` |
| Gate 생성 후 resolve | [관측] `ready -> blocked -> ready` |
| 정상 worker 시작 후 성공 보고 | [관측] `ready -> dispatched -> completed` |
| worker 실패 보고 | [관측] `dispatched -> failed` |
| failed Task의 retry 시작 후 성공 보고 | [관측] `failed -> dispatched -> completed` |
| prompt-blocked 실패 3회와 circuit break | [관측] `ready -> failed` |
| active unsupervised worker stop | [관측] `dispatched -> blocked` |

```text
task_9d8d868a66a5 worker-list rows:
  ctx_3dbdf6ae0463  failed     agent_readiness timeout
  ctx_4fdb9f9a65f9  failed     agent_readiness timeout
  ctx_51a574abdff9  failed     agent_readiness timeout
  ctx_c8c3733f2f94  failed     agent_readiness timeout
  ctx_5a600a29237c  completed  worker_done succeeded

current task-list row:
  task_9d8d868a66a5  status="completed"  # exactly one Task row
```

```text
8.5KB worker-start probe ctx_92da991815ae:
  worker-show.result.worker.effects[kind="dispatch_input"].state="accepted"
  worker-show.result.dispatch.status="completed"
  worker-show.result.dispatch.last_failure=null

8.5KB manual inject probe ctx_2d25718d4d31:
  dispatch command ok=true and input accepted
  later permission interaction was observed; operator stop left last_failure="stopped"

agent_prompt_stalled occurrences in both probes: 0
```

```text
final task-list: count=8
  ready=2, completed=3, failed=2, blocked=1, pending=0, dispatched=0

final worker-list: 12 Dispatch rows
  terminalState counts: release_unknown=3, retained=8, released=1
```

### [관측된 사실]

- [문서] Task status enum은 `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked` 여섯 개다.
- [관측] 의존성이 미완료인 Task는 `pending`이었고 root 완료 뒤 자동으로 `ready`가 되었다.
- [관측] Run이 진행 중일 때 Task 두 개를 추가하자 `task-list.result.count`가 1에서 3으로 늘어났으므로 Orca의 Task 집합은 고정 분모가 아니다.
- [관측] `cancelled` update는 argument validation에서 거부됐고 대상 Task 상태는 바뀌지 않았다.
- [관측] `worker_done --outcome failed`는 Task를 `failed`로 만들었고, retry Dispatch도 같은 Task ID를 사용했다.
- [관측] Task `task_9d8d868a66a5`는 네 failed Dispatch 뒤 정상 retry가 성공하자 현재 상태가 `completed`로 바뀌었고 `task-list`에는 계속 한 행만 있었다.
- [관측] 같은 Task의 과거 네 실패와 현재 성공은 `worker-list.result.workers[]`의 다섯 Dispatch 행으로 남았다.
- [관측] `--retry-of`는 실제 입력으로 승인됐지만 worker-start receipt, `worker-list.result.workers[]`, `worker-show.result.dispatch`, `worker-show.result.worker.startOptions` 어느 출력에도 `retry_of` 필드가 없었다.
- [관측] 현재 Task `result`는 마지막 worker report를 담았고, 이전 attempt의 결과를 Task 행에서 별도로 열거하지 않았다.
- [관측] `--timeout-ms 1`의 네 start 실패는 각각 `stage:"agent_readiness"`, `lastError:"timeout"`인 failed Dispatch였고 네 번째 retry도 허용되어 이 경로에서는 circuit break가 발생하지 않았다.
- [관측] 별도 prompt-blocked Task에서는 `agent_prompt_blocked`가 세 번 누적되자 Dispatch가 `circuit_broken`이고 Task가 `failed`가 되었다.
- [관측] 8.5KB prompt를 `worker-start`와 수동 inject로 보내 `agent_prompt_stalled` 재현을 시도했지만 둘 다 입력을 받아들였다.
- [관측] 이 THROWAWAY Run에서는 `agent_prompt_stalled -> blocked` 전이를 재현하지 못했고, 본 작업 Run의 참고 사례는 변경하거나 재실행하지 않았다.
- [관측] Task `failed`와 `blocked`는 최종 스냅샷에서도 각각 2건과 1건으로 별도 상태였다.
- [관측] `worker-list`의 terminalState는 Task 진행 상태와 다른 resource accounting 값이었다.

### [배제되는 선택지]

- [관측] Run 시작 시점 Task 수를 영구 고정 분모로 사용하는 선택지는 실행 중 추가 Task를 반영하지 못한다.
- [관측] retry Dispatch를 새 Task로 세거나 모든 Dispatch 행을 진행률 분모에 더하는 선택지는 같은 작업을 중복 계산한다.
- [관측] Task 현행 행만 저장해 retry 실패 이력을 복원하는 선택지는 배제된다.
- [관측] `cancelled`를 Orca Task 원천 status로 기대하는 선택지는 배제된다.
- [관측] `failed`와 `blocked`를 동일 상태로 합쳐 Orca의 현재 상태 전이를 그대로 설명하는 선택지는 배제된다.

### [남는 선택지]

- [추론] Task를 분모 단위로 삼고 Dispatch는 attempt 이력으로 분리하되, 실행 중 추가된 Task를 즉시 분모에 반영하는 선택지가 남는다.
- [추론] 특정 시점의 scope를 동결해 별도 baseline 분모로 저장하고 이후 추가분을 분리 표시하는 선택지도 남는다.
- [추론] retry 계보가 필요하면 Bridge가 `worker-start --retry-of` 요청과 새 dispatch ID를 sidecar에 함께 기록하는 선택지가 남는다.
- [추론] failed·blocked·completed 중 무엇을 진행률 분자에 넣을지는 Orca 반환값이 아니라 제품 정책으로 남는다.
- [추론] cancelled UX가 필요하면 Bridge 전용 상태로 두거나 Task를 다른 원천 상태와 별도 표시하는 선택지가 남는다.
- [추론] **권장(미확정):** D1은 `현재 Task 상태별 수 / 현재 task-list.count`와 “Dispatch attempts”를 분리 표시하고, 성공률이나 완료율 공식은 OD-069 결정 전 만들지 않는 편이 원천 의미를 보존한다.

## (d) OD-019 · ask/escalation ↔ reply ↔ Gate correlation

### [실행 명령]

```powershell
# worker에서 실행
orca orchestration send --from term_8e2d42b9-de17-47eb-9d21-ceb7b1847757 --dispatch-capability <redacted> --type escalation --subject "THROWAWAY escalation" --body "synthetic blocker" --task-id task_e104870ce39a --dispatch-id ctx_aeee0d54b193
orca orchestration ask --from term_8e2d42b9-de17-47eb-9d21-ceb7b1847757 --dispatch-capability <redacted> --question "THROWAWAY choose alpha or beta" --options "alpha,beta" --timeout-ms 600000

# throwaway coordinator에서 실행
orca orchestration check --terminal term_b1a3cf85-b09a-4011-91bc-7b8d272b2a90 --wait
orca orchestration reply --id msg_3ef10abfedd9 --body "alpha" --json
orca orchestration worker-read --dispatch ctx_624e708c9702 --source transcript --limit 400 --json

# active supervised Dispatch 중 Gate 승격 시도
orca orchestration gate-create --task task_e104870ce39a --question "THROWAWAY choose alpha or beta" --options '["alpha","beta"]' --json

# Dispatch 정산 뒤 다시 실행
orca orchestration gate-create --task task_e104870ce39a --question "THROWAWAY choose alpha or beta" --options '["alpha","beta"]' --json
orca orchestration gate-resolve --id gate_f21183bef7b3 --resolution "alpha" --json
```

### [출력 발췌]

```text
escalation message msg_63ff11f7af72:
  from_handle = "term_8e2d42b9-de17-47eb-9d21-ceb7b1847757"
  to_handle   = "run:run_f039af831871"
  type        = "escalation"
  thread_id   = null
  payload     = JSON string {taskId:"task_e104870ce39a", dispatchId:"ctx_aeee0d54b193"}

question message msg_3ef10abfedd9:
  from_handle = "dispatch:ctx_aeee0d54b193"
  to_handle   = "run:run_f039af831871"
  type        = "question"
  thread_id   = "msg_3ef10abfedd9"  # self-thread
  payload     = JSON string {taskId, dispatchId, question, options:["alpha","beta"]}
```

```text
reply message msg_1c6f...:
  from_handle = "run:run_f039af831871"
  to_handle   = "dispatch:ctx_aeee0d54b193"
  type        = "status"
  thread_id   = "msg_3ef10abfedd9"

question record:
  message_id:string              = "msg_3ef10abfedd9"
  run_id:string                  = "run_f039af831871"
  dispatch_id:string             = "ctx_aeee0d54b193"
  asker_handle:string
  status:string                  = "answered"
  answer_message_id:string       = "msg_1c6f..."
  answer_body:string             = "alpha"
  answered_by_generation:number
  created_at:string
  answered_at:string
  closed_at:null|string
```

```text
active Dispatch gate-create:
  ok=false
  code="task_not_startable"
  message includes "cannot open a gate while supervised Dispatch ... is active"

settled Dispatch gate-create:
  gate_f21183bef7b3 fields = id, run_id, task_id, question, options,
                            status, resolution, created_at, resolved_at
```

```text
archived transcript for retry Dispatch ctx_624e708c9702:
  tool-call command = orca orchestration ask
                      --from term_fb0b2ab9-9700-4e5f-afc3-1e4b99bcc691
                      --dispatch-capability [dispatch capability redacted]
                      --question "THROWAWAY choose alpha or beta"
                      --options "alpha,beta" --timeout-ms 600000
  tool-result output = "alpha. This is the retry attempt: ..."
  worker-read warning = "Dispatch capability tokens were redacted from transcript output."
```

### [관측된 사실]

- [관측] question message는 `thread_id`를 자기 message ID로 시작했고 payload에 Task·Dispatch·question·options가 함께 있었다.
- [관측] coordinator reply는 새 message였고 `thread_id`가 원 question ID이며 question record의 `answer_message_id`가 그 reply ID를 가리켰다.
- [관측] reply의 message `type`은 별도 `reply`가 아니라 `status`였다.
- [관측] escalation은 같은 Task·Dispatch payload를 가졌지만 `thread_id`가 null이었고 question이나 reply ID를 직접 가리키지 않았다.
- [관측] active supervised Dispatch 중 같은 Task에 Gate를 여는 요청은 `task_not_startable`로 거부되었다.
- [관측] Dispatch 정산 뒤 만든 Gate는 ask와 같은 `task_id`·question·options를 가졌지만 message ID, thread ID, dispatch ID, asker, answer message ID 필드가 없었다.
- [관측] 같은 Task의 retry Dispatch `ctx_624e708c9702` archived transcript에는 두 번째 `ask` 호출과 별도 reply body가 남아 있어 Task 한 건에서 ask가 반복된 사실을 확인했다.
- [관측] 두 번째 ask의 coordinator message row는 실험 coordinator가 종료된 뒤 현재 terminal에서 다시 조회할 때 `consumer_fenced`여서 message ID와 self-thread 값은 재조회하지 못했다.
- [추론] 한 Task에 ask가 반복될 수 있고 Gate에는 ask ID가 없으므로 Task ID 하나만으로 ask 한 건을 식별하는 mapping은 모호하다.

### [배제되는 선택지]

- [관측] reply를 독립 `type:"reply"`로 찾는 선택지는 배제된다.
- [관측] Gate row에서 원 ask의 message/thread/dispatch ID를 직접 조회하는 선택지는 배제된다.
- [추론] `task_id`만으로 원 ask와 승격 Gate를 유일하게 연결하는 선택지는 한 Task의 복수 ask에서 모호하다.
- [추론] escalation을 question reply thread에 자동 포함됐다고 간주하는 선택지는 배제된다.

### [남는 선택지]

- [추론] ask를 Gate로 승격할 때 Bridge가 `{askMessageId, questionThreadId, dispatchId, taskId, gateId}` mapping을 durable하게 저장하는 선택지가 남는다.
- [추론] 원 ask ID를 Gate question 문자열에 직렬화하는 선택지도 남지만 사람용 텍스트 parsing에 의존한다.
- [추론] escalation은 payload의 Task·Dispatch까지만 묶고, 별도 명시 링크가 있을 때만 특정 ask/Gate에 귀속하는 선택지가 남는다.
- [추론] **권장(미확정):** Bridge sidecar mapping을 권위 correlation으로 삼고 question 문자열은 표시용으로만 쓰는 편이 복수 ask와 retry를 구분한다.

## (e) OD-051 · Gate resolve crash window와 중복 resolve

### [실행 명령]

```powershell
# 최초 resolve
orca orchestration gate-resolve `
  --id gate_57783bc9ecfe `
  --resolution "custom free-text: canary after review" `
  --retry-request 11111111-1111-4111-8111-111111111111 `
  --json

# 완전히 같은 요청 재생
orca orchestration gate-resolve `
  --id gate_57783bc9ecfe `
  --resolution "custom free-text: canary after review" `
  --retry-request 11111111-1111-4111-8111-111111111111 `
  --json

# 같은 Gate, 다른 요청과 다른 resolution
orca orchestration gate-resolve `
  --id gate_57783bc9ecfe `
  --resolution "second distinct resolution overwrites" `
  --retry-request 22222222-2222-4222-8222-222222222222 `
  --json

orca orchestration gate-list --run run_f039af831871 --json
orca orchestration task-list --run run_f039af831871 --json
```

### [출력 발췌]

```text
first resolve:
  gate.status="resolved"
  gate.resolution="custom free-text: canary after review"
  mutation={requestId:"11111111-1111-4111-8111-111111111111", replayed:false}
  task.status="ready"

same retry request:
  gate.resolution="custom free-text: canary after review"
  mutation={requestId:"11111111-1111-4111-8111-111111111111", replayed:true}

different retry request:
  ok=true
  gate.status="resolved"
  gate.resolution="second distinct resolution overwrites"
  gate.resolved_at=<new timestamp>
  mutation={requestId:"22222222-2222-4222-8222-222222222222", replayed:false}

later gate-list:
  gate_57783bc9ecfe.resolution="second distinct resolution overwrites"
```

### [관측된 사실]

- [관측] 같은 `--retry-request`를 그대로 재전송하면 첫 결과가 반환되고 `mutation.replayed:true`였다.
- [관측] 이미 resolved인 같은 Gate에 다른 retry request를 보내면 conflict나 already-resolved 오류 없이 resolution과 resolved_at을 덮어썼다.
- [관측] 재조회한 resolved Gate에는 마지막 resolution과 resolved_at이 남아 있었다.
- [관측] 최초 resolve 뒤 Task가 `blocked`에서 `ready`로 바뀌었고, `gate-resolve` 응답 자체에는 Task row가 없어 `task-list`로 별도 확인했다.
- [관측] `gate-resolve` 응답에는 Gate와 mutation만 있고 version, compare-and-set token, outbox event, notification 상태 필드는 없었다.
- [관측] RPC handler가 resolution 저장 도중 죽도록 fault injection하는 실험은 실행하지 않았다.
- [관측] 따라서 resolution과 Task 전이 사이의 내부 transaction 원자성, commit 전후 어느 지점에서 client가 결과를 잃는지, 중간 상태가 남는지는 관측 불가다.
- [추론] 한 번의 정상 호출 전후만 조회해 중간 상태를 못 본 사실은 원자성의 증거가 아니다.
- [추론] 동일 retry request 재생은 응답 유실 구간의 재시도를 다루지만, 서로 다른 resolver의 경합은 막지 않는다.

### [배제되는 선택지]

- [관측] resolved Gate가 Gate ID 기준으로 불변이거나 두 번째 resolve가 오류가 된다는 선택지는 배제된다.
- [관측] `--retry-request`가 모든 중복 resolve를 Gate 단위로 멱등화한다는 선택지는 배제된다.
- [추론] Gate status 선확인만으로 check와 resolve 사이의 경쟁을 완전히 막는 선택지는 배제된다.
- [추론] 이 실측만으로 Gate resolve와 외부 Slack/outbox write가 원자적이라고 가정하는 선택지는 배제된다.

### [남는 선택지]

- [추론] Bridge가 Gate별 durable lock/CAS를 두고 pending 선확인과 resolve를 직렬화하는 선택지가 남는다.
- [추론] 동일 논리 요청의 재시도에는 같은 retry request ID를 보존하고 `mutation.replayed`를 처리하는 선택지가 남는다.
- [추론] resolve와 Slack/outbox 사이에는 durable intent/outbox와 사후 reconciliation을 두는 선택지가 남는다.
- [추론] 내부 Gate↔Task transaction 원자성을 확인하려면 Orca가 제공하는 fault-injection 또는 저장소 수준 관찰 수단이 추가로 필요하다.
- [추론] **권장(미확정):** Gate별 직렬화, 동일 retry key 재사용, resolve 전후 재조회, durable outbox reconciliation을 함께 두되 내부 원자성은 보장으로 문서화하지 않는다.

## 실험 자원과 정리 상태

### [실행 명령]

```powershell
orca orchestration task-list --run run_f039af831871 --json
orca orchestration gate-list --run run_f039af831871 --json
orca orchestration worker-list --run run_f039af831871 --json
orca orchestration run-show --id run_f039af831871 --json
orca terminal list --worktree current --json
orca orchestration inbox --terminal term_b1a3cf85-b09a-4011-91bc-7b8d272b2a90 --full --json
orca orchestration check --run run_f039af831871 --all --json
orca agent-context --json
```

### [출력 발췌]

```text
THROWAWAY Run: run_f039af831871
durable Run row: 1
durable Task rows: 8
durable Gate rows: 3, all resolved
durable Dispatch rows: 12
current worktree terminal rows: 1, current task terminal only
resource accounting: release_unknown=3, retained=8, released=1
```

### [관측된 사실]

- [관측] 실험용 live terminal은 모두 stop/release/close를 시도한 뒤 `terminal list --worktree current`에서 사라졌고, 이 worktree에는 현재 작업 terminal 한 개만 남았다.
- [관측] `release_unknown` 3건은 이미 사라진 terminal에 대한 release가 `tab_not_found`를 반환한 durable resource row이며 transcript archive는 `captured`였다.
- [관측] 같은 release retry request를 다시 보냈을 때 `replayed:true`였고 `release_unknown` 상태는 그대로였다.
- [관측] `run-show`는 `run_f039af831871`의 durable Run row를 계속 반환했다.
- [관측] 종료된 experiment coordinator를 대상으로 한 `inbox --full`은 빈 목록을 반환했고, 현재 terminal에서 `check --run ... --all`을 호출하면 `consumer_fenced`로 거부되었다.
- [관측] 따라서 ask/escalation의 message/question durable row가 남았는지 여부는 현재 권한 있는 조회 표면으로 관측 불가이며, 삭제됐다고 간주하지 않았다.
- [문서] 현재 `agent-context`에는 개별 Run을 삭제하는 명령이 없다.
- [관측] global `reset`은 실행하지 않았고, THROWAWAY Run의 Task/Gate/Dispatch 기록은 위 ID와 수량으로 남아 있다.
- [관측] `pnpm install`, test, build는 이 관측 Task 범위에서 실행하지 않았다.

### [배제되는 선택지]

- [추론] durable Run 기록을 지우기 위해 전역 reset을 사용하는 선택지는 다른 Run을 변경하므로 범위 밖이다.

### [남는 선택지]

- [추론] 개별 Run 삭제 수단이 생기기 전까지 `THROWAWAY` 이름과 Run ID로 durable 실험 기록을 식별해 제외하는 선택지가 남는다.
