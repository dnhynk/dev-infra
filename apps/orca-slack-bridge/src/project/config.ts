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
  /**
   * 이 Project에 속한 **Orca repository id** 목록. 없으면 빈 배열.
   *
   * D1이 Orca Run을 이 Project에 연결하는 유일한 열쇠다(OD-078). Run row에는 repository 필드가
   * 없고, Task의 `created_by_process_incarnation`과 worker의 `resource.worktreeId`에 있는
   * `<repositoryId>::<path>` 앞부분만이 관측 가능한 연결점이다. Git remote는 읽지 않는다 —
   * 자동 발견·자동 등록은 O1 범위다(OD-068).
   *
   * 값을 얻는 방법: `orca worktree list --json`의 `repoId`(= worktree `id`의 `::` 앞부분).
   * 대조는 **exact 문자열 비교**다. 경로가 아니라 id로 등록하므로 정규화도 prefix 매칭도 없다.
   *
   * **[미검증 위험]** 이 id가 Orca 재설치·DB 재생성 뒤에도 유지되는지는 관측하지 않았고,
   * `<uuid>::<path>` 형식 안정성은 `docs/platform-capabilities.md` §7.1이 미검증으로 기록했다.
   * 둘 중 하나가 깨지면 등록이 어긋나 Run이 통째로 사라진다. 그래서 `run/collect.ts`는 맞지
   * 않는 Run을 버리지 않고 **세어서 degraded 사실로 노출한다**(OD-072).
   */
  readonly orcaRepositoryIds: readonly string[];
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
  const seenOrcaIds = new Map<string, string>();
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
    const idsRaw = p['orcaRepositoryIds'];
    if (idsRaw !== undefined && !Array.isArray(idsRaw)) {
      throw new TypeError(`projects[${i}].orcaRepositoryIds가 배열이 아니다`);
    }
    const orcaRepositoryIds = (idsRaw ?? []).map((v, j) => {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new TypeError(
          `projects[${i}].orcaRepositoryIds[${j}]가 비어 있지 않은 문자열이 아니다: ${String(v)}`,
        );
      }
      // `::`가 들어오면 worktree id를 통째로 붙여넣은 것이다. id만 등록해야 exact 비교가 성립한다.
      if (v.includes('::')) {
        throw new TypeError(
          `projects[${i}].orcaRepositoryIds[${j}]에 '::'가 있다. ` +
            `worktree id 전체가 아니라 '::' 앞의 repository id만 등록한다: ${v}`,
        );
      }
      const id = v.trim();
      const prevProject = seenOrcaIds.get(id);
      if (prevProject !== undefined && prevProject !== name.trim()) {
        // 한 repository id가 두 Project에 속하면 Run routing이 모호해진다.
        throw new TypeError(
          `Orca repository id ${id}가 여러 Project에 등록됐다: ${prevProject}, ${name.trim()}`,
        );
      }
      seenOrcaIds.set(id, name.trim());
      return id;
    });
    return { name: name.trim(), repositories, orcaRepositoryIds };
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

/**
 * Orca repository id로 등록된 Project를 찾는다. 없으면 null. 추측하지 않는다(OD-078).
 *
 * **exact 비교다.** 대소문자를 접지 않는다. 이 값은 사람이 읽는 이름이 아니라 Orca가 발급한
 * id이고, 관측된 값은 소문자 UUID였다. 접으면 실제로 다른 id를 같다고 말할 근거가 없다.
 */
export function projectForOrcaRepositoryId(config: BridgeConfig, id: string): string | null {
  for (const p of config.projects) {
    if (p.orcaRepositoryIds.includes(id)) return p.name;
  }
  return null;
}
