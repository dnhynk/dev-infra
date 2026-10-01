# Codex coordinator 설치와 acceptance

상태: **plugin 설치·skill discovery·Astra worker live receipt·Windows Bridge 배포·
live Slack Gate wake·rollover 수용 완료**
기준일: **2026-09-08**

이 절차는 `plugins/orca-orchestration/`을 Codex에 설치하고 `$init-orchestrate` coordinator를
부팅하는 재현 절차다. Claude `/init-orchestrate`와 Channel Adapter는 그대로 병행할 수 있다.

## 1. Source 검증

repository root에서 실행한다.

```powershell
python "$env:CODEX_HOME\skills\.system\skill-creator\scripts\quick_validate.py" `
  plugins/orca-orchestration/skills/init-orchestrate
python "$env:CODEX_HOME\skills\.system\plugin-creator\scripts\validate_plugin.py" `
  plugins/orca-orchestration
node --test plugins/orca-orchestration/test/rollover-monitor.test.mjs
npm --prefix apps/orca-slack-bridge run typecheck
npm --prefix apps/orca-slack-bridge test
```

`CODEX_HOME`에 system skills가 없는 설치에서는 해당 scripts의 실제 system-skill path를 먼저 찾는다.
검증기를 생략하고 성공으로 기록하지 않는다.

셸의 기본 Node가 26이 아니면 Node 26 실행 파일을 직접 지정한다. pnpm shim은 자신의 디렉터리에 있는
Node를 우선하므로 PATH만 바꿔서는 pnpm이 쓰는 Node가 바뀌지 않는다. 테스트가 띄우는 자식 `node`도
Node 26이어야 하므로 PATH 앞에도 같은 디렉터리를 둔다.

```powershell
$bridgeNode = '<Node 26 node.exe 절대경로>'
$bridgePnpm = '<pnpm.mjs 절대경로>'
$env:PATH = "$(Split-Path $bridgeNode);$env:PATH"
& $bridgeNode $bridgePnpm install --frozen-lockfile
& $bridgeNode node_modules/typescript/bin/tsc --noEmit -p apps/orca-slack-bridge/tsconfig.json
& $bridgeNode node_modules/typescript/bin/tsc -p apps/orca-slack-bridge/tsconfig.build.json
& $bridgeNode --test plugins/orca-orchestration/test/rollover-monitor.test.mjs
Push-Location apps/orca-slack-bridge
& $bridgeNode ../../node_modules/vitest/vitest.mjs run
Pop-Location
```

운영 daemon이 fixed pipe를 잡고 있으면 `runs main through the real stdio MCP server`,
`runs main daemon with the production fixed-pipe owner`, `fences the exact fixed pipe across processes`,
`composes runDaemon with real Socket SDK ACKs` 네 테스트가 `EADDRINUSE`로 실패한다. 운영을 유지한 채
실행할 때는 아래처럼 제외하고, 그 결과를 무제외 전체 PASS로 기록하지 않는다.

```powershell
& $bridgeNode ../../node_modules/vitest/vitest.mjs run -t '^(?!.*(?:runs main through the real stdio MCP server|runs main daemon with the production fixed-pipe owner|fences the exact fixed pipe across processes|composes runDaemon with real Socket SDK ACKs)).*$'
```

## 2. Local marketplace와 plugin 설치

이 repository의 `.agents/plugins/marketplace.json`이 plugin source를
`./plugins/orca-orchestration`으로 가리킨다.

```powershell
codex plugin marketplace add D:\dev-infra --json
codex plugin add orca-orchestration@dev-infra --json
codex plugin list --json
```

다른 checkout에서는 첫 명령의 exact repository path만 바꾼다. Orca 계정을 바꾸면 `CODEX_HOME`도
달라질 수 있으므로, 사용할 terminal에서 설치 목록과 `installedPath`를 확인한다. 이전 계정의 설치가
현재 홈에 자동 적용된다고 가정하지 않는다. 이 호스트의 `codex-runtime-home/home/plugins`는
`~/.codex/plugins`를 가리키는 junction이지만 config는 별도 복사본이다. runtime home의 marketplace
등록이 사라지는 경우 기본 `~/.codex` 홈을 대상으로 위 CLI 설치를 실행하고 새 Orca terminal에서
목록을 다시 확인한다. config나 marketplace JSON을 직접 덮어쓰지 않는다.
설치 뒤 **새 Codex thread**를 연다.
기존 thread는 새 skill/hook snapshot을 보지 못할 수 있다.

새 thread의 `/hooks`에서 plugin Stop hook command가 설치 plugin root 아래의
`rollover-monitor.mjs`만 실행하는지 검토한 뒤 신뢰한다. Codex는 plugin 설치만으로 hook을 자동
신뢰하지 않는다. 신뢰 전에는 `$init-orchestrate` skill이 보여도 자동 rollover는 동작하지 않는다.

## 3. 부팅

Orca-managed interactive Codex terminal에서 실행한다.

```text
$init-orchestrate <범위·우선순위·검증 가능한 종료점>
```

플러그인 namespace를 포함한 discovery 이름은 `orca-orchestration:init-orchestrate`다. 이름 충돌 시
`$orca-orchestration:init-orchestrate`로 지정한다.

skill은 authority 문서와 preflight를 먼저 읽고 Fresh/Resume을 판정한다. Fresh Run은 사용자와 방향 및
rollover 1회 승인을 확정한 뒤에만 worker를 만든다. Resume은 live state reconcile과 `run-use` ownership
확인 전까지 mutation하지 않는다.

preflight는 coordinator 자신의 도구 셸에서 실행한다. 직접 실행한 `codex --model ...`이 기존 Orca
agent의 PATH나 실행 권한을 상속한다고 가정하지 않는다. 확인된 CLI/runtime 경로와 명시된 launch
policy를 handoff에 기록하되, rollover 승인만으로 sandbox·approval 설정을 넓히지 않는다.
`agent_prompt_blocked`는 확인창 자동 입력이 거부됐다는 뜻이며 허용된 사용자 조작이 필요하다.

이 호스트에서 확인된 CLI selector는 `C:/Users/<user>/AppData/Local/Programs/orca/resources/bin/orca.exe`다.
직접 띄운 Codex의 제한된 도구 셸에서는 bare `orca`와 이 경로가 모두 `CommandNotFoundException`으로
실패한 적이 있다. custom coordinator와 successor에는 `ORCA_CLI_COMMAND`와 handoff/resume prompt로 이
exact 경로를 넘기고, 각자 자신의 도구 셸에서 실행 가능한지 확인한다.

부팅 뒤 marker에서 다음 exact 값이 current Run/terminal과 같은지 확인한다.

```text
~/.codex/orchestration/runs/<run_id>.json
provider = codex
coordinator_session_id = CODEX_SESSION_ID
coordinator_terminal_handle = ORCA_TERMINAL_HANDLE
coordinator_pane_key = ORCA_PANE_KEY
coordinator_generation = current Run consumer_generation
coordinator_model = 이 session의 effective model
coordinator_effort = 이 session의 effective effort
```

marker는 Bridge wake와 rollover의 route proof다. session takeover 때 원자 교체하고 Run cleanup 완료 뒤
exact marker를 제거한다. 수동 JSON 편집은 acceptance 근거가 아니다.

## 4. Model 수용

model 가용성은 계정/runtime별로 다르다. 한 계정의 거부나 성공을 다른 계정에 일반화하지 않는다.
coordinator는 사용자가 띄운 model/effort로 동작하고 worker model은
[worker routing](../../plugins/orca-orchestration/skills/init-orchestrate/references/worker-routing.md)이
dispatch 시점의 런타임 카탈로그에서 고른다.

model 선택 경로를 수용할 때 disposable Task에서 `worker-start --agent <계열> --model <고른 model>
--effort <고른 effort>` receipt를 읽고 다음을 확인한다.

- `launch.requested`의 model/effort가 요청과 같다
- `launch.effective`가 `launch.requested`와 exact 일치
- worker report가 model/effort를 추측해 재서술하지 않음

요청 model이 거부되면 같은 계열의 다음 후보로 다시 배치하고 거부 오류를 남긴다. 다른 mismatch나
provider 오류는 조용히 넘기지 않고 Gate로 올린다.

## 5. Slack Gate wake 수용

throwaway Run과 실제 Slack 버튼으로 다음을 순서대로 관찰한다.

1. Codex marker가 current Run generation과 exact 일치한다.
2. Claude Channel candidate가 없는 상태에서 owner가 Gate를 해결한다.
3. Bridge delivery가 `pending`에서 `receipted`로 가고, coordinator terminal에
   `[orca-gate-wakeup v1 run_id=... gate_id=...]` 입력이 도착한다. 유휴 Codex를 종료시키는
   `--interrupt`는 사용하지 않는다.
4. prompt에는 resolution 본문이 없고 coordinator가 exact Gate를 다시 읽는다.
5. duplicate wake가 같은 effect를 반복하지 않는다.
6. Bridge가 exact Gate effect를 관찰한 뒤에만 delivery를 `consumed`로 바꾸고, 실제 후속
   Task/Dispatch 관찰 뒤에만 Slack에 작업 재개를 표시한다.
7. marker generation/pane/worktree 중 하나를 고의로 stale하게 한 음성 표본은 terminal write 전에
   fail closed한다. 표본 뒤 marker를 current 값으로 복구한다.

`terminal send`의 `accepted`만으로 3~6번 PASS를 선언하지 않는다.

## 6. Rollover 수용

throwaway Run에서 `run-marker.mjs write`를 같은 exact identity 값으로 다시 실행하되
`--reserve-tokens <현재 remaining보다 큰 값>`을 추가해 Stop hook을 강제로 발동한다. JSON을 손으로
편집하지 않는다. 다음 전체 흐름이 관찰돼야 한다.

```text
Stop decision:block
  → predecessor 신규 dispatch/merge fence
  → atomic handoff
  → marker의 effective model/effort successor terminal
  → $init-orchestrate --resume <same run_id>
  → live reconcile
  → Run consumer_generation 증가와 terminal/pane 교체
  → predecessor 종료
```

successor 준비와 prompt 제출은 `terminal read --screen`으로 확인한다. marker는 successor session으로
교체되어야 하고 predecessor hook은 더 이상 그 Run을 소유하지 않는다.

## 7. 제거와 갱신

plugin 제거:

```powershell
codex plugin remove orca-orchestration@dev-infra --json
```

source 변경 뒤 Codex cache를 갱신할 때는 plugin-creator의 cachebuster helper로 manifest version의
`+codex.<timestamp>` suffix를 교체한 뒤 `codex plugin add orca-orchestration@dev-infra --json`을 다시
실행하고 새 thread를 연다. marketplace JSON이나 Codex config를 손으로 덮어쓰지 않는다.

## 8. 실측 기록

2026-09-07~08의 설치·배포·live acceptance 관찰과 receipt 요약은
[Codex coordinator acceptance evidence](../evidence/codex-coordinator-acceptance.md)에 있다.
