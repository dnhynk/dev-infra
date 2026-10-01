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
import { cardText, fieldValue, headerText, sectionTexts } from './card-text.js';

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
  it('posts one red card with the owner mention and a human cause, and records the code', async () => {
    const slack = new RecordingSlack();
    await expect(announceFatalExit(input(slack))).resolves.toBe('posted');
    expect(slack.posts).toHaveLength(1);
    const post = slack.posts[0]!;
    expect(post).toMatchObject({ channel: 'C0DECISIONS' });
    // mention은 이 알림만의 예외다. 대체 텍스트에 있어야 알림이 간다.
    expect(post.text).toContain('<@U0OWNER>');
    expect(headerText(post)).toBe('🚨  중단 · orca-slack-bridge 데몬');
    expect(post.attachments?.[0]?.color).toBe('#cf222e');
    expect(fieldValue(post, '원인')).toBe('Orca 데이터 형식 변경');
    expect(fieldValue(post, '자동 재시작')).toBe('1분마다 · 원인이 남으면 다시 중단');
    expect(fieldValue(post, '다음 알림')).toBe('같은 원인은 24시간 뒤');
    expect(sectionTexts(post)).toEqual([
      '<@U0OWNER> Orca 응답 형식이 바뀌어 데몬이 멈췄습니다 → status 명령과 운영 로그에서 원인을 확인하세요.',
    ]);
    // 원인 코드는 카드에 싣지 않는다. 운영 로그와 ledger가 싣는다.
    expect(cardText(post)).not.toContain('schema_drift');
    expect(JSON.parse(readFileSync(join(logDir, FATAL_ALERT_LEDGER), 'utf8'))).toEqual({
      'discovery.schema_drift': AT.toISOString(),
    });
  });

  it('maps each fatal code to its cause and falls back without guessing', async () => {
    const causes: Record<string, string> = {
      'run.schema_drift': 'Orca 데이터 형식 변경',
      'daemon.startup_failed': '기동 실패',
      'daemon.fatal_stop': '실행 중 치명 오류',
      'observer.unknown_failure': '확인 불가 · 운영 로그 참고',
    };
    for (const [code, cause] of Object.entries(causes)) {
      const slack = new RecordingSlack();
      await announceFatalExit(input(slack, { code, logDir: join(logDir, code) }));
      expect(fieldValue(slack.posts[0]!, '원인')).toBe(cause);
      expect(cardText(slack.posts[0]!)).not.toContain(code);
    }
  });

  it('stays quiet for the same cause inside the window and speaks again after it', async () => {
    const slack = new RecordingSlack();
    await announceFatalExit(input(slack));
    await expect(announceFatalExit(input(slack, { now: new Date(AT.getTime() + 23 * HOUR) })))
      .resolves.toBe('suppressed');
    await expect(announceFatalExit(input(slack, { code: 'daemon.startup_failed' })))
      .resolves.toBe('posted');
    await expect(announceFatalExit(input(slack, { now: new Date(AT.getTime() + 25 * HOUR) })))
      .resolves.toBe('posted');
    expect(slack.posts.map((post) => post.text.includes('기동 실패'))).toEqual([false, true, false]);
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
    expect(cardText(slack.posts[0]!)).not.toContain('<@');
  });
});
