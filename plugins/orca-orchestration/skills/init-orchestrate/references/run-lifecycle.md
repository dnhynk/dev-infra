# Run lifecycle contract

## Ownership and persistence

Exactly one coordinator generation may mutate a Run. Fresh boot establishes it; Resume first
reconciles read-only state and then uses Orca `run-use`. A predecessor must fence itself before the
successor is created. A successor does not mutate until the Run row names its terminal and pane.

Keep the repository's handoff file current at safe checkpoints. If the repository has no format,
use `HANDOFF.md` with:

- machine-readable `run_id`, repository path, coordinator session, and rollover reason;
- the resolved Orca CLI executable and any required runtime executable paths; a custom Codex tool
  shell may not inherit the predecessor's PATH;
- any explicitly configured launch profile, sandbox, and approval policy; executable resolution
  and execution permission are separate prerequisites;
- verifiable objective and current state;
- Task dependencies and Task/Dispatch/Worker status;
- worktree, branch, PR, review, CI, and cleanup status per Task;
- open Gates plus independent work that can continue;
- in-flight external effects, non-idempotent actions, and rejected debugging approaches;
- validation commands/results, distinguishing passed, failed, reported-but-unverified, and not run.

Write through a temporary sibling and rename. Do not commit a session-local handoff unless repository
authority says otherwise. Never attribute unrelated dirty worktree changes to this Run.

## Worker completion and cleanup

Accept completion only from the exact Task/Dispatch correlation. Release a worker after an accepted
report unless an immediate same-routing follow-up reuses it. A timeout, heartbeat, question, or
unaccepted report is not release evidence.

For PR tasks, confirm GitHub reports the exact PR as merged before cleanup. For no-PR tasks, the
accepted result is the trigger. Then:

1. Verify no uncommitted change, unpushed unique commit, active dispatch, agent, or setup process
   remains in the Task worktree.
2. Remove only the Run-created full worktree identity with Orca and re-read its absence. Do not use
   force by default.
3. Remove only Task-owned build/temp lanes after proving no build is using them.
4. Delete the exact PR head branch only after verifying the merged PR's head repository/branch.
   Squash/rebase merge means ancestry is not authoritative. Safely delete any Orca-created local
   worktree branch; if safe deletion refuses, leave `cleanup_pending` rather than force.
5. Re-query worker, dispatch, worktree, and branches. Record any evidence-backed exception.

Run completion requires every dispatch settled and every Task resource removed or explicitly
recorded as `cleanup_pending` with a safe next action.

## Gates and questions

The user may see Slack while away from the terminal. Create an Orca Gate for every material user
choice. Options must be mutually exclusive, short, and no more than 75 characters each. Do not wait
on an ordinary Codex prompt. Answer worker `ask` messages from canonical facts when possible;
otherwise translate the unresolved decision into a Gate. Only dependent Tasks pause.

The Slack Bridge wake message carries identity, not authority. On
`[orca-gate-wakeup v1 run_id=... gate_id=...]`, re-read that exact Gate and its current Run before
acting. A duplicate wake is normal and must be idempotent.

## Rollover sequence

When the Stop hook directs rollover, or context quality is visibly degraded:

1. Fence this session: stop new dispatches and merges; let already-running independent workers run.
2. Atomically finalize the handoff, including in-flight effects and the next executable action.
3. Launch a successor in the current worktree with the marker's **effective** model and effort:
   `codex --model <marker model> -c 'model_reasoning_effort="<marker effort>"'`.
   Carry the already-resolved CLI executable into the successor's launch environment as
   `ORCA_CLI_COMMAND` and include that exact selector in the resume prompt. On Windows, invoke
   absolute executable paths with PowerShell's `&` operator. Do not change User/system PATH or
   execution policy. Verify the same runtime instead of silently selecting another Orca build.
   These examples specify model and effort only. Preserve an explicitly configured launch policy
   through supported launch options; rollover approval does not authorize broader permissions.
   Do not add permissive flags to get past an execution or approval failure.
4. Wait for the agent TUI to be ready and inspect `terminal read --screen`. Resolve first-run trust
   prompts through their permitted user flow if present, then re-check readiness. An Orca
   `agent_prompt_blocked` response is not a reason to try alternate keystrokes or input tools.
   Do not inject bootstrap text before readiness. Verify Orca access in the successor's own tool
   shell before claiming that it can take ownership.
5. Send `$init-orchestrate --resume <run_id>` with text and Enter in one Orca terminal call.
6. Wait for TUI idle and inspect the screen. If the text remains unsubmitted, send Enter once; do
   not duplicate the text.
7. Confirm the successor has reconciled and the Run consumer generation now names its terminal and
   pane. Update evidence in the handoff.
8. Stop mutating from the predecessor and allow it to exit.

Use `--screen`, not accumulated terminal output, for TUI state. After three failed readiness or
submission checks, raise the bounded failure instead of guessing more keystrokes. Never claim
automatic resume without observing the ownership transfer.
