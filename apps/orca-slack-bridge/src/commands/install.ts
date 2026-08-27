import {
  prepareDeploymentState,
  validateWindowsDeployment,
  type PreparedDeploymentState,
  type ValidateWindowsDeploymentOptions,
  type ValidatedWindowsDeployment,
  type WindowsDeploymentPaths,
} from '../windows/deployment.js';
import { inspectOperationalStatus } from '../operational/status.js';
import {
  createWindowsTaskDefinition,
  CurrentUserTaskSchedulerPowerShellRunner,
  CurrentUserWindowsTaskScheduler,
  fingerprintWindowsTask,
  type ManagedWindowsTaskSnapshot,
  type WindowsTaskDefinition,
} from '../windows/task-scheduler.js';
import {
  createWindowsRuntimeManifest,
  CurrentUserWindowsRuntimeManifestStore,
  serializeWindowsRuntimeManifest,
  type WindowsRuntimeManifestStore,
  type WindowsRuntimeManifestSnapshot,
} from '../windows/runtime-manifest.js';
import {
  DEFAULT_WINDOWS_WAIT_SECONDS,
  runManagedTaskNow,
  validateWindowsWaitSeconds,
  type RunNowDependencies,
  type RunNowResult,
} from './run-now.js';

export type InstallCommandInput = WindowsDeploymentPaths & {
  readonly runNow: boolean;
  readonly waitSeconds?: number;
};

export type InstallCommandResult = {
  readonly task: 'created' | 'updated' | 'unchanged';
  readonly backupCreated: boolean;
  readonly runNow: RunNowResult['action'] | 'not-requested';
};

export type InstallCommandDependencies = {
  readonly platform?: NodeJS.Platform;
  readonly scheduler?: CurrentUserWindowsTaskScheduler;
  readonly manifestStore?: WindowsRuntimeManifestStore;
  readonly validateDeployment?: (
    paths: WindowsDeploymentPaths,
    options: ValidateWindowsDeploymentOptions,
  ) => Promise<ValidatedWindowsDeployment>;
  readonly prepareState?: (
    deployment: ValidatedWindowsDeployment,
  ) => Promise<PreparedDeploymentState>;
  readonly validateExistingState?: (deployment: ValidatedWindowsDeployment) => Promise<void>;
  readonly runNow?: RunNowDependencies;
};

function exactOwnedTask(
  snapshot: ManagedWindowsTaskSnapshot,
  expected: WindowsTaskDefinition,
  scheduler: CurrentUserWindowsTaskScheduler,
): boolean {
  return snapshot.kind === 'present' && snapshot.ownership === 'owned' &&
    snapshot.integrity === 'matched' && scheduler.definitionsMatch(snapshot.definition, expected);
}

async function verifyDesiredTask(
  scheduler: CurrentUserWindowsTaskScheduler,
  expected: WindowsTaskDefinition,
): Promise<boolean> {
  return exactOwnedTask(await scheduler.inspect(), expected, scheduler);
}

async function rollbackUpdatedTask(
  scheduler: CurrentUserWindowsTaskScheduler,
  before: Extract<ManagedWindowsTaskSnapshot, { readonly kind: 'present' }>,
  expected: WindowsTaskDefinition,
): Promise<void> {
  const current = await scheduler.inspect();
  if (current.kind === 'present' && current.xml === before.xml) return;
  if (current.kind !== 'present' || current.ownership !== 'owned' ||
      current.marker?.releaseDigest !== parseExpectedRelease(expected) ||
      current.marker.semanticFingerprint !== parseExpectedSemantic(expected)) {
    throw new Error('windows.install.rollback_collision');
  }
  if (current.xml !== before.xml) await scheduler.restore(before.xml, current.xml);
  const restored = await scheduler.inspect();
  if (restored.kind !== 'present' || restored.ownership !== 'owned' ||
      restored.marker?.releaseDigest !== before.marker?.releaseDigest ||
      restored.marker?.semanticFingerprint !== before.marker?.semanticFingerprint ||
      (before.definition !== null && !scheduler.definitionsMatch(restored.definition, before.definition))) {
    throw new Error('windows.install.rollback_verification_failed');
  }
}

function parseExpectedRelease(definition: WindowsTaskDefinition): string | null {
  const match = /;release=([a-f0-9]{64});semantic=/u.exec(definition.description);
  return match?.[1] ?? null;
}

function parseExpectedSemantic(definition: WindowsTaskDefinition): string | null {
  const match = /;semantic=([a-f0-9]{64})$/u.exec(definition.description);
  return match?.[1] ?? null;
}

async function rollbackCreatedTask(
  scheduler: CurrentUserWindowsTaskScheduler,
  expected: WindowsTaskDefinition,
): Promise<void> {
  const current = await scheduler.inspect();
  if (current.kind === 'absent') return;
  if (current.ownership !== 'owned' ||
      current.marker?.releaseDigest !== parseExpectedRelease(expected) ||
      current.marker.semanticFingerprint !== parseExpectedSemantic(expected)) {
    throw new Error('windows.install.rollback_collision');
  }
  await scheduler.unregister(current.xml);
  if ((await scheduler.inspect()).kind !== 'absent') {
    throw new Error('windows.install.rollback_verification_failed');
  }
}

function manifestBeforeBytes(snapshot: WindowsRuntimeManifestSnapshot): Buffer | null {
  return snapshot.kind === 'present' ? snapshot.bytes : null;
}

function exactManifest(
  snapshot: WindowsRuntimeManifestSnapshot,
  desired: Buffer,
): boolean {
  return snapshot.kind === 'present' && snapshot.protected && snapshot.manifest !== null &&
    snapshot.bytes.equals(desired);
}

async function mutateDeploymentWithRollback(
  scheduler: CurrentUserWindowsTaskScheduler,
  manifestStore: WindowsRuntimeManifestStore,
  manifestPath: string,
  manifestBefore: WindowsRuntimeManifestSnapshot,
  manifestDesired: Buffer,
  before: ManagedWindowsTaskSnapshot,
  expected: WindowsTaskDefinition,
): Promise<'created' | 'updated'> {
  let manifestWritten = false;
  try {
    await manifestStore.replace(manifestPath, manifestBeforeBytes(manifestBefore), manifestDesired);
    manifestWritten = true;
    await scheduler.register(expected, before.kind === 'present', before.kind === 'present' ? before.xml : undefined);
    if (!await verifyDesiredTask(scheduler, expected) ||
        !exactManifest(await manifestStore.inspect(manifestPath), manifestDesired)) {
      throw new Error('windows.install.post_verification_failed');
    }
    return before.kind === 'absent' ? 'created' : 'updated';
  } catch {
    let rollbackFailed = false;
    try {
      if (before.kind === 'absent') await rollbackCreatedTask(scheduler, expected);
      else await rollbackUpdatedTask(scheduler, before, expected);
    } catch { rollbackFailed = true; }
    if (manifestWritten) {
      try {
        await manifestStore.replace(
          manifestPath,
          manifestDesired,
          manifestBeforeBytes(manifestBefore),
        );
        const restored = await manifestStore.inspect(manifestPath);
        const original = manifestBeforeBytes(manifestBefore);
        if (original === null ? restored.kind !== 'absent' :
          restored.kind !== 'present' || !restored.bytes.equals(original)) rollbackFailed = true;
      } catch { rollbackFailed = true; }
    }
    if (rollbackFailed) throw new Error('windows.install.rollback_failed');
    throw new Error('windows.install.task_update_failed');
  }
}

async function validateExistingDeploymentState(deployment: ValidatedWindowsDeployment): Promise<void> {
  const report = await inspectOperationalStatus({
    configPath: deployment.paths.configPath,
    statePath: deployment.paths.statePath,
    logDir: deployment.paths.logDir,
    expectedBuildIdentity: deployment.buildDigest,
  });
  if (report.schema.state !== 'matched' ||
      (report.config.state !== 'matched' && report.config.state !== 'readable') ||
      (report.build.state !== 'matched' && report.build.state !== 'unverified')) {
    throw new Error('windows.install.existing_state_invalid');
  }
}

/** Current-user install/reconcile. Plain install never starts the task. */
export async function installWindowsTask(
  input: InstallCommandInput,
  dependencies: InstallCommandDependencies = {},
): Promise<InstallCommandResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('windows.install.unsupported_platform');
  const waitSeconds = validateWindowsWaitSeconds(input.waitSeconds ?? DEFAULT_WINDOWS_WAIT_SECONDS);
  const scheduler = dependencies.scheduler ?? new CurrentUserWindowsTaskScheduler(
    new CurrentUserTaskSchedulerPowerShellRunner(),
  );
  const manifestStore = dependencies.manifestStore ?? new CurrentUserWindowsRuntimeManifestStore();
  const deployment = await (dependencies.validateDeployment ?? validateWindowsDeployment)(input, {
    platform,
  });
  const before = await scheduler.inspect();
  const expected = createWindowsTaskDefinition({
    currentSid: before.currentSid,
    releaseDigest: deployment.buildDigest,
    powerShellPath: deployment.paths.powerShellPath,
    launcherPath: deployment.paths.launcherPath,
    runtimeManifestPath: deployment.paths.runtimeManifestPath,
    workingDirectory: deployment.paths.appRoot,
  });
  // COM TASK_VALIDATE_ONLY is deliberately the first state/task/manifest effect boundary.
  await scheduler.validate(expected);
  if (before.kind === 'present' && before.ownership !== 'owned') {
    throw new Error('windows.install.foreign_task_collision');
  }
  const desiredManifest = serializeWindowsRuntimeManifest(createWindowsRuntimeManifest({
    releaseRoot: deployment.paths.appRoot,
    releaseDigest: deployment.buildDigest,
    nodeExe: deployment.paths.nodePath,
    distCli: deployment.paths.cliPath,
    launcherPath: deployment.paths.launcherPath,
    launcherSha256: deployment.launcherSha256,
    taskSemanticFingerprint: fingerprintWindowsTask(expected),
    config: deployment.paths.configPath,
    state: deployment.paths.statePath,
    orcaExe: deployment.paths.orcaPath,
    logDirectory: deployment.paths.logDir,
  }));
  const beforeManifest = await manifestStore.inspect(deployment.paths.runtimeManifestPath);
  if (beforeManifest.kind === 'present' &&
      (!beforeManifest.protected || beforeManifest.manifest === null)) {
    throw new Error('windows.install.runtime_manifest_invalid');
  }

  let task: InstallCommandResult['task'] = 'unchanged';
  let backupCreated = false;
  if (exactOwnedTask(before, expected, scheduler)) {
    if (!exactManifest(beforeManifest, desiredManifest)) {
      throw new Error('windows.install.runtime_manifest_invalid');
    }
    await (dependencies.validateExistingState ?? validateExistingDeploymentState)(deployment);
  } else {
    let prepared: PreparedDeploymentState | null = null;
    try {
      prepared = await (dependencies.prepareState ?? ((value) => prepareDeploymentState(value, {
        platform,
      })))(deployment);
      backupCreated = prepared.backupPath !== null;
      task = await mutateDeploymentWithRollback(
        scheduler,
        manifestStore,
        deployment.paths.runtimeManifestPath,
        beforeManifest,
        desiredManifest,
        before,
        expected,
      );
    } finally {
      await prepared?.release();
    }
  }

  let runNow: InstallCommandResult['runNow'] = 'not-requested';
  if (input.runNow) {
    const outcome = await runManagedTaskNow(waitSeconds, {
      ...dependencies.runNow,
      platform,
      scheduler,
      manifestStore,
    });
    runNow = outcome.action;
  }
  return { task, backupCreated, runNow };
}
