# Adaptive resource admission

The server policy uses `capacity_mode=adaptive`: there are no fixed CPU, RAM, job-count or lifetime caps. Admission is derived from real hardware (96 logical threads, ~251 GiB RAM), current availability and existing reservations.

## Planning a job

- Keep small checks local. For real work, estimate CPU scaling, peak RAM, per-card VRAM and a finite lifetime from the workload, using a small local measurement when possible.
- `submit` requires `--cpu N --memory-mb M --timeout SECONDS`; GPUs use `--gpu INDEX` (repeatable). There are no named profiles.
- A request grants no new network, security or spending authority.
- Never bypass admission with another state root or an older helper.

## Admission semantics

- Under the shared `flock`, admission reads allowed affinity, MemTotal/MemAvailable and a 100 ms per-CPU utilization sample, excludes CPU slots already reserved and prefers quieter slots. This is a cooperative estimate, not exclusive ownership.
- RAM must fit both physical MemTotal minus all nominal reservations and current MemAvailable minus the unconsumed part of active reservations. Outside jobs are not isolated, so availability can change after the check.
- Concurrency is bounded only by real resources; each job reserves at least one thread and positive RAM.
- Every job needs an explicit finite lifetime covering startup, waits, compute and reporting; the supervisor enforces it.
- GPUs are reserved with CPU/RAM. Allowed indexes are [0,1,2] (three cards). Admission refuses cards with external occupancy or unreadable metadata.
- New jobs record `admission_observation` (hardware and RAM availability, idle slots, reserved CPU IDs, active count, lifetime). An observation is not a guarantee of future availability.

## Enforcement limits

Command RAM is limited per process (`RLIMIT_AS`). Reservations are nominal accounting, not cgroup isolation. GPU metadata can race external work.
