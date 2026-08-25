# D3-2 durable Channel delivery evidence

Date: 2026-08-25

Base: `origin/main@8caf3cfa81fc8333846376e5fa35bff4efc9c730`

Branch: `dnhynk/d3-2-durable-delivery`

PR: #35

## Delivered boundary

This slice turns the D3-1 verified transport into a live production caller while keeping delivery,
application receipt, Gate effect, and Task resume as separate facts.

- Schema v11 adds only `gate_channel_delivery` plus its due/run indexes. The v10
  `gate_resolution_outbox` DDL and its `notification_state='pending'` contract are unchanged.
- The daemon lazily and idempotently materializes only acknowledged, terminal D2 rows with exact
  stored pending-to-resolved evidence. Migration itself performs no inferred backfill.
- An exact-base v10 recovery row whose pending baseline was already overwritten by a resolved
  snapshot is quarantined by omission: it cannot poison startup and cannot manufacture D3 evidence,
  while independently provable companion rows still seed normally.
- Delivery state is monotonic `pending -> attempted -> receipted -> consumed`, with a revision CAS,
  acquisition-specific expiring lease ownership, bounded retry/error fields, and strict timestamp,
  lifecycle, D2-correlation, foreign-key, column, DDL, and allowed-object validation.
- Delivery scheduling uses a process-monotonic logical clock initialized from the greatest persisted
  v11 lifecycle timestamp. Every due check and mutation advances by at least monotonic elapsed time
  and clamps to wall time plus row-local causal evidence inside the CAS transaction, so rollback,
  equality, and a slowly advancing wall cannot stall retries or leases. Requested delays and lease
  durations are preserved from that effective time, and every lifecycle event remains at or before
  `updated_at`.
- Every state transition and the existing Gate card-outbox re-arm share one `BEGIN IMMEDIATE`
  transaction. The v11 row records the exact re-armed outbox revision as durable provenance; a
  stale card projection revision cannot clear the newer generation.
- A Channel-originated outbox generation is deliberately deferred from the unchanged D2 projector.
  Periodic reconciliation omits that exact revision, direct projection returns without a Slack
  call, and the row remains `card_pending=1` across restart. The store exposes only an exact
  delivery-revision plus outbox-revision claim for D3-3 to acquire that generation later.
- Exact-claim recovery, takeover, and explicit release advance the outbox generation, delivery
  revision, deferred provenance, and new claim identity together. A stale projection owner cannot
  consume the replacement generation, while the ordinary D2 projector still sees no deferred row.
  The same dual CAS preserves a live independent delivery lease and clears it at exact expiry, so
  provenance advancement cannot violate the v11 lease clock or revive its stale delivery owner.
- `attempted` means only that the Adapter's MCP notification write resolved. It may perform a
  non-authorizing `listRuns` read of the current Run to validate that the in-memory route is still
  current, but it never rereads Gate/effect authority, emits a daemon ACK, advances the
  application/production authority revision, consumes the delivery token, or suppresses retry or
  replay. `receipted` is only the reply-tool application callback; neither state is delivery
  consumption or Task resume.
- `consumed` requires a fresh strict `gate-list` reread whose Gate/run/task/options, resolved status,
  resolution, and `resolvedAt` match the durable D2 pending-to-resolved evidence.
- A pending, unreadable, or mismatched fresh Gate remains receipted and retryable with a bounded
  degraded code. No coordinator-side dedup store or second Gate mutation is introduced.

## Routing and crash fences

- Production Gate IDs are written only after the D3-1 opaque probe has been receipted for the exact
  connection epoch and the current Run has one verified current-generation candidate.
- Each send records an in-memory delivery token containing exact Run ID, consumer generation, Gate
  ID, and connection epoch. Attempted and receipt callbacks reread current Run routing and must
  match that token before any durable transition; an old socket after takeover receives no ACK and
  cannot suppress replay to the new current generation.
- Receipt ACK is emitted only after the synchronous durable callback succeeds. A callback failure
  deliberately leaves the Adapter receipt retryable.
- Fresh Run route reads for different Gates start concurrently and durable callbacks stay on one
  arrival-ordered chain per connection. Every receipt-side route validation that can precede an
  application-authority commit carries the production callback revision captured before that read
  starts; if a receipt boundary advances while any initial, speculative, or commit-boundary read is
  pending, the stale result cannot inherit the newer revision. An `attempted` current-Run `listRuns`
  check uses the route shape only and is non-authorizing: receipt alone advances the authority/ACK
  boundary, and every later event still honors the latest preceding receipt boundary.
- Production-event admission is daemon-global rather than per connection. Verified connections
  enter one bounded, fair admission scheduler, so one busy connection cannot monopolize the shared
  fresh-read/callback concurrency budget while another connection has eligible work. Per-connection
  ordered commit chains still preserve each connection's receipt authority boundaries.
- Every queued production event retains the original monotonic deadline fixed when that event
  arrived; time waiting for the daemon-global permit is charged to that same budget and cannot
  re-anchor or extend it. Each admitted event owns exactly one permit, returned exactly once on every
  terminal path—including validation rejection or failure, expiry, callback success or throw,
  socket loss/takeover, and daemon stop/cancellation—before the next fair waiter is admitted. An
  event rejected before admission never acquires a permit.
- Adapter receipt deadlines and daemon callback deadlines use monotonic clocks. Protocol v2
  calibrates the two process-monotonic domains during each connection hello, then carries both the
  translated absolute Adapter deadline and its remaining budget. The daemon chooses the earliest
  bound, so Adapter queue/write/drain, pipe transit, validation, ordered wait, durable commit, and ACK
  drain share one non-extensible deadline; equality expires and reconnect recalibrates the mapping.
  External Channel notifications and reply-tool inputs remain strict Gate-ID-only shapes.
- Adapter notification progress pauses behind attempted-frame backpressure and resumes on drain.
  On the daemon side, the same SQLite commit fence requires the current exact token/epoch, time
  budget, writable socket, and no ended, finished, drain-blocked, or write-blocked state immediately
  before commit. Delayed drain or same-socket backpressure therefore cannot produce durable state
  without a sendable ACK.
- The daemon passes a monotonic connection/deadline fence through the production handler into the
  SQLite transition. The store evaluates it after delivery plus card re-arm writes and immediately
  before `COMMIT`; a closed fence rolls the whole transaction back and the pipe emits no ACK.
- Connection-local sent/notified sets are bounded and discarded on reconnect. Multi-Gate MCP
  notifications are serialized, receipt/ACK backpressure queues are bounded sets, and the daemon
  rejects an over-cap asynchronous inbound queue.
- One delivery pass shares a strict batch budget between a limited lazy-seed page and due sends;
  `batchLimit=1` alternates seed and send so neither side starves. Seed uses a transaction commit
  fence, rolls back the whole page on deadline/stop, releases the SQLite writer promptly, and resumes
  idempotently from the next bounded page. Bounded send concurrency plus the 20-second overall
  deadline remains below the 30-second lease expiry, and late injected work cannot write after stop.
- The D2 post-mutation restart path recognizes a persisted structured resolve result as the missing
  post-read. It never overwrites the original pending baseline with the current resolved Gate, so
  restart can finish D2, seed D3, reopen, and start the daemon without corrupting the evidence.

## Regression coverage

The focused suites cover:

- fresh v11 and populated exact v10-to-v11 DDL/column/index equivalence;
- preservation of every v10 outbox value and DDL plus lazy, idempotent seed;
- future schema, unknown object, lifecycle, correlation, clock, and lease corruption rejection;
- pending/attempted/receipt/consumed separation, stale CAS, expired-lease recovery, duplicate receipt,
  receipt-before-attempt, late attempted, and consumed restart;
- post-resolve/pre-post-read fault, close/reopen, failed recovery read, D2 completion, D3 seed,
  another reopen, and production daemon startup;
- rollback seed clock, idempotent reseed, due pacing, and strict reopen;
- populated-v10 quarantine of a legacy overwritten baseline without blocking a valid companion;
- rollback defer after an attempted event and newer lease, delay preservation, stale-CAS
  idempotency, and exact reopen/due pacing;
- send-before-attempt crash, receipt-before-effect crash/restart, exact mismatch/read failure,
  pending-effect redelivery, bounded redacted errors, and no Task mutation;
- overlapping reconcile fencing and multi-row hung-Orca deadline/late-completion safety;
- verified-only production send, ordered multi-Gate callbacks, durable receipt ACK fencing,
  wrong Gate receipt, reconnect replay, and generation-takeover stale receipt rejection;
- four independently verified bindings under a daemon-global cap of two, with a noisy connection
  backlog unable to monopolize admission, cross-connection round-robin progress, and no starvation;
- exact permit cleanup after active socket close, validation timeout, synchronous callback throw,
  asynchronous callback rejection, rejected route read, queued original-deadline expiry, and daemon
  shutdown/restart, with late settlement producing zero durable callback and zero ACK and never
  double-returning capacity;
- a receipt-before-attempted boundary requiring an exact fresh third route read, with attempted
  producing no ACK or Gate/effect authority reread, preserving its finite retry deadline, and
  leaving the Gate resendable;
- three production Gates with overlapping attempted plus receipt events, 1.4-second authority reads,
  exactly nine reads across the required initial/speculative/commit waves, wire-ordered callbacks,
  and all three receipt ACKs inside 4.5 seconds under the production 5-second Adapter window;
- a raw protocol-v2 A/B/C nested race where C's stale initial read is followed by an in-flight
  speculative refresh, A and then B advance the receipt boundary around it, and C settles with zero
  durable effect and zero ACK while the connection fails closed for retry;
- a same-socket receipt/deliver race where ACK writability disappears during the read/drain gap,
  proving zero receipt/re-arm state and zero ACK before replay succeeds on a new connection epoch;
- a synchronous receipt handler crossing its monotonic deadline plus direct SQLite fence tests,
  proving delivery state and the atomic card re-arm both roll back before ACK;
- multi-Gate attempted-frame backpressure with notification pause/drain resume and no lost callback;
- two queued receipts across independent Adapter-send and daemon-ACK drains, decreasing transmitted
  ACK budget, pre-durable wait, post-wait route refresh, ordered durable callbacks, and no late ACK;
- Adapter-write-to-daemon-dispatch transit delay, exact deadline equality, forward/backward wall
  jumps, queued timeout, and reconnect recalibration, proving the original end-to-end budget cannot
  be re-anchored or extended and a late ACK cannot damage the current route;
- frozen-equality and one-millisecond-per-second wall regressions across retry, lease expiry/recovery,
  release, and reopen, proving the persisted logical floor advances at least with monotonic elapsed;
- 2,048 eligible seed rows across bounded pages and restart, whole-page fence rollback, progress by
  a competing writer, disjoint pages from two open writers, production stop during synchronous seed,
  restart progress, combined batch accounting, and one-slot seed/send alternation;
- production daemon startup wiring of the new store/runtime callbacks and reconciliation caller.
- ordinary D2 projection followed by pending/attempted/receipted/consumed D3 transitions, proving
  one pre-D3 Slack update, zero D3 Slack updates, exact pending provenance across restart, reconcile
  omission without a hot loop, and a future D3-3 exact claim of that same generation.

## Verification checkpoint

Commands were run from the repository root. No live Claude Channel, Slack, Orca Gate/Task, or other
product write was performed.

| Command | Result |
|---|---|
| focused D3-2 store/delivery/protocol suite | pass — 5 files, 79 tests |
| `pnpm test` | pass — 50 files, 1112 tests |
| `pnpm typecheck` | pass |
| app `typecheck` | pass |
| app `build` | pass |
| exact fresh-v11 / populated-v10-to-v11 migration probe | pass |
| `git diff --check` | pass |

## Independent audits

Two independent read-only Codex/GPT auditors reviewed implementation commit `7869c1c`. Their schema/
crash and delivery/routing reviews found one P1 and three P2 issues: loss of the D2 pending baseline
after a post-mutation crash, regressed seed-clock persistence, stale receipt acceptance after Run
takeover, and an unbounded serial 64-row reconciliation pass. All four were corrected in `b0b849d`.

Two fresh independent auditors then reviewed `b0b849d` and found three remaining cases: a populated
v10 legacy baseline could block lazy seed, rollback during lease defer could backdate `updated_at`,
and serial callback validation could exceed the aggregate Adapter ACK window. The implementation now
quarantines only the unprovable legacy row, clamps defer inside its CAS transaction with matching DDL/
runtime invariants, and parallelizes bounded fresh reads while preserving ordered durable callbacks.
That correction became `e8e8324` and was then independently re-audited.

At `e8e8324`, the next schema/crash audit approved with no findings. The delivery/routing audit found
three further P2 backpressure/deadline cases: attempted frames could be lost while the Adapter was
blocked, queued receipt time was not transferred into the daemon ACK window, and wall-clock rollback
could extend a saturated queue. Protocol v2 now carries only the remaining monotonic ACK budget,
both pipe directions pause/wait on drain before the next irreversible boundary, and Adapter timeout
disconnect plus daemon safety margin fence late ACKs. The new head is held for fresh independent
delivery/routing re-audit before completion.

The next independent pair at `7d335d8` found four P2 issues: stale v10/D3-1 CLI help, a sub-25ms
ordered-commit route takeover, a durable receipt transition that could finish after its callback
deadline, and unchanged D2 projection consuming D3-originated card generations before D3-3. This
repair updates the live v11 help contract, replaces elapsed freshness with same-Gate commit-boundary
authority reads, carries the monotonic fence into the SQLite transaction, and records an exact
durable outbox-revision provenance fence. It is held for a fresh independent audit pair.

The FINAL4 independent pair at `ec0d891` then identified six P2 boundaries: deferred exact-claim
recovery provenance, predecessor-read revision capture, transactional ACK writability, cross-process
end-to-end monotonic deadlines, rollback-safe causal scheduling, and bounded lazy seed. The combined
repair advances deferred claim identity atomically, snapshots every authority-read start, fences
socket state inside the store commit, calibrates monotonic clock domains, uses a persisted logical
clock, and pages seed within the shared batch/stop budget. Coordinator live-diff review additionally
found a nested speculative-read race plus frozen-equality and slow-forward clock stalls; exact A/B/C,
equality, slow-forward, concurrent-writer, and production stop/restart regressions now close those
cases. A final adversarial preflight also reproduced exact provenance recovery/release crossing an
independently expired delivery lease; the dual CAS now clears that lease at equality and proves all
late owner writes are zero-effect across restart. This repair remains held for a fresh exact-head
independent audit pair.

The FINAL5 schema/crash audit approved that exact head, while the delivery/routing audit found that
the configured production-event limit was enforced per connection and therefore multiplied across
verified sockets. It also required the evidence to state the deliberately narrow meaning of
`attempted`. This repair moves admission to one daemon-global fair scheduler, retains every event's
arrival-fixed monotonic deadline, and returns its idempotent permit on every terminal path. The
per-connection commit chain remains ordered, stale late work is fenced to zero effect, and
`attempted` permits only non-authorizing current-Run route validation—not Gate/effect authority,
ACK, authority-revision advance, token consumption, or retry/replay suppression.

## Residual: `LIVE_CHANNEL_UNVERIFIED`

No actual Claude Code Channel was registered, no development warning was confirmed, no user MCP
configuration was changed, and no live Slack or Orca resource was mutated. This evidence therefore
does not claim live Channel acceptance, actual coordinator processing, or Task resume. D3-3 remains
responsible for distinct Task-resume evidence and existing-message Slack projection; this PR adds no
`작업 재개` UI or Task-resume write.
