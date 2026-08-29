import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/project/config.js';
import {
  fingerprintOperationalBuild,
  fingerprintOperationalConfig,
  formatOperationalStatus,
  inspectOperationalStatus,
  operationalStatusOwnerPipePath,
  OperationalStatusOwnerServer,
  OPERATIONAL_JOB_NAMES,
  projectOperationalStore,
  type OperationalStatusSnapshot,
} from '../src/operational/status.js';
import {
  activeOperationalStatusCapability,
  CurrentUserOperationalStatusCapabilityStore,
  operationalStatusCapabilityPath,
  operationalStatusPosixProtectionIsExact,
  operationalStatusStateIdentity,
  operationalStatusWindowsAclIsExact,
  operationalStatusWindowsLocalPathIsCanonical,
  operationalStatusWindowsKnownFolderEnvironment,
  operationalStatusWindowsOwnerClaimEnvironment,
  operationalStatusWindowsOwnerClaimName,
  operationalStatusWindowsPowerShellEnvironment,
  operationalStatusWindowsSnapshotLeaseEnvironment,
  operationalStatusWindowsSnapshotLeaseName,
  operationalStatusWindowsTrustedPowerShell,
  retiredOperationalStatusCapability,
  STATUS_OWNER_CAPABILITY_MAX_AGE_MS,
  STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS,
  type ActiveOperationalStatusCapability,
  type OperationalStatusCapabilityDocument,
  type OperationalStatusCapabilityRead,
  type OperationalStatusCapabilityStore,
  type OperationalStatusCapabilityStoreHooks,
  type OperationalStatusOwnerClaim,
  type OperationalStatusOwnerTransportIdentity,
  type OperationalStatusSnapshotLease,
  type OperationalStatusSnapshotLeaseStore,
  type OperationalStatusTransportEndpoint,
  type RetiredOperationalStatusCapability,
} from '../src/operational/status-capability.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import type { DaemonJobName } from '../src/store/operational-types.js';

let dir: string;
let statePath: string;
let capabilityPath: string;
let capabilities: MemoryCapabilityStore;
const AT0 = '2026-08-26T00:00:00.000Z';
const AT1 = '2026-08-26T00:00:01.000Z';
const AT2 = '2026-08-26T00:00:02.000Z';
const NEXT = '2026-08-26T00:15:00.000Z';
const TRANSPORT_AT = '2026-08-27T00:00:00.000Z';
const BUILD = 'release-SENTINEL_PRIVATE_BUILD';
const INSTANCE = 'instance-SENTINEL_RAW_ID';
const config = parseConfig({
  slack: null,
  projects: [{ name: 'Project Sentinel', repositories: ['private-owner/private-repository'] }],
});
const disabledConfig = parseConfig({
  slack: null,
  projects: [{ name: 'Project Sentinel', repositories: ['private-owner/private-repository'] }],
  automation: { enabled: false },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-operational-status-'));
  statePath = join(dir, 'state.db');
  capabilityPath = join(dir, 'owner.capability');
  capabilities = new MemoryCapabilityStore();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function completeJobs(
  store: SqliteDigestStore,
  failure: DaemonJobName | null = null,
  backoff = false,
  jobs: readonly DaemonJobName[] = OPERATIONAL_JOB_NAMES,
): void {
  for (const job of jobs) {
    const claim = store.startDaemonJob(job, AT0);
    if (claim === null) throw new Error('expected job claim');
    if (job === failure) {
      const failed = store.completeDaemonJobFailure({
        claim, at: AT1, durationMs: 1, errorCode: 'github.unavailable',
      });
      if (failed === null) throw new Error('expected failed outcome');
      if (backoff) store.scheduleDaemonJobBackoff(job, failed.revision, NEXT, AT2);
    } else {
      store.completeDaemonJobSuccess({ claim, at: AT1, durationMs: 1, nextRunAt: NEXT });
    }
  }
}

function healthyStore(options: {
  readonly configFingerprint?: string;
  readonly buildFingerprint?: string;
  readonly failure?: DaemonJobName | null;
  readonly backoff?: boolean;
  readonly jobs?: boolean;
  readonly jobNames?: readonly DaemonJobName[];
  readonly config?: typeof config;
} = {}): SqliteDigestStore {
  const store = new SqliteDigestStore(statePath);
  store.recordDaemonStart({
    instanceId: INSTANCE,
    buildFingerprint: options.buildFingerprint ?? fingerprintOperationalBuild(BUILD),
    configFingerprint: options.configFingerprint ?? fingerprintOperationalConfig(options.config ?? config),
    at: AT0,
  });
  if (options.jobs !== false) {
    completeJobs(store, options.failure ?? null, options.backoff ?? false, options.jobNames);
  }
  return store;
}

function inspect(overrides: Parameters<typeof inspectOperationalStatus>[0] = {}) {
  return inspectOperationalStatus({
    config,
    statePath,
    logDir: dir,
    expectedBuildIdentity: BUILD,
    clock: () => new Date('2026-08-26T00:00:30.000Z'),
    ownerTransportClock: () => new Date(TRANSPORT_AT),
    ownerCapabilityPath: capabilityPath,
    ownerCapabilityStore: capabilities,
    snapshotLeaseStore: capabilities,
    ...overrides,
  });
}

function snapshotAndClose(
  store: SqliteDigestStore,
  expectedConfig = config,
  expectedBuild: string | null = BUILD,
): OperationalStatusSnapshot {
  try {
    return projectOperationalStore(store, {
      configFingerprint: fingerprintOperationalConfig(expectedConfig),
      buildFingerprint: expectedBuild === null ? null : fingerprintOperationalBuild(expectedBuild),
    });
  } finally {
    store.close();
  }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function basicFileWitness(path: string): readonly string[] {
  const value = lstatSync(path, { bigint: true });
  return [
    value.dev, value.ino, value.mode, value.size, value.birthtimeNs,
    value.atimeNs, value.ctimeNs, value.mtimeNs,
  ].map(String);
}

function mutateWindowsAclWithoutChangingBasicInfo(
  path: string,
  mode: 'everyone-read' | 'inheritance-enabled',
): void {
  const root = process.env['SystemRoot'] ?? process.env['WINDIR'] ?? String.raw`C:\Windows`;
  const executable = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OrcaStatusBasicInfo {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILE_BASIC_INFO {
    public long CreationTime;
    public long LastAccessTime;
    public long LastWriteTime;
    public long ChangeTime;
    public uint FileAttributes;
  }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetFileInformationByHandleEx(
    SafeFileHandle handle, int infoClass, out FILE_BASIC_INFO info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetFileInformationByHandle(
    SafeFileHandle handle, int infoClass, ref FILE_BASIC_INFO info, uint size);
}
'@
$path = [Environment]::GetEnvironmentVariable('ORCA_STATUS_CAPABILITY_PATH', 'Process')
$mode = [Environment]::GetEnvironmentVariable('ORCA_STATUS_ACL_MUTATION', 'Process')
$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
$stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, $share)
try {
  $size = [Runtime.InteropServices.Marshal]::SizeOf([type][OrcaStatusBasicInfo+FILE_BASIC_INFO])
  $before = [OrcaStatusBasicInfo+FILE_BASIC_INFO]::new()
  if (-not [OrcaStatusBasicInfo]::GetFileInformationByHandleEx(
    $stream.SafeFileHandle, 0, [ref]$before, [uint32]$size)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  $item = [IO.FileInfo]::new($path)
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner
  $acl = $item.GetAccessControl($sections)
  if ($mode -eq 'everyone-read') {
    $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $everyone,
      [Security.AccessControl.FileSystemRights]::Read,
      [Security.AccessControl.InheritanceFlags]::None,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  } elseif ($mode -eq 'inheritance-enabled') {
    $acl.SetAccessRuleProtection($false, $true)
  } else {
    throw 'invalid mutation'
  }
  $item.SetAccessControl($acl)
  if (-not [OrcaStatusBasicInfo]::SetFileInformationByHandle(
    $stream.SafeFileHandle, 0, [ref]$before, [uint32]$size)) {
    throw [ComponentModel.Win32Exception]::new([Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
} finally {
  $stream.Dispose()
}
`;
  execFileSync(executable, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    env: {
      SystemRoot: root,
      WINDIR: root,
      ORCA_STATUS_CAPABILITY_PATH: path,
      ORCA_STATUS_ACL_MUTATION: mode,
    },
    windowsHide: true,
    timeout: 3_000,
    maxBuffer: 1_024,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

class MemoryCapabilityStore implements
  OperationalStatusCapabilityStore, OperationalStatusSnapshotLeaseStore {
  document: OperationalStatusCapabilityDocument | null = null;
  protected = true;
  invalid = false;
  raceAfterPublish: OperationalStatusCapabilityDocument | null = null;
  requestVerification: ((signal: AbortSignal) => Promise<void>) | null = null;
  afterRequestRead: ((observed: OperationalStatusCapabilityRead) => void) | null = null;
  requestReads = 0;
  private claimToken: symbol | null = null;
  private snapshotLeaseToken: symbol | null = null;

  async tryAcquireSnapshotLease(
    _path: string,
    _stateIdentity: string,
  ): Promise<OperationalStatusSnapshotLease | null> {
    if (this.claimToken !== null || this.snapshotLeaseToken !== null) return null;
    const token = Symbol('memory-snapshot-lease');
    this.snapshotLeaseToken = token;
    let released = false;
    return {
      assertHeld: () => {
        if (released || this.snapshotLeaseToken !== token) {
          throw new Error('status.snapshot_lease_lost');
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        if (this.snapshotLeaseToken === token) this.snapshotLeaseToken = null;
      },
    };
  }

  async acquireOwnerClaim(
    path: string,
    stateIdentity: string,
  ): Promise<OperationalStatusOwnerClaim> {
    if (this.claimToken !== null) throw new Error('status.owner_claim_failed');
    const token = Symbol('memory-owner-claim');
    this.claimToken = token;
    let released = false;
    return {
      stateIdentity,
      capabilityPath: path,
      assertHeld: () => {
        if (released || this.claimToken !== token) throw new Error('status.owner_claim_lost');
      },
      release: async () => {
        if (released) return;
        released = true;
        if (this.claimToken === token) this.claimToken = null;
      },
    };
  }

  read(_path: string, enforceProtection = true): OperationalStatusCapabilityRead {
    if (this.invalid || (enforceProtection && !this.protected)) return { kind: 'invalid' };
    return this.document === null
      ? { kind: 'absent' }
      : { kind: 'ready', value: structuredClone(this.document) };
  }

  async readForRequest(path: string, signal: AbortSignal): Promise<OperationalStatusCapabilityRead> {
    this.requestReads += 1;
    if (this.requestVerification !== null) await this.requestVerification(signal);
    const observed: OperationalStatusCapabilityRead = signal.aborted
      ? { kind: 'invalid' }
      : this.read(path);
    this.afterRequestRead?.(observed);
    return observed;
  }

  publish(
    path: string,
    document: OperationalStatusCapabilityDocument,
    expected: OperationalStatusCapabilityDocument | null,
    claim: OperationalStatusOwnerClaim,
  ): void {
    claim.assertHeld();
    if (claim.capabilityPath !== path || claim.stateIdentity !== document.stateIdentity ||
        !this.protected ||
        JSON.stringify(this.document) !== JSON.stringify(expected)) {
      throw new Error('status.capability_permission_failed');
    }
    this.document = structuredClone(document);
    if (this.raceAfterPublish !== null) this.document = structuredClone(this.raceAfterPublish);
  }

  remove(
    path: string,
    expected: RetiredOperationalStatusCapability,
    claim: OperationalStatusOwnerClaim,
  ): void {
    claim.assertHeld();
    if (claim.capabilityPath !== path || claim.stateIdentity !== expected.stateIdentity ||
        !this.protected || this.document === null ||
        JSON.stringify(this.document) !== JSON.stringify(expected)) {
      throw new Error('status.capability_remove_failed');
    }
    this.document = null;
  }

  prepareOwnerTransport(
    path: string,
    _stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void {
    claim.assertHeld();
    if (existsSync(path)) renameSync(path, `${path}.stale-${Date.now()}`);
  }

  activateOwnerTransport(
    path: string,
    _stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): OperationalStatusOwnerTransportIdentity {
    claim.assertHeld();
    chmodSync(path, 0o600);
    const value = lstatSync(path, { bigint: true });
    if (!value.isSocket()) throw new Error('status.owner_transport_failed');
    return { kind: 'pipe', path, device: String(value.dev), inode: String(value.ino) };
  }

  assertOwnerTransport(
    transport: OperationalStatusOwnerTransportIdentity,
    _stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void {
    claim.assertHeld();
    if (!this.verifyOwnerTransport(transport)) throw new Error('status.owner_transport_lost');
  }

  retireOwnerTransport(
    transport: OperationalStatusOwnerTransportIdentity,
    stateIdentity: string,
    claim: OperationalStatusOwnerClaim,
  ): void {
    claim.assertHeld();
    if (!existsSync(transport.path)) return;
    this.assertOwnerTransport(transport, stateIdentity, claim);
    renameSync(transport.path, `${transport.path}.retired-${transport.inode}`);
  }

  verifyOwnerTransport(transport: OperationalStatusOwnerTransportIdentity): boolean {
    try {
      const value = lstatSync(transport.path, { bigint: true });
      const uid = typeof process.getuid === 'function' ? BigInt(process.getuid()) : value.uid;
      return value.isSocket() && value.uid === uid && (value.mode & 0o777n) === 0o600n &&
        String(value.dev) === transport.device && String(value.ino) === transport.inode;
    } catch {
      return false;
    }
  }

  active(): ActiveOperationalStatusCapability {
    if (this.document?.status !== 'active') throw new Error('expected active capability');
    return structuredClone(this.document);
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function ownerMac(secret: string, domain: 'request' | 'response', value: unknown): string {
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(`orca-slack-bridge-status-owner-v2:${domain}\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

function transportBinding(transport: OperationalStatusTransportEndpoint): string {
  return createHash('sha256')
    .update('orca-slack-bridge-status-owner-v2:transport\0', 'utf8')
    .update(canonicalJson(transport), 'utf8')
    .digest('hex');
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), 'utf8');
  const output = Buffer.alloc(payload.length + 4);
  output.writeUInt32BE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

function unframe(input: Buffer): unknown {
  expect(input.length).toBeGreaterThanOrEqual(4);
  expect(input.readUInt32BE(0)).toBe(input.length - 4);
  return JSON.parse(input.subarray(4).toString('utf8'));
}

async function rawOwnerFrame(): Promise<Buffer> {
  const capability = capabilities.active();
  const unsigned = {
    version: 2,
    stateIdentity: operationalStatusStateIdentity(statePath),
    capabilityId: capability.capabilityId,
    transportBinding: transportBinding(capability.transport),
    nonce: 'a'.repeat(32),
    sentAt: TRANSPORT_AT,
    configFingerprint: fingerprintOperationalConfig(config),
    buildFingerprint: fingerprintOperationalBuild(BUILD),
  } as const;
  return await new Promise<Buffer>((resolveFrame, reject) => {
    const socket = capability.transport.kind === 'tcp'
      ? createConnection({ ...capability.transport, allowHalfOpen: true })
      : createConnection({ path: capability.transport.path, allowHalfOpen: true });
    const output: Buffer[] = [];
    socket.setTimeout(1_000, () => socket.destroy(new Error('owner timeout')));
    socket.on('connect', () => socket.end(frame({
      ...unsigned,
      authenticator: ownerMac(capability.secret, 'request', unsigned),
    })));
    socket.on('data', (chunk: Buffer) => output.push(chunk));
    socket.on('end', () => resolveFrame(Buffer.concat(output)));
    socket.on('error', reject);
  });
}

type RawRequestMode =
  | 'valid-split'
  | 'unauthenticated'
  | 'wrong-transport-binding'
  | 'coalesced'
  | 'delayed-trailing'
  | 'partial'
  | 'oversize'
  | 'slowloris';

function validRawOwnerRequest(
  capability: ActiveOperationalStatusCapability,
  nonce = 'b'.repeat(32),
  sentAt = TRANSPORT_AT,
): Buffer {
  const unsigned = {
    version: 2,
    stateIdentity: operationalStatusStateIdentity(statePath),
    capabilityId: capability.capabilityId,
    transportBinding: transportBinding(capability.transport),
    nonce,
    sentAt,
    configFingerprint: fingerprintOperationalConfig(config),
    buildFingerprint: fingerprintOperationalBuild(BUILD),
  } as const;
  return frame({
    ...unsigned,
    authenticator: ownerMac(capability.secret, 'request', unsigned),
  });
}

async function exchangeAuthenticatedOwnerFrame(
  request: Buffer,
  timeoutMilliseconds = 250,
): Promise<Buffer | null> {
  const capability = capabilities.active();
  return await new Promise<Buffer | null>((resolveExchange) => {
    const socket = capability.transport.kind === 'tcp'
      ? createConnection({ ...capability.transport, allowHalfOpen: true })
      : createConnection({ path: capability.transport.path, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveExchange(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMilliseconds);
    timer.unref?.();
    socket.on('connect', () => socket.end(request));
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => finish(chunks.length === 0 ? null : Buffer.concat(chunks)));
    socket.on('error', () => finish(null));
    socket.on('close', () => {
      if (chunks.length === 0) finish(null);
    });
  });
}

async function rawOwnerExchange(
  mode: RawRequestMode,
  timeoutMilliseconds = 200,
): Promise<Buffer | null> {
  const capability = capabilities.active();
  const valid = validRawOwnerRequest(capability);
  return await new Promise<Buffer | null>((resolveExchange) => {
    const socket = capability.transport.kind === 'tcp'
      ? createConnection({
        host: capability.transport.host,
        port: capability.transport.port,
        allowHalfOpen: true,
      })
      : createConnection({ path: capability.transport.path, allowHalfOpen: true });
    const output: Buffer[] = [];
    let settled = false;
    const finish = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveExchange(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMilliseconds);
    socket.on('error', () => finish(null));
    socket.on('data', (chunk: Buffer) => output.push(chunk));
    socket.on('end', () => finish(output.length === 0 ? null : Buffer.concat(output)));
    socket.on('connect', () => {
      if (mode === 'valid-split') {
        socket.write(valid.subarray(0, 2));
        socket.write(valid.subarray(2, 17));
        socket.end(valid.subarray(17));
      } else if (mode === 'unauthenticated') {
        const parsed = unframe(valid) as Record<string, unknown>;
        socket.end(frame({ ...parsed, authenticator: '0'.repeat(64) }));
      } else if (mode === 'wrong-transport-binding') {
        const parsed = unframe(valid) as Record<string, unknown>;
        const { authenticator: _authenticator, ...unsigned } = parsed;
        const tampered = { ...unsigned, transportBinding: '0'.repeat(64) };
        socket.end(frame({
          ...tampered,
          authenticator: ownerMac(capability.secret, 'request', tampered),
        }));
      } else if (mode === 'coalesced') {
        socket.end(Buffer.concat([valid, valid]));
      } else if (mode === 'delayed-trailing') {
        socket.write(valid);
        setTimeout(() => socket.end(Buffer.from('x')), 25);
      } else if (mode === 'partial') {
        socket.end(valid.subarray(0, valid.length - 1));
      } else if (mode === 'oversize') {
        const declaration = Buffer.alloc(4);
        declaration.writeUInt32BE(1_021, 0);
        socket.end(declaration);
      } else {
        socket.write(valid);
      }
    });
  });
}

type FakeResponseMode =
  | 'valid-split'
  | 'invalid-authenticator'
  | 'malformed-snapshot'
  | 'coalesced'
  | 'delayed-trailing'
  | 'partial'
  | 'oversize'
  | 'slowloris';

function decodeFrame(input: Buffer): Record<string, unknown> | null {
  if (input.length < 4 || input.readUInt32BE(0) !== input.length - 4) return null;
  try {
    const value: unknown = JSON.parse(input.subarray(4).toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function inspectThroughFakeOwner(
  mode: FakeResponseMode,
  timeoutMilliseconds = 200,
): Promise<Awaited<ReturnType<typeof inspect>>> {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${statePath}${suffix}`, { force: true });
  const liveStore = healthyStore();
  const sockets = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const requestChunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => requestChunks.push(chunk));
    socket.on('error', () => undefined);
    socket.on('end', () => {
      const parsed = decodeFrame(Buffer.concat(requestChunks));
      if (parsed === null) {
        socket.destroy();
        return;
      }
      const { authenticator: _authenticator, ...unsignedRequest } = parsed;
      const capability = capabilities.active();
      const unsignedResponse = {
        version: 2,
        stateIdentity: parsed['stateIdentity'],
        capabilityId: parsed['capabilityId'],
        transportBinding: parsed['transportBinding'],
        nonce: parsed['nonce'],
        capturedAt: TRANSPORT_AT,
        schemaVersion: 15,
        snapshot: mode === 'malformed-snapshot'
          ? { body: 'SENTINEL_PRIVATE' }
          : projectedSnapshot({
            gateCards: 0,
            channelDeliveries: 0,
            resumeBaselines: 0,
            legacyNotifications: 0,
            slackRootIntents: 0,
          }),
      };
      const valid = frame({
        ...unsignedResponse,
        authenticator: mode === 'invalid-authenticator'
          ? '0'.repeat(64)
          : ownerMac(capability.secret, 'response', {
            request: unsignedRequest,
            response: unsignedResponse,
          }),
      });
      if (mode === 'valid-split') {
        socket.write(valid.subarray(0, 1));
        socket.write(valid.subarray(1, 19));
        socket.end(valid.subarray(19));
      } else if (mode === 'coalesced') {
        socket.end(Buffer.concat([valid, valid]));
      } else if (mode === 'delayed-trailing') {
        socket.write(valid);
        setTimeout(() => socket.end(Buffer.from('x')), 25);
      } else if (mode === 'partial') {
        socket.end(valid.subarray(0, valid.length - 1));
      } else if (mode === 'oversize') {
        const declaration = Buffer.alloc(4);
        declaration.writeUInt32BE(65_533, 0);
        socket.end(declaration);
      } else if (mode === 'slowloris') {
        socket.write(valid);
      } else {
        socket.end(valid);
      }
    });
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
    capabilities.document = activeOperationalStatusCapability(
      operationalStatusStateIdentity(statePath, 'win32'),
      { kind: 'tcp', host: '127.0.0.1', port: address.port },
      TRANSPORT_AT,
    );
    return await inspect({ platform: 'win32', ownerTimeoutMilliseconds: timeoutMilliseconds });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    liveStore.close();
  }
}

function projectedSnapshot(
  pending: {
    readonly gateCards: number;
    readonly channelDeliveries: number;
    readonly resumeBaselines: number;
    readonly legacyNotifications: number;
    readonly slackRootIntents: number;
  },
  uncertain = 0,
  dead = 0,
): OperationalStatusSnapshot {
  return projectOperationalStore({
    readDaemonHealth: () => ({
      revision: 0,
      instanceId: INSTANCE,
      buildFingerprint: fingerprintOperationalBuild(BUILD),
      configFingerprint: fingerprintOperationalConfig(config),
      desiredState: 'running',
      state: 'running',
      startedAt: AT0,
      heartbeatAt: AT0,
      cleanStoppedAt: null,
      lastErrorCode: null,
      updatedAt: AT0,
    }),
    findDaemonJobOutcome: (jobName) => ({
      jobName,
      revision: 1,
      state: 'succeeded',
      attempt: 1,
      consecutiveFailures: 0,
      startedAt: AT0,
      completedAt: AT1,
      lastSuccessAt: AT1,
      lastFailureAt: null,
      durationMs: 1,
      nextRunAt: NEXT,
      errorCode: null,
      processedCount: 0,
      deferredCount: 0,
      checkpoint: 0,
      updatedAt: AT1,
    }),
    readEffectiveDiscoverySnapshot: () => ({ repositories: [], bindings: [], issues: [] }),
    readOperationalAggregateCounts: () => ({
      pending: { ...pending, total: pending.gateCards + pending.channelDeliveries +
        pending.resumeBaselines + pending.legacyNotifications + pending.slackRootIntents },
      uncertain: { slackRootIntents: uncertain, total: uncertain },
      dead: { unavailableResumeBaselines: dead, total: dead },
    }),
  }, {
    configFingerprint: fingerprintOperationalConfig(config),
    buildFingerprint: fingerprintOperationalBuild(BUILD),
  });
}

describe('read-only operational status classification', () => {
  // This one integration owns schema creation, WAL checkpoint, online backup, and strict reopen.
  // Assert the production all-pages operation directly; wall time includes unrelated CI scheduling.
  it('reports a fully matched daemon as healthy with static aggregate-only output', async () => {
    healthyStore().close();
    let backupRate: number | null = null;
    const report = await inspect({
      sqliteBackup: async (source, destination, options) => {
        backupRate = options?.rate ?? null;
        return await backup(source, destination, options);
      },
    });
    expect(backupRate).toBe(2_147_483_647);
    expect(report).toMatchObject({
      overall: 'healthy', exitCode: 0, codes: ['status.healthy'],
      schema: { state: 'matched', expectedVersion: 15, foundVersion: 15 },
      config: { state: 'matched' }, build: { state: 'matched' },
      daemon: { state: 'running', desiredState: 'running', heartbeatAgeSeconds: 30 },
      registry: { active: 0, pending: 0, rejected: 0, deferred: 0 },
      work: { pending: { actionableTotal: 0, legacyNotifications: 0 } },
    });
    expect(report.jobs.every((job) => job.state === 'succeeded')).toBe(true);
    const rendered = `${formatOperationalStatus(report)}\n${JSON.stringify(report)}`;
    for (const privateValue of [INSTANCE, 'Project Sentinel', 'private-owner', statePath, dir, BUILD]) {
      expect(rendered).not.toContain(privateValue);
    }
  }, 15_000);

  it('reads the daemon-owner projection without changing main, WAL, SHM, or directory entries', async () => {
    const store = healthyStore();
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(TRANSPORT_AT),
    });
    try {
      await owner.start();
      const sourceFiles = [`${statePath}`, `${statePath}-wal`, `${statePath}-shm`];
      const before = sourceFiles.map((path) => ({ path, hash: sha256(path) }));
      const beforeFiles = readdirSync(dir).sort();
      const wire = await rawOwnerFrame();
      expect(unframe(wire)).toMatchObject({ version: 2, schemaVersion: 15 });
      for (const privateValue of [
        INSTANCE, BUILD, fingerprintOperationalConfig(config),
        fingerprintOperationalBuild(BUILD), statePath, dir,
      ]) expect(wire.toString('utf8')).not.toContain(privateValue);
      const report = await inspect();
      expect(report).toMatchObject({ exitCode: 0, schema: { state: 'matched' } });
      expect(store.readDaemonHealth()).toMatchObject({ state: 'running' });
      for (const source of before) expect(sha256(source.path)).toBe(source.hash);
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('allows both Windows protected reads across a same-capability production refresh', async () => {
    const store = healthyStore();
    const protectedReadDelayMilliseconds = 1_100;
    const refreshedHeartbeat = '2026-08-26T00:00:20.000Z';
    const completedReadDurations: number[] = [];
    const capabilitiesDuringOwnerRead: ActiveOperationalStatusCapability[] = [];
    type TestOwnerGeneration = { readonly capability: ActiveOperationalStatusCapability };
    const generationsAtOwnerReadBoundary: TestOwnerGeneration[] = [];
    let ownerProtectedReadActive = false;
    let refreshHeartbeatRecorded = false;
    capabilities.requestVerification = async (signal) => {
      const ownerProtectedRead = capabilities.requestReads === 2;
      if (ownerProtectedRead) {
        ownerProtectedReadActive = true;
        const generation = (owner as unknown as {
          readonly generation: TestOwnerGeneration | null;
        }).generation;
        if (generation !== null) generationsAtOwnerReadBoundary.push(generation);
      }
      const startedAt = process.hrtime.bigint();
      try {
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout>;
          const finish = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
          };
          timer = setTimeout(finish, protectedReadDelayMilliseconds);
          timer.unref?.();
          signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
        completedReadDurations.push(
          Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        );
      } finally {
        if (ownerProtectedRead) {
          const generation = (owner as unknown as {
            readonly generation: TestOwnerGeneration | null;
          }).generation;
          if (generation !== null) generationsAtOwnerReadBoundary.push(generation);
          ownerProtectedReadActive = false;
        }
      }
    };
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      platform: 'win32',
      clock: () => new Date(TRANSPORT_AT),
      beforeRefresh: () => {
        if (!ownerProtectedReadActive) return;
        capabilitiesDuringOwnerRead.push(capabilities.active());
        if (!refreshHeartbeatRecorded) {
          refreshHeartbeatRecorded =
            store.recordDaemonHeartbeat(INSTANCE, refreshedHeartbeat) !== null;
        }
      },
    });
    try {
      await owner.start();
      const initialCapability = capabilities.active();
      const report = await inspect({ platform: 'win32' });
      expect({
        report,
        requestReads: capabilities.requestReads,
        completedReadDurations,
      }).toMatchObject({
        report: { exitCode: 0, codes: ['status.healthy'] },
        requestReads: 2,
      });
      // The client verifies first; after request EOF the owner verifies the same protected artifact.
      expect(completedReadDurations).toHaveLength(2);
      expect(completedReadDurations.every((duration) => duration >= 1_000)).toBe(true);
      expect(capabilitiesDuringOwnerRead.length).toBeGreaterThanOrEqual(1);
      expect(generationsAtOwnerReadBoundary).toHaveLength(2);
      const generationAtOwnerReadStart = generationsAtOwnerReadBoundary[0];
      const generationAtOwnerReadEnd = generationsAtOwnerReadBoundary[1];
      expect(generationAtOwnerReadEnd).not.toBe(generationAtOwnerReadStart);
      expect(generationAtOwnerReadStart?.capability).toEqual(initialCapability);
      expect(generationAtOwnerReadEnd?.capability).toEqual(initialCapability);
      expect(capabilitiesDuringOwnerRead.every(
        (capability) => JSON.stringify(capability) === JSON.stringify(initialCapability),
      )).toBe(true);
      expect(capabilities.active()).toEqual(initialCapability);
      expect(refreshHeartbeatRecorded).toBe(true);
      expect(store.readDaemonHealth()?.heartbeatAt).toBe(refreshedHeartbeat);
      expect(report.daemon?.heartbeatAgeSeconds).toBe(30);
    } finally {
      capabilities.requestVerification = null;
      await owner.stop();
      store.close();
    }
  }, 10_000);

  it('preserves explicit null as the owner refresh timer disable sentinel', async () => {
    const store = healthyStore();
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(TRANSPORT_AT),
    });
    try {
      await owner.start();
      expect((owner as unknown as {
        readonly timer: ReturnType<typeof setInterval> | null;
      }).timer).toBeNull();
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('retains a fresh owner snapshot across an exact commit/checkpoint refresh interleaving', async () => {
    const store = healthyStore();
    const checkpoint = new DatabaseSync(statePath);
    const freshHeartbeat = '2026-08-26T00:02:00.000Z';
    let armed = false;
    let checkpointed = false;
    let checkpointResult: { readonly busy: number; readonly log: number; readonly checkpointed: number } | null = null;
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(TRANSPORT_AT),
      beforeRefresh: () => {
        if (armed) expect(store.recordDaemonHeartbeat(INSTANCE, freshHeartbeat)).not.toBeNull();
      },
      afterDaemonCapture: () => {
        if (!armed || checkpointed) return;
        checkpointed = true;
        checkpointResult = checkpoint.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
          readonly busy: number; readonly log: number; readonly checkpointed: number;
        };
      },
    });
    try {
      await owner.start();
      armed = true;
      owner.refresh();
      const sourceFiles = [`${statePath}`, `${statePath}-wal`, `${statePath}-shm`];
      const before = sourceFiles.map((path) => ({ path, hash: sha256(path) }));
      const beforeFiles = readdirSync(dir).sort();
      const report = await inspect({
        clock: () => new Date('2026-08-26T00:02:30.000Z'),
      });
      expect(checkpointed).toBe(true);
      expect(checkpointResult).toMatchObject({ busy: 0 });
      expect(report).toMatchObject({
        exitCode: 0,
        daemon: { heartbeatAgeSeconds: 30 },
        codes: ['status.healthy'],
      });
      expect(store.readDaemonHealth()?.heartbeatAt).toBe(freshHeartbeat);
      for (const source of before) expect(sha256(source.path)).toBe(source.hash);
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
    } finally {
      await owner.stop();
      checkpoint.close();
      store.close();
    }
  });

  it('fails closed without touching a live WAL when its owner endpoint is absent', async () => {
    const store = healthyStore();
    try {
      const sourceFiles = [`${statePath}`, `${statePath}-wal`, `${statePath}-shm`];
      const before = sourceFiles.map((path) => ({ path, hash: sha256(path) }));
      const beforeFiles = readdirSync(dir).sort();
      const report = await inspect({ ownerTimeoutMilliseconds: 50 });
      expect(report).toMatchObject({
        exitCode: 2,
        schema: { state: 'unavailable' },
        codes: ['state.snapshot_unavailable'],
      });
      for (const source of before) expect(sha256(source.path)).toBe(source.hash);
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
    } finally {
      store.close();
    }
  });

  it('never opens an immutable source when a writer starts after the negative WAL witness', async () => {
    healthyStore().close();
    let writer: SqliteDigestStore | null = null;
    let sourceOpenAdmitted = false;
    try {
      const report = await inspect({
        afterClosedWalClassification: () => {
          writer = new SqliteDigestStore(statePath);
          expect(writer.recordDaemonHeartbeat(INSTANCE, '2026-08-26T00:00:45.000Z')).not.toBeNull();
        },
        beforeClosedSourceOpen: () => { sourceOpenAdmitted = true; },
      });
      expect(sourceOpenAdmitted).toBe(false);
      expect(report).toMatchObject({
        exitCode: 2,
        schema: { state: 'unavailable' },
        codes: ['state.snapshot_unavailable'],
      });
    } finally {
      (writer as SqliteDigestStore | null)?.close();
    }
  });

  it('maps a writer mutation plus immutable backup exception to owner unavailable', async () => {
    healthyStore().close();
    let sourceOpenAdmitted = false;
    let writer: SqliteDigestStore | null = null;
    try {
      const report = await inspect({
        beforeClosedSourceOpen: () => { sourceOpenAdmitted = true; },
        afterSqliteBackupStep: () => {
          writer = new SqliteDigestStore(statePath);
          expect(writer.recordDaemonHeartbeat(INSTANCE, '2026-08-26T00:00:50.000Z')).not.toBeNull();
          throw new Error('synthetic backup failure after writer transition');
        },
      });
      expect(sourceOpenAdmitted).toBe(true);
      expect(report).toMatchObject({
        exitCode: 2,
        schema: { state: 'unavailable' },
        codes: ['state.snapshot_unavailable'],
      });
    } finally {
      (writer as SqliteDigestStore | null)?.close();
    }
  });

  it('routes lease contention without classifying WAL or admitting an immutable source', async () => {
    healthyStore().close();
    const identity = operationalStatusStateIdentity(statePath);
    const writerClaim = await capabilities.acquireOwnerClaim(capabilityPath, identity);
    let classified = false;
    let sourceOpenAdmitted = false;
    try {
      const report = await inspect({
        afterClosedWalClassification: () => { classified = true; },
        beforeClosedSourceOpen: () => { sourceOpenAdmitted = true; },
      });
      expect(classified).toBe(false);
      expect(sourceOpenAdmitted).toBe(false);
      expect(report).toMatchObject({
        exitCode: 2,
        schema: { state: 'unavailable' },
        codes: ['state.snapshot_unavailable'],
      });
    } finally {
      await writerClaim.release();
    }
  });

  it('rejects a signed malformed aggregate owner response without echoing private input', async () => {
    const report = await inspectThroughFakeOwner('malformed-snapshot');
    expect(report).toMatchObject({ exitCode: 2, codes: ['state.snapshot_unavailable'] });
    expect(JSON.stringify(report)).not.toContain('SENTINEL');
    expect(capabilities.requestReads).toBe(1);
  });

  it('rejects a stale owner cache and removes the endpoint on bounded shutdown', async () => {
    const store = healthyStore();
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date('2000-01-01T00:00:00.000Z'),
    });
    try {
      await owner.start();
      const sourceFiles = [`${statePath}`, `${statePath}-wal`, `${statePath}-shm`];
      const before = sourceFiles.map((path) => ({ path, hash: sha256(path) }));
      const beforeFiles = readdirSync(dir).sort();
      expect(await inspect()).toMatchObject({
        exitCode: 2, codes: ['state.snapshot_unavailable'],
      });
      for (const source of before) expect(sha256(source.path)).toBe(source.hash);
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
      await owner.stop();
      expect(await inspect({ ownerTimeoutMilliseconds: 50 })).toMatchObject({
        exitCode: 2, codes: ['state.snapshot_unavailable'],
      });
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('requires one authenticated frame through Windows TCP half-close or non-Windows UDS EOF', async () => {
    const store = healthyStore();
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(TRANSPORT_AT),
    });
    try {
      await owner.start();
      expect(unframe((await rawOwnerExchange('valid-split'))!)).toMatchObject({
        version: 2,
        schemaVersion: 15,
      });
      for (const mode of [
        'unauthenticated', 'wrong-transport-binding', 'coalesced', 'delayed-trailing',
        'partial', 'oversize',
      ] as const) {
        expect(await rawOwnerExchange(mode)).toBeNull();
      }
      expect(await rawOwnerExchange('slowloris', 1_200)).toBeNull();
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('applies one non-refreshing deadline across all eight trickling request slots', async () => {
    const store = healthyStore();
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      requestIdleTimeoutMilliseconds: 40,
      requestAbsoluteDeadlineMilliseconds: 160,
      clock: () => new Date(TRANSPORT_AT),
    });
    const sockets: Socket[] = [];
    const intervals: Array<ReturnType<typeof setInterval>> = [];
    try {
      await owner.start();
      expect(capabilities.active().transport.kind)
        .toBe(process.platform === 'win32' ? 'tcp' : 'pipe');
      const capability = capabilities.active();
      const request = validRawOwnerRequest(capability, '9'.repeat(32));
      const open = new Set<Socket>();
      const closes: Array<Promise<void>> = [];
      for (let index = 0; index < 8; index += 1) {
        const socket = capability.transport.kind === 'tcp'
          ? createConnection({ ...capability.transport, allowHalfOpen: true })
          : createConnection({ path: capability.transport.path, allowHalfOpen: true });
        sockets.push(socket);
        open.add(socket);
        closes.push(new Promise<void>((resolveClose) => socket.once('close', () => {
          open.delete(socket);
          resolveClose();
        })));
        await new Promise<void>((resolveConnect, rejectConnect) => {
          socket.once('connect', resolveConnect);
          socket.once('error', rejectConnect);
        });
        let offset = 0;
        socket.write(request.subarray(offset, ++offset));
        const interval = setInterval(() => {
          if (socket.destroyed) return;
          socket.write(request.subarray(offset, ++offset));
        }, 20);
        intervals.push(interval);
        socket.once('close', () => clearInterval(interval));
      }
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(open.size).toBe(8);
      await Promise.race([
        Promise.all(closes),
        new Promise((_, reject) => setTimeout(() => reject(new Error('absolute deadline leaked sockets')), 500)),
      ]);
      expect(open.size).toBe(0);
      expect(await exchangeAuthenticatedOwnerFrame(
        validRawOwnerRequest(capabilities.active(), '8'.repeat(32)),
      )).not.toBeNull();
    } finally {
      for (const interval of intervals) clearInterval(interval);
      for (const socket of sockets) socket.destroy();
      await owner.stop();
      store.close();
    }
  });

  it('cancels eight concurrent capability verifiers without blocking the absolute deadline', async () => {
    const store = healthyStore();
    let activeVerifiers = 0;
    let startedVerifiers = 0;
    capabilities.requestVerification = async (signal) => await new Promise<void>((resolve) => {
      activeVerifiers += 1;
      startedVerifiers += 1;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        activeVerifiers -= 1;
        resolve();
      };
      const timer = setTimeout(finish, 1_000);
      timer.unref?.();
      signal.addEventListener('abort', finish, { once: true });
    });
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      requestIdleTimeoutMilliseconds: 150,
      requestAbsoluteDeadlineMilliseconds: 160,
      clock: () => new Date(TRANSPORT_AT),
    });
    const sockets: Socket[] = [];
    try {
      await owner.start();
      const capability = capabilities.active();
      const startedAt = process.hrtime.bigint();
      const closes = Array.from({ length: 8 }, (_, index) => new Promise<void>((resolveClose) => {
        const nonce = index.toString(16).padStart(32, '0');
        const socket = capability.transport.kind === 'tcp'
          ? createConnection({ ...capability.transport, allowHalfOpen: true })
          : createConnection({ path: capability.transport.path, allowHalfOpen: true });
        sockets.push(socket);
        socket.once('connect', () => socket.end(validRawOwnerRequest(capability, nonce)));
        socket.once('close', resolveClose);
        socket.on('error', () => undefined);
      }));
      await Promise.race([
        Promise.all(closes),
        new Promise((_, reject) => setTimeout(
          () => reject(new Error('deadline leaked verifier sockets')),
          400,
        )),
      ]);
      const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      expect(startedVerifiers).toBe(8);
      expect(activeVerifiers).toBe(0);
      expect(elapsedMilliseconds).toBeLessThan(300);
    } finally {
      capabilities.requestVerification = null;
      for (const socket of sockets) socket.destroy();
      await owner.stop();
      store.close();
    }
  });

  it('accepts one split authenticated response only after EOF and rejects every trailing form', async () => {
    expect(await inspectThroughFakeOwner('valid-split')).toMatchObject({
      exitCode: 0,
      codes: ['status.healthy'],
    });
    for (const mode of [
      'coalesced', 'delayed-trailing', 'partial', 'oversize', 'slowloris',
    ] as const) {
      expect(await inspectThroughFakeOwner(mode, mode === 'slowloris' ? 100 : 200)).toMatchObject({
        exitCode: 2,
        codes: ['state.snapshot_unavailable'],
      });
    }
  });

  it('rejects a raw loopback squatter that echoes the nonce and a healthy aggregate', async () => {
    expect(await inspectThroughFakeOwner('invalid-authenticator')).toMatchObject({
      overall: 'unavailable',
      exitCode: 2,
      codes: ['state.snapshot_unavailable'],
    });
    expect(capabilities.requestReads).toBe(1);
  });

  it('re-reads the protected capability once when the owner rotates before authentication', async () => {
    const store = healthyStore();
    let transportTime = Date.parse(TRANSPORT_AT);
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(transportTime),
    });
    try {
      await owner.start();
      const first = capabilities.active();
      let rotated = false;
      capabilities.afterRequestRead = (observed) => {
        if (rotated || observed.kind !== 'ready' ||
            observed.value.status !== 'active' ||
            observed.value.capabilityId !== first.capabilityId) return;
        rotated = true;
        capabilities.afterRequestRead = null;
        transportTime += STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS;
        owner.refresh();
      };

      expect(await inspect({
        ownerTransportClock: () => new Date(transportTime),
      })).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
      const replacement = capabilities.active();
      expect(rotated).toBe(true);
      expect(replacement.transport).toEqual(first.transport);
      expect(replacement.capabilityId).not.toBe(first.capabilityId);
      expect(replacement.secret).not.toBe(first.secret);
      // Initial read, protected re-read, then the owner's request-time verification.
      expect(capabilities.requestReads).toBe(3);
    } finally {
      capabilities.afterRequestRead = null;
      await owner.stop();
      store.close();
    }
  });

  it('rejects rotation after owner verification before one fresh-generation retry', async () => {
    const store = healthyStore();
    let transportTime = Date.parse(TRANSPORT_AT);
    let rotated = false;
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(transportTime),
    });
    try {
      await owner.start();
      const first = capabilities.active();
      capabilities.afterRequestRead = (observed) => {
        if (rotated || capabilities.requestReads !== 2 || observed.kind !== 'ready' ||
            observed.value.capabilityId !== first.capabilityId) return;
        rotated = true;
        capabilities.afterRequestRead = null;
        transportTime += STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS;
        owner.refresh();
      };

      expect(await inspect({
        ownerTransportClock: () => new Date(transportTime),
      })).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
      const replacement = capabilities.active();
      expect(rotated).toBe(true);
      expect(replacement.capabilityId).not.toBe(first.capabilityId);
      expect(replacement.secret).not.toBe(first.secret);
      // Initial client/owner reads reject the old generation; the protected re-read/retry adds two.
      expect(capabilities.requestReads).toBe(4);
    } finally {
      capabilities.afterRequestRead = null;
      await owner.stop();
      store.close();
    }
  });

  it('does not retry an empty stable-capability failure', async () => {
    const store = healthyStore();
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => undefined);
      socket.on('end', () => socket.destroy());
    });
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
      capabilities.document = activeOperationalStatusCapability(
        operationalStatusStateIdentity(statePath, 'win32'),
        { kind: 'tcp', host: '127.0.0.1', port: address.port },
        TRANSPORT_AT,
      );

      expect(await inspect({
        platform: 'win32',
        ownerTimeoutMilliseconds: 200,
      })).toMatchObject({ exitCode: 2, codes: ['state.snapshot_unavailable'] });
      expect(connections).toBe(1);
      expect(capabilities.requestReads).toBe(2);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      store.close();
    }
  });

  it.each([
    ['capability ID', 'capabilityId'],
    ['capability secret', 'secret'],
  ] as const)('does not retry when only the %s changes', async (_label, changedField) => {
    const store = healthyStore();
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => undefined);
      socket.on('end', () => socket.destroy());
    });
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
      const transport = { kind: 'tcp', host: '127.0.0.1', port: address.port } as const;
      capabilities.document = activeOperationalStatusCapability(
        operationalStatusStateIdentity(statePath, 'win32'),
        transport,
        TRANSPORT_AT,
      );
      const first = capabilities.active();
      const generated = activeOperationalStatusCapability(
        first.stateIdentity,
        transport,
        TRANSPORT_AT,
      );
      const halfRotated: ActiveOperationalStatusCapability = changedField === 'capabilityId'
        ? { ...generated, secret: first.secret }
        : { ...generated, capabilityId: first.capabilityId };
      capabilities.afterRequestRead = (observed) => {
        if (capabilities.requestReads !== 1 || observed.kind !== 'ready') return;
        capabilities.afterRequestRead = null;
        capabilities.document = structuredClone(halfRotated);
      };

      expect(await inspect({
        platform: 'win32',
        ownerTimeoutMilliseconds: 200,
      })).toMatchObject({ exitCode: 2, codes: ['state.snapshot_unavailable'] });
      const replacement = capabilities.active();
      expect(replacement.capabilityId === first.capabilityId)
        .toBe(changedField !== 'capabilityId');
      expect(replacement.secret === first.secret).toBe(changedField !== 'secret');
      expect(connections).toBe(1);
      expect(capabilities.requestReads).toBe(2);
    } finally {
      capabilities.afterRequestRead = null;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      store.close();
    }
  });

  it('keeps the non-Windows default owner-request deadline bounded to one second', async () => {
    const store = healthyStore();
    const nonWindowsCapabilities = new MemoryCapabilityStore();
    nonWindowsCapabilities.requestVerification = async (signal) => {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), {
        once: true,
      }));
    };
    let claim: OperationalStatusOwnerClaim | null = null;
    try {
      const stateIdentity = operationalStatusStateIdentity(statePath, 'linux');
      claim = await nonWindowsCapabilities.acquireOwnerClaim(capabilityPath, stateIdentity);
      const startedAt = process.hrtime.bigint();

      expect(await inspect({
        platform: 'linux',
        ownerCapabilityStore: nonWindowsCapabilities,
        snapshotLeaseStore: nonWindowsCapabilities,
      })).toMatchObject({ exitCode: 2, codes: ['state.snapshot_unavailable'] });
      const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      expect(elapsedMilliseconds).toBeLessThan(3_000);
      expect(nonWindowsCapabilities.requestReads).toBe(1);
    } finally {
      nonWindowsCapabilities.requestVerification = null;
      await claim?.release();
      store.close();
    }
  }, 7_500);

  it('keeps an explicit Windows timeout bounded without re-read or retry', async () => {
    const store = healthyStore();
    const sockets = new Set<Socket>();
    let connections = 0;
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      socket.on('data', () => undefined);
      // Hold the readable half open until the client's one overall deadline closes it.
      socket.on('end', () => undefined);
    });
    try {
      await new Promise<void>((resolveListen, reject) => {
        server.once('error', reject);
        server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen);
      });
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('expected TCP listener');
      capabilities.document = activeOperationalStatusCapability(
        operationalStatusStateIdentity(statePath, 'win32'),
        { kind: 'tcp', host: '127.0.0.1', port: address.port },
        TRANSPORT_AT,
      );
      const startedAt = process.hrtime.bigint();

      expect(await inspect({
        platform: 'win32',
        ownerTimeoutMilliseconds: 50,
      })).toMatchObject({ exitCode: 2, codes: ['state.snapshot_unavailable'] });
      const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      expect(elapsedMilliseconds).toBeLessThan(200);
      expect(connections).toBe(1);
      expect(capabilities.requestReads).toBe(1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      store.close();
    }
  });

  it('rotates a stolen capability and rejects the old authenticator while serving the new one', async () => {
    const store = healthyStore();
    let transportTime = Date.parse(TRANSPORT_AT);
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(transportTime),
    });
    try {
      await owner.start();
      const stolen = new MemoryCapabilityStore();
      stolen.document = capabilities.active();
      const old = stolen.active();
      transportTime += STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS;
      owner.refresh();
      const rotated = capabilities.active();
      expect(rotated.capabilityId).not.toBe(old.capabilityId);
      expect(rotated.secret).not.toBe(old.secret);
      expect(await inspect({
        ownerCapabilityStore: stolen,
        ownerTransportClock: () => new Date(transportTime),
      })).toMatchObject({ exitCode: 2, codes: ['state.snapshot_unavailable'] });
      expect(await inspect({
        ownerTransportClock: () => new Date(transportTime),
      })).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('replaces stale protected metadata but preserves a live first owner against a second daemon', async () => {
    const store = healthyStore();
    const transportTime = Date.parse(TRANSPORT_AT);
    const stale = activeOperationalStatusCapability(
      operationalStatusStateIdentity(statePath),
      { kind: 'tcp', host: '127.0.0.1', port: 1 },
      new Date(transportTime - STATUS_OWNER_CAPABILITY_MAX_AGE_MS - 1).toISOString(),
    );
    capabilities.document = stale;
    const first = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(transportTime),
    });
    const second = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(transportTime),
    });
    try {
      await first.start();
      const firstCapability = capabilities.active();
      expect(firstCapability.secret).not.toBe(stale.secret);
      await expect(second.start()).rejects.toThrow('status.owner_start_failed');
      expect(capabilities.active()).toEqual(firstCapability);
      expect(await inspect({
        ownerTransportClock: () => new Date(transportTime),
      })).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    } finally {
      await second.stop();
      await first.stop();
      store.close();
    }
  });

  it('reclaims a verified fresh crash residue but fails closed on malformed metadata, races, and permission drift', async () => {
    const store = healthyStore();
    const now = new Date(TRANSPORT_AT);
    const makeOwner = () => new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => now,
    });
    const squat = activeOperationalStatusCapability(
      operationalStatusStateIdentity(statePath),
      { kind: 'tcp', host: '127.0.0.1', port: 1 },
      now.toISOString(),
    );
    capabilities.document = squat;
    const restarted = makeOwner();
    await restarted.start();
    expect(capabilities.active().capabilityId).not.toBe(squat.capabilityId);
    await restarted.stop();

    capabilities.document = null;
    capabilities.invalid = true;
    await expect(makeOwner().start()).rejects.toThrow('status.owner_start_failed');

    capabilities.invalid = false;
    capabilities.raceAfterPublish = squat;
    await expect(makeOwner().start()).rejects.toThrow('status.owner_start_failed');
    expect(capabilities.document).toEqual(squat);

    capabilities.raceAfterPublish = null;
    capabilities.document = null;
    const owner = makeOwner();
    try {
      await owner.start();
      capabilities.protected = false;
      expect(await inspect()).toMatchObject({
        exitCode: 2,
        codes: ['state.snapshot_unavailable'],
      });
    } finally {
      capabilities.protected = true;
      await owner.stop();
      store.close();
    }
  });

  it('resynchronizes after a committed publish whose confirming read failed', async () => {
    // Production signature: the artifact held one fully committed capability (both slots, adjacent
    // sequences) for ten hours while the daemon stayed healthy and `status` failed closed forever.
    // `publish` commits before `refresh` records the generation, so a throw in between left the
    // durable document ahead of memory and every later rotation CAS'd against a stale `expected`.
    const store = healthyStore();
    let now = new Date(TRANSPORT_AT);
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => now,
    });
    try {
      await owner.start();
      const started = capabilities.active();

      // Rotate, letting the publish commit but failing the confirming read exactly once.
      now = new Date(Date.parse(TRANSPORT_AT) + 20_000);
      capabilities.raceAfterPublish = null;
      const confirmFailure = { invalid: false };
      const realRead = capabilities.read.bind(capabilities);
      capabilities.read = ((path: string, enforceProtection = true) =>
        confirmFailure.invalid
          ? { kind: 'invalid' as const }
          : realRead(path, enforceProtection)) as typeof capabilities.read;
      const publishedWhileFailing: string[] = [];
      const realPublish = capabilities.publish.bind(capabilities);
      capabilities.publish = ((...args: Parameters<typeof capabilities.publish>) => {
        realPublish(...args);
        publishedWhileFailing.push(capabilities.active().capabilityId);
        confirmFailure.invalid = true;
      }) as typeof capabilities.publish;

      expect(() => owner.refresh()).toThrow('status.snapshot_unavailable');
      expect(publishedWhileFailing).toHaveLength(1);
      const committed = capabilities.active();
      expect(committed.capabilityId).not.toBe(started.capabilityId);

      // The transient is over. Before the fix every later refresh threw forever because the
      // in-memory generation still held `started` while the artifact held `committed`.
      capabilities.read = realRead as typeof capabilities.read;
      capabilities.publish = realPublish as typeof capabilities.publish;
      confirmFailure.invalid = false;
      now = new Date(Date.parse(TRANSPORT_AT) + 40_000);
      expect(() => owner.refresh()).not.toThrow();
      const recovered = capabilities.active();
      expect(recovered.capabilityId).not.toBe(committed.capabilityId);
      expect(recovered.publishedAt).toBe(now.toISOString());

      // A live client reads the recovered capability, so `status` is available again.
      expect(await inspect({ ownerTransportClock: () => now }))
        .toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('adopts a durable capability only when it is provably this owner and not older', async () => {
    const store = healthyStore();
    let now = new Date(TRANSPORT_AT);
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => now,
    });
    try {
      await owner.start();
      const held = capabilities.active();
      now = new Date(Date.parse(TRANSPORT_AT) + 20_000);

      // Foreign transport: a squatter that swapped the endpoint must never be adopted.
      capabilities.document = activeOperationalStatusCapability(
        operationalStatusStateIdentity(statePath),
        { kind: 'tcp', host: '127.0.0.1', port: 1 },
        now.toISOString(),
      );
      expect(() => owner.refresh()).toThrow('status.snapshot_unavailable');

      // Foreign state identity: same shape, different database.
      capabilities.document = activeOperationalStatusCapability(
        'f'.repeat(64),
        held.transport,
        now.toISOString(),
      );
      expect(() => owner.refresh()).toThrow('status.snapshot_unavailable');

      // A rolled-back, older document is not adopted either.
      capabilities.document = activeOperationalStatusCapability(
        operationalStatusStateIdentity(statePath),
        held.transport,
        new Date(Date.parse(TRANSPORT_AT) - 60_000).toISOString(),
      );
      expect(() => owner.refresh()).toThrow('status.snapshot_unavailable');

      // None of the three was adopted, so the owner still holds its own capability and can retire it.
      capabilities.document = held;
      expect(() => owner.refresh()).not.toThrow();
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('serves eight concurrent clients and deterministically shuts down and rebinds', async () => {
    const store = healthyStore();
    const options = {
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(TRANSPORT_AT),
    } as const;
    const first = new OperationalStatusOwnerServer(options);
    await first.start();
    const firstCapability = capabilities.active();
    const reports = await Promise.all(Array.from({ length: 8 }, async () => await inspect()));
    expect(reports.every((report) => report.exitCode === 0)).toBe(true);
    await first.stop();
    expect(capabilities.document).toBeNull();
    expect(await inspect({ ownerTimeoutMilliseconds: 50 })).toMatchObject({ exitCode: 2 });

    const second = new OperationalStatusOwnerServer(options);
    try {
      await second.start();
      expect(capabilities.active().capabilityId).not.toBe(firstCapability.capabilityId);
      expect(await inspect()).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    } finally {
      await second.stop();
      store.close();
    }
  });

  it('rejects tampered and external transport endpoints before making a connection', async () => {
    const liveStore = healthyStore();
    try {
      const capability = activeOperationalStatusCapability(
        operationalStatusStateIdentity(statePath, 'win32'),
        { kind: 'tcp', host: '127.0.0.1', port: 1 },
        TRANSPORT_AT,
      );
      capabilities.document = {
        ...capability,
        transport: { kind: 'tcp', host: '0.0.0.0', port: 1 },
      } as unknown as OperationalStatusCapabilityDocument;
      expect(await inspect({ platform: 'win32', ownerTimeoutMilliseconds: 50 })).toMatchObject({
        exitCode: 2,
        codes: ['state.snapshot_unavailable'],
      });
      capabilities.document = {
        ...capability,
        transport: { kind: 'tcp', host: '127.0.0.1', port: 0 },
      } as unknown as OperationalStatusCapabilityDocument;
      expect(await inspect({ platform: 'win32', ownerTimeoutMilliseconds: 50 }))
        .toMatchObject({ exitCode: 2 });
    } finally {
      liveStore.close();
    }
  });

  it('releases a failed rotation claim without deleting the raced replacement', async () => {
    const store = healthyStore();
    let transportTime = Date.parse(TRANSPORT_AT);
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(transportTime),
    });
    const squat = activeOperationalStatusCapability(
      operationalStatusStateIdentity(statePath),
      { kind: 'tcp', host: '127.0.0.1', port: 1 },
      new Date(transportTime).toISOString(),
    );
    try {
      await owner.start();
      capabilities.raceAfterPublish = squat;
      transportTime += STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS;
      expect(() => owner.refresh()).toThrow('status.snapshot_unavailable');
      expect(capabilities.document).toEqual(squat);
      capabilities.raceAfterPublish = null;
      await expect(owner.stop()).rejects.toThrow('status.owner_stop_failed');
      expect(capabilities.document).toEqual(squat);

      capabilities.document = null;
      const rebound = new OperationalStatusOwnerServer({
        statePath,
        store,
        capabilityPath,
        capabilityStore: capabilities,
        refreshMilliseconds: null,
        clock: () => new Date(transportTime),
      });
      await rebound.start();
      await rebound.stop();
    } finally {
      capabilities.raceAfterPublish = null;
      await owner.stop().catch(() => undefined);
      store.close();
    }
  });

  it('grants one per-state owner claim under a concurrent two-daemon start interleaving', async () => {
    const store = healthyStore();
    const options = {
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(TRANSPORT_AT),
    } as const;
    const owners = [
      new OperationalStatusOwnerServer(options),
      new OperationalStatusOwnerServer(options),
    ] as const;
    const results = await Promise.allSettled(owners.map(async (owner) => owner.start()));
    const winners = results.flatMap((result, index) => result.status === 'fulfilled' ? [index] : []);
    const losers = results.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(String((losers[0] as PromiseRejectedResult).reason)).toContain('status.owner_start_failed');
    const winner = winners[0];
    if (winner === undefined) throw new Error('expected one owner winner');
    const published = capabilities.active();
    try {
      await owners[1 - winner]!.stop();
      expect(capabilities.active()).toEqual(published);
    } finally {
      await owners[winner]!.stop();
      store.close();
    }
    expect(capabilities.document).toBeNull();
  });

  it('rejects replayed and concurrent duplicate authenticated nonces until expiry or epoch reset', async () => {
    const store = healthyStore();
    let transportTime = Date.parse(TRANSPORT_AT);
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      clock: () => new Date(transportTime),
    });
    try {
      await owner.start();
      let capability = capabilities.active();
      const replayNonce = 'c'.repeat(32);
      const request = validRawOwnerRequest(capability, replayNonce, new Date(transportTime).toISOString());
      expect(await exchangeAuthenticatedOwnerFrame(request)).not.toBeNull();
      expect(await exchangeAuthenticatedOwnerFrame(request)).toBeNull();

      const concurrentNonce = 'd'.repeat(32);
      const duplicate = validRawOwnerRequest(
        capability,
        concurrentNonce,
        new Date(transportTime).toISOString(),
      );
      const concurrent = await Promise.all([
        exchangeAuthenticatedOwnerFrame(duplicate),
        exchangeAuthenticatedOwnerFrame(duplicate),
      ]);
      expect(concurrent.filter((value) => value !== null)).toHaveLength(1);

      transportTime += 5_001;
      expect(await exchangeAuthenticatedOwnerFrame(validRawOwnerRequest(
        capability,
        replayNonce,
        new Date(transportTime).toISOString(),
      ))).not.toBeNull();

      transportTime = Date.parse(TRANSPORT_AT) + STATUS_OWNER_CAPABILITY_ROTATE_AFTER_MS;
      owner.refresh();
      const rotated = capabilities.active();
      expect(rotated.capabilityId).not.toBe(capability.capabilityId);
      capability = rotated;
      expect(await exchangeAuthenticatedOwnerFrame(validRawOwnerRequest(
        capability,
        replayNonce,
        new Date(transportTime).toISOString(),
      ))).not.toBeNull();
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('prunes a near-expiry signed nonce before the replay-capacity check at exact expiry', async () => {
    const store = healthyStore();
    let transportTime = Date.parse(TRANSPORT_AT);
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath,
      capabilityStore: capabilities,
      refreshMilliseconds: null,
      acceptedNonceLimit: 2,
      clock: () => new Date(transportTime),
    });
    try {
      await owner.start();
      const capability = capabilities.active();
      expect(await exchangeAuthenticatedOwnerFrame(validRawOwnerRequest(
        capability,
        '1'.repeat(32),
        new Date(transportTime - 4_999).toISOString(),
      ))).not.toBeNull();
      expect(await exchangeAuthenticatedOwnerFrame(validRawOwnerRequest(
        capability,
        '2'.repeat(32),
        new Date(transportTime).toISOString(),
      ))).not.toBeNull();
      expect(await exchangeAuthenticatedOwnerFrame(validRawOwnerRequest(
        capability,
        '3'.repeat(32),
        new Date(transportTime).toISOString(),
      ))).toBeNull();

      transportTime += 1;
      expect(await exchangeAuthenticatedOwnerFrame(validRawOwnerRequest(
        capability,
        '3'.repeat(32),
        new Date(transportTime).toISOString(),
      ))).not.toBeNull();
    } finally {
      await owner.stop();
      store.close();
    }
  });

  it('rejects unbounded Windows roots and derives PowerShell only through GLOBALROOT realpath', () => {
    const accepted = String.raw`D:\Users\operator\AppData\Local`;
    expect(operationalStatusWindowsLocalPathIsCanonical(accepted)).toBe(true);
    for (const rejected of [
      String.raw`\\server\share`,
      String.raw`\\?\D:\Users\operator\AppData\Local`,
      String.raw`\\.\D:\Users\operator\AppData\Local`,
      String.raw`\??\D:\Users\operator\AppData\Local`,
      String.raw`D:relative`,
      String.raw`D:\Users\operator\..\escape`,
      String.raw`D:\Users\operator\stream:secret`,
      String.raw`D:\Users\operator\NUL`,
      `D:\\Users\\operator\\bad${String.fromCharCode(1)}`,
      `D:\\${'a'.repeat(241)}`,
    ]) expect(operationalStatusWindowsLocalPathIsCanonical(rejected)).toBe(false);

    const capability = operationalStatusCapabilityPath(
      String.raw`D:\state\bridge.db`,
      {
        LOCALAPPDATA: String.raw`\\poisoned\local`,
        APPDATA: String.raw`\\poisoned\roaming`,
      },
      'win32',
      () => accepted,
    );
    expect(capability.startsWith(`${accepted}\\orca-slack-bridge-status-v2\\owner-`)).toBe(true);
    for (const root of [
      String.raw`\\server\share`,
      String.raw`\\?\D:\local`,
      String.raw`D:relative`,
      String.raw`D:\local\..\escape`,
      String.raw`D:\local\stream:secret`,
    ]) {
      expect(() => operationalStatusCapabilityPath(
        String.raw`D:\state\bridge.db`,
        { LOCALAPPDATA: root },
        'win32',
        () => root,
      )).toThrow('status.capability_path_unavailable');
    }
    expect(operationalStatusCapabilityPath(
      String.raw`D:\state\bridge.db`,
      {
        LOCALAPPDATA: String.raw`\\poisoned\local`,
        APPDATA: String.raw`\\poisoned\roaming`,
      },
      'win32',
      () => accepted,
    )).toBe(capability);
    const boundedStore = new CurrentUserOperationalStatusCapabilityStore(
      'win32',
      {
        LOCALAPPDATA: String.raw`C:\poisoned-local-authority`,
        APPDATA: String.raw`\\poisoned\roaming-authority`,
      },
      { windowsKnownLocalAppData: () => accepted },
    );
    expect(boundedStore.read(String.raw`C:\poisoned-local-authority\owner.json`))
      .toEqual({ kind: 'invalid' });

    const calls: string[] = [];
    expect(operationalStatusWindowsTrustedPowerShell((path) => {
      calls.push(path);
      return calls.length === 1
        ? String.raw`D:\Windows\System32`
        : String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
    })).toEqual({
      root: String.raw`D:\Windows`,
      systemDirectory: String.raw`D:\Windows\System32`,
      executable: String.raw`D:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    });
    expect(calls[0]).toBe(String.raw`\\?\GLOBALROOT\SystemRoot\System32`);
    expect(() => operationalStatusWindowsTrustedPowerShell(() => String.raw`\\server\System32`))
      .toThrow('status.capability_permission_failed');
    expect(operationalStatusWindowsKnownFolderEnvironment(String.raw`D:\Windows`)).toEqual({
      SystemRoot: String.raw`D:\Windows`,
      WINDIR: String.raw`D:\Windows`,
    });
  });

  it('accepts only the exact protected current-user Windows directory and file DACL shapes', () => {
    const rule = {
      currentUser: true,
      allow: true,
      rights: 0x1f01ff,
      inherited: false,
      inheritance: 0,
      propagation: 0,
    };
    const file = { ownerCurrentUser: true, protected: true, rules: [rule] };
    const directory = {
      ownerCurrentUser: true,
      protected: true,
      rules: [{ ...rule, inheritance: 3 }],
    };
    expect(operationalStatusWindowsAclIsExact(file, 'file')).toBe(true);
    expect(operationalStatusWindowsAclIsExact(directory, 'directory')).toBe(true);

    const invalid = [
      { ...file, ownerCurrentUser: false },
      { ...file, protected: false },
      { ...file, rules: [] },
      { ...file, rules: [rule, { ...rule }] },
      { ...file, rules: [{ ...rule, currentUser: false }] },
      { ...file, rules: [{ ...rule, allow: false }] },
      { ...file, rules: [{ ...rule, rights: 0x20089 }] },
      { ...file, rules: [{ ...rule, inherited: true }] },
      { ...file, rules: [{ ...rule, inheritance: 3 }] },
      { ...file, rules: [{ ...rule, propagation: 2 }] },
      { ...file, unexpected: true },
    ];
    for (const value of invalid) expect(operationalStatusWindowsAclIsExact(value, 'file')).toBe(false);
    expect(operationalStatusWindowsAclIsExact(
      { ...directory, rules: [{ ...directory.rules[0]!, inheritance: 1 }] },
      'directory',
    )).toBe(false);
  });

  it('derives a bounded pathname UDS inside the private POSIX capability directory', () => {
    const runtime = '/run/user/1234';
    const capability = operationalStatusCapabilityPath(
      '/srv/orca/state.db',
      { XDG_RUNTIME_DIR: runtime },
      'linux',
    );
    const socket = operationalStatusOwnerPipePath(
      '/srv/orca/state.db',
      { XDG_RUNTIME_DIR: runtime },
      'linux',
    );
    expect(socket[0]).not.toBe('\0');
    expect(socket.startsWith(`${runtime}/`)).toBe(true);
    expect(posix.dirname(socket)).not.toBe(posix.dirname(capability));
    expect(Buffer.byteLength(socket, 'utf8')).toBeLessThanOrEqual(103);
    const contentionSizedRuntime = `/${'r'.repeat(39)}`;
    expect(Buffer.byteLength(operationalStatusOwnerPipePath(
      '/srv/orca/state.db',
      { XDG_RUNTIME_DIR: contentionSizedRuntime },
      'linux',
    ), 'utf8')).toBeLessThanOrEqual(103);
    expect(operationalStatusPosixProtectionIsExact(
      { uid: 1000n, mode: 0o140600n, type: 'socket' },
      1000n,
      'socket',
    )).toBe(true);
    for (const rejected of [
      { uid: 1001n, mode: 0o140600n, type: 'socket' as const },
      { uid: 1000n, mode: 0o140660n, type: 'socket' as const },
      { uid: 1000n, mode: 0o100600n, type: 'file' as const },
    ]) {
      expect(operationalStatusPosixProtectionIsExact(rejected, 1000n, 'socket')).toBe(false);
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'publishes and revalidates a real current-user 0700/0600 pathname UDS identity',
    async () => {
      const env = { ...process.env, XDG_RUNTIME_DIR: dir };
      const nativeCapabilityPath = operationalStatusCapabilityPath(statePath, env, 'linux');
      const native = new CurrentUserOperationalStatusCapabilityStore('linux', env);
      const store = healthyStore();
      const owner = new OperationalStatusOwnerServer({
        statePath,
        store,
        capabilityPath: nativeCapabilityPath,
        capabilityStore: native,
        env,
        platform: 'linux',
        refreshMilliseconds: null,
        clock: () => new Date(TRANSPORT_AT),
      });
      try {
        await owner.start();
        const observed = native.read(nativeCapabilityPath);
        if (observed.kind !== 'ready' || observed.value.status !== 'active' ||
            observed.value.transport.kind !== 'pipe') throw new Error('expected native UDS');
        const transport = observed.value.transport;
        const parent = statSync(posix.dirname(transport.path));
        const socket = lstatSync(transport.path, { bigint: true });
        const uid = process.getuid?.();
        if (uid === undefined) throw new Error('expected POSIX uid');
        expect(parent.mode & 0o777).toBe(0o700);
        expect(parent.uid).toBe(uid);
        expect(socket.isSocket()).toBe(true);
        expect(socket.mode & 0o777n).toBe(0o600n);
        expect(socket.uid).toBe(BigInt(uid));
        expect({ device: String(socket.dev), inode: String(socket.ino) }).toEqual({
          device: transport.device,
          inode: transport.inode,
        });
        expect(native.verifyOwnerTransport(transport)).toBe(true);
        await owner.stop();
        const runtimeDirectory = posix.dirname(nativeCapabilityPath);
        const socketDirectory = posix.dirname(transport.path);
        const baselineEntries = readdirSync(runtimeDirectory).sort();
        const baselineSocketEntries = readdirSync(socketDirectory).sort();
        for (let restart = 0; restart < 3; restart += 1) {
          const rebound = new OperationalStatusOwnerServer({
            statePath,
            store,
            capabilityPath: nativeCapabilityPath,
            capabilityStore: native,
            env,
            platform: 'linux',
            refreshMilliseconds: null,
            clock: () => new Date(TRANSPORT_AT),
          });
          await rebound.start();
          await rebound.stop();
          expect(readdirSync(runtimeDirectory).sort()).toEqual(baselineEntries);
          expect(readdirSync(socketDirectory).sort()).toEqual(baselineSocketEntries);
        }
      } finally {
        await owner.stop();
        store.close();
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'rebinds after SIGKILL leaves the implementation pre-activation 0755 UDS',
    async () => {
      const env = { ...process.env, XDG_RUNTIME_DIR: dir };
      const nativeCapabilityPath = operationalStatusCapabilityPath(statePath, env, 'linux');
      const socketPath = operationalStatusOwnerPipePath(statePath, env, 'linux');
      const native = new CurrentUserOperationalStatusCapabilityStore('linux', env);
      const identity = operationalStatusStateIdentity(statePath, 'linux');
      const preparationClaim = await native.acquireOwnerClaim(nativeCapabilityPath, identity);
      try {
        native.prepareOwnerTransport(socketPath, identity, preparationClaim);
      } finally {
        await preparationClaim.release();
      }

      const child = spawn(process.execPath, [
        '--input-type=module',
        '--eval',
        [
          "import { createServer } from 'node:net';",
          'process.umask(0o022);',
          'const server = createServer();',
          "server.listen(process.argv[1], () => process.stdout.write('bound\\n'));",
        ].join('\n'),
        socketPath,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise<void>((resolveBound, rejectBound) => {
        let output = '';
        const timer = setTimeout(() => rejectBound(new Error('child bind timeout')), 5_000);
        child.once('error', rejectBound);
        child.once('exit', () => rejectBound(new Error('child exited before bind')));
        child.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (!output.includes('\n')) return;
          clearTimeout(timer);
          resolveBound();
        });
      });
      expect(child.kill('SIGKILL')).toBe(true);
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));

      const crashedSocket = lstatSync(socketPath, { bigint: true });
      expect(crashedSocket.isSocket()).toBe(true);
      expect(crashedSocket.mode & 0o777n).toBe(0o755n);
      expect(statSync(posix.dirname(socketPath)).mode & 0o777).toBe(0o700);

      const store = healthyStore();
      const owner = new OperationalStatusOwnerServer({
        statePath,
        store,
        capabilityPath: nativeCapabilityPath,
        capabilityStore: native,
        env,
        platform: 'linux',
        refreshMilliseconds: null,
        clock: () => new Date(TRANSPORT_AT),
      });
      try {
        await owner.start();
        const active = native.read(nativeCapabilityPath);
        if (active.kind !== 'ready' || active.value.status !== 'active' ||
            active.value.transport.kind !== 'pipe') throw new Error('expected active UDS');
        const reboundSocket = lstatSync(active.value.transport.path, { bigint: true });
        expect(reboundSocket.mode & 0o777n).toBe(0o600n);
        expect(String(reboundSocket.dev)).toBe(active.value.transport.device);
        expect(String(reboundSocket.ino)).toBe(active.value.transport.inode);
        const residuePrefix = `.owner-socket-residue-${identity.slice(0, 16)}-`;
        const residues = readdirSync(posix.dirname(socketPath))
          .filter((entry) => entry.startsWith(residuePrefix));
        expect(residues).toHaveLength(1);
        expect(residues.length).toBeLessThanOrEqual(8);
      } finally {
        await owner.stop();
        store.close();
      }
    },
    20_000,
  );

  it('holds the native per-state claim exclusively and releases it for a clean rebind', async () => {
    const nativePath = join(dir, 'native-claim', 'owner.json');
    const identity = operationalStatusStateIdentity(statePath);
    const firstStore = new CurrentUserOperationalStatusCapabilityStore(process.platform, process.env);
    const secondStore = new CurrentUserOperationalStatusCapabilityStore(process.platform, process.env);
    const first = await firstStore.acquireOwnerClaim(nativePath, identity);
    try {
      await expect(secondStore.acquireOwnerClaim(nativePath, identity))
        .rejects.toThrow('status.owner_claim_failed');
      first.assertHeld();
    } finally {
      await first.release();
    }
    const rebound = await secondStore.acquireOwnerClaim(nativePath, identity);
    rebound.assertHeld();
    await rebound.release();
  }, 10_000);

  it('bounds native snapshot-lease contention and releases it for an immediate rebind', async () => {
    const nativePath = join(dir, 'native-snapshot-lease', 'owner.json');
    const identity = operationalStatusStateIdentity(statePath);
    const firstStore = new CurrentUserOperationalStatusCapabilityStore(process.platform, process.env);
    const secondStore = new CurrentUserOperationalStatusCapabilityStore(process.platform, process.env);
    const first = await firstStore.tryAcquireSnapshotLease(nativePath, identity);
    expect(first).not.toBeNull();
    if (first === null) throw new Error('expected snapshot lease');
    try {
      const startedAt = process.hrtime.bigint();
      expect(await secondStore.tryAcquireSnapshotLease(nativePath, identity)).toBeNull();
      const elapsedMilliseconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      expect(elapsedMilliseconds).toBeLessThan(3_000);
      first.assertHeld();
    } finally {
      await first.release();
    }
    const rebound = await secondStore.tryAcquireSnapshotLease(nativePath, identity);
    expect(rebound).not.toBeNull();
    rebound!.assertHeld();
    await rebound!.release();
  }, 15_000);

  it.skipIf(process.platform !== 'linux')(
    'automatically releases the native snapshot lease after SIGKILL',
    async () => {
      const nativePath = join(dir, 'snapshot-lease-crash', 'owner.json');
      const identity = operationalStatusStateIdentity(statePath, 'linux');
      const moduleUrl = new URL(
        '../src/operational/status-capability.ts',
        import.meta.url,
      ).href;
      const child = spawn(process.execPath, [
        '--no-warnings',
        '--input-type=module',
        '--eval',
        [
          'const module = await import(process.argv[1]);',
          "const store = new module.CurrentUserOperationalStatusCapabilityStore('linux', process.env);",
          'const lease = await store.tryAcquireSnapshotLease(process.argv[2], process.argv[3]);',
          "if (lease === null) process.exit(19);",
          'lease.assertHeld();',
          "process.stdout.write('ready\\n');",
          'setInterval(() => lease.assertHeld(), 100);',
        ].join('\n'),
        moduleUrl,
        nativePath,
        identity,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      await new Promise<void>((resolveReady, rejectReady) => {
        let output = '';
        const timer = setTimeout(() => rejectReady(new Error('lease child timeout')), 8_000);
        child.once('error', rejectReady);
        child.once('exit', (code) => rejectReady(new Error(`lease child exited ${code}`)));
        child.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (!output.includes('\n')) return;
          clearTimeout(timer);
          resolveReady();
        });
      });
      const contender = new CurrentUserOperationalStatusCapabilityStore('linux', process.env);
      expect(await contender.tryAcquireSnapshotLease(nativePath, identity)).toBeNull();
      expect(child.kill('SIGKILL')).toBe(true);
      await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));

      const rebound = await contender.tryAcquireSnapshotLease(nativePath, identity);
      expect(rebound).not.toBeNull();
      rebound!.assertHeld();
      await rebound!.release();
      const leasePath = `${nativePath}.snapshot-lease`;
      expect(readFileSync(leasePath)).toHaveLength(0);
      expect(statSync(leasePath).mode & 0o777).toBe(0o600);
      expect(readdirSync(dirname(nativePath)).sort()).toEqual(['owner.json.snapshot-lease']);
    },
    20_000,
  );

  it('restarts immediately over a verified same-state fresh capability left after owner death', async () => {
    const nativeEnv = process.platform === 'win32'
      ? {
        ...process.env,
        LOCALAPPDATA: String.raw`C:\poisoned-local-authority`,
        APPDATA: String.raw`\\poisoned\roaming-authority`,
      }
      : { ...process.env, XDG_RUNTIME_DIR: dir };
    const nativePath = process.platform === 'win32'
      ? join(dir, 'fresh-crash-capability', 'owner.json')
      : operationalStatusCapabilityPath(statePath, nativeEnv, process.platform);
    const native = new CurrentUserOperationalStatusCapabilityStore(
      process.platform,
      nativeEnv,
      process.platform === 'win32' ? { windowsKnownLocalAppData: () => dir } : {},
    );
    const identity = operationalStatusStateIdentity(statePath);
    const deadTransport = process.platform === 'win32'
      ? { kind: 'tcp' as const, host: '127.0.0.1' as const, port: 42_109 }
      : {
        kind: 'pipe' as const,
        path: posix.join(posix.dirname(nativePath), 'dead-owner.sock'),
        device: '1',
        inode: '2',
      };
    const dead = activeOperationalStatusCapability(identity, deadTransport, TRANSPORT_AT);
    const deadClaim = await native.acquireOwnerClaim(nativePath, identity);
    native.publish(nativePath, dead, null, deadClaim);
    await deadClaim.release();

    const store = healthyStore();
    const owner = new OperationalStatusOwnerServer({
      statePath,
      store,
      capabilityPath: nativePath,
      capabilityStore: native,
      env: nativeEnv,
      platform: process.platform,
      refreshMilliseconds: null,
      clock: () => new Date(TRANSPORT_AT),
    });
    try {
      await owner.start();
      const current = native.read(nativePath);
      expect(current.kind).toBe('ready');
      if (current.kind === 'ready') {
        expect(current.value.status).toBe('active');
        expect(current.value.capabilityId).not.toBe(dead.capabilityId);
      }
    } finally {
      await owner.stop();
      store.close();
    }
  }, 25_000);

  it('uses a token-free PowerShell environment and a crash-safe fixed protected capability', async () => {
    const sanitized = operationalStatusWindowsPowerShellEnvironment(
      String.raw`C:\Windows`,
      String.raw`C:\private\owner.json`,
      'artifact',
    );
    expect(Object.keys(sanitized).sort()).toEqual([
      'ORCA_STATUS_CAPABILITY_KIND', 'ORCA_STATUS_CAPABILITY_PATH', 'SystemRoot', 'WINDIR',
    ]);
    expect(JSON.stringify(sanitized)).not.toContain('TOKEN_SENTINEL');
    const claimEnvironment = operationalStatusWindowsOwnerClaimEnvironment(
      String.raw`C:\Windows`,
      operationalStatusWindowsOwnerClaimName('a'.repeat(64)),
    );
    expect(Object.keys(claimEnvironment).sort()).toEqual([
      'ORCA_STATUS_OWNER_CLAIM_NAME', 'SystemRoot', 'WINDIR',
    ]);
    expect(claimEnvironment['ORCA_STATUS_OWNER_CLAIM_NAME'])
      .toBe('Global\\orca-slack-bridge-status-v2-' + 'a'.repeat(64));
    expect(JSON.stringify(claimEnvironment)).not.toContain('TOKEN_SENTINEL');
    const leaseEnvironment = operationalStatusWindowsSnapshotLeaseEnvironment(
      String.raw`C:\Windows`,
      operationalStatusWindowsSnapshotLeaseName('b'.repeat(64)),
    );
    expect(Object.keys(leaseEnvironment).sort()).toEqual([
      'ORCA_STATUS_SNAPSHOT_LEASE_NAME', 'SystemRoot', 'WINDIR',
    ]);
    expect(leaseEnvironment['ORCA_STATUS_SNAPSHOT_LEASE_NAME'])
      .toBe('Global\\orca-slack-bridge-status-v2-snapshot-' + 'b'.repeat(64));
    expect(JSON.stringify(leaseEnvironment)).not.toContain('TOKEN_SENTINEL');

    const nativePath = join(dir, 'protected-capability', 'owner.json');
    let failInstall = false;
    const native = new CurrentUserOperationalStatusCapabilityStore(
      process.platform,
      { ...process.env, TOKEN_SENTINEL: 'must-not-reach-powershell' },
      { beforeInstall: () => { if (failInstall) throw new Error('synthetic destination lock'); } },
    );
    const endpoint = process.platform === 'win32'
      ? { kind: 'tcp' as const, host: '127.0.0.1' as const, port: 42_100 }
      : { kind: 'pipe' as const, path: '/tmp/owner-test.sock', device: '1', inode: '2' };
    const old = activeOperationalStatusCapability(
      operationalStatusStateIdentity(statePath), endpoint, AT0,
    );
    const replacement = activeOperationalStatusCapability(
      old.stateIdentity, endpoint, AT1,
    );
    const claim = await native.acquireOwnerClaim(nativePath, old.stateIdentity);
    try {
      native.publish(nativePath, old, null, claim);
      failInstall = true;
      expect(() => native.publish(nativePath, replacement, old, claim))
        .toThrow('status.capability_publish_failed');
      failInstall = false;
      expect(native.read(nativePath)).toEqual({ kind: 'ready', value: old });
      expect(readFileSync(nativePath, 'utf8')).not.toContain(replacement.secret);
      expect(readdirSync(join(dir, 'protected-capability')).every((name) => !name.endsWith('.tmp')))
        .toBe(true);
      native.publish(nativePath, replacement, old, claim);
      expect(native.read(nativePath)).toEqual({ kind: 'ready', value: replacement });
      expect(readFileSync(nativePath, 'utf8')).not.toContain(old.secret);
      expect(readdirSync(join(dir, 'protected-capability')).every((name) => !name.endsWith('.tmp')))
        .toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(join(dir, 'protected-capability')).mode & 0o777).toBe(0o700);
        expect(statSync(nativePath).mode & 0o777).toBe(0o600);
        chmodSync(nativePath, 0o644);
        expect(native.read(nativePath)).toEqual({ kind: 'invalid' });
        chmodSync(nativePath, 0o600);
      }
      const retired = retiredOperationalStatusCapability(replacement, AT2);
      native.publish(nativePath, retired, replacement, claim);
      native.remove(nativePath, retired, claim);
      expect(native.read(nativePath)).toEqual({ kind: 'absent' });
    } finally {
      await claim.release();
    }
  }, 15_000);

  it.skipIf(process.platform !== 'win32')(
    'rechecks ACL-only Everyone/read and inheritance drift even when all basic metadata is restored',
    async () => {
      const native = new CurrentUserOperationalStatusCapabilityStore('win32', process.env);
      const endpoint = { kind: 'tcp' as const, host: '127.0.0.1' as const, port: 42_101 };
      for (const mode of ['everyone-read', 'inheritance-enabled'] as const) {
        const nativePath = join(dir, `acl-${mode}`, 'owner.json');
        const identity = operationalStatusStateIdentity(join(dir, `${mode}.db`), 'win32');
        const document = activeOperationalStatusCapability(identity, endpoint, AT0);
        const claim = await native.acquireOwnerClaim(nativePath, identity);
        try {
          native.publish(nativePath, document, null, claim);
          expect(native.read(nativePath)).toEqual({ kind: 'ready', value: document });
          const before = basicFileWitness(nativePath);
          mutateWindowsAclWithoutChangingBasicInfo(nativePath, mode);
          expect(basicFileWitness(nativePath)).toEqual(before);
          expect(native.read(nativePath)).toEqual({ kind: 'invalid' });
        } finally {
          await claim.release();
        }
      }
    },
    20_000,
  );

  it('updates through a pinned inode and preserves an identical-content raced replacement identity', async () => {
    const endpoint = process.platform === 'win32'
      ? { kind: 'tcp' as const, host: '127.0.0.1' as const, port: 42_102 }
      : { kind: 'pipe' as const, path: '/tmp/owner-race-test.sock', device: '1', inode: '2' };

    const publishIdentity = operationalStatusStateIdentity(join(dir, 'publish-race.db'));
    const old = activeOperationalStatusCapability(publishIdentity, endpoint, AT0);
    const replacement = activeOperationalStatusCapability(publishIdentity, endpoint, AT1);
    const publishCandidate = join(dir, 'publish-candidate', 'owner.json');
    const candidateStore = new CurrentUserOperationalStatusCapabilityStore(
      process.platform,
      process.env,
    );
    const candidateClaim = await candidateStore.acquireOwnerClaim(
      publishCandidate,
      publishIdentity,
    );
    try {
      candidateStore.publish(publishCandidate, replacement, null, candidateClaim);
    } finally {
      await candidateClaim.release();
    }
    const candidateIdentity = lstatSync(publishCandidate, { bigint: true });

    let publishRace = false;
    const publishPath = join(dir, 'publish-race', 'owner.json');
    const publishStore = new CurrentUserOperationalStatusCapabilityStore(
      process.platform,
      process.env,
      {
        afterInstall: (path) => {
          if (publishRace && path === publishPath) {
            rmSync(path);
            renameSync(publishCandidate, path);
          }
        },
      },
    );
    const publishClaim = await publishStore.acquireOwnerClaim(publishPath, publishIdentity);
    try {
      publishStore.publish(publishPath, old, null, publishClaim);
      publishRace = true;
      expect(() => publishStore.publish(publishPath, replacement, old, publishClaim))
        .toThrow('status.capability_publish_failed');
      expect(publishStore.read(publishPath)).toEqual({ kind: 'ready', value: replacement });
      const preservedIdentity = lstatSync(publishPath, { bigint: true });
      expect({ dev: preservedIdentity.dev, ino: preservedIdentity.ino }).toEqual({
        dev: candidateIdentity.dev,
        ino: candidateIdentity.ino,
      });
    } finally {
      await publishClaim.release();
    }

    let removeRace = false;
    const removePath = join(dir, 'remove-race', 'owner.json');
    const removeCandidatePath = join(dir, 'remove-candidate', 'owner.json');
    const removeIdentity = operationalStatusStateIdentity(join(dir, 'remove-race.db'));
    const active = activeOperationalStatusCapability(removeIdentity, endpoint, AT0);
    const retired = retiredOperationalStatusCapability(active, AT1);
    const removeCandidateStore = new CurrentUserOperationalStatusCapabilityStore(
      process.platform,
      process.env,
    );
    const removeCandidateClaim = await removeCandidateStore.acquireOwnerClaim(
      removeCandidatePath,
      removeIdentity,
    );
    removeCandidateStore.publish(removeCandidatePath, active, null, removeCandidateClaim);
    removeCandidateStore.publish(removeCandidatePath, retired, active, removeCandidateClaim);
    await removeCandidateClaim.release();
    const removeCandidateIdentity = lstatSync(removeCandidatePath, { bigint: true });
    const removeStore = new CurrentUserOperationalStatusCapabilityStore(
      process.platform,
      process.env,
      {
        afterInstall: (path) => {
          if (removeRace && path === removePath) {
            renameSync(path, `${path}.detached`);
            renameSync(removeCandidatePath, path);
          }
        },
      },
    );
    const removeClaim = await removeStore.acquireOwnerClaim(removePath, removeIdentity);
    try {
      removeStore.publish(removePath, active, null, removeClaim);
      removeStore.publish(removePath, retired, active, removeClaim);
      removeRace = true;
      expect(() => removeStore.remove(removePath, retired, removeClaim))
        .toThrow('status.capability_remove_failed');
      expect(removeStore.read(removePath)).toEqual({ kind: 'ready', value: retired });
      const preserved = lstatSync(removePath, { bigint: true });
      expect({ dev: preserved.dev, ino: preserved.ino }).toEqual({
        dev: removeCandidateIdentity.dev,
        ino: removeCandidateIdentity.ino,
      });
    } finally {
      await removeClaim.release();
    }
  }, 25_000);

  it('keeps one fixed bounded capability container through repeated rotation and retirement', async () => {
    const endpoint = process.platform === 'win32'
      ? { kind: 'tcp' as const, host: '127.0.0.1' as const, port: 42_110 }
      : {
        kind: 'pipe' as const,
        path: '/tmp/owner-inner-race.sock',
        device: '1',
        inode: '2',
      };
    const identity = operationalStatusStateIdentity(join(dir, 'bounded-rotation.db'));
    const targetPath = join(dir, 'bounded-rotation', 'owner.json');
    const targetStore = new CurrentUserOperationalStatusCapabilityStore(process.platform, process.env);
    let target = activeOperationalStatusCapability(identity, endpoint, AT0);
    const targetClaim = await targetStore.acquireOwnerClaim(targetPath, identity);
    try {
      targetStore.publish(targetPath, target, null, targetClaim);
      const parent = dirname(targetPath);
      const baselineEntries = readdirSync(parent).sort();
      const baselineIdentity = lstatSync(targetPath, { bigint: true });
      const retiredSecrets: string[] = [];
      for (let index = 1; index <= 4; index += 1) {
        const previous = target;
        retiredSecrets.push(previous.secret);
        target = activeOperationalStatusCapability(
          identity,
          endpoint,
          new Date(Date.parse(AT0) + index * 1_000).toISOString(),
        );
        targetStore.publish(targetPath, target, previous, targetClaim);
        expect(readdirSync(parent).sort()).toEqual(baselineEntries);
        const currentIdentity = lstatSync(targetPath, { bigint: true });
        expect({ dev: currentIdentity.dev, ino: currentIdentity.ino }).toEqual({
          dev: baselineIdentity.dev,
          ino: baselineIdentity.ino,
        });
        const bytes = readFileSync(targetPath, 'utf8');
        for (const oldSecret of retiredSecrets) expect(bytes).not.toContain(oldSecret);
      }
      const retired = retiredOperationalStatusCapability(target, AT2);
      targetStore.publish(targetPath, retired, target, targetClaim);
      targetStore.remove(targetPath, retired, targetClaim);
      expect(targetStore.read(targetPath)).toEqual({ kind: 'absent' });
      expect(readdirSync(parent).sort()).toEqual(baselineEntries);
      expect(readFileSync(targetPath, 'utf8')).not.toContain(target.secret);
    } finally {
      await targetClaim.release();
    }
  }, 30_000);

  it.skipIf(process.platform !== 'linux')(
    'keeps fixed claim entries bounded across publication faults and absent-claim contenders',
    async () => {
      const faultHooks: readonly (keyof Pick<OperationalStatusCapabilityStoreHooks,
        'afterPosixClaimBootstrapCreate' | 'afterPosixClaimBootstrapWrite' |
        'afterPosixClaimBootstrapFsync' | 'afterPosixClaimLink'>)[] = [
        'afterPosixClaimBootstrapCreate',
        'afterPosixClaimBootstrapWrite',
        'afterPosixClaimBootstrapFsync',
        'afterPosixClaimLink',
      ];
      for (const hook of faultHooks) {
        const nativePath = join(dir, `claim-fault-${hook}`, 'owner.json');
        const parent = dirname(nativePath);
        mkdirSync(parent, { mode: 0o700 });
        chmodSync(parent, 0o700);
        const identity = operationalStatusStateIdentity(`${statePath}-${hook}`, 'linux');
        let armed = true;
        const faulting = new CurrentUserOperationalStatusCapabilityStore(
          'linux',
          process.env,
          {
            [hook]: () => {
              if (!armed) return;
              armed = false;
              throw new Error(`synthetic ${hook}`);
            },
          },
        );
        await expect(faulting.acquireOwnerClaim(nativePath, identity))
          .rejects.toThrow('status.owner_claim_failed');
        const entriesBeforeBaseline = readdirSync(parent).sort();
        expect(entriesBeforeBaseline.length).toBeLessThanOrEqual(2);
        expect(entriesBeforeBaseline.some((entry) =>
          entry.startsWith('.owner-claim-bootstrap-'))).toBe(false);

        const recovered = new CurrentUserOperationalStatusCapabilityStore('linux', process.env);
        const claim = await recovered.acquireOwnerClaim(nativePath, identity);
        claim.assertHeld();
        await claim.release();
        const baseline = readdirSync(parent).sort();
        expect(baseline.length).toBe(2);
        for (let restart = 0; restart < 3; restart += 1) {
          const rebound = await recovered.acquireOwnerClaim(nativePath, identity);
          rebound.assertHeld();
          await rebound.release();
          expect(readdirSync(parent).sort()).toEqual(baseline);
        }
      }

      const nativePath = join(dir, 'claim-contenders', 'owner.json');
      const parent = dirname(nativePath);
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o700);
      const identity = operationalStatusStateIdentity(`${statePath}-contenders`, 'linux');
      const contenders = Array.from({ length: 7 }, () =>
        new CurrentUserOperationalStatusCapabilityStore('linux', process.env));
      const racedAcquisitions: Promise<OperationalStatusOwnerClaim>[] = [];
      let dispatched = false;
      const publisher = new CurrentUserOperationalStatusCapabilityStore(
        'linux',
        process.env,
        {
          afterPosixClaimBootstrapWrite: () => {
            if (dispatched) return;
            dispatched = true;
            // The publisher still holds the bootstrap flock and the fixed claim is absent here.
            for (const contender of contenders) {
              racedAcquisitions.push(contender.acquireOwnerClaim(nativePath, identity));
            }
          },
        },
      );
      const winner = await publisher.acquireOwnerClaim(nativePath, identity);
      const results = await Promise.allSettled(racedAcquisitions);
      expect(dispatched).toBe(true);
      expect(results).toHaveLength(7);
      expect(results.every((result) => result.status === 'rejected')).toBe(true);
      const entriesBeforeBaseline = readdirSync(parent).sort();
      expect(entriesBeforeBaseline).toEqual([
        'owner.json.claim',
        'owner.json.claim.bootstrap',
      ]);
      await winner.release();
      const rebound = await contenders[0]!.acquireOwnerClaim(nativePath, identity);
      await rebound.release();
      expect(readdirSync(parent).sort()).toEqual(entriesBeforeBaseline);
    },
    30_000,
  );

  it.skipIf(process.platform !== 'linux')(
    'reuses one locked POSIX claim inode across stale, empty, and repeated restarts',
    async () => {
      const nativePath = join(dir, 'posix-claim', 'owner.json');
      const parent = join(dir, 'posix-claim');
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o700);
      const identity = operationalStatusStateIdentity(statePath, 'linux');
      const claimPath = `${nativePath}.claim`;
      const emptyPrepared = join(parent, '.owner-claim-prepared-crash-empty');
      const partialPrepared = join(parent, '.owner-claim-prepared-crash-partial');
      writeFileSync(emptyPrepared, '', { mode: 0o600 });
      writeFileSync(partialPrepared, '{"version":1', { mode: 0o600 });
      chmodSync(emptyPrepared, 0o600);
      chmodSync(partialPrepared, 0o600);
      const stale = {
        version: 1,
        stateIdentity: identity,
        claimId: 'a'.repeat(32),
        pid: 2_147_483_647,
        processStart: '1',
      };
      writeFileSync(claimPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
      chmodSync(claimPath, 0o600);
      const native = new CurrentUserOperationalStatusCapabilityStore('linux', process.env);
      const claim = await native.acquireOwnerClaim(nativePath, identity);
      try {
        claim.assertHeld();
        expect(readFileSync(claimPath, 'utf8')).not.toContain(stale.claimId);
      } finally {
        await claim.release();
      }
      expect(existsSync(claimPath)).toBe(true);
      expect(readFileSync(claimPath)).toHaveLength(0);
      expect(readFileSync(emptyPrepared)).toHaveLength(0);
      expect(readFileSync(partialPrepared, 'utf8')).toBe('{"version":1');

      const baselineEntries = readdirSync(parent).sort();
      for (let restart = 0; restart < 4; restart += 1) {
        const rebound = await native.acquireOwnerClaim(nativePath, identity);
        rebound.assertHeld();
        await rebound.release();
        expect(readFileSync(claimPath)).toHaveLength(0);
        expect(readdirSync(parent).sort()).toEqual(baselineEntries);
      }

      writeFileSync(claimPath, '{"version":1', { mode: 0o600 });
      chmodSync(claimPath, 0o600);
      const unknownIdentity = lstatSync(claimPath, { bigint: true });
      await expect(native.acquireOwnerClaim(nativePath, identity))
        .rejects.toThrow('status.owner_claim_failed');
      expect(readFileSync(claimPath, 'utf8')).toBe('{"version":1');
      const preservedIdentity = lstatSync(claimPath, { bigint: true });
      expect({ dev: preservedIdentity.dev, ino: preservedIdentity.ino }).toEqual({
        dev: unknownIdentity.dev,
        ino: unknownIdentity.ino,
      });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'admits only same-state or released-empty legacy claim bytes and preserves raced inodes',
    async () => {
      const identity = operationalStatusStateIdentity(statePath, 'linux');
      const legacyPath = join(dir, 'legacy-posix-claim', 'owner.json');
      const legacyParent = dirname(legacyPath);
      const legacyClaimPath = `${legacyPath}.claim`;
      const legacyBootstrapPath = `${legacyClaimPath}.bootstrap`;
      mkdirSync(legacyParent, { mode: 0o700 });
      chmodSync(legacyParent, 0o700);
      writeFileSync(legacyBootstrapPath, '', { mode: 0o600 });
      chmodSync(legacyBootstrapPath, 0o600);
      const stale = {
        version: 1,
        stateIdentity: identity,
        claimId: 'b'.repeat(32),
        pid: 2_147_483_647,
        processStart: '1',
      };
      writeFileSync(legacyClaimPath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
      chmodSync(legacyClaimPath, 0o600);

      const native = new CurrentUserOperationalStatusCapabilityStore('linux', process.env);
      const staleClaim = await native.acquireOwnerClaim(legacyPath, identity);
      staleClaim.assertHeld();
      await staleClaim.release();
      expect(readFileSync(legacyClaimPath)).toHaveLength(0);
      const emptyClaim = await native.acquireOwnerClaim(legacyPath, identity);
      emptyClaim.assertHeld();
      await emptyClaim.release();

      const unknown = '{"version":1';
      writeFileSync(legacyClaimPath, unknown, { mode: 0o600 });
      chmodSync(legacyClaimPath, 0o600);
      const unknownIdentity = lstatSync(legacyClaimPath, { bigint: true });
      await expect(native.acquireOwnerClaim(legacyPath, identity))
        .rejects.toThrow('status.owner_claim_failed');
      expect(readFileSync(legacyClaimPath, 'utf8')).toBe(unknown);
      const preservedUnknown = lstatSync(legacyClaimPath, { bigint: true });
      expect({ dev: preservedUnknown.dev, ino: preservedUnknown.ino }).toEqual({
        dev: unknownIdentity.dev,
        ino: unknownIdentity.ino,
      });

      const racePath = join(dir, 'legacy-posix-claim-race', 'owner.json');
      const raceParent = dirname(racePath);
      const raceClaimPath = `${racePath}.claim`;
      const raceBootstrapPath = `${raceClaimPath}.bootstrap`;
      const detachedPath = `${raceClaimPath}.admitted`;
      const replacement = '{}\n';
      mkdirSync(raceParent, { mode: 0o700 });
      chmodSync(raceParent, 0o700);
      writeFileSync(raceBootstrapPath, '', { mode: 0o600 });
      chmodSync(raceBootstrapPath, 0o600);
      const admitted = `${JSON.stringify(stale)}\n`;
      writeFileSync(raceClaimPath, admitted, { mode: 0o600 });
      chmodSync(raceClaimPath, 0o600);
      let race = true;
      const racing = new CurrentUserOperationalStatusCapabilityStore('linux', process.env, {
        beforePosixLegacyClaimMutation: (path) => {
          if (!race) return;
          race = false;
          renameSync(path, detachedPath);
          writeFileSync(path, replacement, { mode: 0o600 });
          chmodSync(path, 0o600);
        },
      });
      await expect(racing.acquireOwnerClaim(racePath, identity))
        .rejects.toThrow('status.owner_claim_failed');
      expect(readFileSync(detachedPath, 'utf8')).toBe(admitted);
      expect(readFileSync(raceClaimPath, 'utf8')).toBe(replacement);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'closes a lost POSIX claim descriptor without deleting either raced pathname',
    async () => {
      const nativePath = join(dir, 'lost-posix-claim', 'owner.json');
      const identity = operationalStatusStateIdentity(statePath, 'linux');
      const claimPath = `${nativePath}.claim`;
      const bootstrapPath = `${claimPath}.bootstrap`;
      const detachedPath = `${claimPath}.detached`;
      const native = new CurrentUserOperationalStatusCapabilityStore('linux', process.env);
      const claim = await native.acquireOwnerClaim(nativePath, identity);
      renameSync(claimPath, detachedPath);
      writeFileSync(claimPath, '{}\n', { mode: 0o600 });
      chmodSync(claimPath, 0o600);
      const detachedIdentity = lstatSync(detachedPath, { bigint: true });
      const hasDetachedDescriptor = (): boolean => readdirSync('/proc/self/fd').some((entry) => {
        try {
          const observed = statSync(`/proc/self/fd/${entry}`, { bigint: true });
          return observed.dev === detachedIdentity.dev && observed.ino === detachedIdentity.ino;
        } catch { return false; }
      });

      expect(hasDetachedDescriptor()).toBe(true);
      await expect(claim.release()).rejects.toThrow('status.owner_claim_release_failed');
      expect(hasDetachedDescriptor()).toBe(false);
      expect(readFileSync(claimPath, 'utf8')).toBe('{}\n');
      expect(existsSync(detachedPath)).toBe(true);
      const bootstrapIdentity = lstatSync(bootstrapPath, { bigint: true });
      expect({ dev: bootstrapIdentity.dev, ino: bootstrapIdentity.ino }).toEqual({
        dev: detachedIdentity.dev,
        ino: detachedIdentity.ino,
      });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'detects an identical-byte POSIX claim swap between pre/post pathname identity checks',
    async () => {
      const nativePath = join(dir, 'post-check-posix-claim', 'owner.json');
      const identity = operationalStatusStateIdentity(statePath, 'linux');
      const claimPath = `${nativePath}.claim`;
      const detachedPath = `${claimPath}.held`;
      let armed = false;
      const native = new CurrentUserOperationalStatusCapabilityStore('linux', process.env, {
        duringPosixClaimAssertion: (path) => {
          if (!armed) return;
          armed = false;
          const replacement = `${path}.replacement`;
          writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
          chmodSync(replacement, 0o600);
          renameSync(path, detachedPath);
          renameSync(replacement, path);
        },
      });
      const claim = await native.acquireOwnerClaim(nativePath, identity);
      armed = true;
      expect(() => claim.assertHeld()).toThrow('status.owner_claim_lost');
      await expect(claim.release()).rejects.toThrow('status.owner_claim_release_failed');
      expect(existsSync(claimPath)).toBe(true);
      expect(existsSync(detachedPath)).toBe(true);
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'closes the descriptor when the initial POSIX claim assertion detects a pathname swap',
    async () => {
      const nativePath = join(dir, 'initial-posix-claim-swap', 'owner.json');
      const identity = operationalStatusStateIdentity(statePath, 'linux');
      const claimPath = `${nativePath}.claim`;
      const bootstrapPath = `${claimPath}.bootstrap`;
      const detachedPath = `${claimPath}.held`;
      let armed = true;
      const native = new CurrentUserOperationalStatusCapabilityStore('linux', process.env, {
        duringPosixClaimAssertion: (path) => {
          if (!armed) return;
          armed = false;
          const replacement = `${path}.replacement`;
          writeFileSync(replacement, readFileSync(path), { mode: 0o600 });
          chmodSync(replacement, 0o600);
          renameSync(path, detachedPath);
          renameSync(replacement, path);
        },
      });
      await expect(native.acquireOwnerClaim(nativePath, identity))
        .rejects.toThrow('status.owner_claim_failed');
      const detachedIdentity = lstatSync(detachedPath, { bigint: true });
      const replacementIdentity = lstatSync(claimPath, { bigint: true });
      const hasOpenDescriptor = (identity: typeof detachedIdentity): boolean =>
        readdirSync('/proc/self/fd').some((entry) => {
          try {
            const observed = statSync(`/proc/self/fd/${entry}`, { bigint: true });
            return observed.dev === identity.dev && observed.ino === identity.ino;
          } catch { return false; }
        });
      expect(hasOpenDescriptor(detachedIdentity)).toBe(false);
      expect(hasOpenDescriptor(replacementIdentity)).toBe(false);
      expect(existsSync(claimPath)).toBe(true);
      expect(existsSync(detachedPath)).toBe(true);
      const bootstrapIdentity = lstatSync(bootstrapPath, { bigint: true });
      expect({ dev: bootstrapIdentity.dev, ino: bootstrapIdentity.ino }).toEqual({
        dev: detachedIdentity.dev,
        ino: detachedIdentity.ino,
      });
      expect({ dev: replacementIdentity.dev, ino: replacementIdentity.ino }).not.toEqual({
        dev: detachedIdentity.dev,
        ino: detachedIdentity.ino,
      });

      await expect(native.acquireOwnerClaim(nativePath, identity))
        .rejects.toThrow('status.owner_claim_failed');
      expect(hasOpenDescriptor(detachedIdentity)).toBe(false);
      expect(hasOpenDescriptor(replacementIdentity)).toBe(false);
      expect(existsSync(bootstrapPath)).toBe(true);
      expect(existsSync(claimPath)).toBe(true);
      expect(existsSync(detachedPath)).toBe(true);
    },
  );

  it('uses the injected clock for fresh/stale and clock-drift classifications', async () => {
    const snapshot = snapshotAndClose(healthyStore());
    expect((await inspect({ snapshot, clock: () => new Date('2026-08-26T00:01:30.000Z') })).exitCode).toBe(0);
    const stale = await inspect({ snapshot, clock: () => new Date('2026-08-26T00:01:31.000Z') });
    expect(stale.exitCode).toBe(1);
    expect(stale.codes).toContain('daemon.stale');
    const future = await inspect({ snapshot, clock: () => new Date('2026-08-25T23:59:00.000Z') });
    expect(future.exitCode).toBe(1);
    expect(future.codes).toContain('daemon.clock_drift');
    const broken = await inspect({ snapshot, clock: () => { throw new Error('SENTINEL_CLOCK_DETAIL'); } });
    expect(broken).toMatchObject({ exitCode: 1, codes: expect.arrayContaining(['daemon.clock_drift']) });
    expect(JSON.stringify(broken)).not.toContain('SENTINEL');
  });

  it('maps stopped/config/schema absence to exit 2 and build/job degradation to exit 1', async () => {
    let store = healthyStore();
    store.recordDaemonCleanStop(INSTANCE, AT2);
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['daemon.stopped']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore();
    store.setDaemonDesiredState('stopped', AT2);
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['daemon.stopped']),
    });

    rmSync(statePath, { force: true });
    expect(await inspect({ snapshot: snapshotAndClose(new SqliteDigestStore(statePath)) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['daemon.absent']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ configFingerprint: 'different-config' });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['config.drift']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ buildFingerprint: 'different-build' });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['build.drift']),
    });

    rmSync(statePath, { force: true });
    expect(await inspect({
      snapshot: snapshotAndClose(healthyStore(), config, null), expectedBuildIdentity: null, env: {},
    })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['build.unverified']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ failure: 'repository-discovery' });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['job.failed']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ failure: 'repository-discovery', backoff: true });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['job.backoff']),
    });

    rmSync(statePath, { force: true });
    store = healthyStore({ jobs: false });
    expect(await inspect({ snapshot: snapshotAndClose(store) })).toMatchObject({
      exitCode: 1, codes: expect.arrayContaining(['job.absent']),
    });
  });

  it('ignores disabled observer rows while Gate and Channel jobs remain required', async () => {
    const requiredJobs = ['gate-reconcile', 'channel-delivery'] as const;
    let store = healthyStore({ config: disabledConfig, jobNames: requiredJobs });
    let report = await inspect({
      config: disabledConfig, snapshot: snapshotAndClose(store, disabledConfig),
    });
    expect(report).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    expect(report.jobs.filter((job) => job.state === 'absent').map((job) => job.job)).toEqual([
      'repository-discovery', 'run-observer', 'pr-digest',
    ]);

    rmSync(statePath, { force: true });
    store = healthyStore({ config: disabledConfig, jobNames: requiredJobs });
    for (const job of ['repository-discovery', 'run-observer', 'pr-digest'] as const) {
      const claim = store.startDaemonJob(job, AT0);
      if (claim === null) throw new Error('expected disabled observer claim');
      const failed = store.completeDaemonJobFailure({
        claim, at: AT1, durationMs: 1, errorCode: 'github.unavailable',
      });
      if (failed === null) throw new Error('expected disabled observer failure');
      if (job === 'run-observer') store.scheduleDaemonJobBackoff(job, failed.revision, AT2, AT2);
    }
    report = await inspect({
      config: disabledConfig, snapshot: snapshotAndClose(store, disabledConfig),
    });
    expect(report).toMatchObject({ exitCode: 0, codes: ['status.healthy'] });
    expect(report.jobs.find((job) => job.job === 'repository-discovery')?.state).toBe('failed');
    expect(report.jobs.find((job) => job.job === 'run-observer')?.state).toBe('backoff');

    rmSync(statePath, { force: true });
    store = healthyStore({
      config: disabledConfig,
      jobNames: requiredJobs,
      failure: 'gate-reconcile',
    });
    report = await inspect({
      config: disabledConfig, snapshot: snapshotAndClose(store, disabledConfig),
    });
    expect(report).toMatchObject({ exitCode: 1, codes: expect.arrayContaining(['job.failed']) });

    rmSync(statePath, { force: true });
    store = healthyStore({ config: disabledConfig, jobNames: ['gate-reconcile'] });
    report = await inspect({
      config: disabledConfig, snapshot: snapshotAndClose(store, disabledConfig),
    });
    expect(report).toMatchObject({ exitCode: 1, codes: expect.arrayContaining(['job.absent']) });
  });

  it('accepts an injected O1-6 task facet without inspecting or mutating Task Scheduler', async () => {
    const snapshot = snapshotAndClose(healthyStore());
    expect(await inspect({ snapshot, taskFacet: () => ({ ownership: 'absent', state: 'stopped' }) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['task.absent', 'task.stopped']),
    });
    expect(await inspect({ snapshot, taskFacet: () => ({ ownership: 'drifted', state: 'running' }) })).toMatchObject({
      exitCode: 2, codes: expect.arrayContaining(['task.drift']),
    });
    expect(await inspect({ snapshot, taskFacet: () => ({ ownership: 'matched', state: 'running' }) })).toMatchObject({
      exitCode: 0,
    });
  });

  it('does not create an absent source database or a temporary snapshot', async () => {
    expect(existsSync(statePath)).toBe(false);
    expect((await inspect()).codes).toContain('schema.absent');
    expect(existsSync(statePath)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it.each([12, 16] as const)('does not migrate or alter a schema-v%s source database', async (version) => {
    healthyStore().close();
    const raw = new DatabaseSync(statePath);
    raw.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(version);
    raw.close();
    const beforeHash = sha256(statePath);
    const beforeFiles = readdirSync(dir).sort();
    const report = await inspect();
    expect(report).toMatchObject({ exitCode: 2, schema: { state: 'mismatched', foundVersion: version } });
    expect(sha256(statePath)).toBe(beforeHash);
    expect(readdirSync(dir).sort()).toEqual(beforeFiles);
  }, 15_000);

  it('reads a multi-page closed snapshot with the positive backup batch bound', async () => {
    const store = healthyStore();
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [],
      bindings: [],
      issues: Array.from({ length: 512 }, (_, index) => ({
        issueHash: index.toString(16).padStart(64, '0'),
        category: 'capacity_deferred' as const,
      })),
      at: AT0,
    });
    store.close();

    // The default SQLite page size is 4096; the populated fixture must cross one page without
    // opening another source connection between the closed-WAL witness and the status read.
    expect(statSync(statePath).size).toBeGreaterThan(4096);

    await expect(inspect()).resolves.toMatchObject({
      exitCode: 1,
      schema: { state: 'matched', foundVersion: 15 },
      registry: { active: 0, pending: 0, rejected: 0, deferred: 512 },
    });
  }, 15_000);

  it('does not alter or echo a corrupt source database', async () => {
    writeFileSync(statePath, 'SENTINEL_CORRUPT_DATABASE');
    const beforeHash = sha256(statePath);
    const beforeFiles = readdirSync(dir).sort();
    const report = await inspect();
    expect(report).toMatchObject({ exitCode: 2, schema: { state: 'corrupt' } });
    expect(JSON.stringify(report)).not.toContain('SENTINEL');
    expect(sha256(statePath)).toBe(beforeHash);
    expect(readdirSync(dir).sort()).toEqual(beforeFiles);
  });

  it('turns config/path failures into static exit-2 codes without leaking private paths', async () => {
    const privatePath = join(dir, 'SENTINEL-private-config.json');
    const invalidConfig = await inspectOperationalStatus({
      configPath: privatePath, statePath, logDir: dir,
    });
    expect(invalidConfig).toMatchObject({ exitCode: 2, codes: ['config.invalid'] });
    expect(JSON.stringify(invalidConfig)).not.toContain('SENTINEL');

    const pathFailure = await inspectOperationalStatus({
      config,
      env: {},
      platform: 'win32',
      expectedBuildIdentity: BUILD,
    });
    expect(pathFailure).toMatchObject({ exitCode: 2, codes: ['state.path_unavailable'] });
  });
});

describe('registry and exact D2/D3 aggregates', () => {
  it('separates active/pending/rejected/deferred registry aggregates without returning identities', async () => {
    const store = healthyStore();
    store.replaceDiscoverySnapshot({
      passOutcome: 'succeeded',
      repositories: [{
        canonicalKey: 'github.com/private-owner/private-repository',
        nameWithOwner: 'private-owner/private-repository',
        githubRepositoryId: 123,
        projectKey: 'Project Sentinel',
        projectOrigin: 'explicit',
        evidence: 'verified',
      }],
      bindings: [],
      issues: [
        { issueHash: 'a'.repeat(64), category: 'github_identity_unverified' },
        { issueHash: 'b'.repeat(64), category: 'capacity_deferred' },
        { issueHash: 'c'.repeat(64), category: 'no_remote' },
      ],
      at: AT0,
    });
    store.close();
    const report = await inspect();
    expect(report).toMatchObject({
      exitCode: 1,
      registry: { active: 1, pending: 1, rejected: 1, deferred: 1 },
      codes: expect.arrayContaining(['registry.pending', 'registry.rejected', 'registry.deferred']),
    });
    expect(JSON.stringify(report)).not.toContain('private-owner');
    expect(JSON.stringify(report)).not.toContain('Project Sentinel');
  });

  it('keeps legacy notification_state diagnostic but not actionable', async () => {
    const snapshot = projectedSnapshot({
      gateCards: 0, channelDeliveries: 0, resumeBaselines: 0,
      legacyNotifications: 1, slackRootIntents: 0,
    });
    const report = await inspect({ snapshot });
    expect(report.work.pending).toMatchObject({ legacyNotifications: 1, actionableTotal: 0 });
    expect(report.codes).not.toContain('work.pending');
    expect(report.exitCode).toBe(0);
    expect(JSON.stringify(report)).not.toContain('gate:legacy-private-id');
  });

  it('projects gate card, delivery, required resume, Slack pending/uncertain, and unavailable-resume dead exactly', async () => {
    const snapshot = projectedSnapshot({
      gateCards: 1, channelDeliveries: 1, resumeBaselines: 1,
      legacyNotifications: 0, slackRootIntents: 1,
    }, 1, 1);
    const report = await inspect({ snapshot });
    expect(report.work).toEqual({
      pending: {
        gateCards: 1, channelDeliveries: 1, resumeBaselines: 1, slackRootIntents: 1,
        legacyNotifications: 0, actionableTotal: 4,
      },
      uncertain: { slackRootIntents: 1, total: 1 },
      dead: { unavailableResumeBaselines: 1, total: 1 },
    });
    expect(report).toMatchObject({
      exitCode: 1,
      codes: expect.arrayContaining(['work.pending', 'work.uncertain', 'work.dead']),
    });
    const json = JSON.stringify(report);
    for (const sentinel of ['private-id', 'C_PRIVATE', 'dispatch-private-id']) expect(json).not.toContain(sentinel);
  });
});
