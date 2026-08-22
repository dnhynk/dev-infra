import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Bridge 설정.
 *
 * 저장소가 public이므로 이 파일은 저장소 밖에 둔다(OD-027, DL-015).
 * 저장소에는 `config.example.json`만 커밋한다.
 */
export type BridgeConfig = {
  readonly slack: SlackConfig | null;
  readonly projects: readonly ProjectConfig[];
  /** PR body에서 correlation ID를 읽을 때 쓸 key 이름. 형식 확정 전까지 주입받는다(OD-021). */
  readonly correlationKeys: CorrelationKeys;
};

/**
 * Slack 식별자. **토큰은 여기 두지 않는다.**
 * 토큰은 환경변수 SLACK_BOT_TOKEN / SLACK_APP_TOKEN로만 주입한다.
 */
export type SlackConfig = {
  readonly teamId: string;
  /** Gate 결정 권한이 있는 실제 sender user ID. channel 소속이 아니라 이 목록으로 판정한다. */
  readonly ownerUserIds: readonly string[];
  readonly channels: {
    readonly prDigest: string;
    readonly agentRuns: string;
  };
};

export type ProjectConfig = {
  /** 사람이 보는 이름. Slack identity 영역에 쓴다. */
  readonly name: string;
  /** `owner/name` 목록. 대소문자를 구분하지 않고 비교한다. */
  readonly repositories: readonly string[];
};

export type CorrelationKeys = {
  readonly run: string;
  readonly task: string;
  readonly dispatch: string;
};

export const DEFAULT_CORRELATION_KEYS: CorrelationKeys = {
  run: 'orca-run',
  task: 'orca-task',
  dispatch: 'orca-dispatch',
};

/** 설정 파일 기본 경로. `--config`와 환경변수가 우선한다. */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['ORCA_SLACK_BRIDGE_CONFIG'];
  if (explicit && explicit.trim() !== '') return explicit;
  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData && appData.trim() !== '') {
      return join(appData, 'orca-slack-bridge', 'config.json');
    }
  }
  const xdg = env['XDG_CONFIG_HOME'];
  const base = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return join(base, 'orca-slack-bridge', 'config.json');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 설정을 검증한다. 빠진 값을 추측으로 채우지 않는다. */
/** 설정 어디에도 토큰 값이 들어가지 않게 막는다. 잘못된 위치에 붙여넣는 사고를 잡는다. */
function assertNoTokens(node: unknown, path = 'config'): void {
  if (typeof node === 'string') {
    if (/^x(ox[bpsa]|app)-/.test(node.trim())) {
      throw new TypeError(
        `${path}에 Slack 토큰으로 보이는 값이 있다. 토큰은 설정 파일이 아니라 환경변수로 주입한다`,
      );
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => assertNoTokens(v, `${path}[${i}]`));
    return;
  }
  if (isRecord(node)) {
    for (const [k, v] of Object.entries(node)) assertNoTokens(v, `${path}.${k}`);
  }
}

function parseSlack(raw: unknown): SlackConfig | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) throw new TypeError('slack이 객체가 아니다');
  const id = (key: string, prefix: string): string => {
    const v = raw[key];
    if (typeof v !== 'string' || !v.startsWith(prefix)) {
      throw new TypeError(`slack.${key}가 ${prefix}로 시작하는 ID가 아니다`);
    }
    return v;
  };
  const owners = raw['ownerUserIds'];
  if (!Array.isArray(owners) || owners.length === 0) {
    throw new TypeError('slack.ownerUserIds가 비어 있다. Gate 결정 권한의 근거다');
  }
  const ownerUserIds = owners.map((o, i) => {
    if (typeof o !== 'string' || !o.startsWith('U')) {
      throw new TypeError(`slack.ownerUserIds[${i}]가 U로 시작하는 user ID가 아니다`);
    }
    return o;
  });
  const ch = raw['channels'];
  if (!isRecord(ch)) throw new TypeError('slack.channels가 없다');
  const channel = (key: string): string => {
    const v = ch[key];
    // 공개 채널 C, private G, 일부 워크스페이스는 C로 통일된다.
    if (typeof v !== 'string' || !/^[CG]/.test(v)) {
      throw new TypeError(`slack.channels.${key}가 채널 ID가 아니다. 이름이 아니라 ID를 쓴다`);
    }
    return v;
  };
  return {
    teamId: id('teamId', 'T'),
    ownerUserIds,
    channels: { prDigest: channel('prDigest'), agentRuns: channel('agentRuns') },
  };
}

export function parseConfig(raw: unknown): BridgeConfig {
  if (!isRecord(raw)) throw new TypeError('설정이 객체가 아니다');
  assertNoTokens(raw);
  const projectsRaw = raw['projects'];
  if (!Array.isArray(projectsRaw)) throw new TypeError('설정에 projects 배열이 없다');

  const seen = new Map<string, string>();
  const projects = projectsRaw.map((p, i) => {
    if (!isRecord(p)) throw new TypeError(`projects[${i}]가 객체가 아니다`);
    const name = p['name'];
    const repos = p['repositories'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError(`projects[${i}].name이 비어 있다`);
    }
    if (!Array.isArray(repos) || repos.length === 0) {
      throw new TypeError(`projects[${i}].repositories가 비어 있다`);
    }
    const repositories = repos.map((r, j) => {
      if (typeof r !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(r.trim())) {
        throw new TypeError(`projects[${i}].repositories[${j}]가 owner/name 형식이 아니다: ${String(r)}`);
      }
      const key = r.trim().toLowerCase();
      const prev = seen.get(key);
      if (prev !== undefined && prev !== name.trim()) {
        // 한 repository가 두 Project에 속하면 Slack routing이 모호해진다.
        throw new TypeError(`repository ${r.trim()}가 여러 Project에 등록됐다: ${prev}, ${name.trim()}`);
      }
      seen.set(key, name.trim());
      return r.trim();
    });
    return { name: name.trim(), repositories };
  });

  const keysRaw = raw['correlationKeys'];
  const correlationKeys: CorrelationKeys = isRecord(keysRaw)
    ? {
        run: typeof keysRaw['run'] === 'string' ? keysRaw['run'] : DEFAULT_CORRELATION_KEYS.run,
        task: typeof keysRaw['task'] === 'string' ? keysRaw['task'] : DEFAULT_CORRELATION_KEYS.task,
        dispatch:
          typeof keysRaw['dispatch'] === 'string'
            ? keysRaw['dispatch']
            : DEFAULT_CORRELATION_KEYS.dispatch,
      }
    : DEFAULT_CORRELATION_KEYS;

  return { slack: parseSlack(raw['slack']), projects, correlationKeys };
}

export async function loadConfig(path: string): Promise<BridgeConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`설정 파일을 읽을 수 없다: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SyntaxError(`설정 파일이 JSON이 아니다: ${path}`);
  }
  return parseConfig(raw);
}

/** `owner/name`으로 Project를 찾는다. 없으면 null. 추측하지 않는다. */
export function projectForRepository(config: BridgeConfig, nameWithOwner: string): string | null {
  const needle = nameWithOwner.trim().toLowerCase();
  for (const p of config.projects) {
    if (p.repositories.some((r) => r.toLowerCase() === needle)) return p.name;
  }
  return null;
}
