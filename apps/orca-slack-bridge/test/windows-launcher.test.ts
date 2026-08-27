import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeReleaseBuildDigest } from '../src/windows/deployment.js';
import {
  createWindowsRuntimeManifest,
  serializeWindowsRuntimeManifest,
} from '../src/windows/runtime-manifest.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const temporaryRoots: string[] = [];
const sentinel = 'INHERITED_SENTINEL_DO_NOT_PRINT';
const syntheticBot = 'SYNTHETIC_BOT_FIXTURE_VALUE';
const syntheticApp = 'SYNTHETIC_APP_FIXTURE_VALUE';
const userScopeReads = [
  '[Environment]::GetEnvironmentVariable($botTokenName, [EnvironmentVariableTarget]::User)',
  '[Environment]::GetEnvironmentVariable($appTokenName, [EnvironmentVariableTarget]::User)',
] as const;
const knownLocalAppDataRead =
  '[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)';

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function launcherSource(): string {
  return readFileSync(
    process.env['ORCA_WINDOWS_LAUNCHER_FIXTURE_SOURCE'] ??
      join(process.cwd(), 'windows', 'launch-daemon.ps1'),
    'utf8',
  );
}

function createLauncherFixture(options: {
  readonly botValue?: string;
  readonly appValue?: string;
  readonly canonicalRoot?: boolean;
  readonly protectedManifest?: boolean;
  readonly taskBinding?: boolean;
  readonly manifestMutation?: 'self-digest' | 'launcher-hash';
} = {}) {
  const botValue = options.botValue ?? syntheticBot;
  const appValue = options.appValue ?? syntheticApp;
  const parent = mkdtempSync(join(tmpdir(), 'Orca launcher closure 실제 공백 '));
  temporaryRoots.push(parent);
  const knownLocalAppData = join(parent, 'Local AppData 알려진 폴더');
  const releasesRoot = options.canonicalRoot === false
    ? join(parent, '비정규 releases')
    : join(knownLocalAppData, 'OrcaSlackBridge', 'releases');
  mkdirSync(releasesRoot, { recursive: true });
  const stagingRoot = join(parent, '검증 staging');
  const distDirectory = join(stagingRoot, 'dist');
  const windowsDirectory = join(stagingRoot, 'windows');
  const dependencyDirectory = join(stagingRoot, 'node_modules', 'fixture-dependency');
  const nestedDirectory = join(dependencyDirectory, 'nested');
  const dataDirectory = join(parent, '사용자 데이터');
  const logDirectory = join(dataDirectory, '운영 로그');
  for (const directory of [distDirectory, windowsDirectory, nestedDirectory, logDirectory]) {
    mkdirSync(directory, { recursive: true });
  }

  const tokenReadMarker = join(dataDirectory, 'token reads.marker');
  const daemonMarker = join(dataDirectory, 'daemon.marker');
  const psPath = (value: string): string =>
    `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf16le').toString('base64')}'))`;
  const quote = String.fromCharCode(39);
  const psString = (value: string): string =>
    quote + value.replaceAll(quote, quote + quote) + quote;
  const sourceLauncher = launcherSource();
  expect(sourceLauncher.split('(Test-PrivateAcl $manifestParent $true)').length - 1).toBe(2);
  expect(sourceLauncher.split('(Test-PrivateAcl $SettingsPath $false)').length - 1).toBe(2);
  expect(sourceLauncher.split('Assert-TaskBinding $runtime $SettingsPath').length - 1).toBe(1);
  const protectedResult = options.protectedManifest === false ? '$false' : '$true';
  const instrumentedLauncher = sourceLauncher
    .replace(
      userScopeReads[0],
      `$([IO.File]::AppendAllText((${psPath(tokenReadMarker)}), 'bot'); ${psString(botValue)})`,
    )
    .replace(
      userScopeReads[1],
      `$([IO.File]::AppendAllText((${psPath(tokenReadMarker)}), 'app'); ${psString(appValue)})`,
    )
    .replace(knownLocalAppDataRead, `(${psPath(knownLocalAppData)})`)
    .replaceAll('(Test-PrivateAcl $manifestParent $true)', protectedResult)
    .replaceAll('(Test-PrivateAcl $SettingsPath $false)', protectedResult)
    .replace(
      'Assert-TaskBinding $runtime $SettingsPath',
      options.taskBinding === false ? "throw 'task binding fixture'" : '$null = $true',
    );
  if (instrumentedLauncher.includes('[EnvironmentVariableTarget]::User')) {
    throw new Error('launcher fixture instrumentation failed');
  }
  if (instrumentedLauncher.includes(knownLocalAppDataRead)) {
    throw new Error('launcher known-folder instrumentation failed');
  }
  writeFileSync(join(windowsDirectory, 'launch-daemon.ps1'), instrumentedLauncher, 'utf8');
  writeFileSync(join(stagingRoot, 'package.json'), JSON.stringify({
    name: '@dev-infra/orca-slack-bridge',
    version: '1.2.3',
    type: 'module',
    files: ['dist', 'windows/launch-daemon.ps1'],
    bin: { 'orca-slack-bridge': './dist/cli.js' },
    dependencies: { 'fixture-dependency': '1.0.0' },
  }));
  writeFileSync(
    join(dependencyDirectory, 'package.json'),
    JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }),
  );
  const payloadA = join(dependencyDirectory, 'payload-a.txt');
  const payloadB = join(dependencyDirectory, 'payload-b.txt');
  const nestedPayload = join(nestedDirectory, 'payload.txt');
  for (const path of [payloadA, payloadB]) writeFileSync(path, 'same transitive bytes\n');
  writeFileSync(nestedPayload, 'nested transitive bytes\n');

  const cliSource = String.raw`
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
const expected = basename(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const sentinel = ${JSON.stringify(sentinel)};
writeFileSync(${JSON.stringify(daemonMarker)}, 'launched');
const tokensAreFresh = process.env.ORCA_SLACK_BRIDGE_BOT_TOKEN === ${JSON.stringify(syntheticBot)} &&
  process.env.ORCA_SLACK_BRIDGE_APP_TOKEN === ${JSON.stringify(syntheticApp)} &&
  process.env.ORCA_SLACK_BRIDGE_BOT_TOKEN !== sentinel &&
  process.env.ORCA_SLACK_BRIDGE_APP_TOKEN !== sentinel;
const argumentsAreExact = JSON.stringify(process.argv.slice(2)) === JSON.stringify([
  'daemon', '--config', process.argv[4], '--state', process.argv[6],
  '--orca', process.argv[8], '--log-dir', process.argv[10],
]);
if (!tokensAreFresh || process.env.ORCA_SLACK_BRIDGE_BUILD !== expected || !argumentsAreExact) {
  process.exit(41);
}
`;
  writeFileSync(join(distDirectory, 'cli.js'), cliSource);
  const digest = computeReleaseBuildDigest(stagingRoot);
  const releaseRoot = join(releasesRoot, digest);
  renameSync(stagingRoot, releaseRoot);

  const config = join(dataDirectory, 'bridge config.json');
  const state = join(dataDirectory, 'state.db');
  const orca = join(dataDirectory, 'orca fixture.exe');
  for (const path of [config, state, orca]) writeFileSync(path, 'fixture');
  const manifestPath = join(knownLocalAppData, 'OrcaSlackBridge', 'runtime.json');
  mkdirSync(join(knownLocalAppData, 'OrcaSlackBridge'), { recursive: true });
  const launcherPath = join(releaseRoot, 'windows', 'launch-daemon.ps1');
  const manifest = createWindowsRuntimeManifest({
    releaseRoot,
    releaseDigest: digest,
    nodeExe: process.execPath,
    distCli: join(releaseRoot, 'dist', 'cli.js'),
    launcherPath,
    launcherSha256: options.manifestMutation === 'launcher-hash'
      ? '0'.repeat(64)
      : createHash('sha256').update(readFileSync(launcherPath)).digest('hex'),
    taskSemanticFingerprint: 'f'.repeat(64),
    config,
    state,
    orcaExe: orca,
    logDirectory,
  });
  writeFileSync(
    manifestPath,
    options.manifestMutation === 'self-digest'
      ? Buffer.from(JSON.stringify({ ...manifest, manifestDigest: '0'.repeat(64) }) + '\n')
      : serializeWindowsRuntimeManifest(manifest),
  );

  const systemRoot = process.env['SystemRoot'];
  if (systemRoot === undefined || systemRoot.length === 0) throw new Error('SystemRoot absent');
  const powerShell = join(
    systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  return {
    parent,
    releaseRoot,
    dependencyDirectory: join(releaseRoot, 'node_modules', 'fixture-dependency'),
    payloadA: join(releaseRoot, 'node_modules', 'fixture-dependency', 'payload-a.txt'),
    payloadB: join(releaseRoot, 'node_modules', 'fixture-dependency', 'payload-b.txt'),
    nestedDirectory: join(releaseRoot, 'node_modules', 'fixture-dependency', 'nested'),
    nestedPayload: join(releaseRoot, 'node_modules', 'fixture-dependency', 'nested', 'payload.txt'),
    tokenReadMarker,
    daemonMarker,
    run: () => spawnSync(powerShell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', launcherPath, '-SettingsPath', manifestPath,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ORCA_SLACK_BRIDGE_BOT_TOKEN: sentinel,
        ORCA_SLACK_BRIDGE_APP_TOKEN: sentinel,
        ORCA_SLACK_BRIDGE_BUILD: sentinel,
      },
      timeout: 20_000,
      windowsHide: true,
    }),
  };
}

function expectStaticRejection(fixture: ReturnType<typeof createLauncherFixture>): void {
  const result = fixture.run();
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('windows.launcher.invalid_runtime_manifest');
  expect(existsSync(fixture.tokenReadMarker)).toBe(false);
  expect(existsSync(fixture.daemonMarker)).toBe(false);
  expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
}

describe('versioned Windows launcher', () => {
  it('strictly resolves and forwards the one exported LogonTrigger SID', () => {
    const source = launcherSource();
    expect(source).toContain("'xml', 'currentSid', 'resolvedTriggerUserSid'");
    expect(source).toContain('$triggerUsers.Count -ne 1');
    expect(source).toContain('}, undefined, input.resolvedTriggerUserSid)');
  });

  const driftCases = [
    ['transitive byte', (fixture: ReturnType<typeof createLauncherFixture>) => {
      writeFileSync(fixture.nestedPayload, 'drifted bytes\n');
    }],
    ['transitive path', (fixture: ReturnType<typeof createLauncherFixture>) => {
      renameSync(fixture.nestedPayload, join(fixture.nestedDirectory, 'renamed.txt'));
    }],
    ['tree', (fixture: ReturnType<typeof createLauncherFixture>) => {
      writeFileSync(join(fixture.dependencyDirectory, 'unexpected.txt'), 'extra tree entry\n');
    }],
    ['reparse', (fixture: ReturnType<typeof createLauncherFixture>) => {
      rmSync(fixture.nestedDirectory, { recursive: true, force: true });
      const target = join(fixture.parent, '외부 reparse target');
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'payload.txt'), 'nested transitive bytes\n');
      symlinkSync(target, fixture.nestedDirectory, 'junction');
    }],
    ['hardlink', (fixture: ReturnType<typeof createLauncherFixture>) => {
      rmSync(fixture.payloadB);
      linkSync(fixture.payloadA, fixture.payloadB);
    }],
  ] as const;

  for (const [kind, mutate] of driftCases) {
    windowsIt(`rejects ${kind} drift before either User-scope token read`, () => {
      const fixture = createLauncherFixture();
      mutate(fixture);
      expectStaticRejection(fixture);
    }, 30_000);
  }

  for (const [kind, options] of [
    ['unprotected manifest', { protectedManifest: false }],
    ['manifest self-digest drift', { manifestMutation: 'self-digest' }],
    ['launcher identity drift', { manifestMutation: 'launcher-hash' }],
    ['Scheduled Task binding drift', { taskBinding: false }],
  ] as const) {
    windowsIt(`rejects ${kind} before either User-scope token read`, () => {
      expectStaticRejection(createLauncherFixture(options));
    }, 30_000);
  }

  windowsIt('uses fresh resolver values and the verified manifest digest in the daemon child', () => {
    const source = launcherSource();
    expect(userScopeReads.reduce((count, expression) =>
      count + source.split(expression).length - 1, 0)).toBe(2);
    expect(source.split(knownLocalAppDataRead).length - 1).toBe(1);
    const fixture = createLauncherFixture();
    const result = fixture.run();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(readFileSync(fixture.tokenReadMarker, 'utf8')).toBe('botapp');
    expect(readFileSync(fixture.daemonMarker, 'utf8')).toBe('launched');
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
  }, 30_000);

  windowsIt('keeps absent User-scope tokens on a static non-secret failure path', () => {
    const fixture = createLauncherFixture({ botValue: '   ', appValue: syntheticApp });
    const result = fixture.run();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim()).toBe('windows.launcher.required_environment_absent');
    expect(readFileSync(fixture.tokenReadMarker, 'utf8')).toBe('botapp');
    expect(existsSync(fixture.daemonMarker)).toBe(false);
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
    expect(`${result.stdout}${result.stderr}`).not.toContain(syntheticApp);
  }, 30_000);

  windowsIt('rejects a matching digest outside the current User known-folder release root', () => {
    const fixture = createLauncherFixture({ canonicalRoot: false });
    expect(computeReleaseBuildDigest(fixture.releaseRoot)).toBe(basename(fixture.releaseRoot));
    expectStaticRejection(fixture);
  }, 30_000);
});
