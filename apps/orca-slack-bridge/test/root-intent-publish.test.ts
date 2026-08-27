import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullRequestKey, runKey } from '../src/identity/keys.js';
import {
  postSlackRootAtMostOnce,
  SlackRootSimulatedCrash,
  type SlackRootIntentHooks,
} from '../src/slack/root-intent.js';
import { SlackApiError, type PostedMessage, type SlackPoster } from '../src/slack/post.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import type { SlackRootEntity, SlackRootPostedMapping } from '../src/store/operational-types.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-root-intent-'));
  path = join(dir, 'state.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

class Clock {
  private tick = 0;
  now = (): Date => new Date(Date.UTC(2026, 7, 27) + this.tick++ * 1_000);
}

class FakeSlack implements SlackPoster {
  attempts = 0;
  failTransport = false;
  failDefinite = false;
  hang = false;
  async post(input: { readonly channel: string }): Promise<PostedMessage> {
    this.attempts += 1;
    if (this.failDefinite) throw new SlackApiError('chat.postMessage', 'ratelimited');
    if (this.failTransport) throw new Error('response lost after possible transport write');
    if (this.hang) return await new Promise<PostedMessage>(() => undefined);
    return { channel: input.channel, ts: '1880000000.000001' };
  }
  async update(): Promise<PostedMessage> {
    throw new Error('update is outside the create-root boundary');
  }
}

const PR = { kind: 'pr', key: pullRequestKey(101, 7) } as const;
const PR_MAPPING = {
  kind: 'pr', factsFingerprint: 'facts.1', summaryJson: null,
} as const;

async function attempt(
  store: SqliteDigestStore,
  slack: FakeSlack,
  clock: Clock,
  hooks?: SlackRootIntentHooks,
  timeoutMs?: number,
) {
  return await postSlackRootAtMostOnce({
    store,
    entity: PR,
    channel: 'C1',
    renderFingerprint: 'render.1',
    message: { text: 'facts', blocks: [] },
    mapping: PR_MAPPING,
    slack,
    now: clock.now,
    runtime: {
      instanceId: 'instance-a',
      ...(hooks === undefined ? {} : { hooks }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  });
}

async function restartAndRetry(slack: FakeSlack, clock: Clock): Promise<void> {
  const restarted = new SqliteDigestStore(path);
  expect(restarted.recoverSlackRootIntents('instance-b', clock.now().toISOString()))
    .toBeGreaterThanOrEqual(0);
  const result = await postSlackRootAtMostOnce({
    store: restarted,
    entity: PR,
    channel: 'C1',
    renderFingerprint: 'render.1',
    message: { text: 'facts', blocks: [] },
    mapping: PR_MAPPING,
    slack,
    now: clock.now,
    runtime: { instanceId: 'instance-b' },
  });
  expect(result).toMatchObject({ kind: 'blocked', state: 'uncertain' });
  expect(restarted.findSlackRootIntent(PR)?.state).toBe('uncertain');
  restarted.close();
}

describe('at-most-once Slack root intent', () => {
  for (const [stage, hooks, expectedAttempts] of [
    ['before send', { afterClaim: () => { throw new SlackRootSimulatedCrash('before_send'); } }, 0],
    ['after response', {
      afterPostResponse: () => { throw new SlackRootSimulatedCrash('after_response'); },
    }, 1],
    ['before DB commit', {
      beforeCommit: () => { throw new SlackRootSimulatedCrash('before_commit'); },
    }, 1],
  ] as const) {
    it(`leaves ${stage} crash sending, recovers uncertain, and never posts twice`, async () => {
      const clock = new Clock();
      const slack = new FakeSlack();
      const store = new SqliteDigestStore(path);
      await expect(attempt(store, slack, clock, hooks)).rejects
        .toBeInstanceOf(SlackRootSimulatedCrash);
      expect(store.findSlackRootIntent(PR)?.state).toBe('sending');
      store.close();

      await restartAndRetry(slack, clock);
      expect(slack.attempts).toBe(expectedAttempts);
    });
  }

  it('classifies a possible transport effect as uncertain and future polls perform zero posts', async () => {
    const clock = new Clock();
    const slack = new FakeSlack();
    slack.failTransport = true;
    const store = new SqliteDigestStore(path);
    expect(await attempt(store, slack, clock)).toMatchObject({ kind: 'blocked', state: 'uncertain' });
    expect(store.findSlackRootIntent(PR)?.state).toBe('uncertain');
    store.close();

    slack.failTransport = false;
    await restartAndRetry(slack, clock);
    expect(slack.attempts).toBe(1);
  });

  it('times out a non-settling transport as uncertain and never retries it', async () => {
    const clock = new Clock();
    const slack = new FakeSlack();
    slack.hang = true;
    const store = new SqliteDigestStore(path);
    expect(await attempt(store, slack, clock, undefined, 10)).toMatchObject({
      kind: 'blocked', state: 'uncertain',
    });
    store.close();

    slack.hang = false;
    await restartAndRetry(slack, clock);
    expect(slack.attempts).toBe(1);
  });

  it('returns a proven no-effect failure to pending and permits one later claim', async () => {
    const clock = new Clock();
    const slack = new FakeSlack();
    slack.failDefinite = true;
    const store = new SqliteDigestStore(path);
    expect(await attempt(store, slack, clock)).toMatchObject({ kind: 'blocked', state: 'pending' });
    expect(store.findSlackRootIntent(PR)?.state).toBe('pending');

    slack.failDefinite = false;
    expect(await attempt(store, slack, clock)).toMatchObject({ kind: 'posted' });
    expect(slack.attempts).toBe(2);
    expect(store.findSlackRootIntent(PR)?.state).toBe('posted');
    store.close();
  });

  it('rolls back a mapping fault, records commit uncertainty, and never retries the post', async () => {
    const clock = new Clock();
    const slack = new FakeSlack();
    const store = new SqliteDigestStore(path, {
      operationalFault: (point) => {
        if (point === 'after_root_mapping') throw new Error('injected commit fault');
      },
    });
    expect(await attempt(store, slack, clock)).toMatchObject({ kind: 'blocked', state: 'uncertain' });
    expect(store.findPrMessage(PR.key)).toBeNull();
    expect(store.findSlackRootIntent(PR)?.state).toBe('uncertain');
    store.close();

    await restartAndRetry(slack, clock);
    expect(slack.attempts).toBe(1);
  });

  it.each([
    {
      entity: PR as SlackRootEntity,
      mapping: PR_MAPPING as SlackRootPostedMapping,
      mapped: (store: SqliteDigestStore) => store.findPrMessage(PR.key),
    },
    {
      entity: { kind: 'run', key: runKey('run_root_intent') } as SlackRootEntity,
      mapping: { kind: 'run' } as SlackRootPostedMapping,
      mapped: (store: SqliteDigestStore) => store.findRunMessage(runKey('run_root_intent')),
    },
    {
      entity: { kind: 'run_collection', key: 'run_collection' } as SlackRootEntity,
      mapping: { kind: 'run_collection' } as SlackRootPostedMapping,
      mapped: (store: SqliteDigestStore) => store.findRunCollectionMessage(),
    },
  ])('atomically commits the exact successful response for $entity.kind', async ({
    entity, mapping, mapped,
  }) => {
    const clock = new Clock();
    const slack = new FakeSlack();
    const store = new SqliteDigestStore(path);
    const result = await postSlackRootAtMostOnce({
      store, entity, mapping, channel: 'C1', renderFingerprint: 'render.1',
      message: { text: 'facts', blocks: [] }, slack, now: clock.now,
      runtime: { instanceId: 'instance-a' },
    });
    expect(result).toEqual({
      kind: 'posted', message: { channel: 'C1', ts: '1880000000.000001' },
    });
    expect(store.findSlackRootIntent(entity)).toMatchObject({
      state: 'posted', messageTs: '1880000000.000001', attemptCount: 1,
    });
    expect(mapped(store)).toMatchObject({ channelId: 'C1', messageTs: '1880000000.000001' });

    const second = await postSlackRootAtMostOnce({
      store, entity, mapping, channel: 'C1', renderFingerprint: 'render.1',
      message: { text: 'facts', blocks: [] }, slack, now: clock.now,
      runtime: { instanceId: 'instance-a' },
    });
    expect(second).toMatchObject({ kind: 'blocked', state: 'posted' });
    expect(slack.attempts).toBe(1);
    store.close();
  });
});
