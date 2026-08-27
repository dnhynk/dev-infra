import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  operationalStatusWindowsTrustedPowerShell,
} from '../operational/status-capability.js';

export const WINDOWS_TASK_NAME = 'Orca Slack Bridge Daemon';
export const WINDOWS_TASK_DESCRIPTION_PREFIX = 'ORCA_SLACK_BRIDGE_MANAGED_V1';
export const WINDOWS_TASK_RESTART_COUNT = 3;
export const WINDOWS_TASK_RESTART_INTERVAL = 'PT1M';
export const WINDOWS_TASK_EXECUTION_TIME_LIMIT = 'PT0S';
const WINDOWS_TASK_RESULT_NOT_YET_RUN = 267011;
const WINDOWS_TASK_INFORMATIONAL_RESULT_MIN = 267008;
const WINDOWS_TASK_INFORMATIONAL_RESULT_MAX = 267015;

export type WindowsTaskDefinition = {
  readonly taskName: typeof WINDOWS_TASK_NAME;
  readonly description: string;
  readonly enabled: boolean;
  readonly principal: {
    readonly userId: string;
    readonly logonType: 'InteractiveToken';
    readonly runLevel: 'Limited';
  };
  readonly trigger: {
    readonly kind: 'AtLogOn';
    readonly userId: string;
    readonly enabled: true;
  };
  readonly settings: {
    readonly startWhenAvailable: true;
    readonly multipleInstances: 'IgnoreNew';
    readonly allowStartOnBatteries: true;
    readonly dontStopOnBatteries: true;
    readonly executionTimeLimit: typeof WINDOWS_TASK_EXECUTION_TIME_LIMIT;
    readonly restartCount: typeof WINDOWS_TASK_RESTART_COUNT;
    readonly restartInterval: typeof WINDOWS_TASK_RESTART_INTERVAL;
  };
  readonly action: {
    readonly execute: string;
    readonly arguments: string;
    readonly workingDirectory: string;
  };
};

export type WindowsTaskRuntime = {
  readonly state: 'running' | 'ready' | 'queued' | 'disabled' | 'unknown';
  /** Raw Task Scheduler engine state, kept separate because disabling does not stop a live instance. */
  readonly executionState: 'running' | 'ready' | 'queued' | 'unknown';
  readonly enabled: boolean;
  readonly hasRun: boolean;
  readonly lastTaskResult: number | null;
};

export type WindowsTaskMarker = {
  readonly releaseDigest: string;
  readonly semanticFingerprint: string;
};

export type ManagedWindowsTaskSnapshot =
  | { readonly kind: 'absent'; readonly currentSid: string }
  | {
      readonly kind: 'present';
      readonly currentSid: string;
      readonly xml: string;
      readonly definition: WindowsTaskDefinition | null;
      readonly marker: WindowsTaskMarker | null;
      readonly runtime: WindowsTaskRuntime;
      readonly ownership: 'owned' | 'foreign' | 'other-principal';
      readonly integrity: 'matched' | 'drifted';
    };

export type PowerShellTaskRecord = {
  readonly exists: boolean;
  readonly xml?: string;
  readonly state?: string;
  readonly enabled?: boolean;
  readonly lastTaskResult?: number | null;
  readonly lastRunTime?: string | null;
};

export type TaskSchedulerPowerShellOperation =
  | 'currentSid'
  | 'inspect'
  | 'register'
  | 'restoreXml'
  | 'disable'
  | 'start'
  | 'unregister';

export interface TaskSchedulerPowerShellRunner {
  run(operation: TaskSchedulerPowerShellOperation, input: unknown): Promise<unknown>;
}

const STATIC_POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$operation = $env:ORCA_TASK_OPERATION
$taskPath = '\'
$raw = [Console]::In.ReadToEnd()
$inputObject = if ([String]::IsNullOrWhiteSpace($raw)) { $null } else { $raw | ConvertFrom-Json }

function Write-Result([object]$value) {
  [Console]::Out.Write(($value | ConvertTo-Json -Compress -Depth 12))
}

function Assert-ExpectedTaskXml([string]$taskName, [string]$expectedXml) {
  $current = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
  if ($null -eq $current -or (Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName) -cne $expectedXml) { throw 'task changed before mutation' }
}

switch ($operation) {
  'currentSid' {
    Write-Result ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  }
  'inspect' {
    $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
      Write-Result @{ exists = $false }
      break
    }
    $info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $inputObject.taskName
    $lastRun = if ($info.LastTaskResult -eq 267011 -or $info.LastRunTime.Year -le 2000) { $null } else { $info.LastRunTime.ToUniversalTime().ToString('o') }
    Write-Result @{
      exists = $true
      xml = (Export-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName)
      state = [String]$task.State
      enabled = [bool]$task.Settings.Enabled
      lastTaskResult = [int64]$info.LastTaskResult
      lastRunTime = $lastRun
    }
  }
  'register' {
    $d = $inputObject.definition
    $action = New-ScheduledTaskAction -Execute $d.action.execute -Argument $d.action.arguments -WorkingDirectory $d.action.workingDirectory
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $d.trigger.userId
    $principal = New-ScheduledTaskPrincipal -UserId $d.principal.userId -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    if ([bool]$inputObject.replace) {
      $current = Get-ScheduledTask -TaskPath $taskPath -TaskName $d.taskName -ErrorAction SilentlyContinue
      if ($null -eq $current -or (Export-ScheduledTask -TaskPath $taskPath -TaskName $d.taskName) -cne [String]$inputObject.expectedXml) { throw 'task changed before replace' }
      Register-ScheduledTask -TaskPath $taskPath -TaskName $d.taskName -Description $d.description -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
    } else {
      Register-ScheduledTask -TaskPath $taskPath -TaskName $d.taskName -Description $d.description -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    }
    if (-not [bool]$d.enabled) { Disable-ScheduledTask -TaskPath $taskPath -TaskName $d.taskName | Out-Null }
    Write-Result @{ ok = $true }
  }
  'restoreXml' {
    Assert-ExpectedTaskXml $inputObject.taskName $inputObject.expectedCurrentXml
    Register-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName -Xml $inputObject.xml -Force | Out-Null
    Write-Result @{ ok = $true }
  }
  'disable' {
    Assert-ExpectedTaskXml $inputObject.taskName $inputObject.expectedXml
    Disable-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName | Out-Null
    Write-Result @{ ok = $true }
  }
  'start' {
    Assert-ExpectedTaskXml $inputObject.taskName $inputObject.expectedXml
    Start-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName
    Write-Result @{ ok = $true }
  }
  'unregister' {
    Assert-ExpectedTaskXml $inputObject.taskName $inputObject.expectedXml
    Unregister-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName -Confirm:$false
    Write-Result @{ ok = $true }
  }
  default { throw 'unsupported operation' }
}
`;

function safePowerShellEnvironment(
  operation: TaskSchedulerPowerShellOperation,
  root: string,
): NodeJS.ProcessEnv {
  return { SystemRoot: root, WINDIR: root, ORCA_TASK_OPERATION: operation };
}

/** Production management boundary. Paths travel only as JSON on stdin, never through interpolation. */
export class CurrentUserTaskSchedulerPowerShellRunner implements TaskSchedulerPowerShellRunner {
  constructor(private readonly timeoutMilliseconds = 30_000) {}

  async run(operation: TaskSchedulerPowerShellOperation, input: unknown): Promise<unknown> {
    if (process.platform !== 'win32') throw new Error('windows.task_scheduler.unsupported_platform');
    let trusted: ReturnType<typeof operationalStatusWindowsTrustedPowerShell>;
    try { trusted = operationalStatusWindowsTrustedPowerShell(); } catch {
      throw new Error('windows.task_scheduler.powershell_unavailable');
    }
    const encoded = Buffer.from(STATIC_POWERSHELL, 'utf16le').toString('base64');
    return await new Promise<unknown>((resolve, reject) => {
      const child = spawn(trusted.executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encoded,
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: safePowerShellEnvironment(operation, trusted.root),
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as unknown);
        } catch {
          reject(new Error('windows.task_scheduler.invalid_response'));
        }
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('windows.task_scheduler.timeout'));
      }, this.timeoutMilliseconds);
      timer.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > 1024 * 1024) {
          child.kill();
          finish(new Error('windows.task_scheduler.response_too_large'));
          return;
        }
        stdout.push(chunk);
      });
      // stderr is deliberately drained but never surfaced: PowerShell may echo input paths.
      child.stderr.resume();
      child.once('error', () => finish(new Error('windows.task_scheduler.launch_failed')));
      child.once('exit', (code) => {
        if (code !== 0) finish(new Error('windows.task_scheduler.command_failed'));
        else finish();
      });
      child.stdin.end(JSON.stringify(input));
    });
  }
}

function encodeXmlText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function xmlBlocks(xml: string, tag: string): readonly string[] {
  const safe = tag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [...xml.matchAll(new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)</${safe}>`, 'giu'))]
    .map((match) => match[1] ?? '');
}

function oneXmlBlock(xml: string, tag: string): string | null {
  const blocks = xmlBlocks(xml, tag);
  return blocks.length === 1 ? blocks[0] ?? null : null;
}

function oneXmlElement(xml: string, tag: string): { readonly attributes: string; readonly body: string } | null {
  const safe = tag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const matches = [...xml.matchAll(
    new RegExp(`<${safe}(\\s[^>]*)?>([\\s\\S]*?)</${safe}>`, 'giu'),
  )];
  return matches.length === 1 ? {
    attributes: matches[0]?.[1] ?? '',
    body: matches[0]?.[2] ?? '',
  } : null;
}

function xmlAttribute(attributes: string, name: string): string | null {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = new RegExp(`(?:^|\\s)${safe}\\s*=\\s*"([^"]*)"`, 'iu').exec(attributes);
  return match === null ? null : decodeXmlText(match[1] ?? '');
}

function xmlText(xml: string, tag: string): string | null {
  const value = oneXmlBlock(xml, tag);
  return value === null ? null : decodeXmlText(value.trim());
}

function xmlBoolean(xml: string, tag: string): boolean | null {
  const value = xmlText(xml, tag)?.toLowerCase();
  return value === 'true' ? true : value === 'false' ? false : null;
}

function xmlInteger(xml: string, tag: string): number | null {
  const value = xmlText(xml, tag);
  if (value === null || !/^[0-9]+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Quotes one argv element according to CommandLineToArgvW backslash/quote rules. */
export function quoteWindowsArgument(value: string): string {
  if (value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new TypeError('windows.task.argument_contains_control_character');
  }
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    quoted += '\\'.repeat(backslashes) + character;
    backslashes = 0;
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"';
}

export function joinWindowsArguments(values: readonly string[]): string {
  return values.map(quoteWindowsArgument).join(' ');
}

/** Pure inverse used for owned-action inspection and quoting round-trip tests. */
export function parseWindowsArguments(commandLine: string): readonly string[] | null {
  const result: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (index < commandLine.length && /\s/u.test(commandLine[index] ?? '')) index += 1;
    if (index >= commandLine.length) break;
    let value = '';
    let quoted = false;
    let sawToken = false;
    while (index < commandLine.length) {
      let backslashes = 0;
      while (commandLine[index] === '\\') {
        backslashes += 1;
        index += 1;
      }
      if (commandLine[index] === '"') {
        value += '\\'.repeat(Math.floor(backslashes / 2));
        if (backslashes % 2 === 1) {
          value += '"';
          index += 1;
          sawToken = true;
          continue;
        }
        quoted = !quoted;
        index += 1;
        sawToken = true;
        continue;
      }
      value += '\\'.repeat(backslashes);
      if (index >= commandLine.length || (!quoted && /\s/u.test(commandLine[index] ?? ''))) break;
      value += commandLine[index] ?? '';
      index += 1;
      sawToken = true;
    }
    if (quoted || !sawToken) return null;
    result.push(value);
    while (index < commandLine.length && /\s/u.test(commandLine[index] ?? '')) index += 1;
  }
  return result;
}

function fingerprintProjection(definition: WindowsTaskDefinition): object {
  return {
    taskName: definition.taskName,
    principal: definition.principal,
    trigger: definition.trigger,
    settings: definition.settings,
    action: definition.action,
  };
}

/** Stable non-secret semantic identity; description and the temporary enabled bit are excluded. */
export function fingerprintWindowsTask(definition: WindowsTaskDefinition): string {
  return createHash('sha256')
    .update(JSON.stringify(fingerprintProjection(definition)), 'utf8')
    .digest('hex');
}

export function windowsTaskDescription(
  releaseDigest: string,
  semanticFingerprint: string,
): string {
  if (!/^[a-f0-9]{64}$/u.test(releaseDigest) || !/^[a-f0-9]{64}$/u.test(semanticFingerprint)) {
    throw new TypeError('windows.task.invalid_fingerprint');
  }
  return `${WINDOWS_TASK_DESCRIPTION_PREFIX};release=${releaseDigest};semantic=${semanticFingerprint}`;
}

export function parseWindowsTaskMarker(description: string): WindowsTaskMarker | null {
  const match = new RegExp(
    `^${WINDOWS_TASK_DESCRIPTION_PREFIX};release=([a-f0-9]{64});semantic=([a-f0-9]{64})$`,
    'u',
  ).exec(description);
  return match === null ? null : {
    releaseDigest: match[1]!,
    semanticFingerprint: match[2]!,
  };
}

export function createWindowsTaskDefinition(input: {
  readonly currentSid: string;
  readonly releaseDigest: string;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly configPath: string;
  readonly statePath: string;
  readonly orcaPath: string;
  readonly logDir: string;
  readonly workingDirectory: string;
}): WindowsTaskDefinition {
  const withoutDescription: WindowsTaskDefinition = {
    taskName: WINDOWS_TASK_NAME,
    description: '',
    enabled: true,
    principal: {
      userId: input.currentSid,
      logonType: 'InteractiveToken',
      runLevel: 'Limited',
    },
    trigger: { kind: 'AtLogOn', userId: input.currentSid, enabled: true },
    settings: {
      startWhenAvailable: true,
      multipleInstances: 'IgnoreNew',
      allowStartOnBatteries: true,
      dontStopOnBatteries: true,
      executionTimeLimit: WINDOWS_TASK_EXECUTION_TIME_LIMIT,
      restartCount: WINDOWS_TASK_RESTART_COUNT,
      restartInterval: WINDOWS_TASK_RESTART_INTERVAL,
    },
    action: {
      execute: input.nodePath,
      arguments: joinWindowsArguments([
        input.cliPath,
        'daemon',
        '--config', input.configPath,
        '--state', input.statePath,
        '--orca', input.orcaPath,
        '--log-dir', input.logDir,
      ]),
      workingDirectory: input.workingDirectory,
    },
  };
  return {
    ...withoutDescription,
    description: windowsTaskDescription(
      input.releaseDigest,
      fingerprintWindowsTask(withoutDescription),
    ),
  };
}

/** Parses the exported Task Scheduler XML and rejects duplicate/missing semantic components. */
export function parseWindowsTaskXml(xml: string): WindowsTaskDefinition | null {
  const registration = oneXmlBlock(xml, 'RegistrationInfo');
  const principals = oneXmlBlock(xml, 'Principals');
  const principalElement = principals === null ? null : oneXmlElement(principals, 'Principal');
  const principal = principalElement?.body ?? null;
  const triggers = oneXmlBlock(xml, 'Triggers');
  const logonTrigger = triggers === null ? null : oneXmlBlock(triggers, 'LogonTrigger');
  const settings = oneXmlBlock(xml, 'Settings');
  const restart = settings === null ? null : oneXmlBlock(settings, 'RestartOnFailure');
  const actionsElement = oneXmlElement(xml, 'Actions');
  const actions = actionsElement?.body ?? null;
  const exec = actions === null ? null : oneXmlBlock(actions, 'Exec');
  if (registration === null || principal === null || logonTrigger === null || settings === null ||
      restart === null || exec === null) return null;
  const description = xmlText(registration, 'Description');
  const principalId = principalElement === null ? null : xmlAttribute(principalElement.attributes, 'id');
  const actionContext = actionsElement === null ? null : xmlAttribute(actionsElement.attributes, 'Context');
  const principalUser = xmlText(principal, 'UserId');
  const logonType = xmlText(principal, 'LogonType');
  const runLevel = xmlText(principal, 'RunLevel');
  const triggerUser = xmlText(logonTrigger, 'UserId');
  const triggerEnabled = xmlBoolean(logonTrigger, 'Enabled');
  const enabled = xmlBoolean(settings, 'Enabled');
  const startWhenAvailable = xmlBoolean(settings, 'StartWhenAvailable');
  const multipleInstances = xmlText(settings, 'MultipleInstancesPolicy');
  const disallowBattery = xmlBoolean(settings, 'DisallowStartIfOnBatteries');
  const stopBattery = xmlBoolean(settings, 'StopIfGoingOnBatteries');
  const executionLimit = xmlText(settings, 'ExecutionTimeLimit');
  const restartCount = xmlInteger(restart, 'Count');
  const restartInterval = xmlText(restart, 'Interval');
  const execute = xmlText(exec, 'Command');
  const args = xmlText(exec, 'Arguments');
  const workingDirectory = xmlText(exec, 'WorkingDirectory');
  if (description === null || principalId === null || actionContext !== principalId ||
      principalUser === null || triggerUser === null || execute === null ||
      args === null || workingDirectory === null || enabled === null ||
      logonType !== 'InteractiveToken' || runLevel !== 'LeastPrivilege' || triggerEnabled !== true ||
      startWhenAvailable !== true || multipleInstances !== 'IgnoreNew' || disallowBattery !== false ||
      stopBattery !== false || executionLimit !== WINDOWS_TASK_EXECUTION_TIME_LIMIT ||
      restartCount !== WINDOWS_TASK_RESTART_COUNT || restartInterval !== WINDOWS_TASK_RESTART_INTERVAL ||
      /<(?:BootTrigger|CalendarTrigger|EventTrigger|IdleTrigger|RegistrationTrigger|SessionStateChangeTrigger|TimeTrigger)\b/iu.test(triggers ?? '') ||
      /<(?:ComHandler|SendEmail|ShowMessage)\b/iu.test(actions ?? '')) {
    return null;
  }
  return {
    taskName: WINDOWS_TASK_NAME,
    description,
    enabled,
    principal: { userId: principalUser, logonType: 'InteractiveToken', runLevel: 'Limited' },
    trigger: { kind: 'AtLogOn', userId: triggerUser, enabled: true },
    settings: {
      startWhenAvailable: true,
      multipleInstances: 'IgnoreNew',
      allowStartOnBatteries: true,
      dontStopOnBatteries: true,
      executionTimeLimit: WINDOWS_TASK_EXECUTION_TIME_LIMIT,
      restartCount: WINDOWS_TASK_RESTART_COUNT,
      restartInterval: WINDOWS_TASK_RESTART_INTERVAL,
    },
    action: { execute, arguments: args, workingDirectory },
  };
}

function sameDefinition(actual: WindowsTaskDefinition, expected: WindowsTaskDefinition): boolean {
  return actual.enabled === expected.enabled && actual.description === expected.description &&
    JSON.stringify(fingerprintProjection(actual)) === JSON.stringify(fingerprintProjection(expected));
}

function parseRuntime(record: PowerShellTaskRecord, definition: WindowsTaskDefinition | null): WindowsTaskRuntime {
  const state = String(record.state ?? '').toLowerCase();
  const enabled = record.enabled ?? definition?.enabled ?? false;
  const executionState = state === 'running' || state === 'ready' || state === 'queued'
    ? state
    : 'unknown';
  const rawResult = typeof record.lastTaskResult === 'number' && Number.isSafeInteger(record.lastTaskResult)
    ? record.lastTaskResult
    : null;
  const lastTaskResult = rawResult !== null && rawResult >= WINDOWS_TASK_INFORMATIONAL_RESULT_MIN &&
    rawResult <= WINDOWS_TASK_INFORMATIONAL_RESULT_MAX ? 0 : rawResult;
  return {
    state: !enabled ? 'disabled' : executionState,
    executionState,
    enabled,
    hasRun: record.lastRunTime !== null && record.lastRunTime !== undefined &&
      record.lastTaskResult !== WINDOWS_TASK_RESULT_NOT_YET_RUN,
    lastTaskResult,
  };
}

function taskRecord(value: unknown): PowerShellTaskRecord {
  if (value === null || typeof value !== 'object') {
    throw new Error('windows.task_scheduler.invalid_response');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['exists'] !== 'boolean') throw new Error('windows.task_scheduler.invalid_response');
  return record as PowerShellTaskRecord;
}

function sidResult(value: unknown): string {
  if (typeof value !== 'string' || !/^S-[0-9]+(?:-[0-9]+)+$/u.test(value)) {
    throw new Error('windows.task_scheduler.invalid_sid');
  }
  return value;
}

export class CurrentUserWindowsTaskScheduler {
  constructor(private readonly runner: TaskSchedulerPowerShellRunner) {}

  async currentSid(): Promise<string> {
    return sidResult(await this.runner.run('currentSid', {}));
  }

  async inspect(): Promise<ManagedWindowsTaskSnapshot> {
    const currentSid = await this.currentSid();
    const record = taskRecord(await this.runner.run('inspect', { taskName: WINDOWS_TASK_NAME }));
    if (!record.exists) return { kind: 'absent', currentSid };
    if (typeof record.xml !== 'string') throw new Error('windows.task_scheduler.invalid_response');
    const definition = parseWindowsTaskXml(record.xml);
    const description = definition?.description ?? (() => {
      const registration = oneXmlBlock(record.xml!, 'RegistrationInfo');
      return registration === null ? null : xmlText(registration, 'Description');
    })();
    const marker = description === null ? null : parseWindowsTaskMarker(description);
    const managedDescription = description === WINDOWS_TASK_DESCRIPTION_PREFIX ||
      description?.startsWith(`${WINDOWS_TASK_DESCRIPTION_PREFIX};`) === true;
    const principalUser = definition?.principal.userId ?? (() => {
      const principals = oneXmlBlock(record.xml!, 'Principals');
      const principal = principals === null ? null : oneXmlBlock(principals, 'Principal');
      return principal === null ? null : xmlText(principal, 'UserId');
    })();
    const ownership = !managedDescription
      ? 'foreign'
      : principalUser !== currentSid
        ? 'other-principal'
        : 'owned';
    const integrity = definition !== null && marker !== null && principalUser === currentSid &&
      definition.trigger.userId === currentSid &&
      fingerprintWindowsTask(definition) === marker.semanticFingerprint
      ? 'matched'
      : 'drifted';
    return {
      kind: 'present', currentSid, xml: record.xml, definition, marker,
      runtime: parseRuntime(record, definition), ownership, integrity,
    };
  }

  async register(definition: WindowsTaskDefinition, replace: boolean, expectedXml?: string): Promise<void> {
    await this.runner.run('register', { definition, replace, expectedXml: expectedXml ?? null });
  }

  async restore(xml: string, expectedCurrentXml: string): Promise<void> {
    await this.runner.run('restoreXml', { taskName: WINDOWS_TASK_NAME, xml, expectedCurrentXml });
  }

  async disable(expectedXml: string): Promise<void> {
    await this.runner.run('disable', { taskName: WINDOWS_TASK_NAME, expectedXml });
  }

  async start(expectedXml: string): Promise<void> {
    await this.runner.run('start', { taskName: WINDOWS_TASK_NAME, expectedXml });
  }

  async unregister(expectedXml: string): Promise<void> {
    await this.runner.run('unregister', { taskName: WINDOWS_TASK_NAME, expectedXml });
  }

  definitionsMatch(actual: WindowsTaskDefinition | null, expected: WindowsTaskDefinition): boolean {
    return actual !== null && sameDefinition(actual, expected);
  }
}

/** Exported for tests and audit tooling without exposing a raw XML canonicalization claim. */
export function escapeTaskXmlTextForTest(value: string): string {
  return encodeXmlText(value);
}
