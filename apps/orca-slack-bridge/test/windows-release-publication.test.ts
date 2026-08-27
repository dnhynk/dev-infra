import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireWindowsReleasePublicationMutex,
  assertWindowsReleaseFilesystemSemantics,
  type WindowsReleasePublicationMutex,
} from '../src/windows/release-publication.js';

const windowsIt = process.platform === 'win32' ? it : it.skip;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Windows release publication boundary', () => {
  windowsIt('serializes concurrent publishers with the protected current-user mutex', async () => {
    const first = await acquireWindowsReleasePublicationMutex();
    let second: WindowsReleasePublicationMutex | null = null;
    let secondEntered = false;
    const pending = acquireWindowsReleasePublicationMutex().then((lock) => {
      second = lock;
      secondEntered = true;
      return lock;
    });
    try {
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      expect(secondEntered).toBe(false);
      await first.release();
      await pending;
      expect(secondEntered).toBe(true);
    } finally {
      await first.release();
      if (second === null) second = await pending;
      await second.release();
    }
  }, 20_000);

  windowsIt('rejects reparse attributes, non-NFC paths, and OrdinalIgnoreCase collisions', () => {
    const parent = mkdtempSync(join(tmpdir(), 'Orca publication 실제 공백 '));
    temporaryRoots.push(parent);
    const release = join(parent, 'release 검증');
    const nested = join(release, 'node_modules', 'fixture');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'payload.txt'), 'regular bytes');
    expect(() => assertWindowsReleaseFilesystemSemantics(release)).not.toThrow();

    const decomposed = join(nested, 'e\u0301.txt');
    writeFileSync(decomposed, 'non-NFC');
    expect(() => assertWindowsReleaseFilesystemSemantics(release))
      .toThrow('windows.stage.invalid_windows_release_tree');
    rmSync(decomposed);

    const systemRoot = process.env['SystemRoot'];
    if (systemRoot === undefined) throw new Error('SystemRoot absent');
    const caseSensitive = join(release, 'case-sensitive');
    mkdirSync(caseSensitive);
    const fsutil = join(systemRoot, 'System32', 'fsutil.exe');
    const enabled = spawnSync(
      fsutil, ['file', 'setCaseSensitiveInfo', caseSensitive, 'enable'],
      { stdio: 'ignore', windowsHide: true },
    );
    if (enabled.status === 0) {
      const upper = join(caseSensitive, 'Case.txt');
      const lower = join(caseSensitive, 'case.txt');
      writeFileSync(upper, 'upper');
      writeFileSync(lower, 'lower');
      expect(() => assertWindowsReleaseFilesystemSemantics(release))
        .toThrow('windows.stage.invalid_windows_release_tree');
      rmSync(lower);
      const disabled = spawnSync(
        fsutil, ['file', 'setCaseSensitiveInfo', caseSensitive, 'disable'],
        { stdio: 'ignore', windowsHide: true },
      );
      expect(disabled.status).toBe(0);
    }

    const external = join(parent, 'external target');
    mkdirSync(external);
    symlinkSync(external, join(nested, 'junction'), 'junction');
    expect(() => assertWindowsReleaseFilesystemSemantics(release))
      .toThrow('windows.stage.invalid_windows_release_tree');
  }, 20_000);
});
