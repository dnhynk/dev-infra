# D3 live Channel acceptance evidence

Date: 2026-10-01

Accepted build: merged `main@7c80b6c` (squash merges of #56 and #57). Staging that commit yields
release digest `e27b1299b67975cbe21012ed9b9193bc8798c98bb483d0cc97c1db329fd592a6` with
`status=unchanged`. That is the release the acceptance ran on; it was built from `e164a0b`, whose
tree differs from `7c80b6c` only in one test file.

Status: **ACCEPTED** — `LIVE_CHANNEL_UNVERIFIED` is released (DL-071)

All Slack, Orca, terminal, message, Gate, Task, Dispatch, user, and mutation identifiers are
redacted in this document. The operator database and Slack workspace remain the authoritative
correlation sources.

## Environment

| Component | Version and launch path |
|---|---|
| Bridge daemon | Windows Scheduled Task running the release above, installed before the session started |
| Session Adapter | the same release, started by `plugins/orca-slack-channel/launch-adapter.mjs` from `runtime.json` |
| Claude Code | 2.1.286, interactive, `--channels plugin:orca-slack-channel@dev-infra`. The allowlisted plugin path shows no development-channel warning |
| Orca | 1.4.217 |
| Worker | Codex CLI 0.159.0 through `worker-start --agent codex`, with model and effort unspecified |

The coordinator prompt created a throwaway Run, one read-only Task and one two-option Gate. It
contained no channel or receipt rule, so the session acted only on the Adapter's MCP instructions.

## Acceptance result

| Criterion (ops §5) | Result | Redacted evidence |
|---|---|---|
| Bridge-owned Slack action resolves one pending Gate | pass | the first valid selection was claimed and acked; Orca's final resolution matched the selected option |
| durable delivery order | pass | `pending -> attempted -> receipted -> consumed` with one attempt; consumed 6 s after the receipt |
| receipt alone claims no resume | pass | the four card projections before the witness showed only resolution and coordinator states |
| post-baseline Orca work resumes | pass | the coordinator receipted without asking, re-read the Gate, and followed its recorded resolution with one Codex worker. Codex readiness passed and the Task completed |
| existing Slack card updates after the witness | pass | a `new_dispatch` witness (`ready -> dispatched`), then the same channel/ts re-rendered 10 s later. The operator saw `▶️ 작업 재개` on that card |
| duplicate/late receipt is harmless | pass | `receipt_duplicate`; delivery, witness, mapping and Slack row counts unchanged |
| daemon restart and Adapter reconnect are harmless | pass | uninstall and install on the same release. The same Adapter process reconnected and receipted the new probe without asking. No Gate replay, delivery or root-intent event, or new Slack message |
| generation takeover | not applicable | no takeover occurred; the offline failure matrix covers stale-generation fencing |
| one exact build for daemon and session Adapter | pass | both processes ran the release above |

## Session-start probe window

Claude Code attaches a channel server's MCP instructions and its deferred-tool notice to the next
human prompt or tool result. It does not attach them to turns started by channel events (DL-070).
In the 2.1.285 and 2.1.286 sessions the first four probes arrived before either, so the session had
neither the instructions nor the receipt tool and asked the operator what the empty events meant.
After the notice was attached, every event was receipted without a question: probes after both
daemon restarts and the production Gate. Probe retries completed route verification without
operator help.

## Incidents during the run

- The first four clicks were each audited as `card_mapping_not_matched`, and the operator saw no
  response. The Run observer had overrun its 90 s deadline after staging the card and still held
  the card's write lease. The next observer pass released it. This D2 defect is tracked separately.
- The daemon stopped twice without a launcher exit record, once before and once after the
  acceptance checks. The task repetition restarted it after 2 minutes and after 19 seconds. One
  click in the first window was not delivered. Both times the operator had closed or reopened
  Windows Terminal. On this host it holds the launcher's console as a minimized window, so the
  launcher ended and the daemon stopped on stdin EOF. The launcher now detaches from its console at
  start (DL-072). After the first restart, the same Adapter reconnected and receipted the new probe
  without asking.

## 2026-08-26 split-build observation

The same functional criteria passed on 2026-08-26 in a session that used the development-channel
flag. The session's Adapter predated the authority repair below, while the daemon ran the repaired
build, so the one-exact-build condition was not met.

## Live defect found and repaired (2026-08-26)

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

## Verification checkpoint (2026-10-01)

| Command or observation | Result |
|---|---|
| `tsc --noEmit` (app including tests) | pass |
| Bridge build | pass |
| full app tests (`vitest run --maxWorkers=2`) | 1,760 pass and 5 fail. Four tests need the production fixed pipe and failed because the live daemon owned it; they failed identically with and without the change under test. One status test is a known parallel-only failure and passes alone |
| merged `main` stage | the same digest as the accepted release, `status=unchanged` |

The pipe-ownership tests were not rerun with the daemon stopped. While it is stopped, the open
Claude sessions' Adapters reconnect to whichever process owns the fixed pipe, including a test
server.

## Retained operator state

No repository secret, Slack token, raw payload, or private identifier was recorded. The throwaway
Run, Task and Gate remain in Orca, and the test coordinator terminal remains open for the operator.
A pre-recovery SQLite backup from 2026-08-26 remains outside the repository. It contains operator
data and must be removed only as an explicit, verified cleanup action.
