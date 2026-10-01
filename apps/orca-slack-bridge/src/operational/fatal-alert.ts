import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { RenderedCard } from '../digest/render.js';
import { renderCardShell } from '../slack/card.js';
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

const HOUR_MS = 60 * 60 * 1_000;

/**
 * 원인 코드를 사람이 읽는 원인과 할 일로 옮긴다. 코드 자체는 카드에 싣지 않는다(DL-074) —
 * observer 원인 코드는 운영 로그 `job.failed`의 `errorCode`에 있고, 알린 코드는 `fatal-alert.json`에 남는다.
 */
function fatalCause(code: string): { readonly cause: string; readonly note: string } {
  if (code.endsWith('.schema_drift')) {
    return { cause: 'Orca 데이터 형식 변경', note: 'Orca 응답 형식이 바뀌어 데몬이 멈췄습니다' };
  }
  if (code === 'daemon.startup_failed') {
    return { cause: '기동 실패', note: '데몬이 시작하지 못하고 멈췄습니다' };
  }
  if (code === 'daemon.fatal_stop') {
    return { cause: '실행 중 치명 오류', note: '데몬이 실행 중 치명 오류로 멈췄습니다' };
  }
  return { cause: '확인 불가 · 운영 로그 참고', note: '데몬이 멈췄지만 원인을 분류하지 못했습니다' };
}

/**
 * 알림 대체 텍스트. owner mention이 여기 있어야 알림이 간다.
 *
 * mention은 이 알림만의 예외다(DL-074). 다른 카드는 사람을 부르지 않는다.
 */
export function fatalAlertText(code: string, ownerUserId: string | null): string {
  const mention = ownerUserId === null ? '' : `<@${ownerUserId}> `;
  return `${mention}orca-slack-bridge 데몬 중단 · ${fatalCause(code).cause}`;
}

/** 치명 종료 카드. 시각은 종료를 알린 시각이고 원인 코드는 싣지 않는다. */
export function fatalAlertCard(
  code: string,
  ownerUserId: string | null,
  now: Date,
  quietMs: number = FATAL_ALERT_QUIET_MS,
): RenderedCard {
  const { cause, note } = fatalCause(code);
  const mention = ownerUserId === null ? '' : `<@${ownerUserId}> `;
  return renderCardShell({
    tone: 'error',
    emoji: '🚨',
    kind: '중단',
    head: 'orca-slack-bridge 데몬',
    text: fatalAlertText(code, ownerUserId),
    fields: [
      ['원인', cause],
      // Scheduled Task가 1분마다 다시 띄운다. 원인이 그대로면 다시 멈춘다(DL-057).
      ['자동 재시작', '1분마다 · 원인이 남으면 다시 중단'],
      ['다음 알림', `같은 원인은 ${Math.max(1, Math.round(quietMs / HOUR_MS))}시간 뒤`],
    ],
    sections: [`${mention}${note} → status 명령과 운영 로그에서 원인을 확인하세요.`],
    footer: { at: now, verb: null, basis: 'Windows 작업 스케줄러 기준' },
  });
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
  const card = fatalAlertCard(
    input.code,
    input.ownerUserId,
    input.now,
    input.quietMs ?? FATAL_ALERT_QUIET_MS,
  );
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
        ...card,
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
