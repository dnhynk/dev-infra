# D3-4 lifecycle/chaos acceptance evidence

Date: 2026-08-26

Base: `origin/main@bb7344f6ee68a94dc1c087cdab28d5c6861a92b5`

Branch: `dnhynk/d3-4-lifecycle-acceptance`

Orca: Run `run_f93a72e6ef6e`, Task `task_6ea165cbe114`, Dispatch `ctx_b289c2cffb59`

PR: [#37](https://github.com/dnhynk/dev-infra/pull/37)

## Delivered boundary

D3-4 adds no schema, lifecycle state, Task mutation, Slack message identity, or Channel authority
semantic. It closes the production ownership and shutdown boundary around the already-merged D2 and
D3 state machines and makes their acceptance evidence executable.

- `runDaemonCommand` acquires the fixed pipe before recovery or Slack ingress, arms production
  SIGINT/SIGTERM handling before startup awaits, treats post-listen pipe loss as fatal, runs D2 and
  D3 recovery in independent bounded flights, and rejects a second daemon before Socket creation.
- Shutdown first disables Slack intake and periodic recovery, quiesces Adapter sessions while the
  fixed pipe remains bound, closes Socket ingress, drains accepted ACK/CAS work within one bounded
  grace, and only then releases the pipe and closes SQLite. A contender cannot overlap the old
  daemon's external-work drain.
- Slack Socket candidates cannot deliver envelopes until exact hello/App-ID verification and atomic
  promotion. Candidate, previous, retired, and post-stop callbacks stay unACKed for authoritative
  Slack redelivery. Immediate close failure and timeout each run one bounded cleanup retry and
  surface fixed redacted errors.
- D2 recovery now has a rotating batch and global deadline. Owner cancellation reaches exact Orca
  reads/mutation, Slack update-in-place projection, and late-result fences without manufacturing an
  uncertain result. D3 recovery accepts the daemon owner signal and distinguishes an owner stop
  from a real reconcile deadline.
- `ChannelPipeServer.quiesce()` retires sessions, queued production work, deadlines, and permits
  without releasing listener ownership. Its snapshot exposes every daemon-owned socket, timer,
  binding read, receipt ACK, production permit/active/queued/ready event, and inbound message count.
- Adapter and MCP cleanup phases are independently bounded. MCP stdio shutdown rejects blocked
  writes and removes its exact `drain` listeners, including re-entrant close during `write()`.
  The acceptance fixtures verify exact process signal-listener restoration and zero pipe/Adapter
  resource snapshots.
- The checked-in MCP example has no token, state, or config value. The operator guide requires
  manual merge/trust/approval and manual every-launch development warning confirmation; the harness
  never starts Claude or edits user configuration.

## Executable failure matrix

The focused matrix is the union of a new full lifecycle composition and the existing state-machine
fault seams. Every row runs with temporary SQLite, unique local pipes, fake tokens, and injected
Orca/Slack/Socket boundaries only.

| Boundary | Executable proof | Result |
|---|---|---|
| daemon start/stop ownership | actual `runDaemonCommand` + `ChannelPipeServer` + `ChannelAdapterClient`; pipe-before-Socket startup, quiesce-before-Socket-stop, pipe release last | pass |
| second daemon and runtime owner loss | real fixed-pipe contender never constructs Socket; quiesced owner still rejects bind; injected post-listen fatal stops Socket and returns 1 | pass |
| startup signal and listener cleanup | invoke only the newly installed SIGTERM listener while pipe startup is pending; Socket factory stays at zero; exact listener arrays restored | pass |
| Socket candidate/reconnect lifecycle | pre-hello candidate, reconnect candidate, previous/retired connection, close rejection/timeout, and real `@slack/socket-mode` v3 overlap matrix | pass |
| Adapter reconnect/epoch | daemon restart forces a new epoch; stale epoch/generation receipt is rejected; current unreceipted Gate replays | pass |
| multi-session routing | exact binding sends once; same-binding pair is ambiguous and sends zero; retiring one leaves one eligible candidate | pass |
| Run generation takeover | old claim is retired before routing; fresh capture/epoch is required; old receipt/ACK is fenced and new generation replays | pass |
| no-flag and policy simulation | successful notification write without receipt and rejected notification both remain `unverified`; production writes stay zero | pass |
| transport/receipt/consumed crash ladder | send-before-attempt, attempted-before-receipt, durable receipt-before-ACK, receipt-before-effect, exact effect-before-consumed, restart/replay | pass |
| duplicate and late events | duplicate exact receipt is idempotent; receipt-before-attempt and late attempted never regress; wrong Gate/epoch/generation/deadline has zero effect/ACK | pass |
| migration/restart | fresh v12 equals populated v10→v11→v12; authentic v11 unavailable rows retain retry/consume liveness but cannot create resume evidence; future/corrupt shapes fail closed | pass |
| Task resume evidence | immutable pre-send baseline, exact source/descendant Task-worker-Dispatch cut, ambiguous/pre-existing/unrelated/failed negatives, unique post-baseline witness only | pass |
| Slack timeout/stale projection | timeout remains replayable; stale/late success cannot clear a newer generation; crash after Slack success converges by update-in-place to the same channel/ts | pass |
| bounded shutdown and late work | owner-aborted Orca/Slack/delivery operations settle promptly, release leases without false deadline state, and late non-cooperative completions cannot touch closed state | pass |
| leak freedom | repeated stop/rebind reaches zero sockets/timers/permits/queues/inbound messages, zero Adapter timers/writes, zero blocked stdio `drain` listeners, and baseline process listeners | pass |
| harness/operator safety | static assertions reject secret/config/state-bearing MCP examples, Claude spawning, user MCP writes, and live-verification claims | pass |

Focused suite routing:

- lifecycle composition and operator safety: `d3-lifecycle-acceptance.test.ts`, `cli-daemon.test.ts`,
  `cli-channel-adapter.test.ts`, `channel-mcp-server.test.ts`;
- transport, ownership, routing, deadlines, duplicate/late events: `channel-pipe.test.ts`,
  `slack-socket.test.ts`, `slack-socket-sdk.test.ts`, `channel-protocol.test.ts`;
- crash/migration/delivery/consume: `gate-resolve.test.ts`, `gate-resolution-store.test.ts`,
  `channel-delivery.test.ts`, `channel-delivery-store.test.ts`,
  `channel-delivery-bounded-seed.test.ts`;
- Task resume and Slack projection: `channel-resume.test.ts`, `channel-resume-store.test.ts`,
  `gate-resolution-render.test.ts`, `post.test.ts`.

## Verification checkpoint

Commands were run from the repository root. No actual Claude Channel, Slack, Orca Gate/Task, or
other product write was performed.

| Command | Result |
|---|---|
| `pnpm acceptance:d3-4` focused matrix | pass — 19 files, 370 tests |
| `pnpm typecheck` | pass |
| app build | pass |
| `pnpm test` | pass — 54 files, 1172 tests |
| `git diff --check` | pass |
| independent GPT chaos/security audit | pending coordinator dispatch on pushed exact head |
| final integrated GPT audit | pending coordinator dispatch after chaos/security approval |
| CI | pending pushed PR |

## Audit repair log

The implementation worker's parallel read-only preflight identified and repaired candidate Socket
event admission, post-listen pipe failure propagation, late signal installation, serial/unbounded D2
recovery, premature pipe ownership release, post-stop route reads, incomplete resource accounting,
immediate Socket close failure cleanup, unbounded MCP close, and false-success/re-entrant stdio
backpressure cleanup. These preflights are not counted as the required independent Orca audits;
the coordinator owns those exact-head reviews.

## Residual: `LIVE_CHANNEL_UNVERIFIED`

No actual Claude Code 2.1.243 Channel was registered or launched, no development warning was
confirmed, no user `.mcp.json` or Bridge configuration was changed, and no live Slack or Orca
resource was mutated. Offline notification writes, probe receipts, Gate consumption, and simulated
Task/Dispatch shapes do not prove that a real coordinator resumed.

Keep `LIVE_CHANNEL_UNVERIFIED` until the coordinator manually confirms the every-launch warning in
an interactive Claude Code 2.1.243 development-channel session and observes both the exact
post-baseline Orca Task/Dispatch resume witness and the corresponding existing Slack card update on
the reviewed build.
