import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openRunStore, parseArgs, runsObserveOptions, runsPoster, runRunsCommand } from '../src/cli.js';
import { SlackWebApiPoster } from '../src/slack/post.js';
import { BOT_TOKEN_VAR } from '../src/slack/verify.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import { DEFAULT_CORRELATION_KEYS, type BridgeConfig } from '../src/project/config.js';
import type { OrcaRunner } from '../src/orca/client.js';
import type { GateStore, RunStore } from '../src/store/schema.js';

/**
 * runs 명령의 CLI 경계 검증(OD-080, OD-078).
 *
 * **이 파일이 막는 회귀는 하나다 — "타입에는 있는데 배선이 없다".** 이 Run에서 그 실패가
 * 반복됐다. `publishRunCollection`이 존재하고 테스트도 통과하는데 `cli.ts`가 부르지 않으면
 * `#agent-runs`에는 아무것도 나가지 않는다.
 *
 * 그래서 세 자리를 각각 고정한다.
 * - `runsPoster`: 실제 실행이 write 경계를 실제로 만든다. `null`로 되돌리면 실패한다.
 * - `runsObserveOptions`: 대상 채널이 `agentRuns`다. `prDigest`로 바꾸면 실패한다.
 * - `runRunsCommand`: 명령이 관찰과 게시까지 실제로 잇는다. 게시 호출을 떼면 실패한다.
 *
 * 실제 파일과 실제 sqlite를 쓴다. 모킹하면 검증 대상인 "dry-run이 파일을 만들지 않는다"의
 * 근거가 사라진다. **실제 Slack은 부르지 않는다** — dry-run은 poster를 아예 만들지 않는다.
 */

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-cli-runs-'));
  // 부모 디렉터리를 일부러 만들지 않는다. dry-run이 그것마저 만들지 않는지 함께 본다.
  statePath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// 실제 토큰 형태를 리터럴로 적으면 GitHub push protection이 커밋을 막는다.
const TOKEN = ['xoxb', 'FAKE', 'NOTAREALBOTTOKENVALUE'].join('-');
const AGENT_RUNS = 'C0AGENTRUNS';
const PR_DIGEST = 'C0PRDIGEST';
const REPO_ID = 'ccb3c8ee-6d9e-42af-af36-9fdac6566fcc';

const CONFIG: BridgeConfig = {
  slack: {
    teamId: 'T0TEAM',
    ownerUserIds: ['U0OWNER'],
    channels: { prDigest: PR_DIGEST, agentRuns: AGENT_RUNS , decisions: AGENT_RUNS },
  },
  projects: [
    { name: 'dev-infra', repositories: ['dnhynk/dev-infra'], orcaRepositoryIds: [REPO_ID] },
  ],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

/** 관찰 1회를 흉내내는 Orca CLI. 인자별로 고정 응답을 준다. */
class FakeOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  constructor(private readonly responses: Record<string, unknown>) {}
  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const key = args[1] ?? '';
    const result = this.responses[key];
    if (result === undefined) throw new Error(`예상치 못한 호출: ${args.join(' ')}`);
    return Promise.resolve(JSON.stringify({ id: 'x', ok: true, result }));
  }
}

/**
 * 등록된 repository의 Run 하나를 관측하는 Orca.
 *
 * Task 행이 필요하다. 등록 열쇠는 Task의 `created_by_process_incarnation`에 있는
 * `<repositoryId>::<path>`의 앞부분뿐이고(OD-078), Task가 없으면 그 Run은 등록 판정이 되지
 * 않아 미등록으로 분류된다.
 */
function orcaWith(runs: readonly Record<string, unknown>[]): FakeOrca {
  return new FakeOrca({
    'run-list': { runs },
    'task-list': {
      tasks: [
        {
          id: 'task_1',
          run_id: 'run_36d28e6e947a',
          task_title: 't',
          status: 'ready',
          deps: '[]',
          result: null,
          created_by_process_incarnation: `${REPO_ID}::D:/dev-infra@@h:i`,
          created_by_terminal_handle: 'term_now',
          created_by_pane_key: 'pane:now',
          created_by_run_generation: 2,
          created_at: '2026-08-24 00:00:00',
        },
      ],
      count: 1,
    },
    'gate-list': { gates: [] },
    'worker-list': { workers: [] },
    inbox: { messages: [] },
  });
}

const REGISTERED_RUN = {
  id: 'run_36d28e6e947a',
  objective: 'D1 관찰',
  coordinator_handle: 'term_now',
  coordinator_pane_key: 'pane:now',
  consumer_generation: 2,
  legacy: 0,
  created_at: '2026-08-24T00:00:00Z',
  updated_at: '2026-08-24T00:00:00Z',
};

function args(argv: readonly string[]) {
  const parsed = parseArgs(argv);
  if (parsed.kind !== 'run') throw new Error(`run이 아니다: ${JSON.stringify(parsed)}`);
  return parsed;
}

/** stdout을 가로채 명령의 출력을 문자열로 모은다. */
async function captureRun(
  argv: readonly string[],
  orca: OrcaRunner,
  config: BridgeConfig = CONFIG,
): Promise<{ readonly code: number; readonly out: string }> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    const code = await runRunsCommand(args(argv), config, orca);
    return { code, out: chunks.join('') };
  } finally {
    spy.mockRestore();
  }
}

describe('runs write 경계 배선', () => {
  // 회귀 방지: 이 배선이 `null`이면 카드는 전부 만들어지고 결정도 전부 나지만 Slack에는
  // 아무것도 나가지 않는다. 그 상태가 프로덕션 경로에서만 참이라 다른 테스트가 잡지 못한다.
  it('실제 실행은 Slack write 경계를 받는다', () => {
    expect(runsPoster(false, { [BOT_TOKEN_VAR]: TOKEN })).toBeInstanceOf(SlackWebApiPoster);
  });

  it('dry-run은 경계를 만들지 않고 토큰도 읽지 않는다', () => {
    // 토큰이 없는 환경이다. 읽었다면 여기서 던진다.
    expect(runsPoster(true, {})).toBeNull();
  });

  it('실제 실행에서 토큰이 없으면 게시를 시작하지 않는다', () => {
    expect(() => runsPoster(false, {})).toThrow(BOT_TOKEN_VAR);
  });
});

describe('runs 관찰 옵션', () => {
  function withStore<T>(fn: (store: RunStore & GateStore & { close(): void }) => T): T {
    const store = openRunStore(statePath, false);
    try {
      return fn(store);
    } finally {
      store.close();
    }
  }

  // 회귀 방지: prDigest를 쓰면 PR 카드 채널에 Run 카드가 섞이고, 그 뒤 매핑 행의 채널이 굳어
  // 되돌리려면 channel_mismatch를 지나야 한다.
  it('대상 채널은 agentRuns다. prDigest가 아니다', () => {
    withStore((store) => {
      const options = runsObserveOptions(args(['runs', '--dry-run']), CONFIG, store, {});
      expect(options.channel).toBe(AGENT_RUNS);
      expect(options.channel).not.toBe(PR_DIGEST);
    });
  });

  it('dry-run이면 write 경계가 null이다', () => {
    withStore((store) => {
      const options = runsObserveOptions(args(['runs', '--dry-run']), CONFIG, store, {});
      expect(options.slack).toBeNull();
      expect(options.thread).toBeNull();
    });
  });

  it('실제 실행이면 write 경계를 받는다', () => {
    withStore((store) => {
      const options = runsObserveOptions(args(['runs']), CONFIG, store, {
        [BOT_TOKEN_VAR]: TOKEN,
      });
      expect(options.slack).toBeInstanceOf(SlackWebApiPoster);
      expect(options.thread).toBe(options.slack);
    });
  });

  it('slack 섹션이 없으면 채널을 만들어내지 않고 던진다', () => {
    withStore((store) => {
      expect(() =>
        runsObserveOptions(args(['runs', '--dry-run']), { ...CONFIG, slack: null }, store, {}),
      ).toThrow(/slack 섹션/);
    });
  });
});

describe('runs dry-run store', () => {
  // 회귀 방지: dry-run이 SqliteDigestStore를 열면 부모 디렉터리·DB 파일·WAL·schema_version을
  // 만들고 close에서 checkpoint까지 한다. 도움말은 "store에 쓰지 않는다"였다.
  it('없는 경로에 아무것도 만들지 않고 행 없음으로 다룬다', () => {
    const store = openRunStore(statePath, true);
    try {
      expect(store.findRunCollectionMessage()).toBeNull();
    } finally {
      store.close();
    }
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(dirname(statePath))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  // 대조군. 실제 게시 경로의 store는 같은 경로를 만든다.
  it('실제 게시 경로의 store는 같은 경로를 만든다', () => {
    openRunStore(statePath, false).close();
    expect(existsSync(statePath)).toBe(true);
  });
});

describe('runs 명령 배선', () => {
  /*
   * 회귀 방지 — 이 Run에서 다섯 번 나온 실패다. `publishRunCollection`이 존재하고 그 단위
   * 테스트도 통과하는데 `cli.ts`가 부르지 않으면 `#agent-runs`에는 아무것도 나가지 않는다.
   *
   * 그래서 사실 출력만 보지 않는다. **게시 결정이 보고에 있는지**를 본다. 명령이 관찰만 하고
   * 게시 경로를 부르지 않으면 이 단언이 실패한다.
   */
  it('관찰과 게시를 실제로 잇는다 — 게시 결정이 보고에 나온다', async () => {
    const { code, out } = await captureRun(
      ['runs', '--dry-run', '--state', statePath],
      orcaWith([REGISTERED_RUN]),
    );

    expect(code).toBe(0);
    // 사실 보고. `formatRunCollection`이 낸다.
    expect(out).toContain('run_36d28e6e947a');
    // 게시 보고. 이 세 줄이 없으면 게시 경로가 돌지 않은 것이다.
    expect(out).toContain('mode=dry-run');
    expect(out).toContain('컬렉션 카드  create');
    expect(out).toContain('run_36d28e6e947a  create');
    expect(out).toContain('Run 카드 1건 / 컬렉션 카드 1건');
  });

  // 수용 기준(OD-080). 등록 Run이 0이면 Run 카드가 없지만 컬렉션 카드는 그대로 나간다.
  it('등록된 Run이 0이어도 컬렉션 카드를 만들고 미등록 수를 싣는다', async () => {
    const unregistered = {
      ...REGISTERED_RUN,
      id: 'run_unregistered',
    };
    const orca = new FakeOrca({
      'run-list': { runs: [unregistered] },
      'task-list': {
        tasks: [
          {
            id: 'task_1',
            run_id: 'run_unregistered',
            task_title: 't',
            status: 'ready',
            deps: '[]',
            result: null,
            created_by_process_incarnation: 'other-repo-id::D:/other@@h:i',
            created_by_terminal_handle: 'term_now',
            created_by_pane_key: 'pane:now',
            created_by_run_generation: 2,
            created_at: '2026-08-24 00:00:00',
          },
        ],
        count: 1,
      },
      'gate-list': { gates: [] },
      'worker-list': { workers: [] },
      inbox: { messages: [] },
    });

    const { code, out } = await captureRun(['runs', '--dry-run', '--state', statePath], orca);

    expect(code).toBe(0);
    expect(out).toContain('Run 카드 0건 / 컬렉션 카드 1건');
    expect(out).toContain('컬렉션 카드  create');
    // 카드 본문이 미등록 사실을 싣는지 같은 자리에서 확인한다. dry-run은 blocks를 그대로 찍는다.
    expect(out).toContain('등록되지 않은 Run 1건');
    expect(out).toContain('run_unregistered');
    expect(out).toContain('unregistered_repository');
  });

  // dry-run이 막는 것은 두 종류이고 겹 수가 다르다.
  //
  // - **Slack write는 한 겹이다** — `runsPoster`가 `null`이라 `publish.ts`가 write 경로에
  //   들어가지 않는다. 이 한 겹뿐이다. 실측: 이 한 겹만 끊고 store는 `ReadOnlyDigestStore`로 둔
  //   채 `runRunObserver`를 돌리면 `chat.postMessage`가 **1건 실제로 나간 뒤에** store가 던진다.
  //   store 겹은 Slack 호출 **뒤에** 오므로 Slack을 막지 못한다.
  // - **store write는 두 겹이다** — store가 읽기 전용이라 세 write가 전부 던지고, 그 store는
  //   원본 파일을 열지도 않아 파일 부작용도 없다.
  //
  // 그래서 "여러 겹이니 하나 건드려도 안전하다"가 아니다. `runsPoster`를 건드리면 실제 채널에
  // 쓴다. 아래 테스트가 고정하는 것은 store 겹이다.
  it('dry-run은 store 파일을 만들지 않는다', async () => {
    const { code } = await captureRun(
      ['runs', '--dry-run', '--state', statePath],
      orcaWith([REGISTERED_RUN]),
    );
    expect(code).toBe(0);
    expect(existsSync(statePath)).toBe(false);
    expect(existsSync(dirname(statePath))).toBe(false);
  });

  // 기존 매핑이 있으면 dry-run도 update로 보고한다. 못 읽으면 이미 루트가 있는 Run을 create로
  // 보고하고, 그 보고를 믿고 게시하면 루트가 하나 더 생긴다.
  it('dry-run이 기존 매핑을 읽어 update로 보고한다', async () => {
    const live = new SqliteDigestStore(statePath);
    live.insertRunCollectionMessage({
      channelId: AGENT_RUNS,
      messageTs: '1787403740.000001',
      renderFingerprint: 'fp-오래된-지문',
      at: '2026-08-24T00:00:00.000Z',
    });
    live.close();

    const { out } = await captureRun(
      ['runs', '--dry-run', '--state', statePath],
      orcaWith([REGISTERED_RUN]),
    );
    expect(out).toContain('컬렉션 카드  update');
  });

  it('slack 섹션이 없으면 게시하지 않고 2로 끝난다', async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
    try {
      const code = await runRunsCommand(
        args(['runs', '--dry-run', '--state', statePath]),
        { ...CONFIG, slack: null },
        orcaWith([REGISTERED_RUN]),
      );
      expect(code).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(errors.join('')).toContain('slack 섹션');
  });
});
