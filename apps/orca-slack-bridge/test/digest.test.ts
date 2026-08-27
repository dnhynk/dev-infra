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
import { SlackWebApiPoster } from '../src/slack/post.js';
import type {
  PostMessageInput,
  PostedMessage,
  SlackPoster,
  ThreadPoster,
  ThreadReplyInput,
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
/** 이 PR과 무관한 Run. 관측 1회가 모든 Run을 훑기 때문에 같은 목록에 섞여 온다(OD-079). */
const FOREIGN_RUN = 'run_59bccb319e7f';
const FOREIGN_TASK = 'task_5694362d24f8';
/**
 * 실측된 깨진 `result`. 따옴표가 없어 JSON으로 읽히지 않는다.
 *
 * `orca orchestration task-list --run run_59bccb319e7f --json`(2026-08-24)의
 * `task_5694362d24f8` `result`를 그대로 옮겼다. 이전 세션의 throwaway probe가 남긴 값이고
 * 이 Run과 아무 관계가 없다.
 */
const BROKEN_RESULT =
  '{kind:reviewer_result,schemaVersion:1,verdict:approve,pr:{repo:THROWAWAY/none,number:10},' +
  'reviewedHeadSha:deadbeef,findings:[],gates:{evidence_discipline:pass},note:two words}';
/**
 * 나머지 세 칸의 깨진 row. `foreign`이 만드는 깨진 `result`와 같은 Run에 얹는다(OD-079).
 *
 * `run-list`에도 `inbox`에도 필터가 없으므로 관측 1회가 이 넷을 한 번에 만난다. 한 칸만
 * 가두면 나머지가 그대로 관측을 중단시킨다.
 */
const FOREIGN_DEPS_TASK = 'task_baddeps001';
const FOREIGN_SHAPE_TASK = 'task_badshape01';
const FOREIGN_GATE = 'gate_badoptions1';
const BROKEN_MESSAGE = 'msg_badpayload1';

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
  constructor(
    /** null이면 reviewer task 자체가 없다. 리뷰 전 상태를 만든다. */
    private readonly verdict: 'approve' | 'request_changes' | null = 'approve',
    /** 참이면 깨진 result를 가진 무관한 Run 하나를 관측에 섞는다(OD-079). */
    private readonly foreign = false,
    /**
     * 참이면 나머지 세 칸(`deps`·reviewer_result shape·`options`)과 깨진 `payload`도 섞는다.
     *
     * `foreign`과 따로 둔다. 깨진 `result` 한 칸만 있는 관측과 네 칸이 모두 깨진 관측이 서로
     * 다른 사실이고, 둘을 한 플래그로 묶으면 어느 쪽이 고정됐는지 알 수 없다.
     */
    private readonly brokenFields = false,
  ) {}
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
            consumer_generation: 1,
            legacy: 0,
            created_at: '2026-08-22T00:00:00Z',
            updated_at: '2026-08-22T00:00:00Z',
          },
          ...(this.foreign
            ? [
                {
                  id: FOREIGN_RUN,
                  objective: 'THROWAWAY PR10 reviewer probe',
                  coordinator_handle: 'term_1235a5d1',
                  coordinator_pane_key: 'e119e82a:ed65e315',
                  legacy: 0,
                  created_at: '2026-08-23T04:50:00Z',
                  updated_at: '2026-08-23T04:52:36Z',
                },
              ]
            : []),
        ],
      });
    }
    if (args[1] === 'task-list' && args[3] === FOREIGN_RUN) {
      return wrap({
        tasks: [
          {
            id: FOREIGN_TASK,
            run_id: FOREIGN_RUN,
            task_title: 'THROWAWAY PR10 reviewer probe',
            display_name: 'THROWAWAY PR10 reviewer probe',
            status: 'completed',
            deps: '[]',
            result: BROKEN_RESULT,
            created_by_process_incarnation: 'ccb3c8ee::C:/review-pr10@@43d9a730:df5d1fc8',
            created_by_terminal_handle: 'term_6354ef22', created_by_pane_key: 'pane:1',
            created_by_run_generation: 1,
            created_at: '2026-08-23 04:50:32',
            completed_at: '2026-08-23T04:52:36.700Z',
          },
          ...(this.brokenFields
            ? [
                {
                  id: FOREIGN_DEPS_TASK,
                  run_id: FOREIGN_RUN,
                  task_title: 'deps가 깨진 probe',
                  display_name: 'deps가 깨진 probe',
                  status: 'completed',
                  deps: '[task_1,task_2]',
                  result: '{"provenance":"worker_report"}',
                  created_by_process_incarnation: 'ccb3c8ee::C:/review-pr10@@43d9a730:df5d1fc8',
                  created_by_terminal_handle: 'term_6354ef22', created_by_pane_key: 'pane:1',
                  created_by_run_generation: 1,
                  created_at: '2026-08-23 04:50:33',
                  completed_at: '2026-08-23T04:52:37.700Z',
                },
                {
                  id: FOREIGN_SHAPE_TASK,
                  run_id: FOREIGN_RUN,
                  task_title: 'shape가 깨진 probe',
                  display_name: 'shape가 깨진 probe',
                  status: 'completed',
                  deps: '[]',
                  // JSON으로는 읽히지만 OD-073 v1 shape가 아니다.
                  result: JSON.stringify({
                    kind: 'reviewer_result',
                    schemaVersion: 1,
                    verdict: 'lgtm',
                    pr: { repo: REPO, number: 7 },
                    findings: [],
                  }),
                  created_by_process_incarnation: 'ccb3c8ee::C:/review-pr10@@43d9a730:df5d1fc8',
                  created_by_terminal_handle: 'term_6354ef22', created_by_pane_key: 'pane:1',
                  created_by_run_generation: 1,
                  created_at: '2026-08-23 04:50:34',
                  completed_at: '2026-08-23T04:52:38.700Z',
                },
              ]
            : []),
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
            created_by_terminal_handle: 'term_1',
            created_by_pane_key: 'a:b',
            created_by_run_generation: 1,
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
            created_by_terminal_handle: 'term_1',
            created_by_pane_key: 'a:b',
            created_by_run_generation: 1,
            created_at: '2026-08-22 00:05:00',
            completed_at: '2026-08-22 01:05:00',
          },
          ...(this.verdict === null
            ? []
            : [
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
                    verdict: this.verdict,
                    pr: { repo: REPO, number: 7 },
                    reviewedHeadSha: HEAD,
                    findings: [
                      { severity: 'minor', file: 'src/a.ts', line: 3, summary: '주석이 부족하다' },
                    ],
                  }),
                  created_by_process_incarnation: 'uuid::D:/dev-infra@@h:i',
                  created_by_terminal_handle: 'term_1',
                  created_by_pane_key: 'a:b',
                  created_by_run_generation: 1,
                  created_at: '2026-08-22 00:10:00',
                  completed_at: '2026-08-22 01:10:00',
                },
              ]),
        ],
      });
    }
    if (args[1] === 'gate-list' && args[3] === FOREIGN_RUN && this.brokenFields) {
      return wrap({
        gates: [
          {
            id: FOREIGN_GATE,
            run_id: FOREIGN_RUN,
            task_id: FOREIGN_TASK,
            question: '어느 쪽으로 갈까',
            options: '[A,B]',
            status: 'pending',
            resolution: null,
            created_at: '2026-08-23 04:51:00',
            resolved_at: null,
          },
          {
            id: 'gate_ok0000001',
            run_id: FOREIGN_RUN,
            task_id: FOREIGN_TASK,
            question: '정상 gate',
            options: '["A","B"]',
            status: 'resolved',
            resolution: 'A',
            created_at: '2026-08-23 04:51:01',
            resolved_at: '2026-08-23 04:52:00',
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
          ...(this.brokenFields
            ? [
                {
                  id: BROKEN_MESSAGE,
                  run_id: FOREIGN_RUN,
                  type: 'worker_done',
                  subject: '완료',
                  body: '했다. 봤다. 남았다.',
                  payload: '{taskId:task_1,outcome:succeeded}',
                  created_at: '2026-08-23 04:52:00',
                },
              ]
            : []),
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

/** rollup row 하나를 덮어쓸 값. C2-3은 같은 resource의 진행/완료 두 snapshot을 만들어야 한다. */
type CheckOver = Record<string, unknown>;

/** head rollup GraphQL 응답. checks는 PR row가 아니라 이 응답에서 온다(`github/rollup.ts`). */
function rollupJson(conclusion: string, over: CheckOver = {}): string {
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
                      ...over,
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

/** GitHub 대역이 흉내낼 base branch 정책과 rollup row. 기본은 dev-infra 실측과 같은 미보호다. */
type GhOver = {
  /** classic protection이 요구하는 context 목록. 없으면 404(미보호)다. */
  readonly requiredContexts?: readonly string[];
  /** rollup row 덮어쓰기. 같은 head의 진행과 완료를 순서를 바꿔 관측할 때 쓴다. */
  readonly checkOver?: CheckOver;
};

class FakeGh implements GhRunner {
  constructor(
    private readonly prs: readonly PrRow[],
    private readonly buildConclusion = 'SUCCESS',
    private readonly over: GhOver = {},
  ) {}
  async run(args: readonly string[]): Promise<string> {
    const path = args[1] ?? '';
    // required rule 조회. 기본 fixture repo는 protection도 ruleset도 없다(dev-infra 실측과 같다).
    if (args[0] === 'api' && path.includes('/protection/required_status_checks')) {
      const contexts = this.over.requiredContexts;
      if (contexts === undefined) {
        throw new GhCommandError(args, 1, 'gh: Branch not protected (HTTP 404)');
      }
      return JSON.stringify({
        contexts,
        checks: contexts.map((c) => ({ context: c, app_id: null })),
      });
    }
    if (args[0] === 'api' && args.join(' ').includes('/rules/branches/')) return '[]';
    if (args[0] === 'api' && args[1] === 'graphql') {
      return rollupJson(this.buildConclusion, this.over.checkOver);
    }
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

/** thread write 경계 대역. 실제 Slack을 부르지 않고 `digest`의 게시 순서만 본다. */
class FakeThread implements ThreadPoster {
  readonly replies: ThreadReplyInput[] = [];
  private seq = 0;
  async reply(input: ThreadReplyInput): Promise<PostedMessage> {
    this.replies.push(input);
    this.seq += 1;
    return { channel: input.channel, ts: `1700000001.00000${this.seq}` };
  }
}

/** 게시가 실패하는 대역. 실패한 게시가 ledger에 행을 남기지 않는지 본다. */
class FailingThread implements ThreadPoster {
  async reply(): Promise<PostedMessage> {
    throw new Error('thread reply가 실패했다');
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
  projects: [{ name: 'demo', repositories: [REPO], orcaRepositoryIds: [] }],
  correlationKeys: DEFAULT_CORRELATION_KEYS,
};

type Once = {
  readonly prs?: readonly PrRow[];
  /** head rollup의 `build` 결론. 사실이 바뀌는 경우를 만든다. */
  readonly buildConclusion?: string;
  readonly slack?: SlackPoster | null;
  readonly provider?: SummaryProvider;
  readonly summaryMode?: 'model' | 'facts_only';
  readonly onlyPr?: number | null;
  readonly channel?: string;
  /** thread 게시 경계. 넘기지 않으면 null이고 전이는 `unposted`로 남는다. */
  readonly thread?: ThreadPoster | null;
  /** reviewer verdict. null이면 reviewer task 자체가 없어 리뷰 전 상태가 된다. */
  readonly verdict?: 'approve' | 'request_changes' | null;
  /** 참이면 깨진 result를 가진 무관한 Run 하나가 관측에 섞인다(OD-079). */
  readonly foreign?: boolean;
  /** 참이면 `deps`·reviewer_result shape·`options`·`payload`의 깨진 row도 함께 섞인다(OD-079). */
  readonly brokenFields?: boolean;
  readonly gh?: GhOver;
};

/** 매 실행이 store 파일을 새로 연다. 재시작 뒤에도 매핑을 찾는지 함께 본다. */
async function digestOnce(opts: Once = {}): Promise<DigestReport> {
  const store = new SqliteDigestStore(dbPath);
  try {
    return await runDigest(
      new FakeOrca(
        opts.verdict === undefined ? 'approve' : opts.verdict,
        opts.foreign ?? false,
        opts.brokenFields ?? false,
      ),
      new FakeGh(opts.prs ?? [prRow()], opts.buildConclusion, opts.gh),
      {
        config: CONFIG,
        channel: opts.channel ?? CHANNEL,
        store,
        slack: opts.slack === undefined ? new FakeSlack() : opts.slack,
        thread: opts.thread ?? null,
        provider: opts.provider ?? new StubProvider(),
        cache: new MemorySummaryCache(),
        ...(opts.summaryMode === undefined ? {} : { summaryMode: opts.summaryMode }),
        prLimit: 50,
        onlyPr: opts.onlyPr ?? null,
        now: () => new Date('2026-08-22T02:00:00Z'),
      },
    );
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
  it('daemon facts-only mode ignores a present model key and performs zero provider calls', async () => {
    const previous = process.env['ORCA_SLACK_BRIDGE_OPENAI_KEY'];
    process.env['ORCA_SLACK_BRIDGE_OPENAI_KEY'] = 'present-but-must-not-be-used';
    const trap = new StubProvider();
    try {
      const report = await digestOnce({ provider: trap, summaryMode: 'facts_only' });
      expect(trap.calls).toHaveLength(0);
      expect(card(report).summary).toMatchObject({
        kind: 'failed', reason: 'daemon facts-only mode',
      });
    } finally {
      if (previous === undefined) delete process.env['ORCA_SLACK_BRIDGE_OPENAI_KEY'];
      else process.env['ORCA_SLACK_BRIDGE_OPENAI_KEY'] = previous;
    }
  });
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
  it('isolates a failed repository without publishing its collected prefix or blocking the next repo', async () => {
    const repositories = ['good/one', 'bad/two', 'good/three'] as const;
    const ids = new Map(repositories.map((name, index) => [name, index + 1]));
    const ghCalls: string[][] = [];
    const gh: GhRunner = {
      run: async (args) => {
        ghCalls.push([...args]);
        const joined = args.join(' ');
        if (args[0] === 'api' && args[1]?.startsWith('repos/') &&
            !joined.includes('/branches/') && !joined.includes('/rules/')) {
          const name = args[1].slice('repos/'.length) as typeof repositories[number];
          return JSON.stringify({ id: ids.get(name), full_name: name });
        }
        if (args[0] === 'pr' && args[1] === 'list') {
          const name = args[args.indexOf('--repo') + 1];
          if (name === 'good/three') return '[]';
          return JSON.stringify([prRow({ url: `https://github.com/${name}/pull/7` })]);
        }
        if (args[0] === 'api' && args[1] === 'graphql') {
          if (joined.includes('owner=bad') && joined.includes('name=two')) {
            throw new Error('repository-local GraphQL failure');
          }
          return rollupJson('SUCCESS');
        }
        if (joined.includes('/protection/required_status_checks')) {
          throw new GhCommandError(args, 1, 'gh: Branch not protected (HTTP 404)');
        }
        if (joined.includes('/rules/branches/')) return '[]';
        throw new Error(`unexpected isolated gh command: ${joined}`);
      },
    };
    const config: BridgeConfig = {
      ...CONFIG,
      projects: [{ name: 'isolation', repositories: [...repositories], orcaRepositoryIds: [] }],
    };
    const slack = new FakeSlack();
    const store = new SqliteDigestStore(dbPath);
    try {
      const report = await runDigest(new FakeOrca(), gh, {
        config, channel: CHANNEL, store, slack, thread: null,
        summaryMode: 'facts_only', prLimit: 10, onlyPr: null,
        repositories, isolateRepositoryFailures: true,
        now: () => new Date('2026-08-22T02:00:00Z'),
      });
      expect(report.repositoryFailures).toEqual([
        { repository: 'bad/two', reason: 'query_failed' },
      ]);
      expect(slack.posts).toHaveLength(1);
      expect(store.findPrMessage(`pr:1#7`)).not.toBeNull();
      expect(store.findPrMessage(`pr:2#7`)).toBeNull();
      expect(ghCalls.some((args) => args.includes('good/three'))).toBe(true);
    } finally {
      store.close();
    }
  });

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
        thread: null,
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

/** 리뷰 전 open PR. 전이가 아직 하나도 없는 상태를 만든다. */
const OPEN_ROW = { state: 'OPEN', mergedAt: null };

/** 같은 store 파일을 다시 열어 저장된 직전 관측 상태를 읽는다. store를 열지 않은 상태에서만 부른다. */
function readPrState(prKey: `pr:${number}#${number}`) {
  const store = new SqliteDigestStore(dbPath);
  try {
    return store.findPrState(prKey);
  } finally {
    store.close();
  }
}

/** 같은 store 파일을 다시 열어 기록된 전이를 읽는다. store를 열지 않은 상태에서만 부른다. */
function readThreadEvents(prKey: `pr:${number}#${number}`) {
  const store = new SqliteDigestStore(dbPath);
  try {
    return store.listThreadEvents(prKey);
  } finally {
    store.close();
  }
}

const PR_KEY = `pr:${REPO_ID}#7` as const;

/**
 * 전이 판정과 thread 1회 기록(OD-044, OD-046).
 *
 * 실제 sqlite 파일을 쓴다. store를 모킹하면 검증 대상인 "재시작해도 중복 reply가 없다"의 근거가
 * 사라진다. 매 `digestOnce`가 store 파일을 새로 열므로 각 호출이 곧 재시작이다.
 */
describe('runDigest 전이', () => {
  // OD-046: 이전 상태를 모르면 지금 참인 사실을 전이로 쏟아내지 않는다. 이 fixture PR은 이미
  // merged이고 approve된 상태로 처음 관측되므로, 재생했다면 두 건이 thread에 나갔을 것이다.
  it('첫 관측은 전이를 게시하지 않고 기준선으로만 남긴다', async () => {
    const thread = new FakeThread();
    const report = await digestOnce({ thread });

    expect(thread.replies).toHaveLength(0);
    expect(card(report).transitions.map((t) => [t.kind, t.outcome])).toEqual([
      ['review_approved', 'baseline'],
      ['merged', 'baseline'],
    ]);
    // 기준선은 durable하다. 게시하지 않았다는 사실이 행에 남는다.
    expect(readThreadEvents(PR_KEY).map((e) => [e.kind, e.messageTs])).toEqual([
      ['review_approved', null],
      ['merged', null],
    ]);
  });

  it('같은 snapshot을 다시 관측하면 전이가 0건이다', async () => {
    const thread = new FakeThread();
    await digestOnce({ thread });
    const second = await digestOnce({ thread });

    expect(card(second).transitions).toEqual([]);
    expect(thread.replies).toHaveLength(0);
  });

  // 이 Task의 핵심 경로다. 리뷰 전 → approve로 바뀌면 thread에 한 줄이 나간다.
  it('새 사실이 관측되면 thread에 한 번 나간다', async () => {
    const thread = new FakeThread();
    await digestOnce({ thread, verdict: null, prs: [prRow(OPEN_ROW)] });
    // 첫 관측에는 후보 자체가 없다. 리뷰도 required rule도 없고 open이다.
    expect(readThreadEvents(PR_KEY)).toEqual([]);

    const second = await digestOnce({ thread, verdict: 'approve', prs: [prRow(OPEN_ROW)] });

    expect(card(second).transitions.map((t) => [t.kind, t.outcome])).toEqual([
      ['review_approved', 'posted'],
    ]);
    expect(thread.replies).toHaveLength(1);
    expect(thread.replies[0]?.threadTs).toBe('1700000000.000001');
    expect(thread.replies[0]?.channel).toBe(CHANNEL);
    expect(JSON.stringify(thread.replies[0]?.blocks)).toContain('리뷰 통과');
    // 게시한 reply의 ts가 행에 남는다. seed 행과 구분된다.
    expect(readThreadEvents(PR_KEY).map((e) => e.messageTs)).toEqual(['1700000001.000001']);
  });

  it('같은 전이를 다시 관측해도 두 번 나가지 않는다', async () => {
    const thread = new FakeThread();
    await digestOnce({ thread, verdict: null, prs: [prRow(OPEN_ROW)] });
    await digestOnce({ thread, verdict: 'approve', prs: [prRow(OPEN_ROW)] });
    const third = await digestOnce({ thread, verdict: 'approve', prs: [prRow(OPEN_ROW)] });

    expect(card(third).transitions).toEqual([]);
    expect(thread.replies).toHaveLength(1);
  });

  // **dedupe key가 load-bearing한 자리다.** 판정 근거가 프로세스 메모리가 아니라 store 파일이다.
  // 별도의 poster 인스턴스 = 프로세스 재시작에 해당한다.
  it('재시작해도 중복 reply를 만들지 않는다', async () => {
    const first = new FakeThread();
    await digestOnce({ thread: first, verdict: null, prs: [prRow(OPEN_ROW)] });
    await digestOnce({ thread: first, verdict: 'approve', prs: [prRow(OPEN_ROW)] });
    expect(first.replies).toHaveLength(1);

    const restarted = new FakeThread();
    const report = await digestOnce({
      thread: restarted,
      verdict: 'approve',
      prs: [prRow(OPEN_ROW)],
    });

    expect(restarted.replies).toHaveLength(0);
    expect(card(report).transitions).toEqual([]);
    expect(readThreadEvents(PR_KEY)).toHaveLength(1);
  });

  // 게시 경계가 없으면 기록하지 않는다. 기록만 하면 그 전이가 영영 사라진다.
  it('thread 경계가 없으면 unposted로 남고 다음 관측의 후보로 돌아온다', async () => {
    await digestOnce({ verdict: null, prs: [prRow(OPEN_ROW)] });
    const withoutThread = await digestOnce({ verdict: 'approve', prs: [prRow(OPEN_ROW)] });
    expect(card(withoutThread).transitions.map((t) => t.outcome)).toEqual(['unposted']);
    expect(readThreadEvents(PR_KEY)).toEqual([]);

    const thread = new FakeThread();
    const withThread = await digestOnce({ thread, verdict: 'approve', prs: [prRow(OPEN_ROW)] });
    expect(card(withThread).transitions.map((t) => t.outcome)).toEqual(['posted']);
    expect(thread.replies).toHaveLength(1);
  });

  // **행은 게시가 성공한 뒤에 쓴다.** 실패한 게시에 행을 남기면 그 전이는 이미 말한 것으로
  // 걸러져 영영 나가지 않는다. `settle`의 순서를 뒤집으면 이 테스트가 걸린다.
  it('게시가 던지면 행을 남기지 않고 다음 관측의 후보로 돌아온다', async () => {
    await digestOnce({ verdict: null, prs: [prRow(OPEN_ROW)] });
    expect(readThreadEvents(PR_KEY)).toEqual([]);

    await expect(
      digestOnce({ thread: new FailingThread(), verdict: 'approve', prs: [prRow(OPEN_ROW)] }),
    ).rejects.toThrow('thread reply가 실패했다');
    expect(readThreadEvents(PR_KEY)).toEqual([]);

    const thread = new FakeThread();
    const recovered = await digestOnce({ thread, verdict: 'approve', prs: [prRow(OPEN_ROW)] });

    expect(card(recovered).transitions.map((t) => [t.kind, t.outcome])).toEqual([
      ['review_approved', 'posted'],
    ]);
    expect(thread.replies).toHaveLength(1);
    expect(readThreadEvents(PR_KEY).map((e) => e.messageTs)).toEqual(['1700000001.000001']);
  });

  /**
   * 같은 계약을 **프로덕션 구현**으로 다시 본다.
   *
   * 위 두 테스트의 대역은 `ThreadPoster`를 손으로 구현한 것이라, 실제 게시 경계가 실패를
   * 삼키거나 재시도하면 그대로 지나간다. 여기서는 `SlackWebApiPoster`를 `thread`로 넣고
   * Slack 응답만 대역으로 둔다. 실제 Slack은 부르지 않는다.
   */
  it('실제 poster로도 실패한 게시는 행을 남기지 않고 재시도하지 않는다', async () => {
    const calls: string[] = [];
    const fetchWith = (body: unknown): typeof fetch =>
      async (_url, init) => {
        calls.push(String((init ?? {}).body));
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
    const posterWith = (body: unknown): SlackWebApiPoster =>
      new SlackWebApiPoster({
        token: ['xoxb', 'FAKE', 'NOTAREALBOTTOKENVALUE'].join('-'),
        fetchImpl: fetchWith(body),
        sleep: async () => {},
      });

    await digestOnce({ verdict: null, prs: [prRow(OPEN_ROW)] });

    // 게시 여부를 알 수 없는 실패다. 재시도하면 thread에 같은 전이가 두 번 남는다.
    await expect(
      digestOnce({
        thread: posterWith({ ok: false, error: 'internal_error' }),
        verdict: 'approve',
        prs: [prRow(OPEN_ROW)],
      }),
    ).rejects.toThrow('internal_error');
    expect(calls).toHaveLength(1);
    expect(readThreadEvents(PR_KEY)).toEqual([]);

    const ok = posterWith({ ok: true, channel: CHANNEL, ts: '1700000002.000002' });
    const recovered = await digestOnce({ thread: ok, verdict: 'approve', prs: [prRow(OPEN_ROW)] });

    expect(card(recovered).transitions.map((t) => [t.kind, t.outcome])).toEqual([
      ['review_approved', 'posted'],
    ]);
    // 저장된 루트의 ts가 실제 요청의 thread_ts로 실렸다. 이 값이 빠지면 루트가 하나 더 생긴다.
    expect(JSON.parse(calls[1]!)['thread_ts']).toBe(readPrMessage(PR_KEY)?.messageTs);
    // ledger는 Slack이 준 ts를 그대로 기록한다.
    expect(readThreadEvents(PR_KEY).map((e) => e.messageTs)).toEqual(['1700000002.000002']);
  });
});

/**
 * 오래된 상태가 merged를 되돌리지 않는다(로드맵 §6 출구 조건, OD-044).
 *
 * `reconcileTerminal`의 프로덕션 호출자는 `digest/digest.ts` 하나이며 여기서 그 배선을 본다.
 * 순수 함수 자체는 `transition.test.ts`가 본다.
 */
describe('runDigest terminal dominance', () => {
  it('merged 뒤에 도착한 open snapshot이 카드를 되돌리지 않는다', async () => {
    const slack = new FakeSlack();
    const merged = await digestOnce({ slack });
    expect(card(merged).card.text).toContain('병합 완료');

    // 같은 PR이 open으로 보이는 오래된 snapshot이다. mergedAt도 없다.
    const stale = await digestOnce({ slack, prs: [prRow(OPEN_ROW)] });

    expect(card(stale).card.text).toContain('병합 완료');
    // 카드가 그대로이므로 chat.update조차 필요 없다.
    expect(card(stale).action).toBe('skip');
    expect(slack.updates).toHaveLength(0);
    // 저장된 상태도 내려가지 않는다. latch의 발생 시각까지 유지한다.
    expect(readPrState(PR_KEY)?.terminal).toBe('merged');
    expect(readPrState(PR_KEY)?.mergedAt).toBe('2026-08-22T01:20:00Z');
  });

  it('되돌림을 전이로 만들지 않는다', async () => {
    const thread = new FakeThread();
    await digestOnce({ thread });
    const stale = await digestOnce({ thread, prs: [prRow(OPEN_ROW)] });

    expect(card(stale).transitions).toEqual([]);
    expect(thread.replies).toHaveLength(0);
  });
});

/**
 * 역순 관측 복구(OD-044).
 *
 * 동일 head 안의 check는 각 resource의 timestamp와 id로 reconcile한다. 완료 snapshot 뒤에 늦게
 * 도착한 진행 snapshot이 완료를 되돌리면 카드의 required check 축이 거짓을 말한다.
 */
describe('runDigest check 역순 관측', () => {
  const REQUIRED = { requiredContexts: ['build'] } as const;
  /** 같은 resource(`CR_build`)의 진행 중 snapshot. id는 같고 완료 시각만 없다. */
  const RUNNING = {
    checkOver: { status: 'IN_PROGRESS', conclusion: null, completedAt: null },
    requiredContexts: ['build'],
  } as const;

  it('완료 뒤에 도착한 진행 snapshot이 카드의 축을 되돌리지 않는다', async () => {
    const slack = new FakeSlack();
    const done = await digestOnce({ slack, gh: REQUIRED });
    expect(JSON.stringify(card(done).card.blocks)).toContain('required check: 모두 통과');

    const late = await digestOnce({ slack, gh: RUNNING });

    expect(JSON.stringify(card(late).card.blocks)).toContain('required check: 모두 통과');
    expect(card(late).action).toBe('skip');
    expect(slack.updates).toHaveLength(0);
  });

  it('진행 뒤에 도착한 완료 snapshot은 그대로 반영한다', async () => {
    const slack = new FakeSlack();
    const running = await digestOnce({ slack, gh: RUNNING });
    expect(JSON.stringify(card(running).card.blocks)).toContain(
      'required check: 아직 결론 나지 않은 것이 있다',
    );

    const done = await digestOnce({ slack, gh: REQUIRED });

    expect(JSON.stringify(card(done).card.blocks)).toContain('required check: 모두 통과');
    expect(card(done).action).toBe('update');
  });

  // 진행 → 완료는 실제 전이다. 위 역순 사례와 달리 thread에 나가야 한다.
  it('진행에서 완료로 바뀌면 check 전이가 한 번 나간다', async () => {
    const thread = new FakeThread();
    await digestOnce({ thread, gh: RUNNING });
    const done = await digestOnce({ thread, gh: REQUIRED });

    expect(card(done).transitions.map((t) => [t.kind, t.outcome])).toEqual([
      ['checks_passing', 'posted'],
    ]);
    expect(JSON.stringify(thread.replies[0]?.blocks)).toContain('required check 통과');
  });
});

/**
 * dry-run과 채널 불일치에서의 전이 처리.
 *
 * 둘 다 store에 대한 규율이 이미 정해져 있고, 전이도 그 규율을 따른다.
 */
describe('runDigest 전이 경계', () => {
  it('dry-run은 상태도 전이도 저장하지 않고 결정만 보고한다', async () => {
    const thread = new FakeThread();
    const report = await digestOnce({ slack: null, thread });

    // 게시하지 않은 카드의 기준선을 남기면 다음 실제 실행이 그 전이를 영영 내보내지 않는다.
    expect(readPrState(PR_KEY)).toBeNull();
    expect(readThreadEvents(PR_KEY)).toEqual([]);
    expect(thread.replies).toHaveLength(0);
    // 무엇을 하기로 했는지는 그대로 보고한다. 그것이 dry-run의 쓸모다.
    expect(card(report).transitions.map((t) => [t.kind, t.outcome])).toEqual([
      ['review_approved', 'baseline'],
      ['merged', 'baseline'],
    ]);
  });

  it('채널이 어긋나면 상태는 남기고 thread에는 쓰지 않는다', async () => {
    const thread = new FakeThread();
    await digestOnce({ thread, verdict: null, prs: [prRow(OPEN_ROW)] });

    const mismatched = await digestOnce({
      thread,
      verdict: 'approve',
      prs: [prRow(OPEN_ROW)],
      channel: 'C_OTHER_CHANNEL',
    });

    expect(card(mismatched).action).toBe('channel_mismatch');
    // 어느 채널의 어느 루트에 매달지 확정할 수 없으므로 게시하지 않는다.
    expect(thread.replies).toHaveLength(0);
    expect(card(mismatched).transitions.map((t) => t.outcome)).toEqual(['unposted']);
    // 관측한 사실 자체는 남는다(`recordPrTask`와 같은 근거).
    expect(readPrState(PR_KEY)?.reviewVerdict).toBe('approve');
  });
});

/**
 * 깨진 row 하나가 관측 전체를 죽이지 않는다(OD-079).
 *
 * 실제로 재현된 실패다. `origin/main` 9b9decbb에서 `digest --pr 25 --dry-run`이 stdout 0바이트에
 * exit 1로 끝났고, 원인은 이 Run과 무관한 `run_59bccb319e7f`의 row 하나였다.
 *
 * 봉쇄 대상은 네 호출부다. 여기서는 관찰 1회가 넷을 모두 만났을 때 보고가 넷을 다 싣는지 본다.
 * 칸마다의 봉쇄 자체는 `project.test.ts`의 '깨진 task result 봉쇄'가 고정한다.
 */
describe('runDigest 깨진 task result 봉쇄', () => {
  it('무관한 Run의 깨진 row가 있어도 나머지는 그대로 관측된다', async () => {
    const withBroken = await digestOnce({ foreign: true });
    const clean = await digestOnce({ slack: null });

    // 카드는 깨진 row가 없을 때와 같다. 봉쇄가 정상 경로를 바꾸지 않는다.
    expect(card(withBroken).card).toEqual(card(clean).card);
    expect(card(withBroken).fingerprint).toBe(card(clean).fingerprint);
  });

  it('어느 Run의 어느 task가 왜 실패했는지 사실로 남긴다', async () => {
    const report = await digestOnce({ foreign: true });
    expect(report.degraded).toHaveLength(1);
    expect(report.degraded[0]).toMatchObject({
      runId: FOREIGN_RUN,
      subject: 'task',
      id: FOREIGN_TASK,
      field: 'result',
    });
    // 이유는 `parseJsonField`가 만든 메시지 그대로다. 읽지 못한 값이 그 안에 남는다.
    expect(report.degraded[0]?.reason).toContain('JSON 필드를 파싱할 수 없다');
    expect(report.degraded[0]?.reason).toContain('{kind:reviewer_result');
  });

  it('깨진 row가 없으면 degraded도 비어 있다', async () => {
    expect((await digestOnce({})).degraded).toEqual([]);
  });

  it('사람이 읽는 보고가 그 사실을 숨기지 않는다', async () => {
    const text = formatReport(await digestOnce({ foreign: true }));
    expect(text).toContain(`${FOREIGN_RUN} / ${FOREIGN_TASK}`);
    expect(text).toContain('읽지 못한 칸 1건');
    // 깨진 row가 있어도 카드는 그대로 나온다.
    expect(text).toContain('카드 1건');
  });

  /**
   * 네 호출부가 한 관찰에 모두 걸린 경우.
   *
   * `run-list`에도 `inbox`에도 필터가 없으므로 이것이 실제로 일어나는 모양이다. 한 칸만 가두면
   * 나머지가 그대로 관측을 중단시킨다.
   */
  it('네 칸의 깨진 row가 모두 있어도 관측은 끝까지 간다', async () => {
    const withBroken = await digestOnce({ foreign: true, brokenFields: true });
    const clean = await digestOnce({ slack: null });
    // 카드는 깨진 row가 없을 때와 같다. 봉쇄가 정상 경로를 바꾸지 않는다.
    expect(card(withBroken).card).toEqual(card(clean).card);
    expect(card(withBroken).fingerprint).toBe(card(clean).fingerprint);
  });

  it('읽지 못한 네 칸을 한 목록에 runId·row id·칸 이름과 함께 싣는다', async () => {
    const report = await digestOnce({ foreign: true, brokenFields: true });
    expect(
      report.degraded.map((d) => [d.runId, d.subject, d.id, d.field]),
    ).toEqual([
      [FOREIGN_RUN, 'task', FOREIGN_TASK, 'result'],
      [FOREIGN_RUN, 'task', FOREIGN_DEPS_TASK, 'deps'],
      [FOREIGN_RUN, 'task', FOREIGN_SHAPE_TASK, 'result.reviewer_result'],
      [FOREIGN_RUN, 'gate', FOREIGN_GATE, 'options'],
      [FOREIGN_RUN, 'worker_done', BROKEN_MESSAGE, 'payload'],
    ]);
    // 이유는 각 엄격 parser가 만든 메시지 그대로다.
    const reason = (id: string): string =>
      report.degraded.find((d) => d.id === id)?.reason ?? '';
    expect(reason(FOREIGN_DEPS_TASK)).toContain('[task_1,task_2]');
    expect(reason(FOREIGN_SHAPE_TASK)).toContain('verdict가 approve/request_changes가 아니다');
    expect(reason(FOREIGN_GATE)).toContain('[A,B]');
    expect(reason(BROKEN_MESSAGE)).toContain('{taskId:task_1,outcome:succeeded}');
  });

  it('사람이 읽는 보고가 네 칸을 모두 드러낸다', async () => {
    const text = formatReport(await digestOnce({ foreign: true, brokenFields: true }));
    expect(text).toContain(`${FOREIGN_RUN} / ${FOREIGN_DEPS_TASK} · task.deps`);
    expect(text).toContain(`${FOREIGN_RUN} / ${FOREIGN_SHAPE_TASK} · task.result.reviewer_result`);
    expect(text).toContain(`${FOREIGN_RUN} / ${FOREIGN_GATE} · gate.options`);
    expect(text).toContain(`${FOREIGN_RUN} / ${BROKEN_MESSAGE} · worker_done.payload`);
    expect(text).toContain('읽지 못한 칸 5건');
    expect(text).toContain('카드 1건');
  });
});
