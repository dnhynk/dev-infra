import { describe, it, expect } from 'vitest';
import { parseArgs, decideEntrypoint } from '../src/cli.js';

describe('명령 분기', () => {
  it('snapshot을 인식한다', () => {
    const p = parseArgs(['snapshot']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') expect(p.command).toBe('snapshot');
  });

  it('verify-slack을 인식한다', () => {
    // 회귀 방지: 이전 버전은 snapshot만 인식하고 verify-slack에 usage를 출력했다.
    const p = parseArgs(['verify-slack']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') expect(p.command).toBe('verify-slack');
  });

  it('모든 문서화된 명령이 인식된다', () => {
    for (const c of ['snapshot', 'verify-slack']) {
      expect(parseArgs([c]).kind).toBe('run');
    }
  });

  it('인자 없이는 도움말', () => {
    expect(parseArgs([]).kind).toBe('help');
  });

  it('--help는 명령이 있어도 도움말', () => {
    expect(parseArgs(['snapshot', '--help']).kind).toBe('help');
  });

  it('알 수 없는 명령은 오류로 구분한다 — 도움말과 같은 취급을 하지 않는다', () => {
    const p = parseArgs(['snapshotz']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') expect(p.message).toContain('snapshotz');
  });

  it('옵션을 읽는다', () => {
    const p = parseArgs(['snapshot', '--config', 'C:/x.json', '--orca', 'C:/orca.exe', '--pr-limit', '5', '--json']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') {
      expect(p.configPath).toBe('C:/x.json');
      expect(p.orcaBin).toBe('C:/orca.exe');
      expect(p.prLimit).toBe(5);
      expect(p.json).toBe(true);
    }
  });

  it('기본 pr-limit은 50이고 옵션이 없으면 null로 남긴다', () => {
    const p = parseArgs(['snapshot']);
    if (p.kind === 'run') {
      expect(p.prLimit).toBe(50);
      expect(p.configPath).toBeNull();
      expect(p.orcaBin).toBeNull();
      expect(p.json).toBe(false);
    }
  });

  it('잘못된 pr-limit은 오류', () => {
    expect(parseArgs(['snapshot', '--pr-limit', '0']).kind).toBe('error');
    expect(parseArgs(['snapshot', '--pr-limit', 'x']).kind).toBe('error');
    expect(parseArgs(['snapshot', '--pr-limit', '-3']).kind).toBe('error');
  });
});

describe('진입점 판정', () => {
  it('true면 실행한다', () => {
    expect(decideEntrypoint(true, 'v26.7.0').kind).toBe('run');
  });

  it('false면 import된 상태이므로 실행하지 않는다', () => {
    expect(decideEntrypoint(false, 'v26.7.0').kind).toBe('imported');
  });

  it('필드가 없으면 조용히 넘어가지 않고 원인을 밝힌다', () => {
    // 회귀 방지: 이전 버전은 undefined를 falsy로 흘려 아무 출력 없이 exit 0으로 끝났다.
    const d = decideEntrypoint(undefined, 'v20.19.0');
    expect(d.kind).toBe('unsupported');
    if (d.kind === 'unsupported') {
      expect(d.message).toContain('import.meta.main');
      expect(d.message).toContain('>=26');
      expect(d.message).toContain('v20.19.0');
    }
  });
});
