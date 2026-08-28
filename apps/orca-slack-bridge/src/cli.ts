#!/usr/bin/env node
import {
  DEFAULT_AUTOMATION_CONFIG,
  loadConfig,
  defaultConfigPath,
  type BridgeConfig,
  type ParsedBridgeConfig,
} from './project/config.js';
import {
  persistGateMetadata,
  readGateRegistrationDocument,
  validateGateRegistrationIdentity,
  type GateRegistrationResult,
} from './gate/register.js';
import { GhCli, type GhRunner } from './github/runner.js';
import { BackgroundGithub } from './github/background.js';
import { repositoryIdentityConfirmer } from './github/repository.js';
import { boundedOrcaRunner, OrcaCli, type OrcaRunner } from './orca/client.js';
import { takeSnapshot, summarize } from './snapshot/snapshot.js';
import { formatRunCollection } from './run/collect.js';
import {
  formatRunObserveReport,
  runRunObserver,
  type RunObserveOptions,
} from './run/publish.js';
import { RunCollectionContractError } from './run/collect.js';
import { appToken, verifySlack, formatVerify, maskToken } from './slack/verify.js';
import {
  SlackSocketTransport,
  slackSdkConnectionFactory,
  verifySocketPreflight,
  type SocketConnectionFactory,
  type SocketTimeouts,
} from './slack/socket.js';
import { runDigest, formatReport } from './digest/digest.js';
import {
  SlackWebApiPoster,
  botToken,
  type SlackPoster,
  type ThreadPoster,
} from './slack/post.js';
import {
  OperationalStoreError,
  ReadOnlyDigestStore,
  SchemaVersionError,
  SqliteDigestStore,
  resolveStatePath,
} from './store/sqlite.js';
import type { DigestStore, GateStore, RunStore } from './store/schema.js';
import type { SummaryProvider } from './summarize/openai.js';
import { GateActionHandler } from './gate/action-handler.js';
import {
  GateDirectInputHandler,
  isGateDirectInputEvent,
} from './gate/direct-input-handler.js';
import { GateResolutionEngine } from './gate/resolve.js';
import {
  SlackWebApiViewOpener,
  type SlackViewOpener,
} from './slack/views.js';
import {
  ChannelAdapterClient,
  channelAdapterIdentityFromEnv,
  type ChannelAdapterIdentity,
  type ChannelNotificationWriter,
} from './channel/adapter.js';
import { ChannelMcpServer, type ChannelReceiptHandler } from './channel/mcp-server.js';
import { GateChannelDeliveryEngine } from './channel/delivery.js';
import {
  ChannelPipeServer,
  type ChannelDeliverySendResult,
  type ChannelPipeErrorCode,
  type ChannelProductionCommitFence,
  type ChannelProductionDeliveryEvent,
  type ChannelProductionDeliveryHandlers,
} from './channel/pipe-server.js';
import type { Readable, Writable } from 'node:stream';
import type { DaemonJobName } from './store/operational-types.js';
import type { DaemonJobClaim, OperationalFailureCode } from './store/operational-types.js';
import {
  formatOperationalStatus,
  inspectOperationalStatus,
  OperationalStatusOwnerServer,
  type InspectOperationalStatusOptions,
  type OperationalStatusOwnerServerLike,
} from './operational/status.js';
import {
  CurrentUserOperationalStatusCapabilityStore,
  operationalStatusCapabilityPath,
  operationalStatusStateIdentity,
  type OperationalStatusSnapshotLease,
  type OperationalStatusSnapshotLeaseStore,
} from './operational/status-capability.js';
import {
  followOperationalLogs,
  formatOperationalLogRecord,
  readOperationalLogTail,
} from './operational/logs.js';
import {
  OPERATIONAL_JOB_NAMES,
  OperationalNdjsonLogger,
  entityIdentity,
  resolveOperationalLogDir,
  type OperationalTelemetrySink,
} from './operational/logger.js';
import { OperationalHealthTelemetry } from './operational/health.js';
import {
  fingerprintOperationalBuild,
  fingerprintOperationalConfig,
} from './operational/status.js';
import {
  bridgeConfigFingerprint,
  buildEffectiveBridgeConfig,
  compareText,
} from './discovery/effective-config.js';
import { runRepositoryDiscoveryPass } from './discovery/reconcile.js';
import type { EffectiveBridgeConfig } from './discovery/types.js';
import {
  ObserverJobFailure,
  ObserverSupervisor,
  SYSTEM_OBSERVER_CLOCK,
  type ObserverClock,
  type ObserverCompletion,
  type ObserverJobName,
} from './observer/supervisor.js';
import type { SlackRootIntentRuntime } from './slack/root-intent.js';
import { randomUUID } from 'node:crypto';
import { installWindowsTask, type InstallCommandDependencies } from './commands/install.js';
import {
  DEFAULT_WINDOWS_WAIT_SECONDS,
  managedTaskStatusObservation,
  runManagedTaskNow,
  type RunNowDependencies,
} from './commands/run-now.js';
import { uninstallWindowsTask, type UninstallCommandDependencies } from './commands/uninstall.js';
import {
  CurrentUserTaskSchedulerPowerShellRunner,
  CurrentUserWindowsTaskScheduler,
} from './windows/task-scheduler.js';

export type Command =
  | 'snapshot'
  | 'verify-slack'
  | 'digest'
  | 'runs'
  | 'gate-register'
  | 'daemon'
  | 'channel-adapter'
  | 'status'
  | 'logs'
  | 'install'
  | 'uninstall'
  | 'run-now';

export type ParsedArgs =
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'run';
      readonly command: Command;
      readonly configPath: string | null;
      readonly orcaBin: string | null;
      readonly prLimit: number;
      readonly json: boolean;
      /** durable store 경로. null이면 `ORCA_SLACK_BRIDGE_STATE` 또는 기본 경로다. */
      readonly statePath: string | null;
      /** Required JSON file transport for `gate-register`; null for other commands. */
      readonly inputPath: string | null;
      /** `digest`가 처리할 PR 번호. null이면 전부. */
      readonly pr: number | null;
      /** 참이면 Slack과 store에 쓰지 않는다. */
      readonly dryRun: boolean;
      /** `verify-slack`에서만 실제 Socket hello를 확인한다. */
      readonly socket: boolean;
      /** status/logs가 참조하는 bounded operational log directory. */
      readonly logDir: string | null;
      /** logs가 출력할 마지막 safe record 수. */
      readonly tail: number;
      /** logs가 rotation/truncation을 따라갈지 여부. */
      readonly follow: boolean;
      /** logs가 parsed allowlisted job field로 거를 이름. */
      readonly job: DaemonJobName | null;
      /** Windows current-user deployment release root. */
      readonly appRoot: string | null;
      /** Exact versioned node.exe used by the Scheduled Task action. */
      readonly nodePath: string | null;
      /** Install is the only lifecycle command allowed to request an immediate start. */
      readonly runNow: boolean;
      /** Bounded health/clean-stop wait for Windows lifecycle commands. */
      readonly waitSeconds: number;
      /** Explicit post-timeout owned-task force recovery; uninstall only. */
      readonly force: boolean;
    };

type RunArgs = Extract<ParsedArgs, { readonly kind: 'run' }>;

/**
 * 값 플래그의 값을 읽는다. 플래그가 없으면 undefined.
 *
 * `argv[i + 1]`을 그대로 값으로 쓴다. 그 자리에 값이 실제로 있는지는 `missingFlagValue`가 먼저
 * 판정하므로 여기서 다시 보지 않는다. **새 값 플래그를 만들면 반드시 `VALUE_FLAGS`에 넣는다.**
 * 넣지 않으면 그 플래그만 검사를 통과하지 못한 채 값 없이 흐른다.
 */
function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const COMMANDS: readonly Command[] = [
  'snapshot', 'verify-slack', 'digest', 'runs', 'gate-register', 'daemon', 'channel-adapter',
  'status', 'logs', 'install', 'uninstall', 'run-now',
];

function isCommand(v: string | undefined): v is Command {
  return v !== undefined && (COMMANDS as readonly string[]).includes(v);
}

/** 값을 받는 플래그와 받지 않는 플래그. 값 검사와 `digest`의 오타 검사에 쓴다. */
const VALUE_FLAGS: readonly string[] = [
  '--config',
  '--orca',
  '--pr-limit',
  '--pr',
  '--state',
  '--input',
];
const BOOL_FLAGS: readonly string[] = ['--json', '--dry-run', '--socket'];
const ALL_VALUE_FLAGS: readonly string[] = [
  ...VALUE_FLAGS, '--log-dir', '--tail', '--job', '--app-root', '--node', '--wait-seconds',
];

/**
 * 되돌릴 수 없는 외부 write를 하는 명령.
 *
 * 이 목록의 명령은 write 안전 때문에 모르는 인자를 거부한다. `verify-slack`은 별도로
 * Socket preflight 선택 오타를 막기 위해 exact allowlist를 쓴다.
 */
const WRITE_COMMANDS: readonly Command[] = [
  'digest', 'runs', 'gate-register', 'daemon', 'install', 'uninstall', 'run-now',
];

/** `gate-register` has a deliberately narrow production transport; other known flags are still invalid. */
function unknownGateRegisterArg(argv: readonly string[]): string | null {
  const valueFlags = new Set(['--input', '--state', '--orca']);
  const boolFlags = new Set(['--json']);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (valueFlags.has(token)) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) i += 1;
      continue;
    }
    if (boolFlags.has(token)) continue;
    return token;
  }
  return null;
}

/** Long-running consumer accepts only the identities needed to open its exact local/remote paths. */
function unknownDaemonArg(argv: readonly string[]): string | null {
  const valueFlags = new Set(['--config', '--state', '--orca', '--log-dir']);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (valueFlags.has(token)) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) i += 1;
      continue;
    }
    return token;
  }
  return null;
}

/** The stdio Adapter has a fixed pipe address and accepts no runtime flags or positionals. */
function unknownChannelAdapterArg(argv: readonly string[]): string | null {
  return argv[1] ?? null;
}

/** Socket preflight 선택이 있는 verify-slack은 문서화된 공통 옵션과 --socket만 받는다. */
function unknownVerifySlackArg(argv: readonly string[]): string | null {
  const valueFlags = new Set(['--config', '--orca', '--pr-limit']);
  const boolFlags = new Set(['--json', '--socket']);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (valueFlags.has(token)) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) i += 1;
      continue;
    }
    if (boolFlags.has(token)) continue;
    return token;
  }
  return null;
}

function unknownExactArg(
  argv: readonly string[],
  valueFlags: readonly string[],
  boolFlags: readonly string[],
): string | null {
  const values = new Set(valueFlags);
  const booleans = new Set(boolFlags);
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (values.has(token)) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) i += 1;
      continue;
    }
    if (booleans.has(token)) continue;
    return token;
  }
  return null;
}

function repeatedExactArg(argv: readonly string[], flags: readonly string[]): string | null {
  for (const flag of flags) {
    if (argv.filter((token) => token === flag).length > 1) return flag;
  }
  return null;
}

/**
 * 값 플래그가 값을 실제로 받았는지 본다. 위반이 없으면 null.
 *
 * `arg()`는 `argv[i + 1]`을 무조건 값으로 쓰므로, 이 검사가 없으면 값이 없거나 값 자리에 다른
 * 플래그가 온 호출이 오류 없이 `run`으로 내려간다. 그때 잃는 것이 크다.
 *
 * - `digest --pr`은 `pr = null`이 되어 좁히려던 의도와 반대로 **모든 PR에 게시**한다.
 * - `digest --state`는 기본 DB로 간다. 다른 store를 쓰려던 의도가 조용히 뒤집힌다.
 * - `digest --state --dry-runn`은 `--dry-run` 오타가 `--state`의 값으로 먹혀 `dryRun`이 false가
 *   된다. 실제 채널에 게시하면서 없던 이름의 DB를 열어 기존 매핑을 못 찾으므로 **루트를 하나 더
 *   만든다.** 로드맵 §5의 "재관찰로 루트가 중복되지 않음"이 오타 하나로 깨진다.
 *
 * 값이 `--`로 시작하면 오류로 본다. 값을 요구하는 자리에 플래그가 온 것이므로 오타이거나 값
 * 누락이다. `--config`·`--orca`·`--state`의 값이 `--`로 시작하는 정상적인 호출은 없다.
 *
 * `unknownWriteFlag`와 달리 이 검사는 **모든 명령**에 건다. 모르는 인자를 무시하는 것은
 * `snapshot`에서 무해하지만, 값 없는 값 플래그는 어느 명령에서도 유효한 호출이 아니어서 뺏을
 * 정상 동작이 없다. 원인도 명령별이 아니라 `arg()` 한 곳에 있으므로 명령별 특례를 두지 않는다.
 */
function missingFlagValue(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !ALL_VALUE_FLAGS.includes(token)) continue;
    const value = argv[i + 1];
    if (value === undefined) return `${token}은 값을 요구하는데 값이 없다`;
    if (value.startsWith('--')) return `${token}은 값을 요구하는데 플래그가 왔다: ${value}`;
  }
  return null;
}

/**
 * write하는 명령이 모르는 인자를 찾는다. 없으면 null.
 *
 * 이 파서는 `indexOf`로 아는 이름만 찾으므로 모르는 인자를 조용히 무시한다. `snapshot`은
 * 기존 호환 동작을 유지하지만 `digest`와 `runs`는 되돌릴 수 없는 외부 write를 한다.
 * `--dry-run`을 한 글자 틀리면 확인 없이 실제 채널에 게시된다. 그래서 write하는 명령에만
 * 검사를 건다. 다른 명령의 기존 동작은 바꾸지 않는다.
 *
 * **`--`로 시작하는 토큰만 보지 않는다.** `runs -dry-run`과 `runs dry-run`은 하이픈이 모자란
 * 오타이지 다른 뜻의 호출이 아닌데, `--`로 시작하는 것만 검사하면 둘 다 통과해 `dryRun`이
 * false가 된다. 확인 없이 실제 채널에 게시된다 — 이 함수가 막으려던 바로 그 결과다.
 * `digest`와 `runs`는 위치 인자를 하나도 받지 않으므로 떠도는 위치 인자에 뺏을 정상 동작이 없다.
 *
 * **write하는 명령이 늘면 `WRITE_COMMANDS`에 넣는다.** 넣지 않으면 그 명령에서 `--dry-run`
 * 오타가 확인 없이 실제 게시로 간다.
 *
 * 값 플래그의 **값 자리는 건너뛴다.** 그 자리의 `state.db` 같은 토큰은 위치 인자가 아니라 값이다.
 * 단, 값이 `--`로 시작하면 건너뛰지 않는다. 건너뛰던 예전 코드가 `--state --dry-runn`의 오타를
 * 값으로 보아 통과시켰다. `missingFlagValue`가 먼저 돌아 그 형태를 이미 거부하지만, 그 순서에
 * 기대지 않아야 검사 순서가 바뀌어도 오타가 값으로 먹히지 않는다.
 */
function unknownWriteFlag(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (VALUE_FLAGS.includes(token)) {
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith('--')) i += 1;
      continue;
    }
    if (BOOL_FLAGS.includes(token)) continue;
    return token;
  }
  return null;
}

/** 인자 해석을 순수 함수로 분리해 테스트가 명령 분기를 검증할 수 있게 한다. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes('--help') || argv.length === 0) return { kind: 'help' };
  const command = argv[0];
  if (!isCommand(command)) {
    return { kind: 'error', message: `알 수 없는 명령: ${String(command)}` };
  }
  if (command !== 'gate-register' && argv.includes('--input')) {
    return { kind: 'error', message: `${command}가 모르는 인자다: --input` };
  }
  if (command !== 'verify-slack' && argv.includes('--socket')) {
    return { kind: 'error', message: `${command}가 모르는 인자다: --socket` };
  }
  if (command === 'verify-slack') {
    const unknown = unknownVerifySlackArg(argv);
    if (unknown !== null) {
      return { kind: 'error', message: `verify-slack이 모르는 인자다: ${unknown}` };
    }
  }
  const missing = missingFlagValue(argv);
  if (missing !== null) return { kind: 'error', message: missing };
  if (command === 'install') {
    const required = ['--app-root', '--node', '--orca', '--config', '--state', '--log-dir'];
    const flags = [...required, '--wait-seconds', '--run-now'];
    const unknown = unknownExactArg(
      argv,
      ['--app-root', '--node', '--orca', '--config', '--state', '--log-dir', '--wait-seconds'],
      ['--run-now'],
    );
    if (unknown !== null) return { kind: 'error', message: 'install이 모르는 인자다' };
    const repeated = repeatedExactArg(argv, flags);
    if (repeated !== null) return { kind: 'error', message: `install은 ${repeated}을 한 번만 받는다` };
    const absent = required.find((flag) => arg(argv, flag) === undefined || arg(argv, flag) === '');
    if (absent !== undefined) return { kind: 'error', message: `install은 ${absent}이 필수다` };
  }
  if (command !== 'install' && argv.includes('--run-now')) {
    return { kind: 'error', message: `${command}가 모르는 인자다: --run-now` };
  }
  for (const installOnly of ['--app-root', '--node']) {
    if (command !== 'install' && argv.includes(installOnly)) {
      return { kind: 'error', message: `${command}가 모르는 인자다: ${installOnly}` };
    }
  }
  if (command !== 'install' && command !== 'uninstall' && command !== 'run-now' &&
      argv.includes('--wait-seconds')) {
    return { kind: 'error', message: `${command}가 모르는 인자다: --wait-seconds` };
  }
  if (command === 'uninstall' || command === 'run-now') {
    const unknown = unknownExactArg(argv, ['--wait-seconds'], command === 'uninstall' ? ['--force'] : []);
    if (unknown !== null) return { kind: 'error', message: `${command}이 모르는 인자다` };
    const repeated = repeatedExactArg(argv, command === 'uninstall' ? ['--wait-seconds', '--force'] : ['--wait-seconds']);
    if (repeated !== null) return { kind: 'error', message: `${command}은 ${repeated}을 한 번만 받는다` };
  }
  if (command !== 'uninstall' && argv.includes('--force')) {
    return { kind: 'error', message: `${command}가 모르는 인자다: --force` };
  }
  if (command === 'status') {
    const flags = ['--config', '--state', '--log-dir', '--json'];
    const unknown = unknownExactArg(argv, ['--config', '--state', '--log-dir'], ['--json']);
    if (unknown !== null) return { kind: 'error', message: 'status가 모르는 인자다' };
    const repeated = repeatedExactArg(argv, flags);
    if (repeated !== null) return { kind: 'error', message: `status는 ${repeated}을 한 번만 받는다` };
  }
  if (command === 'logs') {
    const flags = ['--tail', '--follow', '--job', '--log-dir'];
    const unknown = unknownExactArg(argv, ['--tail', '--job', '--log-dir'], ['--follow']);
    if (unknown !== null) return { kind: 'error', message: 'logs가 모르는 인자다' };
    const repeated = repeatedExactArg(argv, flags);
    if (repeated !== null) return { kind: 'error', message: `logs는 ${repeated}을 한 번만 받는다` };
  }
  if ((WRITE_COMMANDS as readonly string[]).includes(command) &&
      command !== 'daemon' && command !== 'install' && command !== 'uninstall' &&
      command !== 'run-now') {
    const unknown = unknownWriteFlag(argv);
    if (unknown !== null) {
      return { kind: 'error', message: `${command}가 모르는 인자다: ${unknown}` };
    }
  }
  if (command === 'gate-register') {
    const unknown = unknownGateRegisterArg(argv);
    if (unknown !== null) {
      return { kind: 'error', message: `gate-register가 모르는 인자다: ${unknown}` };
    }
    const inputCount = argv.filter((token) => token === '--input').length;
    if (inputCount !== 1) {
      return {
        kind: 'error',
        message:
          inputCount === 0
            ? 'gate-register는 --input <JSON 파일 경로>가 필수다'
            : 'gate-register는 --input을 정확히 한 번만 받는다',
      };
    }
    const inputPath = arg(argv, '--input');
    if (inputPath === undefined || inputPath.trim() === '') {
      return { kind: 'error', message: 'gate-register --input 경로가 비어 있다' };
    }
  }
  if (command === 'daemon') {
    const unknown = unknownDaemonArg(argv);
    if (unknown !== null) {
      return { kind: 'error', message: `daemon이 모르는 인자다: ${unknown}` };
    }
  }
  if (command === 'channel-adapter') {
    const unknown = unknownChannelAdapterArg(argv);
    if (unknown !== null) {
      return { kind: 'error', message: `channel-adapter가 모르는 인자다: ${unknown}` };
    }
  }
  const prLimitRaw = arg(argv, '--pr-limit');
  const prLimit = prLimitRaw === undefined ? 50 : Number.parseInt(prLimitRaw, 10);
  if (!Number.isSafeInteger(prLimit) || prLimit <= 0) {
    return { kind: 'error', message: `--pr-limit이 양의 정수가 아니다: ${String(prLimitRaw)}` };
  }
  const prRaw = arg(argv, '--pr');
  const pr = prRaw === undefined ? null : Number.parseInt(prRaw, 10);
  if (pr !== null && (!Number.isSafeInteger(pr) || pr <= 0)) {
    return { kind: 'error', message: `--pr이 양의 정수가 아니다: ${String(prRaw)}` };
  }
  const tailRaw = arg(argv, '--tail');
  const tail = tailRaw === undefined ? 200 : Number(tailRaw);
  if (command === 'logs' && tailRaw !== undefined &&
      (!/^[1-9][0-9]*$/u.test(tailRaw) || !Number.isSafeInteger(tail) || tail > 5_000)) {
    return { kind: 'error', message: '--tail은 1..5000 정수여야 한다' };
  }
  const jobRaw = arg(argv, '--job');
  if (command === 'logs' && jobRaw !== undefined &&
      !(OPERATIONAL_JOB_NAMES as readonly string[]).includes(jobRaw)) {
    return { kind: 'error', message: '--job이 알려진 daemon job 이름이 아니다' };
  }
  const waitRaw = arg(argv, '--wait-seconds');
  const waitSeconds = waitRaw === undefined ? DEFAULT_WINDOWS_WAIT_SECONDS : Number(waitRaw);
  if ((command === 'install' || command === 'uninstall' || command === 'run-now') &&
      (!/^[1-9][0-9]*$/u.test(waitRaw ?? String(DEFAULT_WINDOWS_WAIT_SECONDS)) ||
       !Number.isSafeInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 300)) {
    return { kind: 'error', message: '--wait-seconds는 1..300 정수여야 한다' };
  }
  return {
    kind: 'run',
    command,
    configPath: arg(argv, '--config') ?? null,
    orcaBin: arg(argv, '--orca') ?? null,
    prLimit,
    json: argv.includes('--json'),
    statePath: arg(argv, '--state') ?? null,
    inputPath: arg(argv, '--input') ?? null,
    pr,
    dryRun: argv.includes('--dry-run'),
    socket: command === 'verify-slack' && argv.includes('--socket'),
    logDir: arg(argv, '--log-dir') ?? null,
    tail,
    follow: command === 'logs' && argv.includes('--follow'),
    job: command === 'logs' && jobRaw !== undefined ? jobRaw as DaemonJobName : null,
    appRoot: arg(argv, '--app-root') ?? null,
    nodePath: arg(argv, '--node') ?? null,
    runNow: command === 'install' && argv.includes('--run-now'),
    waitSeconds,
    force: command === 'uninstall' && argv.includes('--force'),
  };
}

export const CLI_USAGE = `orca-slack-bridge <snapshot|verify-slack|digest|runs|gate-register|daemon|channel-adapter|status|logs|install|uninstall|run-now>

snapshot      Orca와 GitHub을 read-only로 1회 관찰한다
verify-slack  Slack 토큰과 설정을 확인한다 (기본은 연결하지 않는다)
digest        관찰 1회로 PR digest 카드를 #pr-digest에 게시하거나 갱신한다
runs          관찰 1회로 Run 카드를 #agent-runs에 게시하거나 갱신한다
gate-register coordinator가 만든 Gate sidecar JSON을 검증해 local SQLite에 등록한다
daemon        Gate action과 verified Channel delivery/resume를 durable하게 재조정한다
channel-adapter session별 stdio MCP Channel Adapter를 실행하고 daemon pipe에 재연결한다
status        local operational state를 read-only로 진단한다
logs          redacted rotating NDJSON history를 read-only로 읽는다
install       prebuilt release를 current-user Windows Scheduled Task로 설치한다
uninstall     managed task를 clean stop 뒤 등록 해제한다 (data/release는 보존)
run-now       exact-owned installed task를 시작하고 fresh heartbeat를 기다린다

  --config <path>   설정 파일 (기본: ORCA_SLACK_BRIDGE_CONFIG 또는 OS 설정 경로)
  --orca <path>     orca 실행 파일 (기본: ORCA_BIN 또는 'orca')
  --pr-limit <n>    repository당 조회할 PR 수 (기본 50)
  --json            요약 대신 결과 전체를 JSON으로 출력

verify-slack 전용:

  --socket          Socket에 연결해 hello/App ID를 확인한 뒤 바로 닫는다

digest·runs 전용:

  --state <path>    durable store 경로 (기본: ORCA_SLACK_BRIDGE_STATE 또는 OS state 경로)
  --dry-run         Slack에도 store에도 쓰지 않고 만들 blocks와 결정을 출력한다

digest 전용:

  --pr <number>     이 번호의 PR만 처리한다

gate-register 전용:

  --input <path>    strict Gate metadata JSON 파일 (필수; stdin/자유 텍스트 입력 없음)
  --state <path>    등록할 durable store 경로

daemon 전용:

  --state <path>    v13 durable store 경로 (additive migration, dry-run 없음)
  --log-dir <path>  operational log directory

status 전용:

  --config <path>   비교할 strict config
  --state <path>    읽을 durable store (source migration/create 없음)
  --log-dir <path>  operational log directory
  --json            aggregate/static-code report를 JSON으로 출력

install 전용:

  --app-root <path> stage:windows가 만든 LocalAppData digest release root (절대경로, 필수)
  --node <path>     Node 26+ node.exe (절대경로, 필수)
  --orca <path>     orca 실행 파일 (절대경로, 필수)
  --config <path>   strict credential-free config (절대경로, 필수)
  --state <path>    durable store (절대경로, 필수)
  --log-dir <path>  operational log directory (절대경로, 필수)
  --run-now         설치 후 exact release heartbeat까지 기다린다
  --wait-seconds N  heartbeat 제한시간 (1..300, 기본 90)

uninstall·run-now 전용:

  --wait-seconds N  clean stop 또는 heartbeat 제한시간 (1..300, 기본 90)

uninstall 전용:

  --force           clean-stop timeout 뒤 exact-owned task만 강제 중지하고 bounded release를 기다린다

logs 전용:

  --tail <n>        마지막 safe record 수 (기본 200, 범위 1..5000)
  --follow          rotation/truncation을 따라가며 signal까지 대기
  --job <name>      parsed allowlisted daemon job field로 필터
  --log-dir <path>  operational log directory

snapshot과 verify-slack은 외부 write를 하지 않는다. digest는 설정의 slack.channels.prDigest에만,
runs는 slack.channels.agentRuns에만 게시하며 채널을 코드에서 만들지 않는다. runs는 Run마다 카드
하나와, 등록된 Run 수와 무관하게 컬렉션 카드 하나를 게시한다(OD-080). gate-register는 Orca Gate를
read-only로 재조회한 뒤 local SQLite에만 쓰고 Slack/Orca mutation을 하지 않는다. daemon은
Bridge-owned fixed-option action과 verified Channel pipe를 실행하고, v12 delivery를 lazy seed해 exact
production Gate ID를 전달·receipt·consume한다. 새 Task/Dispatch를 직접 만들지 않으며, receipt 뒤
Orca에서 실제 후속 Task resume evidence를 관찰한 경우에만 기존 Slack Gate 카드를 갱신한다.
channel-adapter는 옵션이 없다.`;

/**
 * summarizer provider를 만든다.
 *
 * 키가 없으면 던지지 않고 **항상 실패하는 provider**를 준다. `summarize`가 그 실패를
 * `kind: 'failed'`로 바꾸므로 카드는 요약 없이 사실만 담은 축소 카드로 게시된다(OD-035).
 * 여기서 던지면 요약 실패 하나가 GitHub·Orca 관찰과 Slack 게시를 통째로 막는다.
 */
async function summaryProvider(env: NodeJS.ProcessEnv): Promise<SummaryProvider> {
  const {
    OPENAI_KEY_VAR,
    OpenAiSummaryProvider,
    SummaryProviderError,
  } = await import('./summarize/index.js');
  const key = env[OPENAI_KEY_VAR]?.trim();
  if (!key) {
    return {
      complete: () =>
        Promise.reject(new SummaryProviderError(`${OPENAI_KEY_VAR}가 비어 있다`, false)),
    };
  }
  return new OpenAiSummaryProvider({ apiKey: key });
}

/**
 * digest가 쓸 store를 연다.
 *
 * dry-run은 읽기 전용 store를 쓴다. `SqliteDigestStore`는 여는 것만으로 부모 디렉터리와 DB
 * 파일을 만들고 WAL과 스키마를 쓰며 닫을 때 checkpoint하므로, 도움말이 말하는 "store에 쓰지
 * 않는다"가 거짓이 된다. 쓰지 않는 수단과 그 근거는 `ReadOnlyDigestStore`에 있다.
 */
export function openDigestStore(statePath: string, dryRun: boolean): DigestStore {
  return dryRun ? new ReadOnlyDigestStore(statePath) : new SqliteDigestStore(statePath);
}

/**
 * 게시 명령의 실패를 사람이 읽는 한 줄로 만든다. 대상 채널 ID를 지운다.
 *
 * `digest`와 `runs`가 함께 쓴다. 두 경로의 store 오류가 같은 모양으로 채널 ID를 싣기 때문이다
 * (`insertPrMessage`, `insertRunMessage`, `insertRunCollectionMessage`). 경로마다 따로 만들면
 * 한쪽만 고쳐진다.
 *
 * `store/sqlite.ts`의 `insertPrMessage`는 실패 원인을 좁히려고 오류 message에 `channelId`와
 * `messageTs`를 싣는다. disk full이나 제약 위반이면 그 message가 그대로 stderr로 나가, 설정에서만
 * 와야 할 실제 채널 ID가 로그에 남는다(스펙 §10의 로그 마스킹).
 *
 * store의 오류 형식을 바꾸지 않고 **CLI 경계에서** 지운다. store 오류가 사람에게 나가는 경로가
 * 여기 하나뿐이라 diff가 작고, 같은 오류를 쓰는 다른 경로(test, 예외 chain)의 진단 정보는 그대로
 * 남기 때문이다. 마스킹은 `slack/verify.ts`의 `maskToken`을 그대로 쓴다. `slack/post.ts`가 토큰에
 * 하는 것과 같은 방식이고, 형식을 새로 만들면 둘이 갈라져 한쪽만 고쳐진다.
 *
 * `maskToken`은 길이에 따라 결과가 다르다. 12자 이하는 통째로 `***`가 되고 그보다 길면 앞뒤
 * 일부가 남는다. 통상 Slack 채널 ID는 12자 이하라 `***`가 된다. `config.ts`는 채널 ID의 길이를
 * 제한하지 않으므로, 더 긴 ID에서는 값 전체가 아니라 앞 9자가 남는다는 것을 알고 쓴다.
 *
 * **구현자에게**: store 오류를 사람에게 내보내는 경로를 새로 만들면 여기서 하는 것을 함께 한다.
 */
export function formatChannelError(e: unknown, channel: string): string {
  const message = e instanceof Error ? e.message : String(e);
  // 빈 문자열로 replaceAll하면 문자 사이마다 끼워 넣는다. 지울 것도 없다.
  if (channel === '') return message;
  return message.replaceAll(channel, maskToken(channel));
}

/**
 * digest의 Slack write 경계를 만든다.
 *
 * **dry-run은 poster를 아예 만들지 않는다.** 토큰도 읽지 않으므로 write 경로 자체가 없다.
 *
 * 루트와 thread를 **같은 인스턴스**가 맡는다. 토큰을 한 번만 읽고 재시도 규율이 한 곳에 있다
 * (`slack/post.ts`의 `SlackWebApiPoster`). `digest`는 두 경계를 따로 받으므로 인터페이스는 둘이다.
 *
 * `runDigestCommand`에서 떼어 export한다. 이 배선을 다시 `thread: null`로 되돌리면 실패하는
 * 테스트가 필요한데, `runDigestCommand`는 실제 `gh`·`orca` 프로세스를 만들어 그 자리에서 볼 수
 * 없기 때문이다. 호출자는 이 반환값을 통째로 펼쳐 쓴다 — 뒤에서 한 축만 덮어쓰지 않는다.
 */
export function digestPosters(
  dryRun: boolean,
  env: NodeJS.ProcessEnv,
): { readonly slack: SlackPoster | null; readonly thread: ThreadPoster | null } {
  if (dryRun) return { slack: null, thread: null };
  const poster = new SlackWebApiPoster({ token: botToken(env) });
  return { slack: poster, thread: poster };
}

/**
 * runs가 쓸 store를 연다.
 *
 * `openDigestStore`와 같은 판정을 같은 이유로 한다 — dry-run은 읽기 전용 store를 쓴다.
 * `SqliteDigestStore`는 여는 것만으로 부모 디렉터리와 DB 파일을 만들고 WAL과 스키마를 쓰므로,
 * 도움말이 말하는 "store에 쓰지 않는다"가 거짓이 된다.
 *
 * 반환 타입만 다르다. `runs`는 `DigestStore`가 아니라 `RunStore`를 쓴다. 두 인터페이스를 나눈
 * 이유는 `store/schema.ts`에 있고, 여기서 다시 합치면 그 경계가 CLI에서 무너진다.
 */
export function openRunStore(
  statePath: string,
  dryRun: boolean,
): RunStore & GateStore & { close(): void } {
  return dryRun ? new ReadOnlyDigestStore(statePath) : new SqliteDigestStore(statePath);
}

/**
 * runs의 Slack write 경계를 만든다.
 *
 * **dry-run은 poster를 아예 만들지 않는다.** 토큰도 읽지 않으므로 write 경로 자체가 없다.
 * `digestPosters`와 같은 규율이고, 그 함수와 같은 이유로 `runRunsCommand`에서 떼어 export한다 —
 * 이 배선을 다시 `null`로 되돌리면 실패하는 테스트가 필요한데, `runRunsCommand`는 실제 `orca`
 * 프로세스를 만들어 그 자리에서 볼 수 없기 때문이다.
 *
 * 같은 concrete poster를 Run root, Gate thread card, D2-C status projection에 함께 쓴다.
 * Fixed-option consumption itself is the separate Socket Mode daemon path below.
 */
export function runsPoster(dryRun: boolean, env: NodeJS.ProcessEnv): SlackWebApiPoster | null {
  if (dryRun) return null;
  return new SlackWebApiPoster({ token: botToken(env) });
}

/**
 * runs가 쓸 관찰 옵션을 만든다. **대상 채널과 write 경계가 여기서 정해진다.**
 *
 * 채널은 `slack.channels.agentRuns`다. **`prDigest`가 아니다** — 잘못 쓰면 PR 카드 채널에 Run
 * 카드가 섞이고, 그 뒤 매핑 행의 채널이 굳어 되돌리려면 `channel_mismatch`를 지나야 한다.
 *
 * `runRunsCommand`에서 떼어 export한다. 채널과 poster 두 배선이 다 이 함수 안에 있으므로 어느
 * 하나를 되돌리면 이 함수의 테스트가 실패한다. 실제 `orca`·Slack 프로세스가 없어도 본다.
 */
export function runsObserveOptions(
  parsed: RunArgs,
  config: BridgeConfig,
  store: RunStore & GateStore,
  env: NodeJS.ProcessEnv,
): RunObserveOptions {
  if (config.slack === null) {
    throw new Error('runs는 설정의 slack 섹션이 필요하다. 게시 채널은 설정에서만 읽는다');
  }
  const poster = runsPoster(parsed.dryRun, env);
  return {
    config,
    channel: config.slack.channels.agentRuns,
    store,
    slack: poster,
    thread: poster,
    now: () => new Date(),
  };
}

/**
 * runs 명령 1회.
 *
 * `runDigestCommand`와 같은 모양이다. store를 열고, 옵션을 만들고, 관찰을 한 번 돌리고, 보고를
 * 출력한다. 판정은 전부 `run/` 아래에 있고 여기서 다시 하지 않는다.
 *
 * `orca`를 인자로 받는 이유는 하나다. 이 함수가 `publishRunCollection`까지 실제로 잇는지는
 * 대역 runner 없이 볼 수 없고, 그 배선이 끊긴 채 타입만 맞는 상태가 이 Run에서 반복된 실패
 * 모드다. 기본값은 실제 CLI이므로 프로덕션 경로는 달라지지 않는다.
 */
export async function runRunsCommand(
  parsed: RunArgs,
  config: BridgeConfig,
  orca?: OrcaRunner,
): Promise<number> {
  if (config.slack === null) {
    process.stderr.write('runs는 설정의 slack 섹션이 필요하다. 게시 채널은 설정에서만 읽는다\n');
    return 2;
  }
  const channel = config.slack.channels.agentRuns;
  const orcaBin = parsed.orcaBin ?? process.env['ORCA_BIN'] ?? 'orca';
  const store = openRunStore(resolveStatePath(parsed.statePath), parsed.dryRun);
  try {
    const report = await runRunObserver(
      orca ?? new OrcaCli(orcaBin),
      runsObserveOptions(parsed, config, store, process.env),
    );
    process.stdout.write(
      (parsed.json
        ? JSON.stringify(report, null, 2)
        : `${formatRunCollection(report.facts)}\n\n${formatRunObserveReport(report)}`) + '\n',
    );
    return 0;
  } catch (e) {
    // main의 최상위 handler로 올리지 않는다. 그쪽은 채널 ID를 지울 근거를 갖고 있지 않다.
    process.stderr.write(formatChannelError(e, channel) + '\n');
    return 1;
  } finally {
    store.close();
  }
}

function formatGateRegistration(result: GateRegistrationResult): string {
  return [
    `Gate metadata ${result.action}`,
    `gate ${result.metadata.gateKey}`,
    `run ${result.metadata.runKey}`,
    `task ${result.metadata.taskKey}`,
    `ask ${result.metadata.askMessageId}`,
  ].join('\n');
}

/** `gate-register --input` production ingress: one read-only Orca query and one local store write. */
export async function runGateRegisterCommand(
  parsed: RunArgs,
  orca?: OrcaRunner,
): Promise<number> {
  if (parsed.command !== 'gate-register' || parsed.inputPath === null) {
    process.stderr.write('gate-register는 --input <JSON 파일 경로>가 필수다\n');
    return 2;
  }
  const orcaBin = parsed.orcaBin ?? process.env['ORCA_BIN'] ?? 'orca';
  let store: SqliteDigestStore | null = null;
  try {
    const document = await readGateRegistrationDocument(parsed.inputPath);
    const candidate = await validateGateRegistrationIdentity(
      orca ?? new OrcaCli(orcaBin),
      document,
    );
    store = new SqliteDigestStore(resolveStatePath(parsed.statePath));
    const result = persistGateMetadata(store, candidate);
    process.stdout.write(
      (parsed.json ? JSON.stringify(result, null, 2) : formatGateRegistration(result)) + '\n',
    );
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  } finally {
    store?.close();
  }
}

async function runDigestCommand(parsed: RunArgs, config: BridgeConfig): Promise<number> {
  if (config.slack === null) {
    process.stderr.write('digest는 설정의 slack 섹션이 필요하다. 게시 채널은 설정에서만 읽는다\n');
    return 2;
  }
  const channel = config.slack.channels.prDigest;
  const orcaBin = parsed.orcaBin ?? process.env['ORCA_BIN'] ?? 'orca';
  const store = openDigestStore(resolveStatePath(parsed.statePath), parsed.dryRun);
  try {
    const { MemorySummaryCache } = await import('./summarize/result.js');
    const report = await runDigest(new OrcaCli(orcaBin), new GhCli(), {
      config,
      channel,
      store,
      // 루트와 thread write 경계. dry-run이면 둘 다 null이다.
      ...digestPosters(parsed.dryRun, process.env),
      provider: await summaryProvider(process.env),
      cache: new MemorySummaryCache(),
      prLimit: parsed.prLimit,
      onlyPr: parsed.pr,
      now: () => new Date(),
    });
    process.stdout.write(
      (parsed.json ? JSON.stringify(report, null, 2) : formatReport(report)) + '\n',
    );
    return 0;
  } catch (e) {
    // main의 최상위 handler로 올리지 않는다. 그쪽은 채널 ID를 지울 근거를 갖고 있지 않다.
    process.stderr.write(formatChannelError(e, channel) + '\n');
    return 1;
  } finally {
    store.close();
  }
}

export type ChannelMcpRuntime = ChannelNotificationWriter & {
  connectStdio(input?: Readable, output?: Writable): Promise<void>;
  waitClosed(): Promise<void>;
  close(): Promise<void>;
};

export type ChannelAdapterRuntime = {
  start(): void;
  stop(): Promise<void>;
  reportReceipt(gateId: string): Promise<'accepted' | 'duplicate'>;
};

export type ChannelAdapterCommandDependencies = {
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly createMcp?: (receipt: ChannelReceiptHandler) => ChannelMcpRuntime;
  readonly createAdapter?: (
    identity: ChannelAdapterIdentity,
    notificationWriter: ChannelNotificationWriter,
  ) => ChannelAdapterRuntime;
  readonly waitForStop?: (mcpClosed: Promise<void>, input: Readable) => Promise<void>;
  /** Bounds each Adapter and MCP cleanup phase; production defaults to two seconds. */
  readonly shutdownTimeoutMs?: number;
};

async function settleAdapterCleanup(operation: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = Promise.resolve(operation).then(
    () => undefined,
    () => undefined,
  );
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  await Promise.race([settled, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  void settled;
}

function waitForAdapterStop(mcpClosed: Promise<void>, input: Readable): Promise<void> {
  if (input.destroyed || input.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const stop = (): void => {
      if (settled) return;
      settled = true;
      input.off('end', stop);
      input.off('close', stop);
      input.off('error', stop);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    };
    input.once('end', stop);
    input.once('close', stop);
    input.once('error', stop);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    void mcpClosed.then(stop, stop);
  });
}

/** Production stdio Adapter path. It does not load Bridge config or read Slack credentials. */
export async function runChannelAdapterCommand(
  parsed: RunArgs,
  dependencies: ChannelAdapterCommandDependencies = {},
): Promise<number> {
  if (parsed.command !== 'channel-adapter') {
    process.stderr.write('channel_adapter_wrong_command\n');
    return 2;
  }
  let adapter: ChannelAdapterRuntime | null = null;
  let mcp: ChannelMcpRuntime | null = null;
  const configuredShutdownTimeout = dependencies.shutdownTimeoutMs ?? 2_000;
  if (!Number.isFinite(configuredShutdownTimeout) || configuredShutdownTimeout < 10) {
    process.stderr.write('channel_adapter_failed\n');
    return 1;
  }
  const shutdownTimeoutMs = Math.trunc(configuredShutdownTimeout);
  try {
    const identity = channelAdapterIdentityFromEnv(dependencies.env ?? process.env);
    const receipt: ChannelReceiptHandler = async (gateId) => {
      if (adapter === null) throw new Error('adapter_not_ready');
      return await adapter.reportReceipt(gateId);
    };
    mcp = dependencies.createMcp?.(receipt) ?? new ChannelMcpServer({ receipt });
    adapter = dependencies.createAdapter?.(identity, mcp) ?? new ChannelAdapterClient({
      identity,
      notificationWriter: mcp,
    });
    const input = dependencies.input ?? process.stdin;
    await mcp.connectStdio(input, dependencies.output ?? process.stdout);
    adapter.start();
    await (dependencies.waitForStop ?? waitForAdapterStop)(mcp.waitClosed(), input);
    return 0;
  } catch {
    // stdout is reserved for MCP frames; stderr gets one code and never a frame/claim/env value.
    process.stderr.write('channel_adapter_failed\n');
    return 1;
  } finally {
    if (adapter !== null) {
      await settleAdapterCleanup(Promise.resolve().then(() => adapter!.stop()), shutdownTimeoutMs);
    }
    if (mcp !== null) {
      await settleAdapterCleanup(Promise.resolve().then(() => mcp!.close()), shutdownTimeoutMs);
    }
  }
}

export type ChannelDaemonServer = {
  start(): Promise<void>;
  /** Retains fixed-pipe ownership while rejecting/retiring all sessions and delivery work. */
  quiesce?(): void;
  stop(): Promise<void>;
  /** Resolves on an unexpected post-listen ownership failure. */
  waitForFailure?(): Promise<ChannelPipeErrorCode>;
  deliverGate(
    runId: string,
    gateId: string,
    signal?: AbortSignal,
  ): Promise<ChannelDeliverySendResult>;
  setProductionDeliveryHandlers?(handlers: ChannelProductionDeliveryHandlers): void;
};

export type ChannelDeliveryRuntime = {
  reconcile(signal?: AbortSignal): Promise<void>;
  recordAttempted(
    event: ChannelProductionDeliveryEvent,
    commitFence?: ChannelProductionCommitFence,
  ): unknown;
  recordReceipted(
    event: ChannelProductionDeliveryEvent,
    commitFence?: ChannelProductionCommitFence,
  ): unknown;
};

export type DaemonDependencies = {
  readonly orca?: OrcaRunner;
  readonly gh?: GhRunner;
  readonly slack?: SlackPoster;
  readonly viewOpener?: SlackViewOpener;
  readonly connectionFactory?: SocketConnectionFactory;
  readonly socketTimeouts?: Partial<SocketTimeouts>;
  /** Production defaults to fifteen seconds and kills the real Orca subprocess at expiry. */
  readonly orcaTimeoutMs?: number;
  /** Bounds every post-ACK D2 Slack card update; production defaults to fifteen seconds. */
  readonly slackTimeoutMs?: number;
  /** Production defaults to five seconds; tests may shorten the durable retry cadence. */
  readonly reconcileIntervalMs?: number;
  readonly waitForStop?: () => Promise<void>;
  readonly channelServer?: ChannelDaemonServer;
  /** Test seam; production serves aggregate-only status from the daemon/store owner. */
  readonly statusOwnerServer?: OperationalStatusOwnerServerLike;
  /** Test seam for the cross-process daemon/closed-snapshot exclusion primitive. */
  readonly statusSnapshotLeaseStore?: OperationalStatusSnapshotLeaseStore;
  /** Test seam for proving the production lease precedes every writable store open. */
  readonly openStore?: (statePath: string) => SqliteDigestStore;
  readonly createChannelDelivery?: (
    store: GateStore,
    orca: OrcaRunner,
    transport: ChannelDaemonServer,
  ) => ChannelDeliveryRuntime;
  /** Test seam; production creates the O1-4 bounded NDJSON logger. */
  readonly telemetry?: OperationalTelemetrySink;
  readonly observerClock?: ObserverClock;
  readonly observerDrainTimeoutMs?: number;
  readonly digestStartupDelayMs?: number;
  readonly buildIdentity?: string;
  readonly installationSeed?: string;
};

type ProcessStopLatch = {
  readonly promise: Promise<void>;
  dispose(): void;
};

function processStop(): ProcessStopLatch {
  let dispose = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    let settled = false;
    const stop = (): void => {
      if (settled) return;
      settled = true;
      dispose();
      resolve();
    };
    dispose = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return { promise, dispose: () => dispose() };
}

function parsedDaemonConfig(config: BridgeConfig): ParsedBridgeConfig {
  return {
    ...config,
    // Parsed production configs always carry automation. Missing means a legacy hand-built caller
    // (including the D2/D3 regression fixtures), for which silently starting new jobs is unsafe.
    automation: config.automation ?? { ...DEFAULT_AUTOMATION_CONFIG, enabled: false },
  };
}

function scopedOrcaRunner(runner: OrcaRunner, signal: AbortSignal): OrcaRunner {
  return {
    run: (args, options = {}) => runner.run(args, {
      signal: options.signal === undefined
        ? signal
        : AbortSignal.any([signal, options.signal]),
    }),
  };
}

function digestBridgeConfig(effective: EffectiveBridgeConfig): BridgeConfig {
  return {
    ...effective.base,
    projects: effective.projects.map((project) => ({
      name: project.name,
      repositories: project.repositories.map((repository) => repository.nameWithOwner),
      orcaRepositoryIds: project.orcaRepositoryIds,
    })),
  };
}

export function fairDigestCycle(
  effective: EffectiveBridgeConfig,
  checkpoint: number,
): {
  readonly repositories: readonly string[];
  readonly checkpoint: number;
  readonly deferred: number;
  readonly prLimit: number;
} {
  const perRepository = effective.base.automation.prDigest.prLimit;
  const globalBudget = effective.base.automation.prDigest.globalPrBudget;
  const prLimit = Math.min(perRepository, globalBudget);
  const automation = effective.base.automation;
  const unique = [...new Map(effective.projects
    .flatMap((project) => project.repositories)
    .map((repository) => [repository.canonicalKey, repository.nameWithOwner])).entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([, nameWithOwner]) => nameWithOwner);
  if (effective.routing.status === 'blocked') {
    return {
      repositories: [], checkpoint, deferred: unique.length * perRepository, prLimit,
    };
  }
  if (unique.length === 0) {
    return { repositories: [], checkpoint: 0, deferred: 0, prLimit };
  }
  const repositoryBudget = Math.max(1,
    Math.floor(automation.prDigest.globalPrBudget / prLimit));
  const count = Math.min(unique.length, repositoryBudget);
  const start = checkpoint % unique.length;
  const selected = Array.from({ length: count }, (_unused, offset) =>
    unique[(start + offset) % unique.length]!);
  return {
    repositories: selected,
    checkpoint: (start + count) % unique.length,
    deferred: (unique.length - count) * perRepository + count * (perRepository - prLimit),
    prLimit,
  };
}

function discoveryFailureCode(failure: string | undefined): OperationalFailureCode {
  switch (failure) {
    case 'schema_drift': return 'discovery.schema_drift';
    case 'capacity_conflict': return 'discovery.capacity_conflict';
    case 'config_drift': return 'config.drift';
    case 'github_unavailable': return 'discovery.github_unavailable';
    case 'query_failed': return 'discovery.query_failed';
    case 'store_failed': return 'schema.drift';
    default: return 'validation.failed';
  }
}

function observerInvariantError(error: unknown): boolean {
  return error instanceof OperationalStoreError || error instanceof SchemaVersionError ||
    error instanceof RunCollectionContractError || error instanceof TypeError ||
    error instanceof SyntaxError || error instanceof RangeError;
}

/** Production D2+D3 path: strict v12 startup → delivery/resume reconcile → existing-card projection. */
export async function runDaemonCommand(
  parsed: RunArgs,
  config: BridgeConfig,
  dependencies: DaemonDependencies = {},
): Promise<number> {
  if (parsed.command !== 'daemon' || config.slack === null) {
    process.stderr.write('daemon은 설정의 slack 섹션이 필요하다\n');
    return 2;
  }
  const token = appToken(process.env);
  if (token === undefined || !token.startsWith('xapp-')) {
    process.stderr.write('daemon은 ORCA_SLACK_BRIDGE_APP_TOKEN xapp token이 필요하다\n');
    return 2;
  }
  const daemonConfig = parsedDaemonConfig(config);
  const automation = daemonConfig.automation;
  const observerClock = dependencies.observerClock ?? SYSTEM_OBSERVER_CLOCK;
  const processStopLatch = dependencies.waitForStop === undefined ? processStop() : null;
  let store: SqliteDigestStore | null = null;
  let transport: SlackSocketTransport | null = null;
  let channelServer: ChannelDaemonServer | null = null;
  let statusOwnerServer: OperationalStatusOwnerServerLike | null = null;
  let statusSnapshotLease: OperationalStatusSnapshotLease | null = null;
  let writableStoreOpenAttempted = false;
  let failureReported = false;
  let channelDelivery: ChannelDeliveryRuntime | null = null;
  let observerSupervisor: ObserverSupervisor | null = null;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let telemetry: OperationalTelemetrySink | null = null;
  let ownsTelemetry = false;
  let health: OperationalHealthTelemetry | null = null;
  const instanceId = `daemon-${process.pid}-${randomUUID()}`;
  let daemonHealthStarted = false;
  let observerDrainTimedOut = false;
  let fatalOperationalFailure = false;
  let commandFailed = false;
  let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  let gateReconciliation: Promise<void> | null = null;
  let deliveryReconciliation: Promise<void> | null = null;
  const pending = new Set<Promise<void>>();
  const inbound = new Set<Promise<void>>();
  const inboundAbort = new AbortController();
  const reconciliationAbort = new AbortController();
  const acceptedWorkAbort = new AbortController();
  let stopReason: 'requested' | 'pipe_failure' | null = null;
  let resolveStop!: () => void;
  const stopRequested = new Promise<void>((resolve) => { resolveStop = resolve; });
  const requestStop = (reason: 'requested' | 'pipe_failure'): void => {
    if (stopReason !== null) return;
    stopReason = reason;
    reconciliationAbort.abort();
    resolveStop();
  };
  const reportFailure = (): void => {
    if (failureReported) return;
    failureReported = true;
    process.stderr.write('daemon이 strict startup 또는 Gate reconciliation에 실패했다\n');
  };
  if (processStopLatch !== null) {
    void processStopLatch.promise.then(() => requestStop('requested'));
  }
  let acceptingInbound = false;
  const drainAcceptedWork = async (): Promise<void> => {
    const settle = async (
      work: readonly Promise<void>[],
      onTimeout: () => void,
    ): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timed = new Promise<false>((resolve) => {
        timer = setTimeout(() => { onTimeout(); resolve(false); }, 20_000);
        timer.unref?.();
      });
      const drained = await Promise.race([Promise.allSettled(work).then(() => true), timed]);
      if (timer !== undefined) clearTimeout(timer);
      return drained;
    };
    // First let every already-accepted envelope finish ACK/CAS and enqueue its post-ACK work.
    // Only then snapshot the durable work set; taking both snapshots together loses that handoff.
    if (!await settle([...inbound], () => inboundAbort.abort())) {
      observerDrainTimedOut = true;
      acceptedWorkAbort.abort();
      return;
    }
    inboundAbort.abort();
    if (!await settle([...pending], () => acceptedWorkAbort.abort())) {
      observerDrainTimedOut = true;
    }
    acceptedWorkAbort.abort();
  };
  const stopObserverWork = async (): Promise<void> => {
    if (heartbeatTimer !== null) {
      observerClock.clearTimer(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (observerSupervisor !== null) {
      const drained = await observerSupervisor.stop(dependencies.observerDrainTimeoutMs ?? 20_000);
      if (!drained) observerDrainTimedOut = true;
      observerSupervisor = null;
    }
  };
  try {
    const resolvedStatePath = resolveStatePath(parsed.statePath);
    const statusCapabilityPath = operationalStatusCapabilityPath(resolvedStatePath);
    const nativeStatusStore = dependencies.statusSnapshotLeaseStore === undefined
      ? new CurrentUserOperationalStatusCapabilityStore()
      : null;
    const statusSnapshotLeaseStore = dependencies.statusSnapshotLeaseStore ?? nativeStatusStore!;
    statusSnapshotLease = await statusSnapshotLeaseStore.tryAcquireSnapshotLease(
      statusCapabilityPath,
      operationalStatusStateIdentity(resolvedStatePath),
    );
    if (statusSnapshotLease === null) throw new Error('status.snapshot_lease_failed');
    statusSnapshotLease.assertHeld();
    writableStoreOpenAttempted = true;
    store = (dependencies.openStore ?? ((path) => new SqliteDigestStore(path)))(resolvedStatePath);
    const daemonStore = store;
    statusOwnerServer = dependencies.statusOwnerServer ?? new OperationalStatusOwnerServer({
      statePath: resolvedStatePath,
      store,
      capabilityPath: statusCapabilityPath,
      ...(nativeStatusStore === null ? {} : { capabilityStore: nativeStatusStore }),
      // A refresh that keeps failing leaves `status` permanently unavailable while every other
      // subsystem stays healthy. Report it on a bounded cadence so the operator sees it (DL-031).
      onRefreshFailure: (consecutiveFailures) => {
        if (telemetry === null) return;
        if (consecutiveFailures !== 1 && consecutiveFailures !== 10 &&
            consecutiveFailures !== 60 && consecutiveFailures % 300 !== 0) return;
        void telemetry.log({
          level: 'warn',
          event: 'status.owner_degraded',
          outcome: 'degraded',
          errorCode: 'status.owner_refresh_failed',
          retryable: true,
          attempt: consecutiveFailures,
        }).catch(() => { /* reporting never breaks the owner */ });
      },
    });
    await statusOwnerServer.start();
    statusSnapshotLease.assertHeld();
    const configuredOrcaTimeout = dependencies.orcaTimeoutMs ?? 15_000;
    if (!Number.isFinite(configuredOrcaTimeout) || configuredOrcaTimeout < 10) {
      throw new TypeError('orcaTimeoutMs must be a finite number >= 10');
    }
    const orcaTimeoutMs = Math.trunc(configuredOrcaTimeout);
    const rawOrca = dependencies.orca ?? new OrcaCli(
      parsed.orcaBin ?? process.env['ORCA_BIN'] ?? 'orca',
      { timeoutMs: orcaTimeoutMs },
    );
    const orca = boundedOrcaRunner(rawOrca, orcaTimeoutMs);
    const productionBotToken = dependencies.slack === undefined || dependencies.viewOpener === undefined
      ? (dependencies.slack === undefined ? botToken(process.env) : null)
      : null;
    const slack = dependencies.slack ?? new SlackWebApiPoster({ token: productionBotToken! });
    const threadPoster = typeof (slack as Partial<ThreadPoster>).reply === 'function'
      ? slack as SlackPoster & ThreadPoster
      : null;
    const viewOpener = dependencies.viewOpener ?? (
      productionBotToken === null
        ? { open: () => Promise.reject(new Error('Slack modal opener is not injected')) }
        : new SlackWebApiViewOpener({ token: productionBotToken })
    );
    const engine = new GateResolutionEngine({
      store,
      orca,
      slack,
      ...(dependencies.slackTimeoutMs === undefined
        ? {}
        : { slackTimeoutMs: dependencies.slackTimeoutMs }),
    });
    const daemonEngine: Pick<GateResolutionEngine, 'resolveAndProject'> = {
      resolveAndProject: (gateKey) => engine.resolveAndProject(gateKey, acceptedWorkAbort.signal),
    };
    const schedule = (job: () => Promise<void>): void => {
      if (acceptedWorkAbort.signal.aborted) return;
      const task = job().catch(() => undefined).finally(() => pending.delete(task));
      pending.add(task);
    };
    const handler = new GateActionHandler({
      config: config.slack,
      store,
      engine: daemonEngine,
      schedule,
      abortSignal: inboundAbort.signal,
    });
    const directHandler = new GateDirectInputHandler({
      config: config.slack,
      store,
      opener: viewOpener,
      engine: daemonEngine,
      schedule,
      abortSignal: inboundAbort.signal,
    });

    // Acquire the single fixed pipe before recovery or Slack ingress. A second daemon fails closed
    // here and cannot become either the Channel owner or an interactive consumer.
    channelServer = dependencies.channelServer ?? new ChannelPipeServer({ orca });
    channelDelivery = dependencies.createChannelDelivery?.(store, orca, channelServer) ??
      new GateChannelDeliveryEngine({
        store,
        orca,
        transport: channelServer,
        // The Channel round trip was the one production path with no operational trace at all.
        // Without these the daemon reports every job `succeeded` while a coordinator silently
        // never wakes, which is exactly the failure shape DL-031 forbids.
        // `route_*` means no coordinator session could be reached; everything else is the delivery
        // machinery itself failing. An operator needs those two apart — the first is "boot a
        // coordinator", the second is "something is broken". The raw code carries an unbounded
        // suffix, so only these two fixed codes are persisted.
        onError: (code) => {
          void health?.event({
            level: 'warn',
            event: 'channel.delivery',
            outcome: 'failed',
            errorCode: code.startsWith('route_')
              ? 'channel.route_unavailable'
              : 'channel.delivery_failed',
            retryable: true,
          }).catch(() => { /* reporting never fences delivery */ });
        },
        onTransition: (state, gateKey) => {
          void health?.event({
            level: 'info',
            event: 'channel.delivery',
            outcome: state === 'attempted' ? 'started' : state === 'receipted' ? 'running' : 'succeeded',
            entityIdentity: entityIdentity(gateKey),
          }).catch(() => { /* reporting never fences delivery */ });
        },
      });
    channelServer.setProductionDeliveryHandlers?.({
      attempted: (event: ChannelProductionDeliveryEvent, commitFence) => {
        channelDelivery?.recordAttempted(event, commitFence);
      },
      receipted: (event: ChannelProductionDeliveryEvent, commitFence) => {
        channelDelivery?.recordReceipted(event, commitFence);
      },
    });
    if (reconciliationAbort.signal.aborted) return stopReason === 'pipe_failure' ? 1 : 0;
    // A production signal suppresses Node's default termination, so a pending pipe startup must
    // itself lose to the stop latch. Normalize both branches now so a late rejected start remains
    // observed after shutdown has already continued through the single `finally` owner.
    const channelStarting = channelServer.start().then(
      () => 'started' as const,
      () => 'failed' as const,
    );
    const channelStartOutcome = await Promise.race([
      channelStarting,
      stopRequested.then(() => 'stopped' as const),
    ]);
    if (channelStartOutcome === 'stopped') {
      return stopReason === 'pipe_failure' ? 1 : 0;
    }
    if (channelStartOutcome === 'failed') throw new Error('pipe_start_failed');
    if (reconciliationAbort.signal.aborted) return stopReason === 'pipe_failure' ? 1 : 0;
    const pipeFailure = channelServer.waitForFailure?.();
    if (pipeFailure !== undefined) {
      void pipeFailure.then(
        () => requestStop('pipe_failure'),
        () => requestStop('pipe_failure'),
      );
    }

    const previousHealth = store.readDaemonHealth();
    const configFingerprint = fingerprintOperationalConfig(daemonConfig);
    const discoveryConfigFingerprint = bridgeConfigFingerprint(daemonConfig);
    const buildIdentity = dependencies.buildIdentity ??
      process.env['ORCA_SLACK_BRIDGE_BUILD'] ?? 'development';
    const buildFingerprint = fingerprintOperationalBuild(buildIdentity);
    if (dependencies.telemetry !== undefined) {
      telemetry = dependencies.telemetry;
    } else {
      ownsTelemetry = true;
      telemetry = await OperationalNdjsonLogger.create({
        logDir: resolveOperationalLogDir(parsed.logDir),
        buildIdentity,
        maxFileMiB: automation.logging.maxFileMiB,
        backupCount: automation.logging.backupCount,
        clock: observerClock.wallNow,
        onFailure: (notice) => {
          if (!notice.fatal) return;
          fatalOperationalFailure = true;
          requestStop('requested');
        },
      });
    }
    health = new OperationalHealthTelemetry(store, telemetry, () => {
      try {
        statusOwnerServer?.refresh();
      } catch {
        // The store mutation is already committed. Keep the daemon alive and let the owner's
        // existing one-second refresh timer rebuild the fail-closed status cache.
      }
    });
    await health.daemonStarted({
      instanceId,
      buildFingerprint,
      configFingerprint,
      at: observerClock.wallNow().toISOString(),
    });
    daemonHealthStarted = true;
    if (fatalOperationalFailure) throw new Error('logger_fatal');

    // No Slack Socket event can race schema validation or startup recovery.
    await engine.reconcile(reconciliationAbort.signal);
    await channelDelivery.reconcile(reconciliationAbort.signal);
    const recoveredRoots = store.recoverSlackRootIntents(
      instanceId,
      observerClock.wallNow().toISOString(),
    );
    statusOwnerServer.refresh();
    if (recoveredRoots > 0) {
      await health.event({
        level: 'warn', event: 'root_intent.changed', outcome: 'uncertain',
        counts: { uncertain: recoveredRoots },
      });
    }
    for (const name of [
      'repository-discovery', 'run-observer', 'pr-digest',
    ] as const satisfies readonly ObserverJobName[]) {
      const orphan = store.findDaemonJobOutcome(name);
      if (orphan?.state !== 'running') continue;
      store.completeDaemonJobFailure({
        claim: { jobName: name, revision: orphan.revision, startedAt: orphan.startedAt },
        at: observerClock.wallNow().toISOString(),
        durationMs: orphan.durationMs ?? 0,
        errorCode: 'scheduler.aborted',
        processedCount: orphan.processedCount,
        deferredCount: orphan.deferredCount,
        checkpoint: orphan.checkpoint,
      });
      statusOwnerServer.refresh();
    }
    if (store.readDaemonHealth()?.desiredState === 'stopped') requestStop('requested');
    if (reconciliationAbort.signal.aborted) return stopReason === 'pipe_failure' ? 1 : 0;

    const configuredInterval = dependencies.reconcileIntervalMs ?? 5_000;
    if (!Number.isFinite(configuredInterval) || configuredInterval < 10) {
      throw new TypeError('reconcileIntervalMs must be a finite number >= 10');
    }
    const scheduleReconciliation = (): void => {
      if (reconciliationAbort.signal.aborted) return;
      if (gateReconciliation === null) {
        // D2 dedupes by Gate. Periodic and accepted handler calls therefore share the accepted-
        // work grace signal; the interval gate above prevents any new periodic work after stop.
        const gateWork = engine.reconcile(acceptedWorkAbort.signal).catch(() => undefined);
        gateReconciliation = gateWork;
        pending.add(gateWork);
        void gateWork.finally(() => {
          pending.delete(gateWork);
          if (gateReconciliation === gateWork) gateReconciliation = null;
        });
      }
      if (deliveryReconciliation === null) {
        const deliveryWork = channelDelivery!.reconcile(reconciliationAbort.signal)
          .catch(() => undefined);
        deliveryReconciliation = deliveryWork;
        pending.add(deliveryWork);
        void deliveryWork.finally(() => {
          pending.delete(deliveryWork);
          if (deliveryReconciliation === deliveryWork) deliveryReconciliation = null;
        });
      }
    };
    // D2/D3 retain their independent five-second cadence while the bounded observer startup
    // discovery is running. They are deliberately outside the serial observer lane.
    reconciliationTimer = setInterval(
      scheduleReconciliation,
      Math.trunc(configuredInterval),
    );
    reconciliationTimer.unref?.();

    const heartbeatMilliseconds = automation.health.heartbeatSeconds * 1_000;
    const armHeartbeat = (): void => {
      if (stopReason !== null || health === null) return;
      heartbeatTimer = observerClock.setTimer(() => {
        heartbeatTimer = null;
        void health!.daemonHeartbeat(instanceId, observerClock.wallNow().toISOString())
          .then((record) => {
            if (record === null) {
              fatalOperationalFailure = true;
              requestStop('requested');
              return;
            }
            if (record.desiredState === 'stopped') requestStop('requested');
            else armHeartbeat();
          })
          .catch(() => {
            fatalOperationalFailure = true;
            requestStop('requested');
          });
      }, heartbeatMilliseconds);
      heartbeatTimer.unref?.();
    };
    armHeartbeat();

    if (automation.enabled) {
      const lkgCompatible = previousHealth?.configFingerprint === configFingerprint;
      let lkgProof: string | null = lkgCompatible ? discoveryConfigFingerprint : null;
      let effectiveConfig = buildEffectiveBridgeConfig(
        daemonConfig,
        lkgCompatible
          ? store.readEffectiveDiscoverySnapshot()
          : { repositories: [], bindings: [], issues: [] },
        { configFingerprint: discoveryConfigFingerprint },
      );
      const backgroundGithub = new BackgroundGithub(
        dependencies.gh ?? new GhCli(),
        {
          commandBudgetPerHour: automation.github.commandBudgetPerHour,
          rateLimitFloor: automation.github.rateLimitFloor,
          nowMs: observerClock.monotonicMs,
        },
      );
      const claims = new Map<ObserverJobName, DaemonJobClaim>();
      const rootRuntime = (signal: AbortSignal): SlackRootIntentRuntime => ({
        instanceId,
        telemetry: telemetry!,
        signal,
        timeoutMs: dependencies.slackTimeoutMs ?? 15_000,
      });
      const observerJobs = [
        {
          name: 'repository-discovery' as const,
          intervalMs: automation.repositoryDiscovery.intervalSeconds * 1_000,
          timeoutMs: automation.repositoryDiscovery.timeoutSeconds * 1_000,
          backoffCapMs: 5 * 60_000,
          run: async (signal: AbortSignal) => {
            try {
              const result = await runRepositoryDiscoveryPass({
                orca: scopedOrcaRunner(orca, signal),
                github: repositoryIdentityConfirmer(backgroundGithub.scoped(signal)),
                store: daemonStore,
                config: daemonConfig,
                configFingerprint: discoveryConfigFingerprint,
                lastKnownGoodConfigFingerprint: lkgProof,
                signal,
                deadlineAt: observerClock.wallNow().getTime() +
                  automation.repositoryDiscovery.timeoutSeconds * 1_000,
                now: observerClock.wallNow,
              });
              effectiveConfig = result.effectiveConfig;
              const counts = {
                processedCount: result.counts.effectiveBindings,
                deferredCount: result.counts.deferredRepositories + result.counts.blockedBindings,
              };
              if (result.status === 'failed') {
                throw new ObserverJobFailure(
                  discoveryFailureCode(result.failure),
                  counts,
                  result.failure === 'schema_drift' || result.failure === 'config_drift' ||
                    result.failure === 'store_failed',
                );
              }
              lkgProof = discoveryConfigFingerprint;
              await health!.event({
                level: 'info', event: 'discovery.completed', outcome: 'succeeded',
                counts: {
                  processed: result.counts.effectiveBindings,
                  deferred: result.counts.deferredRepositories,
                },
              });
              return counts;
            } catch (error) {
              if (error instanceof ObserverJobFailure) throw error;
              if (observerInvariantError(error)) {
                throw new ObserverJobFailure('schema.drift', {}, true);
              }
              throw new ObserverJobFailure(
                signal.aborted ? 'scheduler.timeout' : 'discovery.query_failed',
              );
            }
          },
        },
        {
          name: 'run-observer' as const,
          intervalMs: automation.runObserver.intervalSeconds * 1_000,
          timeoutMs: automation.runObserver.timeoutSeconds * 1_000,
          backoffCapMs: 15 * 60_000,
          run: async (signal: AbortSignal) => {
            try {
              const report = await runRunObserver(scopedOrcaRunner(orca, signal), {
                config: effectiveConfig,
                channel: config.slack!.channels.agentRuns,
                store: daemonStore,
                slack,
                thread: threadPoster,
                now: observerClock.wallNow,
                rootIntent: rootRuntime(signal),
                signal,
                ...(dependencies.slackTimeoutMs === undefined
                  ? {}
                  : { slackTimeoutMs: dependencies.slackTimeoutMs }),
              });
              return {
                processedCount: report.published.runs.length + 1,
                deferredCount: report.facts.unregistered.count,
              };
            } catch (error) {
              if (error instanceof ObserverJobFailure) throw error;
              if (observerInvariantError(error)) {
                throw new ObserverJobFailure('run.schema_drift', {}, true);
              }
              throw new ObserverJobFailure(
                signal.aborted ? 'run.timeout' : 'run.query_failed',
              );
            }
          },
        },
        {
          /*
           * Durable Gate outbox sweep.
           *
           * The Slack action path already resolves in real time through `GateActionHandler`. What
           * had no owner was the interrupted case: an action whose Orca mutation died mid-flight
           * leaves a durable intent, and without a recurring pass nothing ever retries it. The owner
           * sees a pressed button and no resolution, with no signal that anything is wrong.
           *
           * `reconcile` is already serialized per Gate and carries its own bounded deadline, so this
           * job only supplies the cadence.
           */
          name: 'gate-reconcile' as const,
          intervalMs: automation.gateReconcile.intervalSeconds * 1_000,
          timeoutMs: automation.gateReconcile.timeoutSeconds * 1_000,
          backoffCapMs: 10 * 60_000,
          run: async (signal: AbortSignal) => {
            try {
              await engine.reconcile(signal);
              return {};
            } catch (error) {
              if (error instanceof ObserverJobFailure) throw error;
              throw new ObserverJobFailure(
                signal.aborted ? 'scheduler.timeout' : 'gate.reconcile_failed',
              );
            }
          },
        },
        {
          name: 'pr-digest' as const,
          intervalMs: automation.prDigest.intervalSeconds * 1_000,
          timeoutMs: automation.prDigest.timeoutSeconds * 1_000,
          backoffCapMs: 2 * 60 * 60_000,
          run: async (signal: AbortSignal) => {
            let progress: { readonly deferredCount?: number; readonly checkpoint?: number } = {};
            try {
              const priorCheckpoint = daemonStore.findDaemonJobOutcome('pr-digest')?.checkpoint ?? 0;
              const cycle = fairDigestCycle(effectiveConfig, priorCheckpoint);
              progress = { deferredCount: cycle.deferred, checkpoint: cycle.checkpoint };
              if (effectiveConfig.routing.status === 'blocked') {
                const invariant = effectiveConfig.routing.reason !== 'capacity_conflict';
                throw new ObserverJobFailure(
                  invariant ? 'config.drift' : 'digest.capacity_deferred',
                  progress,
                  invariant,
                );
              }
              const report = await runDigest(
                scopedOrcaRunner(orca, signal),
                backgroundGithub.scoped(signal),
                {
                  config: digestBridgeConfig(effectiveConfig),
                  channel: config.slack!.channels.prDigest,
                  store: daemonStore,
                  slack,
                  thread: threadPoster,
                  summaryMode: 'facts_only',
                  prLimit: cycle.prLimit,
                  onlyPr: null,
                  now: observerClock.wallNow,
                  repositories: cycle.repositories,
                  isolateRepositoryFailures: true,
                  rootIntent: rootRuntime(signal),
                  signal,
                  ...(dependencies.slackTimeoutMs === undefined
                    ? {}
                    : { slackTimeoutMs: dependencies.slackTimeoutMs }),
                },
              );
              const failures = report.repositoryFailures ?? [];
              const deferredCount = cycle.deferred + failures.length * cycle.prLimit;
              const result = {
                processedCount: report.results.length,
                deferredCount,
                checkpoint: cycle.checkpoint,
              };
              if (failures.length > 0) {
                const code: OperationalFailureCode = failures.some((row) =>
                  row.reason === 'deadline_deferred')
                  ? 'digest.timeout'
                  : failures.some((row) => row.reason === 'budget_deferred')
                    ? 'digest.capacity_deferred'
                    : 'digest.github_unavailable';
                throw new ObserverJobFailure(code, result);
              }
              return result;
            } catch (error) {
              if (error instanceof ObserverJobFailure) throw error;
              if (observerInvariantError(error)) {
                throw new ObserverJobFailure('schema.drift', progress, true);
              }
              throw new ObserverJobFailure(
                signal.aborted ? 'digest.timeout' : 'digest.query_failed',
                progress,
              );
            }
          },
        },
      ] as const;
      const startupClaims = new Set<ObserverJobName>([
        'repository-discovery', 'run-observer', 'pr-digest',
      ]);
      observerSupervisor = new ObserverSupervisor({
        installationSeed: dependencies.installationSeed ?? resolvedStatePath,
        jitterRatio: automation.scheduler.jitterRatio,
        jobs: observerJobs,
        clock: observerClock,
        initialState: Object.fromEntries([
          'repository-discovery', 'run-observer', 'gate-reconcile', 'pr-digest',
        ].map((name) => {
          const prior = daemonStore.findDaemonJobOutcome(name as ObserverJobName);
          return [name, {
            consecutiveFailures: prior?.consecutiveFailures ?? 0,
            executionBucket: prior?.attempt ?? 0,
          }];
        })),
        onStarted: async (name, at) => {
          const claim = await health!.jobStarted(name, at, {
            startupTakeover: startupClaims.delete(name),
          });
          if (claim === null) throw new Error('daemon_job_claim_rejected');
          claims.set(name, claim);
        },
        onCompleted: async (completion: ObserverCompletion) => {
          const claim = claims.get(completion.name);
          claims.delete(completion.name);
          if (claim === undefined) return;
          const at = observerClock.wallNow().toISOString();
          const common = {
            claim,
            at,
            durationMs: completion.durationMs,
            ...(completion.processedCount === undefined
              ? {}
              : { processedCount: completion.processedCount }),
            ...(completion.deferredCount === undefined
              ? {}
              : { deferredCount: completion.deferredCount }),
            ...(completion.checkpoint === undefined
              ? {}
              : { checkpoint: completion.checkpoint }),
          };
          if (completion.status === 'succeeded') {
            if (await health!.jobSucceeded({ ...common, nextRunAt: completion.nextRunAt }) === null) {
              throw new Error('daemon_job_success_rejected');
            }
            return;
          }
          const failed = await health!.jobFailed({
            ...common,
            errorCode: completion.errorCode ?? 'validation.failed',
          }, completion.retryable);
          if (failed === null) throw new Error('daemon_job_failure_rejected');
          if (!completion.retryable) return;
          if (await health!.jobBackoff(
            completion.name,
            failed.revision,
            completion.nextRunAt,
            at,
          ) === null) {
            throw new Error('daemon_job_backoff_rejected');
          }
        },
        onFatal: () => {
          fatalOperationalFailure = true;
          requestStop('requested');
        },
      });
      await observerSupervisor.runStartupDiscovery();
      if (fatalOperationalFailure) throw new Error('observer_supervisor_fatal');
    }
    if (reconciliationAbort.signal.aborted) return stopReason === 'pipe_failure' ? 1 : 0;
    transport = new SlackSocketTransport({
      ...(config.slack.apiAppId === undefined ? {} : { expectedApiAppId: config.slack.apiAppId }),
      connectionFactory: dependencies.connectionFactory ?? slackSdkConnectionFactory(token),
      ...(dependencies.socketTimeouts === undefined ? {} : { timeouts: dependencies.socketTimeouts }),
      event: (event) => {
        // A connection may invoke a retained callback while its bounded close is still draining.
        // Leave that envelope unACKed for Slack redelivery instead of starting work after stop.
        if (!acceptingInbound) return Promise.resolve();
        const consumer = isGateDirectInputEvent(event) ? directHandler : handler;
        const task = consumer.handle(event).then(() => undefined).finally(() => inbound.delete(task));
        inbound.add(task);
        return task;
      },
    });
    acceptingInbound = true;
    const starting = transport.start().then(
      () => 'started' as const,
      () => 'failed' as const,
    );
    const startupOutcome = await Promise.race([
      starting,
      stopRequested.then(() => 'stopped' as const),
    ]);
    if (startupOutcome === 'stopped') {
      acceptingInbound = false;
      if (reconciliationTimer !== null) clearInterval(reconciliationTimer);
      reconciliationTimer = null;
      reconciliationAbort.abort();
      channelServer.quiesce?.();
      await stopObserverWork();
      await transport.shutdown();
      await starting;
      transport = null;
      await drainAcceptedWork();
      await channelServer.stop();
      channelServer = null;
      return stopReason === 'pipe_failure' || observerDrainTimedOut || fatalOperationalFailure ? 1 : 0;
    }
    if (startupOutcome === 'failed') throw new Error('socket_start_failed');
    observerSupervisor?.startAfterSocket(dependencies.digestStartupDelayMs ?? 60_000);

    if (dependencies.waitForStop !== undefined) {
      const injectedStop = dependencies.waitForStop().then(
        () => 'requested' as const,
        () => 'failed' as const,
      );
      const waitOutcome = await Promise.race([
        injectedStop,
        stopRequested.then(() => 'stopped' as const),
      ]);
      if (waitOutcome === 'failed') throw new Error('daemon_stop_wait_failed');
      if (waitOutcome === 'requested') requestStop('requested');
    } else {
      await stopRequested;
    }
    acceptingInbound = false;
    if (reconciliationTimer !== null) clearInterval(reconciliationTimer);
    reconciliationTimer = null;
    reconciliationAbort.abort();
    channelServer.quiesce?.();
    await stopObserverWork();
    // Keep the fixed pipe bound until Socket ingress and all already-accepted work are quiescent.
    // A contender therefore remains failed closed throughout the entire external-work drain.
    await transport.shutdown();
    transport = null;
    await drainAcceptedWork();
    await channelServer.stop();
    channelServer = null;
    return stopReason === 'pipe_failure' || observerDrainTimedOut || fatalOperationalFailure ? 1 : 0;
  } catch {
    commandFailed = true;
    reportFailure();
    return 1;
  } finally {
    acceptingInbound = false;
    if (reconciliationTimer !== null) clearInterval(reconciliationTimer);
    reconciliationAbort.abort();
    channelServer?.quiesce?.();
    await stopObserverWork();
    if (transport !== null) {
      try {
        await transport.shutdown();
      } catch {
        // Shutdown failure cannot authorize a second daemon or a different external write.
      }
    }
    // The store and fixed pipe remain owned until both ACK/CAS handlers and already-ACKed jobs
    // settle, even when Socket close rejects or times out.
    await drainAcceptedWork();
    if (channelServer !== null) {
      try {
        await channelServer.stop();
      } catch {
        // Pipe shutdown failure cannot authorize a second daemon or a different external write.
      }
    }
    if (daemonHealthStarted && !commandFailed && !observerDrainTimedOut &&
        stopReason !== 'pipe_failure' && !fatalOperationalFailure && health !== null) {
      let cleanStopped = false;
      for (let attempt = 0; attempt < 4 && !cleanStopped; attempt += 1) {
        try {
          cleanStopped = await health.daemonCleanStopped(
            instanceId,
            observerClock.wallNow().toISOString(),
          ) !== null;
        } catch {
          if (attempt < 3) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
          }
        }
      }
      if (!cleanStopped) fatalOperationalFailure = true;
    }
    if (statusOwnerServer !== null) {
      try {
        await statusOwnerServer.stop();
      } catch {
        // The store remains the owner until the bounded local status listener has been retired.
      }
    }
    if (ownsTelemetry && telemetry !== null) {
      try {
        await telemetry.close();
      } catch {
        fatalOperationalFailure = true;
      }
    }
    let writableStoreClosureUncertain = writableStoreOpenAttempted && store === null;
    if (store !== null) {
      try {
        store.close();
      } catch {
        writableStoreClosureUncertain = true;
      }
    }
    if (!writableStoreClosureUncertain && statusSnapshotLease !== null) {
      try {
        statusSnapshotLease.assertHeld();
        await statusSnapshotLease.release();
      } catch {
        // A lost lease is already fail-closed; shutdown must not open another writer.
      }
      statusSnapshotLease = null;
    }
    processStopLatch?.dispose();
    if (writableStoreClosureUncertain || observerDrainTimedOut || fatalOperationalFailure) {
      // Do not release or discard the descriptor/mutex when the writable handle may still be live.
      // The CLI entrypoint exits nonzero immediately after this bounded static diagnostic.
      reportFailure();
      return 1;
    }
  }
}

export type CliMainDependencies = {
  readonly channelAdapter?: ChannelAdapterCommandDependencies;
  readonly daemon?: DaemonDependencies;
  readonly status?: InspectOperationalStatusOptions;
  readonly logs?: {
    readonly signal?: AbortSignal;
    readonly pollMilliseconds?: number;
    readonly clock?: () => Date;
  };
  readonly install?: InstallCommandDependencies;
  readonly uninstall?: UninstallCommandDependencies;
  readonly runNow?: RunNowDependencies;
};

type ProcessAbortLatch = { readonly signal: AbortSignal; readonly dispose: () => void };

function processAbortLatch(): ProcessAbortLatch {
  const controller = new AbortController();
  const stop = (): void => { controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    },
  };
}

async function runStatusCli(
  parsed: RunArgs,
  dependencies: InspectOperationalStatusOptions | undefined,
): Promise<number> {
  let productionTask: Awaited<ReturnType<CurrentUserWindowsTaskScheduler['inspect']>> | null = null;
  if (dependencies === undefined && process.platform === 'win32') {
    try {
      const scheduler = new CurrentUserWindowsTaskScheduler(
        new CurrentUserTaskSchedulerPowerShellRunner(),
      );
      productionTask = await scheduler.inspect();
    } catch {
      productionTask = null;
    }
  }
  const report = await inspectOperationalStatus({
    ...dependencies,
    ...(productionTask === null
      ? {}
      : {
          taskFacet: () => managedTaskStatusObservation(productionTask),
          ...(productionTask.kind === 'present' && productionTask.marker !== null
            ? { expectedBuildIdentity: productionTask.marker.releaseDigest }
            : {}),
        }),
    ...(parsed.configPath === null ? {} : { configPath: parsed.configPath }),
    ...(parsed.statePath === null ? {} : { statePath: parsed.statePath }),
    ...(parsed.logDir === null ? {} : { logDir: parsed.logDir }),
  });
  process.stdout.write((parsed.json ? JSON.stringify(report, null, 2) : formatOperationalStatus(report)) + '\n');
  return report.exitCode;
}

async function runLogsCli(
  parsed: RunArgs,
  dependencies: CliMainDependencies['logs'],
): Promise<number> {
  let logDir: string;
  try {
    logDir = resolveOperationalLogDir(parsed.logDir);
  } catch {
    process.stderr.write('logs.path_unavailable\n');
    return 1;
  }
  const common = {
    logDir,
    tail: parsed.tail,
    job: parsed.job,
    ...(dependencies?.clock === undefined ? {} : { clock: dependencies.clock }),
  };
  try {
    if (!parsed.follow) {
      const records = await readOperationalLogTail(common);
      if (records.length > 0) {
        process.stdout.write(records.map((record) => formatOperationalLogRecord(record)).join('\n') + '\n');
      }
      return 0;
    }

    const ownedLatch = dependencies?.signal === undefined ? processAbortLatch() : null;
    try {
      const signal = dependencies?.signal ?? ownedLatch?.signal;
      if (signal === undefined) throw new Error('logs.signal_unavailable');
      for await (const record of followOperationalLogs({
        ...common,
        signal,
        ...(dependencies?.pollMilliseconds === undefined
          ? {}
          : { pollMilliseconds: dependencies.pollMilliseconds }),
      })) {
        process.stdout.write(formatOperationalLogRecord(record) + '\n');
      }
      return 0;
    } finally {
      ownedLatch?.dispose();
    }
  } catch {
    process.stderr.write('logs.read_failed\n');
    return 1;
  }
}

function writeWindowsLifecycleFailure(command: 'install' | 'uninstall' | 'run-now', error: unknown): void {
  const code = error instanceof Error && /^windows\.[a-z0-9_.]+$/u.test(error.message)
    ? error.message
    : `windows.${command.replace('-', '_')}.failed`;
  process.stderr.write(code + '\n');
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  dependencies: CliMainDependencies = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    process.stdout.write(CLI_USAGE + '\n');
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(parsed.message + '\n\n' + CLI_USAGE + '\n');
    return 2;
  }

  if (parsed.command === 'status') {
    return await runStatusCli(parsed, dependencies.status);
  }

  if (parsed.command === 'logs') {
    return await runLogsCli(parsed, dependencies.logs);
  }

  if (parsed.command === 'install') {
    try {
      if (parsed.appRoot === null || parsed.nodePath === null || parsed.orcaBin === null ||
          parsed.configPath === null || parsed.statePath === null || parsed.logDir === null) {
        throw new Error('windows.install.invalid_arguments');
      }
      const result = await installWindowsTask({
        appRoot: parsed.appRoot,
        nodePath: parsed.nodePath,
        orcaPath: parsed.orcaBin,
        configPath: parsed.configPath,
        statePath: parsed.statePath,
        logDir: parsed.logDir,
        runNow: parsed.runNow,
        waitSeconds: parsed.waitSeconds,
      }, dependencies.install);
      process.stdout.write(
        `install task=${result.task} backup=${result.backupCreated ? 'created' : 'not-needed'} runNow=${result.runNow}\n`,
      );
      return 0;
    } catch (error) {
      writeWindowsLifecycleFailure('install', error);
      return 1;
    }
  }

  if (parsed.command === 'uninstall') {
    try {
      const result = await uninstallWindowsTask(parsed.waitSeconds, {
        ...dependencies.uninstall,
        force: parsed.force,
      });
      process.stdout.write(`uninstall task=${result.task}\n`);
      return 0;
    } catch (error) {
      writeWindowsLifecycleFailure('uninstall', error);
      return 1;
    }
  }

  if (parsed.command === 'run-now') {
    try {
      const result = await runManagedTaskNow(parsed.waitSeconds, dependencies.runNow);
      process.stdout.write(`run-now action=${result.action}\n`);
      return 0;
    } catch (error) {
      writeWindowsLifecycleFailure('run-now', error);
      return 1;
    }
  }

  if (parsed.command === 'gate-register') {
    return await runGateRegisterCommand(parsed);
  }

  if (parsed.command === 'channel-adapter') {
    return await runChannelAdapterCommand(parsed, dependencies.channelAdapter);
  }

  const config = await loadConfig(parsed.configPath ?? defaultConfigPath());

  if (parsed.command === 'verify-slack') {
    let result = await verifySlack(config.slack, process.env);
    if (parsed.socket && result.ok) {
      const socketCheck = await verifySocketPreflight(config.slack, process.env);
      result = {
        checks: [...result.checks, socketCheck],
        ok: socketCheck.ok,
      };
    }
    process.stdout.write(formatVerify(result) + '\n');
    return result.ok ? 0 : 1;
  }

  if (parsed.command === 'digest') {
    return await runDigestCommand(parsed, config);
  }

  if (parsed.command === 'runs') {
    return await runRunsCommand(parsed, config);
  }

  if (parsed.command === 'daemon') {
    return await runDaemonCommand(parsed, config, dependencies.daemon);
  }

  const orcaBin = parsed.orcaBin ?? process.env['ORCA_BIN'] ?? 'orca';
  const snapshot = await takeSnapshot(new OrcaCli(orcaBin), new GhCli(), config, {
    prLimit: parsed.prLimit,
  });
  process.stdout.write(
    (parsed.json ? JSON.stringify(snapshot, null, 2) : summarize(snapshot)) + '\n',
  );
  return 0;
}

/** package.json engines가 요구하는 Node 버전. 진입점 판정이 이 버전의 API에 의존한다. */
const REQUIRED_NODE = '>=26';

export type Entrypoint =
  | { readonly kind: 'run' }
  | { readonly kind: 'imported' }
  | { readonly kind: 'unsupported'; readonly message: string };

/**
 * 진입점 판정을 순수 함수로 분리해 test가 필드 부재 경로를 검증할 수 있게 한다.
 * `import.meta.main`이 없는 런타임에서는 진입점 여부를 알 수 없다. 그때 조용히
 * 넘어가면 CLI가 아무 출력 없이 exit 0으로 끝나 사용자가 성공으로 오인하므로,
 * 경로 문자열 비교로 흉내내지 않고 지원 범위 밖으로 구분해 호출자가 실패시킨다.
 */
export function decideEntrypoint(main: boolean | undefined, nodeVersion: string): Entrypoint {
  if (main === undefined) {
    return {
      kind: 'unsupported',
      message:
        'import.meta.main을 지원하지 않는 런타임이라 CLI 진입점을 판정할 수 없다.\n' +
        `요구 Node 버전: ${REQUIRED_NODE} (package.json engines) / 실행 중인 버전: ${nodeVersion}`,
    };
  }
  return main ? { kind: 'run' } : { kind: 'imported' };
}

/**
 * 이 모듈이 프로세스의 진입점일 때만 CLI를 실행한다.
 * 진입점 판정을 Node에 맡겨 경로 문자열 비교 없이 처리하므로,
 * test가 `parseArgs`를 import해도 `main()`과 `process.exit`이 실행되지 않는다.
 * 필드가 없는 런타임은 지원 범위 밖이므로 조용히 넘어가지 않고 즉시 실패한다.
 */
const entrypoint = decideEntrypoint(import.meta.main, process.version);
if (entrypoint.kind === 'unsupported') {
  process.stderr.write(entrypoint.message + '\n');
  process.exit(1);
} else if (entrypoint.kind === 'run') {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    },
  );
}
