import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('versioned Windows launcher', () => {
  windowsIt('uses fresh resolver values and the manifest digest in the actual daemon child', () => {
    const parent = mkdtempSync(join(tmpdir(), 'Orca launcher 실제 공백 '));
    temporaryRoots.push(parent);
    const digest = 'd'.repeat(64);
    const releaseRoot = join(parent, digest);
    const distDirectory = join(releaseRoot, 'dist');
    const windowsDirectory = join(releaseRoot, 'windows');
    const dataDirectory = join(parent, '사용자 데이터');
    const logDirectory = join(dataDirectory, '운영 로그');
    mkdirSync(distDirectory, { recursive: true });
    mkdirSync(windowsDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });

    const launcher = join(windowsDirectory, 'launch-daemon.ps1');
    const sourceLauncher = readFileSync(
      process.env['ORCA_WINDOWS_LAUNCHER_FIXTURE_SOURCE'] ??
        join(process.cwd(), 'windows', 'launch-daemon.ps1'),
      'utf8',
    );
    const userScopeReads = [
      '[Environment]::GetEnvironmentVariable($botTokenName, [EnvironmentVariableTarget]::User)',
      '[Environment]::GetEnvironmentVariable($appTokenName, [EnvironmentVariableTarget]::User)',
    ] as const;
    expect(userScopeReads.reduce((count, expression) =>
      count + sourceLauncher.split(expression).length - 1, 0)).toBe(2);
    const syntheticBot = 'SYNTHETIC_BOT_FIXTURE_VALUE';
    const syntheticApp = 'SYNTHETIC_APP_FIXTURE_VALUE';
    const instrumentedLauncher = sourceLauncher
      .replace(userScopeReads[0], `'${syntheticBot}'`)
      .replace(userScopeReads[1], `'${syntheticApp}'`);
    expect(instrumentedLauncher).not.toContain('[EnvironmentVariableTarget]::User');
    writeFileSync(launcher, instrumentedLauncher, 'utf8');
    const cli = join(distDirectory, 'cli.js');
    const sentinel = 'INHERITED_SENTINEL_DO_NOT_PRINT';
    writeFileSync(cli, String.raw`
const expected = ${JSON.stringify(digest)};
const sentinel = ${JSON.stringify(sentinel)};
const tokensAreFresh = process.env.ORCA_SLACK_BRIDGE_BOT_TOKEN === ${JSON.stringify(syntheticBot)} &&
  process.env.ORCA_SLACK_BRIDGE_APP_TOKEN === ${JSON.stringify(syntheticApp)} &&
  process.env.ORCA_SLACK_BRIDGE_BOT_TOKEN !== sentinel &&
  process.env.ORCA_SLACK_BRIDGE_APP_TOKEN !== sentinel;
const argumentsAreExact = JSON.stringify(process.argv.slice(2)) === JSON.stringify([
  'daemon', '--config', process.argv[4], '--state', process.argv[6],
  '--orca', process.argv[8], '--log-dir', process.argv[10],
]);
if (!tokensAreFresh || process.env.ORCA_SLACK_BRIDGE_BUILD !== expected || !argumentsAreExact) process.exit(41);
`);
    const config = join(dataDirectory, 'bridge config.json');
    const state = join(dataDirectory, 'state.db');
    const orca = join(dataDirectory, 'orca fixture.exe');
    for (const path of [config, state, orca]) writeFileSync(path, 'fixture');
    const manifestPath = join(parent, 'runtime settings.json');
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      releaseRoot,
      releaseDigest: digest,
      nodeExe: process.execPath,
      distCli: cli,
      config,
      state,
      orcaExe: orca,
      logDirectory,
    }) + '\n');

    const systemRoot = process.env['SystemRoot'];
    expect(systemRoot).toBeTruthy();
    const powerShell = join(
      systemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
    );
    const result = spawnSync(powerShell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', launcher, '-SettingsPath', manifestPath,
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
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);

    const missingLauncher = sourceLauncher
      .replace(userScopeReads[0], "'   '")
      .replace(userScopeReads[1], `'${syntheticApp}'`);
    expect(missingLauncher).not.toContain('[EnvironmentVariableTarget]::User');
    writeFileSync(launcher, missingLauncher, 'utf8');
    const missing = spawnSync(powerShell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', launcher, '-SettingsPath', manifestPath,
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
    });
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe('');
    expect(missing.stderr.trim()).toBe('windows.launcher.required_environment_absent');
    expect(`${missing.stdout}${missing.stderr}`).not.toContain(sentinel);
    expect(`${missing.stdout}${missing.stderr}`).not.toContain(syntheticApp);
  }, 30_000);
});
