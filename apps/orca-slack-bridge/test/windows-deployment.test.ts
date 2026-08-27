import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  prepareDeploymentState,
  setDeploymentDesiredStopped,
  validateWindowsDeployment,
  type ValidatedWindowsDeployment,
  type WindowsDeploymentPathAccess,
  type WindowsDeploymentPaths,
} from '../src/windows/deployment.js';
import { APP_TOKEN_VAR, BOT_TOKEN_VAR } from '../src/slack/verify.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import {
  operationalStatusStateIdentity,
  type OperationalStatusSnapshotLeaseStore,
} from '../src/operational/status-capability.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-windows-deploy-한글-'));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function windowsPathAccess(
  nativeRoot: string,
  windowsRoot: string,
): WindowsDeploymentPathAccess {
  const canonicalNativeRoot = realpathSync.native(nativeRoot);
  const toNativePath = (windowsPath: string): string => {
    const normalized = win32.normalize(windowsPath);
    const child = win32.relative(windowsRoot, normalized);
    if (child === '..' || child.startsWith('..\\') || win32.isAbsolute(child)) {
      throw new Error('test fixture Windows path escaped its native root');
    }
    return child === ''
      ? canonicalNativeRoot
      : join(canonicalNativeRoot, ...child.split('\\'));
  };
  return {
    toNativePath,
    canonicalize: (windowsPath) => {
      const canonical = realpathSync.native(toNativePath(windowsPath));
      const child = relative(canonicalNativeRoot, canonical);
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error('test fixture canonical path escaped its native root');
      }
      return child === '' ? windowsRoot : win32.join(windowsRoot, ...child.split(sep));
    },
  };
}

function createRelease(): {
  readonly input: WindowsDeploymentPaths;
  readonly env: NodeJS.ProcessEnv;
  readonly pathAccess: WindowsDeploymentPathAccess;
} {
  const windowsRoot = String.raw`C:\Orca 배포 테스트`;
  const pathAccess = windowsPathAccess(root, windowsRoot);
  const appRoot = win32.join(windowsRoot, 'release with spaces', 'bridge-2026.08.27');
  const data = win32.join(windowsRoot, '사용자 데이터');
  mkdirSync(pathAccess.toNativePath(win32.join(appRoot, 'dist')), { recursive: true });
  mkdirSync(pathAccess.toNativePath(data), { recursive: true });
  const dependencies = {
    '@modelcontextprotocol/sdk': '1.30.0',
    '@slack/socket-mode': '3.0.0',
    '@slack/web-api': '8.0.0',
    undici: '^7.29.0',
  };
  writeFileSync(pathAccess.toNativePath(win32.join(appRoot, 'package.json')), JSON.stringify({
    name: '@dev-infra/orca-slack-bridge',
    version: '1.2.3',
    type: 'module',
    files: ['dist'],
    bin: { 'orca-slack-bridge': './dist/cli.js' },
    dependencies,
  }));
  writeFileSync(
    pathAccess.toNativePath(win32.join(appRoot, 'dist', 'cli.js')),
    '#!/usr/bin/env node\n',
  );
  for (const dependency of Object.keys(dependencies)) {
    const directory = win32.join(appRoot, 'node_modules', ...dependency.split('/'));
    mkdirSync(pathAccess.toNativePath(directory), { recursive: true });
    writeFileSync(
      pathAccess.toNativePath(win32.join(directory, 'package.json')),
      JSON.stringify({ name: dependency }),
    );
  }
  const nodePath = win32.join(windowsRoot, 'runtime', 'node.exe');
  const orcaPath = win32.join(windowsRoot, 'tools', 'Orca CLI.exe');
  mkdirSync(pathAccess.toNativePath(win32.dirname(nodePath)), { recursive: true });
  mkdirSync(pathAccess.toNativePath(win32.dirname(orcaPath)), { recursive: true });
  writeFileSync(pathAccess.toNativePath(nodePath), 'synthetic node');
  writeFileSync(pathAccess.toNativePath(orcaPath), 'synthetic orca');
  const configPath = win32.join(data, 'bridge config.json');
  writeFileSync(
    pathAccess.toNativePath(configPath),
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
      statePath: win32.join(data, 'state.db'),
      logDir: win32.join(data, '운영 로그'),
    },
    env,
    pathAccess,
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

function snapshotLeaseIdentity(statePath: string): {
  readonly capabilityPath: string;
  readonly stateIdentity: string;
} {
  return {
    capabilityPath: win32.join(win32.dirname(statePath), 'synthetic-owner.capability'),
    stateIdentity: operationalStatusStateIdentity(statePath, 'win32'),
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
  it('preserves Windows drive/backslash semantics over native host fixture storage', async () => {
    const fixture = createRelease();
    const result = await validateWindowsDeployment(fixture.input, {
      platform: 'win32',
      env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.3.0' },
      pathAccess: fixture.pathAccess,
    });
    expect(fixture.input.appRoot).toMatch(/^[A-Z]:\\/u);
    expect(fixture.input.appRoot).not.toContain('/');
    expect(fixture.pathAccess.toNativePath(fixture.input.appRoot)).toBe(
      join(root, 'release with spaces', 'bridge-2026.08.27'),
    );
    expect(result.paths).toMatchObject(fixture.input);
    expect(result.paths.cliPath).toBe(win32.join(fixture.input.appRoot, 'dist', 'cli.js'));
    expect(result.buildDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(existsSync(fixture.pathAccess.toNativePath(result.paths.logDir))).toBe(true);
  });

  it('rejects credential-shaped config fields and unsupported Node/platform with static errors', async () => {
    const fixture = createRelease();
    const nativeConfigPath = fixture.pathAccess.toNativePath(fixture.input.configPath);
    const config = JSON.parse(readFileSync(nativeConfigPath, 'utf8')) as Record<string, unknown>;
    config['botToken'] = 'TOKEN_SENTINEL_NEVER_PRINT';
    writeFileSync(nativeConfigPath, JSON.stringify(config));
    await expect(validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
      pathAccess: fixture.pathAccess,
    })).rejects.toThrow('windows.deploy.config_contains_credentials');
    await expect(validateWindowsDeployment(fixture.input, {
      platform: 'linux', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
      pathAccess: fixture.pathAccess,
    })).rejects.toThrow('windows.deploy.unsupported_platform');
    writeFileSync(
      nativeConfigPath,
      readFileSync(join(process.cwd(), 'config.example.json')),
    );
    await expect(validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v25.9.0' },
      pathAccess: fixture.pathAccess,
    })).rejects.toThrow('windows.deploy.unsupported_node');
  });

  // node:sqlite backup is one libuv work item and can wait behind unrelated parallel test workers.
  it('checkpoints and verifies a timestamped backup outside the release before first v13 migration', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
      pathAccess: fixture.pathAccess,
    });
    downgradeToV12(fixture.pathAccess.toNativePath(deployment.paths.statePath));
    const order: string[] = [];
    const prepared = await prepareDeploymentState(deployment, {
      platform: 'win32',
      leaseStore: leaseStore(),
      resolveSnapshotLeaseIdentity: snapshotLeaseIdentity,
      pathAccess: fixture.pathAccess,
      clock: () => new Date('2026-08-27T01:02:03.004Z'),
      afterBackup: () => { order.push('backup'); },
      beforeMigration: (version) => { order.push(`migrate-${version}`); },
    });
    try {
      expect(prepared.backupPath).not.toBeNull();
      expect(prepared.backupPath?.startsWith(deployment.paths.appRoot)).toBe(false);
      expect(schemaVersion(fixture.pathAccess.toNativePath(prepared.backupPath!))).toBe(12);
      expect(schemaVersion(fixture.pathAccess.toNativePath(deployment.paths.statePath))).toBe(13);
      expect(order).toEqual(['backup', 'migrate-12']);
    } finally {
      await prepared.release();
    }
  }, 15_000);

  it('fails before migration when the state lease is not available', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, {
      platform: 'win32', env: fixture.env,
      versionProbe: { readVersion: async () => 'v26.0.0' },
      pathAccess: fixture.pathAccess,
    });
    await expect(prepareDeploymentState(deployment, {
      platform: 'win32',
      leaseStore: { tryAcquireSnapshotLease: async () => null },
      resolveSnapshotLeaseIdentity: snapshotLeaseIdentity,
      pathAccess: fixture.pathAccess,
    })).rejects.toThrow('windows.deploy.state_in_use');
    expect(existsSync(fixture.pathAccess.toNativePath(deployment.paths.statePath))).toBe(false);
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
