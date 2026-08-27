# O1 operational acceptance evidence

Status: **disposable Windows and local hermetic aggregate PASS; launcher SID hotfix CI and fixed-merge production deployment pending**

This evidence is for O1-7 only. The baseline was clean merged `main` at
`c26a53a7faf1b3c57aa384e88b2874362ecc3d2f`; O1-5 and O1-6 had independent canonical PASS
audits before this branch started. No production Slack, GitHub, Orca, Scheduled Task, state, or
credential was used by the disposable acceptance. D3 remains `LIVE_CHANNEL_UNVERIFIED` and is not
changed by O1 evidence.

The first production install from exact merged `main` at
`8d857f94c0ad44617071aaa97a4756cd9e114b42` exposed a Windows registered-export
canonicalization and absent-create rollback gap and ended with
`windows.install.rollback_failed`. The exact owned residual task was safely removed and no manifest
or daemon process remained; production installation is pending the fixed merge.

The second production install from exact merged `main` at
`a3e018bffef633e8d55d3e2dc2dc1c50f8a846b2` left the owned Task and protected manifest
semantically matched, but the Task ended with last result `2` and produced no new daemon log or
heartbeat. The launcher rejected the canonical exported account name before daemon start because
its dynamic binding verifier did not receive the trusted resolved LogonTrigger SID; deployment of
this second hotfix remains pending its fixed merge.

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
| privacy and operability | `operational-logger` and `operational-status` focused files | allowlisted NDJSON only, hashed refs, bounded rotation, read-only status, and exact pending/uncertain/dead aggregates without identities |
| current-user Scheduled Task | `o1-7-windows-scheduled-task-acceptance.ps1` under a process-wide mutex | unique exact target, non-admin create, semantic export, demand start, IgnoreNew, bounded PT1M TimeTrigger relaunch after exit 23, clean exit 0, exact unregister, and residual task/process/file counts all zero |

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
| capacity | 16 repositories; 64 Runs; 16 Orca IDs per canonical | hard maxima 64 / 256 / 64; overflow fails closed without truncation |
| operational logs | 5 MiB active file; 5 backups | 16 KiB canonical NDJSON line; allowlisted fields and 12-hex SHA-256 refs only |
| Windows Task | current-user interactive, Limited, AtLogOn | indefinite PT1M LogonTrigger repetition for an exited daemon; `IgnoreNew` overlap fence; demand start; `StartWhenAvailable`; PT0S execution limit |
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

Rollback means selecting the prior immutable staged release and running that release's `install`
command with the same six absolute operator inputs; task XML and protected manifest replacement are
CAS checked and rolled back on post-registration mismatch. Do not delete state, config, logs, or
release roots as part of rollback. Production installation remains pending until this hotfix is merged,
the merged-main release is deployed, and its local startup/status smoke passes.

## Privacy boundary

The repository stores no token, workspace/channel/user ID, real repository identity, absolute
operator path, message payload, or Task export. Tokens remain process environment inputs; the Task
contains only the protected manifest launcher binding. Logs and status expose fixed codes, timestamps,
counts, and hashed refs. Disposable Windows evidence records aggregate booleans/counts only and never
retains its generated task name, paths, XML, process command line, or mock state.

## Recorded results

- Node 26.8.1 focused hard-crash acceptance: 1 file, 2/2 tests passed; bridge typecheck PASS.
- Exact-head CI: pending PR validation. The named O1-7 step runs the complete bridge Vitest suite once;
  the separate typecheck job is the only other code-validation invocation.
- The pre-repair disposable sample proved that an already-started Exec exiting 23 does not activate
  `RestartOnFailure`; every run still ended with residual task/process/file `0/0/0` and external
  writes `0`. This is the audited O1-6 crash-recovery gap that introduced the PT1M trigger repetition.
- Disposable Windows Task post-repair aggregate: PASS — non-admin create, semantic export, demand
  start, IgnoreNew, observed action exit 23, PT1M OS repetition relaunch, clean exit 0, and residual
  task/process/file `0/0/0`; external writes `0`; failure code `null`.
- The first exact merged-main stage/install exposed the canonical registered-export/rollback gap
  above. The fixed-merge production stage/install and local startup/status smoke remain pending.
- The second exact merged-main install retained a matched Task/manifest but ended with Task result
  `2` and no new daemon log/heartbeat; the launcher SID-forwarding repair is pending fixed-merge
  deployment.
