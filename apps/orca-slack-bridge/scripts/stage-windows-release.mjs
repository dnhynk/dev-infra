import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(packageRoot, '..', '..');
const packageName = '@dev-infra/orca-slack-bridge';
const tokenNames = [
  'ORCA_SLACK_BRIDGE_BOT_TOKEN',
  'ORCA_SLACK_BRIDGE_APP_TOKEN',
];

/**
 * 오래된 릴리스를 지운다.
 *
 * ## 왜 staging이 이것을 하는가
 *
 * 릴리스를 만드는 쪽이 쓰레기를 만든다. 실측에서 하루에 21개가 쌓여 root 아래 파일이
 * 125,229개가 됐고, 그 시점에 배포가 통째로 막혔다 — manifest 쓰기가 root에 상속 ACL을
 * 적용하는데 그 전파가 10초 제한을 넘겼기 때문이다. ACL 쪽은 따로 고쳤지만, 쌓이는 것 자체를
 * 멈추지 않으면 다음 한계에서 같은 종류의 일이 다시 난다.
 *
 * ## 절대 지우지 않는 것
 *
 * - `runtime.json`이 가리키는 릴리스. 지금 배포된 것이다.
 * - 방금 만든 릴리스.
 * - 프로세스가 실행 중인 릴리스. daemon과 세션별 channel adapter가 여기 해당한다. 실행 중인
 *   트리를 지우면 그 프로세스가 다음에 파일을 읽을 때 죽는다.
 * - 그 밖에 최근 `KEEP_RECENT`개. 되돌릴 자리를 남긴다.
 *
 * 판정에 실패하면 아무것도 지우지 않는다. 정리는 배포의 부수 작업이고, 확신이 없을 때 지우는
 * 것보다 남기는 쪽이 싸다.
 */
const KEEP_RECENT = 3;

/**
 * 실행 중인 프로세스가 참조하는 릴리스 digest. 읽지 못하면 null이다.
 *
 * PowerShell은 command line만 내보내고 매칭은 여기서 한다. 정규식을 PowerShell 인자로 넘기면
 * shell·PowerShell·정규식 세 층의 이스케이프를 통과해야 하고, 한 층만 어긋나도 조용히 빈
 * 결과가 나온다. 빈 결과는 "실행 중인 것이 없다"로 읽혀 살아 있는 릴리스를 지우게 된다.
 */
function runningReleaseDigests() {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.error !== undefined || result.status !== 0) return null;
  const digests = new Set();
  const pattern = /releases[\\/]([0-9a-f]{64})/gi;
  for (const match of result.stdout.matchAll(pattern)) {
    const digest = match[1];
    if (digest !== undefined) digests.add(digest.toLowerCase());
  }
  return digests;
}

/** `runtime.json`이 가리키는 릴리스. 파일이 없거나 읽지 못하면 null이다. */
function deployedReleaseDigest(localAppData) {
  const manifestPath = join(localAppData, 'OrcaSlackBridge', 'runtime.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const digest = manifest?.releaseDigest;
    return typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

function pruneReleases(releasesRoot, localAppData, keepDigest) {
  const running = runningReleaseDigests();
  // 실행 중인 것을 판정하지 못하면 지우지 않는다. 살아 있는 트리를 지우는 것보다 남기는 것이 싸다.
  if (running === null) {
    process.stdout.write('stage prune=skipped reason=process_scan_failed\n');
    return;
  }
  const keep = new Set([keepDigest.toLowerCase(), ...running]);
  const deployed = deployedReleaseDigest(localAppData);
  if (deployed !== null) keep.add(deployed);

  let entries;
  try {
    entries = readdirSync(releasesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{64}$/.test(entry.name))
      .map((entry) => {
        const path = join(releasesRoot, entry.name);
        return { name: entry.name.toLowerCase(), path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    process.stdout.write('stage prune=skipped reason=listing_failed\n');
    return;
  }

  // 최근 것부터 KEEP_RECENT개를 되돌릴 자리로 남긴다. 이미 keep에 있는 것은 그 수에 넣지 않는다.
  let headroom = KEEP_RECENT;
  const removable = [];
  for (const entry of entries) {
    if (keep.has(entry.name)) continue;
    if (headroom > 0) { headroom -= 1; continue; }
    removable.push(entry);
  }

  let removed = 0;
  let failed = 0;
  for (const entry of removable) {
    try {
      rmSync(entry.path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // 파일이 잠겨 있으면 그 릴리스를 쓰는 프로세스가 아직 있다는 뜻이다. 다음 배포가 다시 시도한다.
      failed += 1;
    }
  }
  process.stdout.write(
    `stage prune=done removed=${removed} kept=${entries.length - removed} failed=${failed}\n`,
  );
}

function removeInside(root, target) {
  const child = relative(root, target);
  if (child === '' || child === '..' || child.startsWith(`..${win32.sep}`) || win32.isAbsolute(child)) {
    throw new Error('windows.stage.path_escape');
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}

function assertRegularTree(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw new Error('windows.stage.reparse_point');
      if (stats.isDirectory()) visit(path);
      else if (!stats.isFile()) throw new Error('windows.stage.invalid_entry');
    }
  };
  visit(root);
}

function makeFilesReadOnly(root) {
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else chmodSync(path, 0o444);
    }
  };
  visit(root);
}

function normalizePnpmWindowsShims(root) {
  const binDirectory = join(root, 'node_modules', '.bin');
  if (!existsSync(binDirectory)) return;
  const expectedTargetPrefix = `${root.replaceAll('\\', '/')}/`.toLowerCase();
  for (const entry of readdirSync(binDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || extname(entry.name) !== '') continue;
    const path = join(binDirectory, entry.name);
    const source = readFileSync(path, 'utf8');
    const marker = '\n# cmd-shim-target=';
    const markerIndex = source.lastIndexOf(marker);
    if (markerIndex < 0) continue;
    const trailing = source.slice(markerIndex + marker.length);
    if (!/^[^\r\n]+\r?\n?$/u.test(trailing) ||
        !trailing.replace(/\r?\n$/u, '').toLowerCase().startsWith(expectedTargetPrefix)) {
      throw new Error('windows.stage.invalid_shim_target');
    }
    if (source.indexOf(marker) !== markerIndex) throw new Error('windows.stage.invalid_shim_target');
    // pnpm appends only this nonfunctional absolute-path comment; retain the executable shim bytes.
    writeFileSync(path, source.slice(0, markerIndex + 1), 'utf8');
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('windows.stage.unsupported_platform');
  if (process.argv.length !== 2) throw new Error('windows.stage.invalid_arguments');
  const pnpmCli = process.env.npm_execpath;
  if (pnpmCli === undefined || !existsSync(pnpmCli)) throw new Error('windows.stage.pnpm_unavailable');
  const [{ computeReleaseBuildDigest, normalizeWindowsReleaseTextFiles },
    { operationalStatusWindowsKnownLocalAppData },
    { acquireWindowsReleasePublicationMutex, assertWindowsReleaseFilesystemSemantics }] = await Promise.all([
    import('../dist/windows/deployment.js'),
    import('../dist/operational/status-capability.js'),
    import('../dist/windows/release-publication.js'),
  ]);
  const localAppData = operationalStatusWindowsKnownLocalAppData();
  const releasesRoot = join(localAppData, 'OrcaSlackBridge', 'releases');
  mkdirSync(releasesRoot, { recursive: true });
  if (realpathSync.native(releasesRoot).toLowerCase() !== releasesRoot.toLowerCase()) {
    throw new Error('windows.stage.releases_root_reparse_point');
  }
  const stagingRoot = join(releasesRoot, '.stage');
  mkdirSync(stagingRoot, { recursive: true });
  if (realpathSync.native(stagingRoot).toLowerCase() !== stagingRoot.toLowerCase()) {
    throw new Error('windows.stage.staging_root_reparse_point');
  }
  const releasePublicationMutex = await acquireWindowsReleasePublicationMutex();
  // Keep the supported workflow honest about the Windows paths operators actually use.
  const temporary = join(stagingRoot, `검증 staging ${process.pid}-${randomUUID()}`);
  const childEnvironment = { ...process.env };
  for (const name of tokenNames) delete childEnvironment[name];
  try {
    const pnpmIsExecutable = extname(pnpmCli).toLowerCase() === '.exe';
    const deployed = spawnSync(pnpmIsExecutable ? pnpmCli : process.execPath, [
      ...(pnpmIsExecutable ? [] : [pnpmCli]),
      '--config.node-linker=hoisted',
      '--filter', packageName,
      'deploy', '--prod', temporary,
    ], {
      cwd: workspaceRoot,
      env: childEnvironment,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (deployed.error !== undefined || deployed.status !== 0) {
      throw new Error('windows.stage.deploy_failed');
    }
    for (const metadata of [
      join(temporary, 'pnpm-lock.yaml'),
      join(temporary, 'pnpm-workspace.yaml'),
      join(temporary, 'node_modules', '.modules.yaml'),
      join(temporary, 'node_modules', '.pnpm'),
      join(temporary, 'node_modules', '.pnpm-workspace-state-v1.json'),
    ]) removeInside(temporary, metadata);
    normalizePnpmWindowsShims(temporary);
    const expectedTopLevel = ['dist', 'node_modules', 'package.json', 'windows'];
    const actualTopLevel = readdirSync(temporary).sort();
    if (JSON.stringify(actualTopLevel) !== JSON.stringify(expectedTopLevel)) {
      throw new Error('windows.stage.unexpected_output');
    }
    assertRegularTree(temporary);
    assertWindowsReleaseFilesystemSemantics(temporary);
    normalizeWindowsReleaseTextFiles(temporary);
    assertWindowsReleaseFilesystemSemantics(temporary);
    const digest = computeReleaseBuildDigest(temporary);
    const destination = join(releasesRoot, digest);
    if (existsSync(destination)) {
      assertWindowsReleaseFilesystemSemantics(destination);
      if (computeReleaseBuildDigest(destination) !== digest) {
        throw new Error('windows.stage.existing_release_drift');
      }
      makeFilesReadOnly(destination);
      assertWindowsReleaseFilesystemSemantics(destination);
      if (computeReleaseBuildDigest(destination) !== digest) {
        throw new Error('windows.stage.existing_release_drift');
      }
      removeInside(releasesRoot, temporary);
      process.stdout.write(`stage digest=${digest} release=${destination} status=unchanged\n`);
      pruneReleases(releasesRoot, localAppData, digest);
      return;
    }
    renameSync(temporary, destination);
    assertWindowsReleaseFilesystemSemantics(destination);
    makeFilesReadOnly(destination);
    assertWindowsReleaseFilesystemSemantics(destination);
    if (computeReleaseBuildDigest(destination) !== digest) {
      throw new Error('windows.stage.post_verification_failed');
    }
    process.stdout.write(`stage digest=${digest} release=${destination} status=created\n`);
    // 릴리스를 만든 뒤에 정리한다. 실패해도 staging 결과를 되돌리지 않는다 — 정리는 부수 작업이다.
    pruneReleases(releasesRoot, localAppData, digest);
  } catch (error) {
    if (existsSync(temporary)) removeInside(releasesRoot, temporary);
    throw error;
  } finally {
    await releasePublicationMutex.release();
  }
}

try {
  await main();
} catch {
  process.stderr.write('windows.stage.failed\n');
  process.exitCode = 1;
}
