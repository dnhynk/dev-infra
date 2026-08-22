import type { SlackConfig } from '../project/config.js';

/**
 * Slack 준비 상태를 확인한다.
 *
 * 메시지를 게시하지 않는다. `auth.test`와 `apps.connections.open`만 호출한다.
 * `apps.connections.open`은 만료되는 WebSocket URL을 발급받을 뿐 연결하지 않는다.
 */
/**
 * 환경변수 이름에 앱 이름을 붙인다.
 *
 * `SLACK_BOT_TOKEN`·`SLACK_APP_TOKEN`은 Bolt for JavaScript가 쓰는 관례 이름이다.
 * 사용자 환경변수는 같은 사용자의 모든 프로세스가 상속하므로, 관례 이름을 쓰면
 * 나중에 만든 다른 Slack 앱이 이 Bridge의 토큰을 조용히 집어간다.
 */
export const BOT_TOKEN_VAR = 'ORCA_SLACK_BRIDGE_BOT_TOKEN';
export const APP_TOKEN_VAR = 'ORCA_SLACK_BRIDGE_APP_TOKEN';

export type VerifyResult = {
  readonly checks: readonly Check[];
  readonly ok: boolean;
};

export type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

/** 토큰을 로그에 남기지 않는다. */
export function maskToken(token: string): string {
  if (token.length <= 12) return '***';
  return `${token.slice(0, 9)}…${token.slice(-4)} (${token.length}자)`;
}

async function slackPost(
  method: string,
  token: string,
): Promise<{ ok: boolean; error?: string } & Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
  });
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }
  return (await res.json()) as { ok: boolean; error?: string };
}

export async function verifySlack(
  config: SlackConfig | null,
  env: NodeJS.ProcessEnv,
): Promise<VerifyResult> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  if (config === null) {
    add('config.slack', false, '설정에 slack 절이 없다');
    return { checks, ok: false };
  }
  add('config.slack', true, `team=${config.teamId} owners=${config.ownerUserIds.length} channels=2`);

  const botToken = env[BOT_TOKEN_VAR]?.trim();
  const appToken = env[APP_TOKEN_VAR]?.trim();

  // 관례 이름이 설정돼 있으면 진단을 돕는다. 값은 읽지 않는다.
  for (const [generic, specific] of [
    ['SLACK_BOT_TOKEN', BOT_TOKEN_VAR],
    ['SLACK_APP_TOKEN', APP_TOKEN_VAR],
  ] as const) {
    if (env[generic] && !env[specific]) {
      add(
        specific,
        false,
        `${generic}가 설정돼 있으나 읽지 않는다. Bolt 등 다른 앱과 겹치는 이름이라 ${specific}로 옮겨야 한다`,
      );
    }
  }

  if (!botToken) {
    if (!env['SLACK_BOT_TOKEN']) add(BOT_TOKEN_VAR, false, '환경변수가 비어 있다');
  } else if (!botToken.startsWith('xoxb-')) {
    add(BOT_TOKEN_VAR, false, `xoxb-로 시작하지 않는다: ${maskToken(botToken)}`);
  } else {
    add(BOT_TOKEN_VAR, true, maskToken(botToken));
    const auth = await slackPost('auth.test', botToken);
    if (!auth.ok) {
      add('auth.test', false, `실패: ${String(auth.error)}`);
    } else {
      const team = String(auth['team_id'] ?? '');
      const botUser = String(auth['user_id'] ?? '');
      add('auth.test', true, `team=${team} bot_user=${botUser}`);
      add(
        'team 일치',
        team === config.teamId,
        team === config.teamId ? '설정과 같다' : `설정 ${config.teamId} ≠ 실제 ${team}`,
      );
    }
  }

  if (!appToken) {
    if (!env['SLACK_APP_TOKEN']) add(APP_TOKEN_VAR, false, '환경변수가 비어 있다');
  } else if (!appToken.startsWith('xapp-')) {
    add(APP_TOKEN_VAR, false, `xapp-로 시작하지 않는다: ${maskToken(appToken)}`);
  } else {
    add(APP_TOKEN_VAR, true, maskToken(appToken));
    const conn = await slackPost('apps.connections.open', appToken);
    if (!conn.ok) {
      const e = String(conn.error);
      add(
        'connections:write',
        false,
        e === 'not_allowed_token_type'
          ? 'app-level token이 아니다'
          : e === 'missing_scope'
            ? 'connections:write scope가 없다'
            : `실패: ${e}`,
      );
    } else {
      // URL 자체는 비밀이므로 출력하지 않는다.
      add('connections:write', true, 'WebSocket URL 발급 성공 (연결하지 않음)');
    }
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

export function formatVerify(r: VerifyResult): string {
  const lines = r.checks.map((c) => `  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name.padEnd(18)} ${c.detail}`);
  lines.push('', r.ok ? '모든 확인 통과' : '실패 항목이 있다');
  return lines.join('\n');
}
