---
name: shared-compute
description: Run heavy tests, benchmarks or training on the owned u22 server over SSH (alias `compute`) with sanitized repo snapshots, explicit resources and bounded jobs. Use for computation too large for the local machine; keep small checks local.
---

# Shared compute (u22)

SSH alias `compute` = `hyun@u22`: 48 cores / 96 threads, ~256 GiB RAM, four separate 24 GiB TITAN RTX cards (not one 96 GiB card). Allowed GPU indexes are [0,2,3]; GPU1 stays excluded. No sudo or docker on u22.

## Commands

```powershell
python -B D:\dev-infra\skills\shared-compute\scripts\compute.py status
```

`snapshot REPO`, `submit REPO --cpu N --memory-mb N --timeout SECONDS -- COMMAND ARG...`, `logs JOB`, `fetch JOB NEW_DIRECTORY`, `cancel JOB`. Use only these SSH subcommands; the `aws-*` and `oci-*` subcommands are retired.

## Rules

- Request explicit CPU threads, RAM, GPU indexes and a finite timeout covering startup, work and reporting. Do not invent fixed profiles or caps, and do not bypass admission with another state root or older helper. Details: [adaptive resources](references/adaptive-resources.md), [execution contract](references/contract.md).
- Review the snapshot manifest before submitting: tracked changes, deletions and untracked files must be intended. Never put secrets in arguments or copy agent/SSH credentials to the server.
- Fetch outputs into a new directory and review conflicts; never overwrite the working tree.
- Cancel only your own job group. Preserve other users' active workloads: no global kill, no stale-job purge. On an uncertain transport, inspect the same job before retrying.
- No automatic push, merge or production migration from compute results.
