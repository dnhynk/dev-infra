import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { SlackApiError, type SlackPoster } from '../slack/post.js';

/**
 * A daemon that stops on a fatal cause is restarted by the Scheduled Task every minute and stops
 * again, so nothing reaches Slack while the loop lasts. A repository-row drift once kept the
 * Bridge down for 17 days before anyone looked. One line per cause per quiet window is enough to
 * act on and cannot flood the channel while the loop continues.
 */
export const FATAL_ALERT_QUIET_MS = 24 * 60 * 60 * 1_000;
export const FATAL_ALERT_TIMEOUT_MS = 10_000;
/** Per-cause timestamp of the last notice, kept next to the operational log. */
export const FATAL_ALERT_LEDGER = 'fatal-alert.json';

export type FatalAlertOutcome = 'posted' | 'suppressed' | 'rejected' | 'uncertain';

export type FatalAlertInput = {
  /** Operational failure code, e.g. `discovery.schema_drift`. No payload text is ever posted. */
  readonly code: string;
  readonly slack: SlackPoster;
  readonly channel: string;
  readonly ownerUserId: string | null;
  readonly logDir: string;
  readonly now: Date;
  readonly quietMs?: number;
  readonly timeoutMs?: number;
};

function readLedger(path: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ));
  } catch {
    return {};
  }
}

function writeLedger(path: string, ledger: Readonly<Record<string, string>>): void {
  try {
    // The operational logger creates this directory, but a fatal exit can precede the logger. A
    // missing directory would silently drop the ledger and repeat the notice on every restart.
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(ledger));
    renameSync(temporary, path);
  } catch {
    // Losing the ledger costs at most one repeated notice on the next fatal start.
  }
}

export function fatalAlertText(code: string, ownerUserId: string | null): string {
  const mention = ownerUserId === null ? '' : `<@${ownerUserId}> `;
  return `${mention}orca-slack-bridge daemon이 치명 오류로 멈췄습니다: ${code}\n`
    + 'Scheduled Task가 다시 띄워도 원인이 그대로면 계속 멈춥니다. '
    + '`status`와 `logs`로 원인을 확인하세요. 같은 원인은 24시간 동안 다시 알리지 않습니다.';
}

/**
 * Post one notice for a fatal daemon exit. It never throws and never changes the exit: the caller
 * is already stopping. A Slack API rejection proves nothing was posted, so the next start may try
 * again; a timeout or unknown failure may have posted and is recorded to avoid repeats.
 */
export async function announceFatalExit(input: FatalAlertInput): Promise<FatalAlertOutcome> {
  const path = join(input.logDir, FATAL_ALERT_LEDGER);
  const ledger = readLedger(path);
  const last = Date.parse(ledger[input.code] ?? '');
  if (
    Number.isFinite(last) &&
    input.now.getTime() - last < (input.quietMs ?? FATAL_ALERT_QUIET_MS)
  ) {
    return 'suppressed';
  }
  const text = fatalAlertText(input.code, input.ownerUserId);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, input.timeoutMs ?? FATAL_ALERT_TIMEOUT_MS);
  });
  let outcome: FatalAlertOutcome;
  try {
    const posted = await Promise.race([
      input.slack.post({
        channel: input.channel,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
        signal: controller.signal,
      }).then(() => 'posted' as const),
      timedOut,
    ]);
    outcome = posted === 'posted' ? 'posted' : 'uncertain';
  } catch (error) {
    outcome = error instanceof SlackApiError ? 'rejected' : 'uncertain';
  } finally {
    clearTimeout(timer);
  }
  if (outcome !== 'rejected') writeLedger(path, { ...ledger, [input.code]: input.now.toISOString() });
  return outcome;
}
