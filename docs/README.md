# dev-infra documentation

This folder holds the specs, design notes, operating procedures and test records for dev-infra. The documents are written in Korean, except six evidence records in English. Start with the [root README](../README.md) for what the project does and where it stands.

## Reading order

| Document | What it covers |
|---|---|
| [Working agreement](process/working-agreement.md) | How design, implementation, debugging and verification sessions run in this repo |
| [Product vision](product-vision.md) | The manual steps the project removes and the design rules behind it |
| [Coordinator boot and handover spec](specs/orchestration-bootstrap-and-continuity.md) | `/init-orchestrate`, Run markers, handoff files and rollover |
| [Bridge spec](specs/orca-slack-bridge.md) | Required behavior of `orca-slack-bridge` |
| [Bridge architecture](architecture/orca-slack-bridge.md) | Components, processes and failure boundaries |
| [Observation and correlation contract](contracts/observation-and-correlation.md) | Entity identity, and how pull requests are linked to Runs and Tasks |
| [Slack surfaces](ux/slack-surfaces.md) | Card layout and wording |
| [Roadmap](roadmap.md) | Build order by stage |
| [Decision log](decision-log.md) | The owner's decisions in date order. Replaced entries are marked SUPERSEDED |
| [Open decisions](open-decisions.md) | Questions still open, and the answers to closed ones |
| [Platform capabilities](platform-capabilities.md) | Measured behavior and limits of Orca, GitHub, Slack, Claude Code and Codex, with versions |
| [Slack app setup](ops/slack-app-setup.md) | Creating the Slack app, tokens and channels |
| [Claude Code channel adapter](ops/channel-adapter-acceptance.md) | Installing the adapter and the live acceptance procedure |
| [Codex coordinator setup](ops/codex-coordinator-setup.md) | Installing the Codex plugin and its acceptance |
| [Windows login start](ops/windows-startup.md) | Staging a release and installing the Scheduled Task |
| [Traceability](traceability.md) | Where each original requirement is kept |
| [Initial design notes](source/initial-design-notes.md) | The design discussion the specs were written from |

## When documents disagree

Read them in this order of authority:

1. The owner's latest explicit decision.
2. The [decision log](decision-log.md).
3. The [working agreement](process/working-agreement.md) and any `AGENTS.md` that applies.
4. The topic documents in the table above.
5. Examples, candidate technologies and future ideas.

A newer owner decision replaces an older one on the same topic. The decision log keeps both and marks the older entry SUPERSEDED. An implementer who meets an unanswered question records it in the open-decisions log, and the owner settles it during the build.

Example JSON, CLI calls and Slack wording illustrate intent. They do not fix field names, command syntax or copy unless a document marks them as a fixed contract (확정 계약).

## Status labels used in the documents

| Label | Meaning |
|---|---|
| Draft | The document still has open items. Requirements marked 확정 inside it are still binding |
| 확정 (fixed) | An implementer must not change or replace it by guesswork |
| TBD | To be settled from observation and the owner's decision during the build |
| 후속 (follow-up) | Part of the long-term plan, outside the current build |
| 검증 필요 (needs verification) | Depends on an external product version or a live environment and must be rechecked |
| Open | An open-decisions entry with no decision yet |
| Draft audit | The traceability table's audit of the documents; not a source of requirements |

## Stage and entry codes

The Korean documents refer to build stages and log entries by short codes.

| Code | Meaning |
|---|---|
| AB | Coordinator boot and context handover (`/init-orchestrate`, rollover monitor) |
| S0 | Read-only observation of Orca and GitHub, and entity correlation |
| C1, C2 | PR cards in `#pr-digest`; review, CI and merge tracking |
| D1 | Run observer and Run cards in `#agent-runs` |
| D2 | Gate cards, and writing Slack decisions to Orca |
| D3 | Waking the coordinator after a decision (Claude Code channel adapter, Codex terminal route) |
| O1 | Always-on operation: daemon, Windows login task, status and logs |
| T1 to T5 | Platform probes run on 2026-08-23 to settle open questions for C2, D1, D2 and D3 |
| DL-nnn, OD-nnn | Entries in the decision log and the open-decisions log |

## Evidence

[`evidence/`](evidence/) holds dated records of live and offline checks. They support the specs but do not define behavior.

| Record | Check | Date | Language |
|---|---|---|---|
| [t1-github-lifecycle](evidence/t1-github-lifecycle.md) | GitHub pull request lifecycle | 2026-08-23 | Korean |
| [t2-orca-worker-done-retrieval](evidence/t2-orca-worker-done-retrieval.md) | Reading worker completion reports from Orca | 2026-08-23 | Korean |
| [t3-orca-gate-and-aggregation](evidence/t3-orca-gate-and-aggregation.md) | Orca Gates and Run aggregation | 2026-08-23 | Korean |
| [t4-slack-inbound](evidence/t4-slack-inbound.md) | Slack Socket Mode and interaction payloads | 2026-08-23 | Korean |
| [t5-channel-adapter](evidence/t5-channel-adapter.md) | Claude Code channel behavior | 2026-08-23 | Korean |
| [d2-c-gate-resolution](evidence/d2-c-gate-resolution.md) | Resolving a Gate from a fixed-option button | 2026-08-25 | English |
| [d2-d-direct-input-modal](evidence/d2-d-direct-input-modal.md) | Resolving a Gate from the direct-input dialog | 2026-08-25 | Korean |
| [d3-1-channel-transport](evidence/d3-1-channel-transport.md) | Local named-pipe transport to the adapter | 2026-08-25 | English |
| [d3-2-durable-delivery](evidence/d3-2-durable-delivery.md) | Durable delivery of decisions to the coordinator | 2026-08-25 | English |
| [d3-4-lifecycle-acceptance](evidence/d3-4-lifecycle-acceptance.md) | Offline failure matrix for the wake-up path | 2026-08-26 | English |
| [o1-operational-acceptance](evidence/o1-operational-acceptance.md) | Windows login task and status checks | 2026-08-27 | English |
| [codex-coordinator-acceptance](evidence/codex-coordinator-acceptance.md) | Codex coordinator wake-up and rollover, live | 2026-09-07 | Korean |
| [d3-live-channel-acceptance](evidence/d3-live-channel-acceptance.md) | Slack decision wakes a Claude Code coordinator, live | 2026-10-01 | English |
