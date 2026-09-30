# Worker routing

The work type fixes the worker family (`--agent`). The model and effort inside that family are chosen
at dispatch time from runtime evidence, never from this file: providers ship models too often for a
fixed table to stay current. Reasoning effort is a correctness/cost control, not a status symbol.

| # | Work | Trigger | family (`--agent`) |
|---|---|---|---|
| 1 | Architecture, schema, contract | Expensive-to-reverse structure or competing invariants | `claude` |
| 2 | Hard implementation | Concurrency, state machines, security, numerical correctness, or performance proof | `claude` |
| 3 | Standard implementation and tests | Specified feature plus non-trivial tests | `codex` |
| 4 | Reproduction and debugging | Requires hypotheses, discriminating observations, and falsification | `codex` |
| 5 | Mechanical change | Exact rule, no design judgment: rename, imports, generated cases, fixed migration | `codex` |
| 6 | Broad factual research | Several primary sources or repo regions; conclusion is evidence synthesis | `codex` |
| 7 | Ordinary PR review | Correctness, regression, tests, maintainability | `codex` |
| 7b | Silent-risk adversarial review | Money, units, signs, probability, time leakage, security boundary, concurrency invariant, irreversible migration | `claude` |
| 8 | Reasoned spec or design docs | Document itself makes or defends design decisions | `claude` |
| 9 | Factual docs | Organize already-settled facts, references, README, or release notes | `codex` |
| 10 | Review-fix pass | Directly addresses review findings without changing scope | same family as the original dispatch |
| 11 | Escalation after failure or low confidence | Rows 1–4 fail twice for the same cause, or evidence-backed completion remains indeterminate | fresh `claude` |

Row 3 is the default when no trigger clearly applies. A repository-specific routing contract wins.

## Choosing model and effort

- Read candidates from the runtime at dispatch time, not from memory.
  - `claude`: the aliases that `claude --help` lists for `--model` (each resolves to the latest model
    of its line) and the levels it lists for `--effort`. Any Claude model may be chosen.
  - `codex`: models with `visibility` `list` in `codex debug models`, chosen by the catalog's
    `priority` and `description` against the task's difficulty. Pick effort only from that model's
    `supported_reasoning_levels`.
- Choose the lowest setting that can produce the result. Use the family's strongest reasoning setting
  for expensive-to-reverse decisions, correctness proofs, row 7b, and row 11.
- Record the chosen model, effort, and a one-line reason in Task metadata.
- If candidates cannot be read, do not guess: omit `--model` and `--effort` so the worker inherits the
  user's configured agent default, and record that.
- If the requested model is rejected, relaunch with the next candidate of the same family and record
  the rejection. Never switch family silently. If the family has no usable candidate, raise a Gate.

## Dispatch rules

- Include the selected row and its trigger in Task metadata.
- Check the `worker-start` receipt's `launch.effective` model and effort against `launch.requested`.
  A request is not evidence that the runtime applied it.
- Do not reuse a terminal for a task whose row changes. Release it and launch a fresh worker because
  `--terminal` retains the original model/effort assignment.
- Do not give a worker `ultra`. It can introduce nested delegation; the coordinator, not a worker, owns
  the DAG and fan-out. A repository may explicitly override this.
- Do not invent a service tier. `worker-start` has no service-tier control.

## Escalation discipline

Low confidence must be observable: contradictory report text, only conditional conclusions, no
supporting execution/observation, or failure to claim a testable completion criterion. If the
coordinator can decide from canonical spec, code, and live state, decide directly instead of
escalating. Give row 11 the prior hypothesis, evidence, and unresolved point, and require a distinct
counter-hypothesis. If row 11 remains indeterminate, raise one Gate rather than recursing again.

Row 7b is preventive and must name the silent-risk trigger. It does not replace ordinary review for
every PR.
