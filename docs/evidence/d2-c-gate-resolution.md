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
  contention exhaustion leaves either no winner or a quarantined `pending` winner. Graceful daemon
  shutdown gates off new Socket intake first, drains every already-accepted handler under that same
  bounded ingress deadline, and only then aborts the now-idle ingress signal; it cannot prematurely
  cancel a post-ACK promotion that would succeed within the remaining headroom.
- Post-ACK reconciliation performs exact Orca pre-read and mutation-edge read, invokes the official
  `gate-resolve --retry-request`, strictly parses `mutation.replayed`, then performs an exact
  post-read. Restarts resume every ACK-confirmed nonterminal intent and its pending card outbox with
  the original UUID; pre-ACK and failed-ACK intents are durably non-runnable. Exact authorized Slack
  redelivery can recover that same immutable pending/failed winner even if a later ordinary
  completion made the mutable card mapping fail closed; a different valid option remains `lost`.
  Already-ACKed intents do not receive this bypass and remain fenced by a mismatched mapping until
  corrective projection. An
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
  an unrelated Run observation. This exhaustive query is deliberately not presented as bounded:
  the schema has exactly one outbox row per `gate_key` (revisions update that row, rather than
  appending attempt history), so its cost is linear in the ACK-confirmed Gates retained by this
  local Bridge database. Synchronous startup integrity validation likewise builds one keyed map/set
  per retained Gate table and performs linear cross-table membership checks rather than nested
  intent/outbox/ordinary-owner scans. The repository specification leaves durable-store retention for a later
  slice, and the current renderer fingerprint is computed from each intent/outbox in code, so SQL
  cannot safely preselect completed drift candidates without a new durable renderer-version
  contract. Large retained stores therefore carry a documented startup/periodic latency and memory
  risk; bounded paging and a retention policy remain follow-up work rather than an implicit D2-C
  guarantee. Every nonexpired same-owner generation continuation atomically renews both the
  projection expiry and `updated_at`. Projection and ordinary-card owners carry strict
  persisted expiries, so an unrelated process reusing a crashed owner's PID cannot block recovery;
  exact-expiry takeover advances the revision and fences stale completions. The separately owned
  ordinary-card write fence is serialized against Gate claims and survives restart. An additive
  v9 generation row leaves the v8 observation table and its CHECK unchanged while giving every
  observation reservation a monotonic CAS token, including byte-identical and same-timestamp
  renders. The publisher atomically persists a complete valid observation plus its reservation
  before the first asynchronous pause, then confirms that exact revision before Slack. A
  reservation-only crash therefore leaves neither an orphan generation nor a claimable card; an
  older equal-time render that resumes after a newer publisher cannot relabel itself current.
  Before Slack, the publisher must own the exact generation plus run/task/status/resolution/
  metadata/source-time snapshot. A newer generation makes an already-started Slack completion
  persist only the card fingerprint it actually applied while retaining the current durable
  `write_pending` repair owner, or fail-closing an ownerless row to `mismatched`. Owner replacement
  or clearance advances beyond the stale token, and generation-aware completion is single-use.
  An exact retry preserves that ownerless fail-closed state through its reservation and confirmation;
  `beginGateObservationWrite` revalidates the canonical message identity and atomically changes it
  directly to `write_pending` ownership. Another SQLite connection therefore has no matched claim
  window while the remote card is still dirty. This recovery path bypasses the normal equal-render-
  fingerprint skip: correlation repair still performs one fenced idempotent Slack update before it
  may restore `matched`.
  If an ACKed D2 intent already exists, the same transaction also advances/re-arms its outbox
  without releasing an active projection owner; only a fresh actionless D2 projection can settle.
  Same-owner renewal or dead/exact-expiry takeover must project the current generation before any
  click can win. Resolved observations are terminal-latched, so an older paused or already-in-flight
  pending publisher cannot restore actions after a newer resolved observation.
- A first Gate thread reply is posted without action controls. Its exact Slack identity, staged
  fingerprint, and matched local observation then commit in one SQLite transaction; only a bounded
  idempotent update may expose buttons afterward. A process fault, delivery-unknown post response,
  competing first publisher, or mapping-time writer lock can therefore leave an inert duplicate,
  but never an actionable card whose message correlation is absent. A restart promotes the one
  durably mapped staged reply in place. The pre-post observation write also atomically rechecks an
  initially absent message and derives correlation from the exact run/channel/thread identity that
  appeared, so a paused second publisher cannot overwrite the first publisher's established
  `matched` observation with its stale `missing` snapshot or post even an inert orphan. Matching the
  run alone is insufficient:
  a paused publisher with the wrong channel or wrong `thread_ts` durably records `mismatched` when
  no remote call owns the card. If a call is already draining, the unchanged v8 CHECK requires the
  visible row to remain `write_pending`, while the v9 generation still durably records the
  invalidation and fences that call's completion. The canonical card rejects clicks fail-closed
  across restart; only an exact run/channel/thread publisher can repair and restore `matched`.

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
  v7-to-v8 plus populated-v8-to-v9 additive migration, a shared write/startup lifecycle-evidence
  matrix, unknown D2 schema objects, orphan/malformed v9 generation rows and linear generation-to-
  observation validation, plus map-backed linear intent/outbox/ordinary-owner cross-table startup
  validation with a deterministic no-nested-scan guard,
corrupt persisted shapes and atomic malformed-write rollback, bounded redacted audit facts with a
reserved winner slot plus exact winner-audit correlation, mandatory terminal pre-read evidence,
malformed/missing owner-expiry pairs, PID-reuse takeover at exact expiry with stale-completion
fencing, same-owner projection renewal and nonblocking busy-owner passes across two store
instances, three consecutive pending generations/Slack attempts protected past the original
expiry boundary, completed-renderer re-arm with stale-completion fencing and crash/restart replay,
two-connection transient writer contention during both winner claim and ACK promotion,
  claim/promotion deadline exhaustion, explicit handler abort during both retry phases, graceful
  shutdown during a real two-connection post-ACK writer lock (new intake rejected, the accepted
  promotion drained, and every remote call observing durable `acked`), forced expiry before mutation,
  never-settling injected Slack updates, production fetch abort, and a
deadline-during-retry-sleep case proving no later request starts, fixed-option-only empty input
state, actionless first-reply staging, crash before/after atomic mapping, real two-connection
mapping contention with inert-orphan recovery, a paused two-store first-publisher race that keeps
the canonical card actionable across restart, explicit paused-publisher wrong-channel and
wrong-thread identity cases that persist `mismatched`, plus same-timestamp wrong-identity/live-owner
cases that advance the v9 generation, fence the stale Slack completion, remain unclaimable through
  restart, and require one exact repair. Same-timestamp render-only drift is covered on both sides
  of the reservation boundary: a newer exact publisher wins while the older equal-time publisher is
  paused, and a reservation-only crash invalidates an in-flight owner while leaving a valid,
  unclaimable observation that an exact-expiry restart repairs. A two-store no-owner probe pauses an
  exact repair after confirmation but before begin, observes `mismatched` and a rejected claim from
  another connection, then observes `write_pending` and another rejected claim while corrective
  Slack is held; only completion restores `matched`. Separate wrong-channel and wrong-thread probes
  first create `mismatched` without any remote mutation, then repeat those two claim checks while an
  exact same-fingerprint retry performs its fenced repair. Exact-expiry takeover with chained
  later-completion fencing, an older pending snapshot paused until a newer resolved card commits,
  and an already-in-flight pending Slack success held behind a resolved terminal latch are covered
  independently. A final cross-boundary regression releases ordinary update A only after exact
  takeover, winner ACK, and terminal D2 projection; A's late completion records its remote
  fingerprint, re-arms the terminal outbox, rejects clicks/replayed completion, and permits exactly
  one corrective actionless projection. A separate composed recovery holds ordinary generation A,
  completes exact-expiry generation B, crashes after B's pending winner claim but before ACK, lands A
  last to make the mapping `mismatched`, then reopens: unauthorized/wrong-thread deliveries reject, a
  different valid option loses, and exact redelivery reuses and ACKs the original UUID before normal
  actionless resolution projection. Terminal completed-card renderer drift through engine startup
  reconciliation and the production
CLI/Socket-to-Orca path including Socket-close failure draining and periodic owner-death takeover.

Focused command:

```text
pnpm --dir apps/orca-slack-bridge exec vitest run test/gate-resolution-store.test.ts test/gate-action-handler.test.ts test/gate-resolve.test.ts test/gate-publish.test.ts test/cli-daemon.test.ts test/post.test.ts

6 test files passed; 150 tests passed.
```

Full local suite at the implementation checkpoint:

```text
pnpm test

39 test files passed; 952 tests passed.
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

The final identity-focused audit then found two ordinary-render ordering holes: a newer exact
publisher could make a Gate claimable while an older Slack update was still outstanding, and an
older pending snapshot could save after a newer resolved observation. The v9 generation CAS closes
both without weakening or rebuilding the v8 table. Public two-connection regressions mutate wrong
channel and wrong thread at the exact same timestamp as a blocked owner, exercise same-timestamp
render-only drift, record the stale remote fingerprint without clearing the repair barrier, deny
takeover at `t+29.999`, recover at exact `t+30`, and prove only the repaired generation becomes
claimable. A separate paused-source regression commits a resolved no-actions card first, then
resumes the older pending publisher and proves it makes no Slack call, cannot change the resolved
fingerprint/facts, and remains rejected after reopen.

The final fresh audit found that save-time generation alone did not order an equal-time render that
paused before persistence. The two-phase reservation now fixes ordering before the fault boundary,
and its confirmation can only persist a newly discovered fail-closed identity—not stale Orca facts.
Public regressions prove exact and wrong-channel/thread first-publisher behavior, a newer exact
equal-time render winning without an older Slack call, and B-reserve-then-crash invalidating A while
C repairs after restart. The same audit required late owner-loss completion handling: the terminal
D2 regression releases A last and proves the applied stale fingerprint, owner/generation fences,
outbox re-arm, single-use completion, and corrective actionless projection are one convergent chain.
The last high-priority review then exposed a smaller ownerless interval in that chain: an exact
retry's save could restore `matched` before acquiring its corrective-write owner. The final
transition preserves `mismatched` across both reservation transactions and changes it directly to
`write_pending` inside the identity-checked begin transaction. The public paused-confirmation probe
uses another store connection to reject claims on both sides of begin and allows a winner only after
the corrective Slack completion.
The follow-up same-fingerprint review showed why correlation recovery cannot use the ordinary render
deduplication shortcut. Two parameterized public regressions make wrong-channel and wrong-thread
observations fail closed without Slack, then prove an exact retry with the unchanged card fingerprint
still crosses the atomic owner transition, remains unclaimable before and during Slack, and becomes
claimable only after completion.

The next two fresh material audits found three P2 composition/scale gaps, all closed in the final
tree. First, daemon shutdown used the handler abort signal before draining an ACKed winner's bounded
SQLite promotion retry; the production regression now holds `BEGIN IMMEDIATE` through shutdown,
rejects a retained late Socket callback without ACK or claim, releases inside headroom, and proves the
original ACK occurs once and remote work observes only durable `acked`. Second, startup validation
still nested full-table intent/outbox scans even though later validation already needed keyed maps;
those maps now serve every membership check, and a deterministic structure test observed the old
nesting depth of two but requires one. Third, a pre-ACK winner could be followed by an old ordinary
completion that made its mapping `mismatched`, leaving both redelivery and ordinary repair blocked.
The combined two-store expiry/crash/restart regression now proves immutable exact redelivery recovers
that original pending UUID before mutable mapping/status checks, while invalid identity still rejects,
another valid option loses, and already-ACKed mismatches retain the terminal repair fence.

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
irreducible without a distributed transaction with Slack and is not described as atomic. Graceful
shutdown no longer widens it: intake stops first and the accepted bounded promotion drains before
the abort signal. Exact redelivery also recovers its original pending/failed winner across a later
mutable mapping mismatch, but Slack still does not guarantee redelivery after accepting the ACK. A
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

The same remote/local limitation applies if an ordinary Slack call outlives its lease: when its
completion code runs, the Bridge now records the card it actually applied, fences any replacement,
and re-arms D2 atomically. If that old process instead dies after Slack applies the late card but
before this local completion transaction, SQLite has no fact proving the remote overwrite; a newer
completed outbox may be skipped until another generation or forced reprojection. Slack provides no
message-update CAS or distributed transaction to close this final stale-remote/storage crash gap.

An ordinary Run observer holds a durable pre-Slack write fence while it updates the shared Gate
card. A click during that short interval is still ACKed exactly once but is rejected fail-closed;
the owner must click again after the observer settles. This is intentional because allowing the
claim to race the ordinary update would let a stale fixed-action card overwrite the D2 status card.

No live Slack or Orca product write was made while collecting this evidence.
