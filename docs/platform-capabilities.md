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
