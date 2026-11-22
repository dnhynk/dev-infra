# Execution contract

Source: `D:\dev-infra\skills\shared-compute`, discovered through junctions `C:\Users\dongh\.agents\skills\shared-compute` and `C:\Users\dongh\.claude\skills\shared-compute`. Keep one source; do not copy it into plugin caches or other skill folders.

## Configuration

- Windows configuration: `C:\Users\dongh\.config\shared-compute\config.json` (`SHARED_COMPUTE_CONFIG` overrides it for fixtures). The configured host is the SSH alias `compute`.
- Host strings are plain aliases or hostnames only, with no SSH options, user or port syntax. Existing SSH configuration supplies user, port and keys.
- The server also runs unrelated long-lived services; jobs never touch them.
- Submission receipts are written under the configuration directory's `jobs` folder before SSH starts (job ID, host, snapshot-manifest hash). A failed or timed-out transport leaves `submission: uncertain`; inspect that job before retrying. `SHARED_COMPUTE_STATE` overrides the receipt directory for fixtures.
- The Codex Windows sandbox may deny access to `.config` and SSH configuration. Use a narrowly approved invocation outside the sandbox; do not change ACLs or authentication.

## Transport

Windows OpenSSH with `BatchMode=yes`, `StrictHostKeyChecking=yes`, connection and operation timeouts. Command calls ship `common.py` and `remote.py` over stdin instead of relying on installed server code. It never adds keys, changes SSH config, accepts new host keys or copies credentials. A new submit never overwrites an existing job.

All jobs share the private server state root `~/.local/state/shared-compute` and its owner-private `policy.json`. See [adaptive resources](adaptive-resources.md).

## What is enforced

- Jobs atomically reserve CPU threads, RAM, job slots and GPUs under one `flock`. Reservations last until the supervisor exits. A missing supervisor is a closed failure that needs operator inspection; reservations are not freed automatically because children might still run.
- Workers set CPU affinity, CPU-time limits, a wall timeout, thread hints and CUDA visibility for the owned process group. RAM limits are per-process address-space limits, not aggregate limits. GPU exclusivity is cooperative among this wrapper's jobs, not hardware isolation. There is no network or filesystem sandbox; the server user's processes can read anything that user can read.
- Cancellation writes a job-owned marker; the supervisor terminates, then kills and reaps its process group and publishes a terminal result. Descendants that escape the process group are outside the contract. A crashed supervisor is reported `orphaned`; submit nothing further until an operator checks the processes. No global kill or automatic stale-job deletion.

## Snapshots and outputs

- Snapshots use Git's tracked and nonignored untracked files, including dirty content, deletions and executable bits. Reparse points, symlinks, unsafe paths and UNC roots fail closed. Reads are bounded and reject size, time or mode changes during the read.
- Snapshots are not atomic across the repository; stop writers while snapshotting.
- Payloads are capped at 32 MiB and 10,000 files. Credential filenames, token/secret name patterns and obvious key/token content are excluded (`tokenizer.py`-style names are kept). This is not a complete secret detector. `.git` and local agent/cloud/SSH credential directories are never uploaded. The manifest (SHA-256 and sizes) is rechecked at remote extraction, which accepts regular files only.
- Jobs run in a fresh `workspace` with a fresh `outputs` directory exposed as `SHARED_COMPUTE_OUTPUT`; only that directory is fetched. Fetch accepts terminal jobs only, verifies hashes, requires a new destination and rejects symlinks or unsafe files.
- Logs keep the last 4 MiB on the server and return the last 64 KiB. There is no automatic job cleanup; check disk usage and authorize retention separately.

## Validation

`python -B scripts/run_offline_tests.py` from the skill directory. Windows runs snapshot, transport and fetch tests; Linux/WSL also runs the runner lifecycle, concurrency, timeout and cancellation fixtures. Fixtures use local temporary data and a fake SSH executable; they do not prove live readiness.
