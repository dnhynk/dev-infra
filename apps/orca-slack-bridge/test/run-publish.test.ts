import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishRunCard, publishRunCollection } from '../src/run/publish.js';
import type { RunPublishOptions } from '../src/run/publish.js';
import type { RunCardInput } from '../src/run/render.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import { pullRequestKey, runKey, taskKey } from '../src/identity/keys.js';
import type {
  PostMessageInput,
  PostedMessage,
  SlackPoster,
  UpdateMessageInput,
} from '../src/slack/post.js';
import type { RunCollection, RunFacts } from '../src/run/types.js';

/**
 * Run 루트 재사용(로드맵 §7 출구 조건).
 *
 * **실제 Slack을 부르지 않는다.** write 경계만 대역으로 두고 store는 임시 파일의 실제 sqlite를
 * 쓴다. store를 모킹하면 검증 대상인 "재관찰과 재시작이 같은 루트를 재사용한다"의 근거가
 * 사라진다 — 그 근거가 durable 파일이기 때문이다.
 *
 * 이 테스트가 **검증하지 않는 것**: 매핑 행이 남기 전의 두 창(crash, delivery unknown).
 * 그 구간에는 행이 아예 없으므로 재관찰이 루트를 새로 만든다. 두 창은 D1에서 닫지 않는다
 * (스펙 §9, OD-051). 근거는 `store/schema.ts`의 `RUN_MESSAGE_TABLE`과 `run/publish.ts`에 있다.
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-run-publish-'));
  dbPath = join(dir, 'nested', 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = 'run_36d28e6e947a';
const OTHER_RUN_ID = 'run_7804be5a654f';
const REPO_ID = 'ccb3c8ee-6d9e-42af-af36-9fdac6566fcc';
const CHANNEL = 'C0AGENTRUNS';
const AT = '2026-08-24T05:00:00.000Z';

/** Slack write 경계 대역. 호출 순서와 인자만 본다. */
class FakeSlack implements SlackPoster {
  readonly posts: PostMessageInput[] = [];
  readonly updates: UpdateMessageInput[] = [];
  private seq = 0;
  async post(input: PostMessageInput): Promise<PostedMessage> {
    this.posts.push(input);
    this.seq += 1;
    return { channel: input.channel, ts: `1787403740.00000${this.seq}` };
  }
  async update(input: UpdateMessageInput): Promise<PostedMessage> {
    this.updates.push(input);
    return { channel: input.channel, ts: input.ts };
  }
}

function facts(over: Partial<RunFacts> = {}, runId = RUN_ID): RunFacts {
  return {
    identity: {
      key: runKey(runId),
      runId,
      objective: 'Slack Bridge D1 Run Observer',
      legacy: false,
      current: { handle: 'term_6354ef22', paneKey: 'pane:now', generation: 2 },
      observed: [
        {
          binding: { handle: 'term_6354ef22', paneKey: 'pane:now', generation: 2 },
          liveness: 'live',
          tasks: 24,
        },
      ],
      liveness: 'live',
    },
    project: 'dev-infra',
    repositories: ['dnhynk/dev-infra'],
    observedRepositoryIds: [REPO_ID],
    tasks: { total: 10, byStatus: [{ status: 'completed', count: 10 }] },
    dispatches: { total: 12, byStatus: [{ status: 'completed', count: 12 }], retriedTasks: 1 },
    blockers: { badges: [], notObservable: [] },
    gates: [],
    degraded: [],
    ...over,
  };
}

function input(run: RunFacts = facts()): RunCardInput {
  return {
    run,
    pullRequests: [],
    collection: { degraded: [], unregistered: { count: 0, runs: [] } },
  };
}

function options(store: SqliteDigestStore, slack: SlackPoster | null): RunPublishOptions {
  return { store, slack, thread: null, channel: CHANNEL, now: () => new Date(AT) };
}

describe('Run 루트 재사용', () => {
  it('매핑이 없으면 루트를 만들고 그 매핑을 남긴다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const result = await publishRunCard(options(store, slack), input());
    const mapped = store.findRunMessage(runKey(RUN_ID));
    store.close();

    expect(result.action).toBe('create');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
    expect(mapped?.messageTs).toBe(result.messageTs);
    expect(mapped?.channelId).toBe(CHANNEL);
    expect(mapped?.renderFingerprint).toBe(result.fingerprint);
  });

  it('사실이 그대로인 재관찰은 Slack을 아예 부르지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const first = await publishRunCard(options(store, slack), input());
    const second = await publishRunCard(options(store, slack), input());
    store.close();

    expect(second.action).toBe('skip');
    expect(second.messageTs).toBe(first.messageTs);
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
  });

  // 이것이 출구 조건이다. 새 루트를 만들지 않고 기존 매핑을 찾아 update로 간다.
  it('사실이 바뀐 재관찰은 새 루트를 만들지 않고 기존 ts를 update한다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const first = await publishRunCard(options(store, slack), input());
    const changed = facts({ tasks: { total: 11, byStatus: [{ status: 'ready', count: 11 }] } });
    const second = await publishRunCard(options(store, slack), input(changed));
    const mapped = store.findRunMessage(runKey(RUN_ID));
    store.close();

    expect(second.action).toBe('update');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]?.ts).toBe(first.messageTs);
    expect(slack.updates[0]?.channel).toBe(CHANNEL);
    // 매핑은 그대로이고 지문만 옮겨간다.
    expect(mapped?.messageTs).toBe(first.messageTs);
    expect(mapped?.renderFingerprint).toBe(second.fingerprint);
    expect(mapped?.renderFingerprint).not.toBe(first.fingerprint);
  });

  it('Run root update가 응답하지 않아도 deadline 뒤 durable 관찰을 전진시키지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const firstSlack = new FakeSlack();
    const first = await publishRunCard(options(store, firstSlack), input());
    const hanging: SlackPoster = {
      async post(): Promise<PostedMessage> {
        throw new Error('부르면 안 된다');
      },
      async update(): Promise<PostedMessage> {
        return await new Promise<PostedMessage>(() => undefined);
      },
    };
    const changed = facts({ tasks: { total: 11, byStatus: [{ status: 'ready', count: 11 }] } });
    const began = Date.now();

    await expect(
      publishRunCard(
        { ...options(store, hanging), slackTimeoutMs: 10 },
        input(changed),
      ),
    ).rejects.toThrow('Slack card update deadline exceeded');
    const elapsed = Date.now() - began;
    const mapped = store.findRunMessage(runKey(RUN_ID));
    store.close();

    expect(elapsed).toBeLessThan(1_000);
    expect(mapped?.messageTs).toBe(first.messageTs);
    expect(mapped?.renderFingerprint).toBe(first.fingerprint);
  });

  // 판정 근거가 프로세스 메모리가 아니라 durable 파일이라는 것을 store를 닫았다 여는 것으로 본다.
  it('재시작 뒤에도 같은 루트를 재사용한다', async () => {
    const firstStore = new SqliteDigestStore(dbPath);
    const firstSlack = new FakeSlack();
    const first = await publishRunCard(options(firstStore, firstSlack), input());
    firstStore.close();

    const secondStore = new SqliteDigestStore(dbPath);
    const secondSlack = new FakeSlack();
    const changed = facts({ degraded: [{ kind: 'query_failed', detail: 'gate-list 실패' }] });
    const second = await publishRunCard(options(secondStore, secondSlack), input(changed));
    secondStore.close();

    expect(second.action).toBe('update');
    // 새 프로세스가 post를 한 번도 부르지 않았다는 것이 "루트를 새로 만들지 않았다"이다.
    expect(secondSlack.posts).toHaveLength(0);
    expect(secondSlack.updates[0]?.ts).toBe(first.messageTs);
  });

  it('Run이 다르면 루트도 다르다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const a = await publishRunCard(options(store, slack), input());
    const b = await publishRunCard(options(store, slack), input(facts({}, OTHER_RUN_ID)));
    store.close();

    expect(a.action).toBe('create');
    expect(b.action).toBe('create');
    expect(b.messageTs).not.toBe(a.messageTs);
    expect(slack.posts).toHaveLength(2);
  });

  // 예전 채널의 ts로 update를 걸면 지금 설정이 가리키지 않는 채널의 메시지를 고치고,
  // 새로 post하면 루트가 둘이 된다. 어느 쪽도 이 관찰이 결정할 일이 아니다.
  it('채널이 어긋나면 게시하지도 갱신하지도 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();
    await publishRunCard(options(store, slack), input());

    const moved: RunPublishOptions = {
      store,
      slack,
      thread: null,
      channel: 'C0OTHER',
      now: () => new Date(AT),
    };
    const result = await publishRunCard(moved, input(facts({ tasks: { total: 99, byStatus: [] } })));
    store.close();

    expect(result.action).toBe('channel_mismatch');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
  });

  it('dry-run은 Slack도 store도 건드리지 않고 결정만 돌려준다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const dry = await publishRunCard(options(store, null), input());
    expect(dry.action).toBe('create');
    expect(dry.messageTs).toBeNull();
    expect(store.findRunMessage(runKey(RUN_ID))).toBeNull();

    // 매핑이 생긴 뒤의 dry-run은 update로 보고한다.
    const slack = new FakeSlack();
    await publishRunCard(options(store, slack), input());
    const again = await publishRunCard(
      options(store, null),
      input(facts({ tasks: { total: 7, byStatus: [] } })),
    );
    store.close();
    expect(again.action).toBe('update');
    expect(slack.updates).toHaveLength(0);
  });

  it('게시가 실패하면 매핑 행을 남기지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const failing: SlackPoster = {
      async post(): Promise<PostedMessage> {
        throw new Error('chat.postMessage가 실패했다');
      },
      async update(): Promise<PostedMessage> {
        throw new Error('부르면 안 된다');
      },
    };

    await expect(publishRunCard(options(store, failing), input())).rejects.toThrow(
      /chat.postMessage가 실패했다/,
    );
    const mapped = store.findRunMessage(runKey(RUN_ID));
    store.close();
    // 실패를 기록으로 바꾸지 않는다. 다만 이 행이 없다는 것이 "게시되지 않았다"를 뜻하지는
    // 않는다 — 그것이 `run/publish.ts`가 적어 둔 창 2다.
    expect(mapped).toBeNull();
  });
});

/**
 * 관찰 1회의 게시.
 *
 * **첫 post는 항상 컬렉션 카드다**(OD-080). 등록 Run 수와 무관하게 먼저 나가므로 아래 단언들이
 * Run 카드를 볼 때는 `posts[1]`부터 본다. 순서를 뒤집으면 Run 카드 하나의 실패가 컬렉션 카드를
 * 막고, 그 카드가 싣는 것이 바로 "등록이 어긋났다"는 사실이다.
 */
describe('컬렉션 게시', () => {
  const collection = (over: Partial<RunCollection> = {}): RunCollection => ({
    observedAt: AT,
    runs: [facts(), facts({}, OTHER_RUN_ID)],
    unregistered: { count: 0, runs: [] },
    degraded: [],
    ...over,
  });

  it('등록된 Run마다 카드 하나를 만든다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const results = await publishRunCollection(options(store, slack), collection());
    store.close();

    expect(results.runs.map((r) => r.action)).toEqual(['create', 'create']);
    // 컬렉션 카드 1장 + Run 카드 2장이다. 두 수를 더하지 않고 따로 본다.
    expect(results.collection.action).toBe('create');
    expect(slack.posts).toHaveLength(3);
  });

  it('미등록 Run은 카드를 만들지 않지만 그 수가 모든 카드에 실린다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    await publishRunCollection(
      options(store, slack),
      collection({
        unregistered: {
          count: 2,
          runs: [
            { runId: 'run_aaa', repositoryIds: ['unknown-id'], degraded: [] },
            { runId: 'run_bbb', repositoryIds: [], degraded: [] },
          ],
        },
      }),
    );
    store.close();

    // 컬렉션 카드 1장 + Run 카드 2장. 미등록 수는 셋 모두에 실린다.
    expect(slack.posts).toHaveLength(3);
    for (const post of slack.posts) {
      const text = post.blocks
        .map((b) => (b['text'] as { text?: string } | undefined)?.text ?? '')
        .join('\n');
      expect(text).toContain('*등록되지 않은 Run*');
      expect(text).toContain('run_aaa');
    }
  });

  it('컬렉션 degraded가 모든 카드에 실린다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    await publishRunCollection(
      options(store, slack),
      collection({
        degraded: [
          { kind: 'unverified_platform_assumption', detail: 'run-use 가정은 미검증이다' },
        ],
      }),
    );
    store.close();

    for (const post of slack.posts) {
      const text = post.blocks
        .map((b) => (b['text'] as { text?: string } | undefined)?.text ?? '')
        .join('\n');
      expect(text).toContain('[unverified_platform_assumption]');
    }
  });

  // 재료는 store에 이미 있다. GitHub을 새로 조회하지 않는다.
  it('store의 pr_task·pr_state를 읽어 관련 PR을 카드에 싣는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();
    const PR = pullRequestKey(1057758478, 25);
    store.recordPrTask({
      prKey: PR,
      taskKey: taskKey('task_42914531e46b'),
      runKey: runKey(RUN_ID),
      at: AT,
    });
    store.savePrState(
      PR,
      {
        terminal: 'merged',
        mergedAt: AT,
        reviewVerdict: 'approve',
        reviewedHeadSha: 'c'.repeat(40),
        headSha: 'c'.repeat(40),
        checksHeadSha: 'c'.repeat(40),
        checks: [],
      },
      AT,
    );

    await publishRunCollection(options(store, slack), collection({ runs: [facts()] }));
    store.close();

    const text = (slack.posts[1]?.blocks ?? [])
      .map((b) => (b['text'] as { text?: string } | undefined)?.text ?? '')
      .join('\n');
    expect(text).toContain('#25 ✅ 병합 완료 · 리뷰 통과');
  });

  it('다른 Run의 PR을 이 Run 카드에 싣지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();
    store.recordPrTask({
      prKey: pullRequestKey(1057758478, 26),
      taskKey: taskKey('task_other'),
      runKey: runKey(OTHER_RUN_ID),
      at: AT,
    });

    await publishRunCollection(options(store, slack), collection({ runs: [facts()] }));
    store.close();

    const text = (slack.posts[1]?.blocks ?? [])
      .map((b) => (b['text'] as { text?: string } | undefined)?.text ?? '')
      .join('\n');
    expect(text).toContain('store에 기록된 PR 없음');
    expect(text).not.toContain('#26');
  });
  /*
   * `skip`이 실운영에서 살아 있는지를 본다.
   *
   * 두 관찰의 Run 사실은 같고 **관측 시각만 다르다** — 컬렉션 `observedAt`도, `digest`가 갱신하는
   * `pr_state.observed_at`·`pr_task.last_seen_at`도 움직였다. 카드에 그 값이 하나라도 남아 있으면
   * 지문이 달라져 이 테스트가 `update`를 본다. 고정 시각으로만 도는 테스트는 이 경로를 놓친다.
   *
   * **PR이 붙은 Run으로 한다.** PR 없는 Run으로만 하면 `pullRequestLine`의 시각을 놓친다.
   */
  it('관측 시각만 다른 재관찰은 Slack을 부르지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();
    const PR = pullRequestKey(1057758478, 27);
    const snapshot = {
      terminal: 'open' as const,
      mergedAt: null,
      reviewVerdict: null,
      reviewedHeadSha: null,
      headSha: 'd'.repeat(40),
      checksHeadSha: 'd'.repeat(40),
      checks: [],
    };
    const observe = (at: string) => {
      store.recordPrTask({ prKey: PR, taskKey: taskKey('task_42914531e46b'), runKey: runKey(RUN_ID), at });
      store.savePrState(PR, snapshot, at);
    };

    observe(AT);
    const first = await publishRunCollection(options(store, slack), collection({ runs: [facts()] }));

    const LATER = '2026-08-24T06:30:00.000Z';
    observe(LATER);
    const later: RunPublishOptions = {
      store,
      slack,
      thread: null,
      channel: CHANNEL,
      now: () => new Date(LATER),
    };
    const second = await publishRunCollection(later, collection({ observedAt: LATER, runs: [facts()] }));
    store.close();

    // 카드가 PR을 실제로 그렸다는 것을 같은 자리에서 확인한다. 안 그리면 이 테스트가 공허하다.
    // posts[0]은 컬렉션 카드다. Run 카드는 그 다음이다.
    const text = (slack.posts[1]?.blocks ?? [])
      .map((b) => (b['text'] as { text?: string } | undefined)?.text ?? '')
      .join('\n');
    expect(text).toContain('#27 🟡 열림');

    expect(first.runs[0]?.action).toBe('create');
    expect(second.runs[0]?.action).toBe('skip');
    expect(second.runs[0]?.fingerprint).toBe(first.runs[0]?.fingerprint);
    // 컬렉션 카드도 같은 이유로 skip이다. 두 카드 모두 관측 시각을 싣지 않는다.
    expect(second.collection.action).toBe('skip');
    expect(slack.posts).toHaveLength(2);
    expect(slack.updates).toHaveLength(0);
  });

});

/**
 * 컬렉션 카드(OD-080).
 *
 * **이 describe가 닫는 구멍이 이것이다.** 미등록 Run 수는 Run 카드에도 실리지만, 등록된 Run이
 * 하나도 없으면 Run 카드도 하나도 없어 그 수가 Slack 어디에도 나타나지 않는다. 그 구간이 정확히
 * OD-078이 감수한 위험 — 등록 열쇠가 통째로 어긋나 Run이 조용히 사라지는 구간 — 이다.
 * 완화 장치가 하필 그때 보이지 않으면 완화 장치가 아니다.
 */
describe('컬렉션 카드 (OD-080)', () => {
  const empty = (over: Partial<RunCollection> = {}): RunCollection => ({
    observedAt: AT,
    runs: [],
    unregistered: { count: 0, runs: [] },
    degraded: [],
    ...over,
  });

  function blockText(post: PostMessageInput | undefined): string {
    return (post?.blocks ?? [])
      .map((b) => (b['text'] as { text?: string } | undefined)?.text ?? '')
      .join('\n');
  }

  // 등록 Run이 0이어도 미등록 사실이 #agent-runs에 도달한다. 이것이 수용 기준이다.
  it('등록된 Run이 하나도 없어도 미등록 수가 Slack에 도달한다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const result = await publishRunCollection(
      options(store, slack),
      empty({
        unregistered: {
          count: 2,
          runs: [
            {
              runId: 'run_aaa',
              repositoryIds: ['unknown-id'],
              degraded: [
                { kind: 'unregistered_repository', detail: '등록되지 않은 id: unknown-id' },
              ],
            },
            {
              runId: 'run_bbb',
              repositoryIds: [],
              degraded: [
                { kind: 'repository_unobservable', detail: 'task-list 조회가 실패했다' },
                { kind: 'query_failed', detail: 'task-list 실패' },
              ],
            },
          ],
        },
      }),
    );
    store.close();

    expect(result.runs).toEqual([]);
    // Run 카드가 없는데도 post가 한 번 나갔다. 그것이 컬렉션 카드다.
    expect(slack.posts).toHaveLength(1);
    expect(result.collection.action).toBe('create');

    const text = blockText(slack.posts[0]);
    expect(text).toContain('*등록되지 않은 Run*');
    expect(text).toContain('run_aaa');
    expect(text).toContain('run_bbb');
    // D1-B가 확정한 구분이 이 카드에서도 갈려야 한다. 이 줄들이 없으면 "조회에 실패해서 판정할
    // 수 없다"와 "조회했더니 등록에 없다"가 바이트 동일해지고, 그러면 이 카드가 두 사건을 함께 센다.
    expect(text).toContain('[unregistered_repository]');
    expect(text).toContain('[query_failed]');
    // 대체 텍스트에도 수가 남는다. blocks를 그리지 못하는 자리가 있다.
    expect(slack.posts[0]?.text).toContain('등록되지 않은 Run 2건');
  });

  // 조건부로 만들면 장치가 조건부가 된다. 등록 Run이 있어도, 미등록이 0이어도 카드는 나간다.
  it('등록 Run과 미등록 Run이 모두 0이어도 카드를 만든다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const result = await publishRunCollection(options(store, slack), empty());
    store.close();

    expect(result.collection.action).toBe('create');
    expect(slack.posts).toHaveLength(1);
    expect(blockText(slack.posts[0])).toContain('*등록되지 않은 Run*');
  });

  // 컬렉션 카드도 Run 카드와 같은 루트 재사용 규율을 따른다. 관찰마다 새 루트를 만들면
  // #agent-runs가 같은 요약으로 도배된다.
  it('재관찰은 새 루트를 만들지 않고 기존 ts를 update한다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    const first = await publishRunCollection(options(store, slack), empty());
    const second = await publishRunCollection(
      options(store, slack),
      empty({
        unregistered: { count: 1, runs: [{ runId: 'run_aaa', repositoryIds: [], degraded: [] }] },
      }),
    );
    store.close();

    expect(second.collection.action).toBe('update');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(1);
    expect(slack.updates[0]?.ts).toBe(first.collection.messageTs);
    expect(slack.updates[0]?.channel).toBe(CHANNEL);
  });

  it('사실이 그대로인 재관찰은 Slack을 아예 부르지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();

    await publishRunCollection(options(store, slack), empty());
    const second = await publishRunCollection(options(store, slack), empty());
    store.close();

    expect(second.collection.action).toBe('skip');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
  });

  // 재시작 뒤에도 같은 루트를 재사용한다. 판정 근거가 프로세스 메모리가 아니라 durable 파일이다.
  it('재시작 뒤에도 같은 루트를 재사용한다', async () => {
    const firstStore = new SqliteDigestStore(dbPath);
    const firstSlack = new FakeSlack();
    const first = await publishRunCollection(options(firstStore, firstSlack), empty());
    firstStore.close();

    const secondStore = new SqliteDigestStore(dbPath);
    const secondSlack = new FakeSlack();
    const second = await publishRunCollection(
      options(secondStore, secondSlack),
      empty({ degraded: [{ kind: 'inbox_saturated', detail: 'inbox가 상한에 닿았다' }] }),
    );
    secondStore.close();

    expect(second.collection.action).toBe('update');
    // 새 프로세스가 post를 한 번도 부르지 않았다는 것이 "루트를 새로 만들지 않았다"이다.
    expect(secondSlack.posts).toHaveLength(0);
    expect(secondSlack.updates[0]?.ts).toBe(first.collection.messageTs);
  });

  // 예전 채널의 ts로 update를 걸면 지금 설정이 가리키지 않는 채널의 메시지를 고치고,
  // 새로 post하면 루트가 둘이 된다. Run 카드와 같은 판정이다.
  it('채널이 어긋나면 게시하지도 갱신하지도 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const slack = new FakeSlack();
    await publishRunCollection(options(store, slack), empty());

    const moved: RunPublishOptions = {
      store,
      slack,
      thread: null,
      channel: 'C0OTHER',
      now: () => new Date(AT),
    };
    const result = await publishRunCollection(
      moved,
      empty({
        unregistered: { count: 3, runs: [] },
      }),
    );
    store.close();

    expect(result.collection.action).toBe('channel_mismatch');
    expect(slack.posts).toHaveLength(1);
    expect(slack.updates).toHaveLength(0);
  });

  it('dry-run은 Slack도 store도 건드리지 않고 결정만 돌려준다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const result = await publishRunCollection(options(store, null), empty());
    const mapped = store.findRunCollectionMessage();
    store.close();

    expect(result.collection.action).toBe('create');
    expect(result.collection.messageTs).toBeNull();
    // dry-run이 매핑을 남기면 다음 실제 실행이 존재하지 않는 메시지를 update하려 한다.
    expect(mapped).toBeNull();
  });

  // 컬렉션 카드가 먼저 나간다. 뒤에 두면 Run 카드 하나의 실패가 컬렉션 카드까지 막는데,
  // 그 카드가 싣는 것이 바로 "등록이 어긋났다"는 사실이다.
  it('Run 카드 게시가 실패해도 컬렉션 카드는 이미 나가 있다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const posts: PostMessageInput[] = [];
    const failing: SlackPoster = {
      async post(input: PostMessageInput): Promise<PostedMessage> {
        posts.push(input);
        if (posts.length === 1) return { channel: input.channel, ts: '1787403740.000001' };
        throw new Error('chat.postMessage가 실패했다');
      },
      async update(): Promise<PostedMessage> {
        throw new Error('부르면 안 된다');
      },
    };

    await expect(
      publishRunCollection(options(store, failing), {
        observedAt: AT,
        runs: [facts()],
        unregistered: { count: 4, runs: [] },
        degraded: [],
      }),
    ).rejects.toThrow(/chat.postMessage가 실패했다/);
    const mapped = store.findRunCollectionMessage();
    store.close();

    expect(posts).toHaveLength(2);
    expect(posts[0]?.text).toContain('등록되지 않은 Run 4건');
    // 컬렉션 카드의 매핑은 남았다. 다음 관찰이 그것을 재사용한다.
    expect(mapped?.messageTs).toBe('1787403740.000001');
  });
});
