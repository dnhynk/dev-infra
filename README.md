# dev-infra

[![CI](https://github.com/dnhynk/dev-infra/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dnhynk/dev-infra/actions/workflows/ci.yml)

dev-infra helps one developer supervise several Claude Code and Codex agents working in parallel in Orca: it boots the coordinating agent, mirrors pull requests and Runs into Slack cards, and takes decisions back from Slack buttons.

A decision made in Slack is written to Orca before the coordinator is woken, and the wake-up carries only the Gate ID, so the coordinator reads the answer from Orca itself.

Orca is a desktop app that runs coding agents side by side, each in its own git worktree and terminal. A Run is one job in Orca, split into tasks with dependencies. The coordinator is the agent session that owns a Run: it assigns tasks to worker agents, checks reviews and merges pull requests. A Gate is a question the coordinator records in Orca when a person must decide; the tasks that depend on it wait and the others keep running.

```text
❓  결정 필요 · Keep the v1 webhook format or move to v2?
[Keep v1]  [Move to v2]  [직접 입력]
Run Webhook cleanup · Project sample-app · 권장 Keep v1 · 대기 Task 2개 · 계속 가능 1개
```

Abridged text of a Gate card as [`src/gate/render.ts`](apps/orca-slack-bridge/src/gate/render.ts) builds it for a sample question. The card labels are Korean: 결정 필요 "decision needed", 직접 입력 "type an answer", 권장 "recommended", 대기 Task 2개 "2 tasks waiting", 계속 가능 1개 "1 task can continue".

- Context: personal project, built solo, August to October 2026.
- Verified: on 2026-10-01 a Gate answered with a Slack button was recorded in Orca, and the waiting Claude Code coordinator re-read it and resumed with a Codex worker. Live check on the author's Windows machine with a throwaway Run ([record](docs/evidence/d3-live-channel-acceptance.md)).
- Status: maintained personal tool. Windows only, one Slack workspace, one owner. Waking a Claude Code coordinator relies on Claude Code channels, a research preview.

## What it does

- Boots a coordinator with one command (`/init-orchestrate` in Claude Code, `$init-orchestrate` in Codex) and hands the Run to a fresh session before the context window fills.
- Keeps one card per pull request in `#pr-digest` with a short summary, the review result, CI, risk and merge readiness.
- Keeps one card per Run in `#agent-runs` with the coordinator, task status, worker assignments and anything waiting on a person.
- Posts each Gate as a card with one button per option and a typed-answer dialog, records the answer in Orca and wakes the coordinator that asked.
- Posts a card when an agent terminal is stuck on a Claude Code choice prompt, and types the chosen option into that terminal.

## How it works

Paths that start with `src/` or `test/` are in [`apps/orca-slack-bridge/`](apps/orca-slack-bridge/).

- Boot and handover. The skill has the session re-read the repository's specs and write a Run marker. After each turn a Stop hook reads the session's token usage. When the remaining context falls below the reserve in the marker, the hook tells the coordinator to write `HANDOFF.md`, start a successor in a new terminal and pass it the Run ([`skills/init-orchestrate/SKILL.md`](skills/init-orchestrate/SKILL.md), [`tools/rollover-monitor/rollover-monitor.mjs`](tools/rollover-monitor/rollover-monitor.mjs); the Codex hook is tested in `plugins/orca-orchestration/test/rollover-monitor.test.mjs`).
- One card per pull request and per Run. The daemon polls Orca and GitHub (through `gh`). It links a pull request to its Run and Task only through metadata lines the worker adds to the PR body, not through branch names or titles. It edits the same Slack message with `chat.update` when the facts change and makes no Slack call when they do not (`test/digest.test.ts`).
- Decision before wake-up. A Gate click is checked, saved to SQLite and acknowledged within Slack's 3-second limit. The daemon then calls `orca orchestration gate-resolve` and queues a wake-up only after Orca confirms the resolution. Claude Code receives it through a channel adapter, an MCP server connected to the daemon over a named pipe; Codex receives it as input to the coordinator's Orca terminal once the Run marker matches (`src/gate/action-handler.ts`, `src/gate/resolve.ts`, `src/channel/delivery.ts`; offline failure matrix in `test/d3-lifecycle-acceptance.test.ts`).
- Owner allowlist. Gate buttons, the typed-answer dialog and terminal-prompt buttons count only when the Slack team, app and user match the config, with the user listed in `slack.ownerUserIds`. Other clicks and ordinary Slack messages are acknowledged and dropped before Orca is called (`src/gate/action-handler.ts`, `test/gate-action-handler.test.ts`, `test/terminal-action-handler.test.ts`).
- A narrow job for the LLM. For PR cards the OpenAI API returns four strings (title, what, why, review gist) under a strict JSON schema. Status, risk, links and buttons come from code, and output that adds a link is rejected. A summary is regenerated only when its input facts change, and without an API key the card shows facts only (`src/summarize/contract.ts`, `test/summarize.test.ts`).

Start reading here: `src/gate/action-handler.ts` (a Slack click from identity check to durable claim), `src/summarize/contract.ts` (what the model may write) and [`skills/init-orchestrate/SKILL.md`](skills/init-orchestrate/SKILL.md) (the coordinator contract, in Korean). Two bridge files are very large: `src/store/sqlite.ts`, the SQLite store, is 354 KB (8,281 lines), and `src/cli.ts` is 113 KB.

## Results

| Check | Date | Setting | Result | Record |
|---|---|---|---|---|
| Slack decision wakes a Claude Code coordinator | 2026-10-01 | Live, author's Windows machine, throwaway Run. Daemon and channel adapter on the same build of `main` (`7c80b6c`), Claude Code 2.1.286, Orca 1.4.217 | A Slack button resolved one Gate. The coordinator re-read it and started one Codex worker, and the task completed. The same Slack card updated 10 s later | [d3-live-channel-acceptance](docs/evidence/d3-live-channel-acceptance.md) |
| Slack decision wakes a Codex coordinator, and one rollover | 2026-09-07 to 09-08 | Live, throwaway Run, Orca 1.4.188, Codex 0.153.4 | After a Slack answer the coordinator woke and the task resumed. The installed Stop hook triggered one rollover (Run generation 1 to 2) | [codex-coordinator-acceptance](docs/evidence/codex-coordinator-acceptance.md) (in Korean) |
| Claude Code coordinator rollover | 2026-08-22 | Live, throwaway Run | Low-context detection, handoff, successor start and takeover completed once | [platform-capabilities](docs/platform-capabilities.md), section 2.10 (in Korean) |
| Test suite in CI | 2026-10-01 | GitHub Actions, ubuntu-latest, Node 26, commit `6a42b89` | 1,797 Vitest tests passed and 21 were skipped; 8 Node tests for the Codex hook passed | [CI run](https://github.com/dnhynk/dev-infra/actions/runs/36867604840) |

Each live check ran once, on one machine.

## Status and limitations

- Built for the author's setup: one Slack workspace and a single owner. Card text and CLI messages are in Korean.
- The daemon, its login task and the named pipe to coordinator sessions are Windows-only. The tests also run on Linux in CI.
- Waking a Claude Code coordinator depends on Claude Code channels, a research preview. Starting sessions without a per-session approval prompt needs an admin-written Claude Code managed settings file that allowlists this plugin, and that file replaces Claude Code's default channel allowlist.
- When a session starts, Claude Code shows a channel's instructions only after the next human prompt or tool result. Wake-up events that arrive earlier reach the session without them (seen with Claude Code 2.1.285 and 2.1.286); the daemon repeats its probe until the session acknowledges it.
- If a coordinator stops after starting its successor but before the successor takes over, nothing restarts it. `HANDOFF.md` keeps the state, and a person resumes the Run.
- During the 2026-10-01 check the daemon stopped twice when Windows Terminal was closed or reopened. The launcher now detaches from its console (`test/windows-launcher.test.ts`); there is no live record of that fix yet.
- Not built: `#deploys` and `#prod-alerts` channels, a second confirmation for high-risk actions, relaying Claude Code permission prompts to Slack, and use by more than one owner.

## Run it

The test suite needs no accounts, API keys or network services. It needs Node.js 26 or newer and pnpm 11.22.0.

```sh
git clone https://github.com/dnhynk/dev-infra.git && cd dev-infra
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
node --test plugins/orca-orchestration/test/rollover-monitor.test.mjs
```

On Linux `pnpm test` ends with `Tests  1798 passed | 21 skipped (1819)`, and the last command reports `pass 8`. On Windows a different set of platform-specific tests runs, so the counts differ. If a bridge daemon is already running on that Windows machine, the four tests that bind its fixed named pipe fail with `EADDRINUSE`.

Running the bridge itself is Windows-only, because it starts at login through Task Scheduler. It needs Windows PowerShell 5.1, Node.js 26, pnpm 11.22.0, Orca with its `orca` CLI, a signed-in GitHub CLI (`gh`), Claude Code or Codex, and a Slack app in Socket Mode. Tokens are read from the user environment variables `ORCA_SLACK_BRIDGE_BOT_TOKEN`, `ORCA_SLACK_BRIDGE_APP_TOKEN` and, for PR summaries, `ORCA_SLACK_BRIDGE_OPENAI_KEY`. The config file holds IDs only, and installation rejects a config that contains a credential ([`config.example.json`](apps/orca-slack-bridge/config.example.json)). Follow [Slack app setup](docs/ops/slack-app-setup.md), then [Windows login start](docs/ops/windows-startup.md), then [Claude Code channel adapter](docs/ops/channel-adapter-acceptance.md) or [Codex coordinator setup](docs/ops/codex-coordinator-setup.md). All four guides are in Korean.

## Docs

- [Documentation index](docs/README.md): reading order and a key to the stage codes used in the Korean documents.
- [Bridge spec](docs/specs/orca-slack-bridge.md) (in Korean)
- [Bridge architecture](docs/architecture/orca-slack-bridge.md) (in Korean)
- [Coordinator boot and handover spec](docs/specs/orchestration-bootstrap-and-continuity.md) (in Korean)
- [Records of live and offline checks](docs/evidence/) (English and Korean)

## Project context

Personal project for my own Orca setup, built solo between August and October 2026. Specified, reviewed and verified by me; implemented with Claude Code and Codex. Commits written through Claude Code carry Co-Authored-By trailers.

## License

[MIT](LICENSE)
