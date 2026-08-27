import {
  prepareDeploymentState,
  validateWindowsDeployment,
  type PreparedDeploymentState,
  type ValidateWindowsDeploymentOptions,
  type ValidatedWindowsDeployment,
  type WindowsDeploymentPaths,
} from '../windows/deployment.js';
import {
  createWindowsTaskDefinition,
  CurrentUserTaskSchedulerPowerShellRunner,
  CurrentUserWindowsTaskScheduler,
  type ManagedWindowsTaskSnapshot,
  type WindowsTaskDefinition,
} from '../windows/task-scheduler.js';
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
  readonly env?: NodeJS.ProcessEnv;
  readonly scheduler?: CurrentUserWindowsTaskScheduler;
  readonly validateDeployment?: (
    paths: WindowsDeploymentPaths,
    options: ValidateWindowsDeploymentOptions,
  ) => Promise<ValidatedWindowsDeployment>;
  readonly prepareState?: (
    deployment: ValidatedWindowsDeployment,
  ) => Promise<PreparedDeploymentState>;
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
): Promise<void> {
  const current = await scheduler.inspect();
  if (current.kind !== 'present' || current.ownership !== 'owned') {
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

async function rollbackCreatedTask(scheduler: CurrentUserWindowsTaskScheduler): Promise<void> {
  const current = await scheduler.inspect();
  if (current.kind === 'absent') return;
  if (current.ownership !== 'owned') throw new Error('windows.install.rollback_collision');
  await scheduler.unregister(current.xml);
  if ((await scheduler.inspect()).kind !== 'absent') {
    throw new Error('windows.install.rollback_verification_failed');
  }
}

async function mutateTaskWithRollback(
  scheduler: CurrentUserWindowsTaskScheduler,
  before: ManagedWindowsTaskSnapshot,
  expected: WindowsTaskDefinition,
): Promise<'created' | 'updated'> {
  try {
    await scheduler.register(expected, before.kind === 'present', before.kind === 'present' ? before.xml : undefined);
    if (!await verifyDesiredTask(scheduler, expected)) {
      throw new Error('windows.install.post_verification_failed');
    }
    return before.kind === 'absent' ? 'created' : 'updated';
  } catch {
    try {
      if (before.kind === 'absent') await rollbackCreatedTask(scheduler);
      else await rollbackUpdatedTask(scheduler, before);
    } catch {
      throw new Error('windows.install.rollback_failed');
    }
    throw new Error('windows.install.task_update_failed');
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
  const deployment = await (dependencies.validateDeployment ?? validateWindowsDeployment)(input, {
    platform,
    env: dependencies.env ?? process.env,
  });
  const before = await scheduler.inspect();
  const expected = createWindowsTaskDefinition({
    currentSid: before.currentSid,
    releaseDigest: deployment.buildDigest,
    nodePath: deployment.paths.nodePath,
    cliPath: deployment.paths.cliPath,
    configPath: deployment.paths.configPath,
    statePath: deployment.paths.statePath,
    orcaPath: deployment.paths.orcaPath,
    logDir: deployment.paths.logDir,
    workingDirectory: deployment.paths.appRoot,
  });
  if (before.kind === 'present' && before.ownership !== 'owned') {
    throw new Error('windows.install.foreign_task_collision');
  }

  let task: InstallCommandResult['task'] = 'unchanged';
  let backupCreated = false;
  if (!exactOwnedTask(before, expected, scheduler)) {
    let prepared: PreparedDeploymentState | null = null;
    try {
      prepared = await (dependencies.prepareState ?? ((value) => prepareDeploymentState(value, {
        platform,
      })))(deployment);
      backupCreated = prepared.backupPath !== null;
      task = await mutateTaskWithRollback(scheduler, before, expected);
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
    });
    runNow = outcome.action;
  }
  return { task, backupCreated, runNow };
}
