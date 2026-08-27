import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createWindowsTaskDefinition,
  CurrentUserTaskSchedulerPowerShellRunner,
  CurrentUserWindowsTaskScheduler,
  escapeTaskXmlTextForTest,
  fingerprintWindowsTask,
  joinWindowsArguments,
  parseWindowsArguments,
  parseWindowsTaskMarker,
  parseWindowsTaskXml,
  quoteWindowsArgument,
  windowsTaskXmlMatchesLaunchBinding,
  WINDOWS_TASK_DESCRIPTION_PREFIX,
  WINDOWS_TASK_NAME,
  type WindowsTaskDefinition,
} from '../src/windows/task-scheduler.js';

const SID = 'S-1-5-21-100-200-300-1001';
const OTHER_SID = 'S-1-5-21-100-200-300-1002';
const ACCOUNT = String.raw`WORKSTATION\operator`;
const DIGEST = 'a'.repeat(64);
const windowsIt = process.platform === 'win32' ? it : it.skip;

function definition(): WindowsTaskDefinition {
  return createWindowsTaskDefinition({
    currentSid: SID,
    releaseDigest: DIGEST,
    powerShellPath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    launcherPath: String.raw`C:\릴리스 공간\bridge 1\windows\launch-daemon.ps1`,
    runtimeManifestPath: String.raw`C:\사용자 데이터\runtime.json`,
    workingDirectory: String.raw`C:\릴리스 공간\bridge 1`,
  });
}

function xml(value: WindowsTaskDefinition, schemaVersion = '1.2'): string {
  const e = escapeTaskXmlTextForTest;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="${schemaVersion}" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${e(value.description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><UserId>${e(value.trigger.userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${e(value.principal.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>${String(value.enabled).toLowerCase()}</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${e(value.action.execute)}</Command><Arguments>${e(value.action.arguments)}</Arguments><WorkingDirectory>${e(value.action.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

/** Sanitized exact node shape observed from the disposable registered COM definition. */
function canonicalRegisteredXml(value: WindowsTaskDefinition): string {
  const e = escapeTaskXmlTextForTest;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.6" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${e(value.description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Repetition><Interval>PT1M</Interval></Repetition><UserId>${e(ACCOUNT)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${e(value.principal.userId)}</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>${e(value.action.execute)}</Command><Arguments>${e(value.action.arguments)}</Arguments><WorkingDirectory>${e(value.action.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

describe('Windows Scheduled Task semantic contract', () => {
  windowsIt('COM validate-only accepts the desired definition and leaves no synthetic task', async () => {
    const runner = new CurrentUserTaskSchedulerPowerShellRunner();
    const currentSid = await runner.run('currentSid', {});
    expect(currentSid).toMatch(/^S-[0-9]+(?:-[0-9]+)+$/u);
    const schemaVersion = await runner.run('taskSchemaVersion', {});
    expect(schemaVersion).toBe('1.6');
    const taskName = `Orca Slack Bridge Validate Fixture ${randomUUID()}`;
    expect(await runner.run('inspect', { taskName })).toEqual({ exists: false });
    const systemRoot = process.env['SystemRoot']!;
    const desired = createWindowsTaskDefinition({
      currentSid: String(currentSid),
      releaseDigest: DIGEST,
      powerShellPath: join(
        systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
      ),
      launcherPath: join(process.cwd(), 'windows', 'launch-daemon.ps1'),
      runtimeManifestPath: join(process.cwd(), 'runtime-validate-only.json'),
      workingDirectory: process.cwd(),
    });
    expect(await runner.run('validate', {
      definition: { ...desired, taskName },
    })).toEqual({ ok: true });
    expect(await runner.run('inspect', { taskName })).toEqual({ exists: false });
  }, 30_000);

  it('round-trips every independently quoted argument including spaces, non-ASCII, quotes, and trailing slashes', () => {
    const values = [
      String.raw`C:\plain\cli.js`,
      'daemon',
      '--config',
      String.raw`C:\한 글\config "quoted".json`,
      '--state',
      'C:\\state trailing\\',
      '',
    ];
    expect(parseWindowsArguments(joinWindowsArguments(values))).toEqual(values);
    expect(values.map(quoteWindowsArgument).every((value) => value.startsWith('"') && value.endsWith('"')))
      .toBe(true);
  });

  it('serializes the fixed current-user semantic shape and verifies exported XML by meaning', () => {
    const expected = definition();
    const parsed = parseWindowsTaskXml(xml(expected));
    expect(parsed).toEqual(expected);
    expect(parsed?.taskName).toBe(WINDOWS_TASK_NAME);
    expect(parsed?.principal).toEqual({
      userId: SID,
      logonType: 'InteractiveToken',
      runLevel: 'Limited',
    });
    expect(parsed?.trigger.repetition).toEqual({
      interval: 'PT1M', duration: null, stopAtDurationEnd: false,
    });
    expect(parsed?.settings).toMatchObject({
      startWhenAvailable: true,
      multipleInstances: 'IgnoreNew',
      allowStartOnBatteries: true,
      dontStopOnBatteries: true,
      allowHardTerminate: true,
      allowDemandStart: true,
      hidden: false,
      executionTimeLimit: 'PT0S',
      restartCount: 3,
      restartInterval: 'PT1M',
    });
    expect(parseWindowsArguments(parsed!.action.arguments)).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', String.raw`C:\릴리스 공간\bridge 1\windows\launch-daemon.ps1`,
      '-SettingsPath', String.raw`C:\사용자 데이터\runtime.json`,
    ]);
    expect(parseWindowsTaskXml(xml(expected).replace(
      '    <AllowStartOnDemand>true</AllowStartOnDemand>\n',
      '',
    ))).toEqual(expected);
    expect(parseWindowsTaskXml(xml(expected).replace(
      '<StopAtDurationEnd>false</StopAtDurationEnd>',
      '',
    ))).toEqual(expected);
  });

  it('accepts the sanitized registered export only with its trusted resolved trigger SID', () => {
    const expected = definition();
    const registered = canonicalRegisteredXml(expected);

    expect(parseWindowsTaskXml(registered, '1.6')).toBeNull();
    expect(parseWindowsTaskXml(registered, '1.6', null)).toBeNull();
    expect(parseWindowsTaskXml(registered, '1.6', OTHER_SID)).toBeNull();
    expect(parseWindowsTaskXml(
      registered.replace(ACCOUNT, OTHER_SID),
      '1.6',
      SID,
    )).toBeNull();
    expect(parseWindowsTaskXml(registered, '1.6', SID)).toEqual(expected);
    expect(parseWindowsTaskXml(registered, '1.6', SID)?.trigger.userId).toBe(SID);
  });

  it('accepts only omitted documented defaults and rejects present nondefault drift', () => {
    const expected = definition();
    const registered = canonicalRegisteredXml(expected);
    const explicitDefaults = registered
      .replace('</Interval></Repetition>',
        '</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>')
      .replace('</Repetition><UserId>', '</Repetition><Enabled>true</Enabled><UserId>')
      .replace('</LogonType></Principal>',
        '</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>')
      .replace('<ExecutionTimeLimit>',
        '<AllowHardTerminate>true</AllowHardTerminate>' +
        '<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>' +
        '<AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled>' +
        '<Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle>' +
        '<WakeToRun>false</WakeToRun><Priority>7</Priority><ExecutionTimeLimit>');
    expect(parseWindowsTaskXml(explicitDefaults, '1.6', SID)).toEqual(expected);

    for (const drifted of [
      explicitDefaults.replace('LeastPrivilege', 'HighestAvailable'),
      explicitDefaults.replace('<Enabled>true</Enabled><UserId>',
        '<Enabled>false</Enabled><UserId>'),
      explicitDefaults.replace('<StopAtDurationEnd>false</StopAtDurationEnd>',
        '<StopAtDurationEnd>true</StopAtDurationEnd>'),
      explicitDefaults.replace('<AllowHardTerminate>true</AllowHardTerminate>',
        '<AllowHardTerminate>false</AllowHardTerminate>'),
      explicitDefaults.replace('<RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
        '<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>'),
      explicitDefaults.replace('<AllowStartOnDemand>true</AllowStartOnDemand>',
        '<AllowStartOnDemand>false</AllowStartOnDemand>'),
      explicitDefaults.replace('<Hidden>false</Hidden>', '<Hidden>true</Hidden>'),
      explicitDefaults.replace('<RunOnlyIfIdle>false</RunOnlyIfIdle>',
        '<RunOnlyIfIdle>true</RunOnlyIfIdle>'),
      explicitDefaults.replace('<WakeToRun>false</WakeToRun>', '<WakeToRun>true</WakeToRun>'),
      explicitDefaults.replace('<Priority>7</Priority>', '<Priority>8</Priority>'),
      registered.replace('<StartWhenAvailable>true</StartWhenAvailable>', ''),
      registered.replace('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>', ''),
    ]) expect(parseWindowsTaskXml(drifted, '1.6', SID)).toBeNull();
  });

  it('strictly validates the inspect triggerUserSid record field', async () => {
    const expected = definition();
    const inspectRecord = {
      exists: true,
      xml: canonicalRegisteredXml(expected),
      triggerUserSid: SID as string | null,
      state: 'Ready',
      enabled: true,
      lastTaskResult: 267011,
      lastRunTime: null,
      nextRunTime: null,
      missedRuns: 0,
      observedAt: '2026-08-27T00:00:00.000Z',
    };
    const scheduler = (record: Record<string, unknown>) => new CurrentUserWindowsTaskScheduler({
      run: async (operation) => operation === 'currentSid' ? SID
        : operation === 'taskSchemaVersion' ? '1.6'
          : record,
    });
    const matched = await scheduler(inspectRecord).inspect();
    expect(matched).toMatchObject({
      kind: 'present', ownership: 'owned', integrity: 'matched', definition: expected,
    });
    await expect(scheduler({ ...inspectRecord, triggerUserSid: 'not-a-sid' }).inspect())
      .rejects.toThrow('windows.task_scheduler.invalid_response');
    const { triggerUserSid: _omitted, ...missingTriggerSid } = inspectRecord;
    await expect(scheduler(missingTriggerSid).inspect())
      .rejects.toThrow('windows.task_scheduler.invalid_response');
  });

  it('accepts supported exports only through the host-reported highest Task schema version', () => {
    const expected = definition();
    expect(parseWindowsTaskXml(xml(expected, '1.3'), '1.3')).toEqual(expected);
    expect(parseWindowsTaskXml(xml(expected, '1.3'), '1.2')).toBeNull();
    expect(parseWindowsTaskXml(xml(expected, '1.2'), '1.3')).toEqual(expected);
    expect(parseWindowsTaskXml(xml(expected, '1.6'), '1.6')).toEqual(expected);
    expect(parseWindowsTaskXml(xml(expected, '1.0'))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected, '1.1'))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected, '1.99'))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected, '2.0'))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected, 'not-a-version'))).toBeNull();
  });

  it('rejects a plausible unsupported COM HighestVersion before task ownership parsing', async () => {
    const scheduler = new CurrentUserWindowsTaskScheduler({
      run: async (operation) => {
        if (operation === 'currentSid') return SID;
        if (operation === 'taskSchemaVersion') return '1.99';
        throw new Error('inspect must not run');
      },
    });
    await expect(scheduler.inspect()).rejects.toThrow(
      'windows.task_scheduler.invalid_schema_version',
    );
  });

  it('binds the actual full Task export and marker to the protected launch manifest', () => {
    const expected = definition();
    const binding = {
      currentSid: SID,
      releaseRoot: expected.action.workingDirectory,
      releaseDigest: DIGEST,
      powerShellPath: expected.action.execute,
      launcherPath: String.raw`C:\릴리스 공간\bridge 1\windows\launch-daemon.ps1`,
      runtimeManifestPath: String.raw`C:\사용자 데이터\runtime.json`,
      taskSemanticFingerprint: fingerprintWindowsTask(expected),
    };
    const exported = xml(expected, '1.6');
    expect(windowsTaskXmlMatchesLaunchBinding(exported, binding, '1.6')).toBe(true);
    const canonicalExport = canonicalRegisteredXml(expected);
    expect(windowsTaskXmlMatchesLaunchBinding(canonicalExport, binding, '1.6')).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(
      canonicalExport, binding, '1.6', SID,
    )).toBe(true);
    expect(windowsTaskXmlMatchesLaunchBinding(
      canonicalExport, binding, '1.6', OTHER_SID,
    )).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(
      canonicalExport, binding, '1.6', 'not-a-sid',
    )).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(
      canonicalExport.replace(ACCOUNT, OTHER_SID), binding, '1.6', SID,
    )).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(exported, {
      ...binding, taskSemanticFingerprint: '0'.repeat(64),
    }, '1.6')).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(
      exported.replace('-SettingsPath', '-DifferentSettingsPath'), binding, '1.6',
    )).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(
      exported.replace(`release=${DIGEST}`, `release=${'b'.repeat(64)}`), binding, '1.6',
    )).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(exported, binding, '1.4')).toBe(false);
  });

  it('fails semantic verification for extra actions, wrong principal/settings, or shell wrappers', () => {
    const expected = definition();
    const valid = xml(expected);
    expect(parseWindowsTaskXml(valid.replace(
      '</Actions>',
      '<Exec><Command>cmd.exe</Command><Arguments>/c whoami</Arguments><WorkingDirectory>C:\\</WorkingDirectory></Exec></Actions>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace('InteractiveToken', 'Password'))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace('<Count>3</Count>', '<Count>10</Count>'))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace(
      '<Repetition><Interval>PT1M</Interval>',
      '<Repetition><Interval>PT2M</Interval>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace(
      '<StopAtDurationEnd>false</StopAtDurationEnd>',
      '<StopAtDurationEnd>true</StopAtDurationEnd>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace(
      '<Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd>',
      '<Interval>PT1M</Interval><Duration>PT2M</Duration><StopAtDurationEnd>false</StopAtDurationEnd>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace('Context="Author"', 'Context="Other"'))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace('</Actions>', '<ComHandler><ClassId>x</ClassId></ComHandler></Actions>'))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace(
      '<Hidden>false</Hidden>',
      '<Hidden>true</Hidden>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace(
      '<AllowStartOnDemand>true</AllowStartOnDemand>',
      '<AllowStartOnDemand>false</AllowStartOnDemand>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace(
      '<AllowStartOnDemand>true</AllowStartOnDemand>',
      '<AllowStartOnDemand>true</AllowStartOnDemand><AllowStartOnDemand>true</AllowStartOnDemand>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(valid.replace(
      '</Settings>',
      '<UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine></Settings>',
    ))).toBeNull();
    const shellWrapped = parseWindowsTaskXml(
      valid.replace('<Command>C:', '<Command>cmd.exe</Command><Ignored>C:'),
    );
    expect(shellWrapped).toBeNull();
  });

  it('accepts namespace-prefix normalization but rejects namespace confusion and duplicates', () => {
    const expected = definition();
    const prefixed = xml(expected)
      .replace('<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
        '<t:Task version="1.2" xmlns:t="http://schemas.microsoft.com/windows/2004/02/mit/task">')
      .replace('</Task>', '</t:Task>')
      .replace(/<(\/)?(RegistrationInfo|Description|Triggers|LogonTrigger|Repetition|Enabled|UserId|Principals|Principal|LogonType|RunLevel|Settings|MultipleInstancesPolicy|DisallowStartIfOnBatteries|StopIfGoingOnBatteries|AllowHardTerminate|StartWhenAvailable|RunOnlyIfNetworkAvailable|IdleSettings|Duration|WaitTimeout|StopOnIdleEnd|RestartOnIdle|StopAtDurationEnd|AllowStartOnDemand|Hidden|RunOnlyIfIdle|WakeToRun|ExecutionTimeLimit|Priority|RestartOnFailure|Interval|Count|Actions|Exec|Command|Arguments|WorkingDirectory)(?=[ >])/gu,
        '<$1t:$2');
    expect(parseWindowsTaskXml(prefixed)).toEqual(expected);
    expect(parseWindowsTaskXml(xml(expected).replace(
      '<Enabled>true</Enabled>',
      '<evil:Enabled xmlns:evil="urn:evil">true</evil:Enabled>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected).replace(
      '</Triggers>',
      '<LogonTrigger><Enabled>true</Enabled><UserId>S-1-5-18</UserId></LogonTrigger></Triggers>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected).replace(
      '</Principals>',
      '<Principal id="Other"><UserId>S-1-5-18</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>',
    ))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected).replace(
      '<Settings>',
      '<Settings><!-- unexpected -->',
    ))).toBeNull();
    expect(parseWindowsTaskXml(xml(expected).replace(
      '<Settings>',
      '<Settings><?unexpected value?>',
    ))).toBeNull();
  });

  it('keeps the ownership marker non-secret and bound to semantic drift, not the disabled bit', () => {
    const sentinel = 'xoxb-TOKEN_SENTINEL-never-serialize';
    const expected = definition();
    const marker = parseWindowsTaskMarker(expected.description);
    expect(expected.description.startsWith(WINDOWS_TASK_DESCRIPTION_PREFIX)).toBe(true);
    expect(marker).toEqual({
      releaseDigest: DIGEST,
      semanticFingerprint: fingerprintWindowsTask(expected),
    });
    expect(JSON.stringify(expected)).not.toContain(sentinel);
    expect(xml(expected)).not.toContain(sentinel);
    expect(expected.description).not.toMatch(/token|secret|password|authorization/iu);
    expect(fingerprintWindowsTask({ ...expected, enabled: false })).toBe(marker?.semanticFingerprint);
    expect(fingerprintWindowsTask({
      ...expected,
      action: { ...expected.action, workingDirectory: String.raw`C:\drifted` },
    })).not.toBe(marker?.semanticFingerprint);
  });
});

export { definition as windowsTaskDefinitionFixture, xml as windowsTaskXmlFixture };
