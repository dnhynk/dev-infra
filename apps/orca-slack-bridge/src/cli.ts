#!/usr/bin/env node
import { loadConfig, defaultConfigPath } from './project/config.js';
import { GhCli } from './github/runner.js';
import { OrcaCli } from './orca/client.js';
import { takeSnapshot, summarize } from './snapshot/snapshot.js';
import { verifySlack, formatVerify } from './slack/verify.js';

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const USAGE = `orca-slack-bridge <snapshot|verify-slack>

snapshot   Orca와 GitHub을 read-only로 1회 관찰한다
verify-slack  Slack 토큰과 설정을 확인한다 (메시지를 게시하지 않는다)

  --config <path>   설정 파일 (기본: ORCA_SLACK_BRIDGE_CONFIG 또는 OS 설정 경로)
  --orca <path>     orca 실행 파일 (기본: ORCA_BIN 또는 'orca')
  --pr-limit <n>    repository당 조회할 PR 수 (기본 50)
  --json            요약 대신 snapshot 전체를 JSON으로 출력

외부 write를 하지 않는다. Slack과 Orca 상태를 변경하지 않는다.`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv[0] !== 'snapshot') {
    process.stdout.write(USAGE + '\n');
    return argv.includes('--help') ? 0 : 2;
  }

  const configPath = arg(argv, '--config') ?? defaultConfigPath();
  const config = await loadConfig(configPath);
  const orcaBin = arg(argv, '--orca') ?? process.env['ORCA_BIN'] ?? 'orca';
  const prLimitRaw = arg(argv, '--pr-limit');
  const prLimit = prLimitRaw === undefined ? 50 : Number.parseInt(prLimitRaw, 10);
  if (!Number.isSafeInteger(prLimit) || prLimit <= 0) {
    process.stderr.write(`--pr-limit이 양의 정수가 아니다: ${String(prLimitRaw)}\n`);
    return 2;
  }

  const snapshot = await takeSnapshot(new OrcaCli(orcaBin), new GhCli(), config, { prLimit });
  process.stdout.write(
    (argv.includes('--json') ? JSON.stringify(snapshot, null, 2) : summarize(snapshot)) + '\n',
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
