#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.exe' : 'pnpm';
const focusedTests = [
  'test/o1-operational-acceptance.test.ts',
  'test/observer-supervisor.test.ts',
  'test/cli-daemon.test.ts',
  'test/github-background.test.ts',
  'test/discovery-reconcile.test.ts',
  'test/run-effective-routing.test.ts',
  'test/root-intent-publish.test.ts',
  'test/run-publish.test.ts',
  'test/digest.test.ts',
  'test/operational-logger.test.ts',
  'test/operational-status.test.ts',
  'test/windows-task-definition-acceptance.test.ts',
  'test/windows-task-scheduler.test.ts',
  'test/windows-lifecycle.test.ts',
  'test/windows-launcher.test.ts',
];

const steps = [
  {
    name: 'focused operational matrix',
    args: ['--dir', 'apps/orca-slack-bridge', 'exec', 'vitest', 'run', ...focusedTests],
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
