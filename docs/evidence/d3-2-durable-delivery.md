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
- A regressed process clock is clamped to the latest persisted D2 evidence before seed and outbox
  re-arm. Defer similarly derives its effective update/retry clock from persisted causal timestamps
  inside the revision/owner transaction, and schema plus runtime validation require every lifecycle
  event timestamp to be at or before `updated_at`.
- Every state transition and the existing Gate card-outbox re-arm share one `BEGIN IMMEDIATE`
  transaction. A stale card projection revision cannot clear the newer generation.
- `attempted` means only that the Adapter's MCP notification write resolved. `receipted` is only the
  reply-tool application callback. Neither is delivery consumption or Task resume.
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
- Fresh Run reads for a bounded callback burst run concurrently, then their durable callbacks and
  ACKs commit on one arrival-ordered chain. Pipe protocol v2 adds only an Adapter-computed relative
  ACK budget to its internal receipt frame; the external Channel notification and reply-tool input
  remain strict Gate-ID-only shapes.
- Adapter receipt deadlines and daemon callback deadlines use monotonic clocks. Queue time is
  deducted before the Adapter writes a receipt, the daemon caps that remainder below the production
  5-second timeout with an ACK safety margin, and socket timeout disconnects fence any late ACK.
- Adapter notification progress pauses behind attempted-frame backpressure and resumes on drain.
  On the daemon side, receipt processing waits for ACK writability and then refreshes an aged route
  before the synchronous durable transition, so delayed drain cannot produce state without an ACK.
- Connection-local sent/notified sets are bounded and discarded on reconnect. Multi-Gate MCP
  notifications are serialized, receipt/ACK backpressure queues are bounded sets, and the daemon
  rejects an over-cap asynchronous inbound queue.
- One delivery pass processes a bounded batch with bounded concurrency and a 20-second overall
  deadline that precedes the 30-second lease expiry. Deadline abort synchronously defers/releases
  active leases; even an injected runner that ignores `AbortSignal` cannot write the store after
  shutdown or close.
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
- three production Gates with six independent 1.7-second fresh route reads, concurrent validation,
  wire-ordered durable callbacks, and all receipt ACKs inside the default Adapter window;
- multi-Gate attempted-frame backpressure with notification pause/drain resume and no lost callback;
- two queued receipts across independent Adapter-send and daemon-ACK drains, decreasing transmitted
  ACK budget, pre-durable wait, post-wait route refresh, ordered durable callbacks, and no late ACK;
- saturated single-slot receipt validation under repeated wall-clock rollback, proving monotonic
  expiry prevents the queued callback and ACK before the Adapter timeout;
- production daemon startup wiring of the new store/runtime callbacks and reconciliation caller.

## Verification checkpoint

Commands were run from the repository root. No live Claude Channel, Slack, Orca Gate/Task, or other
product write was performed.

| Command | Result |
|---|---|
| focused D3-2/D2 recovery/protocol suite | pass — 10 files, 170 tests |
| `pnpm test` | pass — 49 files, 1086 tests |
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

## Residual: `LIVE_CHANNEL_UNVERIFIED`

No actual Claude Code Channel was registered, no development warning was confirmed, no user MCP
configuration was changed, and no live Slack or Orca resource was mutated. This evidence therefore
does not claim live Channel acceptance, actual coordinator processing, or Task resume. D3-3 remains
responsible for distinct Task-resume evidence and existing-message Slack projection; this PR adds no
`작업 재개` UI or Task-resume write.
