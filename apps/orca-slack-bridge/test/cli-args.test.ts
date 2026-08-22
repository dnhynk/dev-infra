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

  it('digest를 인식한다', () => {
    const p = parseArgs(['digest']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') expect(p.command).toBe('digest');
  });

  it('모든 문서화된 명령이 인식된다', () => {
    for (const c of ['snapshot', 'verify-slack', 'digest']) {
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

describe('digest 옵션', () => {
  it('기본값은 실제 게시이며 대상을 좁히지 않는다', () => {
    const p = parseArgs(['digest']);
    if (p.kind === 'run') {
      expect(p.dryRun).toBe(false);
      expect(p.pr).toBeNull();
      expect(p.statePath).toBeNull();
    }
  });

  it('--dry-run, --pr, --state를 읽는다', () => {
    const p = parseArgs(['digest', '--dry-run', '--pr', '5', '--state', 'D:/state.db']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') {
      expect(p.dryRun).toBe(true);
      expect(p.pr).toBe(5);
      expect(p.statePath).toBe('D:/state.db');
    }
  });

  it('잘못된 --pr은 오류', () => {
    expect(parseArgs(['digest', '--pr', '0']).kind).toBe('error');
    expect(parseArgs(['digest', '--pr', 'x']).kind).toBe('error');
    expect(parseArgs(['digest', '--pr', '-1']).kind).toBe('error');
  });

  // digest만 외부 write를 한다. --dry-run 오타를 무시하면 확인 없이 실제 채널에 게시된다.
  it('digest는 모르는 플래그를 무시하지 않고 오류로 만든다', () => {
    const p = parseArgs(['digest', '--dry-runn']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') expect(p.message).toContain('--dry-runn');
  });

  it('write하지 않는 명령의 기존 동작은 바꾸지 않는다', () => {
    expect(parseArgs(['snapshot', '--dry-runn']).kind).toBe('run');
  });
});

describe('값 플래그의 값', () => {
  // 회귀 방지: 이전 버전은 `digest --pr`을 pr=null로 흘렸다. 좁히려던 의도와 반대로
  // 설정의 모든 PR에 실제 게시된다.
  it('값이 없으면 오류다 — 기본값으로 조용히 내려가지 않는다', () => {
    const p = parseArgs(['digest', '--pr']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') expect(p.message).toContain('--pr');
  });

  // 회귀 방지: 이전 버전은 `digest --state`를 statePath=null로 흘려 기본 DB를 열었다.
  it('--state에 값이 없으면 오류다', () => {
    const p = parseArgs(['digest', '--state']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') expect(p.message).toContain('--state');
  });

  // 회귀 방지: 이전 버전은 --dry-runn을 --state의 값으로 삼아 dryRun=false로 실제 게시하면서
  // '--dry-runn'이라는 이름의 DB를 열었다. 기존 매핑을 못 찾아 루트가 하나 더 생긴다.
  it('값 자리에 플래그가 오면 오류다 — 오타가 값으로 먹히지 않는다', () => {
    const p = parseArgs(['digest', '--state', '--dry-runn']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') {
      expect(p.message).toContain('--state');
      expect(p.message).toContain('--dry-runn');
    }
  });

  it('write하지 않는 명령에도 같은 검사를 건다. 값 없는 값 플래그는 어디서도 유효하지 않다', () => {
    expect(parseArgs(['snapshot', '--config']).kind).toBe('error');
    expect(parseArgs(['snapshot', '--pr-limit', '--json']).kind).toBe('error');
    expect(parseArgs(['verify-slack', '--orca']).kind).toBe('error');
  });

  it('값이 제대로 있으면 그대로 통과한다', () => {
    const p = parseArgs(['digest', '--pr', '4', '--dry-run']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') {
      expect(p.pr).toBe(4);
      expect(p.dryRun).toBe(true);
    }
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
