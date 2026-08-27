# O1 operational acceptance evidence

Status: **O1-7 production acceptance reopened — Task supervisor evidence remains valid; status capability-rotation repair awaits merge and fixed-release production verification**

This evidence is for O1-7 only. The baseline was clean merged `main` at
`c26a53a7faf1b3c57aa384e88b2874362ecc3d2f`; O1-5 and O1-6 had independent canonical PASS
audits before this branch started. No production Slack, GitHub, Orca, Scheduled Task, state, or
credential was used by the disposable acceptance. D3 remains `LIVE_CHANNEL_UNVERIFIED` and is not
changed by O1 evidence.

After the accepted supervisor release, production status sampling from exact merged `main`
`e56d9d79beccb4eb639fc4b1b638c92e51957ef5` intermittently returned
`state.snapshot_unavailable` at the 15-second operational-status capability rotation boundary. The
Scheduled Task, its direct PowerShell/Node pair, and daemon heartbeat remained healthy, isolating the
observation to the read-only status path: a client could read one protected generation and receive
an empty rejection after the owner rotated before authenticating that socket request. The narrow
repair retains one original deadline and permits one retry only after a second protected read proves
a fresh, policy-matched capability with a new ID and secret; malformed or unauthenticated responses,
stable/stale metadata, transport or state-identity mismatch, and deadline exhaustion remain closed.
Focused local regression and typecheck evidence can qualify the merge, but final O1 production
acceptance remains pending until the merged fixed release is installed and status succeeds across
repeated rotation boundaries.

The first production install from exact merged `main` at
`8d857f94c0ad44617071aaa97a4756cd9e114b42` exposed a Windows registered-export
canonicalization and absent-create rollback gap and ended with
`windows.install.rollback_failed`. The exact owned residual task was safely removed and no manifest
or daemon process remained; production installation was then left pending the fixed merge.

The second production install from exact merged `main` at
`a3e018bffef633e8d55d3e2dc2dc1c50f8a846b2` left the owned Task and protected manifest
semantically matched, but the Task ended with last result `2` and produced no new daemon log or
heartbeat. The launcher rejected the canonical exported account name before daemon start because
its dynamic binding verifier did not receive the trusted resolved LogonTrigger SID.

The next exact merged `main` at `533a4a9530fdd6f6ddc20ba6a265ded3e7a0d3e6` fixed that SID
boundary. Its production release (reported digest prefix `eaa22f`) started one Windows PowerShell
Task action and one healthy Node daemon, but after roughly two to four minutes the PowerShell action
exited with `0xC000013A` while Node remained orphaned. The same immutable launcher, manifest,
configuration, state, and workload stayed parent-owned for 240 seconds when PowerShell was started
outside Task Scheduler with a hidden window. Exact-setting and simple parent/child disposable
controls also survived beyond 130 seconds, excluding battery, idle, execution-time, and generic
child-wait limits. Production O1 acceptance therefore remains open even though the orphaned daemon
itself was healthy.

The observations support, but do not prove, a narrow console-boundary hypothesis: the registered
Task action exposed an interactive Windows PowerShell console and omitted `-WindowStyle Hidden`,
while its Node child uses `CreateNoWindow`. A console-close control event is consistent with the
observed `STATUS_CONTROL_C_EXIT` because it can terminate the PowerShell host without reaching
Node, but no source of such an event was directly observed. The repair therefore pins
`-WindowStyle Hidden` into task creation, the semantic fingerprint, the launcher binding verifier,
and the dynamic `run-now` caller. It intentionally does not introduce a broader control handler or
process wrapper; the acceptance criterion is that the Task remains `Running` with one direct daemon
child past the observed boundary, then both exit without an orphan. The fixed release passed the
production control recorded below, which accepts the repair but does not retroactively prove that a
specific console-close source caused the historical failure.

## Operational failure matrix

| Production risk | Acceptance seam | Expected invariant |
|---|---|---|
| two daemon processes | `o1-operational-acceptance.test.ts` binds the exact fixed Channel pipe from a child process, rejects the production server, transfers ownership, rejects a second production contender, then rebinds after stop | exactly one pipe owner; a loser performs no ingress or external work |
| startup order, overlap, outage/backoff | `cli-daemon`, `observer-supervisor`, and `github-background` focused files | discovery precedes Socket ingress; Run starts immediately; digest starts at +60s; one serial lane; due work coalesces; Orca/GitHub/Slack failures remain bounded and recover with completion-based backoff |
| hard crash and stale restart | `o1-operational-acceptance.test.ts` launches the installed `vite-node` fixture, which writes through `SqliteDigestStore` and exits 23 without `store.close`, then the parent reopens the database | daemon desired state, job checkpoint/failure bucket, and root intent survive process death; orphan work is fenced before restart and the possible Slack effect has no repost authority |
| possible Slack effect | `root-intent-publish` and durable reopen acceptance | `sending` from an old instance becomes `uncertain`; uncertain intent is never claimable or reposted; only proven pre-send no-effect may retry |
| normal mapped update | `run-publish` focused file | a changed observation updates the one stored root timestamp and never creates a second root |
| auto discovery and routing | `discovery-reconcile` and `run-effective-routing` focused files | aliases and exact Orca IDs coalesce by canonical repository; multi-repository consensus routes once; cross-Project, contradictory, unreadable, or over-capacity facts route zero |
| shutdown fence | `cli-daemon` and supervisor focused files | intake closes first; accepted work drains boundedly; no timer, queued completion, or late dependency starts new external work after the fence |
| daemon LLM boundary | `digest` facts-only regression plus daemon wiring | O1 background jobs always select deterministic `facts_only`; the trap summary provider receives zero calls |
| privacy and operability | `operational-logger` and `operational-status` focused files, including the capability-rotation interleaving | allowlisted NDJSON only, hashed refs, bounded rotation, read-only status, and at most one fresh-generation retry inside the original deadline without weakening identity, transport, nonce, or response authentication |
| current-user Scheduled Task | `o1-7-windows-scheduled-task-acceptance.ps1` under a process-wide mutex | unique exact target, non-admin create, hidden PowerShell action, demand start, IgnoreNew, bounded PT1M TimeTrigger relaunch after exit 23, exactly one direct PowerShell→Node pair still Task-owned for 245s, clean exit 0, exact unregister, and residual task/process/file counts all zero |

The hermetic entry point is `pnpm acceptance:o1-7`. Because the repository has one workspace package,
it invokes that bridge package's complete Vitest suite once and does not contact an LLM or a
live external service. CI runs only that named acceptance step for tests on the checked-out commit;
typecheck remains a separate job. Windows Task-definition tests are pure XML/semantic tests and do not
call Task Scheduler.

## Fixed defaults and bounds

| Concern | Default | Hard/semantic boundary |
|---|---:|---|
| repository discovery | every 300s; 30s timeout | startup pass before Socket; deterministic ±10% installation jitter |
| Run observer | every 120s; 90s timeout | immediate startup enqueue; completion-based schedule |
| PR digest | every 900s; 300s timeout | first pass 60s after Socket; 10 PR/repository; 100 PR global pass budget |
| GitHub budget | 2,000 commands/hour | defer before work below REST or GraphQL floor 1,000; at most two commands concurrently |
| daemon health | heartbeat 15s; stale after 90s | exact instance/revision ownership |
| status owner capability | rotate after 15s; stale after 30s | one protected initial read plus at most one protected re-read/retry for a new capability ID and secret under the original request deadline |
| capacity | 16 repositories; 64 Runs; 16 Orca IDs per canonical | hard maxima 64 / 256 / 64; overflow fails closed without truncation |
| operational logs | 5 MiB active file; 5 backups | 16 KiB canonical NDJSON line; allowlisted fields and 12-hex SHA-256 refs only |
| Windows Task | current-user interactive, Limited, AtLogOn | hidden Windows PowerShell action; indefinite PT1M LogonTrigger repetition for an exited daemon; `IgnoreNew` overlap fence; demand start; `StartWhenAvailable`; PT0S execution limit |
| Windows launch failure | Task Scheduler `RestartOnFailure` | 3 attempts at PT1M for unmet start conditions or action-start failure; not process-exit recovery |
| Windows lifecycle wait | 90s | positive bounded override only; force is uninstall-only and follows graceful timeout |

## Operator workflow and rollback

Build and stage an immutable release with `pnpm install --frozen-lockfile`,
`pnpm --filter @dev-infra/orca-slack-bridge build`, and
`pnpm --filter @dev-infra/orca-slack-bridge stage:windows`. Use only the absolute release printed by
the staging command:

```powershell
& $node "$release\dist\cli.js" install --app-root $release --node $node `
  --orca '<orca.exe>' --config '<credential-free config>' --state '<state.db>' `
  --log-dir '<log directory>'
& $node "$release\dist\cli.js" status --config '<config>' --state '<state.db>' `
  --log-dir '<log directory>' --json
& $node "$release\dist\cli.js" logs --log-dir '<log directory>' --tail 200
& $node "$release\dist\cli.js" run-now --wait-seconds 90
& $node "$release\dist\cli.js" uninstall --wait-seconds 90
```

Plain install does not start the task; add `--run-now` to install only when an immediate bounded
health wait is intended. Use `logs --follow` for a bounded operator session and the allowlisted
`--job` filter when narrowing output. `uninstall --force` is allowed only after the graceful wait
times out and reauthenticates the exact owned task/release before stop and unregister.

The managed AtLogOn trigger repeats indefinitely every PT1M while the task is enabled. A healthy
daemon remains single because `MultipleInstancesPolicy=IgnoreNew`; an exited daemon is relaunched at
the next repetition. `RestartOnFailure` remains an independent three-attempt PT1M fence for failures
to satisfy start conditions or start the action. Uninstall disables the exact owned task before it
requests daemon stop, so the repetition cannot create new work after the shutdown fence.

The task action invokes the absolute System32 Windows PowerShell with
`-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass`. The hidden style
is part of the protected semantic fingerprint and both the launcher and `run-now` dynamic readers
reject an omitted or non-hidden value as action drift.

Rollback means selecting the prior immutable staged release and running that release's `install`
command with the same six absolute operator inputs; task XML and protected manifest replacement are
CAS checked and rolled back on post-registration mismatch. Do not delete state, config, logs, or
release roots as part of rollback. The pre-supervisor-hotfix production Task is not accepted merely
because its orphaned daemon was healthy. The repaired exact merged-main release satisfied the Task
supervisor condition: Task state and direct parent/child ownership remained healthy past the
observed boundary. Final O1 acceptance is nevertheless reopened for the later status-rotation race
and requires a merged fixed release production check.

## Privacy boundary

The repository stores no token, workspace/channel/user ID, real repository identity, absolute
operator path, message payload, or Task export. Tokens remain process environment inputs; the Task
contains only the protected manifest launcher binding. Logs and status expose fixed codes, timestamps,
counts, and hashed refs. Disposable Windows evidence records aggregate booleans/counts only and never
retains its generated task name, paths, XML, process command line, or mock state.

## Recorded results

- Status capability-rotation hotfix local qualification: focused
  `test/operational-status.test.ts` passed 1 file, 51 tests passed and 9 platform-skipped (60 total);
  workspace typecheck PASS. This is merge qualification only; fixed-release production acceptance
  remains pending.
- Node 26.8.1 focused hard-crash acceptance: 1 file, 2/2 tests passed; bridge typecheck PASS.
- Supervisor hotfix focused Windows suite: 4 files, 60/60 tests passed. Full O1-7 hermetic gate:
  75 files passed, 1,666 tests passed, 9 platform-skipped; workspace typecheck and bridge build PASS.
- Exact hotfix head `73ebddcca7c6584e9b197caef2103ab43821181f`: GitHub Actions run
  `33092888227` passed `test` and `typecheck`; the final documentation-only inference correction then
  passed a scoped independent read-only re-audit. PR #48 squash-merged as exact `main`
  `da76bf3cd76b4979154ee8dcd6706ce3627f2a5e`.
- The pre-repair disposable sample proved that an already-started Exec exiting 23 does not activate
  `RestartOnFailure`; every run still ended with residual task/process/file `0/0/0` and external
  writes `0`. This is the audited O1-6 crash-recovery gap that introduced the PT1M trigger repetition.
- Disposable Windows Task post-repair aggregate: PASS — non-admin create, semantic export, demand
  start, IgnoreNew, observed action exit 23, PT1M OS repetition relaunch, clean exit 0, and residual
  task/process/file `0/0/0`; external writes `0`; failure code `null`.
- Disposable Windows Task supervisor hotfix aggregate: PASS — hidden action export, dynamic demand
  start, one PowerShell parent with one direct Node child, Task state `Running` and attempt count `1`
  for 247 seconds against the 245-second minimum, clean child/parent exit, and residual
  task/process/file `0/0/0`; external writes `0`; failure code `null`.
- The first exact merged-main stage/install exposed the canonical registered-export/rollback gap
  above.
- The second exact merged-main install retained a matched Task/manifest but ended with Task result
  `2` and no new daemon log/heartbeat; the following merged-main SID repair reached daemon startup.
- The release from exact `533a4a9530fdd6f6ddc20ba6a265ded3e7a0d3e6` then exposed the
  `0xC000013A` Task-console boundary and orphaned one healthy daemon.
- Production control PASS: exact merged `main` `da76bf3cd76b4979154ee8dcd6706ce3627f2a5e`
  staged immutable release
  `1eb41697c6c22f51893adbf4e89fdd864bb399d4a6e0fdba8ed4a978cd93fd38`; plain install created the
  exact current-user Task and its exported argv contained `"-WindowStyle" "Hidden"`. From the
  2026-08-28 01:28:19 +09:00 demand start through the 332-second beyond-boundary observation, the
  Task remained `Running` with result `267009`, exactly one Windows PowerShell launcher and one
  direct Node daemon child retained the same identities, heartbeat remained fresh, and
  schema/config/build/task ownership all remained matched/healthy. Repository discovery, Run
  observer, and facts-only PR digest each recorded a new successful production attempt after that
  start with zero consecutive failures. The installed CLI then returned
  `run-now action=already-healthy` without starting a second instance.
- The read-only aggregate remains `degraded` with `job.absent`, `registry.rejected`, and
  `work.pending`. The absent Gate/Channel jobs correspond to the separately preserved D3
  `LIVE_CHANNEL_UNVERIFIED` state; the registry/work backlog is reported as existing state rather
  than hidden. None indicates a failed O1 supervisor, stale heartbeat, failed O1 background job, or
  build/config/schema/task mismatch, so these separate conditions do not revoke the supervisor
  evidence.
- Later production sampling on exact `main` `e56d9d79beccb4eb639fc4b1b638c92e51957ef5`
  observed intermittent `state.snapshot_unavailable` aligned with the 15-second capability rotation
  while Task/process ownership and heartbeat stayed healthy. This reopens final O1 production
  acceptance until the merged fixed release passes repeated rotation-boundary status sampling.
