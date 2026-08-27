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
