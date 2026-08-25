#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
const focusedTests = [
  'test/d3-lifecycle-acceptance.test.ts',
  'test/cli-args.test.ts',
  'test/cli-daemon.test.ts',
  'test/cli-channel-adapter.test.ts',
  'test/channel-protocol.test.ts',
  'test/channel-mcp-server.test.ts',
  'test/channel-pipe.test.ts',
  'test/channel-delivery-store.test.ts',
  'test/channel-delivery-bounded-seed.test.ts',
  'test/channel-delivery.test.ts',
  'test/channel-resume.test.ts',
  'test/channel-resume-store.test.ts',
  'test/gate-resolve.test.ts',
  'test/gate-resolution-store.test.ts',
  'test/gate-resolution-render.test.ts',
  'test/post.test.ts',
  'test/slack-socket.test.ts',
  'test/slack-socket-sdk.test.ts',
  'test/store-gate.test.ts',
];

const steps = [
  {
    name: 'focused D3-4 failure matrix',
    args: ['--dir', 'apps/orca-slack-bridge', 'exec', 'vitest', 'run', ...focusedTests],
  },
  { name: 'root typecheck', args: ['typecheck'] },
  {
    name: 'bridge build',
    args: ['--filter', '@dev-infra/orca-slack-bridge', 'build'],
  },
  { name: 'full repository tests', args: ['test'] },
];

for (const step of steps) {
  process.stdout.write(`\n[D3-4] ${step.name}\n`);
  const result = spawnSync(pnpm, step.args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  if (result.error !== undefined) {
    process.stderr.write(`[D3-4] ${step.name}: launcher failed (${result.error.message})\n`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.stderr.write(`[D3-4] ${step.name}: failed with exit ${String(result.status)}\n`);
    process.exit(result.status ?? 1);
  }
}

process.stdout.write('\n[D3-4] offline acceptance passed\n');
process.stdout.write(
  '[D3-4] LIVE_CHANNEL_UNVERIFIED — this harness never launches Claude, confirms a development warning, writes user MCP/config files, or mutates live Slack/Orca resources.\n',
);
