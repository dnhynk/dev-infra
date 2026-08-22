import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDigest, formatReport, type DigestReport } from '../src/digest/digest.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import type { GhRunner } from '../src/github/runner.js';
import type { OrcaRunner } from '../src/orca/client.js';
import type { BridgeConfig } from '../src/project/config.js';
import { DEFAULT_CORRELATION_KEYS } from '../src/project/config.js';
import type {
  PostMessageInput,
  PostedMessage,
  SlackPoster,
  UpdateMessageInput,
} from '../src/slack/post.js';
import { MemorySummaryCache, SummaryProviderError } from '../src/summarize/index.js';
import type { SummaryProvider } from '../src/summarize/index.js';
import type { SummaryFacts } from '../src/summarize/contract.js';

/**
 * digest 1회 실행의 통합 검증.
 *
 * store는 임시 파일의 실제 sqlite를 쓰고 GitHub/Orca/Slack/summarizer만 대역으로 둔다.
 * store를 모킹하면 검증 대상인 "재관찰로 루트가 중복되지 않는다"의 근거가 사라진다.
 */

const RUN = 'run_test0001';
const TASK = 'task_worker01';
const REVIEW_TASK = 'task_review01';
const REPO = 'o/r';
const REPO_ID = 4242;
const HEAD = 'a'.repeat(40);
const CHANNEL = 'C_TEST_CHANNEL';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-digest-'));
  dbPath = join(dir, 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 실측 형태를 그대로 흉내낸 합성 fixture (DL-023). */
class FakeOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  async run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    const wrap = (result: unknown): string => JSON.stringify({ id: 'x', ok: true, result });
    if (args[1] === 'run-list') {
      return wrap({
        runs: [
          {
            id: RUN,
            objective: 'C1',
            coordinator_handle: 'term_1',
            coordinator_pane_key: 'a:b',
            legacy: 0,
            created_at: '2026-08-22T00:00:00Z',
            updated_at: '2026-08-22T00:00:00Z',
          },
        ],
      });
    }
    if (args[1] === 'task-list') {
      return wrap({
        tasks: [
          {
            id: TASK,
            run_id: RUN,
            task_title: 'digest CLI 통합',
            display_name: 'digest CLI 통합',
            status: 'completed',
            deps: '[]',
            result: '{"provenance":"worker_report"}',
            created_by_process_incarnation: 'uuid::D:/dev-infra@@h:i',
            created_at: '2026-08-22 00:00:00',
            completed_at: '2026-08-22 01:00:00',
          },
          {
            id: REVIEW_TASK,
            run_id: RUN,
            task_title: 'review',
            display_name: 'review',
            status: 'completed',
            deps: '[]',
            result: JSON.stringify({
              kind: 'reviewer_result',
              schemaVersion: 1,
              verdict: 'approve',
              pr: { repo: REPO, number: 7 },
              reviewedHeadSha: HEAD,
              findings: [
                { severity: 'minor', file: 'src/a.ts', line: 3, summary: '주석이 부족하다' },
              ],
            }),
            created_by_process_incarnation: 'uuid::D:/dev-infra@@h:i',
            created_at: '2026-08-22 00:10:00',
            completed_at: '2026-08-22 01:10:00',
          },
        ],
      });
    }
    if (args[1] === 'gate-list') return wrap({ gates: [] });
    if (args[1] === 'inbox') {
      return wrap({
        messages: [
          {
            id: 'msg_1',
            run_id: RUN,
            type: 'worker_done',
            subject: '완료',
            body: '구현했다. 하나 발견했다. 남은 것은 없다.',
            payload: JSON.stringify({ taskId: TASK, dispatchId: 'ctx_1', outcome: 'succeeded' }),
            created_at: '2026-08-22 01:00:00',
          },
        ],
      });
    }
    throw new Error('예상치 못한 orca 호출: ' + args.join(' '));
  }
}

type PrRow = Record<string, unknown>;

function prRow(over: PrRow = {}): PrRow {
  return {
    number: 7,
    title: 'feat: digest 명령',
    body: ['사람이 읽는 본문', '', `<!-- orca-run: ${RUN} -->`, `<!-- orca-task: ${TASK} -->`].join(
      '\n',
    ),
    url: `https://github.com/${REPO}/pull/7`,
    state: 'MERGED',
    isDraft: false,
    headRefName: 'feat/digest',
    headRefOid: HEAD,
    baseRefName: 'main',
    mergedAt: '2026-08-22T01:20:00Z',
    reviewDecision: null,
    reviews: [],
    statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    files: [{ path: 'src/a.ts' }],
    changedFiles: 1,
    ...over,
  };
}

class FakeGh implements GhRunner {
  constructor(private readonly prs: readonly PrRow[]) {}
  async run(args: readonly string[]): Promise<string> {
    if (args[0] === 'api') return JSON.stringify({ id: REPO_ID, full_name: REPO });
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(this.prs);
    throw new Error('예상치 못한 gh 호출: ' + args.join(' '));
  }
}

class FakeSlack implements SlackPoster {
  readonly posts: PostMessageInput[] = [];
  readonly updates: UpdateMessageInput[] = [];
  private seq = 0;
  async post(input: PostMessageInput): Promise<PostedMessage> {
    this.posts.push(input);
    this.seq += 1;
    return { channel: input.channel, ts: `1700000000.00000${this.seq}` };
  }
  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return { channel: input.channel, ts: input.ts };
  }
}

/** 결정적 대역. 같은 사실이 같은 카드를 내는지 보려면 모델 출력이 흔들리면 안 된다. */
class StubProvider implements SummaryProvider {
  readonly calls: SummaryFacts[] = [];
  async complete(facts: SummaryFacts): Promise<unknown> {
    this.calls.push(facts);
    return {
      title: '요약 제목',
      what: '무엇이 바뀌는지.',
      why: '왜 필요한지.',
      reviewGist: '리뷰 핵심.',
    };
  }
}

/** 요약이 실패해도 카드가 게시되는지 보기 위한 대역. */
class FailingProvider implements SummaryProvider {
  async complete(): Promise<unknown> {
    throw new SummaryProviderError('provider가 죽었다', false);
  }
}

const CONFIG: BridgeConfig = {
  slack: null,
  projects: [{ name: 'demo', repositories: [REPO] }],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

type Once = {
  readonly prs?: readonly PrRow[];
  readonly slack?: SlackPoster | null;
  readonly provider?: SummaryProvider;
  readonly onlyPr?: number | null;
  readonly channel?: string;
};

/** 매 실행이 store 파일을 새로 연다. 재시작 뒤에도 매핑을 찾는지 함께 본다. */
async function digestOnce(opts: Once = {}): Promise<DigestReport> {
  const store = new SqliteDigestStore(dbPath);
  try {
    return await runDigest(new FakeOrca(), new FakeGh(opts.prs ?? [prRow()]), {
      config: CONFIG,
      channel: opts.channel ?? CHANNEL,
      store,
      slack: opts.slack === undefined ? new FakeSlack() : opts.slack,
      provider: opts.provider ?? new StubProvider(),
      cache: new MemorySummaryCache(),
      prLimit: 50,
      onlyPr: opts.onlyPr ?? null,
      now: () => new Date('2026-08-22T02:00:00Z'),
    });
  } finally {
    store.close();
  }
}

function card(report: DigestReport) {
  const r = report.results.find((x) => x.kind === 'card');
  if (r === undefined || r.kind !== 'card') throw new Error('카드가 없다');
  return r;
}

describe('runDigest 멱등', () => {
  it('같은 입력을 두 번 처리하면 postMessage 1회, update 0회다', async () => {
    const slack = new FakeSlack();
    const first = await digestOnce({ slack });
    expect(card(first).action).toBe('create');
    expect(slack.posts).toHaveLength(1);

    const second = await digestOnce({ slack });
    expect(card(second).action).toBe('skip');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
  });

  it('사실이 바뀌면 update가 1회이고 루트는 늘지 않는다', async () => {
    const slack = new FakeSlack();
    await digestOnce({ slack });
    expect(slack.posts).toHaveLength(1);

    const changed = prRow({
      statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    const second = await digestOnce({ slack, prs: [changed] });
    expect(card(second).action).toBe('update');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(1);
    // 새 루트를 만들지 않고 처음 게시한 메시지의 ts를 갱신한다.
    expect(slack.updates[0]?.ts).toBe('1700000000.000001');
  });

  it('재시작해도 같은 store 파일에서 매핑을 찾는다', async () => {
    const first = new FakeSlack();
    await digestOnce({ slack: first });
    // 별도의 poster 인스턴스 = 프로세스 재시작에 해당한다. 판정 근거는 store뿐이다.
    const second = new FakeSlack();
    const report = await digestOnce({ slack: second });
    expect(card(report).action).toBe('skip');
    expect(second.posts).toHaveLength(0);
  });
});

describe('runDigest dry-run', () => {
  it('Slack에도 store에도 쓰지 않는다', async () => {
    const dry = await digestOnce({ slack: null });
    expect(dry.dryRun).toBe(true);
    expect(card(dry).action).toBe('create');
    expect(card(dry).messageTs).toBeNull();

    // dry-run이 store에 썼다면 이 실행은 있지도 않은 메시지를 update하려 한다.
    const slack = new FakeSlack();
    const live = await digestOnce({ slack });
    expect(card(live).action).toBe('create');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
  });

  it('게시할 blocks를 출력에 담는다', async () => {
    const out = formatReport(await digestOnce({ slack: null }));
    expect(out).toContain('mode=dry-run');
    expect(out).toContain('blocks');
    expect(out).toContain('pr_open');
  });
});

describe('runDigest 실패와 경계', () => {
  it('summarizer가 실패해도 축소 카드를 게시한다', async () => {
    const slack = new FakeSlack();
    const report = await digestOnce({ slack, provider: new FailingProvider() });
    const c = card(report);
    expect(c.action).toBe('create');
    expect(c.summary.kind).toBe('failed');
    expect(slack.posts).toHaveLength(1);
    const json = JSON.stringify(slack.posts[0]?.blocks);
    expect(json).toContain('요약 실패');
    // 요약이 없어도 identity와 PR 링크는 남는다.
    expect(json).toContain(`${REPO} #7`);
    expect(json).toContain(`https://github.com/${REPO}/pull/7`);
  });

  it('correlation이 없는 PR에는 카드를 만들지 않는다', async () => {
    const slack = new FakeSlack();
    const report = await digestOnce({
      slack,
      prs: [prRow({ number: 8, body: 'metadata 없는 본문', url: `https://github.com/${REPO}/pull/8` })],
    });
    expect(report.results).toEqual([
      { kind: 'skipped', key: `pr:${REPO_ID}#8`, reason: 'uncorrelated' },
    ]);
    expect(slack.posts).toHaveLength(0);
  });

  it('--pr은 그 번호만 처리한다', async () => {
    const slack = new FakeSlack();
    const report = await digestOnce({
      slack,
      prs: [prRow(), prRow({ number: 8, url: `https://github.com/${REPO}/pull/8` })],
      onlyPr: 8,
    });
    expect(report.results).toHaveLength(1);
    expect(card(report).key).toBe(`pr:${REPO_ID}#8`);
  });

  it('매핑된 채널이 대상 채널과 다르면 아무것도 쓰지 않는다', async () => {
    const first = new FakeSlack();
    await digestOnce({ slack: first });

    const other = new FakeSlack();
    const report = await digestOnce({ slack: other, channel: 'C_OTHER' });
    expect(card(report).action).toBe('channel_mismatch');
    expect(other.posts).toHaveLength(0);
    expect(other.updates).toHaveLength(0);
  });
});

describe('C1 출구 조건', () => {
  it('identity와 PR 링크가 항상 표시된다', async () => {
    const slack = new FakeSlack();
    await digestOnce({ slack });
    const blocks = slack.posts[0]?.blocks ?? [];
    const first = JSON.stringify(blocks[0]);
    expect(first).toContain(`${REPO} #7`);
    const actions = blocks.find((b) => b['type'] === 'actions') as
      | { elements: { url: string; action_id: string }[] }
      | undefined;
    expect(actions?.elements[0]?.url).toBe(`https://github.com/${REPO}/pull/7`);
    expect(actions?.elements[0]?.action_id).toBe('pr_open');
  });

  it('summarizer에는 layout도 action도 요구하지 않는다', async () => {
    const provider = new StubProvider();
    await digestOnce({ slack: new FakeSlack(), provider });
    const facts = provider.calls[0];
    expect(facts).toBeDefined();
    // 모델에 보내는 사실에 blocks, URL, 버튼이 없다. 만들 수 없으면 잘못 주장할 수도 없다.
    expect(JSON.stringify(facts)).not.toContain('https://');
    expect(Object.keys(facts ?? {}).sort()).toEqual([
      'changedPaths',
      'checks',
      'prBody',
      'prTitle',
      'review',
      'taskPurpose',
      'truncated',
      'workerDone',
    ]);
  });

  it('Orca에 write하지 않는다', async () => {
    const orca = new FakeOrca();
    const store = new SqliteDigestStore(dbPath);
    try {
      await runDigest(orca, new FakeGh([prRow()]), {
        config: CONFIG,
        channel: CHANNEL,
        store,
        slack: new FakeSlack(),
        provider: new StubProvider(),
        cache: new MemorySummaryCache(),
        prLimit: 50,
        onlyPr: null,
        now: () => new Date('2026-08-22T02:00:00Z'),
      });
    } finally {
      store.close();
    }
    const flat = orca.calls.flat();
    expect(flat).not.toContain('--ack');
    expect(flat).not.toContain('check');
    expect(flat).not.toContain('task-update');
  });
});
