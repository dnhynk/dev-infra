import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDigest, formatReport, type DigestReport } from '../src/digest/digest.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import { GhCommandError, type GhRunner } from '../src/github/runner.js';
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
/** 같은 PR을 이어서 갱신하는 두 번째 Task(OD-076). */
const SECOND_TASK = 'task_worker02';
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
            id: SECOND_TASK,
            run_id: RUN,
            task_title: '후속 수정',
            display_name: '후속 수정',
            status: 'completed',
            deps: '[]',
            result: '{"provenance":"worker_report"}',
            created_by_process_incarnation: 'uuid::D:/dev-infra@@h:i',
            created_at: '2026-08-22 00:05:00',
            completed_at: '2026-08-22 01:05:00',
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
    files: [{ path: 'src/a.ts' }],
    changedFiles: 1,
    ...over,
  };
}

/** head rollup GraphQL 응답. checks는 PR row가 아니라 이 응답에서 온다(`github/rollup.ts`). */
function rollupJson(conclusion: string): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          commits: {
            nodes: [{
              commit: {
                oid: HEAD,
                statusCheckRollup: {
                  contexts: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [{
                      __typename: 'CheckRun',
                      id: 'CR_build',
                      name: 'build',
                      status: 'COMPLETED',
                      conclusion,
                      startedAt: '2026-08-22T01:00:00Z',
                      completedAt: '2026-08-22T01:05:00Z',
                      checkSuite: { app: { databaseId: 15368 } },
                    }],
                  },
                },
              },
            }],
          },
        },
      },
    },
  });
}

class FakeGh implements GhRunner {
  constructor(
    private readonly prs: readonly PrRow[],
    private readonly buildConclusion = 'SUCCESS',
  ) {}
  async run(args: readonly string[]): Promise<string> {
    const path = args[1] ?? '';
    // required rule 조회. 이 fixture repo는 protection도 ruleset도 없다(dev-infra 실측과 같다).
    if (args[0] === 'api' && path.includes('/protection/required_status_checks')) {
      throw new GhCommandError(args, 1, 'gh: Branch not protected (HTTP 404)');
    }
    if (args[0] === 'api' && args.join(' ').includes('/rules/branches/')) return '[]';
    if (args[0] === 'api' && args[1] === 'graphql') return rollupJson(this.buildConclusion);
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
  /** head rollup의 `build` 결론. 사실이 바뀌는 경우를 만든다. */
  readonly buildConclusion?: string;
  readonly slack?: SlackPoster | null;
  readonly provider?: SummaryProvider;
  readonly onlyPr?: number | null;
  readonly channel?: string;
};

/** 매 실행이 store 파일을 새로 연다. 재시작 뒤에도 매핑을 찾는지 함께 본다. */
async function digestOnce(opts: Once = {}): Promise<DigestReport> {
  const store = new SqliteDigestStore(dbPath);
  try {
    return await runDigest(new FakeOrca(), new FakeGh(opts.prs ?? [prRow()], opts.buildConclusion), {
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

/** 같은 store 파일을 다시 열어 저장된 루트 매핑을 읽는다. store를 열지 않은 상태에서만 부른다. */
function readPrMessage(prKey: `pr:${number}#${number}`) {
  const store = new SqliteDigestStore(dbPath);
  try {
    return store.findPrMessage(prKey);
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

    const second = await digestOnce({ slack, buildConclusion: 'FAILURE' });
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

/**
 * OD-035의 호출 상한. 게이트가 둘이고 각각 다른 것을 막는다(`digest/digest.ts`).
 *
 * 실측 배경: T5의 실제 E2E에서 같은 PR에 digest를 두 번 실행하면 사실이 그대로인데도
 * `update`가 나왔다. 캐시가 프로세스 메모리에만 있어 매 실행이 summarizer를 다시 불렀고,
 * 모델이 만든 문자열 셋이 흔들려 렌더 지문이 달라졌기 때문이다. 아래 테스트는 provider
 * 호출 횟수를 직접 세어 그 회귀를 막는다. `StubProvider`가 결정적이라 호출을 세지 않고
 * action만 보면 이 회귀가 드러나지 않는다.
 */
describe('runDigest 요약 재사용', () => {
  it('사실이 그대로면 두 번째 실행은 summarizer를 부르지 않는다', async () => {
    const slack = new FakeSlack();
    const provider = new StubProvider();

    await digestOnce({ slack, provider });
    expect(provider.calls).toHaveLength(1);

    const second = await digestOnce({ slack, provider });
    expect(card(second).action).toBe('skip');
    // 이것이 이 Task의 핵심이다. 호출 횟수가 관찰 횟수가 아니라 전이 횟수에 비례한다.
    expect(provider.calls).toHaveLength(1);
    expect(card(second).summaryReused).toBe(true);
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
  });

  it('요약 입력이 바뀌면 다시 부르고 update한다', async () => {
    const slack = new FakeSlack();
    const provider = new StubProvider();

    await digestOnce({ slack, provider });
    const second = await digestOnce({ slack, provider, buildConclusion: 'FAILURE' });

    expect(provider.calls).toHaveLength(2);
    expect(card(second).summaryReused).toBe(false);
    expect(card(second).action).toBe('update');
    expect(slack.updates).toHaveLength(1);
  });

  // 두 게이트는 서로 독립이다. 요약 입력이 바뀌었는데 카드가 그대로인 경우가 있고, 그때
  // Slack을 부르지 않는 것이 맞다. 여기서는 PR 제목만 바꾼다. 제목은 SummaryFacts에 있지만
  // 카드 제목은 모델이 만든 문자열에서 오므로(요약 성공 시) 대역의 출력이 같으면 카드도 같다.
  it('요약을 다시 했어도 카드가 같으면 Slack을 부르지 않는다', async () => {
    const slack = new FakeSlack();
    const provider = new StubProvider();

    await digestOnce({ slack, provider });
    const second = await digestOnce({ slack, provider, prs: [prRow({ title: 'feat: 다른 제목' })] });

    expect(provider.calls).toHaveLength(2);
    expect(card(second).summaryReused).toBe(false);
    expect(card(second).action).toBe('skip');
    expect(slack.updates).toHaveLength(0);

    // 새 요약과 새 사실 지문은 저장돼 있어야 한다. 저장하지 않으면 매 관찰이 다시 요약한다.
    const third = await digestOnce({ slack, provider, prs: [prRow({ title: 'feat: 다른 제목' })] });
    expect(provider.calls).toHaveLength(2);
    expect(card(third).summaryReused).toBe(true);
  });

  // 회귀 방지: 사실 지문 하나로 게시까지 판정하면 이 전이에서 카드가 영영 갱신되지 않는다.
  // SummaryFacts에 PR state가 없어 merge는 사실 지문을 전혀 움직이지 않기 때문이다.
  // 게이트 B가 렌더 지문으로 잡는다. LLM은 안 부르고 카드는 갱신된다.
  it('merge만 된 관찰은 summarizer를 부르지 않고 카드만 갱신한다', async () => {
    const slack = new FakeSlack();
    const provider = new StubProvider();

    const open = await digestOnce({
      slack,
      provider,
      prs: [prRow({ state: 'OPEN', mergedAt: null })],
    });
    expect(card(open).action).toBe('create');
    // fixture의 reviewer_result가 approve라 열린 PR의 상태는 '리뷰 통과'다.
    expect(card(open).card.text).toContain('리뷰 통과');
    expect(provider.calls).toHaveLength(1);

    const merged = await digestOnce({ slack, provider });
    // 요약 입력은 byte 단위로 같다. 그래서 provider를 다시 부르지 않는다.
    expect(provider.calls).toHaveLength(1);
    expect(card(merged).summaryReused).toBe(true);
    // 그런데 카드는 달라진다. 상태는 SummaryFacts가 아니라 ProjectedPr에서 온다.
    expect(card(merged).action).toBe('update');
    expect(card(merged).card.text).toContain('병합 완료');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]?.ts).toBe('1700000000.000001');
  });

  it('요약이 실패한 관찰은 저장하지 않아 다음 관찰이 다시 시도한다', async () => {
    const slack = new FakeSlack();
    await digestOnce({ slack, provider: new FailingProvider() });

    // 실패를 durable하게 캐시하면 provider가 돌아와도 축소 카드가 사실이 바뀔 때까지 굳는다.
    const provider = new StubProvider();
    const second = await digestOnce({ slack, provider });
    expect(provider.calls).toHaveLength(1);
    expect(card(second).summaryReused).toBe(false);
    expect(card(second).summary.kind).toBe('ok');
  });

  /** 저장된 값을 손으로 흔든다. store를 열지 않은 상태에서만 부른다. */
  function patchRow(sql: string): void {
    const raw = new DatabaseSync(dbPath);
    raw.exec(sql);
    raw.close();
  }

  // v1 파일에서 올라온 행이 정확히 이 모양이다. 비어 있으면 "비교 불가"다.
  it('사실 지문이 비어 있는 기존 행은 한 번 갱신된 뒤 채워진다', async () => {
    const slack = new FakeSlack();
    const provider = new StubProvider();
    await digestOnce({ slack, provider });
    patchRow('UPDATE pr_message SET facts_fingerprint = NULL, summary_json = NULL');

    // 한 번은 요약한다. 비교할 값이 없으므로 재사용 판정이 miss다.
    const healing = await digestOnce({ slack, provider });
    expect(provider.calls).toHaveLength(2);
    expect(card(healing).summaryReused).toBe(false);
    // 카드 내용은 그대로이므로 Slack은 부르지 않는다. 그래도 지문은 남긴다.
    expect(card(healing).action).toBe('skip');
    expect(slack.updates).toHaveLength(0);

    // 그 한 번의 갱신으로 자가 치유된다. 다음 관찰부터는 부르지 않는다.
    const healed = await digestOnce({ slack, provider });
    expect(provider.calls).toHaveLength(2);
    expect(card(healed).summaryReused).toBe(true);
    expect(card(healed).action).toBe('skip');
  });

  it('저장된 요약을 되살릴 수 없으면 던지지 않고 다시 부른다', async () => {
    const slack = new FakeSlack();
    const provider = new StubProvider();
    await digestOnce({ slack, provider });
    // 저장 형식이 바뀌었거나 행이 손상된 경우다. 카드가 멈추면 안 된다.
    patchRow(`UPDATE pr_message SET summary_json = '{"title":42}'`);

    const second = await digestOnce({ slack, provider });
    expect(provider.calls).toHaveLength(2);
    expect(card(second).summaryReused).toBe(false);
    expect(card(second).action).toBe('skip');
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

  it('기존 카드에도 실제 실행과 같은 판정을 내리고 요약을 재사용한다', async () => {
    const provider = new StubProvider();
    const stillOpen = [prRow({ state: 'OPEN', mergedAt: null })];
    await digestOnce({ slack: new FakeSlack(), provider, prs: stillOpen });
    expect(provider.calls).toHaveLength(1);

    // 사실이 그대로다. dry-run도 provider를 부르지 않고 skip으로 보고한다.
    const unchanged = await digestOnce({ slack: null, provider, prs: stillOpen });
    expect(card(unchanged).action).toBe('skip');
    expect(card(unchanged).summaryReused).toBe(true);
    expect(provider.calls).toHaveLength(1);

    // merge 전이는 요약을 재사용한 채 update로 보고한다. 여전히 아무것도 쓰지 않는다.
    const merged = await digestOnce({ slack: null, provider });
    expect(card(merged).action).toBe('update');
    expect(card(merged).summaryReused).toBe(true);
    expect(provider.calls).toHaveLength(1);

    // dry-run이 store에 썼다면 이 실행은 skip으로 떨어진다. 여전히 update여야 한다.
    const live = await digestOnce({ slack: new FakeSlack(), provider });
    expect(card(live).action).toBe('update');
    expect(card(live).summaryReused).toBe(true);
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

  // "아무것도" 쓰지 않는 것이 아니다. PR↔Task 연관은 채널 게이트 앞에서 기록된다(OD-076).
  // 그쪽은 'PR↔Task 연관과 degraded 입력'의 채널 어긋남 테스트가 고정한다.
  it('매핑된 채널이 대상 채널과 다르면 Slack에 쓰지 않고 pr_message도 갱신하지 않는다', async () => {
    const first = new FakeSlack();
    await digestOnce({ slack: first });
    const before = readPrMessage(`pr:${REPO_ID}#7`);

    // 사실을 바꿔서 온다. 채널이 맞았다면 이 관찰은 chat.update와 updateObservation로 갔다.
    const changed = prRow({
      statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }],
    });
    const other = new FakeSlack();
    const report = await digestOnce({ slack: other, channel: 'C_OTHER', prs: [changed] });
    expect(card(report).action).toBe('channel_mismatch');
    expect(other.posts).toHaveLength(0);
    expect(other.updates).toHaveLength(0);
    expect(readPrMessage(`pr:${REPO_ID}#7`)).toEqual(before);
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

/**
 * PR↔Task N 연관(OD-076)과 run-only degraded 입력(OD-077).
 *
 * store를 직접 열어 확인한다. `runDigest`의 반환값에는 저장된 연관이 실려 있지 않고, OD-076이
 * 요구한 것은 "body가 latest 하나만 담아도 store에는 둘 다 남는다"이므로 판정 근거는 파일이다.
 */
describe('PR↔Task 연관과 degraded 입력', () => {
  /** 같은 store 파일을 다시 열어 저장된 연관을 읽는다. */
  function storedTasks(prKey: `pr:${number}#${number}`) {
    const store = new SqliteDigestStore(dbPath);
    try {
      return store.listPrTasks(prKey);
    } finally {
      store.close();
    }
  }

  const bodyFor = (task: string) =>
    ['사람이 읽는 본문', '', `<!-- orca-run: ${RUN} -->`, `<!-- orca-task: ${task} -->`].join('\n');

  it('두 Task가 한 PR을 갱신하면 body는 latest 하나이고 store에는 둘 다 남는다', async () => {
    const slack = new FakeSlack();
    const provider = new StubProvider();

    const first = await digestOnce({ slack, provider, prs: [prRow({ body: bodyFor(TASK) })] });
    expect(card(first).key).toBe(`pr:${REPO_ID}#7`);

    // 두 번째 관찰의 body는 latest Task 하나만 가리킨다. 형식도 parser도 그대로다(OD-076).
    const second = await digestOnce({ slack, provider, prs: [prRow({ body: bodyFor(SECOND_TASK) })] });
    expect(card(second).key).toBe(`pr:${REPO_ID}#7`);
    // 카드는 body의 latest Task 하나를 따른다. Task 목적이 그 Task의 제목으로 바뀐다.
    expect(provider.calls.map((f) => f.taskPurpose)).toEqual(['digest CLI 통합', '후속 수정']);

    const rows = storedTasks(`pr:${REPO_ID}#7`);
    // 이것이 OD-076의 검증이다. 앞 Task가 뒤 Task에 덮이지 않는다.
    expect(rows.map((r) => r.taskKey)).toEqual([`task:${TASK}`, `task:${SECOND_TASK}`]);
    expect(rows.every((r) => r.runKey === `run:${RUN}`)).toBe(true);
    // 루트는 하나뿐이다. Task가 바뀌었다고 카드를 새로 만들지 않는다.
    expect(slack.posts).toHaveLength(1);
  });

  it('같은 Task를 반복 관측해도 연관 행이 늘지 않는다', async () => {
    const slack = new FakeSlack();
    await digestOnce({ slack });
    await digestOnce({ slack });
    expect(storedTasks(`pr:${REPO_ID}#7`)).toHaveLength(1);
  });

  /**
   * `recordPrTask`가 채널 게이트 **앞에** 있다는 판단을 고정한다.
   *
   * correlation은 그 카드가 어느 Slack 채널로 가는지와 독립인 사실이다. 채널 설정이 어긋나
   * 카드를 갱신하지 못한 관찰에서도 PR과 Task의 관계는 관측된 것이고, 그 관계를 기록해 두는
   * 것이 OD-076이 durable store에 요구한 것이다. 호출을 게이트 뒤로 옮기면 이 테스트가 깨진다.
   */
  it('매핑된 채널과 어긋난 관찰에서도 그 관찰의 PR↔Task 연관은 기록된다', async () => {
    await digestOnce({ slack: new FakeSlack(), prs: [prRow({ body: bodyFor(TASK) })] });

    const other = new FakeSlack();
    const report = await digestOnce({
      slack: other,
      channel: 'C_OTHER',
      prs: [prRow({ body: bodyFor(SECOND_TASK) })],
    });
    expect(card(report).action).toBe('channel_mismatch');
    expect(other.posts).toHaveLength(0);
    expect(other.updates).toHaveLength(0);

    // 두 번째 Task는 이 어긋난 관찰에서만 관측됐다. 게이트 뒤에서 기록한다면 여기 남지 않는다.
    expect(storedTasks(`pr:${REPO_ID}#7`).map((r) => r.taskKey)).toEqual([
      `task:${TASK}`,
      `task:${SECOND_TASK}`,
    ]);
  });

  it('dry-run은 연관을 기록하지 않는다', async () => {
    await digestOnce({ slack: null });
    expect(storedTasks(`pr:${REPO_ID}#7`)).toEqual([]);
  });

  // OD-077. orca-run은 있고 필수 orca-task가 없는 입력이다.
  it('run-only PR은 degraded로 명시하고 카드도 연관도 만들지 않는다', async () => {
    const slack = new FakeSlack();
    const runOnly = prRow({
      number: 9,
      url: `https://github.com/${REPO}/pull/9`,
      title: 'fix: run만 있는 PR',
      headRefName: 'c2/correlation-store',
      body: ['사람이 읽는 본문', '', `<!-- orca-run: ${RUN} -->`].join('\n'),
    });
    const report = await digestOnce({ slack, prs: [runOnly] });

    expect(report.results).toEqual([
      { kind: 'skipped', key: `pr:${REPO_ID}#9`, reason: 'run_only_degraded' },
    ]);
    // Task 카드를 만들지 않는다.
    expect(slack.posts).toHaveLength(0);
    expect(slack.updates).toHaveLength(0);
    // branch 이름·제목·author로 Task를 보완하지 않는다. 저장된 연관이 없다는 것이 그 근거다.
    expect(storedTasks(`pr:${REPO_ID}#9`)).toEqual([]);

    // 사람이 읽는 출력에서 정상 출력과 구분된다.
    const out = formatReport(report);
    expect(out).toContain('invalid/degraded input');
    expect(out).toContain('OD-077');
  });

  it('uncorrelated는 정상 출력으로, run-only는 degraded로 서로 다르게 적는다', async () => {
    const out = formatReport(
      await digestOnce({
        slack: new FakeSlack(),
        prs: [
          prRow({ number: 8, url: `https://github.com/${REPO}/pull/8`, body: 'metadata 없는 본문' }),
          prRow({
            number: 9,
            url: `https://github.com/${REPO}/pull/9`,
            body: `<!-- orca-run: ${RUN} -->`,
          }),
        ],
      }),
    );
    expect(out).toContain('uncorrelated — 실패가 아니라 정상 출력이다(OD-022)');
    expect(out).toContain('run_only_degraded — invalid/degraded input이다');
  });
});
