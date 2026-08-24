# D2-C fixed-option Gate resolution evidence

Date: 2026-08-25
Base: `origin/main@d26be4db4943a67ff7caaabd35a5391c22eaca5a`

## Delivered boundary

- Only Bridge-rendered fixed-option `block_actions` are accepted. Modal input, normal Slack
  messages/events, and D3 Channel transport remain outside this slice.
- The synchronous ingress boundary validates the Socket event, configured Slack identities,
  code-owned block/action/value identities, durable Gate sidecar, local Orca observation, and
  exact Slack thread/card mapping. One Gate-local winner intent, its UUID retry request, initial
  audit fact, and resolving/notification outbox are committed atomically before the one ACK.
- Post-ACK reconciliation performs exact Orca pre-read and mutation-edge read, invokes the official
  `gate-resolve --retry-request`, strictly parses `mutation.replayed`, then performs an exact
  post-read. Restarts resume every ACK-confirmed nonterminal intent and its pending card outbox with
  the original UUID; pre-ACK and failed-ACK intents are durably non-runnable. An
  expiry-authoritative renewable store lease serializes live reconcilers, cannot be resurrected
  after expiry, and is synchronously renewed/fenced before each remote boundary; renewal loss
  aborts before mutation. A busy Gate is skipped by each nonblocking reconciliation pass so later
  Gates and daemon shutdown cannot starve, while a periodic production pass takes over durable
  pending work after a live owner disappears. Orca subprocesses and injected runners have a
  bounded deadline; read timeouts become durable uncertainty and resolve timeouts follow the same
  response-unknown path with the original retry UUID.
- Status projection distinguishes resolving, resolved, conflict, and degraded states and always
  preserves `Coordinator 통지 대기`; D2-C never claims that work resumed. Monotonic intent/outbox
  revisions, terminal-state dominance, and a durable projection owner prevent stale reconcilers or
  Slack completions from clearing newer state. A separately owned ordinary-card write fence is
  serialized against Gate claims and survives restart; its next production observer pass safely
  reprojects and settles the exact stored message.

## Adversarial and fault evidence

The focused suites cover both pre-ACK crash windows, thrown ACK, store failure, every supported
identity/action/mapping rejection class, the pre/post-CAS ACK deadline guards and clock failures,
mixed ACK outcomes, same/different concurrent selections, every post-ACK crash seam including
response loss and success-before-local-result persistence, sticky ambiguous mutation provenance
across repeated restart failures and the mutation-edge read, replayed/invalid structured mutation
output, equal- and different-text external resolution before mutation and before post-read,
restart reconciliation, bounded startup/shutdown Orca calls, stale outbox completion and
projector-success-before-local crash recovery, two-store observer/card races,
first-reply and ordinary-write restart settlement (including catchable same-daemon retry),
v7-to-v8 migration, a shared write/startup lifecycle-evidence matrix, unknown D2 schema objects,
corrupt persisted shapes and atomic malformed-write rollback, bounded redacted audit facts with a
reserved winner slot plus exact winner-audit correlation, lease renewal and nonblocking busy-owner
passes across two store instances, forced expiry before mutation, fixed-option-only empty input
state, and the production
CLI/Socket-to-Orca path including Socket-close failure draining and periodic owner-death takeover.

Focused command:

```text
pnpm --dir apps/orca-slack-bridge exec vitest run test/gate-resolution-store.test.ts test/gate-action-handler.test.ts test/gate-resolve.test.ts test/gate-publish.test.ts test/cli-daemon.test.ts

5 test files passed; 77 tests passed.
```

Full local suite at the implementation checkpoint:

```text
pnpm test

39 test files passed; 907 tests passed.
```

## Base-fails / head-passes contract evidence

The head version of `test/gate-render.test.ts` was copied into a temporary archive extraction of
the exact base commit; no base worktree or live service was changed. Against the base renderer the
new fixed-option contract failed as expected:

```text
node <head>/node_modules/vitest/vitest.mjs run test/gate-render.test.ts

base d26be4db4943a67ff7caaabd35a5391c22eaca5a: exit 1
expected actions blocks to have length 1, received 0
1 failed, 3 passed
```

The same test passes on the D2-C head:

```text
pnpm --filter @dev-infra/orca-slack-bridge test -- test/gate-render.test.ts

head: exit 0
1 test file passed; 4 tests passed
```

The temporary extracted base was deleted after the comparison.

## Residual platform risk

Orca exposes retry replay but no Gate CAS/version token. The second exact pre-read narrows the race,
but an external resolver can still commit after that read and before this Bridge's non-CAS
`gate-resolve`; Orca may then let the Bridge overwrite that external result. A different request
can also overwrite the Gate after this Bridge's confirming post-read, so a locally persisted
`resolved` state is only a point-in-time confirmation. Pre-existing or post-mutation external
winners that are observable are persisted as conflicts and are never overwritten by
reconciliation, but neither external TOCTOU window can be closed in D2-C.

Slack ACK and the SQLite ACK-ready bit cannot be one atomic distributed commit. The implementation
persists the winner before ACK, promotes it to runnable only after ACK returns, and quarantines
thrown/late/clock-uncertain ACKs; a process crash after Slack accepted the ACK but before that local
promotion can strand the intent until Slack redelivers. The CAS starts only with one second of ACK
headroom, but an uninterruptible storage stall can still consume the remaining budget; such a late
completion gets exactly one ACK attempt, is audited, and is kept non-runnable rather than silently
mutating Orca.

An ordinary Run observer holds a durable pre-Slack write fence while it updates the shared Gate
card. A click during that short interval is still ACKed exactly once but is rejected fail-closed;
the owner must click again after the observer settles. This is intentional because allowing the
claim to race the ordinary update would let a stale fixed-action card overwrite the D2 status card.

No live Slack or Orca product write was made while collecting this evidence.
