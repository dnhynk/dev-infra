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
  Transient SQLite writer contention is retried only for `SQLITE_BUSY`, with one stable request
  UUID and a hard-clock/abort-aware bound: winner claim consumes at most the explicit two-second
  local CAS window, while ACK-state persistence consumes only the remainder of Slack's
  three-second ingress budget. The ACK callback is invoked exactly once. No Orca or Slack remote
  work is scheduled unless the durable winner is subsequently observed with `ack_state=acked`;
  contention exhaustion leaves either no winner or a quarantined `pending` winner.
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
  response-unknown path with the original retry UUID. Every Gate card update has a fifteen-second
  lifecycle bound and aborts the production fetch, strictly below its thirty-second durable owner
  expiry, so startup reconciliation and daemon draining cannot wait forever on Slack.
- Status projection distinguishes resolving, resolved, conflict, and degraded states and always
  preserves `Coordinator 통지 대기`; D2-C never claims that work resumed. Monotonic intent/outbox
  revisions, terminal-state dominance, and a durable projection owner prevent stale reconcilers or
  Slack completions from clearing newer state. A completed outbox whose deterministic renderer
  fingerprint drifts is atomically advanced into a fresh pending revision, has projected/owner
  state cleared, and is re-read before any Slack call; a crash after that re-arm is therefore
  restart-replayable. Startup and periodic reconciliation enumerate every ACK-confirmed outbox,
  including completed terminal cards, so a renderer deployment is detected without depending on
  an unrelated Run observation. Every nonexpired same-owner generation continuation atomically
  renews both the projection expiry and `updated_at`. Projection and ordinary-card owners carry strict
  persisted expiries, so an unrelated process reusing a crashed owner's PID cannot block recovery;
  exact-expiry takeover advances the revision and fences stale completions. The separately owned
  ordinary-card write fence is serialized against Gate claims and survives restart, and its next
  production observer pass safely reprojects and settles the exact stored message.
- A first Gate thread reply is posted without action controls. Its exact Slack identity, staged
  fingerprint, and matched local observation then commit in one SQLite transaction; only a bounded
  idempotent update may expose buttons afterward. A process fault, delivery-unknown post response,
  competing first publisher, or mapping-time writer lock can therefore leave an inert duplicate,
  but never an actionable card whose message correlation is absent. A restart promotes the one
  durably mapped staged reply in place. The pre-post observation write also atomically rechecks an
  initially absent message and derives correlation from the exact run/channel/thread identity that
  appeared, so a paused second publisher cannot overwrite the first publisher's established
  `matched` observation with its stale `missing` snapshot.

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
reserved winner slot plus exact winner-audit correlation, mandatory terminal pre-read evidence,
malformed/missing owner-expiry pairs, PID-reuse takeover at exact expiry with stale-completion
fencing, same-owner projection renewal and nonblocking busy-owner passes across two store
instances, three consecutive pending generations/Slack attempts protected past the original
expiry boundary, completed-renderer re-arm with stale-completion fencing and crash/restart replay,
two-connection transient writer contention during both winner claim and ACK promotion,
claim/promotion deadline exhaustion, shutdown abort during both retry phases, forced expiry before
mutation, never-settling injected Slack updates, production fetch abort, and a
deadline-during-retry-sleep case proving no later request starts, fixed-option-only empty input
state, actionless first-reply staging, crash before/after atomic mapping, real two-connection
mapping contention with inert-orphan recovery, a paused two-store first-publisher race that keeps
the canonical card actionable across restart, terminal completed-card renderer drift through
engine startup reconciliation, and the production
CLI/Socket-to-Orca path including Socket-close failure draining and periodic owner-death takeover.

Focused command:

```text
pnpm --dir apps/orca-slack-bridge exec vitest run test/gate-resolution-store.test.ts test/gate-action-handler.test.ts test/gate-resolve.test.ts test/gate-publish.test.ts test/cli-daemon.test.ts test/post.test.ts

6 test files passed; 130 tests passed.
```

Full local suite at the implementation checkpoint:

```text
pnpm test

39 test files passed; 932 tests passed.
```

The root and app typechecks, the app production build, `pnpm audit --audit-level high`, and
`git diff --check` also passed. Dependency manifests and the lockfile did not change, so no new
frozen install was required.

## External-audit failure reproduction and closure

Before the fixes, the new public fixtures were run against exact head
`9e22b4cf90f658ae4179efd63338524aa553eae9`. A completed projected outbox with an obsolete renderer
fingerprint attempted to write a projection owner while `card_pending=0` and failed the v8 schema
CHECK; same-owner reacquisition left its old expiry/`updated_at`; and a supported second connection
holding `BEGIN IMMEDIATE` made both claim and ACK promotion fail immediately:

```text
pnpm --dir apps/orca-slack-bridge exec vitest run test/gate-action-handler.test.ts test/gate-resolution-store.test.ts test/gate-resolve.test.ts

old exact head plus failing fixtures: 4 failed; 68 passed
fixed working tree: 3 test files passed; 77 tests passed
```

The completed-outbox fixture additionally crashes immediately after the durable re-arm, rejects a
late old-generation completion, reopens the database, and proves one current-generation Slack
projection can settle. The three-generation fixture holds each Slack call open across a lifecycle
advance, verifies same-owner renewal on revisions 0/1/2, denies another live owner at the original
exact `t+30s` boundary, and rejects generation-0/1 completions after generation 2 settles.

A fresh independent pre-delivery audit also found that the original first Gate reply exposed
buttons before its Slack message identity was durable. The staged-reply change closes that local
correlation gap: public regressions fault after Slack acceptance, fault after the atomic mapping,
and hold `BEGIN IMMEDIATE` on a second connection during mapping persistence; across restart every
unmapped reply stays actionless and exactly one durably mapped reply is promoted in place.

A subsequent material audit found two follow-on gaps and both are closed in the final tree. The
daemon now checks completed ACK-confirmed terminal outboxes for renderer drift during ordinary
reconciliation, and a first publisher's initially `missing` observation is atomically reconciled
against any message that appeared before its write. Public regressions start from a terminal
completed card during restart and pause a second store between its absent-message read and
observation write, proving the canonical mapping remains actionable after reopen.

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
promotion can strand the intent until Slack redelivers. This post-ACK/storage crash gap is
irreducible without a distributed transaction with Slack and is not described as atomic. A
supported SQLite writer lock is retried only within explicit local headroom; if it persists, the
handler ACKs exactly once and fails closed with no remote work. If the lock remains held through
the whole ingress budget, SQLite may also reject the best-effort durable audit insert—the returned
outcome/reason stays deterministic, and any already-claimed intent remains `pending`, but no local
implementation can atomically record a new audit row while another connection owns the database
writer lock. Corruption, validation failures, and programming errors are never blanket-retried.

Slack first-post delivery and the local message mapping likewise cannot share a distributed
transaction, and Slack provides no stable idempotency token at this boundary. A crash or
delivery-unknown response can still leave an extra thread reply that the Bridge cannot rediscover
from prose. That reply is now deliberately actionless; only a reply whose identity and matched
observation committed atomically can receive controls through an idempotent update, so the
remaining duplicate is visible clutter rather than a stale control-plane entry point.

A Slack update timeout is delivery-unknown. The Bridge releases its local owner and keeps the
durable card outbox pending for replay; the production Web API fetch observes cancellation, but an
injected third-party `SlackPoster` that ignores `AbortSignal` can still physically settle late.
Local owner/revision fencing only prevents that timed-out call from committing local projection
state. If its remote write applies after a newer successful projection, Slack exposes no CAS or
readback fence here: the older card can overwrite the newer one while the local fingerprint/outbox
already says current, so automatic reconciliation may skip it until another generation or forced
reprojection. Production cancellation narrows this interval but cannot prove server-side
non-application once delivery is unknown; Slack's remote-write ordering cannot be made atomic with
the SQLite timeout transition.

An ordinary Run observer holds a durable pre-Slack write fence while it updates the shared Gate
card. A click during that short interval is still ACKed exactly once but is rejected fail-closed;
the owner must click again after the observer settles. This is intentional because allowing the
claim to race the ordinary update would let a stale fixed-action card overwrite the D2 status card.

No live Slack or Orca product write was made while collecting this evidence.
