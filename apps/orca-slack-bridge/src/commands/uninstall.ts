import { createConnection } from 'node:net';
import { CHANNEL_PIPE_PATH } from '../channel/pipe-server.js';
import {
  inspectOperationalStatus,
  type OperationalStatusReport,
} from '../operational/status.js';
import { setDeploymentDesiredStopped, verifyCanonicalWindowsRelease } from '../windows/deployment.js';
import {
  CurrentUserTaskSchedulerPowerShellRunner,
  CurrentUserWindowsTaskScheduler,
  type ManagedWindowsTaskSnapshot,
} from '../windows/task-scheduler.js';
import {
  DEFAULT_WINDOWS_WAIT_SECONDS,
  extractManagedTaskLaunch,
  managedTaskStatusObservation,
  validateWindowsWaitSeconds,
  type ManagedTaskLaunch,
} from './run-now.js';
import {
  CurrentUserWindowsRuntimeManifestStore,
  type WindowsRuntimeManifestStore,
} from '../windows/runtime-manifest.js';

export type UninstallShutdownObservation = {
  readonly scheduler: ManagedWindowsTaskSnapshot;
  readonly report: OperationalStatusReport;
  readonly pipeReleased: boolean;
};

export type UninstallCommandDependencies = {
  readonly platform?: NodeJS.Platform;
  readonly scheduler?: CurrentUserWindowsTaskScheduler;
  readonly setDesiredStopped?: (
    statePath: string,
    expectedBuildIdentity: string,
  ) => void | Promise<void>;
  readonly inspectShutdown?: (launch: ManagedTaskLaunch) => Promise<UninstallShutdownObservation>;
  readonly probePipeReleased?: () => Promise<boolean>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly nowMilliseconds?: () => number;
  readonly pollMilliseconds?: number;
  readonly force?: boolean;
  readonly onForceWarning?: () => void;
  readonly manifestStore?: WindowsRuntimeManifestStore;
  readonly verifyRelease?: (launch: ManagedTaskLaunch) => boolean | Promise<boolean>;
};

export type UninstallCommandResult = { readonly task: 'absent' | 'removed' };

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

/** A successful connection means the daemon still owns the fixed pipe; no protocol bytes are sent. */
export async function channelPipeIsReleased(timeoutMilliseconds = 100): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection(CHANNEL_PIPE_PATH);
    let settled = false;
    const finish = (released: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(released);
    };
    const timer = setTimeout(() => finish(false), timeoutMilliseconds);
    timer.unref?.();
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(error.code === 'ENOENT' || error.code === 'ECONNREFUSED');
    });
  });
}

function defaultShutdownInspector(
  scheduler: CurrentUserWindowsTaskScheduler,
  pipeProbe: () => Promise<boolean>,
): (launch: ManagedTaskLaunch) => Promise<UninstallShutdownObservation> {
  return async (launch) => {
    const task = await scheduler.inspect();
    const [report, pipeReleased] = await Promise.all([
      inspectOperationalStatus({
        configPath: launch.configPath,
        statePath: launch.statePath,
        logDir: launch.logDir,
        expectedBuildIdentity: launch.releaseDigest,
        taskFacet: () => managedTaskStatusObservation(task),
      }),
      pipeProbe(),
    ]);
    return { scheduler: task, report, pipeReleased };
  };
}

function exactSameOwnedTask(
  snapshot: ManagedWindowsTaskSnapshot,
  releaseDigest: string,
  semanticFingerprint: string,
): snapshot is Extract<ManagedWindowsTaskSnapshot, { readonly kind: 'present' }> {
  return snapshot.kind === 'present' && snapshot.ownership === 'owned' &&
    snapshot.integrity === 'matched' && snapshot.marker?.releaseDigest === releaseDigest &&
    snapshot.marker.semanticFingerprint === semanticFingerprint;
}

function shutdownComplete(observation: UninstallShutdownObservation): boolean {
  const task = observation.scheduler;
  const daemon = observation.report.daemon;
  const taskReady = task.kind === 'present' && task.runtime.executionState !== 'running' &&
    task.runtime.executionState !== 'queued';
  const cleanHealth = (daemon.state === 'stopped' && daemon.desiredState === 'stopped') ||
    daemon.state === 'absent';
  return taskReady && cleanHealth && observation.pipeReleased;
}

/** Disable -> durable stop intent -> bounded clean-stop/pipe/Ready wait -> unregister. */
export async function uninstallWindowsTask(
  waitSeconds = DEFAULT_WINDOWS_WAIT_SECONDS,
  dependencies: UninstallCommandDependencies = {},
): Promise<UninstallCommandResult> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') throw new Error('windows.uninstall.unsupported_platform');
  validateWindowsWaitSeconds(waitSeconds);
  const scheduler = dependencies.scheduler ?? new CurrentUserWindowsTaskScheduler(
    new CurrentUserTaskSchedulerPowerShellRunner(),
  );
  const initial = await scheduler.inspect();
  if (initial.kind === 'absent') return { task: 'absent' };
  if (initial.ownership !== 'owned' || initial.integrity !== 'matched' || initial.marker === null) {
    throw new Error('windows.uninstall.task_not_owned');
  }
  const launch = await extractManagedTaskLaunch(
    initial,
    dependencies.manifestStore ?? new CurrentUserWindowsRuntimeManifestStore(),
  );
  if (!await (dependencies.verifyRelease ?? ((value) =>
    verifyCanonicalWindowsRelease(value.appRoot, value.releaseDigest)))(launch)) {
    throw new Error('windows.uninstall.release_drift');
  }
  const releaseDigest = initial.marker.releaseDigest;
  const semanticFingerprint = initial.marker.semanticFingerprint;
  await scheduler.disable(initial.xml);
  const disabled = await scheduler.inspect();
  if (!exactSameOwnedTask(disabled, releaseDigest, semanticFingerprint) || disabled.runtime.enabled) {
    throw new Error('windows.uninstall.disable_verification_failed');
  }
  await (dependencies.setDesiredStopped ?? setDeploymentDesiredStopped)(
    launch.statePath,
    launch.releaseDigest,
  );

  const pipeProbe = dependencies.probePipeReleased ?? channelPipeIsReleased;
  const inspectShutdown = dependencies.inspectShutdown ?? defaultShutdownInspector(scheduler, pipeProbe);
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.nowMilliseconds ?? (() => performance.now());
  const pollMilliseconds = dependencies.pollMilliseconds ?? 1_000;
  if (!Number.isFinite(pollMilliseconds) || pollMilliseconds < 10 || pollMilliseconds > 5_000) {
    throw new Error('windows.uninstall.invalid_poll');
  }
  let previousNow = now();
  if (!Number.isFinite(previousNow)) throw new Error('windows.uninstall.clock_invalid');
  const monotonicNow = (): number => {
    const value = now();
    if (!Number.isFinite(value) || value < previousNow) throw new Error('windows.uninstall.clock_invalid');
    previousNow = value;
    return value;
  };
  const deadline = previousNow + waitSeconds * 1_000;
  while (monotonicNow() <= deadline) {
    const observation = await inspectShutdown(launch);
    if (!exactSameOwnedTask(observation.scheduler, releaseDigest, semanticFingerprint)) {
      throw new Error('windows.uninstall.task_drift');
    }
    if (shutdownComplete(observation)) {
      if (observation.scheduler.kind !== 'present') throw new Error('windows.uninstall.task_drift');
      await scheduler.unregister(observation.scheduler.xml);
      if ((await scheduler.inspect()).kind !== 'absent') {
        throw new Error('windows.uninstall.unregister_verification_failed');
      }
      return { task: 'removed' };
    }
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMilliseconds, remaining));
  }
  if (dependencies.force !== true) {
    // Default timeout deliberately preserves the disabled registered task and every deployment/data path.
    throw new Error('windows.uninstall.clean_stop_timeout');
  }

  (dependencies.onForceWarning ?? (() => {
    process.stderr.write('windows.uninstall.force_warning\n');
  }))();
  const forceTarget = await scheduler.inspect();
  if (!exactSameOwnedTask(forceTarget, releaseDigest, semanticFingerprint)) {
    throw new Error('windows.uninstall.task_drift');
  }
  await scheduler.stop(forceTarget.xml);
  const forceDeadline = monotonicNow() + waitSeconds * 1_000;
  while (monotonicNow() <= forceDeadline) {
    const [task, pipeReleased] = await Promise.all([scheduler.inspect(), pipeProbe()]);
    if (!exactSameOwnedTask(task, releaseDigest, semanticFingerprint)) {
      throw new Error('windows.uninstall.task_drift');
    }
    if (task.runtime.executionState !== 'running' && task.runtime.executionState !== 'queued' &&
        pipeReleased) {
      const unregisterTarget = await scheduler.inspect();
      if (!exactSameOwnedTask(unregisterTarget, releaseDigest, semanticFingerprint)) {
        throw new Error('windows.uninstall.task_drift');
      }
      await scheduler.unregister(unregisterTarget.xml);
      if ((await scheduler.inspect()).kind !== 'absent') {
        throw new Error('windows.uninstall.unregister_verification_failed');
      }
      return { task: 'removed' };
    }
    const remaining = forceDeadline - monotonicNow();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMilliseconds, remaining));
  }
  throw new Error('windows.uninstall.force_stop_timeout');
}
