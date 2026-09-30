---
name: init-orchestrate
description: >-
  Boot or resume a Codex session as the coordinator of an Orca orchestration Run. Use when the
  user asks for "$init-orchestrate", orchestration startup, a GPT/Codex coordinator, unattended
  worker coordination, or continuation from an Orca handoff. It owns the Task DAG, Claude/Codex worker
  routing, PR/review/merge lifecycle, Slack Gate decisions, cleanup, and safe context rollover. Do
  not use for one worker task or ordinary terminal control.
---

# Init Orchestrate for Codex

Turn this Codex session into the single mutation-authorized coordinator for one Orca Run. Keep the
existing Claude coordinator path compatible; this skill defines the Codex path.

## Invocation

```text
$init-orchestrate <scope, priority, and verifiable stopping point>
$init-orchestrate --resume <run_id>
$init-orchestrate --fresh
```

The argument narrows this Run. Repository authority and the user's latest explicit decision still
win. Do not silently reconcile a conflict that changes product direction.

## Bootstrap

1. Use the installed `orca-cli` skill to resolve this session's CLI executable and read its guide.
   Then load `skills get orchestration --full` through that same executable before orchestration
   commands. The `orca` examples below mean that resolved executable. Use `agent-context --json`
   when an exact command schema is needed. Do not rely on remembered CLI syntax.
2. Verify `orca status --json` reports `state: ready`, `git var GIT_AUTHOR_IDENT` succeeds, the
   repository runtime is available, and `gh auth status` succeeds when the Run creates or merges
   PRs. Report a failed prerequisite and stop before creating workers.
   Run these checks inside this coordinator's own tool shell. A parent or managed worker's success
   does not establish access in a custom Codex launch. Record resolved executable paths and any
   explicitly configured launch policy; do not change sandbox or approval settings to bypass a
   failed check. An Orca `agent_prompt_blocked` response requires the pending prompt to be handled
   through its permitted user flow before continuing.
3. Find and read the repository's authority declaration, commonly `docs/README.md`, `AGENTS.md`, or
   `CONTRIBUTING.md`, then every canonical document it names. Conversation summaries and handoffs
   are continuity evidence, not source of truth.
4. Decide Fresh versus Resume before mutation. An explicit flag wins. Otherwise resume only when a
   handoff contains a live `run_id`; use Fresh in every other case. State the evidence for the
   choice.
5. Read [worker-routing.md](references/worker-routing.md) before proposing or dispatching the DAG.
   Read [run-lifecycle.md](references/run-lifecycle.md) before the first Run mutation. Those two
   references are normative parts of this skill.

## Fresh Run

Before implementation, show the understood objective, exclusions, completion checks, proposed DAG,
and each task's routing row, family, and chosen model/effort. Record existing rollover approval for this Run, or ask once
when it has not been decided. Do not
dispatch a coding worker or edit product code until the user settles any material direction choice.

After agreement:

1. Create the Run and Task DAG.
2. Record the current terminal as coordinator through the Orca flow.
3. Write the Codex Run marker with the bundled helper described below.
4. Dispatch every independent ready task and enter the coordinator loop.

## Resume Run

Re-read repository authority, then compare the handoff with live Orca Run/Task/Dispatch/Worker/Gate,
Git worktree, GitHub PR/review/CI, and cleanup state. Live state wins. Do not duplicate a dispatch,
merge, or already-completed external effect.

Only after the predecessor has fenced itself, take ownership with the installed guide's `run-use`
flow. Confirm that the Run now names this terminal/pane and has advanced its consumer generation;
then replace the marker with this session's identity. Reuse valid workers, worktrees, and PRs.

## Codex Run marker

The marker is both the rollover opt-in and the Slack Bridge's proof that a Run is intentionally
owned by Codex. Write it atomically with the bundled script; do not hand-edit JSON:

```text
node <skill-root>/scripts/run-marker.mjs write \
  --run-id <run_id> --worktree <absolute_path> \
  --session-id <CODEX_SESSION_ID> --terminal-handle <ORCA_TERMINAL_HANDLE> \
  --pane-key <ORCA_PANE_KEY> --generation <consumer_generation> \
  --model <effective_model> --effort <effective_effort> --context-window <effective_window> \
  --handoff-path <absolute_handoff_path> [--reserve-tokens <positive_integer>] \
  [--rollover-approved]
```

Resolve `<skill-root>` from this `SKILL.md` location. Prefer `CODEX_SESSION_ID`, with
`CODEX_THREAD_ID` only as a compatibility fallback. Never guess terminal, pane, or generation;
read them from the current environment and exact Run row. Record the active model/effort, not the
requested preference. The transcript-reported context window overrides the marker fallback when
available. Include `--rollover-approved` only when the user has approved automatic rollover for this
Run. Omit it when rollover is declined; the marker still enables Slack Gate wake delivery.

Markers live at `~/.codex/orchestration/runs/<run_id>.json`. Remove the exact marker only after the
Run has no pending dispatch, cleanup, or external effect:

```text
node <skill-root>/scripts/run-marker.mjs remove --run-id <run_id>
```

## Coordinator loop

- Continue from planning into execution while safe work remains. A plan or status note is not a
  stopping point.
- Parallelize independent Task DAG nodes. Keep one worktree per coding task.
- Workers create PRs but never merge them. Reviewers return a structured verdict; this coordinator
  checks the evidence and performs the merge.
- Release accepted workers/reviewers promptly unless an immediate follow-up reuses the identical
  model/effort assignment. Clean the Task-owned worktree, build lane, and exact PR branch after the
  merge or accepted no-PR result. Never delete a resource whose ownership is uncertain.
- Put user decisions through an Orca Gate, not a Codex interactive question. Continue every task
  independent of that Gate.
- Treat a prompt beginning `[orca-gate-wakeup v1` as wake-only. Do not infer or repeat the decision
  from the prompt. Re-read the exact Gate by both `run_id` and `gate_id`, apply it idempotently, then
  continue the loop.
- If any dispatch remains unsettled, the last action in the turn is another blocking Orca
  `check --wait`, not a text promise to keep working. Timeouts and empty deliveries are checkpoints.

The turn may end only for completed-and-cleaned Run state, a genuinely blocking Gate with no
independent ready or running work, failed bootstrap prerequisites, pre-start direction approval, or
a completed coordinator rollover.

## Correlation required for Slack PRs

Every coding worker must append these machine-readable comments to its PR body:

```html
<!-- orca-run: run_xxxxxxxxxxxx -->
<!-- orca-task: task_xxxxxxxxxxxx -->
<!-- orca-dispatch: dispatch_xxxxxxxxxxxx -->
```

`orca-run` and `orca-task` are required; `orca-dispatch` is preferred. Every completion report must
send `worker_done` with its exact `--task-id`, `--dispatch-id`, outcome, and modified files. The
Bridge deliberately does not infer missing correlation from branch names or prose.

## Rollover

The bundled Stop hook watches only an opted-in marker owned by the current Codex session. It derives
usage and context size from Codex `token_count` transcript events, never cumulative thread totals.
At the reserve it blocks the stop and instructs this coordinator to execute the pre-approved
rollover sequence in [run-lifecycle.md](references/run-lifecycle.md). A repeated hook invocation is
bounded; hook failure is pass-through, never authority to mutate the Run.

The coordinator runs on the model and effort the user launched it with; this skill does not fix a
coordinator model. Record the effective values from the session in the marker and carry them into a
successor. Verify the launched model rather than assuming a requested slug was honored.
