import { describe, expect, it } from 'vitest';
import type { ParsedBridgeConfig } from '../src/project/config.js';
import {
  classifyTaskLifecycle,
  type OperationalStatusReport,
  type TaskStatusObservation,
} from '../src/operational/status.js';
import { installWindowsTask } from '../src/commands/install.js';
import { runManagedTaskNow } from '../src/commands/run-now.js';
import { uninstallWindowsTask } from '../src/commands/uninstall.js';
import type { ValidatedWindowsDeployment } from '../src/windows/deployment.js';
import {
  createWindowsTaskDefinition,
  CurrentUserWindowsTaskScheduler,
  escapeTaskXmlTextForTest,
  parseWindowsTaskXml,
  WINDOWS_TASK_DESCRIPTION_PREFIX,
  type TaskSchedulerPowerShellOperation,
  type TaskSchedulerPowerShellRunner,
  type WindowsTaskDefinition,
} from '../src/windows/task-scheduler.js';

const SID = 'S-1-5-21-100-200-300-1001';
const DIGEST = 'b'.repeat(64);
const paths = {
  appRoot: String.raw`C:\releases\bridge-2026.08.27`,
  nodePath: String.raw`C:\releases\bridge-2026.08.27\node.exe`,
  orcaPath: String.raw`C:\Program Files\Orca\orca.exe`,
  configPath: String.raw`C:\사용자 데이터\bridge config.json`,
  statePath: String.raw`C:\사용자 데이터\state.db`,
  logDir: String.raw`C:\사용자 데이터\logs`,
  cliPath: String.raw`C:\releases\bridge-2026.08.27\dist\cli.js`,
} as const;

function taskDefinition(): WindowsTaskDefinition {
  return createWindowsTaskDefinition({
    currentSid: SID,
    releaseDigest: DIGEST,
    ...paths,
    workingDirectory: paths.appRoot,
  });
}

function xml(value: WindowsTaskDefinition): string {
  const e = escapeTaskXmlTextForTest;
  return `<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>${e(value.description)}</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${e(value.trigger.userId)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Author"><UserId>${e(value.principal.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>${String(value.enabled).toLowerCase()}</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
<Actions Context="Author"><Exec><Command>${e(value.action.execute)}</Command><Arguments>${e(value.action.arguments)}</Arguments><WorkingDirectory>${e(value.action.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

class FakePowerShellRunner implements TaskSchedulerPowerShellRunner {
  definition: WindowsTaskDefinition | null = null;
  state = 'Ready';
  hasRun = false;
  lastTaskResult = 0;
  corruptNextRegister = false;
  readonly operations: string[] = [];

  async run(operation: TaskSchedulerPowerShellOperation, input: unknown): Promise<unknown> {
    this.operations.push(operation);
    if (operation === 'currentSid') return SID;
    if (operation === 'inspect') {
      if (this.definition === null) return { exists: false };
      return {
        exists: true,
        xml: xml(this.definition),
        state: this.state,
        enabled: this.definition.enabled,
        lastTaskResult: this.lastTaskResult,
        lastRunTime: this.hasRun ? '2026-08-27T00:00:00.000Z' : null,
      };
    }
    const record = input as Record<string, unknown>;
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
    if (operation === 'unregister') {
      this.definition = null;
      return { ok: true };
    }
    throw new Error('unsupported fake operation');
  }
}

function deployment(): ValidatedWindowsDeployment {
  return {
    paths,
    buildDigest: DIGEST,
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
    let prepared = 0;
    const dependencies = {
      platform: 'win32' as const,
      scheduler,
      validateDeployment: async () => deployment(),
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
      validateDeployment: async () => deployment(),
      prepareState: async () => { throw new Error('windows.deploy.backup_verification_failed'); },
    })).rejects.toThrow('windows.deploy.backup_verification_failed');
    expect(runner.definition).toBeNull();
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
    await expect(installWindowsTask({ ...paths, runNow: false }, {
      platform: 'win32', scheduler,
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
      verifyRelease: () => true,
      inspectHealth: async () => ({ scheduler: await scheduler.inspect(), report: report() }),
    })).toEqual({ action: 'already-healthy' });
    expect(runner.operations).not.toContain('start');
  });

  it('uninstalls in disable/desired-stop/wait/unregister order and preserves a timed-out task', async () => {
    const runner = new FakePowerShellRunner();
    runner.definition = taskDefinition();
    runner.state = 'Running';
    runner.hasRun = true;
    const scheduler = new CurrentUserWindowsTaskScheduler(runner);
    const lifecycle: string[] = [];
    expect(await uninstallWindowsTask(2, {
      platform: 'win32', scheduler,
      setDesiredStopped: () => { lifecycle.push('desired-stopped'); },
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

    const timeoutRunner = new FakePowerShellRunner();
    timeoutRunner.definition = taskDefinition();
    timeoutRunner.state = 'Running';
    const timeoutScheduler = new CurrentUserWindowsTaskScheduler(timeoutRunner);
    let now = 0;
    await expect(uninstallWindowsTask(1, {
      platform: 'win32', scheduler: timeoutScheduler,
      setDesiredStopped: () => undefined,
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
  lastTaskResult: 0, ...overrides,
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
    ['failed-exhausted', statusTask({ hasRun: true, lastTaskResult: 1 }), report({ state: 'stopped', desiredState: 'running' }).daemon, 'matched', 'matched'],
    ['drifted', statusTask({ ownership: 'drifted' }), report().daemon, 'matched', 'matched'],
  ] as const)('classifies %s from scheduler plus O1 health', (expected, observation, health, build, config) => {
    expect(classifyTaskLifecycle(observation, health, build, config)).toBe(expected);
  });
});
