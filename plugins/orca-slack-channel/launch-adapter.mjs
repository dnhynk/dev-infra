#!/usr/bin/env node
// Channel Adapter launcher.
//
// The Adapter must run from the *currently installed* Bridge release, and that release path changes
// on every deploy. Pinning it in `.mcp.json` would silently bind a coordinator session to a stale
// build — the exact split-build condition that kept D3 at `LIVE_CHANNEL_UNVERIFIED`. So the launcher
// resolves the release from the protected runtime manifest that `install` writes, every start.
//
// 계약: docs/specs/orca-slack-bridge.md §8, docs/ops/channel-adapter-acceptance.md

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Fail closed with a static code. A wrong or guessed release is worse than no Adapter. */
function fail(code) {
  process.stderr.write(`orca-slack-channel: ${code}\n`);
  process.exit(78);
}

const base = process.platform === 'win32'
  ? process.env['LOCALAPPDATA']
  : (process.env['XDG_DATA_HOME'] ?? join(process.env['HOME'] ?? '', '.local', 'share'));
if (!base || base.trim() === '') fail('runtime_base_unavailable');

const manifestPath = join(base, 'OrcaSlackBridge', 'runtime.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch {
  fail('runtime_manifest_unreadable');
}

const nodeExe = manifest?.nodeExe;
const distCli = manifest?.distCli;
if (typeof nodeExe !== 'string' || nodeExe === '' ||
    typeof distCli !== 'string' || distCli === '') {
  fail('runtime_manifest_invalid');
}

// stdio is inherited so the MCP framing between Claude Code and the Adapter stays a single pipe
// pair. Proxying it through this process would add a copy that can reorder or split frames.
const child = spawn(nodeExe, [distCli, 'channel-adapter'], { stdio: 'inherit', windowsHide: true });
child.on('error', () => fail('adapter_spawn_failed'));
child.on('exit', (code, signal) => {
  process.exit(signal !== null ? 1 : (code ?? 1));
});
