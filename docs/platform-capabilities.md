# 플랫폼 역량과 제약 검증 기록

기준일: **2026-08-21**  
목적: 제품 비전의 외부 플랫폼 가정을 “공식 문서 확인”, “로컬 관측”, “아직 미검증”으로 구분한다.

외부 제품은 바뀔 수 있으므로 구현 시작과 release 전 다시 확인한다.

## 1. 로컬 Orca

### 환경

- `ORCA_CLI_COMMAND`: unset
- `ORCA_DEV_REPO_ROOT`: unset
- 선택된 CLI: `C:\Users\dongh\AppData\Local\Programs\orca\resources\bin\orca.exe`
- runtime: `1.4.179`, ready (2026-08-21 재확인: `orca status --json` 결과 `appVersion` `1.4.187`, `state` `ready`)

읽기 전용 확인에 사용한 명령 계열:

```text
orca skills get orca-cli
orca skills get orchestration
orca status --json
orca orchestration run-list --json
orca orchestration task-list ... --json
orca orchestration worker-list ... --json
orca orchestration gate-list ... --json
orca terminal list --json
```

### 확인된 orchestration 표면

- Run: list/show
- Task: list, Run/status/ready filter
- Worker: list/show/read
- Gate: create/list/resolve
- Messaging: worker `ask`, coordinator `reply`; `gate-create`는 coordinator가 관리하는 DAG 결정에만 사용
- `worker-list`는 전역 및 Run filter가 가능하다.
- `worker-read`는 가능한 경우 실제 hook-reported transcript를 반환하고 released worker도 읽을 수 있다.

### 관측된 제약

- 현재 cwd가 Run에 binding되지 않은 상태에서 Run ID 없는 `task-list`와 `gate-list`는 `run_required`를 반환했고 mutation은 없었다.
- global `worker-list`는 unbound context에서도 성공하며 일부 row의 `runId + resource.worktreeId`로 Run↔worktree 후보를 연결할 수 있다.
- historical/released worker도 포함되므로 global worker row는 liveness 증거가 아니며 worker가 없는 Run에는 적용되지 않는다.
- Observer는 `run-list` 뒤 Task/Gate 조회에 각 Run을 명시해야 한다.
- `run-list` row에는 repository/worktree identity가 없다.
- 저장된 coordinator handle이 현재 live terminal과 항상 일치하지 않으므로 Run row 존재를 liveness로 해석하면 안 된다.
- terminal handle 또는 worker resource→worktree/repository→Git remote의 추가 correlation이 필요하다.
- Orca Run은 durable namespace/coordinator inbox이며 플랫폼이 repository-bound entity라고 보장하지 않는다. Run↔Repository는 Bridge 정책으로 검증·정의해야 한다.
- 조사 시점에 Gate가 0개여서 실제 open/resolved Gate JSON sample은 확보하지 못했다.

### Wake-up 관련

- Orca terminal 입력과 orchestration inbox는 서로 다른 표면이다.
- terminal send는 live terminal에 직접 입력하는 경로다.
- orchestration send는 durable inbox/worker relay 성격이다.
- 어떤 경로를 coordinator wake-up fallback으로 허용할지는 아직 결정하지 않았다.
- Orca 최상위 help에서 Claude Channel 자체를 관리하는 전용 명령은 확인되지 않았다.

권위 있는 사용법은 설치된 binary가 제공하는 version-matched skill guide이며, 기억이나 오래된 문서로 subcommand/flag를 추측하지 않는다.

## 2. 로컬 Claude Code와 Channels

### 로컬 관측

- 실행 파일: `C:\Users\dongh\.local\bin\claude.exe`
- 버전: `2.1.237` (2026-08-21 재확인: `2.1.238`)
- `claude --help`에는 조사 시점에 `--channels`와 `--dangerously-load-development-channels`가 노출되지 않았다.

help에 보이지 않는다는 사실만으로 미지원이라고 단정하지 않는다. D3 시작 전에 harmless custom Channel smoke test로 실제 등록·notification delivery를 검증해야 한다.

### 공식 문서에서 확인된 사실

- Channels는 MCP server가 **현재 실행 중인 Claude Code session**으로 event를 push하는 research preview 기능이다.
- Claude Code `2.1.80+`가 필요하다.
- event는 session이 열려 있고 해당 channel을 그 session에 opt-in한 동안만 도착한다.
- event는 session queue에 순서대로 쌓인다. Claude가 바쁜 동안 여러 notification이 도착하면 다음 turn에 함께 전달되어 group으로 처리된다.
- notification transport write는 Claude가 실제로 처리했다는 ACK가 아니다.
- channel이 session에 load되지 않았거나 policy가 막으면 notification이 silent drop될 수 있다.
- Standard MCP는 Claude가 tool/resource를 질의하는 일반 사용 방식이고, Channel은 MCP server에 `claude/channel` push capability를 추가한다. 둘을 완전히 별개 protocol이라고 표현하면 부정확하다.
- 공식 목록에는 Telegram, Discord, iMessage가 있고 Slack은 없다. Slack은 custom Channel 대상이다.
- permission relay는 `2.1.81+`에서 opt-in할 수 있으며 Bash/Write/Edit 등 tool approval을 원격 전달할 수 있다. project trust와 MCP server consent는 대상이 아니다.
- sender gating은 room ID가 아니라 실제 sender identity allowlist를 사용해야 한다.
- Channels는 claude.ai 인증 또는 Console API key가 필요하며 Bedrock, Vertex AI, Microsoft Foundry에서는 제공되지 않는다.
- Team/Enterprise는 조직 차원의 enablement가 필요하다. `2.1.80+`는 필요조건이지 충분조건이 아니다.

공식 자료:

- [Push events into a running session with Channels](https://code.claude.com/docs/en/channels)
- [Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Notification format and delivery](https://code.claude.com/docs/en/channels-reference#notification-format)
- [Gate inbound messages](https://code.claude.com/docs/en/channels-reference#gate-inbound-messages)
- [Permission relay](https://code.claude.com/docs/en/channels-reference#relay-permission-prompts)

### 반드시 qualification할 주장

- custom Channel 개발에는 공식 문서상 session별 opt-in이 필요하다. bare MCP server의 공식 개발 문법은 다음과 같다.

  ```text
  claude --dangerously-load-development-channels server:<mcp-server-name>
  ```

- `.mcp.json` 등록만으로는 inbound push가 활성화되지 않는다.
- 자체 marketplace plugin은 공식 또는 조직 allowlist에 없으면 일반 `--channels plugin:...`만으로 실행할 수 없고 preview 기간에는 development flag가 필요하다.
- 2026년 공개 Claude Code issue에는 일부 버전에서 development channel flag가 등록되지 않는 회귀 보고가 있다. 이는 현재 로컬 2.1.237에서 재현 확인한 사실은 아니지만 D3의 선행 smoke test 사유다.

참고 risk report:

- [Development channel registration issue #71792](https://github.com/anthropics/claude-code/issues/71792)
- [Development plugin channel issue #82939](https://github.com/anthropics/claude-code/issues/82939)

### `@Claude`와의 차이

Claude Code의 Slack coding integration은 coding intent에서 새 cloud/web session과 fresh sandbox를 시작하는 흐름이다. 기존 로컬 Orca coordinator session으로 push하는 요구와 다르다.

- [Claude Code in Slack](https://code.claude.com/docs/en/slack)
- [Channels comparison](https://code.claude.com/docs/en/channels#how-channels-compare)

특정 `/plugin install slack@claude-plugins-official` 명령과 현재 manifest는 공식 확인하지 않았다. 스펙은 “standard Slack MCP integration”이라는 일반 capability로만 표현하고, 필요 시 실제 plugin을 별도로 조사한다.

## 3. Slack

### Socket Mode

확인된 사실:

- 공개 Request URL 대신 앱이 Slack과 WebSocket을 연결해 event와 interactive payload를 받을 수 있다.
- 공인 IP·도메인·포트포워딩·ngrok 없이 로컬 PC에서 inbound event를 받을 수 있다.
- outbound 인터넷, app-level token, reconnect 처리는 필요하다.
- Bolt for JavaScript가 Socket Mode를 공식 지원한다.
- Socket Mode 앱은 public Slack Marketplace 배포에 제약이 있으나 개인 내부 앱 목표와는 충돌하지 않는다.

자료:

- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Bolt for JavaScript Socket Mode](https://docs.slack.dev/tools/bolt-js/concepts/socket-mode)

### Block Kit과 interaction

확인된 사실:

- message와 modal에 button, menu, text input을 배치할 수 있다.
- button action에서 `views.open`으로 직접 입력 modal을 열 수 있다.
- `block_actions`와 `view_submission` payload에 실제 `user.id`가 포함된다.
- action/view handler는 3초 안에 `ack()`해야 한다.
- 고정 선택지 button은 즉시 ACK한 뒤 Gate 처리를 이어갈 수 있다.
- 직접 입력 button은 ACK와 `views.open`을 같은 3초 창 안에 완료해야 한다.
- modal submission도 3초 안에 ACK한 뒤 Gate 처리를 이어간다. validation error를 modal에 남길 UX는 별도 결정이 필요하다.

자료:

- [Block Kit](https://docs.slack.dev/block-kit/)
- [Modals](https://docs.slack.dev/surfaces/modals/)
- [Acknowledging requests](https://docs.slack.dev/tools/bolt-js/concepts/acknowledge/)
- [`block_actions` payload](https://docs.slack.dev/reference/interaction-payloads/block_actions-payload)
- [`view_submission` payload](https://docs.slack.dev/reference/interaction-payloads/view-interactions-payload/)

### 기존 메시지 갱신

- `chat.update`는 channel과 message timestamp로 기존 메시지를 갱신한다.
- 해당 authenticated bot/user가 직접 작성한 non-ephemeral message만 갱신할 수 있다.
- `chat:write` scope가 필요하다.

자료:

- [`chat.update`](https://docs.slack.dev/reference/methods/chat.update/)
- [Modifying messages](https://docs.slack.dev/messaging/modifying-messages)

## 4. GitHub와 GitHub Slack App

### 공식 Slack App

확인된 사실:

- GitHub Slack integration은 workspace당 한 번 설치할 수 있다.
- 여러 repository를 같은 channel에 `/github subscribe owner/repo`로 구독할 수 있다.
- 기본 issues/pulls/default-branch commits/releases/deployments notification이 있다.
- reviews/workflows/branches/comments/all-branch commits/discussions는 opt-in이다.
- workflow notification은 workflow run 수준이며 일부 기능에는 추가 권한이 필요하다.

정정된 용어:

- `#github`은 raw webhook payload 채널이 아니다.
- 공식 앱은 PR/issue를 thread로 묶고 parent card를 갱신하는 presentation layer다.
- 따라서 `#github = GitHub 공식 operational notifications`, `#pr-digest = Bridge semantic view`로 정의한다.

자료:

- [Installing GitHub for Slack](https://docs.github.com/en/integrations/how-tos/slack/integrate-github-with-slack)
- [Using GitHub in Slack](https://docs.github.com/en/integrations/how-tos/slack/use-github-in-slack)
- [Customizing notifications](https://docs.github.com/en/integrations/how-tos/slack/customize-notifications)

### GitHub 원본 상태

확인된 사실:

- `gh pr view --json`, `gh pr diff`, `gh pr checks`와 REST API에서 PR title/body/branch/commit/files/stats/reviews/comments/checks/merge 관련 사실을 읽을 수 있다.
- review의 “핵심 comment”는 API 단일 필드가 아니라 Bridge의 선택·요약 결과다.
- `Merge Ready`도 단일 확정 상태가 아니라 mergeability, reviewDecision, required checks, draft/branch policy를 합성한 derived state다.
- 현재 snapshot만 polling하면 중간 transition을 놓칠 수 있으므로 ingestion/reconciliation 정책이 필요하다.

자료:

- [`gh pr view`](https://cli.github.com/manual/gh_pr_view)
- [`gh pr diff`](https://cli.github.com/manual/gh_pr_diff)
- [`gh pr checks`](https://cli.github.com/manual/gh_pr_checks)
- [Pull requests REST API](https://docs.github.com/en/rest/pulls/pulls)
- [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [Review comments](https://docs.github.com/en/rest/pulls/comments)
- [Check runs](https://docs.github.com/en/rest/checks/runs)

## 5. 현재 미검증인 핵심 항목

- 실제 Orca open/resolved Gate JSON schema
- 현재 로컬 Claude Code 2.1.237에서 custom Slack Channel의 end-to-end inbound delivery
- Run과 live coordinator/repository를 안정적으로 연결하는 공식 계약
- Slack App manifest와 실제 workspace/channel/owner ID
- GitHub target repository의 branch protection과 merge-ready 정책
- actual `worker_done` body 품질과 transcript fallback 필요성

이 항목을 검증하기 전에는 관련 adapter의 구현 완료를 선언하지 않는다.

## 6. 로컬 toolchain 관측 (2026-08-21)

| 도구 | 관측 버전 |
|---|---|
| Node.js | `v26.7.0` |
| npm | `11.19.0` |
| pnpm | `11.22.0` |
| gh | `2.98.0` |
| git | `2.55.0.windows.4` |
| Python | `3.13.15` |
| Claude Code | `2.1.238` |
| Orca | `1.4.187` (app running, runtime ready) |

미설치 확인: `yarn`, `bun`, `deno`.

### `node:sqlite` 로컬 확인

Node 26.7.0에서 다음을 실제 실행해 통과했다.

```text
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); db.exec('create table t(a)'); db.prepare('insert into t values (?)').run(1); console.log(db.prepare('select count(*) c from t').get());"
→ [Object: null prototype] { c: 1 }
```

의미: durable store 후보로 SQLite를 쓸 때 Windows에서 네이티브 모듈 컴파일 없이 런타임 내장 API를 쓸 수 있다. 다만 파일 기반 동작, WAL, 동시성, migration, locking은 아직 확인하지 않았으며 OD-043에서 확정한다.

## 7. AB-0 / Size Gate 1차 관측 (2026-08-21)

### 7.1 권위 있는 스키마 원본

`orca agent-context --json`이 231개 명령의 machine-readable 스키마(`schemaVersion` v1)를 반환한다. 명령·flag를 기억이나 예시로 추측하지 말고 이 출력을 adapter 계약의 1차 자료로 쓴다. orchestration 하위에 29개 명령이 있다.

```text
ask, check, coordinator-start, dispatch, dispatch-show, gate-create, gate-list,
gate-resolve, inbox, reply, reset, run-create, run-current, run-list, run-show,
run-use, send, task-create, task-list, task-update, worker-abandon, worker-list,
worker-read, worker-release, worker-retain, worker-show, worker-start, worker-stop
```

### 7.2 이전 기록에 없던 확인된 사실

**Run을 binding하지 않고 조회하는 경로가 있다.**
`task-list`, `gate-list`, `worker-list`, `check`가 `--run <run_id>`를 받는다. `gate-list`의 스키마 note는 "`--run` inspects a named Run without binding; otherwise gates are scoped to the caller"라고 명시한다. `--run` 없는 `gate-list`는 `run_required`를 반환하고 `data.effectsApplied: false`를 함께 준다. 즉 Observer는 `run-list` → 각 Run에 `--run` 명시 경로로 binding 없이 읽을 수 있다.

**`--retry-request <id>` 멱등성 키가 CLI 표면에 존재한다.**
`gate-create`, `gate-resolve`, `run-use`, `send`, `check`가 이 flag를 받는다. Bridge가 Slack action ID에서 파생한 안정적인 키를 넘기면 crash window에서의 중복 resolve를 플랫폼 수준에서 막을 수 있는 후보다. OD-051과 "같은 action이 Gate를 두 번 resolve하지 않는다" 불변조건에 직접 관련된다. 실제 중복 호출 동작은 아직 검증하지 않았다.

**메시지 전달에 명시적 delivery/ack 의미가 있다.**
`check`는 `--wait`(도착까지 block, 15초마다 stderr에 `_keepalive` JSON), `--peek`(읽음 표시 없이 미읽음만), `--all`(읽음 표시 없이 전체), `--ack <delivery_id>`를 가진다. 스키마 note: "A bound Run replays the same Delivery until `--ack`; process every message before acknowledging."

> **설계 위험**: Bridge가 `--ack`를 호출하면 coordinator가 받아야 할 배치를 소비해 버린다. Observer는 `inbox` 또는 `check --peek/--all`만 쓰고 `--ack`를 절대 호출하지 않아야 한다. OD-023(ingestion 방식)은 이 제약 위에서 결정한다.

**사람 대기 상태에 증거 기반 관측 필드가 있다.**
`worker-show`의 `observation.agentWait`는 사람만 답할 수 있는 프롬프트에 멈춘 worker를 hook/prompt-text/title 중 무엇으로 판정했는지와 함께 보고한다. `null`은 "찾아봤고 없음", 필드 부재는 "보지 않았음"이며 부재를 "대기 아님"으로 해석하면 안 된다. OD-067 blocker taxonomy의 `permission pause` 항목에 쓸 수 있는 실제 source다.

**terminal 상태와 Task 상태는 별개 축이다.**
`worker-list --terminal-state`의 값은 `active|reclaimable|retained|release_pending|release_unknown|released`이며, note는 "process accounting"이고 "완료된 Task도 live terminal을 소유할 수 있다"고 명시한다. liveness 판정에 Task status를 대신 쓰면 안 된다.

**`worker-read`는 source가 전환될 수 있다.**
`--source auto|transcript|terminal`이고 cursor는 특정 source에 고정된다. Orca가 `source_changed`를 보고하면 새로 읽어야 한다. OD-025의 fallback 규칙은 이 전환을 포함해야 한다.

**`coordinator-start`는 은퇴했다.**
스키마 note가 "This command performs no effects"라고 명시한다. 즉 Orca CLI에는 successor coordinator 세션을 만드는 공식 명령이 없다. OD-015의 후보 하나가 제거됐고, 세션 생성 수단은 `orca-cli` 계열 terminal/worktree 표면에서 따로 확인해야 한다.

**`run-use --takeover-legacy`가 인수 경로 후보다.**
note: "must run in the live coordinator agent terminal it binds; it preserves existing worker assignments." OD-016(single-writer·권한 이관)에 직접 관련된 실제 메커니즘이다. 다만 "live coordinator terminal에서 실행"이 전제라 predecessor fencing과 어떻게 결합되는지는 미검증이다.

**`worker_done`은 3문장 body만 나르지 않는다.**
`send`는 `--outcome succeeded|failed`를 `worker_done`에 요구하고 `--task-id`, `--dispatch-id`, `--files-modified <csv>`, `--report-path <path>`, `--phase`, `--payload <json>`을 지원한다. OD-029(PR identity를 어디에 실을지)의 후보 carrier가 body 텍스트 말고도 존재한다는 뜻이다.

**응답 envelope 형태.**

```text
성공: { "id": <uuid>, "ok": true,  "result": {...}, "_meta": { "runtimeId": <uuid> } }
실패: { "id": <uuid>, "ok": false, "error": { "code", "message",
        "data": { "effectsApplied": false, "nextCommandArgs": [...], "nextSteps": [...] } } }
```

`effectsApplied`는 실패 시 mutation 여부를 판정할 수 있게 해준다.

### 7.3 `run-list` row의 실제 필드

```json
{
  "id": "run_legacy_local",
  "objective": "Legacy orchestration state (inspect only)",
  "home_database": "this_database",
  "coordinator_handle": null,
  "coordinator_pane_key": null,
  "consumer_generation": 0,
  "legacy": 1,
  "created_at": "2026-08-21T11:34:41Z",
  "updated_at": "2026-08-21T11:34:41Z"
}
```

repository/worktree identity가 없다는 기존 기록이 확인됐다. 다만 `coordinator_handle`과 `coordinator_pane_key` 필드는 존재하므로, 값이 채워진 실제 Run에서 이 둘이 live terminal 판정에 쓸 수 있는지 다시 확인해야 한다(OD-020).

### 7.4 현재 환경에 실데이터가 없다

관측 시점 상태:

```text
run-list      → run_legacy_local 1건 (legacy: 1, "inspect only")
worker-list   → workers: [], counts: {}
inbox         → messages: [], count: 0
gate-list  --run run_legacy_local → gates: [], count: 0
task-list  --run run_legacy_local → tasks: [], count: 0, legacyReadOnly: true
```

즉 **Size Gate가 요구하는 실제 Run/Task/Worker/Gate/`worker_done` fixture는 관측만으로 확보할 수 없다.** 실제 orchestration Run을 한 번 돌려야 한다. Gate JSON schema가 여전히 미확보라는 기존 기록도 그대로 유효하다.

### 7.5 Claude Code channel flag 재확인

`claude 2.1.238 --help`에도 `--channels`와 `--dangerously-load-development-channels`가 노출되지 않는다(2.1.237 관측과 동일). `--mcp-config`, `--plugin-dir`, `--plugin-url`, `mcp`, `plugin` 서브커맨드는 존재한다. D3의 선행 smoke test 사유가 유지된다.

## 8. Gate 계약 실측 (2026-08-21)

throwaway Run `run_a48566be983b`("THROWAWAY fixture capture ... safe to delete")에서 실제로 생성·조회·resolve하며 관측했다. 이전 기록의 "Gate가 0개여서 실제 JSON sample을 확보하지 못했다"를 대체한다.

### 8.1 실제 Gate schema

```json
{
  "id": "gate_ac624dad74b5",
  "run_id": "run_a48566be983b",
  "task_id": "task_cd1991c049a8",
  "question": "구독 취소 시 서비스 이용 권한을 언제 종료할까?",
  "options": "[\"A: 취소 즉시 종료\",\"B: 결제 기간 종료 시 종료\"]",
  "status": "pending",
  "resolution": null,
  "created_at": "2026-08-21 14:33:10",
  "resolved_at": null
}
```

관측된 `status` 값: `pending`, `resolved`. `gate-list --status pending`은 정상 동작한다.

`options`는 배열이 아니라 **JSON 문자열**이고, 원소는 **설명 없는 평문 문자열**이다. **선택지에 안정적인 ID가 없다.** `resolution`도 구조가 없는 자유 텍스트이며 어떤 option을 골랐는지와 기계적으로 연결되지 않는다.

### 8.2 Slack Gate 카드 요구 대비 부족분

[Slack UX](ux/slack-surfaces.md#32-gate-결정-카드)와 [Bridge 스펙 6.2](specs/orca-slack-bridge.md#62-gate-표시)가 요구하는 의미를 Orca Gate가 직접 제공하는지 대조한 결과다.

| 카드에 필요한 의미 | Orca Gate 제공 여부 |
|---|---|
| 질문 | ✅ `question` |
| 선택지 | ⚠️ `options` (평문 문자열, 설명 없음) |
| 선택지의 안정적 ID | ❌ 없음 |
| 각 선택지의 의미 설명 | ❌ 없음 |
| coordinator 권장안 | ❌ 없음 |
| 권장 이유 | ❌ 없음 |
| 결정 영향 | ❌ 없음 |
| 대기 중인 Task 목록 | ⚠️ `task_id` 1건만. 나머지는 `deps`에서 파생해야 함 |
| 계속 가능한 독립 Task | ❌ 없음 |
| 임의 metadata 필드 | ❌ 없음 |

즉 **Orca Gate schema만으로는 스펙이 요구하는 Gate 카드를 만들 수 없다.** OD-050은 "확인 후 결정"이 아니라 "반드시 Bridge 또는 coordinator 측에서 해결해야 하는 설계 과제"로 확정됐다. 남은 선택지는 `question`/`options` 문자열에 구조를 인코딩하거나, Bridge durable store에 sidecar metadata를 두거나, 카드를 축소하는 것이다. 확장 가능한 Gate 필드는 존재하지 않는다.

### 8.3 Gate와 Task status의 자동 연동

같은 task에 gate를 만들고 status를 추적한 직접 관측 결과다.

```text
gate 생성 전   → task status = ready
gate-create 후 → task status = blocked
gate-resolve 후 → task status = ready
```

플랫폼이 자동으로 전이시킨다. Bridge가 blocked 상태를 따로 계산할 필요가 없다는 뜻이며 OD-067 taxonomy의 `blocked Task` 항목에 쓸 수 있다. 다만 resolve 후 항상 직전 status로 복원되는지, 아니면 항상 `ready`가 되는지는 이번 관측만으로 구분하지 못했다.

### 8.4 ⚠️ Gate 중복 resolve를 플랫폼이 막지 않는다

가장 중요한 발견이다. 다음을 순서대로 실행했다.

| # | 호출 | 결과 |
|---|---|---|
| 1 | `gate-resolve --retry-request slack-action-TEST1 --resolution "B: ..."` | `ok:true`, `status: resolved`, `resolved_at: 14:33:34`, `mutation.replayed: false` |
| 2 | 같은 `--retry-request slack-action-TEST1`로 재호출 | `ok:true`, **`mutation.replayed: true`**, `resolved_at` 14:33:34 그대로, resolution 변화 없음 |
| 3 | **다른** 키 `slack-action-TEST2` + 다른 resolution으로 재호출 | **`ok:true`**, `resolution`이 `"A: 취소 즉시 종료 (덮어쓰기 시도)"`로 **조용히 덮어써짐**, `resolved_at` 14:33:46으로 갱신 |

결론:

- `--retry-request`는 **같은 요청의 재시도**만 멱등화한다. 응답의 `mutation.replayed`로 재생 여부를 판정할 수 있다.
- **이미 `resolved`인 Gate에 다른 요청이 오면 Orca는 거부하지 않고 덮어쓴다.** 오류도, 경고도 없다.

따라서 [Bridge 스펙 §7.2](specs/orca-slack-bridge.md#72-처리-순서)의 "Orca에서 Gate가 아직 open인지 읽는다"와 [보안 경계](specs/orca-slack-bridge.md#10-보안-경계)의 "stale·resolved Gate action 거부"는 **방어적 권장이 아니라 필수**다. 플랫폼이 대신 막아주지 않는다.

추가로 남는 위험: status 확인과 `gate-resolve` 사이에 TOCTOU 창이 있다. 서로 다른 Slack action 두 개가 동시에 `pending`을 읽으면 둘 다 통과하고 마지막 호출이 이긴다. `--retry-request`로는 이 경합을 막을 수 없으므로 Bridge durable store에서 Gate 단위 직렬화가 필요하다. OD-051에 이 조건을 반영한다.

### 8.5 Gate 해결이 coordinator에게 자동 통지되지 않는다

`gate-create`와 `gate-resolve` 이후 `orchestration inbox`는 계속 `messages: [], count: 0`이었다. Orca는 Gate 상태 변화를 coordinator 메일박스로 push하지 않는다. 즉 coordinator를 깨우는 경로(Channel 또는 polling/재조회)는 Bridge가 반드시 제공해야 하며, "Channel은 초인종"이라는 설계 전제가 관측으로 뒷받침됐다.

### 8.6 mutation envelope

모든 mutation 응답에 다음이 포함된다.

```json
"mutation": { "requestId": "<--retry-request 값 또는 자동 생성 uuid>", "replayed": false }
```

`--retry-request`는 호출자가 정한 임의 문자열을 그대로 받는다(`slack-action-TEST1`이 그대로 echo됐다). Slack action ID를 그대로 키로 쓸 수 있다는 뜻이다.

### 8.7 Task row가 repository 경로를 나른다

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

`created_by_process_incarnation`에 **작업 디렉터리(`D:/dev-infra`)가 포함**된다. `run-list` row에는 repository identity가 없다는 기존 기록은 유효하지만, Task row에는 경로 후보가 있다. OD-020(Run↔repository 연결)의 새 후보 경로다. 다만 문자열 안에 인코딩된 값이라 안정적 파싱 형식인지, worktree와 repository root를 구분할 수 있는지는 미검증이다.

`run-create` 응답에서는 `coordinator_handle`과 `coordinator_pane_key`가 **자동으로 채워졌다**. Run을 만든 terminal을 Orca가 식별한다는 뜻이며 이것도 OD-020 후보다.

### 8.8 adapter가 처리해야 할 형식 비일관성

- 타임스탬프 형식이 섞여 있다. Run은 ISO8601 UTC(`2026-08-21T14:32:45Z`), Task와 Gate는 타임존 없는 `2026-08-21 14:33:10`이다.
- `deps`와 `options`는 배열이 아니라 **JSON 문자열**이다(`"[]"`, `"[\"A\",\"B\"]"`).

### 8.9 정리하지 못한 상태

`run-delete`에 해당하는 명령이 orchestration 29개 명령에 없다. throwaway Run `run_a48566be983b`과 그 task/gate는 로컬 Orca DB에 남아 있다. 제거하려면 범위가 넓은 `orchestration reset --all|--tasks`를 써야 하므로 실행하지 않았다. Bridge가 Run을 발견할 때 이 Run을 만나게 되므로, objective 문자열로 식별 가능하도록 `THROWAWAY`를 명시해 두었다.

## 9. Claude Code Channel 스모크 테스트 (2026-08-21, 미완결)

### 9.1 공식 계약 확보

[Channels reference](https://code.claude.com/docs/en/channels-reference)에서 custom channel 계약을 확정 확인했다.

- capability 선언: `capabilities.experimental['claude/channel'] = {}` (필수, 항상 `{}`. 이 키의 존재가 listener를 등록시킨다)
- 양방향이면 `capabilities.tools = {}` 추가, permission relay는 `capabilities.experimental['claude/channel/permission'] = {}`
- push 방식: `notifications/claude/channel`, params는 `content: string`과 `meta: Record<string,string>`
- 세션 컨텍스트 도달 형태: `<channel source="<서버명>" <meta키>="<값>">content</channel>`
- `source` 속성은 서버 이름에서 자동으로 채워진다
- **`meta` 키는 식별자여야 한다. 문자·숫자·밑줄만 허용되고 하이픈이 든 키는 조용히 버려진다.** `gate_id`는 되지만 `gate-id`는 사라진다
- ACK 없음. `mcp.notification()`의 await는 transport write까지만 보장한다
- **공식 권고: 전달 확인이 필요하면 서버가 event 상태를 추적하고 Claude가 호출할 reply tool을 노출하라.** OD-059(application receipt 반환 경로)의 공식 근거다

### 9.2 flag 존재 확인 — 기존 우려 해소

로컬 2.1.238에서 두 flag 모두 존재한다. `--channels foo`는 다음 문법 오류를 반환했다.

```text
--channels entries must be tagged: foo
  plugin:<name>@<marketplace>  — plugin-provided channel (allowlist enforced)
  server:<name>                — manually configured MCP server
```

공식 문서도 명시한다: "Neither `--channels` nor `--dangerously-load-development-channels` appears in `claude --help` while the feature is in preview. The flags work even though they aren't listed."

따라서 §2의 "help에 노출되지 않는다"는 관측은 미지원 근거가 아니며, 이 항목의 불확실성은 해소됐다.

### 9.3 시도한 스모크 테스트

의존성 없는 raw JSON-RPC stdio MCP 서버를 작성했다(`initialize`에서 `experimental: { 'claude/channel': {} }`와 `tools: {}` 선언, `notifications/initialized` 수신 1.2초 뒤 channel notification push, 도달 증명용 `report_receipt` reply tool, 다음 턴 강제용 `wait_a_moment` tool).

| # | 구성 | 결과 |
|---|---|---|
| 1 | `--mcp-config` + `--strict-mcp-config` + `--dangerously-load-development-channels server:...`, `-p` 단일 턴 | 서버 handshake 성공, push 성공, Claude가 tool 미호출 |
| 2 | 위 + `wait_a_moment`로 두 번째 턴 강제, `--output-format stream-json` | push(t+1.2s)가 tool 호출(t+10s)보다 선행했는데도 `report_receipt(content="NONE")` |
| 3 | `--channels server:...`로 교체 | 동일하게 `NONE` |
| 4 | `--mcp-config` 대신 프로젝트 `.mcp.json`, `-p` | 동일하게 `NONE`, **stderr에 경고 한 줄도 없음** |

시도 2의 stream-json `init` 이벤트는 `mcp_servers: [{"name":"orca-slack-smoke","status":"connected"}]`와 두 tool 등록을 보여줬으나 **channel 등록 흔적은 전혀 없었다.**

즉 서버는 일반 MCP server로는 정상 연결되지만 channel로는 등록되지 않았고, notification은 문서가 경고한 대로 조용히 drop됐다.

### 9.4 배제된 가설

- **"다음 턴이 없어서 큐에 남았다"** — 반증. 두 번째 턴이 실제로 있었고 push가 그보다 먼저였다.
- **"`--channels server:<name>`가 정답 경로"** — 반증. 공식 문서: "During the research preview, `--channels` only accepts plugins from an Anthropic-maintained allowlist." bare server는 development flag 경로다.
- **"`--mcp-config`와 `.mcp.json`의 차이"** — 반증. 둘 다 동일 결과.
- **"flag가 이 버전에 없다"** — 배제. 두 flag 모두 존재하고 문서가 동작을 명시한다.

### 9.5 남은 가설

1. **development bypass가 대화형 확인을 요구한다.** 문서: "The development flag bypasses the allowlist for specific entries **after a confirmation prompt**." `-p` 비대화형에는 이 프롬프트에 답할 수단이 없다. 확인 없이 bypass가 성립하지 않으면 channel은 등록되지 않고, 관측된 무경고 silent drop과 일치한다.
2. **조직 정책 `channelsEnabled`가 꺼져 있다.** 문서: "If the setting is disabled or unset, the MCP server still connects and its tools work, but channel messages won't arrive." **관측 증상과 정확히 일치한다.** 단 이 경우 startup warning이 나와야 하는데 `-p`에서는 보이지 않았다. claude.ai Team/Enterprise는 기본 차단이고, 조직 없는 Pro/Max는 이 검사를 건너뛴다.
3. raw JSON-RPC 구현이 MCP SDK와 미묘하게 다르다. 문서의 capability 형태를 그대로 따랐으므로 가능성은 낮지만 배제하지 못했다.

가설 1과 2는 이 세션의 비-TTY 환경에서 확인할 수 없다. **대화형 터미널에서 1회 실행하면 두 가설이 동시에 갈린다** — 확인 프롬프트가 뜨는지, allowlist/정책 경고가 뜨는지가 startup notice에 나온다.

### 9.6 결론

**D3의 전제인 "custom Slack Channel end-to-end inbound delivery"는 아직 검증되지 않았다.** 계약과 flag는 확인됐고 남은 것은 세션 등록 경로다. [로드맵](roadmap.md#3-bridge-사전-size-gate)의 "Channel이 현재 로컬 버전에서 동작하지 않으면 D3을 다른 slice와 묶지 않는다"는 조건은 아직 유효하다.
