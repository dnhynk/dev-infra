#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';

const steps = [
  {
    name: 'complete bridge test suite',
    args: ['--dir', 'apps/orca-slack-bridge', 'exec', 'vitest', 'run'],
  },
];

for (const step of steps) {
  process.stdout.write(`\n[O1-7] ${step.name}\n`);
  const result = spawnSync(pnpm, step.args, { cwd: repositoryRoot, stdio: 'inherit' });
  if (result.error !== undefined) {
    process.stderr.write(`[O1-7] ${step.name}: launcher failed (${result.error.message})\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write('\n[O1-7] hermetic operational acceptance passed\n');
process.stdout.write(
  '[O1-7] No LLM was invoked and no Slack, GitHub, Orca, or production Scheduled Task was mutated.\n',
);
