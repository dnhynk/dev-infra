import { win32 } from 'node:path';
import { verifyCanonicalWindowsRelease } from '../windows/deployment.js';
import {
  inspectOperationalStatus,
  type OperationalStatusReport,
  type TaskStatusObservation,
} from '../operational/status.js';
import {
  CurrentUserTaskSchedulerPowerShellRunner,
  CurrentUserWindowsTaskScheduler,
  parseWindowsArguments,
  type ManagedWindowsTaskSnapshot,
  type WindowsTaskDefinition,
} from '../windows/task-scheduler.js';
import {
  CurrentUserWindowsRuntimeManifestStore,
  readValidatedWindowsRuntimeManifest,
  windowsReleaseLauncherPath,
  type WindowsRuntimeManifestStore,
} from '../windows/runtime-manifest.js';

export const DEFAULT_WINDOWS_WAIT_SECONDS = 90;
export const MIN_WINDOWS_WAIT_SECONDS = 1;
export const MAX_WINDOWS_WAIT_SECONDS = 300;

export type ManagedTaskLaunch = {
  readonly nodePath: string;
  readonly cliPath: string;
  readonly appRoot: string;
  readonly launcherPath: string;
  readonly runtimeManifestPath: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly orcaPath: string;
  readonly logDir: string;
  readonly releaseDigest: string;
};

export type ManagedTaskLaunchAuthority = {
  readonly launch: ManagedTaskLaunch;
  readonly manifestBytes: Buffer;
};

export type ReleaseHealthObservation = {
  readonly scheduler: ManagedWindowsTaskSnapshot;
  readonly report: OperationalStatusReport;
};

export type RunNowDependencies = {
  readonly platform?: NodeJS.Platform;
  readonly scheduler?: CurrentUserWindowsTaskScheduler;
  readonly inspectHealth?: (launch: ManagedTaskLaunch) => Promise<ReleaseHealthObservation>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly nowMilliseconds?: () => number;
  readonly pollMilliseconds?: number;
  readonly verifyRelease?: (launch: ManagedTaskLaunch) => boolean | Promise<boolean>;
  readonly manifestStore?: WindowsRuntimeManifestStore;
};

export type RunNowResult = { readonly action: 'already-healthy' | 'started' };

export function validateWindowsWaitSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < MIN_WINDOWS_WAIT_SECONDS || value > MAX_WINDOWS_WAIT_SECONDS) {
    throw new Error('windows.lifecycle.invalid_wait');
  }
  return value;
}

export function managedTaskStatusObservation(snapshot: ManagedWindowsTaskSnapshot): TaskStatusObservation {
  if (snapshot.kind === 'absent') return {
    ownership: 'absent', state: 'stopped', schedulerState: 'absent', hasRun: false,
    lastTaskResult: null,
  };
  return {
    ownership: snapshot.ownership === 'owned' && snapshot.integrity === 'matched'
      ? 'matched'
      : 'drifted',
    state: snapshot.runtime.state === 'running' ? 'running' : 'stopped',
    schedulerState: snapshot.runtime.state,
    hasRun: snapshot.runtime.hasRun,
    lastTaskResult: snapshot.runtime.lastTaskResult,
    observedAt: snapshot.runtime.observedAt,
    lastRunTime: snapshot.runtime.lastRunTime,
    nextRunTime: snapshot.runtime.nextRunTime,
    missedRuns: snapshot.runtime.missedRuns,
    restartCount: snapshot.runtime.restartCount,
    restartIntervalSeconds: snapshot.runtime.restartIntervalSeconds,
  };
}

function managedTaskReference(
  snapshot: ManagedWindowsTaskSnapshot,
): {
  readonly appRoot: string;
  readonly launcherPath: string;
  readonly runtimeManifestPath: string;
  readonly releaseDigest: string;
  readonly semanticFingerprint: string;
} {
  if (snapshot.kind !== 'present' || snapshot.ownership !== 'owned' ||
      snapshot.integrity !== 'matched' || snapshot.definition === null || snapshot.marker === null) {
    throw new Error('windows.run_now.task_not_owned');
  }
  const values = parseWindowsArguments(snapshot.definition.action.arguments);
  if (values === null || values.length !== 9 || values[0] !== '-NoLogo' ||
      values[1] !== '-NoProfile' || values[2] !== '-NonInteractive' ||
      values[3] !== '-ExecutionPolicy' || values[4] !== 'Bypass' ||
      values[5] !== '-File' || values[7] !== '-SettingsPath') {
    throw new Error('windows.run_now.action_drift');
  }
  const launcherPath = values[6]!;
  const runtimeManifestPath = values[8]!;
  const appRoot = snapshot.definition.action.workingDirectory;
  if (![snapshot.definition.action.execute, appRoot, launcherPath, runtimeManifestPath]
    .every((value) => win32.isAbsolute(value)) ||
      launcherPath.toLowerCase() !== windowsReleaseLauncherPath(appRoot).toLowerCase()) {
    throw new Error('windows.run_now.action_drift');
  }
  return {
    appRoot, launcherPath, runtimeManifestPath,
    releaseDigest: snapshot.marker.releaseDigest,
    semanticFingerprint: snapshot.marker.semanticFingerprint,
  };
}

export async function extractManagedTaskLaunch(
  snapshot: ManagedWindowsTaskSnapshot,
  store: WindowsRuntimeManifestStore = new CurrentUserWindowsRuntimeManifestStore(),
): Promise<ManagedTaskLaunch> {
  return (await extractManagedTaskLaunchAuthority(snapshot, store)).launch;
}

export async function extractManagedTaskLaunchAuthority(
  snapshot: ManagedWindowsTaskSnapshot,
  store: WindowsRuntimeManifestStore = new CurrentUserWindowsRuntimeManifestStore(),
): Promise<ManagedTaskLaunchAuthority> {
  const reference = managedTaskReference(snapshot);
  const { manifest, bytes } = await readValidatedWindowsRuntimeManifest(
    store,
    reference.runtimeManifestPath,
  );
  if (manifest.releaseDigest !== reference.releaseDigest ||
      manifest.releaseRoot.toLowerCase() !== reference.appRoot.toLowerCase() ||
      manifest.launcherPath.toLowerCase() !== reference.launcherPath.toLowerCase() ||
      manifest.taskSemanticFingerprint !== reference.semanticFingerprint) {
    throw new Error('windows.run_now.runtime_manifest_drift');
  }
  return {
    launch: {
      nodePath: manifest.nodeExe,
      cliPath: manifest.distCli,
      appRoot: manifest.releaseRoot,
      launcherPath: reference.launcherPath,
      runtimeManifestPath: reference.runtimeManifestPath,
      configPath: manifest.config,
      statePath: manifest.state,
      orcaPath: manifest.orcaExe,
      logDir: manifest.logDirectory,
      releaseDigest: manifest.releaseDigest,
    },
    manifestBytes: Buffer.from(bytes),
  };
}

function healthyExactRelease(observation: ReleaseHealthObservation, releaseDigest: string): boolean {
  const task = observation.scheduler;
  const report = observation.report;
  return task.kind === 'present' && task.ownership === 'owned' && task.integrity === 'matched' &&
    task.marker?.releaseDigest === releaseDigest && task.runtime.executionState === 'running' &&
    report.build.state === 'matched' && report.config.state === 'matched' &&
    report.daemon.state === 'running' && report.daemon.desiredState === 'running' &&
    report.daemon.heartbeatAgeSeconds !== null &&
    report.daemon.heartbeatAgeSeconds <= report.daemon.staleAfterSeconds &&
    report.daemon.lastErrorCode === null;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function defaultHealthInspector(
  scheduler: CurrentUserWindowsTaskScheduler,
): (launch: ManagedTaskLaunch) => Promise<ReleaseHealthObservation> {
  return async (launch) => {
    const task = await scheduler.inspect();
    const report = await inspectOperationalStatus({
      configPath: launch.configPath,
      statePath: launch.statePath,
      logDir: launch.logDir,
      expectedBuildIdentity: launch.releaseDigest,
      taskFacet: () => managedTaskStatusObservation(task),
    });
    return { scheduler: task, report };
  };
}

/** Starts only a stopped exact-owned task and waits for that release's fresh heartbeat. */
export async function runManagedTaskNow(
  waitSeconds = DEFAULT_WINDOWS_WAIT_SECONDS,
  dependencies: RunNowDependencies = {},
): Promise<RunNowResult> {
  if ((dependencies.platform ?? process.platform) !== 'win32') {
    throw new Error('windows.run_now.unsupported_platform');
  }
  validateWindowsWaitSeconds(waitSeconds);
  const scheduler = dependencies.scheduler ?? new CurrentUserWindowsTaskScheduler(
    new CurrentUserTaskSchedulerPowerShellRunner(),
  );
  const initial = await scheduler.inspect();
  const launch = await extractManagedTaskLaunch(
    initial,
    dependencies.manifestStore ?? new CurrentUserWindowsRuntimeManifestStore(),
  );
  let releaseMatches = false;
  try {
    releaseMatches = await (dependencies.verifyRelease ?? ((value) =>
      verifyCanonicalWindowsRelease(value.appRoot, value.releaseDigest)))(launch);
  } catch { /* static release drift below */ }
  if (!releaseMatches) throw new Error('windows.run_now.release_drift');
  if (initial.kind !== 'present') throw new Error('windows.run_now.task_absent');
  if (!initial.runtime.enabled || initial.runtime.state === 'disabled') {
    throw new Error('windows.run_now.task_disabled');
  }
  const inspectHealth = dependencies.inspectHealth ?? defaultHealthInspector(scheduler);
  const first = await inspectHealth(launch);
  if (healthyExactRelease(first, launch.releaseDigest)) return { action: 'already-healthy' };
  if (initial.runtime.executionState === 'running') {
    // Running-but-stale is deliberately not multiplied or terminated.
    throw new Error('windows.run_now.running_stale');
  }
  await scheduler.start(initial.xml);
  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.nowMilliseconds ?? (() => performance.now());
  const pollMilliseconds = dependencies.pollMilliseconds ?? 1_000;
  if (!Number.isFinite(pollMilliseconds) || pollMilliseconds < 10 || pollMilliseconds > 5_000) {
    throw new Error('windows.run_now.invalid_poll');
  }
  let previousNow = now();
  if (!Number.isFinite(previousNow)) throw new Error('windows.run_now.clock_invalid');
  const monotonicNow = (): number => {
    const value = now();
    if (!Number.isFinite(value) || value < previousNow) throw new Error('windows.run_now.clock_invalid');
    previousNow = value;
    return value;
  };
  const deadline = previousNow + waitSeconds * 1_000;
  while (monotonicNow() <= deadline) {
    const observed = await inspectHealth(launch);
    if (healthyExactRelease(observed, launch.releaseDigest)) return { action: 'started' };
    if (observed.scheduler.kind === 'absent' ||
        (observed.scheduler.kind === 'present' &&
         (observed.scheduler.ownership !== 'owned' || observed.scheduler.integrity !== 'matched'))) {
      throw new Error('windows.run_now.task_drift');
    }
    const remaining = deadline - monotonicNow();
    if (remaining <= 0) break;
    await sleep(Math.min(pollMilliseconds, remaining));
  }
  throw new Error('windows.run_now.heartbeat_timeout');
}
