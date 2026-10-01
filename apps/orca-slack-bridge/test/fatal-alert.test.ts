import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FATAL_ALERT_LEDGER,
  announceFatalExit,
  type FatalAlertInput,
} from '../src/operational/fatal-alert.js';
import {
  SlackApiError,
  type PostMessageInput,
  type PostedMessage,
  type SlackPoster,
  type UpdateMessageInput,
} from '../src/slack/post.js';

const AT = new Date('2026-09-30T09:00:00.000Z');
const HOUR = 60 * 60 * 1_000;

class RecordingSlack implements SlackPoster {
  readonly posts: PostMessageInput[] = [];
  constructor(private readonly behavior: 'ok' | 'reject' | 'hang' = 'ok') {}
  post(input: PostMessageInput): Promise<PostedMessage> {
    this.posts.push(input);
    if (this.behavior === 'reject') return Promise.reject(new SlackApiError('chat.postMessage', 'channel_not_found'));
    if (this.behavior === 'hang') return new Promise<PostedMessage>(() => undefined);
    return Promise.resolve({ channel: input.channel, ts: '1790000000.000100' });
  }
  update(input: UpdateMessageInput): Promise<PostedMessage> {
    return Promise.resolve({ channel: input.channel, ts: input.ts });
  }
}

let logDir: string;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), 'orca-fatal-alert-'));
});

afterEach(() => rmSync(logDir, { recursive: true, force: true }));

function input(slack: SlackPoster, overrides: Partial<FatalAlertInput> = {}): FatalAlertInput {
  return {
    code: 'discovery.schema_drift',
    slack,
    channel: 'C0DECISIONS',
    ownerUserId: 'U0OWNER',
    logDir,
    now: AT,
    ...overrides,
  };
}

describe('fatal daemon exit notice', () => {
  it('posts one mention with the cause code to the decisions channel and records it', async () => {
    const slack = new RecordingSlack();
    await expect(announceFatalExit(input(slack))).resolves.toBe('posted');
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toMatchObject({ channel: 'C0DECISIONS' });
    expect(slack.posts[0]!.text).toContain('<@U0OWNER>');
    expect(slack.posts[0]!.text).toContain('discovery.schema_drift');
    expect(JSON.parse(readFileSync(join(logDir, FATAL_ALERT_LEDGER), 'utf8'))).toEqual({
      'discovery.schema_drift': AT.toISOString(),
    });
  });

  it('stays quiet for the same cause inside the window and speaks again after it', async () => {
    const slack = new RecordingSlack();
    await announceFatalExit(input(slack));
    await expect(announceFatalExit(input(slack, { now: new Date(AT.getTime() + 23 * HOUR) })))
      .resolves.toBe('suppressed');
    await expect(announceFatalExit(input(slack, { code: 'run.schema_drift' }))).resolves.toBe('posted');
    await expect(announceFatalExit(input(slack, { now: new Date(AT.getTime() + 25 * HOUR) })))
      .resolves.toBe('posted');
    expect(slack.posts.map((post) => post.text.includes('run.schema_drift'))).toEqual([false, true, false]);
  });

  it('retries on the next start after Slack rejects the post', async () => {
    await expect(announceFatalExit(input(new RecordingSlack('reject')))).resolves.toBe('rejected');
    const slack = new RecordingSlack();
    await expect(announceFatalExit(input(slack))).resolves.toBe('posted');
    expect(slack.posts).toHaveLength(1);
  });

  it('bounds a hung post and records it so a crash loop cannot repeat the notice', async () => {
    const hung = new RecordingSlack('hang');
    await expect(announceFatalExit(input(hung, { timeoutMs: 20 }))).resolves.toBe('uncertain');
    expect(hung.posts[0]!.signal?.aborted).toBe(true);
    const slack = new RecordingSlack();
    await expect(announceFatalExit(input(slack))).resolves.toBe('suppressed');
    expect(slack.posts).toHaveLength(0);
  });

  it('creates a missing log directory so the quiet window holds before the logger exists', async () => {
    // A fatal exit can precede the operational logger that normally creates this directory.
    const missing = join(logDir, 'not-yet-created');
    const slack = new RecordingSlack();
    await expect(announceFatalExit(input(slack, { logDir: missing }))).resolves.toBe('posted');
    await expect(announceFatalExit(input(slack, { logDir: missing }))).resolves.toBe('suppressed');
    expect(slack.posts).toHaveLength(1);
  });

  it('treats an unreadable ledger as empty and omits the mention without an owner', async () => {
    writeFileSync(join(logDir, FATAL_ALERT_LEDGER), '{not json');
    const slack = new RecordingSlack();
    await expect(announceFatalExit(input(slack, { ownerUserId: null }))).resolves.toBe('posted');
    expect(slack.posts[0]!.text).not.toContain('<@');
  });
});
