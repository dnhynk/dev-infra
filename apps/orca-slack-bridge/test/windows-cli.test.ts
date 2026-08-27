import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';

afterEach(() => vi.restoreAllMocks());

const installArgv = [
  'install',
  '--app-root', String.raw`C:\release\v1`,
  '--node', String.raw`C:\runtime\node.exe`,
  '--orca', String.raw`C:\tools\orca.exe`,
  '--config', String.raw`C:\data\config.json`,
  '--state', String.raw`C:\data\state.db`,
  '--log-dir', String.raw`C:\data\logs`,
] as const;

describe('Windows lifecycle CLI redaction', () => {
  it('never prints dependency errors, token sentinels, or lifecycle path arguments', async () => {
    const sentinel = 'xoxb-TOKEN_SENTINEL-super-secret';
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    expect(await main(installArgv, {
      install: {
        platform: 'win32',
        validateDeployment: async () => { throw new Error(sentinel + String.raw` C:\private\state.db`); },
      },
    })).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toBe('windows.install.failed\n');
    expect(stderr).not.toContain(sentinel);
    for (const value of installArgv.filter((token) => token.startsWith('C:\\'))) {
      expect(stderr).not.toContain(value);
    }
  });

  it('returns static clear non-Windows errors for each lifecycle command', async () => {
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
    expect(await main(installArgv, { install: { platform: 'linux' } })).toBe(1);
    expect(await main(['uninstall'], { uninstall: { platform: 'linux' } })).toBe(1);
    expect(await main(['run-now'], { runNow: { platform: 'linux' } })).toBe(1);
    expect(stderr).toBe(
      'windows.install.unsupported_platform\n' +
      'windows.uninstall.unsupported_platform\n' +
      'windows.run_now.unsupported_platform\n',
    );
  });
});
