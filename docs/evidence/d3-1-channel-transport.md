# D3-1 local Channel transport evidence

Date: 2026-08-25

Base: `origin/main@102c54e38523100b8e863362ca52b9516496f633`

Branch: `dnhynk/d3-1-channel-transport`

## Delivered boundary

This slice connects one production vertical seam without enabling production Gate delivery:

- The existing daemon owns the fixed Windows named pipe
  `\\.\pipe\orca-slack-bridge-channel-v1` through `node:net`. A session-scoped Adapter is the
  reconnecting client, so daemon-first and Adapter-first startup both converge.
- Local protocol v1 is strict, bounded NDJSON. The complete UTF-8 frame, including its LF, is at
  most 4096 bytes. Unknown versions, types, fields, missing claims, malformed identities, invalid
  UTF-8/JSON, empty frames, and unterminated frames fail closed with code-only errors.
- The `channel-adapter` CLI command starts a direct `@modelcontextprotocol/sdk@1.30.0` low-level
  `Server` over `StdioServerTransport`. It is dispatched before Bridge config loading and does not
  need Slack config or credentials.
- The MCP server advertises exactly `experimental: { "claude/channel": {} }` and `tools: {}`. Its
  Channel notification is exactly empty `content` plus `meta: { gate_id }`; the one receipt tool
  accepts exactly `{ gate_id }` and no note, status, or other field.
- Hello claims carry only session ID, Orca terminal handle/pane key, protocol version, Adapter
  instance ID, and connection ID. They are routing claims, not authentication. `CLAUDE_PID` is not
  read or transmitted.
- The read-only router shell calls the existing Orca `listRuns` reader, exact-matches current
  handle/pane, and rejects duplicate Run rows. Before routing, it checks every same-binding
  candidate's hello-time snapshot for the exact current Run ID and `consumer_generation`, retires
  absent or stale captures, and computes zero/one/many only across current-generation candidates.
  Concurrent hello-time reads share one bounded snapshot; shutdown aborts the production Orca
  child and retires that shared read. It never broadcasts.
- Every connection epoch receives one random opaque Gate-ID-shaped probe, repeated with bounded
  exponential pacing. MCP initialize, tools/list, pipe writes, Adapter `attempted`, argv, and env
  never verify opt-in. Only the exact receipt callback accepted by the daemon for that epoch and
  probe marks it verified.
- `productionGateWrites` is structurally fixed to zero. There is no production Gate writer, v11
  state, Slack projection, Gate resolver change, permission relay, allowlist/plugin packaging,
  `.mcp.json` mutation, warning confirmation, or `작업 재개` rendering in D3-1.

## Protocol choice and exact surface

NDJSON was selected instead of a binary length prefix because every v1 message is one small JSON
object, JSON escaping prevents an embedded string newline from becoming a frame delimiter, and one
incremental LF decoder covers both fragmented and coalesced named-pipe reads. The decoder checks
the retained bytes before concatenation and the encoder revalidates the typed object, so the simpler
framing does not weaken the 4 KiB bound. The lower-authority T5 harness also used newline-delimited
JSON successfully, while the production implementation replaces its loose shapes with the table
below.

| Direction | Type | Exact fields after `version` and `type` |
|---|---|---|
| Adapter → daemon | `hello` | `session_id`, `terminal_handle`, `pane_key`, `instance_id`, `connection_id` |
| Adapter → daemon | `attempted` | `connection_epoch`, `gate_id` |
| Adapter → daemon | `receipt` | `connection_epoch`, `gate_id` |
| daemon → Adapter | `hello_ack` | `connection_epoch` |
| daemon → Adapter | `notify` | `connection_epoch`, `gate_id` |
| daemon → Adapter | `receipt_ack` | `connection_epoch`, `gate_id` |

The current official [Anthropic Channels reference](https://code.claude.com/docs/en/channels-reference)
still specifies the experimental capability, `notifications/claude/channel`, stdio MCP server,
and reply-tool pattern. The implementation pins the current v1
[@modelcontextprotocol/sdk 1.30.0 source surface](https://github.com/modelcontextprotocol/typescript-sdk/tree/1.30.0)
rather than adopting the incompatible v2 package surface. Awaiting `Server.notification()` is
treated only as a transport-write attempt; it is never promoted to application receipt.

## Production lifecycle and fault evidence

- `runDaemonCommand` opens the strict v10 store, acquires the single fixed pipe before recovery or
  Slack Socket ingress, and stops Channel intake before Socket shutdown and SQLite close. Failure
  to acquire pipe ownership prevents the second daemon from starting Slack ingress.
- `channel-adapter` connects MCP stdio before starting the pipe client. Stdin EOF/close/error,
  MCP close, SIGINT, and SIGTERM all enter one cleanup path; already-ended stdin is handled without
  waiting. Retry, hello, probe, receipt, and shutdown timers are cleared and sockets/listeners are
  destroyed within explicit bounds.
- Disconnect creates a new connection ID and daemon epoch. Old-epoch, old-Gate, and wrong-Gate
  receipts fail closed; exact duplicate receipts are idempotently acknowledged. A transport write
  without the receipt tool leaves the connection unverified while the same probe ID repeats.
- Untrusted sockets have fixed total and same-binding caps. A `socket.write()` backpressure result
  pauses further writes on both daemon and Adapter until `drain`; each side has a bounded write
  deadline, and only the current receipt/ack can occupy the one-element deferred slot. Receipt/ACK
  races preserve the deadline and flush on drain. The initial Run generation is captured at hello,
  a failed capture reconnects, and a takeover or newly appearing Run forces a fresh epoch rather
  than letting an existing claim adopt a generation lazily. A stale claim overlapping a fresh
  same-binding claim is retired before ambiguity is evaluated.

All integration tests use fake Orca readers, an in-memory MCP transport, and unique local OS pipe
endpoints. On this Windows host, the named-pipe cases exercised the real `\\.\pipe\...` path.

## Verification checkpoint

Commands were run from the repository root. No live Claude Channel, Slack, Orca Gate/Task, or
other product write was performed.

| Command | Result |
|---|---|
| focused Channel + CLI/daemon suite | pass — 6 files, 95 tests |
| `pnpm test` | pass — 47 files, 1060 tests |
| `pnpm typecheck` | pass |
| `pnpm --filter @dev-infra/orca-slack-bridge typecheck` | pass |
| `pnpm --filter @dev-infra/orca-slack-bridge build` | pass |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm audit --audit-level high` | pass — no known vulnerabilities |
| `git diff --check` | pass |

Focused coverage includes byte-boundary fragmentation, coalesced frames, strict shapes and cap,
malformed-input redaction, daemon-first, Adapter-first `ENOENT`, reconnect/new epoch, stale/wrong/
duplicate receipts, true current-generation same-binding ambiguity, generation fencing, stale/fresh
same-binding pruning across repeated route evaluations, write-without-receipt, repeated probe
identity, zero production writes, exact MCP capability/notification/tool shapes, second-daemon
ownership, daemon/Adapter receipt backpressure races, hello-read coalescing and abort, transient
binding-read recovery, a globally capped hanging MCP write across four reconnect epochs, bounded
hanging writes, CLI ordering, and listener/socket/timer/Orca-child cleanup.

The changed-source audit found no `CLAUDE_PID`, raw-frame logger, production Gate mutation/write,
schema-version change, Slack action/projection change, or `작업 재개` string. Environment routing
tests use a rejecting proxy and prove the Adapter command reads only the three declared routing
claim names; no credential value was read, printed, copied, or logged during validation.

## Independent read-only audits

Two independent post-fix read-only GPT reviewers inspected the final diff after all material
findings were fixed. The routing-semantics reviewer reported **PASS — no remaining P0–P2
correctness/security defect** and verified exact per-candidate Run/generation fencing, stale
retirement before cardinality, preserved lone-stale behavior, and structural zero Gate writes. The
lifecycle/test reviewer reported **PASS — no remaining P0–P2 concurrency or regression-coverage
defect** and verified repeated evaluation, stale socket removal, fresh exact-epoch eligibility,
true current-candidate ambiguity, and deterministic cleanup.

## Diff size

The final staged diff contains 15 files, 4,368 insertions, and 20 deletions: production/package
code is 1,807 additions and 18 deletions; tests are 1,663 additions and 2 deletions; evidence is
144 additions; and the exact dependency lock update is 754 additions.

## Historical D3-1 residual

The official surface and installed dependency were verified, but an actual Claude Code 2.1.243
interactive Channel was deliberately not registered or opted in. The development warning was not
confirmed, no user `.mcp.json` was written, and no live receipt callback or Gate/Task resume was
performed. Therefore this evidence does **not** claim a 2.1.243 Channel E2E, silent-drop behavior,
or any production Gate delivery/resume result; production Gate sends remain impossible and zero in
D3-1.

The combined D3 exercise later observed this path in a human-approved live session, but did not
close the release residual because the Adapter and repaired daemon were not launched from one exact
immutable build. See [D3 live Channel acceptance evidence](d3-live-channel-acceptance.md).
