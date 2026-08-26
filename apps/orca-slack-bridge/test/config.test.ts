import { describe, it, expect } from 'vitest';
import {
  parseConfig,
  projectForRepository,
  defaultConfigPath,
  DEFAULT_AUTOMATION_CONFIG,
  DEFAULT_CORRELATION_KEYS,
  MAX_EXPLICIT_REPOSITORIES_PER_PROJECT,
} from '../src/project/config.js';

const valid = {
  projects: [
    { name: 'Tone & Move', repositories: ['dnhynk/ToneAndMove'] },
    { name: 'Vertical Live', repositories: ['dnhynk/vertical-live', 'dnhynk/vertical-live-infra'] },
  ],
};

describe('parseConfig', () => {
  it('유효한 설정을 읽는다', () => {
    const c = parseConfig(valid);
    expect(c.projects).toHaveLength(2);
    expect(c.projects[0]?.repositories).toEqual(['dnhynk/toneandmove']);
    expect(c.correlationKeys).toEqual(DEFAULT_CORRELATION_KEYS);
    expect(c.automation).toEqual(DEFAULT_AUTOMATION_CONFIG);
  });

  it('correlationKeys를 override할 수 있다 (OD-021 미확정 대응)', () => {
    const c = parseConfig({ ...valid, correlationKeys: { run: 'x-run' } });
    expect(c.correlationKeys.run).toBe('x-run');
    expect(c.correlationKeys.task).toBe(DEFAULT_CORRELATION_KEYS.task);
  });

  it('한 repository가 두 Project에 속하면 거부한다', () => {
    expect(() =>
      parseConfig({
        projects: [
          { name: 'A', repositories: ['o/r'] },
          { name: 'B', repositories: ['o/r'] },
        ],
      }),
    ).toThrow(/여러 Project/);
  });

  it('대소문자만 다른 중복도 잡는다', () => {
    expect(() =>
      parseConfig({
        projects: [
          { name: 'A', repositories: ['o/R'] },
          { name: 'B', repositories: ['O/r'] },
        ],
      }),
    ).toThrow(/여러 Project/);
  });

  it('Project name을 case-fold한 중복을 거부한다', () => {
    expect(() => parseConfig({ projects: [
      { name: 'Project A', repositories: ['o/a'] },
      { name: 'project a', repositories: ['o/b'] },
    ] })).toThrow(/case-fold 중복/);
    expect(() => parseConfig({ projects: [
      { name: 'Straße', repositories: ['o/a'] },
      { name: 'STRASSE', repositories: ['o/b'] },
    ] })).toThrow(/case-fold 중복/);
  });

  it('같은 Project 안의 repository 중복을 대소문자와 무관하게 거부한다', () => {
    expect(() => parseConfig({ projects: [
      { name: 'A', repositories: ['Owner/Repo', 'owner/repo'] },
    ] })).toThrow(/같은 Project 안에 중복/);
  });

  it('같은 Project와 여러 Project의 exact Orca ID 중복을 거부한다', () => {
    expect(() => parseConfig({ projects: [
      { name: 'A', repositories: ['o/a'], orcaRepositoryIds: ['repo-1', 'repo-1'] },
    ] })).toThrow(/같은 Project 안에 중복/);
    expect(() => parseConfig({ projects: [
      { name: 'A', repositories: ['o/a'], orcaRepositoryIds: ['repo-1'] },
      { name: 'B', repositories: ['o/b'], orcaRepositoryIds: ['repo-1'] },
    ] })).toThrow(/여러 Project에 등록/);
  });

  it('Orca ID duplicate 비교는 exact이며 case-fold하지 않는다', () => {
    expect(parseConfig({ projects: [
      { name: 'A', repositories: ['o/a'], orcaRepositoryIds: ['Repo-1', 'repo-1'] },
    ] }).projects[0]?.orcaRepositoryIds).toEqual(['Repo-1', 'repo-1']);
  });

  it('Project별 configured repository bound의 edge를 받으며 초과는 거부한다', () => {
    const repositories = Array.from(
      { length: MAX_EXPLICIT_REPOSITORIES_PER_PROJECT },
      (_, index) => `owner/repo-${index}`,
    );
    expect(parseConfig({ projects: [{ name: 'A', repositories, orcaRepositoryIds: ['repo-1'] }] }))
      .toBeDefined();
    expect(() => parseConfig({
      projects: [{ name: 'A', repositories: [...repositories, 'owner/overflow'] }],
    })).toThrow(/상한 16/);
  });

  it('owner/name 형식이 아니면 거부한다', () => {
    expect(() => parseConfig({ projects: [{ name: 'A', repositories: ['justname'] }] })).toThrow(TypeError);
    expect(() => parseConfig({ projects: [{ name: 'A', repositories: ['owner/repository.git'] }] }))
      .toThrow(TypeError);
  });

  it('빠진 값을 추측으로 채우지 않는다', () => {
    expect(() => parseConfig({})).toThrow(TypeError);
    expect(() => parseConfig({ projects: [{ name: '', repositories: ['o/r'] }] })).toThrow(TypeError);
    expect(() => parseConfig({ projects: [{ name: 'A', repositories: [] }] })).toThrow(TypeError);
  });
});

describe('automation config', () => {
  const base = { projects: [{ name: 'A', repositories: ['owner/repository'] }] };

  it('omission defaults to enabled deterministic O1 observers', () => {
    const automation = parseConfig(base).automation;
    expect(automation).toEqual(DEFAULT_AUTOMATION_CONFIG);
    expect(automation.enabled).toBe(true);
    expect(automation.deterministicNoLlm).toBe(true);
    expect(automation.prDigest.prLimit).toBe(10);
    expect(automation.repositoryDiscovery).toEqual({ intervalSeconds: 300, timeoutSeconds: 30 });
    expect(automation.prDigest.globalPrBudget).toBe(100);
  });

  it('enabled=false disables only the O1 observer flag while preserving all defaults', () => {
    const automation = parseConfig({ ...base, automation: { enabled: false } }).automation;
    expect(automation).toEqual({ ...DEFAULT_AUTOMATION_CONFIG, enabled: false });
  });

  it('accepts all documented bound edges and partial overrides', () => {
    const automation = parseConfig({
      ...base,
      automation: {
        repositoryDiscovery: { intervalSeconds: 3_600, timeoutSeconds: 10 },
        runObserver: { intervalSeconds: 30, timeoutSeconds: 300 },
        prDigest: {
          intervalSeconds: 7_200,
          timeoutSeconds: 60,
          prLimit: 50,
          globalPrBudget: 1_000,
        },
        github: { commandBudgetPerHour: 200, rateLimitFloor: 4_000 },
        scheduler: { jitterRatio: 0.25 },
        health: { heartbeatSeconds: 5, staleAfterSeconds: 30 },
        capacity: { repositories: 64, runsPerPass: 1, orcaIdsPerCanonicalRepository: 64 },
        logging: { maxFileMiB: 100, backupCount: 1 },
      },
    }).automation;
    expect(automation.runObserver).toEqual({ intervalSeconds: 30, timeoutSeconds: 300 });
    expect(automation.repositoryDiscovery).toEqual({ intervalSeconds: 3_600, timeoutSeconds: 10 });
    expect(automation.prDigest).toEqual({
      intervalSeconds: 7_200,
      timeoutSeconds: 60,
      prLimit: 50,
      globalPrBudget: 1_000,
    });
    expect(automation.health).toEqual({ heartbeatSeconds: 5, staleAfterSeconds: 30 });
    expect(automation.logging).toEqual({ maxFileMiB: 100, backupCount: 1 });
  });

  it('raises an omitted stale threshold to the heartbeat-relative floor', () => {
    expect(parseConfig({
      ...base,
      automation: { health: { heartbeatSeconds: 60 } },
    }).automation.health).toEqual({ heartbeatSeconds: 60, staleAfterSeconds: 180 });
  });

  const boundCases: readonly [string, unknown, unknown, unknown, unknown][] = [
    ['repositoryDiscovery.intervalSeconds', { repositoryDiscovery: { intervalSeconds: 60 } }, { repositoryDiscovery: { intervalSeconds: 3_600 } }, { repositoryDiscovery: { intervalSeconds: 59 } }, { repositoryDiscovery: { intervalSeconds: 3_601 } }],
    ['repositoryDiscovery.timeoutSeconds', { repositoryDiscovery: { timeoutSeconds: 10 } }, { repositoryDiscovery: { timeoutSeconds: 120 } }, { repositoryDiscovery: { timeoutSeconds: 9 } }, { repositoryDiscovery: { timeoutSeconds: 121 } }],
    ['runObserver.intervalSeconds', { runObserver: { intervalSeconds: 30 } }, { runObserver: { intervalSeconds: 900 } }, { runObserver: { intervalSeconds: 29 } }, { runObserver: { intervalSeconds: 901 } }],
    ['runObserver.timeoutSeconds', { runObserver: { timeoutSeconds: 15 } }, { runObserver: { timeoutSeconds: 300 } }, { runObserver: { timeoutSeconds: 14 } }, { runObserver: { timeoutSeconds: 301 } }],
    ['prDigest.intervalSeconds', { prDigest: { intervalSeconds: 300 } }, { prDigest: { intervalSeconds: 7_200 } }, { prDigest: { intervalSeconds: 299 } }, { prDigest: { intervalSeconds: 7_201 } }],
    ['prDigest.timeoutSeconds', { prDigest: { timeoutSeconds: 60 } }, { prDigest: { timeoutSeconds: 900 } }, { prDigest: { timeoutSeconds: 59 } }, { prDigest: { timeoutSeconds: 901 } }],
    ['prDigest.prLimit', { prDigest: { prLimit: 1 } }, { prDigest: { prLimit: 50 } }, { prDigest: { prLimit: 0 } }, { prDigest: { prLimit: 51 } }],
    ['prDigest.globalPrBudget', { prDigest: { globalPrBudget: 1 } }, { prDigest: { globalPrBudget: 1_000 } }, { prDigest: { globalPrBudget: 0 } }, { prDigest: { globalPrBudget: 1_001 } }],
    ['github.commandBudgetPerHour', { github: { commandBudgetPerHour: 200 } }, { github: { commandBudgetPerHour: 4_000 } }, { github: { commandBudgetPerHour: 199 } }, { github: { commandBudgetPerHour: 4_001 } }],
    ['github.rateLimitFloor', { github: { rateLimitFloor: 100 } }, { github: { rateLimitFloor: 4_000 } }, { github: { rateLimitFloor: 99 } }, { github: { rateLimitFloor: 4_001 } }],
    ['scheduler.jitterRatio', { scheduler: { jitterRatio: 0 } }, { scheduler: { jitterRatio: 0.25 } }, { scheduler: { jitterRatio: -0.001 } }, { scheduler: { jitterRatio: 0.251 } }],
    ['health.heartbeatSeconds', { health: { heartbeatSeconds: 5 } }, { health: { heartbeatSeconds: 60 } }, { health: { heartbeatSeconds: 4 } }, { health: { heartbeatSeconds: 61 } }],
    ['health.staleAfterSeconds', { health: { heartbeatSeconds: 5, staleAfterSeconds: 30 } }, { health: { staleAfterSeconds: 600 } }, { health: { heartbeatSeconds: 5, staleAfterSeconds: 29 } }, { health: { staleAfterSeconds: 601 } }],
    ['capacity.repositories', { capacity: { repositories: 1 } }, { capacity: { repositories: 64 } }, { capacity: { repositories: 0 } }, { capacity: { repositories: 65 } }],
    ['capacity.runsPerPass', { capacity: { runsPerPass: 1 } }, { capacity: { runsPerPass: 256 } }, { capacity: { runsPerPass: 0 } }, { capacity: { runsPerPass: 257 } }],
    ['capacity.orcaIdsPerCanonicalRepository', { capacity: { orcaIdsPerCanonicalRepository: 1 } }, { capacity: { orcaIdsPerCanonicalRepository: 64 } }, { capacity: { orcaIdsPerCanonicalRepository: 0 } }, { capacity: { orcaIdsPerCanonicalRepository: 65 } }],
    ['logging.maxFileMiB', { logging: { maxFileMiB: 1 } }, { logging: { maxFileMiB: 100 } }, { logging: { maxFileMiB: 0 } }, { logging: { maxFileMiB: 101 } }],
    ['logging.backupCount', { logging: { backupCount: 1 } }, { logging: { backupCount: 20 } }, { logging: { backupCount: 0 } }, { logging: { backupCount: 21 } }],
  ];
  it.each(boundCases)('accepts both documented bound edges for %s', (_name, minimum, maximum) => {
    expect(() => parseConfig({ ...base, automation: minimum })).not.toThrow();
    expect(() => parseConfig({ ...base, automation: maximum })).not.toThrow();
  });
  it.each(boundCases)('rejects values immediately outside %s', (_name, _minimum, _maximum, below, above) => {
    expect(() => parseConfig({ ...base, automation: below })).toThrow(TypeError);
    expect(() => parseConfig({ ...base, automation: above })).toThrow(TypeError);
  });

  it('rejects non-integers, wrong types, and unknown keys deterministically', () => {
    expect(() => parseConfig({ ...base, automation: { prDigest: { prLimit: 1.5 } } }))
      .toThrow(/정수/);
    expect(() => parseConfig({ ...base, automation: { enabled: 'yes' } }))
      .toThrow(/boolean/);
    expect(() => parseConfig({ ...base, automation: { unknown: true } }))
      .toThrow(/허용되지 않은/);
    expect(() => parseConfig({ ...base, automation: { github: { unknown: true } } }))
      .toThrow(/허용되지 않은/);
  });

  it('token rejection remains global inside automation', () => {
    expect(() => parseConfig({
      ...base,
      automation: { note: `xoxb-${'X'.repeat(20)}` },
    })).toThrow(/토큰으로 보이는 값/);
  });
});

describe('projectForRepository', () => {
  const c = parseConfig(valid);
  it('등록된 repository의 Project를 찾는다', () => {
    expect(projectForRepository(c, 'dnhynk/ToneAndMove')).toBe('Tone & Move');
    expect(projectForRepository(c, 'DNHYNK/vertical-live')).toBe('Vertical Live');
  });
  it('미등록이면 추측하지 않고 null', () => {
    expect(projectForRepository(c, 'dnhynk/unknown')).toBeNull();
  });
});

describe('defaultConfigPath', () => {
  it('환경변수가 최우선', () => {
    expect(defaultConfigPath({ ORCA_SLACK_BRIDGE_CONFIG: 'C:/x/y.json' } as NodeJS.ProcessEnv)).toBe('C:/x/y.json');
  });
  it('저장소 안 경로를 반환하지 않는다', () => {
    const p = defaultConfigPath({ APPDATA: 'C:/Users/x/AppData/Roaming' } as NodeJS.ProcessEnv);
    expect(p).toContain('orca-slack-bridge');
    expect(p).not.toContain('dev-infra');
  });
});
