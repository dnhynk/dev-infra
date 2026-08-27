import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ParsedBridgeConfig } from '../src/project/config.js';
import {
  classifyTaskLifecycle,
  fingerprintOperationalBuild,
  type OperationalStatusReport,
  type TaskStatusObservation,
} from '../src/operational/status.js';
import { installWindowsTask } from '../src/commands/install.js';
import { runManagedTaskNow } from '../src/commands/run-now.js';
import { uninstallWindowsTask } from '../src/commands/uninstall.js';
import {
  setDeploymentDesiredStopped,
  verifyDeploymentDaemonBuildIdentity,
  type DeploymentDaemonHealthLease,
  type ValidatedWindowsDeployment,
} from '../src/windows/deployment.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import {
  createWindowsRuntimeManifest,
  parseWindowsRuntimeManifest,
  serializeWindowsRuntimeManifest,
  type WindowsRuntimeManifestStore,
  type WindowsRuntimeManifestSnapshot,
} from '../src/windows/runtime-manifest.js';
import {
  createWindowsTaskDefinition,
  CurrentUserWindowsTaskScheduler,
  escapeTaskXmlTextForTest,
  fingerprintWindowsTask,
  parseWindowsTaskXml,
  WINDOWS_TASK_DESCRIPTION_PREFIX,
  type TaskSchedulerPowerShellOperation,
  type TaskSchedulerPowerShellRunner,
  type WindowsTaskDefinition,
} from '../src/windows/task-scheduler.js';

const SID = 'S-1-5-21-100-200-300-1001';
const DIGEST = 'b'.repeat(64);
const lifecycleTemporaryRoots: string[] = [];
const RELEASE_ROOT = win32.join(
  String.raw`C:\Users\test\AppData\Local\OrcaSlackBridge\releases`,
  DIGEST,
);
const paths = {
  appRoot: RELEASE_ROOT,
  nodePath: String.raw`C:\runtime\node.exe`,
  orcaPath: String.raw`C:\Program Files\Orca\orca.exe`,
  configPath: String.raw`C:\사용자 데이터\bridge config.json`,
  statePath: String.raw`C:\사용자 데이터\state.db`,
  logDir: String.raw`C:\사용자 데이터\logs`,
  cliPath: win32.join(RELEASE_ROOT, 'dist', 'cli.js'),
  launcherPath: win32.join(RELEASE_ROOT, 'windows', 'launch-daemon.ps1'),
  powerShellPath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
  runtimeManifestPath: String.raw`C:\Users\test\AppData\Local\OrcaSlackBridge\runtime.json`,
} as const;

afterEach(() => {
  for (const root of lifecycleTemporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function realDaemonState(buildIdentity = DIGEST) {
  const root = mkdtempSync(join(tmpdir(), 'orca-windows-lifecycle-state-'));
  lifecycleTemporaryRoots.push(root);
  const statePath = join(root, 'state.db');
  const store = new SqliteDigestStore(statePath);
  store.recordDaemonStart({
    instanceId: 'daemon-real-store',
    buildFingerprint: fingerprintOperationalBuild(buildIdentity),
    configFingerprint: 'c'.repeat(64),
    at: '2026-08-27T00:00:00.000Z',
  });
  store.close();
  return {
    setDesiredStopped: (
      _ignoredPath: string,
      expectedBuildIdentity: string,
      expectedHealth: DeploymentDaemonHealthLease,
    ): void => {
      setDeploymentDesiredStopped(
        statePath,
        expectedBuildIdentity,
        expectedHealth,
        () => new Date('2026-08-27T00:00:01.000Z'),
      );
    },
    verifyStateIdentity: (_ignoredPath: string, expectedBuildIdentity: string) =>
      verifyDeploymentDaemonBuildIdentity(statePath, expectedBuildIdentity),
    advanceHealthRevision: (): void => {
      const reopened = new SqliteDigestStore(statePath);
      try {
        if (reopened.recordDaemonHeartbeat(
          'daemon-real-store',
          '2026-08-27T00:00:00.500Z',
        ) === null) throw new Error('fixture heartbeat failed');
      } finally { reopened.close(); }
    },
    desiredState: (): string | null => {
      const reopened = new SqliteDigestStore(statePath);
      try { return reopened.readDaemonHealth()?.desiredState ?? null; } finally { reopened.close(); }
    },
  };
}

function taskDefinition(): WindowsTaskDefinition {
  return createWindowsTaskDefinition({
    currentSid: SID,
    releaseDigest: DIGEST,
    powerShellPath: paths.powerShellPath,
    launcherPath: paths.launcherPath,
    runtimeManifestPath: paths.runtimeManifestPath,
    workingDirectory: paths.appRoot,
  });
}

function xml(value: WindowsTaskDefinition): string {
  const e = escapeTaskXmlTextForTest;
  return `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>${e(value.description)}</Description></RegistrationInfo>
<Triggers><LogonTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><UserId>${e(value.trigger.userId)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${e(value.principal.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>${String(value.enabled).toLowerCase()}</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>${e(value.action.execute)}</Command><Arguments>${e(value.action.arguments)}</Arguments><WorkingDirectory>${e(value.action.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

class FakePowerShellRunner implements TaskSchedulerPowerShellRunner {
  definition: WindowsTaskDefinition | null = null;
  state = 'Ready';
  hasRun = false;
  lastTaskResult = 0;
  corruptNextRegister = false;
  validateFailure = false;
  readonly operations: string[] = [];

  async run(operation: TaskSchedulerPowerShellOperation, input: unknown): Promise<unknown> {
    this.operations.push(operation);
    if (operation === 'currentSid') return SID;
    if (operation === 'taskSchemaVersion') return '1.2';
    if (operation === 'inspect') {
      if (this.definition === null) return { exists: false };
      return {
        exists: true,
        xml: xml(this.definition),
        state: this.state,
        enabled: this.definition.enabled,
        lastTaskResult: this.lastTaskResult,
        lastRunTime: this.hasRun ? '2026-08-27T00:00:00.000Z' : null,
        nextRunTime: null,
        missedRuns: 0,
        observedAt: '2026-08-27T00:00:10.000Z',
      };
    }
    const record = input as Record<string, unknown>;
    if (operation === 'validate') {
      if (this.validateFailure) throw new Error('windows.task_scheduler.command_failed');
      return { ok: true };
    }
    if (operation === 'register') {
      const desired = (record['definition'] as WindowsTaskDefinition);
      this.definition = this.corruptNextRegister
        ? { ...desired, action: { ...desired.action, workingDirectory: String.raw`C:\corrupt` } }
        : desired;
      this.state = 'Ready';
      this.corruptNextRegister = false;
      return { ok: true };
    }
    if (operation === 'restoreXml') {
      const restored = parseWindowsTaskXml(String(record['xml']));
      if (restored === null) throw new Error('invalid fixture XML');
      this.definition = restored;
      return { ok: true };
    }
    if (operation === 'disable') {
      if (this.definition === null) throw new Error('absent');
      this.definition = { ...this.definition, enabled: false };
      return { ok: true };
    }
    if (operation === 'start') {
      this.state = 'Running';
      return { ok: true };
    }
    if (operation === 'stop') {
      this.state = 'Ready';
      return { ok: true };
    }
    if (operation === 'unregister') {
      this.definition = null;
      return { ok: true };
    }
    throw new Error('unsupported fake operation');
  }
}

function runtimeManifestBytes(
  taskSemanticFingerprint = fingerprintWindowsTask(taskDefinition()),
  overrides: Partial<Parameters<typeof createWindowsRuntimeManifest>[0]> = {},
): Buffer {
  return serializeWindowsRuntimeManifest(createWindowsRuntimeManifest({
    releaseRoot: paths.appRoot,
    releaseDigest: DIGEST,
    nodeExe: paths.nodePath,
    distCli: paths.cliPath,
    launcherPath: paths.launcherPath,
    launcherSha256: 'e'.repeat(64),
    taskSemanticFingerprint,
    config: paths.configPath,
    state: paths.statePath,
    orcaExe: paths.orcaPath,
    logDirectory: paths.logDir,
    ...overrides,
  }));
}

class FakeManifestStore implements WindowsRuntimeManifestStore {
  bytes: Buffer | null = null;
  protected = true;
  readonly operations: string[] = [];

  seed(): this {
    this.bytes = runtimeManifestBytes();
    return this;
  }

  async inspect(_path: string): Promise<WindowsRuntimeManifestSnapshot> {
    this.operations.push('inspect');
    if (this.bytes === null) return { kind: 'absent' };
    return {
      kind: 'present', bytes: Buffer.from(this.bytes), protected: this.protected,
      manifest: parseWindowsRuntimeManifest(this.bytes),
    };
  }

  async replace(_path: string, expected: Buffer | null, desired: Buffer | null): Promise<void> {
    this.operations.push('replace');
    if (expected === null ? this.bytes !== null : this.bytes === null || !this.bytes.equals(expected)) {
      throw new Error('manifest CAS mismatch');
    }
    this.bytes = desired === null ? null : Buffer.from(desired);
    this.protected = true;
  }
}

function deployment(): ValidatedWindowsDeployment {
  return {
    paths,
    buildDigest: DIGEST,
    launcherSha256: 'e'.repeat(64),
    config: {} as ParsedBridgeConfig,
  };
}

function report(overrides: Partial<OperationalStatusReport['daemon']> = {}): OperationalStatusReport {
  return {
    build: { state: 'matched' },
    config: { state: 'matched' },
    daemon: {
      desiredState: 'running', state: 'running', heartbeatAgeSeconds: 1,
      staleAfterSeconds: 90, lastErrorCode: null, ...overrides,
    },
  } as OperationalStatusReport;
}

describe('Windows current-user lifecycle', () => {
  it('installs twice as one exact task and never starts without --run-now', async () => {
    const runner = new FakePowerShellRunner();
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const manifestStore = new FakeManifestStore();
    let prepared = 0;
    const dependencies = {
      platform: 'win32' as const,
      scheduler,
      manifestStore,
      validateDeployment: async () => deployment(),
      validateExistingState: async () => undefined,
      prepareState: async () => {
        prepared += 1;
        return { backupPath: null, release: async () => undefined };
      },
    };
    expect(await installWindowsTask({ ...paths, runNow: false }, dependencies)).toMatchObject({
      task: 'created', runNow: 'not-requested',
    });
    expect(await installWindowsTask({ ...paths, runNow: false }, dependencies)).toMatchObject({
      task: 'unchanged', runNow: 'not-requested',
    });
    expect(runner.operations.filter((operation) => operation === 'register')).toHaveLength(1);
    expect(runner.operations.filter((operation) => operation === 'validate')).toHaveLength(2);
    expect(runner.operations).not.toContain('start');
    expect(prepared).toBe(1);
  });

  it('fails a same-name foreign collision closed before state preparation or mutation', async () => {
    const otherSid = 'S-1-5-21-900-800-700-1002';
    for (const collision of [
      { ...taskDefinition(), description: 'owned by another product' },
      {
        ...taskDefinition(),
        principal: { ...taskDefinition().principal, userId: otherSid },
        trigger: { ...taskDefinition().trigger, userId: otherSid },
      },
    ]) {
      const runner = new FakePowerShellRunner();
      runner.definition = collision;
      const scheduler = new CurrentUserWindowsTaskScheduler(runner);
      let prepared = false;
      await expect(installWindowsTask({ ...paths, runNow: false }, {
        platform: 'win32', scheduler,
        manifestStore: new FakeManifestStore(),
        validateDeployment: async () => deployment(),
        prepareState: async () => {
          prepared = true;
          return { backupPath: null, release: async () => undefined };
        },
      })).rejects.toThrow('windows.install.foreign_task_collision');
      expect(prepared).toBe(false);
      expect(runner.operations).not.toContain('register');
    }
  });

  it('treats a current-principal managed marker with a damaged fingerprint as owned drift', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = {
      ...taskDefinition(),
      description: `${WINDOWS_TASK_DESCRIPTION_PREFIX};damaged`,
    };
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    expect(await installWindowsTask({ ...paths, runNow: false }, {
      platform: 'win32', scheduler,
      manifestStore: new FakeManifestStore(),
      validateDeployment: async () => deployment(),
      prepareState: async () => ({ backupPath: null, release: async () => undefined }),
    })).toMatchObject({ task: 'updated' });
    expect(runner.definition).toEqual(taskDefinition());
  });

  it('does not mutate the task when backup or migration preflight fails', async () => {
    const runner = new FakePowerShellRunner();
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    await expect(installWindowsTask({ ...paths, runNow: false }, {
      platform: 'win32', scheduler,
      manifestStore: new FakeManifestStore(),
      validateDeployment: async () => deployment(),
      prepareState: async () => { throw new Error('windows.deploy.backup_verification_failed'); },
    })).rejects.toThrow('windows.deploy.backup_verification_failed');
    expect(runner.definition).toBeNull();
    expect(runner.operations).not.toContain('register');
  });

  it('never replaces a present invalid or unprotected manifest during a new install', async () => {
    for (const manifestStore of [
      Object.assign(new FakeManifestStore(), { bytes: Buffer.from('{"foreign":true}\n') }),
      Object.assign(new FakeManifestStore().seed(), { protected: false }),
    ]) {
      const runner = new FakePowerShellRunner();
      let prepared = false;
      await expect(installWindowsTask({ ...paths, runNow: false }, {
        platform: 'win32',
        scheduler: new CurrentUserWindowsTaskScheduler(runner),
        manifestStore,
        validateDeployment: async () => deployment(),
        prepareState: async () => {
          prepared = true;
          return { backupPath: null, release: async () => undefined };
        },
      })).rejects.toThrow('windows.install.runtime_manifest_invalid');
      expect(prepared).toBe(false);
      expect(runner.operations).not.toContain('register');
      expect(manifestStore.operations).toEqual(['inspect']);
    }
  });

  it('runs COM validate-only before state or manifest effects and preserves every byte on failure', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.validateFailure = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const manifestStore = new FakeManifestStore().seed();
    const beforeTask = xml(runner.definition);
    const beforeManifest = Buffer.from(manifestStore.bytes!);
    const stateBytes = Buffer.from('immutable-state-before-validation');
    let prepared = false;
    await expect(installWindowsTask({ ...paths, runNow: false }, {
      platform: 'win32', scheduler, manifestStore,
      validateDeployment: async () => deployment(),
      prepareState: async () => {
        prepared = true;
        stateBytes.fill(0);
        return { backupPath: null, release: async () => undefined };
      },
    })).rejects.toThrow('windows.task_scheduler.command_failed');
    expect(prepared).toBe(false);
    expect(xml(runner.definition!)).toBe(beforeTask);
    expect(manifestStore.bytes).toEqual(beforeManifest);
    expect(stateBytes.toString()).toBe('immutable-state-before-validation');
    expect(manifestStore.operations).toEqual([]);
    expect(runner.operations.at(-1)).toBe('validate');
  });

  it('fails unchanged reinstalls on missing/corrupt manifest or legacy state without preparing state', async () => {
    for (const manifestStore of [
      new FakeManifestStore(),
      Object.assign(new FakeManifestStore(), { bytes: Buffer.from('{"legacy":true}\n') }),
    ]) {
      const runner = new FakePowerShellRunner();
      runner.definition = taskDefinition();
      let prepared = false;
      await expect(installWindowsTask({ ...paths, runNow: false }, {
        platform: 'win32', scheduler: new CurrentUserWindowsTaskScheduler(runner), manifestStore,
        validateDeployment: async () => deployment(),
        prepareState: async () => {
          prepared = true;
          return { backupPath: null, release: async () => undefined };
        },
      })).rejects.toThrow('windows.install.runtime_manifest_invalid');
      expect(prepared).toBe(false);
      expect(runner.operations).not.toContain('register');
    }
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    let prepared = false;
    await expect(installWindowsTask({ ...paths, runNow: false }, {
      platform: 'win32', scheduler: new CurrentUserWindowsTaskScheduler(runner),
      manifestStore: new FakeManifestStore().seed(),
      validateDeployment: async () => deployment(),
      validateExistingState: async () => { throw new Error('windows.install.existing_state_invalid'); },
      prepareState: async () => {
        prepared = true;
        return { backupPath: null, release: async () => undefined };
      },
    })).rejects.toThrow('windows.install.existing_state_invalid');
    expect(prepared).toBe(false);
    expect(runner.operations).not.toContain('register');
  });

  it('backs up an owned drifted task and rolls it back after post-registration semantic failure', async () => {
    const runner = new FakePowerShellRunner();
    const desired = taskDefinition();
    const drifted = {
      ...desired,
      action: { ...desired.action, workingDirectory: String.raw`C:\old-release` },
    };
    runner.definition = drifted;
    runner.corruptNextRegister = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const manifestStore = new FakeManifestStore().seed();
    await expect(installWindowsTask({ ...paths, runNow: false }, {
      platform: 'win32', scheduler,
      manifestStore,
      validateDeployment: async () => deployment(),
      prepareState: async () => ({ backupPath: String.raw`C:\data\backup.db`, release: async () => undefined }),
    })).rejects.toThrow('windows.install.task_update_failed');
    expect(runner.operations).toContain('restoreXml');
    expect(runner.definition).toEqual(drifted);
  });

  it('does not spawn a second process when running is stale, and starts a stopped task until exact heartbeat', async () => {
    const staleRunner = new FakePowerShellRunner();
    staleRunner.definition = taskDefinition();
    staleRunner.state = 'Running';
    const staleScheduler = new CurrentUserWindowsTaskScheduler(staleRunner);
    await expect(runManagedTaskNow(2, {
      platform: 'win32', scheduler: staleScheduler,
      manifestStore: new FakeManifestStore().seed(),
      verifyRelease: () => true,
      inspectHealth: async () => ({ scheduler: await staleScheduler.inspect(), report: report({ heartbeatAgeSeconds: 91 }) }),
    })).rejects.toThrow('windows.run_now.running_stale');
    expect(staleRunner.operations).not.toContain('start');

    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    let now = 0;
    let observations = 0;
    expect(await runManagedTaskNow(2, {
      platform: 'win32', scheduler,
      manifestStore: new FakeManifestStore().seed(),
      verifyRelease: () => true,
      nowMilliseconds: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      inspectHealth: async () => {
        observations += 1;
        const snapshot = await scheduler.inspect();
        return {
          scheduler: snapshot,
          report: observations >= 2 ? report() : report({ state: 'absent', desiredState: 'absent', heartbeatAgeSeconds: null }),
        };
      },
    })).toEqual({ action: 'started' });
    expect(runner.operations.filter((operation) => operation === 'start')).toHaveLength(1);
  });

  it('run-now is a no-op when the exact installed release is already healthy', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    runner.hasRun = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    expect(await runManagedTaskNow(2, {
      platform: 'win32', scheduler,
      manifestStore: new FakeManifestStore().seed(),
      verifyRelease: () => true,
      inspectHealth: async () => ({ scheduler: await scheduler.inspect(), report: report() }),
    })).toEqual({ action: 'already-healthy' });
    expect(runner.operations).not.toContain('start');
  });

  it('rejects a protected self-consistent manifest bound to another task fingerprint', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    const manifestStore = new FakeManifestStore();
    manifestStore.bytes = runtimeManifestBytes('0'.repeat(64));
    await expect(runManagedTaskNow(2, {
      platform: 'win32',
      scheduler: new CurrentUserWindowsTaskScheduler(runner),
      manifestStore,
      verifyRelease: () => true,
    })).rejects.toThrow('windows.run_now.runtime_manifest_drift');
    expect(runner.operations).not.toContain('start');
  });

  it('uninstalls in disable/desired-stop/wait/unregister order and preserves a timed-out task', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    runner.hasRun = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const lifecycle: string[] = [];
    const daemonState = realDaemonState();
    expect(await uninstallWindowsTask(2, {
      platform: 'win32', scheduler,
      manifestStore: new FakeManifestStore().seed(),
      verifyStateIdentity: daemonState.verifyStateIdentity,
      setDesiredStopped: (statePath, expectedBuildIdentity, expectedHealth) => {
        daemonState.setDesiredStopped(statePath, expectedBuildIdentity, expectedHealth);
        lifecycle.push('desired-stopped');
      },
      verifyRelease: () => true,
      inspectShutdown: async () => {
        runner.state = 'Ready';
        lifecycle.push('waited');
        return {
          scheduler: await scheduler.inspect(),
          report: report({ state: 'stopped', desiredState: 'stopped', heartbeatAgeSeconds: 1 }),
          pipeReleased: true,
        };
      },
    })).toEqual({ task: 'removed' });
    expect(runner.operations.indexOf('disable')).toBeLessThan(runner.operations.indexOf('unregister'));
    expect(lifecycle).toEqual(['desired-stopped', 'waited']);
    expect(daemonState.desiredState()).toBe('stopped');

    const timeoutRunner = new FakePowerShellRunner();
    timeoutRunner.definition = taskDefinition();
    timeoutRunner.state = 'Running';
    const timeoutScheduler = new CurrentUserWindowsTaskScheduler(timeoutRunner);
    let now = 0;
    await expect(uninstallWindowsTask(1, {
      platform: 'win32', scheduler: timeoutScheduler,
      manifestStore: new FakeManifestStore().seed(),
      verifyStateIdentity: () => ({ kind: 'absent' }),
      setDesiredStopped: () => undefined,
      verifyRelease: () => true,
      nowMilliseconds: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      inspectShutdown: async () => ({
        scheduler: await timeoutScheduler.inspect(),
        report: report({ heartbeatAgeSeconds: 91 }),
        pipeReleased: false,
      }),
    })).rejects.toThrow('windows.uninstall.clean_stop_timeout');
    expect(timeoutRunner.definition).not.toBeNull();
    expect(timeoutRunner.definition?.enabled).toBe(false);
    expect(timeoutRunner.operations).not.toContain('unregister');
  });

  it('fails a release identity mismatch closed before disable, stop, or unregister', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const daemonState = realDaemonState('d'.repeat(64));
    await expect(uninstallWindowsTask(1, {
      platform: 'win32', scheduler,
      manifestStore: new FakeManifestStore().seed(),
      verifyStateIdentity: daemonState.verifyStateIdentity,
      setDesiredStopped: daemonState.setDesiredStopped,
      verifyRelease: () => true,
    })).rejects.toThrow('windows.uninstall.state_identity_mismatch');
    expect(daemonState.desiredState()).toBe('running');
    expect(runner.definition).not.toBeNull();
    expect(runner.definition?.enabled).toBe(true);
    expect(runner.operations).not.toContain('disable');
    expect(runner.operations).not.toContain('stop');
    expect(runner.operations).not.toContain('unregister');
  });

  it('fences a post-precheck daemon revision race and CAS-restores the enabled owned task', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    const daemonState = realDaemonState();
    await expect(uninstallWindowsTask(1, {
      platform: 'win32',
      scheduler: new CurrentUserWindowsTaskScheduler(runner),
      manifestStore: new FakeManifestStore().seed(),
      verifyRelease: () => true,
      verifyStateIdentity: (statePath, expectedBuildIdentity) => {
        const lease = daemonState.verifyStateIdentity(statePath, expectedBuildIdentity);
        daemonState.advanceHealthRevision();
        return lease;
      },
      setDesiredStopped: daemonState.setDesiredStopped,
    })).rejects.toThrow('windows.uninstall.desired_state_conflict');
    expect(daemonState.desiredState()).toBe('running');
    expect(runner.definition).not.toBeNull();
    expect(runner.definition?.enabled).toBe(true);
    expect(runner.operations).toContain('disable');
    expect(runner.operations).toContain('restoreXml');
    expect(runner.operations).not.toContain('stop');
    expect(runner.operations).not.toContain('unregister');
  });

  it('uses --force only after graceful timeout, warns statically, rechecks CAS, and stops the owned task', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    runner.hasRun = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const daemonState = realDaemonState();
    let now = 0;
    const warnings: string[] = [];
    expect(await uninstallWindowsTask(1, {
      platform: 'win32', scheduler, force: true,
      manifestStore: new FakeManifestStore().seed(),
      verifyStateIdentity: daemonState.verifyStateIdentity,
      setDesiredStopped: daemonState.setDesiredStopped,
      verifyRelease: () => true,
      nowMilliseconds: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      inspectShutdown: async () => ({
        scheduler: await scheduler.inspect(),
        report: report({ heartbeatAgeSeconds: 91 }),
        pipeReleased: false,
      }),
      probePipeReleased: async () => runner.state === 'Ready',
      onForceWarning: () => { warnings.push('windows.uninstall.force_warning'); },
    })).toEqual({ task: 'removed' });
    expect(warnings).toEqual(['windows.uninstall.force_warning']);
    expect(daemonState.desiredState()).toBe('stopped');
    expect(runner.operations.indexOf('stop')).toBeGreaterThan(runner.operations.indexOf('disable'));
    expect(runner.operations.indexOf('unregister')).toBeGreaterThan(runner.operations.indexOf('stop'));
  });

  it('fails closed on protected manifest drift at the force pre-stop boundary', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    runner.hasRun = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const manifestStore = new FakeManifestStore().seed();
    const daemonState = realDaemonState();
    let now = 0;
    await expect(uninstallWindowsTask(1, {
      platform: 'win32', scheduler, force: true, manifestStore,
      verifyStateIdentity: daemonState.verifyStateIdentity,
      setDesiredStopped: daemonState.setDesiredStopped,
      verifyRelease: () => true,
      nowMilliseconds: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      inspectShutdown: async () => {
        manifestStore.bytes = runtimeManifestBytes(
          fingerprintWindowsTask(taskDefinition()),
          { logDirectory: String.raw`C:\drifted\logs` },
        );
        return {
          scheduler: await scheduler.inspect(),
          report: report({ heartbeatAgeSeconds: 91 }),
          pipeReleased: false,
        };
      },
      onForceWarning: () => undefined,
    })).rejects.toThrow('windows.uninstall.runtime_manifest_drift');
    expect(runner.operations).not.toContain('stop');
    expect(runner.operations).not.toContain('unregister');
  });

  it('fails closed on release drift at the force pre-unregister boundary', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    runner.hasRun = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const daemonState = realDaemonState();
    let now = 0;
    let releaseChecks = 0;
    await expect(uninstallWindowsTask(1, {
      platform: 'win32', scheduler, force: true,
      manifestStore: new FakeManifestStore().seed(),
      verifyStateIdentity: daemonState.verifyStateIdentity,
      setDesiredStopped: daemonState.setDesiredStopped,
      verifyRelease: () => {
        releaseChecks += 1;
        return releaseChecks < 3;
      },
      nowMilliseconds: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      inspectShutdown: async () => ({
        scheduler: await scheduler.inspect(),
        report: report({ heartbeatAgeSeconds: 91 }),
        pipeReleased: false,
      }),
      probePipeReleased: async () => runner.state === 'Ready',
      onForceWarning: () => undefined,
    })).rejects.toThrow('windows.uninstall.release_drift');
    expect(releaseChecks).toBe(3);
    expect(runner.operations).toContain('stop');
    expect(runner.operations).not.toContain('unregister');
  });

  it('treats an absent uninstall as success without writing desired state', async () => {
    const runner = new FakePowerShellRunner();
    let desiredWrites = 0;
    expect(await uninstallWindowsTask(2, {
      platform: 'win32',
      scheduler: new CurrentUserWindowsTaskScheduler(runner),
      setDesiredStopped: () => { desiredWrites += 1; },
    })).toEqual({ task: 'absent' });
    expect(desiredWrites).toBe(0);
    expect(runner.operations).not.toContain('unregister');
  });

  it('returns a clear non-Windows error before any scheduler call', async () => {
    const runner = new FakePowerShellRunner();
    await expect(runManagedTaskNow(1, {
      platform: 'linux', scheduler: new CurrentUserWindowsTaskScheduler(runner),
      verifyRelease: () => true,
    })).rejects.toThrow('windows.run_now.unsupported_platform');
    expect(runner.operations).toEqual([]);
  });
});

const statusTask = (overrides: Partial<TaskStatusObservation> = {}): TaskStatusObservation => ({
  ownership: 'matched', state: 'stopped', schedulerState: 'ready', hasRun: false,
  lastTaskResult: 0, observedAt: '2026-08-27T00:03:00.000Z',
  lastRunTime: '2026-08-27T00:00:00.000Z', nextRunTime: null, missedRuns: 0,
  restartCount: 3, restartIntervalSeconds: 60, ...overrides,
});

describe('O1-6 task facet classifications', () => {
  it.each([
    ['uninstalled', statusTask({ ownership: 'absent', schedulerState: 'absent' }), report({ state: 'absent', desiredState: 'absent' }).daemon, 'unverified', 'readable'],
    ['disabled', statusTask({ schedulerState: 'disabled' }), report({ state: 'absent', desiredState: 'absent' }).daemon, 'unverified', 'readable'],
    ['installed-not-started', statusTask({ lastTaskResult: 267011 }), report({ state: 'absent', desiredState: 'absent' }).daemon, 'unverified', 'readable'],
    ['healthy', statusTask({ state: 'running', schedulerState: 'running', hasRun: true }), report().daemon, 'matched', 'matched'],
    ['degraded-hung', statusTask({ state: 'running', schedulerState: 'running', hasRun: true }), report({ heartbeatAgeSeconds: 91 }).daemon, 'matched', 'matched'],
    ['stopped-clean', statusTask({ hasRun: true }), report({ state: 'stopped', desiredState: 'stopped' }).daemon, 'matched', 'matched'],
    ['exited-unexpected', statusTask({ hasRun: true }), report({ state: 'stopped', desiredState: 'running' }).daemon, 'matched', 'matched'],
    ['failed-restarting', statusTask({ state: 'running', schedulerState: 'running', hasRun: true, lastTaskResult: 1 }), report({ state: 'absent', desiredState: 'absent' }).daemon, 'unverified', 'readable'],
    ['failed-exhausted', statusTask({ hasRun: true, lastTaskResult: 1, observedAt: '2026-08-27T00:03:05.001Z' }), report({ state: 'stopped', desiredState: 'running' }).daemon, 'matched', 'matched'],
    ['drifted', statusTask({ ownership: 'drifted' }), report().daemon, 'matched', 'matched'],
  ] as const)('classifies %s from scheduler plus O1 health', (expected, observation, health, build, config) => {
    expect(classifyTaskLifecycle(observation, health, build, config)).toBe(expected);
  });

  it('keeps the bounded retry/grace edge and ambiguous evidence restarting, then exhausts one millisecond later', () => {
    const health = report({ state: 'stopped', desiredState: 'running' }).daemon;
    expect(classifyTaskLifecycle(statusTask({ hasRun: true, lastTaskResult: 1 }), health, 'matched', 'matched'))
      .toBe('failed-restarting');
    expect(classifyTaskLifecycle(statusTask({
      hasRun: true,
      lastTaskResult: 1,
      observedAt: '2026-08-27T00:10:00.000Z',
      nextRunTime: '2026-08-27T00:10:00.001Z',
    }), health, 'matched', 'matched')).toBe('failed-restarting');
    expect(classifyTaskLifecycle(statusTask({
      hasRun: true,
      lastTaskResult: 1,
      observedAt: '2026-08-27T00:03:05.000Z',
    }), health, 'matched', 'matched')).toBe('failed-restarting');
    expect(classifyTaskLifecycle(statusTask({
      hasRun: true,
      lastTaskResult: 1,
      observedAt: '2026-08-27T00:03:05.001Z',
    }), health, 'matched', 'matched')).toBe('failed-exhausted');
    expect(classifyTaskLifecycle(statusTask({
      hasRun: true,
      lastTaskResult: 1,
      observedAt: '2026-08-27T00:10:00.000Z',
      missedRuns: 1,
    }), health, 'matched', 'matched')).toBe('failed-restarting');
    expect(classifyTaskLifecycle({
      ownership: 'matched', state: 'stopped', schedulerState: 'ready', hasRun: true,
      lastTaskResult: 1,
    }, health, 'matched', 'matched')).toBe('failed-restarting');
  });
});
