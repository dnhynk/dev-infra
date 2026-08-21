import { describe, it, expect } from 'vitest';
import { parseConfig, projectForRepository, defaultConfigPath, DEFAULT_CORRELATION_KEYS } from '../src/project/config.js';

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
    expect(c.correlationKeys).toEqual(DEFAULT_CORRELATION_KEYS);
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

  it('owner/name 형식이 아니면 거부한다', () => {
    expect(() => parseConfig({ projects: [{ name: 'A', repositories: ['justname'] }] })).toThrow(TypeError);
  });

  it('빠진 값을 추측으로 채우지 않는다', () => {
    expect(() => parseConfig({})).toThrow(TypeError);
    expect(() => parseConfig({ projects: [{ name: '', repositories: ['o/r'] }] })).toThrow(TypeError);
    expect(() => parseConfig({ projects: [{ name: 'A', repositories: [] }] })).toThrow(TypeError);
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
