import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  createWindowsTaskDefinition,
  CurrentUserTaskSchedulerPowerShellRunner,
  escapeTaskXmlTextForTest,
  fingerprintWindowsTask,
  joinWindowsArguments,
  parseWindowsArguments,
  parseWindowsTaskMarker,
  parseWindowsTaskXml,
  quoteWindowsArgument,
  WINDOWS_TASK_DESCRIPTION_PREFIX,
  WINDOWS_TASK_NAME,
  type WindowsTaskDefinition,
} from '../src/windows/task-scheduler.js';

const SID = 'S-1-5-21-100-200-300-1001';
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

function xml(value: WindowsTaskDefinition): string {
  const e = escapeTaskXmlTextForTest;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${e(value.description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${e(value.trigger.userId)}</UserId></LogonTrigger></Triggers>
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

describe('Windows Scheduled Task semantic contract', () => {
  windowsIt('COM validate-only accepts the desired definition and leaves no synthetic task', async () => {
    const runner = new CurrentUserTaskSchedulerPowerShellRunner();
    const currentSid = await runner.run('currentSid', {});
    expect(currentSid).toMatch(/^S-[0-9]+(?:-[0-9]+)+$/u);
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
      .replace(/<(\/)?(RegistrationInfo|Description|Triggers|LogonTrigger|Enabled|UserId|Principals|Principal|LogonType|RunLevel|Settings|MultipleInstancesPolicy|DisallowStartIfOnBatteries|StopIfGoingOnBatteries|AllowHardTerminate|StartWhenAvailable|RunOnlyIfNetworkAvailable|IdleSettings|Duration|WaitTimeout|StopOnIdleEnd|RestartOnIdle|AllowStartOnDemand|Hidden|RunOnlyIfIdle|WakeToRun|ExecutionTimeLimit|Priority|RestartOnFailure|Interval|Count|Actions|Exec|Command|Arguments|WorkingDirectory)(?=[ >])/gu,
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
