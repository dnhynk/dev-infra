# GPT worker routing

Use only Codex workers and GPT-family models for a Run booted by this skill. Choose the lowest effort
that still matches the risk; reasoning effort is a correctness/cost control, not a status symbol.

| # | Work | Trigger | agent | model | effort |
|---|---|---|---|---|---|
| 1 | Architecture, schema, contract | Expensive-to-reverse structure or competing invariants | `codex` | `gpt-6-astra` | `max` |
| 2 | Hard implementation | Concurrency, state machines, security, numerical correctness, or performance proof | `codex` | `gpt-6-astra` | `xhigh` |
| 3 | Standard implementation and tests | Specified feature plus non-trivial tests | `codex` | `gpt-5.6-sol` | `high` |
| 4 | Reproduction and debugging | Requires hypotheses, discriminating observations, and falsification | `codex` | `gpt-6-astra` | `xhigh` |
| 5 | Mechanical change | Exact rule, no design judgment: rename, imports, generated cases, fixed migration | `codex` | `gpt-5.6-luna` | `low` |
| 6 | Broad factual research | Several primary sources or repo regions; conclusion is evidence synthesis | `codex` | `gpt-5.6-terra` | `high` |
| 7 | Ordinary PR review | Correctness, regression, tests, maintainability | `codex` | `gpt-5.6-sol` | `xhigh` |
| 7b | Silent-risk adversarial review | Money, units, signs, probability, time leakage, security boundary, concurrency invariant, irreversible migration | `codex` | `gpt-6-astra` | `max` |
| 8 | Reasoned spec or design docs | Document itself makes or defends design decisions | `codex` | `gpt-5.6-sol` | `high` |
| 9 | Factual docs | Organize already-settled facts, references, README, or release notes | `codex` | `gpt-5.6-terra` | `medium` |
| 10 | Review-fix pass | Directly addresses review findings without changing scope | same as original dispatch | same | same |
| 11 | Escalation after failure or low confidence | Rows 1–4 fail twice for the same cause, or evidence-backed completion remains indeterminate | fresh `codex` | `gpt-6-astra` | `max` |

Row 3 is the default when no trigger clearly applies. A repository-specific routing contract wins.

## Dispatch rules

- Include the selected row and its trigger in Task metadata.
- Check the `worker-start` receipt's `launch.effective` model and effort against `launch.requested`.
  A request is not evidence that the runtime applied it.
- `gpt-6-astra` is the top lane. Check the current account/runtime; a historical failure from
  another Orca account does not justify a downgrade. For a fresh exact
  `model is not supported when using Codex with a ChatGPT account` availability
  error, use the compatibility lane `gpt-5.6-sol` at `max`, record `astra_unavailable` in Task/Run
  evidence, and never call the result Astra work. A different mismatch or provider error still
  fails closed through an Orca Gate.
- Do not reuse a terminal for a task whose row changes. Release it and launch a fresh worker because
  `--terminal` retains the original model/effort assignment.
- Do not use `ultra` in this table. On the currently observed 5.6 runtime it can introduce nested
  delegation; the coordinator, not a worker, owns the DAG and fan-out. A repository may explicitly
  override this.
- Do not invent a service tier. `worker-start` has no service-tier control.

## Escalation discipline

Low confidence must be observable: contradictory report text, only conditional conclusions, no
supporting execution/observation, or failure to claim a testable completion criterion. If the
coordinator can decide from canonical spec, code, and live state, decide directly instead of
escalating. Give row 11 the prior hypothesis, evidence, and unresolved point, and require a distinct
counter-hypothesis. If row 11 remains indeterminate, raise one Gate rather than recursing again.

Row 7b is preventive and must name the silent-risk trigger. It does not replace ordinary review for
every PR.
