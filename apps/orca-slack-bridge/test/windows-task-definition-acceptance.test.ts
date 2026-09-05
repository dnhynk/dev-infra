import { describe, expect, it } from 'vitest';

import {
  createWindowsTaskDefinition,
  escapeTaskXmlTextForTest,
  fingerprintWindowsTask,
  parseWindowsArguments,
  parseWindowsTaskMarker,
  parseWindowsTaskXml,
  windowsTaskXmlMatchesLaunchBinding,
  WINDOWS_TASK_NAME,
} from '../src/windows/task-scheduler.js';

const SID = 'S-1-5-21-100-200-300-1001';
const DIGEST = 'a'.repeat(64);
const POWERSHELL = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const ROOT = String.raw`C:\ProgramData\Orca Bridge\releases\release-a`;
const LAUNCHER = String.raw`C:\ProgramData\Orca Bridge\releases\release-a\windows\launch-daemon.ps1`;
const MANIFEST = String.raw`C:\Users\operator\AppData\Local\Orca Bridge\runtime-manifest.json`;

function exportedXml(): string {
  const definition = createWindowsTaskDefinition({
    currentSid: SID,
    releaseDigest: DIGEST,
    powerShellPath: POWERSHELL,
    launcherPath: LAUNCHER,
    runtimeManifestPath: MANIFEST,
    workingDirectory: ROOT,
  });
  const e = escapeTaskXmlTextForTest;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.6" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${e(definition.description)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled><UserId>${e(SID)}</UserId></LogonTrigger><RegistrationTrigger><Repetition><Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition><Enabled>true</Enabled></RegistrationTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${e(SID)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>false</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings>
  <Actions Context="Author"><Exec><Command>${e(POWERSHELL)}</Command><Arguments>${e(definition.action.arguments)}</Arguments><WorkingDirectory>${e(ROOT)}</WorkingDirectory></Exec></Actions>
</Task>`;
}

describe('O1-7 CI-safe Windows Task definition acceptance', () => {
  it('pins the current-user, IgnoreNew, demand-start, battery, and bounded restart defaults', () => {
    const definition = createWindowsTaskDefinition({
      currentSid: SID,
      releaseDigest: DIGEST,
      powerShellPath: POWERSHELL,
      launcherPath: LAUNCHER,
      runtimeManifestPath: MANIFEST,
      workingDirectory: ROOT,
    });

    expect(definition).toMatchObject({
      taskName: WINDOWS_TASK_NAME,
      enabled: true,
      principal: { userId: SID, logonType: 'InteractiveToken', runLevel: 'Limited' },
      trigger: {
        kind: 'AtLogOn', userId: SID, enabled: true,
        repetition: { interval: 'PT1M', duration: null, stopAtDurationEnd: false },
      },
      settings: {
        startWhenAvailable: true,
        multipleInstances: 'IgnoreNew',
        allowStartOnBatteries: true,
        dontStopOnBatteries: true,
        allowHardTerminate: true,
        runOnlyIfNetworkAvailable: false,
        allowDemandStart: true,
        hidden: false,
        runOnlyIfIdle: false,
        wakeToRun: false,
        executionTimeLimit: 'PT0S',
        priority: 7,
        restartCount: 3,
        restartInterval: 'PT1M',
      },
    });
    expect(parseWindowsArguments(definition.action.arguments)).toEqual([
      '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', LAUNCHER, '-SettingsPath', MANIFEST,
    ]);
    expect(parseWindowsTaskMarker(definition.description)).toEqual({
      releaseDigest: DIGEST,
      semanticFingerprint: fingerprintWindowsTask(definition),
    });
  });

  it('matches a semantic export and fails closed on restart, principal, instance, or action drift', () => {
    const xml = exportedXml();
    const parsed = parseWindowsTaskXml(xml, '1.6');
    expect(parsed).not.toBeNull();
    const fingerprint = fingerprintWindowsTask(parsed!);
    const binding = {
      currentSid: SID,
      releaseRoot: ROOT,
      releaseDigest: DIGEST,
      powerShellPath: POWERSHELL,
      launcherPath: LAUNCHER,
      runtimeManifestPath: MANIFEST,
      taskSemanticFingerprint: fingerprint,
    };
    expect(windowsTaskXmlMatchesLaunchBinding(xml, binding, '1.6')).toBe(true);
    expect(windowsTaskXmlMatchesLaunchBinding(
      xml.replace('&quot;Hidden&quot;', '&quot;Normal&quot;'), binding, '1.6',
    )).toBe(false);
    expect(windowsTaskXmlMatchesLaunchBinding(
      xml.replace('&quot;-WindowStyle&quot; &quot;Hidden&quot; ', ''), binding, '1.6',
    )).toBe(false);

    for (const drifted of [
      xml.replace('<Count>3</Count>', '<Count>4</Count>'),
      xml.replace(
        '<Repetition><Interval>PT1M</Interval>',
        '<Repetition><Interval>PT2M</Interval>',
      ),
      xml.replace(
        '<StopAtDurationEnd>false</StopAtDurationEnd>',
        '<StopAtDurationEnd>true</StopAtDurationEnd>',
      ),
      xml.replace(
        '<Interval>PT1M</Interval><StopAtDurationEnd>false</StopAtDurationEnd>',
        '<Interval>PT1M</Interval><Duration>PT2M</Duration><StopAtDurationEnd>false</StopAtDurationEnd>',
      ),
      xml.replace('InteractiveToken', 'Password'),
      xml.replace('IgnoreNew', 'Parallel'),
      xml.replace('<Command>C:', '<Command>cmd.exe</Command><Unexpected>C:'),
    ]) expect(parseWindowsTaskXml(drifted, '1.6')).toBeNull();
  });
});
