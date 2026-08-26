# D3 live Channel acceptance evidence

Date: 2026-08-26

Reviewed base: `origin/main@014de3163f2165326ceb03a6cf146ec258d0902e`

Acceptance checkout: `dnhynk/d3-live-channel-acceptance`

Status: **LIVE_CHANNEL_UNVERIFIED** — live path observed; one-exact-build rerun remains

All Slack, Orca, terminal, message, Gate, Task, Dispatch, user, and mutation identifiers are
redacted in this document. The operator database and Slack workspace remain the authoritative
correlation sources.

## Human-approved live boundary

The operator started the interactive Claude Code 2.1.243 session from the pre-repair checkout and personally approved the
`--dangerously-load-development-channels server:orca-slack` warning in the Orca UI. No agent
started that session, approved the warning, replaced the user's `.mcp.json`, or wrote a secret to
the repository. The daemon's exact-epoch probe reached that session and its receipt tool returned
to the daemon before the production Gate was exercised.

The first mutation then exposed the authority defect described below. The daemon was rebuilt with
the repair while the already-approved Claude session and its Adapter remained live. Therefore the
functional observations below are valid split-build observations, but they are not the immutable
one-build evidence required to release `LIVE_CHANNEL_UNVERIFIED`.

## Live acceptance result

| Criterion | Result | Redacted evidence |
|---|---|---|
| Bridge-owned Slack action resolves one pending Gate | pass | exact owner/workspace/action correlation; final Orca resolution matched the selected option |
| durable delivery order | pass | `pending -> attempted -> receipted -> consumed`, with two bounded attempts |
| receipt alone claims no resume | pass | resume evidence stayed empty after receipt and consumption |
| post-baseline Orca work resumes | pass | one new source Dispatch was observed as `ready -> dispatched` after the baseline |
| existing Slack card updates after the witness | pass | the mapped channel/message identity stayed unchanged; the edited card showed `작업 재개` only after the Dispatch witness |
| dependent GPT work runs | pass | the source and dependent read-only smoke Tasks both reached `completed`; all implementation/smoke workers were Codex/GPT |
| duplicate/late receipt is harmless | pass | a late receipt returned `receipt_unavailable`; delivery, witness, mapping, and Slack root/reply counts did not change |
| daemon restart and Adapter reconnect are harmless | pass | the daemon drained on interrupt, the fixed pipe became available to tests, the daemon restarted on the same state/config, the existing Adapter reconnected and receipted a fresh probe, and no Gate replay or duplicate Slack message appeared |
| generation takeover | not applicable | no coordinator takeover occurred during this acceptance; the offline failure matrix covers stale-generation fencing |
| one exact repaired build for daemon and session Adapter | **not satisfied** | the human-approved Adapter process remained from the pre-repair build while the daemon used the repaired build |

The Slack desktop surface was inspected after projection. It contained one edited Gate-card reply
under the existing Run thread, showed `작업 재개`, and contained no second Gate root/reply for the
accepted Gate. The durable store independently contained one Gate-message mapping, one consumed
delivery row, one immutable resume witness, and no pending card projection.

## Live defect found and repaired

The first Slack mutation exposed an authority-boundary defect that the hermetic runner did not
model. A separately running daemon inherited `ORCA_AGENT_LAUNCH_TOKEN` from the Orca terminal that
launched it. That ambient terminal attestation conflicted with the daemon's external-service role,
so an otherwise correct Gate mutation failed before the current Run authority could be used.

The repair is deliberately narrow:

- every daemon-spawned Orca CLI child inherits ordinary runtime discovery variables but drops only
  `ORCA_AGENT_LAUNCH_TOKEN`;
- immediately before `gate-resolve`, the client strictly reads the target Run's current
  `coordinator_handle` from `run-show`;
- the mutation uses that exact handle through `gate-resolve --from`;
- malformed, missing, stale, or mismatched Run rows fail closed before the mutation.

The original durable action request was recovered using the same retry identity. The structured
Orca replay result was persisted, the normal lifecycle engine completed reconciliation, and no
second Gate mutation was manufactured.

Because no immutable repaired tree was captured at the original session launch, the successful
functional path does not override the operator procedure's one-exact-build release rule. A final
merged-build rerun must launch the Adapter and daemon from that same build, receive a new exact-epoch
probe receipt, and repeat the post-baseline resume plus same-message projection observation.

## Verification checkpoint

The daemon was stopped before the executable acceptance so the production fixed-pipe ownership
tests could run without an intentional live-owner collision. It was restarted afterward against
the same reviewed build, operator configuration, and state database.

| Command or observation | Result |
|---|---|
| targeted authority/environment tests | pass — 63 tests |
| `pnpm acceptance:d3-4` focused matrix | pass — 19 files, 379 tests |
| root/app typecheck | pass |
| Bridge build | pass |
| full repository tests | pass — 54 files, 1,189 tests |
| post-restart daemon process | pass — exactly one matching daemon owner |
| post-restart durable invariants | pass — one mapping, consumed delivery, immutable `new_dispatch` witness, no projection error |

The first full-suite attempt while the production daemon still owned the fixed pipe failed only the
three ownership tests that intentionally require that pipe. After the bounded daemon stop, the same
suite passed in full; this is expected operational exclusion rather than a flaky retry.

## Cleanup and retained operator state

No repository secret, Slack token, raw payload, or private identifier was recorded. The manually
provided `.mcp.json` remains untracked and unchanged. The temporary acceptance daemon was stopped
with its bounded interrupt path before final merge validation; O1 will replace it with the stable
startup-managed service. A pre-recovery SQLite backup remains outside the repository until the
merged repair and O1 startup path are proven; it contains operator data and must be removed only as
an explicit, verified cleanup action.
