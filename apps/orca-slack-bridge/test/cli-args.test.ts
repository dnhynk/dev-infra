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

  it('verify-slack은 명시적 --socket에서만 Socket 연결을 요청한다', () => {
    const normal = parseArgs(['verify-slack']);
    const socket = parseArgs(['verify-slack', '--socket']);
    if (normal.kind === 'run') expect(normal.socket).toBe(false);
    if (socket.kind === 'run') expect(socket.socket).toBe(true);
  });

  it('--socket은 verify-slack 외 모든 명령에서 command-scoped unknown이다', () => {
    for (const argv of [
      ['snapshot', '--socket'],
      ['digest', '--socket'],
      ['runs', '--socket'],
      ['gate-register', '--input', 'gate.json', '--socket'],
    ]) {
      const p = parseArgs(argv);
      expect(p.kind).toBe('error');
      if (p.kind === 'error') {
        expect(p.message).toContain(String(argv[0]));
        expect(p.message).toContain('--socket');
      }
    }
  });

  it('digest를 인식한다', () => {
    const p = parseArgs(['digest']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') expect(p.command).toBe('digest');
  });

  it('runs를 인식한다', () => {
    const p = parseArgs(['runs']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') expect(p.command).toBe('runs');
  });

  it('gate-register를 인식한다', () => {
    const p = parseArgs(['gate-register', '--input', 'C:/gate.json']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') {
      expect(p.command).toBe('gate-register');
      expect(p.inputPath).toBe('C:/gate.json');
    }
  });

  it('모든 문서화된 명령이 인식된다', () => {
    for (const c of ['snapshot', 'verify-slack', 'digest', 'runs']) expect(parseArgs([c]).kind).toBe('run');
    expect(parseArgs(['gate-register', '--input', 'gate.json']).kind).toBe('run');
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

  // digest와 runs가 외부 write를 한다. --dry-run 오타를 무시하면 확인 없이 실제 채널에 게시된다.
  it('digest는 모르는 플래그를 무시하지 않고 오류로 만든다', () => {
    const p = parseArgs(['digest', '--dry-runn']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') expect(p.message).toContain('--dry-runn');
  });

  it('write하지 않는 명령의 기존 동작은 바꾸지 않는다', () => {
    expect(parseArgs(['snapshot', '--dry-runn']).kind).toBe('run');
  });
});

describe('runs 옵션', () => {
  it('기본값은 실제 게시다', () => {
    const p = parseArgs(['runs']);
    if (p.kind === 'run') {
      expect(p.dryRun).toBe(false);
      expect(p.statePath).toBeNull();
    }
  });

  it('--dry-run과 --state를 읽는다', () => {
    const p = parseArgs(['runs', '--dry-run', '--state', 'D:/state.db']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') {
      expect(p.dryRun).toBe(true);
      expect(p.statePath).toBe('D:/state.db');
    }
  });

  /*
   * runs도 되돌릴 수 없는 외부 write를 한다. digest와 같은 검사를 건다.
   *
   * 회귀 방지: 이 검사가 runs에 걸리지 않으면 `runs --dry-runn`이 dryRun=false로 내려가
   * 확인 없이 #agent-runs에 실제 게시된다.
   */
  it('runs는 모르는 플래그를 무시하지 않고 오류로 만든다', () => {
    const p = parseArgs(['runs', '--dry-runn']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') {
      expect(p.message).toContain('runs');
      expect(p.message).toContain('--dry-runn');
    }
  });

  // 회귀 방지: --dry-runn을 --state의 값으로 삼으면 dryRun=false로 실제 게시하면서
  // '--dry-runn'이라는 이름의 DB를 열어 기존 매핑을 못 찾고 루트를 하나 더 만든다.
  it('runs의 값 자리에 플래그가 오면 오류다', () => {
    const p = parseArgs(['runs', '--state', '--dry-runn']);
    expect(p.kind).toBe('error');
    if (p.kind === 'error') {
      expect(p.message).toContain('--state');
      expect(p.message).toContain('--dry-runn');
    }
  });
});

describe('gate-register transport', () => {
  it('--input <JSON 파일 경로>를 정확히 한 번 요구한다', () => {
    for (const argv of [
      ['gate-register'],
      ['gate-register', '--input'],
      ['gate-register', '--input', 'a.json', '--input', 'b.json'],
    ]) {
      const p = parseArgs(argv);
      expect(p.kind).toBe('error');
      if (p.kind === 'error') expect(p.message).toContain('--input');
    }
  });

  it('--input은 gate-register 외 모든 명령에서 command-scoped unknown이다', () => {
    for (const command of ['snapshot', 'verify-slack', 'digest', 'runs'] as const) {
      const p = parseArgs([command, '--input', 'gate.json']);
      expect(p.kind).toBe('error');
      if (p.kind === 'error') {
        expect(p.message).toContain(command);
        expect(p.message).toContain('--input');
      }
    }
  });

  it('파일 transport와 local/read-only 경계 플래그만 받는다', () => {
    const p = parseArgs([
      'gate-register',
      '--input',
      'gate.json',
      '--state',
      'state.db',
      '--orca',
      'orca-test',
      '--json',
    ]);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') {
      expect(p.inputPath).toBe('gate.json');
      expect(p.statePath).toBe('state.db');
      expect(p.orcaBin).toBe('orca-test');
      expect(p.json).toBe(true);
    }
  });

  it('stdin/free-text/shell JSON과 다른 명령용 플래그를 production 입력으로 받지 않는다', () => {
    for (const extra of [
      ['{"gateId":"gate_x"}'],
      ['--payload', '{"gateId":"gate_x"}'],
      ['--dry-run'],
      ['--pr', '1'],
      ['--config', 'config.json'],
    ]) {
      const p = parseArgs(['gate-register', '--input', 'gate.json', ...extra]);
      expect(p.kind).toBe('error');
    }
  });
});

/*
 * 하이픈이 모자란 오타(OD-072의 write 규율).
 *
 * 회귀 방지: 검사가 `--`로 시작하는 토큰만 보면 `-dry-run`과 `dry-run`이 통과해 dryRun=false로
 * 내려간다. 그러면 확인 없이 실제 채널에 게시된다 — `unknownWriteFlag`가 막으려던 결과 그대로다.
 * `--dry-runn` 형태만 고정하면 이 구멍이 그대로 남는다.
 */
describe('write 명령의 하이픈 오타와 떠도는 위치 인자', () => {
  for (const command of ['digest', 'runs'] as const) {
    it(`${command}는 하이픈이 모자란 --dry-run 오타를 거부한다`, () => {
      for (const typo of ['-dry-run', 'dry-run']) {
        const p = parseArgs([command, typo]);
        expect(p.kind).toBe('error');
        if (p.kind === 'error') {
          expect(p.message).toContain(command);
          expect(p.message).toContain(typo);
        }
      }
    });

    it(`${command}는 값이 아닌 떠도는 위치 인자를 거부한다`, () => {
      const p = parseArgs([command, '--dry-run', 'state.db']);
      expect(p.kind).toBe('error');
      if (p.kind === 'error') expect(p.message).toContain('state.db');
    });
  }

  /*
   * 대조군. 값 자리의 정상 토큰은 위치 인자가 아니다 — 거부하면 정상 호출이 통째로 막힌다.
   * 값이 플래그 이름처럼 생겼어도 값 자리에 있으면 값이다.
   */
  it('값 자리의 정상 토큰은 거부하지 않는다', () => {
    expect(parseArgs(['runs', '--state', 'state.db', '--dry-run']).kind).toBe('run');
    expect(parseArgs(['digest', '--pr', '5', '--state', 'dry-run', '--dry-run']).kind).toBe('run');
    const p = parseArgs(['digest', '--config', 'c.json', '--orca', 'orca', '--pr-limit', '10']);
    expect(p.kind).toBe('run');
    if (p.kind === 'run') {
      expect(p.configPath).toBe('c.json');
      expect(p.orcaBin).toBe('orca');
      expect(p.prLimit).toBe(10);
    }
  });

  // write하지 않는 명령의 기존 동작은 바꾸지 않는다. 무시가 무해한 쪽에서 뺏을 것이 없다.
  it('write하지 않는 명령의 위치 인자는 그대로 흐른다', () => {
    expect(parseArgs(['snapshot', 'dry-run']).kind).toBe('run');
    expect(parseArgs(['snapshot', '-dry-run']).kind).toBe('run');
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
