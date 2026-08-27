import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { win32 } from 'node:path';
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import {
  operationalStatusWindowsTrustedPowerShell,
} from '../operational/status-capability.js';

export const WINDOWS_TASK_NAME = 'Orca Slack Bridge Daemon';
export const WINDOWS_TASK_DESCRIPTION_PREFIX = 'ORCA_SLACK_BRIDGE_MANAGED_V1';
export const WINDOWS_TASK_RESTART_COUNT = 3;
export const WINDOWS_TASK_RESTART_INTERVAL = 'PT1M';
export const WINDOWS_TASK_REPETITION_INTERVAL = 'PT1M';
export const WINDOWS_TASK_EXECUTION_TIME_LIMIT = 'PT0S';
export const WINDOWS_TASK_IDLE_DURATION = 'PT10M';
export const WINDOWS_TASK_IDLE_WAIT_TIMEOUT = 'PT1H';
export const WINDOWS_TASK_PRIORITY = 7;
export const WINDOWS_TASK_RESTART_INTERVAL_SECONDS = 60;
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
    readonly repetition: {
      readonly interval: typeof WINDOWS_TASK_REPETITION_INTERVAL;
      readonly duration: null;
      readonly stopAtDurationEnd: false;
    };
  };
  readonly settings: {
    readonly startWhenAvailable: true;
    readonly multipleInstances: 'IgnoreNew';
    readonly allowStartOnBatteries: true;
    readonly dontStopOnBatteries: true;
    readonly allowHardTerminate: true;
    readonly runOnlyIfNetworkAvailable: false;
    readonly idle: {
      readonly duration: typeof WINDOWS_TASK_IDLE_DURATION;
      readonly waitTimeout: typeof WINDOWS_TASK_IDLE_WAIT_TIMEOUT;
      readonly stopOnIdleEnd: true;
      readonly restartOnIdle: false;
    };
    readonly allowDemandStart: true;
    readonly hidden: false;
    readonly runOnlyIfIdle: false;
    readonly wakeToRun: false;
    readonly executionTimeLimit: typeof WINDOWS_TASK_EXECUTION_TIME_LIMIT;
    readonly priority: typeof WINDOWS_TASK_PRIORITY;
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
  readonly observedAt: string;
  readonly lastRunTime: string | null;
  readonly nextRunTime: string | null;
  readonly missedRuns: number;
  readonly restartCount: typeof WINDOWS_TASK_RESTART_COUNT;
  readonly restartIntervalSeconds: typeof WINDOWS_TASK_RESTART_INTERVAL_SECONDS;
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
  readonly nextRunTime?: string | null;
  readonly missedRuns?: number;
  readonly observedAt?: string;
};

export type TaskSchedulerPowerShellOperation =
  | 'currentSid'
  | 'taskSchemaVersion'
  | 'inspect'
  | 'validate'
  | 'register'
  | 'restoreXml'
  | 'disable'
  | 'start'
  | 'stop'
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

function New-DesiredTaskDefinition([object]$d) {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $definition = $service.NewTask(0)
  $definition.RegistrationInfo.Description = [string]$d.description
  $definition.Principal.Id = 'Author'
  $definition.Principal.UserId = [string]$d.principal.userId
  $definition.Principal.LogonType = 3
  $definition.Principal.RunLevel = 0
  $trigger = $definition.Triggers.Create(9)
  $trigger.UserId = [string]$d.trigger.userId
  $trigger.Enabled = $true
  $trigger.Repetition.Interval = 'PT1M'
  $trigger.Repetition.StopAtDurationEnd = $false
  $definition.Settings.Enabled = [bool]$d.enabled
  $definition.Settings.StartWhenAvailable = $true
  $definition.Settings.MultipleInstances = 2
  $definition.Settings.DisallowStartIfOnBatteries = $false
  $definition.Settings.StopIfGoingOnBatteries = $false
  $definition.Settings.AllowHardTerminate = $true
  $definition.Settings.RunOnlyIfNetworkAvailable = $false
  $definition.Settings.IdleSettings.IdleDuration = 'PT10M'
  $definition.Settings.IdleSettings.WaitTimeout = 'PT1H'
  $definition.Settings.IdleSettings.StopOnIdleEnd = $true
  $definition.Settings.IdleSettings.RestartOnIdle = $false
  $definition.Settings.AllowDemandStart = $true
  $definition.Settings.Hidden = $false
  $definition.Settings.RunOnlyIfIdle = $false
  $definition.Settings.WakeToRun = $false
  $definition.Settings.ExecutionTimeLimit = 'PT0S'
  $definition.Settings.Priority = 7
  $definition.Settings.RestartCount = 3
  $definition.Settings.RestartInterval = 'PT1M'
  $definition.Actions.Context = 'Author'
  $action = $definition.Actions.Create(0)
  $action.Path = [string]$d.action.execute
  $action.Arguments = [string]$d.action.arguments
  $action.WorkingDirectory = [string]$d.action.workingDirectory
  return @{ service = $service; definition = $definition }
}

switch ($operation) {
  'currentSid' {
    Write-Result ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  }
  'taskSchemaVersion' {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    [uint32]$highest = $service.HighestVersion
    $major = [uint32]($highest -shr 16)
    $minor = [uint32]($highest -band 0xffff)
    Write-Result ([string]$major + '.' + [string]$minor)
  }
  'inspect' {
    $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
      Write-Result @{ exists = $false }
      break
    }
    $info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $inputObject.taskName
    $lastRun = if ($info.LastTaskResult -eq 267011 -or $info.LastRunTime.Year -le 2000) { $null } else { $info.LastRunTime.ToUniversalTime().ToString('o') }
    $nextRun = if ($info.NextRunTime.Year -le 2000) { $null } else { $info.NextRunTime.ToUniversalTime().ToString('o') }
    Write-Result @{
      exists = $true
      xml = (Export-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName)
      state = [String]$task.State
      enabled = [bool]$task.Settings.Enabled
      lastTaskResult = [int64]$info.LastTaskResult
      lastRunTime = $lastRun
      nextRunTime = $nextRun
      missedRuns = [int64]$info.NumberOfMissedRuns
      observedAt = [DateTime]::UtcNow.ToString('o')
    }
  }
  'validate' {
    $built = New-DesiredTaskDefinition $inputObject.definition
    $folder = $built.service.GetFolder($taskPath)
    [void]$folder.RegisterTaskDefinition(
      $inputObject.definition.taskName,
      $built.definition,
      1,
      $inputObject.definition.principal.userId,
      $null,
      3,
      $null
    )
    Write-Result @{ ok = $true }
  }
  'register' {
    $d = $inputObject.definition
    $current = Get-ScheduledTask -TaskPath $taskPath -TaskName $d.taskName -ErrorAction SilentlyContinue
    if ([bool]$inputObject.replace) {
      if ($null -eq $current -or (Export-ScheduledTask -TaskPath $taskPath -TaskName $d.taskName) -cne [String]$inputObject.expectedXml) { throw 'task changed before replace' }
    } elseif ($null -ne $current) { throw 'task appeared before create' }
    $built = New-DesiredTaskDefinition $d
    $folder = $built.service.GetFolder($taskPath)
    $flags = if ([bool]$inputObject.replace) { 6 } else { 2 }
    [void]$folder.RegisterTaskDefinition($d.taskName, $built.definition, $flags, $d.principal.userId, $null, 3, $null)
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
  'stop' {
    Assert-ExpectedTaskXml $inputObject.taskName $inputObject.expectedXml
    $current = Get-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName
    if ($current.State -eq 'Running' -or $current.State -eq 'Queued') {
      Stop-ScheduledTask -TaskPath $taskPath -TaskName $inputObject.taskName
    }
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

const TASK_XML_NAMESPACE = 'http://schemas.microsoft.com/windows/2004/02/mit/task';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';

function taskDocumentElement(xml: string): Element | null {
  if (xml.length === 0 || xml.length > 1024 * 1024 ||
      xml.toUpperCase().includes('<!DOCTYPE') || xml.toUpperCase().includes('<!ENTITY')) return null;
  try {
    const document = new DOMParser({
      onError: () => { throw new Error('invalid XML'); },
    }).parseFromString(xml, 'application/xml');
    const root = document.documentElement;
    if (root === null || root.localName !== 'Task' || root.namespaceURI !== TASK_XML_NAMESPACE) return null;
    for (let index = 0; index < document.childNodes.length; index += 1) {
      const child = document.childNodes.item(index);
      const xmlDeclaration = index === 0 && child?.nodeType === 7 && child.nodeName === 'xml';
      if (child === null || (child !== root && !xmlDeclaration &&
          !(child.nodeType === 3 && (child.nodeValue ?? '').trim().length === 0))) return null;
    }
    return root;
  } catch { return null; }
}

function childElements(parent: Element): readonly Element[] | null {
  const result: Element[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child === null) return null;
    if (child.nodeType === 1) {
      const element = child as Element;
      if (element.namespaceURI !== TASK_XML_NAMESPACE) return null;
      result.push(element);
    } else if (child.nodeType === 3) {
      if ((child.nodeValue ?? '').trim().length !== 0) return null;
    } else return null;
  }
  return result;
}

function exactChildren(
  parent: Element,
  required: readonly string[],
  optional: readonly string[] = [],
): ReadonlyMap<string, Element> | null {
  const children = childElements(parent);
  if (children === null) return null;
  const allowed = new Set([...required, ...optional]);
  const result = new Map<string, Element>();
  for (const child of children) {
    const name = child.localName;
    if (name === null || !allowed.has(name) || result.has(name)) return null;
    result.set(name, child);
  }
  if (required.some((name) => !result.has(name))) return null;
  return result;
}

function exactAttributes(
  element: Element,
  expected: Readonly<Record<string, string>> = {},
): boolean {
  const seen = new Set<string>();
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes.item(index);
    if (attribute === null) return false;
    if (attribute.namespaceURI === XMLNS_NAMESPACE || attribute.name === 'xmlns') continue;
    const name = attribute.localName;
    if (name === null || attribute.namespaceURI !== null || !(name in expected) ||
        attribute.value !== expected[name] || seen.has(name)) return false;
    seen.add(name);
  }
  return Object.keys(expected).every((name) => seen.has(name));
}

const MINIMUM_TASK_SCHEMA_MINOR = 2;
const MAXIMUM_TASK_SCHEMA_MINOR = 6;

function supportedTaskSchemaMinor(value: string): number | null {
  const match = /^1\.([0-9]+)$/u.exec(value);
  if (match === null || match[1] === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(match[1])) {
    return null;
  }
  const minor = Number(match[1]);
  return Number.isSafeInteger(minor) && minor >= MINIMUM_TASK_SCHEMA_MINOR &&
    minor <= MAXIMUM_TASK_SCHEMA_MINOR ? minor : null;
}

function taskSchemaVersion(root: Element, hostHighestVersion?: string): string | null {
  const version = root.getAttribute('version');
  if (version === null || !exactAttributes(root, { version })) return null;
  const minor = supportedTaskSchemaMinor(version);
  const hostHighestMinor = hostHighestVersion === undefined
    ? MAXIMUM_TASK_SCHEMA_MINOR
    : supportedTaskSchemaMinor(hostHighestVersion);
  if (minor === null || hostHighestMinor === null || minor > hostHighestMinor) return null;
  return version;
}

function elementText(element: Element): string | null {
  if (!exactAttributes(element)) return null;
  let value = '';
  for (let index = 0; index < element.childNodes.length; index += 1) {
    const child: Node | null = element.childNodes.item(index);
    if (child === null || (child.nodeType !== 3 && child.nodeType !== 4)) return null;
    value += child.nodeValue ?? '';
  }
  return value;
}

function childText(children: ReadonlyMap<string, Element>, name: string): string | null {
  const element = children.get(name);
  return element === undefined ? null : elementText(element);
}

function childBoolean(children: ReadonlyMap<string, Element>, name: string): boolean | null {
  const value = childText(children, name);
  return value === 'true' ? true : value === 'false' ? false : null;
}

function childInteger(children: ReadonlyMap<string, Element>, name: string): number | null {
  const value = childText(children, name);
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

type TaskXmlIdentity = { readonly description: string; readonly principalUser: string };

function parseTaskXmlIdentity(xml: string, hostHighestSchemaVersion?: string): TaskXmlIdentity | null {
  const root = taskDocumentElement(xml);
  if (root === null || taskSchemaVersion(root, hostHighestSchemaVersion) === null) return null;
  const rootChildren = exactChildren(
    root,
    ['RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions'],
  );
  if (rootChildren === null || !exactAttributes(rootChildren.get('RegistrationInfo')!) ||
      !exactAttributes(rootChildren.get('Principals')!)) return null;
  const registration = exactChildren(
    rootChildren.get('RegistrationInfo')!,
    ['Description'],
    ['Author', 'Date', 'URI'],
  );
  const principals = childElements(rootChildren.get('Principals')!);
  if (registration === null || principals === null || principals.length !== 1 ||
      principals[0]?.localName !== 'Principal' ||
      !exactAttributes(principals[0], { id: 'Author' })) return null;
  const principalChildren = exactChildren(principals[0], ['UserId', 'LogonType', 'RunLevel']);
  const description = childText(registration, 'Description');
  const principalUser = principalChildren === null ? null : childText(principalChildren, 'UserId');
  return description === null || principalUser === null ? null : { description, principalUser };
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
  readonly powerShellPath: string;
  readonly launcherPath: string;
  readonly runtimeManifestPath: string;
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
    trigger: {
      kind: 'AtLogOn',
      userId: input.currentSid,
      enabled: true,
      repetition: {
        interval: WINDOWS_TASK_REPETITION_INTERVAL,
        duration: null,
        stopAtDurationEnd: false,
      },
    },
    settings: {
      startWhenAvailable: true,
      multipleInstances: 'IgnoreNew',
      allowStartOnBatteries: true,
      dontStopOnBatteries: true,
      allowHardTerminate: true,
      runOnlyIfNetworkAvailable: false,
      idle: {
        duration: WINDOWS_TASK_IDLE_DURATION,
        waitTimeout: WINDOWS_TASK_IDLE_WAIT_TIMEOUT,
        stopOnIdleEnd: true,
        restartOnIdle: false,
      },
      allowDemandStart: true,
      hidden: false,
      runOnlyIfIdle: false,
      wakeToRun: false,
      executionTimeLimit: WINDOWS_TASK_EXECUTION_TIME_LIMIT,
      priority: WINDOWS_TASK_PRIORITY,
      restartCount: WINDOWS_TASK_RESTART_COUNT,
      restartInterval: WINDOWS_TASK_RESTART_INTERVAL,
    },
    action: {
      execute: input.powerShellPath,
      arguments: joinWindowsArguments([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', input.launcherPath,
        '-SettingsPath', input.runtimeManifestPath,
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

/** Namespace-aware semantic normalizer for the one allowed Task Scheduler definition. */
export function parseWindowsTaskXml(
  xml: string,
  hostHighestSchemaVersion?: string,
): WindowsTaskDefinition | null {
  const root = taskDocumentElement(xml);
  if (root === null || taskSchemaVersion(root, hostHighestSchemaVersion) === null) return null;
  const rootChildren = exactChildren(
    root,
    ['RegistrationInfo', 'Triggers', 'Principals', 'Settings', 'Actions'],
  );
  if (rootChildren === null || [...rootChildren.values()].some((element) =>
    element.localName !== 'Actions' && !exactAttributes(element))) return null;
  const registration = exactChildren(
    rootChildren.get('RegistrationInfo')!,
    ['Description'],
    ['Author', 'Date', 'URI'],
  );
  if (registration === null || [...registration.values()].some((element) =>
    elementText(element) === null)) return null;
  const principals = childElements(rootChildren.get('Principals')!);
  const triggers = childElements(rootChildren.get('Triggers')!);
  const actionsElement = rootChildren.get('Actions')!;
  const actions = childElements(actionsElement);
  if (principals === null || principals.length !== 1 || principals[0]?.localName !== 'Principal' ||
      !exactAttributes(principals[0], { id: 'Author' }) ||
      triggers === null || triggers.length !== 1 || triggers[0]?.localName !== 'LogonTrigger' ||
      !exactAttributes(triggers[0]) ||
      actions === null || actions.length !== 1 || actions[0]?.localName !== 'Exec' ||
      !exactAttributes(actionsElement, { Context: 'Author' }) || !exactAttributes(actions[0])) return null;
  const principal = exactChildren(principals[0], ['UserId', 'LogonType', 'RunLevel']);
  const logonTrigger = exactChildren(triggers[0], ['Enabled', 'UserId', 'Repetition']);
  const settings = exactChildren(rootChildren.get('Settings')!, [
    'MultipleInstancesPolicy', 'DisallowStartIfOnBatteries', 'StopIfGoingOnBatteries',
    'AllowHardTerminate', 'StartWhenAvailable', 'RunOnlyIfNetworkAvailable', 'IdleSettings',
    'Enabled', 'Hidden', 'RunOnlyIfIdle', 'WakeToRun',
    'ExecutionTimeLimit', 'Priority', 'RestartOnFailure',
  ], ['AllowStartOnDemand']);
  const exec = exactChildren(actions[0], ['Command', 'Arguments', 'WorkingDirectory']);
  if (principal === null || logonTrigger === null || settings === null || exec === null) return null;
  const repetition = exactChildren(
    logonTrigger.get('Repetition')!,
    ['Interval'],
    ['StopAtDurationEnd'],
  );
  const idle = exactChildren(settings.get('IdleSettings')!, [
    'Duration', 'WaitTimeout', 'StopOnIdleEnd', 'RestartOnIdle',
  ]);
  const restart = exactChildren(settings.get('RestartOnFailure')!, ['Interval', 'Count']);
  if (repetition === null || idle === null || restart === null ||
      !exactAttributes(logonTrigger.get('Repetition')!) ||
      !exactAttributes(settings.get('IdleSettings')!) ||
      !exactAttributes(settings.get('RestartOnFailure')!)) return null;
  const description = childText(registration, 'Description');
  const principalUser = childText(principal, 'UserId');
  const triggerUser = childText(logonTrigger, 'UserId');
  const enabled = childBoolean(settings, 'Enabled');
  const execute = childText(exec, 'Command');
  const args = childText(exec, 'Arguments');
  const workingDirectory = childText(exec, 'WorkingDirectory');
  if (description === null || principalUser === null || triggerUser === null || enabled === null ||
      execute === null || args === null || workingDirectory === null ||
      childText(principal, 'LogonType') !== 'InteractiveToken' ||
      childText(principal, 'RunLevel') !== 'LeastPrivilege' ||
      childBoolean(logonTrigger, 'Enabled') !== true ||
      childText(repetition, 'Interval') !== WINDOWS_TASK_REPETITION_INTERVAL ||
      (repetition.has('StopAtDurationEnd') &&
       childBoolean(repetition, 'StopAtDurationEnd') !== false) ||
      childText(settings, 'MultipleInstancesPolicy') !== 'IgnoreNew' ||
      childBoolean(settings, 'DisallowStartIfOnBatteries') !== false ||
      childBoolean(settings, 'StopIfGoingOnBatteries') !== false ||
      childBoolean(settings, 'AllowHardTerminate') !== true ||
      childBoolean(settings, 'StartWhenAvailable') !== true ||
      childBoolean(settings, 'RunOnlyIfNetworkAvailable') !== false ||
      childText(idle, 'Duration') !== WINDOWS_TASK_IDLE_DURATION ||
      childText(idle, 'WaitTimeout') !== WINDOWS_TASK_IDLE_WAIT_TIMEOUT ||
      childBoolean(idle, 'StopOnIdleEnd') !== true ||
      childBoolean(idle, 'RestartOnIdle') !== false ||
      (settings.has('AllowStartOnDemand') && childBoolean(settings, 'AllowStartOnDemand') !== true) ||
      childBoolean(settings, 'Hidden') !== false ||
      childBoolean(settings, 'RunOnlyIfIdle') !== false ||
      childBoolean(settings, 'WakeToRun') !== false ||
      childText(settings, 'ExecutionTimeLimit') !== WINDOWS_TASK_EXECUTION_TIME_LIMIT ||
      childInteger(settings, 'Priority') !== WINDOWS_TASK_PRIORITY ||
      childText(restart, 'Interval') !== WINDOWS_TASK_RESTART_INTERVAL ||
      childInteger(restart, 'Count') !== WINDOWS_TASK_RESTART_COUNT) return null;
  return {
    taskName: WINDOWS_TASK_NAME,
    description,
    enabled,
    principal: { userId: principalUser, logonType: 'InteractiveToken', runLevel: 'Limited' },
    trigger: {
      kind: 'AtLogOn',
      userId: triggerUser,
      enabled: true,
      repetition: {
        interval: WINDOWS_TASK_REPETITION_INTERVAL,
        duration: null,
        stopAtDurationEnd: false,
      },
    },
    settings: {
      startWhenAvailable: true,
      multipleInstances: 'IgnoreNew',
      allowStartOnBatteries: true,
      dontStopOnBatteries: true,
      allowHardTerminate: true,
      runOnlyIfNetworkAvailable: false,
      idle: {
        duration: WINDOWS_TASK_IDLE_DURATION,
        waitTimeout: WINDOWS_TASK_IDLE_WAIT_TIMEOUT,
        stopOnIdleEnd: true,
        restartOnIdle: false,
      },
      allowDemandStart: true,
      hidden: false,
      runOnlyIfIdle: false,
      wakeToRun: false,
      executionTimeLimit: WINDOWS_TASK_EXECUTION_TIME_LIMIT,
      priority: WINDOWS_TASK_PRIORITY,
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
    observedAt: record.observedAt!,
    lastRunTime: record.lastRunTime ?? null,
    nextRunTime: record.nextRunTime ?? null,
    missedRuns: record.missedRuns!,
    restartCount: WINDOWS_TASK_RESTART_COUNT,
    restartIntervalSeconds: WINDOWS_TASK_RESTART_INTERVAL_SECONDS,
  };
}

export type WindowsTaskLaunchBinding = {
  readonly currentSid: string;
  readonly releaseRoot: string;
  readonly releaseDigest: string;
  readonly powerShellPath: string;
  readonly launcherPath: string;
  readonly runtimeManifestPath: string;
  readonly taskSemanticFingerprint: string;
};

function sameWindowsBindingPath(left: string, right: string): boolean {
  return win32.isAbsolute(left) && win32.isAbsolute(right) &&
    win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

/** Closed pre-token binding between a protected manifest and the actual fixed Task export. */
export function windowsTaskXmlMatchesLaunchBinding(
  xml: string,
  input: WindowsTaskLaunchBinding,
  hostHighestSchemaVersion?: string,
): boolean {
  if (!/^S-[0-9]+(?:-[0-9]+)+$/u.test(input.currentSid) ||
      !/^[a-f0-9]{64}$/u.test(input.releaseDigest) ||
      !/^[a-f0-9]{64}$/u.test(input.taskSemanticFingerprint)) return false;
  const definition = parseWindowsTaskXml(xml, hostHighestSchemaVersion);
  if (definition === null || definition.taskName !== WINDOWS_TASK_NAME ||
      !definition.enabled || definition.principal.userId !== input.currentSid ||
      definition.trigger.userId !== input.currentSid ||
      !sameWindowsBindingPath(definition.action.execute, input.powerShellPath) ||
      !sameWindowsBindingPath(definition.action.workingDirectory, input.releaseRoot)) return false;
  const argumentsList = parseWindowsArguments(definition.action.arguments);
  if (JSON.stringify(argumentsList) !== JSON.stringify([
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', input.launcherPath, '-SettingsPath', input.runtimeManifestPath,
  ])) return false;
  const fingerprint = fingerprintWindowsTask(definition);
  const marker = parseWindowsTaskMarker(definition.description);
  return fingerprint === input.taskSemanticFingerprint && marker !== null &&
    marker.releaseDigest === input.releaseDigest &&
    marker.semanticFingerprint === input.taskSemanticFingerprint;
}

function canonicalSchedulerTimestamp(value: unknown, nullable: boolean): value is string | null {
  if (value === null) return nullable;
  return typeof value === 'string' &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3,7}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value));
}

function taskRecord(value: unknown): PowerShellTaskRecord {
  if (value === null || typeof value !== 'object') {
    throw new Error('windows.task_scheduler.invalid_response');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['exists'] !== 'boolean') throw new Error('windows.task_scheduler.invalid_response');
  if (!record['exists']) {
    if (Object.keys(record).some((key) => key !== 'exists')) {
      throw new Error('windows.task_scheduler.invalid_response');
    }
    return { exists: false };
  }
  const allowed = new Set([
    'exists', 'xml', 'state', 'enabled', 'lastTaskResult', 'lastRunTime',
    'nextRunTime', 'missedRuns', 'observedAt',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)) ||
      typeof record['xml'] !== 'string' || record['xml'].length === 0 ||
      typeof record['state'] !== 'string' || typeof record['enabled'] !== 'boolean' ||
      (record['lastTaskResult'] !== null &&
       (typeof record['lastTaskResult'] !== 'number' || !Number.isSafeInteger(record['lastTaskResult']))) ||
      !canonicalSchedulerTimestamp(record['lastRunTime'], true) ||
      !canonicalSchedulerTimestamp(record['nextRunTime'], true) ||
      !canonicalSchedulerTimestamp(record['observedAt'], false) ||
      typeof record['missedRuns'] !== 'number' || !Number.isSafeInteger(record['missedRuns']) ||
      record['missedRuns'] < 0) throw new Error('windows.task_scheduler.invalid_response');
  return record as PowerShellTaskRecord;
}

function sidResult(value: unknown): string {
  if (typeof value !== 'string' || !/^S-[0-9]+(?:-[0-9]+)+$/u.test(value)) {
    throw new Error('windows.task_scheduler.invalid_sid');
  }
  return value;
}

function taskSchemaVersionResult(value: unknown): string {
  if (typeof value !== 'string' || supportedTaskSchemaMinor(value) === null) {
    throw new Error('windows.task_scheduler.invalid_schema_version');
  }
  return value;
}

function assertOkResult(value: unknown): void {
  if (value === null || typeof value !== 'object' ||
      JSON.stringify(Object.keys(value)) !== JSON.stringify(['ok']) ||
      (value as { readonly ok?: unknown }).ok !== true) {
    throw new Error('windows.task_scheduler.invalid_response');
  }
}

export class CurrentUserWindowsTaskScheduler {
  constructor(private readonly runner: TaskSchedulerPowerShellRunner) {}

  async currentSid(): Promise<string> {
    return sidResult(await this.runner.run('currentSid', {}));
  }

  async inspect(): Promise<ManagedWindowsTaskSnapshot> {
    const currentSid = await this.currentSid();
    const schemaVersion = taskSchemaVersionResult(await this.runner.run('taskSchemaVersion', {}));
    const record = taskRecord(await this.runner.run('inspect', { taskName: WINDOWS_TASK_NAME }));
    if (!record.exists) return { kind: 'absent', currentSid };
    if (typeof record.xml !== 'string') throw new Error('windows.task_scheduler.invalid_response');
    const definition = parseWindowsTaskXml(record.xml, schemaVersion);
    const identity = definition === null ? parseTaskXmlIdentity(record.xml, schemaVersion) : null;
    const description = definition?.description ?? identity?.description ?? null;
    const marker = description === null ? null : parseWindowsTaskMarker(description);
    const managedDescription = description === WINDOWS_TASK_DESCRIPTION_PREFIX ||
      description?.startsWith(`${WINDOWS_TASK_DESCRIPTION_PREFIX};`) === true;
    const principalUser = definition?.principal.userId ?? identity?.principalUser ?? null;
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
    assertOkResult(await this.runner.run(
      'register', { definition, replace, expectedXml: expectedXml ?? null },
    ));
  }

  async validate(definition: WindowsTaskDefinition): Promise<void> {
    assertOkResult(await this.runner.run('validate', { definition }));
  }

  async restore(xml: string, expectedCurrentXml: string): Promise<void> {
    assertOkResult(await this.runner.run(
      'restoreXml', { taskName: WINDOWS_TASK_NAME, xml, expectedCurrentXml },
    ));
  }

  async disable(expectedXml: string): Promise<void> {
    assertOkResult(await this.runner.run('disable', { taskName: WINDOWS_TASK_NAME, expectedXml }));
  }

  async start(expectedXml: string): Promise<void> {
    assertOkResult(await this.runner.run('start', { taskName: WINDOWS_TASK_NAME, expectedXml }));
  }

  async stop(expectedXml: string): Promise<void> {
    assertOkResult(await this.runner.run('stop', { taskName: WINDOWS_TASK_NAME, expectedXml }));
  }

  async unregister(expectedXml: string): Promise<void> {
    assertOkResult(await this.runner.run('unregister', { taskName: WINDOWS_TASK_NAME, expectedXml }));
  }

  definitionsMatch(actual: WindowsTaskDefinition | null, expected: WindowsTaskDefinition): boolean {
    return actual !== null && sameDefinition(actual, expected);
  }
}

/** Exported for tests and audit tooling without exposing a raw XML canonicalization claim. */
export function escapeTaskXmlTextForTest(value: string): string {
  return encodeXmlText(value);
}
