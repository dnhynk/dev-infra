import { describe, expect, it } from 'vitest';
import {
  createWindowsTaskDefinition,
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

function definition(): WindowsTaskDefinition {
  return createWindowsTaskDefinition({
    currentSid: SID,
    releaseDigest: DIGEST,
    nodePath: String.raw`C:\Program Files\nodejs\node.exe`,
    cliPath: String.raw`C:\릴리스 공간\bridge 1\dist\cli.js`,
    configPath: String.raw`C:\사용자 데이터\bridge config.json`,
    statePath: String.raw`C:\사용자 데이터\state.db`,
    orcaPath: String.raw`C:\Program Files\Orca\orca.exe`,
    logDir: String.raw`C:\사용자 데이터\로그`,
    workingDirectory: String.raw`C:\릴리스 공간\bridge 1`,
  });
}

function xml(value: WindowsTaskDefinition): string {
  const e = escapeTaskXmlTextForTest;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${e(value.description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${e(value.trigger.userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${e(value.principal.userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>${String(value.enabled).toLowerCase()}</Enabled>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${e(value.action.execute)}</Command><Arguments>${e(value.action.arguments)}</Arguments><WorkingDirectory>${e(value.action.workingDirectory)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

describe('Windows Scheduled Task semantic contract', () => {
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
      executionTimeLimit: 'PT0S',
      restartCount: 3,
      restartInterval: 'PT1M',
    });
    expect(parseWindowsArguments(parsed!.action.arguments)).toEqual([
      expected.action.arguments && String.raw`C:\릴리스 공간\bridge 1\dist\cli.js`,
      'daemon', '--config', String.raw`C:\사용자 데이터\bridge config.json`,
      '--state', String.raw`C:\사용자 데이터\state.db`,
      '--orca', String.raw`C:\Program Files\Orca\orca.exe`,
      '--log-dir', String.raw`C:\사용자 데이터\로그`,
    ]);
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
    const shellWrapped = parseWindowsTaskXml(
      valid.replace('<Command>C:', '<Command>cmd.exe</Command><Ignored>C:'),
    );
    expect(shellWrapped?.action.execute).toBe('cmd.exe');
    expect(fingerprintWindowsTask(shellWrapped!)).not.toBe(
      parseWindowsTaskMarker(expected.description)?.semanticFingerprint,
    );
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
