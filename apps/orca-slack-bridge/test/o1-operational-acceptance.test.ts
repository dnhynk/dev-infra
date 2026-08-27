import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  CHANNEL_PIPE_PATH,
  ChannelPipeServer,
} from '../src/channel/pipe-server.js';
import { runKey } from '../src/identity/keys.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const AT0 = '2026-08-27T00:00:00.000Z';
const AT1 = '2026-08-27T00:00:01.000Z';
const AT2 = '2026-08-27T00:00:02.000Z';
const AT3 = '2026-08-27T00:00:03.000Z';

const offlineOrca: OrcaRunner = {
  run: () => Promise.reject(new Error('O1 acceptance forbids external Orca work')),
};

const servers: ChannelPipeServer[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
});

function productionPipeServer(): ChannelPipeServer {
  const server = new ChannelPipeServer({
    orca: offlineOrca,
    probeDelaysMs: [25],
    helloTimeoutMs: 250,
    shutdownTimeoutMs: 1_000,
  });
  servers.push(server);
  return server;
}

async function waitForChildLine(child: ChildProcessWithoutNullStreams): Promise<string> {
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  return await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('pipe fixture readiness timeout')), 5_000);
    const finish = (error: Error | null, line = ''): void => {
      clearTimeout(timeout);
      child.stdout.removeAllListeners('data');
      child.stderr.removeAllListeners('data');
      child.removeAllListeners('exit');
      if (error === null) resolve(line);
      else reject(error);
    };
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline >= 0) finish(null, stdout.slice(0, newline).trim());
    });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('exit', (code) => finish(new Error(
      `pipe fixture exited before ready (${String(code)}:${stderr.trim()})`,
    )));
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('pipe fixture shutdown timeout')), 5_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

describe('O1-7 hermetic operational acceptance', () => {
  it('fences the exact fixed pipe across processes and hands ownership to one restarted daemon', async () => {
    expect(CHANNEL_PIPE_PATH).toBe(String.raw`\\.\pipe\orca-slack-bridge-channel-v1`);
    const fixture = spawn(process.execPath, [
      '-e',
      String.raw`
        const net = require('node:net');
        const server = net.createServer();
        server.once('error', (error) => {
          process.stderr.write(String(error && error.code || 'listen_failed'));
          process.exit(2);
        });
        server.listen(process.argv[1], () => process.stdout.write('READY\n'));
        process.stdin.resume();
        process.stdin.once('end', () => server.close(() => process.exit(0)));
      `,
      CHANNEL_PIPE_PATH,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    children.push(fixture);
    await expect(waitForChildLine(fixture)).resolves.toBe('READY');

    const daemon = productionPipeServer();
    await expect(daemon.start()).rejects.toMatchObject({ code: 'pipe_in_use' });

    fixture.stdin.end();
    await waitForExit(fixture);
    await daemon.start();

    const contender = productionPipeServer();
    await expect(contender.start()).rejects.toMatchObject({ code: 'pipe_in_use' });
    await daemon.stop();
    await contender.start();
    await contender.stop();
  }, 15_000);

  it('recovers durable daemon, job, and possible-effect root intent state without repost authority', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-o1-7-durable-'));
    const databasePath = join(directory, 'state.db');
    const entity = { kind: 'run', key: runKey('o1_acceptance') } as const;
    try {
      let store = new SqliteDigestStore(databasePath);
      store.recordDaemonStart({
        instanceId: 'old-instance', buildFingerprint: 'build.1',
        configFingerprint: 'config.1', at: AT0,
      });
      const oldJob = store.startDaemonJob('run-observer', AT0)!;
      store.advanceDaemonJobCheckpoint(oldJob, 0, 7, AT1);
      store.prepareSlackRootIntent({
        ...entity, channelId: 'C1', renderFingerprint: 'render.1', at: AT0,
      });
      expect(store.claimSlackRootIntent(entity, 'old-instance', AT1)?.kind).toBe('claimed');
      store.close();

      store = new SqliteDigestStore(databasePath);
      expect(store.readDaemonHealth()).toMatchObject({
        instanceId: 'old-instance', state: 'running', desiredState: 'running',
      });
      const orphan = store.findDaemonJobOutcome('run-observer')!;
      expect(orphan).toMatchObject({ state: 'running', checkpoint: 7 });
      expect(store.readOperationalAggregateCounts().pending.slackRootIntents).toBe(1);

      expect(store.recoverSlackRootIntents('new-instance', AT2)).toBe(1);
      expect(store.findSlackRootIntent(entity)).toMatchObject({
        state: 'uncertain', lastErrorCode: 'startup_recovery', attemptCount: 1,
      });
      expect(store.claimSlackRootIntent(entity, 'new-instance', AT3)?.kind).toBe('not_claimed');
      expect(store.readOperationalAggregateCounts()).toMatchObject({
        pending: { slackRootIntents: 0 }, uncertain: { slackRootIntents: 1 },
      });

      expect(store.completeDaemonJobFailure({
        claim: { jobName: orphan.jobName, revision: orphan.revision, startedAt: orphan.startedAt },
        at: AT2, durationMs: 2_000, errorCode: 'scheduler.aborted', checkpoint: 7,
      })).toMatchObject({ state: 'failed', checkpoint: 7, consecutiveFailures: 1 });
      expect(store.startDaemonJob('run-observer', AT3, { startupTakeover: true }))
        .toMatchObject({ jobName: 'run-observer' });
      expect(store.recordDaemonStart({
        instanceId: 'new-instance', buildFingerprint: 'build.1',
        configFingerprint: 'config.1', at: AT3,
      })).toMatchObject({ instanceId: 'new-instance', desiredState: 'running' });
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
