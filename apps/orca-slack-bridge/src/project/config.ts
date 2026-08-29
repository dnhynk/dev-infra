import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GithubRemoteError, normalizeGithubNameWithOwner } from '../discovery/github-remote.js';

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
  /** Parsed configs always contain this; optional keeps legacy hand-built test/caller fixtures valid. */
  readonly automation?: AutomationConfig;
};

export type ParsedBridgeConfig = BridgeConfig & { readonly automation: AutomationConfig };

export type AutomationConfig = {
  /** Controls only O1 discovery/Run/digest observer jobs. D2/D3 Gate/Channel jobs are independent. */
  readonly enabled: boolean;
  readonly repositoryDiscovery: {
    readonly intervalSeconds: number;
    readonly timeoutSeconds: number;
  };
  readonly runObserver: {
    readonly intervalSeconds: number;
    readonly timeoutSeconds: number;
  };
  /**
   * Durable Gate outbox sweep.
   *
   * The Slack action path resolves in real time, but an action whose Orca mutation was interrupted
   * (transient Orca failure, daemon death mid-flight) leaves a durable intent that nothing retries
   * without this pass. The owner sees a pressed button and no resolution.
   */
  readonly gateReconcile: {
    readonly intervalSeconds: number;
    readonly timeoutSeconds: number;
  };
  /**
   * 막힌 agent 터미널의 대화형 프롬프트를 읽고, 확정된 답을 보낸다.
   *
   * 무인 운용에서 멈춤은 대부분 터미널 프롬프트로 나타난다. 이 주기가 곧 "사람이 막힌 것을
   * 알게 되기까지의 시간"이라 Gate 재조정보다 짧게 둔다.
   */
  readonly terminalPrompt: {
    readonly intervalSeconds: number;
    readonly timeoutSeconds: number;
  };
  readonly prDigest: {
    readonly intervalSeconds: number;
    readonly timeoutSeconds: number;
    /** Daemon-only limit. The existing one-shot digest default remains 50. */
    readonly prLimit: number;
    readonly globalPrBudget: number;
  };
  readonly github: {
    readonly commandBudgetPerHour: number;
    readonly rateLimitFloor: number;
  };
  readonly scheduler: { readonly jitterRatio: number };
  readonly health: {
    readonly heartbeatSeconds: number;
    readonly staleAfterSeconds: number;
  };
  readonly capacity: {
    readonly repositories: number;
    readonly runsPerPass: number;
    readonly orcaIdsPerCanonicalRepository: number;
  };
  readonly logging: {
    readonly maxFileMiB: number;
    readonly backupCount: number;
  };
  /** O1 daemon scheduling/routing must never consult an LLM. */
  readonly deterministicNoLlm: true;
};

export const DEFAULT_AUTOMATION_CONFIG: AutomationConfig = Object.freeze({
  enabled: true,
  repositoryDiscovery: Object.freeze({ intervalSeconds: 300, timeoutSeconds: 30 }),
  runObserver: Object.freeze({ intervalSeconds: 120, timeoutSeconds: 90 }),
  // 60s so a stuck decision converges well inside the owner's attention span; the engine's own
  // 20s reconcile deadline bounds one pass.
  gateReconcile: Object.freeze({ intervalSeconds: 60, timeoutSeconds: 30 }),
  // 30s. 이 값이 사람이 막힘을 알게 되기까지의 지연이다. 한 pass는 터미널 수만큼의 read이고
  // 실측에서 16대가 있었으므로 이 주기에서 비용이 문제 되지 않는다.
  terminalPrompt: Object.freeze({ intervalSeconds: 30, timeoutSeconds: 120 }),
  prDigest: Object.freeze({
    intervalSeconds: 900,
    timeoutSeconds: 300,
    prLimit: 10,
    globalPrBudget: 100,
  }),
  github: Object.freeze({ commandBudgetPerHour: 2_000, rateLimitFloor: 1_000 }),
  scheduler: Object.freeze({ jitterRatio: 0.1 }),
  health: Object.freeze({ heartbeatSeconds: 15, staleAfterSeconds: 90 }),
  capacity: Object.freeze({
    repositories: 16,
    runsPerPass: 64,
    orcaIdsPerCanonicalRepository: 16,
  }),
  logging: Object.freeze({ maxFileMiB: 5, backupCount: 5 }),
  deterministicNoLlm: true,
});

export const MAX_EXPLICIT_REPOSITORIES_PER_PROJECT = 16;
/** Reserved prefix for synthesized discovery-only Project keys. */
export const AUTO_PROJECT_KEY_PREFIX = 'auto:';

/**
 * Slack 식별자. **토큰은 여기 두지 않는다.**
 *
 * 토큰은 환경변수 `ORCA_SLACK_BRIDGE_BOT_TOKEN` / `ORCA_SLACK_BRIDGE_APP_TOKEN`로만 주입한다.
 * 관례 이름 `SLACK_BOT_TOKEN`·`SLACK_APP_TOKEN`은 **읽지 않는다**(OD-005). 사용자 환경변수는
 * 같은 사용자의 모든 프로세스가 상속하므로, 관례 이름을 쓰면 나중에 만든 다른 Slack 앱이 이
 * Bridge의 토큰을 조용히 집어간다. 이름은 `slack/verify.ts`가 권위이고, 관례 이름만 설정된
 * 경우는 `verify-slack`이 옮기라고 알려준다.
 */
export type SlackConfig = {
  readonly teamId: string;
  /** Socket `hello.connection_info.app_id`와 exact 비교할 선택적 App ID(OD-042). */
  readonly apiAppId?: string;
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
   * `<repositoryId>::<path>` 앞부분만이 관측 가능한 연결점이다. 현재 D1 route는 Git remote를 읽지
   * 않는다. O1 strict discovery는 별도 adapter이며 이 manual fallback을 제거하지 않는다(OD-068).
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

/** Locale-independent compatibility fold for Project identity comparisons. */
function caseFold(value: string): string {
  return value.normalize('NFKC').toUpperCase().toLowerCase();
}

/** Explicit Project names may never enter the synthesized discovery namespace. */
export function isReservedAutoProjectName(value: string): boolean {
  return caseFold(value.trim()).startsWith(AUTO_PROJECT_KEY_PREFIX);
}

function assertOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[], at: string): void {
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${at}에 허용되지 않은 설정 key가 있다`);
}

function boundedNumber(
  value: unknown,
  fallback: number,
  at: string,
  min: number,
  max: number,
  integer = true,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    (integer && !Number.isSafeInteger(value)) ||
    value < min ||
    value > max
  ) {
    throw new TypeError(`${at}가 허용 범위 ${min}..${max} 안의 ${integer ? '정수' : '수'}가 아니다`);
  }
  return value;
}

function section(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): Record<string, unknown> {
  const value = raw[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new TypeError(`automation.${key}가 객체가 아니다`);
  assertOnlyKeys(value, allowed, `automation.${key}`);
  return value;
}

function parseAutomation(value: unknown): AutomationConfig {
  if (value === undefined) return DEFAULT_AUTOMATION_CONFIG;
  if (!isRecord(value)) throw new TypeError('automation이 객체가 아니다');
  assertOnlyKeys(
    value,
    [
      'enabled',
      'repositoryDiscovery',
      'runObserver',
      'gateReconcile',
      'terminalPrompt',
      'prDigest',
      'github',
      'scheduler',
      'health',
      'capacity',
      'logging',
    ],
    'automation',
  );
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') {
    throw new TypeError('automation.enabled가 boolean이 아니다');
  }

  const repositoryDiscovery = section(value, 'repositoryDiscovery', [
    'intervalSeconds',
    'timeoutSeconds',
  ]);
  const runObserver = section(value, 'runObserver', ['intervalSeconds', 'timeoutSeconds']);
  const gateReconcile = section(value, 'gateReconcile', ['intervalSeconds', 'timeoutSeconds']);
  const terminalPrompt = section(value, 'terminalPrompt', ['intervalSeconds', 'timeoutSeconds']);
  const prDigest = section(value, 'prDigest', [
    'intervalSeconds',
    'timeoutSeconds',
    'prLimit',
    'globalPrBudget',
  ]);
  const github = section(value, 'github', ['commandBudgetPerHour', 'rateLimitFloor']);
  const scheduler = section(value, 'scheduler', ['jitterRatio']);
  const health = section(value, 'health', ['heartbeatSeconds', 'staleAfterSeconds']);
  const capacity = section(value, 'capacity', [
    'repositories',
    'runsPerPass',
    'orcaIdsPerCanonicalRepository',
  ]);
  const logging = section(value, 'logging', ['maxFileMiB', 'backupCount']);

  const heartbeatSeconds = boundedNumber(
    health['heartbeatSeconds'],
    DEFAULT_AUTOMATION_CONFIG.health.heartbeatSeconds,
    'automation.health.heartbeatSeconds',
    5,
    60,
  );
  const staleAfterSeconds = boundedNumber(
    health['staleAfterSeconds'],
    Math.max(
      DEFAULT_AUTOMATION_CONFIG.health.staleAfterSeconds,
      Math.max(3 * heartbeatSeconds, 30),
    ),
    'automation.health.staleAfterSeconds',
    Math.max(3 * heartbeatSeconds, 30),
    600,
  );

  return {
    enabled: value['enabled'] ?? DEFAULT_AUTOMATION_CONFIG.enabled,
    repositoryDiscovery: {
      intervalSeconds: boundedNumber(
        repositoryDiscovery['intervalSeconds'],
        DEFAULT_AUTOMATION_CONFIG.repositoryDiscovery.intervalSeconds,
        'automation.repositoryDiscovery.intervalSeconds',
        60,
        3_600,
      ),
      timeoutSeconds: boundedNumber(
        repositoryDiscovery['timeoutSeconds'],
        DEFAULT_AUTOMATION_CONFIG.repositoryDiscovery.timeoutSeconds,
        'automation.repositoryDiscovery.timeoutSeconds',
        10,
        120,
      ),
    },
    runObserver: {
      intervalSeconds: boundedNumber(
        runObserver['intervalSeconds'],
        DEFAULT_AUTOMATION_CONFIG.runObserver.intervalSeconds,
        'automation.runObserver.intervalSeconds',
        30,
        900,
      ),
      timeoutSeconds: boundedNumber(
        runObserver['timeoutSeconds'],
        DEFAULT_AUTOMATION_CONFIG.runObserver.timeoutSeconds,
        'automation.runObserver.timeoutSeconds',
        15,
        300,
      ),
    },
    gateReconcile: {
      intervalSeconds: boundedNumber(
        gateReconcile['intervalSeconds'],
        DEFAULT_AUTOMATION_CONFIG.gateReconcile.intervalSeconds,
        'automation.gateReconcile.intervalSeconds',
        15,
        900,
      ),
      timeoutSeconds: boundedNumber(
        gateReconcile['timeoutSeconds'],
        DEFAULT_AUTOMATION_CONFIG.gateReconcile.timeoutSeconds,
        'automation.gateReconcile.timeoutSeconds',
        10,
        300,
      ),
    },
    terminalPrompt: {
      intervalSeconds: boundedNumber(
        terminalPrompt['intervalSeconds'],
        DEFAULT_AUTOMATION_CONFIG.terminalPrompt.intervalSeconds,
        'automation.terminalPrompt.intervalSeconds',
        10,
        900,
      ),
      timeoutSeconds: boundedNumber(
        terminalPrompt['timeoutSeconds'],
        DEFAULT_AUTOMATION_CONFIG.terminalPrompt.timeoutSeconds,
        'automation.terminalPrompt.timeoutSeconds',
        15,
        300,
      ),
    },
    prDigest: {
      intervalSeconds: boundedNumber(
        prDigest['intervalSeconds'],
        DEFAULT_AUTOMATION_CONFIG.prDigest.intervalSeconds,
        'automation.prDigest.intervalSeconds',
        300,
        7_200,
      ),
      timeoutSeconds: boundedNumber(
        prDigest['timeoutSeconds'],
        DEFAULT_AUTOMATION_CONFIG.prDigest.timeoutSeconds,
        'automation.prDigest.timeoutSeconds',
        60,
        900,
      ),
      prLimit: boundedNumber(
        prDigest['prLimit'],
        DEFAULT_AUTOMATION_CONFIG.prDigest.prLimit,
        'automation.prDigest.prLimit',
        1,
        50,
      ),
      globalPrBudget: boundedNumber(
        prDigest['globalPrBudget'],
        DEFAULT_AUTOMATION_CONFIG.prDigest.globalPrBudget,
        'automation.prDigest.globalPrBudget',
        1,
        1_000,
      ),
    },
    github: {
      commandBudgetPerHour: boundedNumber(
        github['commandBudgetPerHour'],
        DEFAULT_AUTOMATION_CONFIG.github.commandBudgetPerHour,
        'automation.github.commandBudgetPerHour',
        200,
        4_000,
      ),
      rateLimitFloor: boundedNumber(
        github['rateLimitFloor'],
        DEFAULT_AUTOMATION_CONFIG.github.rateLimitFloor,
        'automation.github.rateLimitFloor',
        100,
        4_000,
      ),
    },
    scheduler: {
      jitterRatio: boundedNumber(
        scheduler['jitterRatio'],
        DEFAULT_AUTOMATION_CONFIG.scheduler.jitterRatio,
        'automation.scheduler.jitterRatio',
        0,
        0.25,
        false,
      ),
    },
    health: { heartbeatSeconds, staleAfterSeconds },
    capacity: {
      repositories: boundedNumber(
        capacity['repositories'],
        DEFAULT_AUTOMATION_CONFIG.capacity.repositories,
        'automation.capacity.repositories',
        1,
        64,
      ),
      runsPerPass: boundedNumber(
        capacity['runsPerPass'],
        DEFAULT_AUTOMATION_CONFIG.capacity.runsPerPass,
        'automation.capacity.runsPerPass',
        1,
        256,
      ),
      orcaIdsPerCanonicalRepository: boundedNumber(
        capacity['orcaIdsPerCanonicalRepository'],
        DEFAULT_AUTOMATION_CONFIG.capacity.orcaIdsPerCanonicalRepository,
        'automation.capacity.orcaIdsPerCanonicalRepository',
        1,
        64,
      ),
    },
    logging: {
      maxFileMiB: boundedNumber(
        logging['maxFileMiB'],
        DEFAULT_AUTOMATION_CONFIG.logging.maxFileMiB,
        'automation.logging.maxFileMiB',
        1,
        100,
      ),
      backupCount: boundedNumber(
        logging['backupCount'],
        DEFAULT_AUTOMATION_CONFIG.logging.backupCount,
        'automation.logging.backupCount',
        1,
        20,
      ),
    },
    deterministicNoLlm: true,
  };
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
  const apiAppId = raw['apiAppId'];
  if (apiAppId !== undefined && (typeof apiAppId !== 'string' || !apiAppId.startsWith('A'))) {
    throw new TypeError('slack.apiAppId가 A로 시작하는 App ID가 아니다');
  }
  return {
    teamId: id('teamId', 'T'),
    ...(typeof apiAppId === 'string' ? { apiAppId } : {}),
    ownerUserIds,
    channels: { prDigest: channel('prDigest'), agentRuns: channel('agentRuns') },
  };
}

export function parseConfig(raw: unknown): ParsedBridgeConfig {
  if (!isRecord(raw)) throw new TypeError('설정이 객체가 아니다');
  assertNoTokens(raw);
  const projectsRaw = raw['projects'];
  if (!Array.isArray(projectsRaw)) throw new TypeError('설정에 projects 배열이 없다');

  const seenNames = new Map<string, number>();
  const seen = new Map<string, { readonly project: number; readonly item: number }>();
  const seenOrcaIds = new Map<string, { readonly project: number; readonly item: number }>();
  const projects = projectsRaw.map((p, i) => {
    if (!isRecord(p)) throw new TypeError(`projects[${i}]가 객체가 아니다`);
    const name = p['name'];
    const repos = p['repositories'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new TypeError(`projects[${i}].name이 비어 있다`);
    }
    const projectName = name.trim();
    if (isReservedAutoProjectName(projectName)) {
      throw new TypeError(`projects[${i}].name이 예약된 auto Project namespace를 사용한다`);
    }
    const nameKey = caseFold(projectName);
    const previousName = seenNames.get(nameKey);
    if (previousName !== undefined) {
      throw new TypeError(`projects[${i}].name이 projects[${previousName}].name과 case-fold 중복이다`);
    }
    seenNames.set(nameKey, i);
    if (!Array.isArray(repos) || repos.length === 0) {
      throw new TypeError(`projects[${i}].repositories가 비어 있다`);
    }
    if (repos.length > MAX_EXPLICIT_REPOSITORIES_PER_PROJECT) {
      throw new TypeError(
        `projects[${i}].repositories가 상한 ${MAX_EXPLICIT_REPOSITORIES_PER_PROJECT}을 넘는다`,
      );
    }
    const repositories = repos.map((r, j) => {
      if (typeof r !== 'string') {
        throw new TypeError(`projects[${i}].repositories[${j}]가 owner/name 형식이 아니다`);
      }
      const repository = r.trim();
      let canonicalRepository: ReturnType<typeof normalizeGithubNameWithOwner>;
      try {
        canonicalRepository = normalizeGithubNameWithOwner(repository);
      } catch (error) {
        if (error instanceof GithubRemoteError) {
          throw new TypeError(
            `projects[${i}].repositories[${j}]가 owner/name 계약을 위반했다: ${error.code}`,
          );
        }
        throw error;
      }
      const key = canonicalRepository.nameWithOwner;
      const prev = seen.get(key);
      if (prev !== undefined) {
        const scope = prev.project === i ? '같은 Project 안에 중복 등록됐다' : '여러 Project에 등록됐다';
        throw new TypeError(
          `projects[${i}].repositories[${j}]가 projects[${prev.project}].repositories[${prev.item}]와 ${scope}`,
        );
      }
      seen.set(key, { project: i, item: j });
      return canonicalRepository.nameWithOwner;
    });
    const idsRaw = p['orcaRepositoryIds'];
    if (idsRaw !== undefined && !Array.isArray(idsRaw)) {
      throw new TypeError(`projects[${i}].orcaRepositoryIds가 배열이 아니다`);
    }
    const orcaRepositoryIds = (idsRaw ?? []).map((v, j) => {
      if (typeof v !== 'string' || v.trim() === '') {
        throw new TypeError(`projects[${i}].orcaRepositoryIds[${j}]가 비어 있지 않은 문자열이 아니다`);
      }
      // `::`가 들어오면 worktree id를 통째로 붙여넣은 것이다. id만 등록해야 exact 비교가 성립한다.
      if (v.includes('::')) {
        throw new TypeError(
          `projects[${i}].orcaRepositoryIds[${j}]에 '::'가 있다. ` +
            `worktree id 전체가 아니라 '::' 앞의 repository id만 등록한다`,
        );
      }
      const id = v.trim();
      const prevProject = seenOrcaIds.get(id);
      if (prevProject !== undefined) {
        const scope = prevProject.project === i ? '같은 Project 안에 중복 등록됐다' : '여러 Project에 등록됐다';
        throw new TypeError(
          `projects[${i}].orcaRepositoryIds[${j}]가 ` +
            `projects[${prevProject.project}].orcaRepositoryIds[${prevProject.item}]와 ${scope}`,
        );
      }
      seenOrcaIds.set(id, { project: i, item: j });
      return id;
    });
    return { name: projectName, repositories, orcaRepositoryIds };
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

  return {
    slack: parseSlack(raw['slack']),
    projects,
    correlationKeys,
    automation: parseAutomation(raw['automation']),
  };
}

export async function loadConfig(path: string): Promise<ParsedBridgeConfig> {
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
