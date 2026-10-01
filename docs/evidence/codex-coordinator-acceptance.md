# Codex coordinator acceptance evidence

Date: 2026-09-07 ~ 2026-09-08 (KST)

Status: **PASS** — Astra worker receipt, 실제 Slack Gate 응답 뒤 wake와 Task 재개, 설치된 Stop hook이
지시한 1회 rollover(Run generation 1→2)를 관찰했다. 관측 당시 Orca는 1.4.188, Codex TUI는 0.153.4였다.

이 기록은 [Codex coordinator 설치와 acceptance](../ops/codex-coordinator-setup.md) 절차의 실측 증거이며
normative source가 아니다. 원본 receipt와 SQLite/manifest backup은 저장소 밖
`build/codex-live-20260908/`(gitignored)에 있다.

## A. 2026-09-07 후속 검증

- 이전 provider session은 읽기 전용으로 참조했다. 기존 Run을 resume하거나 live Slack 메시지를
  만들지 않았다.
- 기본 Codex 홈에 `orca-orchestration@dev-infra` `0.1.0+codex.20260907144331`을 설치했다.
  CLI의 `installed=true`, `enabled=true`와 source/cache 9개 파일의 SHA-256 일치를 확인했다.
- 별도 Codex app-server의 `skills/list`에서도 `orca-orchestration:init-orchestrate`, 위 cache 경로,
  `enabled=true`를 확인했다. 이 discovery 검증은 LLM 호출이나 새 agent thread를 만들지 않는다.
- 설치된 `commandWindows`를 실제 PowerShell에서 격리 marker로 실행해 `decision:block`과
  `gpt-6-astra at xhigh`를 확인했다. 이 실행은 `/hooks`의 영구 신뢰를 대신하지 않는다.
- `node --test plugins/orca-orchestration/test/rollover-monitor.test.mjs`: **8 passed**.
  미승인 marker, 다른 session/worktree, 실제 258,400 context window, 프로세스 간 3회 제한을 포함한다.
- `npx vitest run test/channel-delivery.test.ts test/codex-terminal-delivery.test.ts`: **20 passed**.
  실제 Codex marker transport와 SQLite delivery를 조합해 stale route 무전송, queue receipt,
  exact Gate 재조회 뒤 consumption, 중복 전송 방지를 검증했다. terminal 조회·전송의 취소 신호 누락은
  두 음성 회귀로 재현한 뒤 수정했다.
- Bridge 회귀 검증: **81 files / 1,737 passed / 14 skipped**. 아래 네 test-name pattern은 이전
  전체 실행에서 production fixed pipe의 `EADDRINUSE`로 실패한 표본이다. 운영 서비스를 유지하기
  위해 이번 실행에서 제외했으므로, 무제외 전체-suite PASS로 기록하지 않는다.
  `runs main through the real stdio MCP server`, `runs main daemon with the production fixed-pipe owner`,
  `fences the exact fixed pipe across processes`, `composes runDaemon with real Socket SDK ACKs`.
- `npm --prefix apps/orca-slack-bridge run typecheck`, `npm --prefix apps/orca-slack-bridge run build`,
  skill/plugin validator, `git diff --check`: **PASS**. plugin hook/marker 테스트도 CI에 추가했다.
- 아직 실행하지 않은 것: 실제 Slack 버튼→현재 Codex 소비→Task 재개 관찰, 새 Astra supervised worker
  receipt, successor의 Run ownership 인수를 포함한 live rollover, 새 Bridge build의 운영 배포.

## B. 2026-09-08 Windows 운영 반영 준비

현재 셸의 기본 Node는 `24.19.0`이지만 Bridge의 지원 범위는 `>=26`이고, 기존 Windows 배포는
`C:\Users\<user>\AppData\Local\nvm\v26.8.1\node.exe`를 사용한다. 지원 런타임으로 검증하기 위해
아래처럼 실행 파일을 직접 지정했다. pnpm shim은 자신의 디렉터리에 있는 Node 24를 우선하므로
PATH 변경만으로 pnpm의 Node 버전까지 바뀌었다고 판단하지 않는다.

```powershell
$bridgeNode = 'C:/Users/<user>/AppData/Local/nvm/v26.8.1/node.exe'
$bridgePnpm = 'C:/nvm4w/nodejs/node_modules/pnpm/bin/pnpm.mjs'
& $bridgeNode $bridgePnpm install --frozen-lockfile
& $bridgeNode node_modules/typescript/bin/tsc --noEmit -p apps/orca-slack-bridge/tsconfig.json
& $bridgeNode node_modules/typescript/bin/tsc -p apps/orca-slack-bridge/tsconfig.build.json
& $bridgeNode --test plugins/orca-orchestration/test/rollover-monitor.test.mjs
```

- Node `26.8.1` / pnpm `11.22.0`: frozen install, typecheck, build, hook **8 passed**.
- 같은 Node와 child PATH로 Bridge 회귀 검증: **81 files / 1,738 passed / 14 skipped**.
  제외한 네 production-pipe 표본은 §A와 같다. 전체 무제외 PASS는 아니다.
- 운영 반영 전 기존 CLI의 read-only `status`는 `degraded`였다. daemon과 Windows task는 실행 중이고
  schema `16` 및 배포 identity는 일치하지만, repository discovery는 `discovery.schema_drift`,
  PR digest는 `scheduler.aborted`를 보고했다.
- 현재 `orca repo list --json`의 14개 항목 중 한 git 항목에 `projectHostSetupMethod`가 빠져 있다.
  같은 응답을 기존 배포본과 후보 빌드의 parser에 각각 전달하면 둘 다
  `ORCA_REPOSITORY_ROW_INVALID`로 거부한다. 새 Codex transport 배포로 해결됐다고 기록하지 않으며,
  이 관측을 근거로 strict discovery contract를 임의로 완화하지 않았다.

지원 staging 도구를 위 Node와 pnpm으로 실행해 현재 working tree의 Windows release를 생성했다.
의존성 closure, Windows filesystem 제약, LF 정규화 및 read-only 파일의 최종 digest 검증을 통과했다.

```text
release digest: f3d245840801be052ce88d2b9efdbb12a1c6ee4184bd1c45ecdd5a02f156bb79
release root: C:\Users\<user>\AppData\Local\OrcaSlackBridge\releases\f3d245840801be052ce88d2b9efdbb12a1c6ee4184bd1c45ecdd5a02f156bb79
```

이 패키지는 현재 checkout의 기존 변경을 포함한 전체 Bridge build다. plugin은 §A의 Codex cache에
별도로 설치되어 있다. 운영 교체는 [Windows 시작 절차](windows-startup.md)의 기존 daemon 종료,
staged CLI install, run-now와 status 검증 순서를 사용한다. 새 release root로 install하거나 live
Slack Gate 메시지를 생성하는 명령은 아직 실행하지 않았다.

- staged `CodexTerminalDeliveryTransport`와 `CoordinatorDeliveryTransport` import 및 Node 26의
  in-memory SQLite smoke도 통과했다. 운영 DB를 열거나 terminal 입력을 보내지 않는 검증이다.
- 기존 `runtime.json`은 staging 전후 SHA-256이 일치하며 배포 digest
  `17771f15626a325c1de0cbdacfceb0e7887f029557c56da96d461d06150beea9`를 유지한다.
  기존 `Orca Slack Bridge Daemon` task도 실행 중이다.
- staging의 자동 prune 대상은 미리 별도 사본으로 보존했다. 정리된 이전 release
  `31382c8d3bd371148851ac2adae9199c01e7efab7a5d344b6696461d4326cff1`을 복사 복원하고 원래 digest를
  다시 확인했다. 자동 승인 검토가 move와 백업 삭제를 묶은 명령을 `blocked by policy`로 거부해
  삭제 없는 복사 방식으로 완료했으며, `releases/.stage/codex-preserve-20260908-*`의 사본 두 개는
  보존되어 있다. 운영 release와 기존 여섯 release의 내용은 유지된다.

## C. 2026-09-08 승인 후 live 검증

사용자가 운영 교체와 실제 Slack Gate·rollover 검증을 승인했다. 새 supervisor Run은
`run_ba9a2a804218`이며 이전 provider session과 기존 Run은 재개하지 않았다.

- `task_3212b64c7cd1` / `ctx_918167ae7527`: `worker-start`의 requested/effective가 모두
  `gpt-6-astra` / `xhigh`와 일치했다. 실제 도구 실행과 성공 `worker_done`을 수신하고,
  `worker-release`의 `released` / `closed_agent_terminal`을 확인한 뒤 Delivery를 ack했다.
- 기존 daemon이 `discovery.schema_drift` 직후 종료되고 재시작을 반복하는 것을 확인했다.
  §B에서 관측한 setup preference 누락을 두 회귀 표본으로 재현한 후 지원했다. 다른 identity field,
  알 수 없는 key, 존재하는 field의 type 검증은 유지했다. 현재 Orca 응답은 **14 rows / 11 valid /
  3 no_remote**, 관련 parser·discovery·daemon 테스트는 **132 passed**다. typecheck와 build도 통과했다.
- 수정 후 운영 release는
  `6d786261b9083fb1f863db65c7f166bbd7e94259b21331ad1e5114e8df159110`이다.
  운영 manifest와 SQLite의 consistent backup을 `build/codex-live-20260908/`에 먼저 만들었다.
- 기존 uninstall의 90초 정상 대기는 crash 뒤 남은 `daemon.state=running` 기록 때문에 만료됐다.
  Task disabled/stopped, 실제 daemon 부재, fixed pipe 해제를 확인한 뒤 지원되는 exact-owned
  `uninstall --force --wait-seconds 10` 복구로 Task를 제거했다. 새 release의 install과 run-now를 마쳤고
  schema/build identity 일치, 새 daemon heartbeat, Task `healthy`, repository discovery와 Run observer
  성공을 확인했다. 이 초기 snapshot만으로 지속 운영 성공을 선언하지 않는다. 이후 로그에서
  `onCompleted`의 `daemon_job_failure_rejected` 위치에서 주기적 종료가 계속되는 것을 확인했다.
  기존 registry pending/rejected, uncertain root intent, unavailable baseline도 남아 있다.
- PR Digest의 `fairDigestCycle`은 순회 위치를 modulo로 되돌렸지만 SQLite completion은 checkpoint의
  단조 증가를 요구했다. 운영 DB의 `checkpoint=10`과 실제 종료 stack을 대조하고, 성공/실패 결과를
  SQLite에 저장하는 두 회귀에서 `null` 거부를 재현했다. 목록 선택에만 modulo를 쓰고 저장 값은
  누적하며, 발견된 저장소가 없어도 기존 checkpoint를 유지하도록 수정했다. 순회·빈 목록·목록 축소를
  포함한 daemon/supervisor/store/health 테스트 **68 passed**, typecheck/build도 통과했다.
- checkpoint 수정본 `b7489bba4d6277bbf427780d815f4c7bd753762453bdcffee58b602fafee88ac`을
  consistent SQLite/manifest backup 뒤 배포했다. 이전 종료 상태가 남아 정상 대기는 만료됐지만,
  exact Task disabled·daemon 부재·fixed pipe 해제를 확인하고 지원되는 force cleanup 후 install과
  run-now를 완료했다. 운영에서 PR Digest checkpoint **10 → 20** 저장과 같은 daemon instance의
  후속 Run/Gate/terminal 관찰 성공을 확인했다(`build/codex-live-20260908/checkpoint-live.json`).
  PR Digest 결과 자체는 `digest.github_unavailable` / backoff이며, 전체 관찰이 성공했다는 뜻은 아니다.
- 직접 띄운 Codex의 제한된 도구 셸에서 bare `orca`와 아래 exact executable 모두
  `CommandNotFoundException`으로 실패했다. PATH 누락만으로 원인을 확정할 수 없으며, 명시 경로로
  바꿔도 실행 권한 문제가 해소되지 않았다. `orca.exe skills get orca-cli`의 sandbox 밖 실행 확인창에서
  멈췄고, 공개 CLI로 단일 명령을 확인하려는 입력도 `agent_prompt_blocked`로 거부됐다.
  사용자 조작을 요청했으나, 이후 plugin cache 갱신으로 새 thread가 필요해졌다. 전체 29 Run에 이
  terminal의 ownership이 없는 것을 확인하고 빈 bootstrap terminal을 닫았다. 실제 Gate는 만들지 않았다.
- 이 호스트의 확인된 CLI selector는
  `C:/Users/<user>/AppData/Local/Programs/orca/resources/bin/orca.exe`다. custom coordinator/successor에는
  `ORCA_CLI_COMMAND`와 handoff/resume prompt로 이 exact 경로를 전달하고, 별도로 자신의 도구 셸에서
  실행 가능성을 확인한다. User/system PATH, PowerShell 실행 정책, sandbox 설정은 바꾸지 않았다.
- 실행 경로·권한 구분을 보강한 plugin `0.1.0+codex.20260907171927`을 CLI로 재설치했다.
  `installed=true` / `enabled=true`, source/cache **9 files SHA-256 일치**, skill/plugin validator를
  확인했다. 업데이트가 이전 version cache를 교체하므로, live rollover 수용은 새 thread에서 최신
  skill/hook을 다시 읽고 수행해야 한다.
- 남은 실제 Gate/rollover 실행을 위해 `build/codex-live-20260908/launch-proposal.json`에 새 검증
  coordinator와 1회 successor만 대상으로 하는 실행안을 준비했다. `danger-full-access` / `never`를
  명시하는 이 안을 사용자가 "전부 승인"으로 확정했다. 새 terminal
  `term_<redacted>`에서 Astra `xhigh`, 해당 실행 모드와 TUI readiness를
  확인하고 검증 prompt를 제출했다. 이 coordinator의 자체 도구 셸에서 Orca guide/status 실행도
  성공했다. 같은 승인 설정은 1회 successor에 이어지며 전역 설정은 수정하지 않는다.
- 새 검증 Run `run_0337b19093b5` / Task `task_1541f976218b` / Gate `gate_aee7730ddfbe`를 만들고,
  coordinator가 worker 없이 턴을 종료한 것을 확인했다. Slack 소유자의 실제 버튼 응답은
  `2026-09-07T17:50:54Z`에 `계속`으로 resolved됐으며 D2 ACK·pre-read·mutation·post-read가 저장됐다.
- 이 Gate에서 `derived-<gate_id>`를 실제 worker Dispatch로 찾는 baseline 오류가 재현됐다.
  SQLite 회귀도 전송 0회로 실패했다. D2 identity와 현재 exact Gate를 대조하도록 수정한 뒤
  첫 worker 생성 전 기준 관찰, 재시작 후 실제 Dispatch evidence, 잘못된 Gate·합성 worker 거부,
  취소 전파를 포함한 관련 **74 tests**와 typecheck/build가 통과했다. 동일 live Gate에 대한
  read-only 프로브도 `snapshot_rejected`에서 `snapshot_accepted`로 바뀌었다.
- consistent DB/manifest backup 뒤 release
  `11b889292e6d0b1e4120287dc5ef4baf21a0cd3543cace2a220ff5ee5304699d`를 배포했다. 이번에는 기존
  daemon이 `daemon.stopped`로 정상 종료했고 force 없이 uninstall/install/run-now가 완료됐다.
- helper로 테스트 marker만 generation 2로 바꾼 동안 실제 Run generation은 1을 유지했다.
  배포본이 `resume_baseline_state=recorded`를 저장한 뒤 `route_pending_stale_generation`,
  `attempt_count=0`, terminal 무입력을 확인했다(`stale-route-live.json`). helper로 generation 1을
  복구했으며 기존 route backoff의 다음 시각은 `2026-09-07T18:06:03.072Z`다. DB의 retry 시각을
  손으로 바꾸거나 terminal에 가짜 wake를 보내지 않고 실제 daemon 재시도를 기다린다.
- 수정 후 Node 26 전체 회귀 검사는 **81 files / 1,751 passed / 14 skipped**다.
  운영 fixed pipe와 충돌하는 네 test-name pattern은 §A와 동일하게 제외했다. 실행 출력은
  `build/codex-live-20260908/bridge-regression-final.log`에 보존했다.
- 첫 실제 wake의 `--interrupt`는 Codex 0.153.4 유휴 TUI를 종료시켰다. 이 시도의 queue receipt와
  Gate-effect `consumed`는 저장됐지만 Task/Dispatch 재개 evidence는 없었다
  (`interrupt-exit-live.json`). 따라서 첫 wake의 end-to-end는 **FAIL**이며 성공으로 소급하지 않는다.
  Codex 입력을 기존 `sendTerminalInput`의 `--text ... --enter`로 바꾸고 취소 신호를 전달했다.
  기존 두 transport/SQLite 회귀의 `--interrupt` 거부 조건은 수정 전에 실패했고 수정 뒤 통과했다.
  terminal 답변·Gate/resume를 포함한 **92 tests**, typecheck/build도 통과했다.
- queue 수정본은 `cfbc17459cbad19a31265a775730fe9e2bea405eb46a35ec9fa9c8eb8e27e0e2`다.
  교체 중 정상 uninstall이 heartbeat revision 경합으로 세 번 `desired_state_conflict`를 반환했고
  매번 기존 작업을 복원했다. 배포·manifest·Task semantic identity를 확인한 기존 scheduler API로
  exact 작업을 disable/stop했다. 원래 daemon instance의 `state=stopped`와 pipe 해제를 확인하고,
  기존 `verifyDeploymentDaemonBuildIdentity` / `setDeploymentDesiredStopped`로 같은 instance에
  검증된 종료 의도를 기록했다. 임의 SQL, 광역 process kill, identity 검증 완화는 사용하지 않았다.
- 이후 force 없이 uninstall/install/run-now가 완료됐다. 최종 queue 수정본의 전체 회귀도
  **81 files / 1,751 passed / 14 skipped**이며 같은 네 production-pipe pattern을 제외했다
  (`bridge-regression-queue-final.log`). 새 daemon의 schema/config/build/Task는 matched/healthy다.
- 원래 읽기 전용 provider session이 아닌 이번에 생성한 검증 session만 같은 terminal에서 resume했다.
  Run/Task/consumer generation 1과 worker 0건을 다시 확인하고, 같은 Task의 재검증 Gate
  `gate_56ae6e5c66e9`를 만들었다. 첫 실패 Gate와 회복 이유를 별도 필드로 보존했으며, 이 복구를
  승인된 context rollover로 세지 않는다. coordinator는 실제 새 Gate wake를 기다리는 중이다.
- 공식 Computer Use는 Slack 창이 최소화됐다고 보고했으며, 지시된 창 복원 시도에는
  `user input was detected in this window`를 반환했다. 연결 복구 후에도 동일해 추가 UI 입력을
  중단하고 사용자의 실제 Slack 버튼 조작을 요청했다. Orca Computer Use나 임의 Slack API로
  대체하지 않았다.
- 새 Gate 카드는 `2026-09-07T18:22:35Z`에 `#user-input`으로 게시됐다. 마지막 확인
  `2026-09-07T18:24:20Z`에는 `gate_56ae6e5c66e9`가 pending이고 worker/Dispatch는 0건,
  `rollovers_completed=0`이었다. 남은 조건이던 정상 wake·Task 재개·설치된 Stop hook의 1회
  ownership transfer는 §D에서 완료됐다.

## D. 2026-09-08 Gate wake·rollover 완료

- 사용자가 `gate_56ae6e5c66e9`에 Slack 버튼으로 `계속`을 응답했다. coordinator는 Bridge wake를 받은 뒤
  `gate-list --run run_0337b19093b5 --task task_1541f976218b --json`으로 resolved/`계속`을 다시 읽었다.
- 같은 Task의 `worker-start --agent codex --model gpt-5.6-sol --effort high`는 requested/effective가
  일치했고 Dispatch `ctx_5345200cc146`이 read-only 작업을 마쳤다. exact `worker_done`을 성공으로
  수락했고 `worker-release`의 `released`/`closed_agent_terminal`, Delivery ack, mailbox 0건을 확인했다.
  Task 결과의 `filesModified`는 비어 있다.
- 설치된 `run-marker.mjs`로 reserve를 context window − 1로 올려 설치된 Stop hook을 실제로
  발동시켰다(`triggered_count=1`). predecessor는 successor를 만들기 전인 `2026-09-07T19:42:00.094Z`에
  self-fence했다. hook event나 transcript를 수동으로 만들지 않았다.
- 같은 worktree에 successor 1개를 띄웠다. successor의 `run-use` 뒤 `run-show`에서 Run
  `consumer_generation`이 1에서 2로 바뀌고 coordinator terminal/pane이 successor로 교체된 것을
  확인했다(`2026-09-07T19:48:47Z`).
- successor는 기본 reserve로 marker를 다시 쓰고, 남은 worker·Gate·외부 효과가 없음을 확인한 뒤 exact
  marker를 제거했다. 완료 시각은 `2026-09-07T19:52:53Z`, `rollovers_completed=1`이다.
