import { DatabaseSync } from 'node:sqlite';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  computeReleaseBuildDigest,
  normalizeWindowsReleaseTextFiles,
  parseOrcaReadinessOutput,
  prepareDeploymentState,
  setDeploymentDesiredStopped,
  SpawnOrcaReadinessProbe,
  validateWindowsDeployment,
  verifyDeploymentDaemonBuildIdentity,
  type ValidatedWindowsDeployment,
  type WindowsDeploymentPathAccess,
  type WindowsDeploymentPaths,
} from '../src/windows/deployment.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import {
  operationalStatusStateIdentity,
  operationalStatusWindowsKnownAppData,
  operationalStatusWindowsKnownLocalAppData,
  type OperationalStatusSnapshotLeaseStore,
} from '../src/operational/status-capability.js';
import { fingerprintOperationalBuild } from '../src/operational/status.js';
import {
  createWindowsRuntimeManifest,
  parseWindowsRuntimeManifest,
  serializeWindowsRuntimeManifest,
} from '../src/windows/runtime-manifest.js';
import { downgradeGateMetadataToV13 } from './fixtures/schema-downgrade.js';

let root: string;
let releaseSequence: number;

const nativeOrcaCandidate = process.platform === 'win32' && process.env['LOCALAPPDATA'] !== undefined
  ? win32.join(process.env['LOCALAPPDATA'], 'Programs', 'orca', 'resources', 'bin', 'orca.exe')
  : '';
const nativeReadyOrcaIt = nativeOrcaCandidate.length > 0 && existsSync(nativeOrcaCandidate)
  ? it
  : it.skip;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-windows-deploy-한글-'));
  releaseSequence = 0;
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
  readonly pathAccess: WindowsDeploymentPathAccess;
  readonly appData: string;
  readonly localAppData: string;
  readonly powerShellPath: string;
} {
  const sequence = releaseSequence++;
  const windowsRoot = String.raw`C:\Orca 배포 테스트`;
  const pathAccess = windowsPathAccess(root, windowsRoot);
  const appData = win32.join(windowsRoot, 'Roaming AppData 한글');
  const localAppData = win32.join(windowsRoot, 'Local AppData 한글');
  const releasesRoot = win32.join(localAppData, 'OrcaSlackBridge', 'releases');
  const stagingRoot = win32.join(releasesRoot, '.staging release with spaces');
  const data = win32.join(windowsRoot, '사용자 데이터');
  mkdirSync(pathAccess.toNativePath(win32.join(stagingRoot, 'dist')), { recursive: true });
  mkdirSync(pathAccess.toNativePath(win32.join(stagingRoot, 'windows')), { recursive: true });
  mkdirSync(pathAccess.toNativePath(appData), { recursive: true });
  mkdirSync(pathAccess.toNativePath(data), { recursive: true });
  const dependencies = {
    '@modelcontextprotocol/sdk': '1.30.0',
    '@slack/socket-mode': '3.0.0',
    '@slack/web-api': '8.0.0',
    '@xmldom/xmldom': '0.9.12',
    undici: '^7.29.0',
  };
  writeFileSync(pathAccess.toNativePath(win32.join(stagingRoot, 'package.json')), JSON.stringify({
    name: '@dev-infra/orca-slack-bridge',
    version: '1.2.3',
    type: 'module',
    files: ['dist', 'windows/launch-daemon.ps1'],
    bin: { 'orca-slack-bridge': './dist/cli.js' },
    dependencies,
  }));
  writeFileSync(
    pathAccess.toNativePath(win32.join(stagingRoot, 'dist', 'cli.js')),
    `#!/usr/bin/env node\n// fixture ${sequence}\n`,
  );
  writeFileSync(
    pathAccess.toNativePath(win32.join(stagingRoot, 'windows', 'launch-daemon.ps1')),
    '# immutable launcher fixture\n',
  );
  for (const dependency of Object.keys(dependencies)) {
    const directory = win32.join(stagingRoot, 'node_modules', ...dependency.split('/'));
    mkdirSync(pathAccess.toNativePath(directory), { recursive: true });
    writeFileSync(
      pathAccess.toNativePath(win32.join(directory, 'package.json')),
      JSON.stringify({ name: dependency }),
    );
  }
  const digest = computeReleaseBuildDigest(stagingRoot, pathAccess);
  const appRoot = win32.join(releasesRoot, digest);
  renameSync(pathAccess.toNativePath(stagingRoot), pathAccess.toNativePath(appRoot));
  const nodePath = win32.join(windowsRoot, 'runtime', 'node.exe');
  const orcaPath = win32.join(windowsRoot, 'tools', 'Orca CLI.exe');
  const powerShellPath = win32.join(windowsRoot, 'Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  mkdirSync(pathAccess.toNativePath(win32.dirname(nodePath)), { recursive: true });
  mkdirSync(pathAccess.toNativePath(win32.dirname(orcaPath)), { recursive: true });
  mkdirSync(pathAccess.toNativePath(win32.dirname(powerShellPath)), { recursive: true });
  writeFileSync(pathAccess.toNativePath(nodePath), 'synthetic node');
  writeFileSync(pathAccess.toNativePath(orcaPath), 'synthetic orca');
  writeFileSync(pathAccess.toNativePath(powerShellPath), 'synthetic powershell');
  const configPath = win32.join(data, 'bridge config.json');
  writeFileSync(
    pathAccess.toNativePath(configPath),
    readFileSync(join(process.cwd(), 'config.example.json')),
  );
  return {
    input: {
      appRoot,
      nodePath,
      orcaPath,
      configPath,
      statePath: win32.join(data, 'state.db'),
      logDir: win32.join(data, '운영 로그'),
    },
    pathAccess,
    appData,
    localAppData,
    powerShellPath,
  };
}

function validationOptions(fixture: ReturnType<typeof createRelease>) {
  return {
    platform: 'win32' as const,
    versionProbe: { readVersion: async () => 'v26.3.0' },
    orcaReadinessProbe: { ready: async () => true },
    environmentPresenceProbe: { requiredBridgeEnvironmentPresent: async () => true },
    pathAccess: fixture.pathAccess,
    knownAppData: () => fixture.appData,
    knownLocalAppData: () => fixture.localAppData,
    trustedPowerShell: () => ({ executable: fixture.powerShellPath }),
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
  downgradeGateMetadataToV13(db);
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
  it('accepts only the closed ready Orca status shape', () => {
    const ready = {
      id: 'request-id',
      ok: true,
      result: {
        target: { kind: 'local' },
        app: { running: true, pid: 1234, desktopWindowStatus: 'available' },
        runtime: {
          state: 'ready', reachable: true, runtimeId: 'runtime-id', appVersion: '1.2.3',
          remoteUpdateSupport: { installMode: 'interactive', automatic: true, reason: 'supported' },
          capabilities: [],
        },
        graph: { state: 'ready' },
      },
      _meta: { runtimeId: 'runtime-id' },
    };
    expect(parseOrcaReadinessOutput(JSON.stringify(ready))).toBe(true);
    expect(parseOrcaReadinessOutput(JSON.stringify({
      ...ready, result: { ...ready.result, graph: { state: 'loading' } },
    }))).toBe(false);
    expect(parseOrcaReadinessOutput(JSON.stringify({ ...ready, extra: true }))).toBe(false);
    expect(parseOrcaReadinessOutput('{')).toBe(false);
  });

  it('probes the canonical Orca executable and fails closed when it is not ready', async () => {
    const fixture = createRelease();
    let observed = '';
    let observedFolders: { readonly appData: string; readonly localAppData: string } | undefined;
    await validateWindowsDeployment(fixture.input, {
      ...validationOptions(fixture),
      orcaReadinessProbe: {
        ready: async (executable, knownFolders) => {
          observed = executable;
          observedFolders = knownFolders;
          return true;
        },
      },
    });
    expect(observed).toBe(fixture.input.orcaPath);
    expect(observedFolders).toEqual({
      appData: fixture.appData,
      localAppData: fixture.localAppData,
    });
    await expect(validateWindowsDeployment(fixture.input, {
      ...validationOptions(fixture),
      orcaReadinessProbe: { ready: async () => false },
    })).rejects.toThrow('windows.deploy.orca_not_ready');
  });

  nativeReadyOrcaIt('reaches the real ready Orca with both trusted AppData known folders', async () => {
    const localAppData = operationalStatusWindowsKnownLocalAppData();
    const appData = operationalStatusWindowsKnownAppData();
    const executable = realpathSync.native(win32.join(
      localAppData, 'Programs', 'orca', 'resources', 'bin', 'orca.exe',
    ));
    expect(await new SpawnOrcaReadinessProbe().ready(executable, {
      appData,
      localAppData,
    })).toBe(true);
  }, 20_000);

  it('uses one canonical non-secret runtime manifest encoding and rejects semantic drift', () => {
    const fixture = createRelease();
    const digest = win32.basename(fixture.input.appRoot);
    const manifest = createWindowsRuntimeManifest({
      releaseRoot: fixture.input.appRoot,
      releaseDigest: digest,
      nodeExe: fixture.input.nodePath,
      distCli: win32.join(fixture.input.appRoot, 'dist', 'cli.js'),
      launcherPath: win32.join(fixture.input.appRoot, 'windows', 'launch-daemon.ps1'),
      launcherSha256: 'e'.repeat(64),
      taskSemanticFingerprint: 'f'.repeat(64),
      config: fixture.input.configPath,
      state: fixture.input.statePath,
      orcaExe: fixture.input.orcaPath,
      logDirectory: fixture.input.logDir,
    });
    const bytes = serializeWindowsRuntimeManifest(manifest);
    expect(parseWindowsRuntimeManifest(bytes)).toEqual(manifest);
    expect(bytes.toString('utf8')).not.toMatch(/xox|token|secret|password|authorization/iu);
    expect(parseWindowsRuntimeManifest(Buffer.from(' ' + bytes.toString('utf8')))).toBeNull();
    expect(parseWindowsRuntimeManifest(Buffer.from(JSON.stringify({ ...manifest, extra: true }) + '\n')))
      .toBeNull();
    expect(parseWindowsRuntimeManifest(Buffer.from(JSON.stringify({
      ...manifest,
      distCli: win32.join(fixture.input.appRoot, 'other.js'),
    }) + '\n'))).toBeNull();
    expect(parseWindowsRuntimeManifest(Buffer.from(JSON.stringify({
      ...manifest,
      launcherSha256: '0'.repeat(64),
    }) + '\n'))).toBeNull();
  });

  it('preserves Windows paths and keeps mutable state/log preparation read-only', async () => {
    const fixture = createRelease();
    expect(existsSync(fixture.pathAccess.toNativePath(fixture.input.statePath))).toBe(false);
    expect(existsSync(fixture.pathAccess.toNativePath(fixture.input.logDir))).toBe(false);
    const result = await validateWindowsDeployment(fixture.input, validationOptions(fixture));
    expect(fixture.input.appRoot).toMatch(/^[A-Z]:\\/u);
    expect(fixture.input.appRoot).not.toContain('/');
    expect(fixture.pathAccess.toNativePath(fixture.input.appRoot)).toBe(
      join(
        root,
        'Local AppData 한글',
        'OrcaSlackBridge',
        'releases',
        win32.basename(fixture.input.appRoot),
      ),
    );
    expect(result.paths).toMatchObject(fixture.input);
    expect(result.paths.cliPath).toBe(win32.join(fixture.input.appRoot, 'dist', 'cli.js'));
    expect(result.paths.launcherPath).toBe(
      win32.join(fixture.input.appRoot, 'windows', 'launch-daemon.ps1'),
    );
    expect(result.paths.powerShellPath).toBe(fixture.powerShellPath);
    expect(result.paths.runtimeManifestPath).toBe(
      win32.join(fixture.localAppData, 'OrcaSlackBridge', 'runtime.json'),
    );
    expect(win32.basename(result.paths.appRoot)).toBe(result.buildDigest);
    expect(result.buildDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(existsSync(fixture.pathAccess.toNativePath(result.paths.statePath))).toBe(false);
    expect(existsSync(fixture.pathAccess.toNativePath(result.paths.logDir))).toBe(false);
  });

  it('hashes every dependency byte and rejects arbitrary roots, digest drift, and external reparse points', async () => {
    const dependencyFixture = createRelease();
    const before = computeReleaseBuildDigest(dependencyFixture.input.appRoot, dependencyFixture.pathAccess);
    writeFileSync(
      dependencyFixture.pathAccess.toNativePath(win32.join(
        dependencyFixture.input.appRoot,
        'node_modules', 'undici', 'package.json',
      )),
      JSON.stringify({ name: 'undici', changed: true }),
    );
    expect(computeReleaseBuildDigest(dependencyFixture.input.appRoot, dependencyFixture.pathAccess))
      .not.toBe(before);
    await expect(validateWindowsDeployment(
      dependencyFixture.input,
      validationOptions(dependencyFixture),
    )).rejects.toThrow('windows.deploy.noncanonical_release_root');

    const arbitraryFixture = createRelease();
    await expect(validateWindowsDeployment({
      ...arbitraryFixture.input,
      appRoot: win32.dirname(arbitraryFixture.input.appRoot),
    }, validationOptions(arbitraryFixture))).rejects.toThrow(/windows\.deploy\./u);

    const linkFixture = createRelease();
    const external = win32.join(win32.dirname(linkFixture.input.appRoot), 'external dependency');
    mkdirSync(linkFixture.pathAccess.toNativePath(external), { recursive: true });
    writeFileSync(linkFixture.pathAccess.toNativePath(win32.join(external, 'package.json')), '{}');
    symlinkSync(
      linkFixture.pathAccess.toNativePath(external),
      linkFixture.pathAccess.toNativePath(win32.join(linkFixture.input.appRoot, 'node_modules', 'escape')),
      'junction',
    );
    expect(() => computeReleaseBuildDigest(linkFixture.input.appRoot, linkFixture.pathAccess))
      .toThrow('windows.deploy.release_reparse_point');

    const hardLinkFixture = createRelease();
    linkSync(
      hardLinkFixture.pathAccess.toNativePath(win32.join(
        hardLinkFixture.input.appRoot, 'dist', 'cli.js',
      )),
      hardLinkFixture.pathAccess.toNativePath(win32.join(
        hardLinkFixture.input.appRoot, 'dist', 'cli-hard-link.js',
      )),
    );
    expect(() => computeReleaseBuildDigest(hardLinkFixture.input.appRoot, hardLinkFixture.pathAccess))
      .toThrow('windows.deploy.release_hard_link');

    const unicodeFixture = createRelease();
    writeFileSync(
      unicodeFixture.pathAccess.toNativePath(win32.join(
        unicodeFixture.input.appRoot, 'dist', 'e\u0301.js',
      )),
      'non-normalized path',
    );
    expect(() => computeReleaseBuildDigest(unicodeFixture.input.appRoot, unicodeFixture.pathAccess))
      .toThrow('windows.deploy.invalid_release_name');
  });

  it('normalizes app-owned build and launcher EOL so independent stages converge', () => {
    const windowsRoot = String.raw`C:\Orca 재현 가능한 staging`;
    const pathAccess = windowsPathAccess(root, windowsRoot);
    const dependencyPayload = Buffer.from([0, 13, 10, 255, 42]);
    const createStage = (name: string, newline: '\n' | '\r\n'): string => {
      const stage = win32.join(windowsRoot, name);
      for (const directory of [
        win32.join(stage, 'dist', 'nested'),
        win32.join(stage, 'windows'),
        win32.join(stage, 'node_modules', 'fixture-dependency'),
      ]) mkdirSync(pathAccess.toNativePath(directory), { recursive: true });
      writeFileSync(pathAccess.toNativePath(win32.join(stage, 'package.json')), JSON.stringify({
        name: '@dev-infra/orca-slack-bridge',
        version: '1.2.3',
        type: 'module',
        files: ['dist', 'windows/launch-daemon.ps1'],
        bin: { 'orca-slack-bridge': './dist/cli.js' },
        dependencies: { 'fixture-dependency': '1.0.0' },
      }));
      writeFileSync(
        pathAccess.toNativePath(win32.join(stage, 'node_modules', 'fixture-dependency', 'package.json')),
        JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }),
      );
      writeFileSync(
        pathAccess.toNativePath(win32.join(stage, 'node_modules', 'fixture-dependency', 'payload.bin')),
        dependencyPayload,
      );
      writeFileSync(
        pathAccess.toNativePath(win32.join(stage, 'dist', 'cli.js')),
        `#!/usr/bin/env node${newline}console.log('fixture');${newline}`,
      );
      writeFileSync(
        pathAccess.toNativePath(win32.join(stage, 'dist', 'nested', 'types.d.ts')),
        `export type Fixture = string;${newline}`,
      );
      writeFileSync(
        pathAccess.toNativePath(win32.join(stage, 'dist', 'nested', 'cli.js.map')),
        `{"version":3}${newline}`,
      );
      writeFileSync(
        pathAccess.toNativePath(win32.join(stage, 'windows', 'launch-daemon.ps1')),
        `param()${newline}exit 0${newline}`,
      );
      return stage;
    };
    const lfStage = createStage('검증 stage LF', '\n');
    const crlfStage = createStage('검증 stage CRLF', '\r\n');
    expect(computeReleaseBuildDigest(lfStage, pathAccess))
      .not.toBe(computeReleaseBuildDigest(crlfStage, pathAccess));

    normalizeWindowsReleaseTextFiles(pathAccess.toNativePath(lfStage));
    normalizeWindowsReleaseTextFiles(pathAccess.toNativePath(crlfStage));

    expect(computeReleaseBuildDigest(lfStage, pathAccess))
      .toBe(computeReleaseBuildDigest(crlfStage, pathAccess));
    for (const stage of [lfStage, crlfStage]) {
      expect(readFileSync(pathAccess.toNativePath(win32.join(stage, 'dist', 'cli.js')), 'utf8'))
        .not.toContain('\r');
      expect(readFileSync(pathAccess.toNativePath(win32.join(
        stage, 'node_modules', 'fixture-dependency', 'payload.bin',
      )))).toEqual(dependencyPayload);
    }
  });

  it('rejects credential-shaped config fields and unsupported Node/platform with static errors', async () => {
    const fixture = createRelease();
    const nativeConfigPath = fixture.pathAccess.toNativePath(fixture.input.configPath);
    const config = JSON.parse(readFileSync(nativeConfigPath, 'utf8')) as Record<string, unknown>;
    config['botToken'] = 'TOKEN_SENTINEL_NEVER_PRINT';
    writeFileSync(nativeConfigPath, JSON.stringify(config));
    await expect(validateWindowsDeployment(fixture.input, {
      ...validationOptions(fixture),
      versionProbe: { readVersion: async () => 'v26.0.0' },
    })).rejects.toThrow('windows.deploy.config_contains_credentials');
    await expect(validateWindowsDeployment(fixture.input, {
      ...validationOptions(fixture),
      platform: 'linux',
      versionProbe: { readVersion: async () => 'v26.0.0' },
    })).rejects.toThrow('windows.deploy.unsupported_platform');
    writeFileSync(
      nativeConfigPath,
      readFileSync(join(process.cwd(), 'config.example.json')),
    );
    await expect(validateWindowsDeployment(fixture.input, {
      ...validationOptions(fixture),
      versionProbe: { readVersion: async () => 'v25.9.0' },
    })).rejects.toThrow('windows.deploy.unsupported_node');
    await expect(validateWindowsDeployment(fixture.input, {
      ...validationOptions(fixture),
      environmentPresenceProbe: { requiredBridgeEnvironmentPresent: async () => false },
    })).rejects.toThrow('windows.deploy.required_environment_absent');
  });

  // node:sqlite backup is one libuv work item and can wait behind unrelated parallel test workers.
  it('checkpoints and verifies a timestamped backup outside the release before first v14 migration', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, validationOptions(fixture));
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
      expect(schemaVersion(fixture.pathAccess.toNativePath(deployment.paths.statePath))).toBe(14);
      expect(order).toEqual(['backup', 'migrate-12']);
    } finally {
      await prepared.release();
    }
  }, 15_000);

  it('fails before migration when the state lease is not available', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, validationOptions(fixture));
    await expect(prepareDeploymentState(deployment, {
      platform: 'win32',
      leaseStore: { tryAcquireSnapshotLease: async () => null },
      resolveSnapshotLeaseIdentity: snapshotLeaseIdentity,
      pathAccess: fixture.pathAccess,
    })).rejects.toThrow('windows.deploy.state_in_use');
    expect(existsSync(fixture.pathAccess.toNativePath(deployment.paths.statePath))).toBe(false);
  });

  it('creates v14 only when the state path is truly absent', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, validationOptions(fixture));
    const nativeStatePath = fixture.pathAccess.toNativePath(deployment.paths.statePath);
    expect(existsSync(nativeStatePath)).toBe(false);
    const prepared = await prepareDeploymentState(deployment, {
      platform: 'win32',
      leaseStore: leaseStore(),
      resolveSnapshotLeaseIdentity: snapshotLeaseIdentity,
      pathAccess: fixture.pathAccess,
    });
    try {
      expect(prepared.backupPath).toBeNull();
      expect(schemaVersion(nativeStatePath)).toBe(14);
    } finally {
      await prepared.release();
    }
  });

  it('rejects a present unversioned foreign database without changing any state byte', async () => {
    const fixture = createRelease();
    const deployment = await validateWindowsDeployment(fixture.input, validationOptions(fixture));
    mkdirSync(
      fixture.pathAccess.toNativePath(win32.dirname(deployment.paths.statePath)),
      { recursive: true },
    );
    const nativeStatePath = fixture.pathAccess.toNativePath(deployment.paths.statePath);
    const foreign = new DatabaseSync(nativeStatePath);
    foreign.exec('CREATE TABLE operator_data (value TEXT NOT NULL)');
    foreign.prepare('INSERT INTO operator_data (value) VALUES (?)').run('preserve-me');
    foreign.close();
    const before = readFileSync(nativeStatePath);
    let migrationObserved = false;

    await expect(prepareDeploymentState(deployment, {
      platform: 'win32',
      leaseStore: leaseStore(),
      resolveSnapshotLeaseIdentity: snapshotLeaseIdentity,
      pathAccess: fixture.pathAccess,
      beforeMigration: () => { migrationObserved = true; },
    })).rejects.toThrow('windows.deploy.state_unversioned');

    expect(migrationObserved).toBe(false);
    expect(readFileSync(nativeStatePath)).toEqual(before);
    const reopened = new DatabaseSync(nativeStatePath, { readOnly: true });
    try {
      expect(reopened.prepare('SELECT value FROM operator_data').get()).toEqual({ value: 'preserve-me' });
      expect(reopened.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
      ).get()).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it('writes the uninstall desired-stopped transition durably on exact v13', () => {
    const statePath = join(root, 'state', 'state.db');
    const releaseIdentity = 'a'.repeat(64);
    const store = new SqliteDigestStore(statePath);
    store.recordDaemonStart({
      instanceId: 'daemon-1',
      buildFingerprint: fingerprintOperationalBuild(releaseIdentity),
      configFingerprint: 'b'.repeat(64),
      at: '2026-08-27T00:00:00.000Z',
    });
    store.close();
    const lease = verifyDeploymentDaemonBuildIdentity(statePath, releaseIdentity);
    expect(() => setDeploymentDesiredStopped(
      statePath,
      'c'.repeat(64),
      lease,
      () => new Date('2026-08-27T00:00:01.000Z'),
    )).toThrow('windows.uninstall.state_identity_mismatch');
    setDeploymentDesiredStopped(
      statePath,
      releaseIdentity,
      lease,
      () => new Date('2026-08-27T00:00:01.000Z'),
    );
    const reopened = new SqliteDigestStore(statePath);
    try {
      expect(reopened.readDaemonHealth()?.desiredState).toBe('stopped');
    } finally {
      reopened.close();
    }
  });
});
