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
  uncertain result. D3 recovery accepts the daemon owner signal, distinguishes an owner stop from a
  real reconcile deadline, and synchronously releases the exact resume-observation lease before a
  non-cooperative Orca read is detached.
- `ChannelPipeServer.quiesce()` retires sessions, queued production work, deadlines, and permits
  without releasing listener ownership. Its snapshot exposes every daemon-owned socket, timer,
  binding read, receipt ACK, production permit/active/queued/ready event, and inbound message count.
- Adapter and MCP cleanup phases are independently bounded. MCP stdio stdout error, close, and
  synchronous write failure each reject all blocked writes, wake `waitClosed()` while stdin remains
  open, and remove only its exact `drain`/error/close listeners under re-entrant close. The
  acceptance fixtures verify exact process signal-listener restoration and zero pipe/Adapter
  resource snapshots.
- The checked-in MCP example has no token, state, or config value. The operator guide requires
  manual merge/trust/approval and manual every-launch development warning confirmation; the harness
  never starts Claude or edits user configuration.

## Executable failure matrix

The focused matrix is the union of one stateful production-path daemon composition and the existing
component fault seams. Collectively they use temporary SQLite, isolated local-pipe fixtures
(including explicit production fixed-pipe ownership checks), fake tokens, and injected
Orca/Slack/Socket boundaries only; a row does not imply that every listed crash point is repeated
through `runDaemonCommand`.

| Boundary | Executable proof | Result |
|---|---|---|
| daemon start/stop ownership | actual `runDaemonCommand` + `ChannelPipeServer` + `ChannelAdapterClient`; pipe-before-Socket startup, quiesce-before-Socket-stop, pipe release last | pass |
| stateful default D3 chain | real SQLite D2 resolved seed + default delivery/resume engines + real pipe/Adapter: baseline → attempted → receipted → consumed → exact post-baseline witness → same channel/ts Slack update, across owner abort/restart and generation 1→2 | pass |
| second daemon and runtime owner loss | real fixed-pipe contender never constructs Socket; quiesced owner still rejects bind; injected post-listen fatal stops Socket and returns 1 | pass |
| startup signal and listener cleanup | invoke each newly installed SIGINT/SIGTERM listener after the real pipe is owned while outer startup never settles; Socket factory stays at zero; exact listener arrays restored and the pipe rebinds | pass |
| Socket candidate/reconnect lifecycle | pre-hello candidate, reconnect candidate, previous/retired connection, close rejection/timeout, and real `@slack/socket-mode` v3 overlap matrix | pass |
| Adapter reconnect/epoch | Adapter-first connection and daemon restart force a new epoch; the stateful consumed Gate does not replay, while focused transport seams fence stale epoch/generation receipts | pass |
| multi-session routing | exact binding sends once; same-binding pair is ambiguous and sends zero; retiring one leaves one eligible candidate | pass |
| Run generation takeover | old claim is retired before routing; fresh capture/epoch is required; old receipt/ACK is fenced and new generation replays | pass |
| no-flag and policy simulation | successful notification write without receipt and rejected notification both remain `unverified`; production writes stay zero | pass |
| transport/receipt/consumed crash ladder | the stateful daemon chain proves the durable happy/restart sequence; focused delivery/store suites inject send-before-attempt, attempted-before-receipt, durable receipt-before-ACK, receipt-before-effect, exact effect-before-consumed, and restart/replay | pass |
| duplicate and late events | duplicate exact receipt is idempotent; receipt-before-attempt and late attempted never regress; wrong Gate/epoch/generation/deadline has zero effect/ACK | pass |
| migration/restart | fresh v12 equals populated v10→v11→v12; authentic v11 unavailable rows retain retry/consume liveness but cannot create resume evidence; future/corrupt shapes fail closed | pass |
| Task resume evidence | the stateful chain persists one exact post-baseline Task/Dispatch witness; focused resume suites cover immutable baselines and ambiguous/pre-existing/unrelated/failed negatives | pass |
| Slack timeout/stale projection | focused projection suites prove timeout replay, stale/late generation fencing, and post-success convergence; the stateful chain proves the existing card is updated at the same channel/ts with zero post | pass |
| bounded shutdown and late work | owner-aborted Orca/Slack/delivery operations settle promptly, exact resume leases release immediately without a 30s wait, and late non-cooperative completions cannot overwrite a successor or touch closed state | pass |
| leak freedom | repeated stop/rebind reaches zero sockets/timers/permits/queues/inbound messages, zero Adapter timers/writes, zero blocked stdio/output listeners, and baseline process listeners | pass |
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
| `pnpm acceptance:d3-4` focused matrix | pass — 19 files, 379 tests |
| `pnpm typecheck` | pass |
| app build | pass |
| `pnpm test` | pass — 54 files, 1181 tests |
| `git diff --check` | pass |
| independent GPT chaos/security audit | initial exact-head audit requested changes; repaired exact-head rerun pending coordinator dispatch |
| final integrated GPT audit | initial exact-head audit requested changes; repaired exact-head rerun pending coordinator dispatch |
| CI | initial head passed; repaired exact-head run pending push |

## Audit repair log

The initial independent GPT reviews additionally identified held pipe startup after a production
signal, stdout failure with stdin still open, abort-stranded resume leases, and the absence of one
stateful default-engine daemon composition. The repaired tree adds exact regressions for all four.
Approval still requires fresh reviews of the pushed repaired head; the coordinator owns those
exact-head audits.

## Offline residual, narrowed but not closed by live observation

No actual Claude Code 2.1.243 Channel was registered or launched, no development warning was
confirmed, no user `.mcp.json` or Bridge configuration was changed, and no live Slack or Orca
resource was mutated. Offline notification writes, probe receipts, Gate consumption, and simulated
Task/Dispatch shapes do not prove that a real coordinator resumed.

On 2026-08-26 the operator personally approved an interactive Claude Code 2.1.243 development
Channel session, and the exercise observed the post-baseline Orca Dispatch witness, same-message
Slack update, duplicate-receipt no-op, and restart/reconnect behavior. The session Adapter had been
launched from the pre-repair build while the daemon was rebuilt after the authority repair, so this
does not satisfy the one-exact-build release condition. Keep `LIVE_CHANNEL_UNVERIFIED`; see
[D3 live Channel acceptance evidence](d3-live-channel-acceptance.md).
