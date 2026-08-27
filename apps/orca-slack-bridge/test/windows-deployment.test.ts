import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  prepareDeploymentState,
  setDeploymentDesiredStopped,
  validateWindowsDeployment,
  type ValidatedWindowsDeployment,
} from '../src/windows/deployment.js';
import { APP_TOKEN_VAR, BOT_TOKEN_VAR } from '../src/slack/verify.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import type { OperationalStatusSnapshotLeaseStore } from '../src/operational/status-capability.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-windows-deploy-한글-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function createRelease(): {
  readonly input: {
    readonly appRoot: string;
    readonly nodePath: string;
    readonly orcaPath: string;
    readonly configPath: string;
    readonly statePath: string;
    readonly logDir: string;
  };
  readonly env: NodeJS.ProcessEnv;
} {
  const appRoot = join(root, 'release with spaces', 'bridge-2026.08.27');
  const data = join(root, '사용자 데이터');
  mkdirSync(join(appRoot, 'dist'), { recursive: true });
  mkdirSync(data, { recursive: true });
  const dependencies = {
    '@modelcontextprotocol/sdk': '1.30.0',
    '@slack/socket-mode': '3.0.0',
    '@slack/web-api': '8.0.0',
    undici: '^7.29.0',
  };
  writeFileSync(join(appRoot, 'package.json'), JSON.stringify({
    name: '@dev-infra/orca-slack-bridge',
    version: '1.2.3',
    type: 'module',
    files: ['dist'],
    bin: { 'orca-slack-bridge': './dist/cli.js' },
    dependencies,
  }));
  writeFileSync(join(appRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  for (const dependency of Object.keys(dependencies)) {
    const directory = join(appRoot, 'node_modules', ...dependency.split('/'));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: dependency }));
  }
  const nodePath = join(root, 'runtime', 'node.exe');
  const orcaPath = join(root, 'tools', 'Orca CLI.exe');
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(nodePath, 'synthetic node');
  writeFileSync(orcaPath, 'synthetic orca');
  const configPath = join(data, 'bridge config.json');
  writeFileSync(
    configPath,
    readFileSync(join(process.cwd(), 'config.example.json')),
  );
  const env: NodeJS.ProcessEnv = {};
  Object.defineProperty(env, BOT_TOKEN_VAR, {
    enumerable: true,
    get: () => { throw new Error('TOKEN_SENTINEL_WAS_READ'); },
  });
  Object.defineProperty(env, APP_TOKEN_VAR, {
    enumerable: true,
    get: () => { throw new Error('TOKEN_SENTINEL_WAS_READ'); },
  });
  return {
    input: {
      appRoot,
      nodePath,
      orcaPath,
      configPath,
      statePath: join(data, 'state.db'),
      logDir: join(data, '운영 로그'),
    },
    env,
  };
}

function leaseStore(): OperationalStatusSnapshotLeaseStore {
  return {
    tryAcquireSnapshotLease: async () => ({
      assertHeld: () => undefined,
      release: async () => undefined,
    }),
  };
}

function downgradeToV12(path: string): void {
  new SqliteDigestStore(path).close();
  const db = new DatabaseSync(path);
  db.exec(`
    DROP TABLE slack_root_intent;
    DROP TABLE daemon_job_outcome;
    DROP TABLE daemon_health;
    DROP TABLE repository_discovery_issue;
    DROP TABLE orca_repository_binding;
    DROP TABLE repository_registry;
  `);
  db.prepare('UPDATE schema_version SET version = 12 WHERE id = 1').run();
  db.close();
}

function schemaVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number }).version;
  } finally {
    db.close();
  }
}

describe('prebuilt Windows deployment preflight', () => {
  it('canonicalizes Unicode/space paths, verifies Node 26 and self-contained dependencies, and only checks token names', async () => {
    const fixture = createRelease();
    const result = await validateWindowsDeployment(fixture.input, {
      platform: 'win32',
      env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.3.0' },
    });
    expect(result.paths).toMatchObject(fixture.input);
    expect(result.paths.cliPath).toBe(join(fixture.input.appRoot, 'dist', 'cli.js'));
    expect(result.buildDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(existsSync(result.paths.logDir)).toBe(true);
  });

  it('rejects credential-shaped config fields and unsupported Node/platform with static errors', async () => {
    const fixture = createRelease();
    const config = JSON.parse(readFileSync(fixture.input.configPath, 'utf8')) as Record<string, unknown>;
    config['botToken'] = 'TOKEN_SENTINEL_NEVER_PRINT';
    writeFileSync(fixture.input.configPath, JSON.stringify(config));
    await expect(validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
    })).rejects.toThrow('windows.deploy.config_contains_credentials');
    await expect(validateWindowsDeployment(fixture.input, {
      platform: 'linux', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
    })).rejects.toThrow('windows.deploy.unsupported_platform');
    writeFileSync(
      fixture.input.configPath,
      readFileSync(join(process.cwd(), 'config.example.json')),
    );
    await expect(validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v25.9.0' },
    })).rejects.toThrow('windows.deploy.unsupported_node');
  });

  it('checkpoints and verifies a timestamped backup outside the release before first v13 migration', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
    });
    downgradeToV12(deployment.paths.statePath);
    const order: string[] = [];
    const prepared = await prepareDeploymentState(deployment, {
      platform: 'win32',
      leaseStore: leaseStore(),
      clock: () => new Date('2026-08-27T01:02:03.004Z'),
      afterBackup: () => { order.push('backup'); },
      beforeMigration: (version) => { order.push(`migrate-${version}`); },
    });
    try {
      expect(prepared.backupPath).not.toBeNull();
      expect(prepared.backupPath?.startsWith(deployment.paths.appRoot)).toBe(false);
      expect(schemaVersion(prepared.backupPath!)).toBe(12);
      expect(schemaVersion(deployment.paths.statePath)).toBe(13);
      expect(order).toEqual(['backup', 'migrate-12']);
    } finally {
      await prepared.release();
    }
  });

  it('fails before migration when the state lease is not available', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
    });
    await expect(prepareDeploymentState(deployment, {
      platform: 'win32',
      leaseStore: { tryAcquireSnapshotLease: async () => null },
    })).rejects.toThrow('windows.deploy.state_in_use');
    expect(existsSync(deployment.paths.statePath)).toBe(false);
  });

  it('writes the uninstall desired-stopped transition durably on exact v13', () => {
    const statePath = join(root, 'state', 'state.db');
    const store = new SqliteDigestStore(statePath);
    store.recordDaemonStart({
      instanceId: 'daemon-1',
      buildFingerprint: 'a'.repeat(64),
      configFingerprint: 'b'.repeat(64),
      at: '2026-08-27T00:00:00.000Z',
    });
    store.close();
    setDeploymentDesiredStopped(statePath, () => new Date('2026-08-27T00:00:01.000Z'));
    const reopened = new SqliteDigestStore(statePath);
    try {
      expect(reopened.readDaemonHealth()?.desiredState).toBe('stopped');
    } finally {
      reopened.close();
    }
  });
});
