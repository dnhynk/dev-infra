# 플랫폼 역량과 제약

기준일: **2026-08-22**

이 문서는 Bridge와 orchestration이 의존하는 외부 플랫폼의 **현재 계약**을 정리한다. 각 항목은 공식 문서 확인 또는 로컬 실측에 근거한다. 외부 제품은 바뀌므로 구현 시작과 release 전 다시 확인한다.

권위 있는 사용법은 설치된 binary가 제공하는 version-matched 자료다. 기억이나 오래된 문서로 subcommand·flag·모델 id를 추측하지 않는다.

## 1. 로컬 환경

| 도구 | 버전 | 비고 |
|---|---|---|
| Orca | `1.4.187` | `C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe`, runtime ready |
| Claude Code | `2.1.238` | `C:\Users\dongh\.local\bin\claude.exe` |
| codex-cli | `0.149.0` | `C:\Users\dongh\AppData\Local\Programs\OpenAI\Codex\bin\codex` |
| gh | `2.98.0` | |
| git | `2.55.0.windows.4` | |
| pnpm | `11.22.0` | |
| Python | `3.13.15` | |
| Node.js | **미설치** | PATH의 `C:\Program Files\nodejs`, `.volta\bin`, `.fnm\aliases\default\bin`이 모두 존재하지 않는다. OD-001이 Node를 전제하므로 구현 전 재설치가 필요하다. |

`ORCA_CLI_COMMAND`와 `ORCA_DEV_REPO_ROOT`는 unset이다. Claude 계정은 조직에 속하지 않은 개인 Max이고, Codex는 oauth로 인증돼 있다.

## 2. Orca

### 2.1 권위 자료와 CLI 표면

`orca agent-context --json`이 231개 명령의 machine-readable 스키마(`schemaVersion` v1)를 반환한다. adapter 계약은 이 출력을 1차 자료로 쓴다.

orchestration 하위 29개 명령:

```text
ask, check, coordinator-start, dispatch, dispatch-show, gate-create, gate-list,
gate-resolve, inbox, reply, reset, run-create, run-current, run-list, run-show,
run-use, send, task-create, task-list, task-update, worker-abandon, worker-list,
worker-read, worker-release, worker-retain, worker-show, worker-start, worker-stop
```

`coordinator-start`, `coordinator-stop`, `run`, `run-stop`은 은퇴한 scheduler 명령으로 아무 효과가 없다. **successor coordinator 세션을 만드는 공식 orchestration 명령은 존재하지 않는다.**

`task-list`, `gate-list`, `worker-list`, `check`는 `--run <run_id>`를 받는다. `gate-list` 스키마 note: "--run inspects a named Run without binding; otherwise gates are scoped to the caller." Observer는 `run-list` 뒤 각 Run을 `--run`으로 명시해 binding 없이 읽는다. `--run` 없는 호출은 `run_required` 오류를 반환한다.

### 2.2 응답 envelope와 멱등성

```text
성공: { "id": <uuid>, "ok": true,  "result": {...}, "_meta": { "runtimeId": <uuid> } }
실패: { "id": <uuid>, "ok": false, "error": { "code", "message",
        "data": { "effectsApplied": false, "nextCommandArgs": [...], "nextSteps": [...] } } }
```

`effectsApplied`로 실패 시 mutation 발생 여부를 판정한다.

mutation 응답은 다음을 포함한다.

```json
"mutation": { "requestId": "<retry-request 값 또는 자동 생성 uuid>", "replayed": false }
```

`gate-create`, `gate-resolve`, `run-use`, `send`, `check`, `task-create`, `task-update`가 `--retry-request <id>`를 받는다. 호출자가 정한 임의 문자열을 그대로 받아 echo하므로 Slack action ID를 키로 쓸 수 있다. **같은 키로 재호출하면 상태를 바꾸지 않고 `replayed: true`를 반환한다.**

### 2.3 Run과 Task

`run-list` / `run-show` row:

```json
{
  "id": "run_a48566be983b",
  "objective": "...",
  "home_database": "this_database",
  "coordinator_handle": "term_720b6c26-eb04-4a16-ab79-b226ac50c04f",
  "coordinator_pane_key": "f39db44b-...:8c71884b-...",
  "consumer_generation": 1,
  "legacy": 0,
  "created_at": "2026-08-21T14:32:45Z",
  "updated_at": "2026-08-21T14:32:45Z"
}
```

`coordinator_handle`과 `coordinator_pane_key`는 `run-create` 시 자동으로 채워진다. row에 repository/worktree identity는 없다.

Orca Run은 durable namespace이자 coordinator inbox이며, 플랫폼이 repository-bound entity라고 보장하지 않는다. Run↔Repository는 Bridge 정책으로 정의한다.

`task-list` row:

```json
{
  "id": "task_cd1991c049a8",
  "run_id": "run_a48566be983b",
  "parent_id": null,
  "created_by_terminal_handle": "term_720b6c26-...",
  "created_by_pane_key": "f39db44b-...:8c71884b-...",
  "created_by_process_incarnation": "ccb3c8ee-...::D:/dev-infra@@8c25bfec:f126ab2a-...",
  "created_by_run_generation": 1,
  "task_title": "...", "display_name": "...", "spec": "...",
  "status": "ready", "deps": "[]", "result": null,
  "created_at": "2026-08-21 14:32:57", "completed_at": null
}
```

`created_by_process_incarnation`은 작업 디렉터리(`D:/dev-infra`)를 포함한다. 문자열 안에 인코딩된 값이며 파싱 안정성은 미검증이다.

task status 값: `pending`, `ready`, `dispatched`, `completed`, `failed`, `blocked`.

`task-update --result <json>`은 임의 중첩 객체·배열을 손실 없이 보존한다. **reviewer verdict를 durable하게 남길 자리다.** `--status`를 함께 요구하므로 결과 기록과 상태 전이가 한 호출에 묶인다. 스키마 검증은 하지 않으므로 형식 계약은 읽는 쪽에서 검증한다.

### 2.4 Gate

```json
{
  "id": "gate_ac624dad74b5",
  "run_id": "run_a48566be983b",
  "task_id": "task_cd1991c049a8",
  "question": "...",
  "options": "[\"A: 취소 즉시 종료\",\"B: 결제 기간 종료 시 종료\"]",
  "status": "pending",
  "resolution": null,
  "created_at": "2026-08-21 14:33:10",
  "resolved_at": null
}
```

status 값: `pending`, `resolved`. `gate-list --status pending`으로 필터할 수 있다.

`options`는 배열이 아니라 **JSON 문자열**이고 원소는 설명 없는 평문이다. **선택지에 안정적인 ID가 없다.** `resolution`도 구조 없는 자유 텍스트이며 어떤 option을 골랐는지와 기계적으로 연결되지 않는다.

**Gate 생성·해결이 task status를 자동 전이시킨다.** `gate-create` → task `blocked`, `gate-resolve` → task `ready`. Bridge가 blocked 상태를 따로 계산할 필요가 없다.

**Gate 생성·해결은 어떤 inbox 메시지도 만들지 않는다.** Orca는 Gate 상태 변화를 coordinator에게 push하지 않으므로, coordinator를 깨우는 경로는 Bridge가 제공해야 한다.

#### 중복 resolve를 플랫폼이 막지 않는다

이미 `resolved`인 Gate에 **다른** `--retry-request` 키로 다른 resolution을 보내면 `ok: true`로 **조용히 덮어쓴다.** `resolution`과 `resolved_at`이 갱신되고 오류도 경고도 없다.

`--retry-request`는 같은 요청의 재시도만 멱등화하며 서로 다른 두 요청의 경합은 막지 못한다. 따라서 Bridge가 스스로 보장해야 한다.

- `gate-resolve` 직전에 status를 재확인하고 `pending`이 아니면 거부한다.
- status 확인과 resolve 사이의 TOCTOU를 막기 위해 durable store에서 Gate 단위로 직렬화한다.

#### Slack Gate 카드 요구 대비 부족분

| 카드에 필요한 의미 | Orca Gate 제공 |
|---|---|
| 질문 | `question` |
| 선택지 | `options` (평문 문자열, 설명 없음) |
| 선택지의 안정적 ID | 없음 |
| 각 선택지의 의미 설명 | 없음 |
| coordinator 권장안과 이유 | 없음 |
| 결정 영향 | 없음 |
| 대기 중인 Task 목록 | `task_id` 1건만. 나머지는 `deps`에서 파생 |
| 계속 가능한 독립 Task | 없음 |
| 임의 metadata 필드 | 없음 |

확장 가능한 Gate 필드는 존재하지 않는다. 부족한 의미는 `question`/`options` 문자열 인코딩, Bridge sidecar store, 카드 축소 중 하나로 해결해야 한다.

### 2.5 메시지와 delivery

메시지 타입: `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`, `handoff`, `question`, `decision_gate`, `heartbeat`.

group address: `@all`, `@idle`, `@claude`, `@codex`, `@opencode`, `@gemini`, `@droid`, `@grok`, `@cursor`, `@worktree:<id>`.

`check`의 전달 의미:

- `--wait`: 도착까지 block. 15초마다 stderr에 `_keepalive` JSON을 낸다.
- `--peek`: 읽음 표시 없이 미읽음만 반환.
- `--all`: 읽음 표시 없이 전체 반환.
- `--ack <delivery_id>`: 직전 batch를 확인 처리.
- 스키마 note: "A bound Run replays the same Delivery until --ack; process every message before acknowledging."

> **Observer 제약**: Bridge가 `--ack`를 호출하면 coordinator가 받아야 할 batch를 소비한다. Observer는 `inbox` 또는 `check --peek/--all`만 사용하고 `--ack`를 호출하지 않는다.

`worker_done` 전송 형식:

```bash
orca orchestration send --type worker_done --subject "<status>" --body "<3문장>" \
  --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded \
  --files-modified "path/a,path/b" --json
```

`--outcome succeeded|failed`가 필수다. `--report-path`, `--phase`, `--payload <json>`도 지원하므로 PR identity를 본문 텍스트가 아니라 구조화 필드로 실을 수 있다.

### 2.6 Worker 관찰

`worker-list --terminal-state` 값: `active`, `reclaimable`, `retained`, `release_pending`, `release_unknown`, `released`. terminal 상태는 process accounting이며 Task status와 별개다. 완료된 Task도 live terminal을 소유할 수 있으므로 liveness 판정에 Task status를 대신 쓰면 안 된다.

global `worker-list`는 unbound context에서도 성공하며 일부 row의 `runId + resource.worktreeId`로 Run↔worktree 후보를 얻을 수 있다. historical/released worker도 포함되므로 liveness 증거가 아니고, worker가 없는 Run에는 적용되지 않는다.

`worker-read --source auto|transcript|terminal`. `auto`는 증명 가능한 경우 hook-reported transcript를, 아니면 labeled terminal 출력을 반환한다. released worker도 읽을 수 있다. cursor는 특정 source에 고정되며 Orca가 `source_changed`를 보고하면 새로 읽어야 한다.

`worker-show`의 `observation.agentWait`는 사람만 답할 수 있는 프롬프트에 멈춘 worker를 판정 증거(hook / prompt-text / title)와 함께 보고한다. `null`은 "찾아봤고 없음", **필드 부재는 "보지 않았음"**이며 부재를 "대기 아님"으로 해석하면 안 된다. blocker taxonomy의 `permission pause` source다.

### 2.7 Run ↔ coordinator session ↔ repository identity

Orca가 실행한 Claude 세션에 identity가 환경변수로 주입된다.

```text
ORCA_TERMINAL_HANDLE = term_720b6c26-eb04-4a16-ab79-b226ac50c04f
ORCA_PANE_KEY        = f39db44b-...:8c71884b-...
ORCA_TAB_ID          = f39db44b-...
ORCA_WORKTREE_ID     = ccb3c8ee-...::D:/dev-infra
ORCA_WORKSPACE_ID    = ccb3c8ee-...::D:/dev-infra
ORCA_AGENT_HOOK_PORT = 51594
```

이 값들이 Orca row 필드와 동일하다.

| 환경변수 | 대응 필드 |
|---|---|
| `ORCA_TERMINAL_HANDLE` | Run의 `coordinator_handle` |
| `ORCA_PANE_KEY` | Run의 `coordinator_pane_key`, Task의 `created_by_pane_key` |
| `ORCA_WORKTREE_ID` | Task `created_by_process_incarnation`의 접두부 |

연결 사슬:

```text
Orca Run.coordinator_handle / coordinator_pane_key
   ↕ 동일 값
coordinator 세션의 ORCA_TERMINAL_HANDLE / ORCA_PANE_KEY
   ↓
ORCA_WORKTREE_ID = <workspaceUuid>::<로컬 경로>
   ↓ Git remote
GitHub repository
```

**MCP 서브프로세스가 이 값을 상속한다.** Claude Code가 stdio로 spawn하는 Channel Adapter는 위 변수 전부와 함께 `CLAUDE_CODE_SESSION_ID`를 자기 세션 값으로 받는다. Adapter가 추가 배관 없이 자기 binding을 daemon에 보고할 수 있다.

주의:

- 환경변수는 **주장이지 증명이 아니다.** 프로세스가 값을 위조할 수 있다.
- **`CLAUDE_PID`는 사용하지 않는다.** 서브프로세스가 보는 값은 spawn한 세션이 아니라 조상 세션의 PID다.
- `ORCA_*`는 pane 단위다. coordinator pane 안의 자식 Claude 세션도 같은 값을 상속하므로 세션 구분에는 `CLAUDE_CODE_SESSION_ID`가 필요하다.

### 2.8 Agent 배치 표면

```text
orca orchestration worker-start --task <task_id>
  [--worktree <current|selector|new-child|new-top-level>]
  (--agent <agent> | --terminal <handle>)
  [--model <id>] [--effort <level>]
  [--repo <selector>] [--base-branch <ref>] [--name <name>] [--setup <run|skip|inherit>]
```

`--agent` 값: `claude`, `codex`, `cursor`, `opencode`, `gemini`, `grok`, `droid`, `omp`, `pi`.

제약:

- `--effort`는 `--model`을 요구한다.
- **`--model`/`--effort`는 `--terminal`과 결합할 수 없다.** terminal을 재사용하는 후속 Dispatch는 배치를 바꿀 수 없다.
- fresh agent terminal에만 적용되며 agent 기본 인자를 덮어쓴다.
- 연결된 worker server가 launch-preference 지원을 advertise해야 전달된다.
- 실제 적용 결과는 receipt의 `launch.requested`와 `launch.effective`에 보고된다. **요청값이 아니라 `launch.effective`로 검증한다.**

`--model`은 Orca가 검증하지 않는 opaque provider id다. 유효 값은 각 provider CLI가 정한다.

**Claude**: `--model` alias `opus`, `sonnet`, `fable`, `haiku` 또는 풀네임. `--effort` `low`, `medium`, `high`, `xhigh`, `max`. `ultra`는 없다.

**Codex** (models_cache 기준):

| slug | 기본 effort | 지원 effort | speed tier |
|---|---|---|---|
| `gpt-5.6-sol` | low | low, medium, high, xhigh, max, **ultra** | fast |
| `gpt-5.6-terra` | medium | low, medium, high, xhigh, max, **ultra** | fast |
| `gpt-5.6-luna` | medium | low, medium, high, xhigh, max | fast |
| `gpt-5.5` | medium | low, medium, high, xhigh | fast |
| `gpt-5.4` | medium | low, medium, high, xhigh | fast |
| `gpt-5.4-mini` | medium | low, medium, high, xhigh | 없음 |
| `gpt-5.3-codex-spark` | high | low, medium, high, xhigh | 없음 |

`ultra`("Maximum reasoning with automatic task delegation")는 `gpt-5.6-sol`과 `gpt-5.6-terra`에만 있다.

`service_tiers`는 상위 모델 모두 `{"id": "priority", "name": "Fast", "1.5x speed, increased usage"}` 하나이고 `additional_speed_tiers`는 `["fast"]`다.

`~/.codex/config.toml`의 전역 기본값은 `model = "gpt-5.6-sol"`, `model_reasoning_effort = "xhigh"`다. `--model` 없이 dispatch된 codex worker는 이 값을 쓴다.

사용자 표기 `sol high fast`는 서로 다른 세 축이다: model `gpt-5.6-sol` + effort `high` + service tier `priority`. **`worker-start`에 service tier 인자가 없으므로 tier는 이 경로로 지정할 수 없다.** argv를 직접 구성하는 우회 경로는 supervised worker lifecycle을 벗어나 `worker_done` 권위를 잃는다.

### 2.9 Wake-up 표면

- Orca terminal 입력과 orchestration inbox는 서로 다른 표면이다.
- `terminal send`는 live terminal에 직접 입력한다.
- `orchestration send`는 durable inbox/worker relay다.
- Orca에 Claude Channel을 관리하는 전용 명령은 없다.

## 3. Claude Code

### 3.1 skill 패키징

skill은 `~/.agents/skills/<name>/SKILL.md`에 있다. `~/.claude/skills`는 존재하지 않는다. `~/.agents/.skill-lock.json`이 출처를 기록하며 `orchestration`·`orca-cli`·`computer-use`는 `stablyai/orca` repo에서 설치됐다.

`orchestration/SKILL.md`는 **discovery stub**이다. 본문이 "This file is a discovery stub, not the usage guide"라고 명시하고, 실제 가이드는 `orca skills get orchestration --full`이 버전에 맞춰 서빙한다. 버전 의존 계약을 파일에 고정하지 않는 이 패턴은 `/init-orchestrate`에도 적용할 수 있다.

### 3.2 Orca hook 계측

`~/.claude/settings.json`에 Orca가 설치한 hook이 등록돼 있다: `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`.

모두 `~/.orca/agent-hooks/claude-hook.cmd`를 호출하고 localhost로 보고한다.

```text
POST http://127.0.0.1:%ORCA_AGENT_HOOK_PORT%/hook/claude
  X-Orca-Agent-Hook-Token: %ORCA_AGENT_HOOK_TOKEN%
  paneKey, tabId, launchToken, worktreeId, env, version, payload(stdin)
```

### 3.3 Channels 계약

Channels는 MCP server가 실행 중인 Claude Code session으로 event를 push하는 research preview 기능이다. Claude Code `2.1.80+`가 필요하고, claude.ai 인증 또는 Console API key를 요구하며 Bedrock·Vertex AI·Microsoft Foundry에서는 제공되지 않는다.

server 선언:

| 필드 | 값 |
|---|---|
| `capabilities.experimental["claude/channel"]` | 필수. 항상 `{}`. 존재만으로 listener가 등록된다 |
| `capabilities.experimental["claude/channel/permission"]` | 선택. permission relay를 받겠다는 선언 |
| `capabilities.tools` | 양방향일 때만. reply tool용 |
| `instructions` | Claude system prompt에 추가된다 |

push:

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: { content: '<본문>', meta: { gate_id: '...', decision: 'B' } },
})
```

세션에는 `<channel source="<서버명>" <meta키>="<값>">content</channel>` 형태로 도착하며 `source`는 서버 이름에서 자동 설정된다.

- **`meta` 키는 문자·숫자·밑줄만 허용한다. 하이픈이 든 키는 조용히 버려진다.** `gate_id`는 되지만 `gate-id`는 사라진다.
- Claude Code는 notification을 ACK하지 않는다. `await`는 transport write까지만 보장한다.
- 전달 확인이 필요하면 서버가 event 상태를 추적하고 **reply tool**을 노출해 Claude가 수신을 보고하게 한다. 이것이 공식 권고 경로다.

session opt-in:

```text
claude --channels plugin:<name>@<marketplace>                            # allowlist된 plugin
claude --dangerously-load-development-channels server:<mcp-server-name>  # 개발 중인 custom server
```

- preview 동안 `--channels`는 **Anthropic 관리 allowlist의 plugin만** 받는다. bare MCP server는 development flag 경로다.
- development flag는 **확인 프롬프트 후에** allowlist를 우회한다.
- `.mcp.json` 등록만으로는 push가 활성화되지 않는다. 반드시 flag로 지정해야 한다.
- 두 flag 모두 `claude --help`에 노출되지 않는다. 공식 문서가 "The flags work even though they aren't listed"라고 명시한다.
- 조직 정책 `channelsEnabled`가 꺼져 있으면 MCP는 연결되고 tool도 동작하지만 channel 메시지는 도착하지 않는다. 조직 없는 Pro/Max는 이 검사를 건너뛴다.

공식 자료: [Channels](https://code.claude.com/docs/en/channels) · [Channels reference](https://code.claude.com/docs/en/channels-reference) · [Notification format](https://code.claude.com/docs/en/channels-reference#notification-format) · [Gate inbound messages](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages) · [Permission relay](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)

### 3.4 검증된 동작과 운영 제약

로컬 2.1.238, 개인 Max 계정, Windows 11에서 custom channel end-to-end 전달을 확인했다. 15초 간격 반복 push에 대해 `seq=1`~`18`이 **유실 0, 중복 0**으로 도착했다.

- `source` 속성이 서버 이름으로 자동 설정된다.
- 첫 턴 중 도착한 이벤트는 큐에 쌓였다가 다음 턴에 순서대로 그룹 처리된다.
- Claude가 사용자 입력 없이 새 이벤트마다 자율 반응한다.
- reply tool이 application receipt로 실제 작동한다.
- push부터 Claude가 receipt를 호출하기까지 약 7~10초. transport 지연이 아니라 모델 턴을 포함한 반응 시간이며, 유휴 세션·단일 이벤트 조건의 값이다.

> **운영 제약: channel 이벤트는 대화형 세션에만 도착한다.** 같은 서버·flag·설정으로 `-p` 비대화형 세션은 4가지 구성 모두 미도달이었다. Bridge가 깨울 coordinator 세션은 대화형으로 유지돼야 하며, daemon이 `-p`로 coordinator를 대신 띄우는 설계는 성립하지 않는다.

### 3.5 `@Claude`와의 차이

Claude Code의 Slack coding integration은 coding intent에서 새 cloud/web session과 fresh sandbox를 시작한다. 기존 로컬 coordinator session으로 push하는 요구와 다르다. [Claude Code in Slack](https://code.claude.com/docs/en/slack) · [Channels comparison](https://code.claude.com/docs/en/channels#how-channels-compare)

standard Slack MCP integration은 Claude가 질의할 때 동작하며 외부→세션 push를 제공하지 않는다.

## 4. Slack

### Socket Mode

- 공개 Request URL 대신 앱이 Slack과 WebSocket을 연결해 event와 interactive payload를 받는다.
- 공인 IP·도메인·포트포워딩·ngrok 없이 로컬 PC에서 inbound event를 받을 수 있다.
- outbound 인터넷, app-level token, reconnect 처리가 필요하다.
- Bolt for JavaScript가 공식 지원한다.
- public Marketplace 배포에 제약이 있으나 개인 내부 앱 목표와 충돌하지 않는다.

[Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) · [Bolt for JavaScript Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode)

### Block Kit과 interaction

- message와 modal에 button, menu, text input을 배치할 수 있다.
- button action에서 `views.open`으로 modal을 연다.
- `block_actions`와 `view_submission` payload에 실제 `user.id`가 포함된다.
- handler는 **3초 안에** `ack()`해야 한다.
- 고정 선택지 button은 즉시 ACK 후 Gate 처리를 이어간다.
- 직접 입력 button은 ACK와 `views.open`을 같은 3초 창 안에 끝내야 한다.
- modal submission도 3초 안에 ACK 후 처리를 이어간다.

[Block Kit](https://docs.slack.dev/block-kit/) · [Modals](https://docs.slack.dev/surfaces/modals/) · [Acknowledging requests](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/) · [`block_actions`](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload) · [`view_submission`](https://docs.slack.dev/reference/interaction-payloads/view-interactions-payload/)

### 메시지 갱신

`chat.update`는 channel과 message timestamp로 기존 메시지를 갱신한다. 해당 authenticated bot/user가 직접 작성한 non-ephemeral message만 갱신할 수 있고 `chat:write` scope가 필요하다.

[`chat.update`](https://docs.slack.dev/reference/methods/chat.update/) · [Modifying messages](https://docs.slack.dev/messaging/modifying-messages)

## 5. GitHub

### 5.1 공식 Slack App

- workspace당 한 번 설치하고 여러 repository를 같은 channel에 `/github subscribe owner/repo`로 구독한다.
- 기본 notification은 issues/pulls/default-branch commits/releases/deployments다.
- reviews/workflows/branches/comments/all-branch commits/discussions는 opt-in이다.
- 공식 앱은 raw webhook 채널이 아니라 PR/issue를 thread로 묶고 parent card를 갱신하는 presentation layer다. 따라서 `#github`은 operational notifications, `#pr-digest`는 Bridge semantic view로 정의한다.

[Installing GitHub for Slack](https://docs.github.com/en/integrations/how-tos/slack/integrate-github-with-slack) · [Using GitHub in Slack](https://docs.github.com/en/integrations/how-tos/slack/use-github-in-slack) · [Customizing notifications](https://docs.github.com/en/integrations/how-tos/slack/customize-notifications)

### 5.2 원본 상태 조회

`gh pr view --json`, `gh pr diff`, `gh pr checks`와 REST API에서 PR title/body/branch/commit/files/stats/reviews/comments/checks/merge 사실을 읽을 수 있다.

`statusCheckRollup` 원소:

```json
{
  "__typename": "CheckRun", "name": "ci", "workflowName": "CI",
  "status": "COMPLETED", "conclusion": "SUCCESS",
  "startedAt": "...", "completedAt": "...", "detailsUrl": "..."
}
```

merged PR에서 `mergeable`과 `mergeStateStatus`는 `UNKNOWN`을 반환하고 `mergedAt`·`mergeCommit.oid`는 정상이다. terminal state 판정에는 `state`/`mergedAt`을 쓴다.

review의 "핵심 comment"와 `Merge Ready`는 API 단일 필드가 아니라 Bridge가 정의할 derived 의미다. snapshot polling만으로는 중간 transition을 놓칠 수 있으므로 ingestion/reconciliation 정책이 필요하다.

[`gh pr view`](https://cli.github.com/manual/gh_pr_view) · [`gh pr diff`](https://cli.github.com/manual/gh_pr_diff) · [`gh pr checks`](https://cli.github.com/manual/gh_pr_checks) · [Pull requests REST API](https://docs.github.com/en/rest/pulls/pulls) · [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews) · [Check runs](https://docs.github.com/en/rest/checks/runs)

### 5.3 대상 repository 실측

| repository | PR 수 | GitHub review | `reviewDecision` | CI check |
|---|---|---|---|---|
| `vertical-live` (public) | 31 | 전부 `COMMENTED` | null | 1 |
| `ToneAndMove` | 36 | 0건 | null | 2 |
| `toss_trade` | 49 | 0건 | null | 0 |
| `PostFeel` | 22 | 0건 | null | 1 |

**`reviewDecision`은 모든 repository에서 null이다.** `vertical-live`의 31개 PR에 `APPROVED`나 `CHANGES_REQUESTED`가 한 건도 없다. 원인은 구조적이다 — PR author와 review author가 같은 계정(`dnhynk`)이고 GitHub은 자기 PR을 스스로 approve할 수 없게 막는다. 단일 계정 workflow에서는 formal verdict가 원리적으로 불가능하다.

따라서 **GitHub만 관찰해서는 approve/changes-requested를 알 수 없다.** reviewer verdict의 durable source는 Orca다(DL-016).

check 개수는 repository마다 0~2개로 제각각이고 CI가 아예 없는 repo도 있다. merge-ready 판정에 required check 통과를 전제할 수 없다.

#### review 본문 규약 (repo 국소)

`vertical-live`의 review 본문 구조:

```text
## Verdict: request_changes        ← 또는 approve
## Gates (executed by reviewer)    ← gate | result | evidence 표
## Acceptance criteria
## Findings
- [blocker] path/to/file.ts:750 — ...
- [major]   ...
- [minor]   ...
```

표본에서 `request_changes` 12건, `approve` 4건이 확인됐다. **나머지 세 repository에는 GitHub review 자체가 없으므로 이 규약은 전역 계약이 아니다.**

이 형식이 제공하는 것: verdict 라인, `[blocker]`/`[major]`/`[minor]` severity taxonomy(risk를 추정이 아닌 집계된 사실로 산정), `## Findings`의 blocker 항목(핵심 comment 추출 대상), `## Gates` 표(검증 사실의 근거).

본문은 신뢰 경계상 untrusted content다. 표시용 보조 사실로만 쓰고 상태 source로 삼지 않는다.

PR body에도 `## Task`(`T-ID`, ticket 경로)/`## Why`/`## What` 규약이 있으나 **Orca Run/Task/Dispatch ID는 없다.** correlation metadata는 추가해야 하며 기존 규약과의 공존 형식을 정해야 한다.

## 6. 미검증 항목

- Slack App manifest와 실제 workspace/channel/owner ID
- 실제 `worker_done` body 품질과 transcript fallback 필요 조건
- open PR에서의 `mergeable`/`mergeStateStatus` 값
- GitHub target repository의 branch protection과 merge-ready 정책
- `ORCA_WORKTREE_ID`의 `<uuid>::<path>` 파싱 안정성
- coordinator 재시작 후 terminal/pane handle 유지 여부
- Gate resolve 후 task status가 직전 값으로 복원되는지 아니면 항상 `ready`가 되는지
- 장시간 세션에서의 Channel 안정성과 재시작 시 pending 이벤트 처리
- successor coordinator 세션을 만드는 수단 (`orca-cli` terminal/worktree 계열 미조사)

이 항목을 검증하기 전에는 관련 adapter의 구현 완료를 선언하지 않는다.
