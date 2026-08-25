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
- Delivery state is monotonic `pending -> attempted -> receipted -> consumed`, with a revision CAS,
  acquisition-specific expiring lease ownership, bounded retry/error fields, and strict timestamp,
  lifecycle, D2-correlation, foreign-key, column, DDL, and allowed-object validation.
- A regressed process clock is clamped to the latest persisted D2 evidence before seed and outbox
  re-arm. Reopen rejects an artificially backdated cross-table seed.
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
- send-before-attempt crash, receipt-before-effect crash/restart, exact mismatch/read failure,
  pending-effect redelivery, bounded redacted errors, and no Task mutation;
- overlapping reconcile fencing and multi-row hung-Orca deadline/late-completion safety;
- verified-only production send, ordered multi-Gate callbacks, durable receipt ACK fencing,
  wrong Gate receipt, reconnect replay, and generation-takeover stale receipt rejection;
- production daemon startup wiring of the new store/runtime callbacks and reconciliation caller.

## Verification checkpoint

Commands were run from the repository root. No live Claude Channel, Slack, Orca Gate/Task, or other
product write was performed.

| Command | Result |
|---|---|
| focused D3-2/D2 recovery suite | pass — 9 files, 157 tests |
| `pnpm test` | pass — 49 files, 1080 tests |
| `pnpm typecheck` | pass |
| app `typecheck` | pass |
| app `build` | pass |
| exact fresh-v11 / populated-v10-to-v11 migration probe | pass |
| `git diff --check` | pass |

## Independent audits

Two independent read-only Codex/GPT auditors reviewed implementation commit `7869c1c`. Their schema/
crash and delivery/routing reviews found one P1 and three P2 issues: loss of the D2 pending baseline
after a post-mutation crash, regressed seed-clock persistence, stale receipt acceptance after Run
takeover, and an unbounded serial 64-row reconciliation pass. All four findings were corrected with
the regressions listed above. The corrected head is held for independent re-audit before completion.

## Residual: `LIVE_CHANNEL_UNVERIFIED`

No actual Claude Code Channel was registered, no development warning was confirmed, no user MCP
configuration was changed, and no live Slack or Orca resource was mutated. This evidence therefore
does not claim live Channel acceptance, actual coordinator processing, or Task resume. D3-3 remains
responsible for distinct Task-resume evidence and existing-message Slack projection; this PR adds no
`작업 재개` UI or Task-resume write.
