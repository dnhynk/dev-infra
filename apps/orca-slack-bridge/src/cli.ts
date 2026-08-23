#!/usr/bin/env node
import { loadConfig, defaultConfigPath, type BridgeConfig } from './project/config.js';
import { GhCli } from './github/runner.js';
import { OrcaCli, type OrcaRunner } from './orca/client.js';
import { takeSnapshot, summarize } from './snapshot/snapshot.js';
import { formatRunCollection } from './run/collect.js';
import {
  formatRunObserveReport,
  runRunObserver,
  type RunObserveOptions,
} from './run/publish.js';
import { verifySlack, formatVerify, maskToken } from './slack/verify.js';
import { runDigest, formatReport } from './digest/digest.js';
import {
  SlackWebApiPoster,
  botToken,
  type SlackPoster,
  type ThreadPoster,
} from './slack/post.js';
import { ReadOnlyDigestStore, SqliteDigestStore, resolveStatePath } from './store/sqlite.js';
import type { DigestStore, RunStore } from './store/schema.js';
import {
  MemorySummaryCache,
  OpenAiSummaryProvider,
  OPENAI_KEY_VAR,
  SummaryProviderError,
  type SummaryProvider,
} from './summarize/index.js';

export type Command = 'snapshot' | 'verify-slack' | 'digest' | 'runs';

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
      /** `digest`가 처리할 PR 번호. null이면 전부. */
      readonly pr: number | null;
      /** 참이면 Slack과 store에 쓰지 않는다. */
      readonly dryRun: boolean;
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

const COMMANDS: readonly Command[] = ['snapshot', 'verify-slack', 'digest', 'runs'];

function isCommand(v: string | undefined): v is Command {
  return v !== undefined && (COMMANDS as readonly string[]).includes(v);
}

/** 값을 받는 플래그와 받지 않는 플래그. 값 검사와 `digest`의 오타 검사에 쓴다. */
const VALUE_FLAGS: readonly string[] = ['--config', '--orca', '--pr-limit', '--pr', '--state'];
const BOOL_FLAGS: readonly string[] = ['--json', '--dry-run'];

/**
 * 되돌릴 수 없는 외부 write를 하는 명령.
 *
 * 이 목록의 명령만 모르는 플래그를 거부한다. 근거는 `unknownWriteFlag`에 있다.
 */
const WRITE_COMMANDS: readonly Command[] = ['digest', 'runs'];

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
 * `unknownDigestFlag`와 달리 이 검사는 **모든 명령**에 건다. 모르는 플래그를 무시하는 것은
 * `snapshot`에서 무해하지만, 값 없는 값 플래그는 어느 명령에서도 유효한 호출이 아니어서 뺏을
 * 정상 동작이 없다. 원인도 명령별이 아니라 `arg()` 한 곳에 있으므로 명령별 특례를 두지 않는다.
 */
function missingFlagValue(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !VALUE_FLAGS.includes(token)) continue;
    const value = argv[i + 1];
    if (value === undefined) return `${token}은 값을 요구하는데 값이 없다`;
    if (value.startsWith('--')) return `${token}은 값을 요구하는데 플래그가 왔다: ${value}`;
  }
  return null;
}

/**
 * write하는 명령이 모르는 플래그를 찾는다. 없으면 null.
 *
 * 이 파서는 `indexOf`로 아는 이름만 찾으므로 모르는 플래그를 조용히 무시한다. `snapshot`과
 * `verify-slack`에서는 무시가 무해하지만 `digest`와 `runs`는 되돌릴 수 없는 외부 write를 한다.
 * `--dry-run`을 한 글자 틀리면 확인 없이 실제 채널에 게시된다. 그래서 write하는 명령에만
 * 검사를 건다. 다른 명령의 기존 동작은 바꾸지 않는다.
 *
 * **write하는 명령이 늘면 `WRITE_COMMANDS`에 넣는다.** 넣지 않으면 그 명령에서 `--dry-run`
 * 오타가 확인 없이 실제 게시로 간다.
 *
 * 값 자리를 따로 건너뛰지 않는다. `missingFlagValue`가 먼저 돌아 `--`로 시작하는 값을 이미
 * 거부하므로, `--`로 시작하는 토큰은 값일 수 없다. 건너뛰던 예전 코드가 `--state --dry-runn`의
 * 오타를 값으로 보아 통과시켰다.
 */
function unknownWriteFlag(argv: readonly string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    if (!VALUE_FLAGS.includes(token) && !BOOL_FLAGS.includes(token)) return token;
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
  const missing = missingFlagValue(argv);
  if (missing !== null) return { kind: 'error', message: missing };
  if ((WRITE_COMMANDS as readonly string[]).includes(command)) {
    const unknown = unknownWriteFlag(argv);
    if (unknown !== null) {
      return { kind: 'error', message: `${command}가 모르는 플래그다: ${unknown}` };
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
  return {
    kind: 'run',
    command,
    configPath: arg(argv, '--config') ?? null,
    orcaBin: arg(argv, '--orca') ?? null,
    prLimit,
    json: argv.includes('--json'),
    statePath: arg(argv, '--state') ?? null,
    pr,
    dryRun: argv.includes('--dry-run'),
  };
}

const USAGE = `orca-slack-bridge <snapshot|verify-slack|digest|runs>

snapshot      Orca와 GitHub을 read-only로 1회 관찰한다
verify-slack  Slack 토큰과 설정을 확인한다 (메시지를 게시하지 않는다)
digest        관찰 1회로 PR digest 카드를 #pr-digest에 게시하거나 갱신한다
runs          관찰 1회로 Run 카드를 #agent-runs에 게시하거나 갱신한다

  --config <path>   설정 파일 (기본: ORCA_SLACK_BRIDGE_CONFIG 또는 OS 설정 경로)
  --orca <path>     orca 실행 파일 (기본: ORCA_BIN 또는 'orca')
  --pr-limit <n>    repository당 조회할 PR 수 (기본 50)
  --json            요약 대신 결과 전체를 JSON으로 출력

digest·runs 전용:

  --state <path>    durable store 경로 (기본: ORCA_SLACK_BRIDGE_STATE 또는 OS state 경로)
  --dry-run         Slack에도 store에도 쓰지 않고 만들 blocks와 결정을 출력한다

digest 전용:

  --pr <number>     이 번호의 PR만 처리한다

snapshot과 verify-slack은 외부 write를 하지 않는다. digest는 설정의 slack.channels.prDigest에만,
runs는 slack.channels.agentRuns에만 게시하며 채널을 코드에서 만들지 않는다. runs는 Run마다 카드
하나와, 등록된 Run 수와 무관하게 컬렉션 카드 하나를 게시한다(OD-080).`;

/**
 * summarizer provider를 만든다.
 *
 * 키가 없으면 던지지 않고 **항상 실패하는 provider**를 준다. `summarize`가 그 실패를
 * `kind: 'failed'`로 바꾸므로 카드는 요약 없이 사실만 담은 축소 카드로 게시된다(OD-035).
 * 여기서 던지면 요약 실패 하나가 GitHub·Orca 관찰과 Slack 게시를 통째로 막는다.
 */
function summaryProvider(env: NodeJS.ProcessEnv): SummaryProvider {
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
export function openRunStore(statePath: string, dryRun: boolean): RunStore & { close(): void } {
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
 * **`digestPosters`와 달리 thread 경계를 돌려주지 않는다.** D1 Run 카드에는 thread 표면이 없다.
 * OD-072가 정한 owner 개입 알림은 D2 범위이고, 지금 여기서 `ThreadPoster`를 넘기면 아무도 쓰지
 * 않는 write 경계가 생긴다.
 */
export function runsPoster(dryRun: boolean, env: NodeJS.ProcessEnv): SlackPoster | null {
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
  store: RunStore,
  env: NodeJS.ProcessEnv,
): RunObserveOptions {
  if (config.slack === null) {
    throw new Error('runs는 설정의 slack 섹션이 필요하다. 게시 채널은 설정에서만 읽는다');
  }
  return {
    config,
    channel: config.slack.channels.agentRuns,
    store,
    slack: runsPoster(parsed.dryRun, env),
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

async function runDigestCommand(parsed: RunArgs, config: BridgeConfig): Promise<number> {
  if (config.slack === null) {
    process.stderr.write('digest는 설정의 slack 섹션이 필요하다. 게시 채널은 설정에서만 읽는다\n');
    return 2;
  }
  const channel = config.slack.channels.prDigest;
  const orcaBin = parsed.orcaBin ?? process.env['ORCA_BIN'] ?? 'orca';
  const store = openDigestStore(resolveStatePath(parsed.statePath), parsed.dryRun);
  try {
    const report = await runDigest(new OrcaCli(orcaBin), new GhCli(), {
      config,
      channel,
      store,
      // 루트와 thread write 경계. dry-run이면 둘 다 null이다.
      ...digestPosters(parsed.dryRun, process.env),
      provider: summaryProvider(process.env),
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

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === 'help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  if (parsed.kind === 'error') {
    process.stderr.write(parsed.message + '\n\n' + USAGE + '\n');
    return 2;
  }

  const config = await loadConfig(parsed.configPath ?? defaultConfigPath());

  if (parsed.command === 'verify-slack') {
    const result = await verifySlack(config.slack, process.env);
    process.stdout.write(formatVerify(result) + '\n');
    return result.ok ? 0 : 1;
  }

  if (parsed.command === 'digest') {
    return await runDigestCommand(parsed, config);
  }

  if (parsed.command === 'runs') {
    return await runRunsCommand(parsed, config);
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
