import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The operational log directory falls back to a machine-global location
 * (`%LOCALAPPDATA%\OrcaSlackBridge\logs` on Windows). Any test that runs the daemon path without an
 * explicit `--log-dir` therefore appends to the operator's live production log, which rotates at
 * 5 MiB and would push out real operational history. Pin the documented override for the whole run
 * so no test can reach it; tests that assert the resolver's own defaults pass `env` explicitly and
 * are unaffected. Child processes inherit this, so spawned daemons are covered too.
 */
const isolated = mkdtempSync(join(tmpdir(), 'orca-bridge-test-logs-'));
process.env['ORCA_SLACK_BRIDGE_LOG_DIR'] = isolated;

process.on('exit', () => {
  try { rmSync(isolated, { recursive: true, force: true }); } catch { /* best effort */ }
});
