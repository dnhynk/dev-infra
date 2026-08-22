#!/usr/bin/env node
import { loadConfig, defaultConfigPath, type BridgeConfig } from './project/config.js';
import { GhCli } from './github/runner.js';
import { OrcaCli } from './orca/client.js';
import { takeSnapshot, summarize } from './snapshot/snapshot.js';
import { verifySlack, formatVerify } from './slack/verify.js';
import { runDigest, formatReport } from './digest/digest.js';
import { SlackWebApiPoster, botToken } from './slack/post.js';
import { SqliteDigestStore, resolveStatePath } from './store/sqlite.js';
import {
  MemorySummaryCache,
  OpenAiSummaryProvider,
  OPENAI_KEY_VAR,
  SummaryProviderError,
  type SummaryProvider,
} from './summarize/index.js';

export type Command = 'snapshot' | 'verify-slack' | 'digest';

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

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const COMMANDS: readonly Command[] = ['snapshot', 'verify-slack', 'digest'];

function isCommand(v: string | undefined): v is Command {
  return v !== undefined && (COMMANDS as readonly string[]).includes(v);
}

/** 값을 받는 플래그와 받지 않는 플래그. `digest`의 오타 검사에 쓴다. */
const VALUE_FLAGS: readonly string[] = ['--config', '--orca', '--pr-limit', '--pr', '--state'];
const BOOL_FLAGS: readonly string[] = ['--json', '--dry-run'];

/**
 * `digest`가 모르는 플래그를 찾는다. 없으면 null.
 *
 * 이 파서는 `indexOf`로 아는 이름만 찾으므로 모르는 플래그를 조용히 무시한다. `snapshot`과
 * `verify-slack`에서는 무시가 무해하지만 `digest`는 되돌릴 수 없는 외부 write를 한다.
 * `--dry-run`을 한 글자 틀리면 확인 없이 실제 채널에 게시된다. 그래서 write하는 명령에만
 * 검사를 건다. 다른 명령의 기존 동작은 바꾸지 않는다.
 */
function unknownDigestFlag(argv: readonly string[]): string | null {
  const valuePositions = new Set<number>();
  for (const flag of VALUE_FLAGS) {
    const i = argv.indexOf(flag);
    if (i >= 0) valuePositions.add(i + 1);
  }
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--') || valuePositions.has(i)) continue;
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
  if (command === 'digest') {
    const unknown = unknownDigestFlag(argv);
    if (unknown !== null) {
      return { kind: 'error', message: `digest가 모르는 플래그다: ${unknown}` };
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

const USAGE = `orca-slack-bridge <snapshot|verify-slack|digest>

snapshot      Orca와 GitHub을 read-only로 1회 관찰한다
verify-slack  Slack 토큰과 설정을 확인한다 (메시지를 게시하지 않는다)
digest        관찰 1회로 PR digest 카드를 #pr-digest에 게시하거나 갱신한다

  --config <path>   설정 파일 (기본: ORCA_SLACK_BRIDGE_CONFIG 또는 OS 설정 경로)
  --orca <path>     orca 실행 파일 (기본: ORCA_BIN 또는 'orca')
  --pr-limit <n>    repository당 조회할 PR 수 (기본 50)
  --json            요약 대신 결과 전체를 JSON으로 출력

digest 전용:

  --state <path>    durable store 경로 (기본: ORCA_SLACK_BRIDGE_STATE 또는 OS state 경로)
  --pr <number>     이 번호의 PR만 처리한다
  --dry-run         Slack에도 store에도 쓰지 않고 만들 blocks와 결정을 출력한다

digest 외의 명령은 외부 write를 하지 않는다. digest는 설정의 slack.channels.prDigest에만
게시하며 채널을 코드에서 만들지 않는다.`;

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

async function runDigestCommand(parsed: RunArgs, config: BridgeConfig): Promise<number> {
  if (config.slack === null) {
    process.stderr.write('digest는 설정의 slack 섹션이 필요하다. 게시 채널은 설정에서만 읽는다\n');
    return 2;
  }
  const orcaBin = parsed.orcaBin ?? process.env['ORCA_BIN'] ?? 'orca';
  const store = new SqliteDigestStore(resolveStatePath(parsed.statePath));
  try {
    const report = await runDigest(new OrcaCli(orcaBin), new GhCli(), {
      config,
      channel: config.slack.channels.prDigest,
      store,
      // dry-run은 poster를 아예 만들지 않는다. 토큰도 읽지 않으므로 write 경로가 없다.
      slack: parsed.dryRun ? null : new SlackWebApiPoster({ token: botToken(process.env) }),
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
