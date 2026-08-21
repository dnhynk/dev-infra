import { describe, it, expect } from 'vitest';
import {
  parseJsonField,
  parseOrcaTimestamp,
  worktreePathFromId,
  worktreePathFromIncarnation,
} from '../src/orca/coerce.js';

describe('parseJsonField', () => {
  it('JSON 문자열로 온 deps를 배열로 만든다', () => {
    expect(parseJsonField<string[]>('[]', [])).toEqual([]);
  });

  it('JSON 문자열로 온 gate options를 배열로 만든다', () => {
    // 실측된 gate row의 options
    const raw = '["A: 취소 즉시 종료","B: 결제 기간 종료 시 종료"]';
    expect(parseJsonField<string[]>(raw, [])).toEqual([
      'A: 취소 즉시 종료',
      'B: 결제 기간 종료 시 종료',
    ]);
  });

  it('중첩 객체를 담은 task result를 복원한다', () => {
    const raw = '{"kind":"reviewer_result","verdict":"request_changes","findings":[{"severity":"blocker"}]}';
    const parsed = parseJsonField<{ verdict: string; findings: { severity: string }[] }>(raw, {
      verdict: '',
      findings: [],
    });
    expect(parsed.verdict).toBe('request_changes');
    expect(parsed.findings[0]?.severity).toBe('blocker');
  });

  it('null과 빈 문자열은 fallback', () => {
    expect(parseJsonField<string[]>(null, [])).toEqual([]);
    expect(parseJsonField<string[]>('   ', [])).toEqual([]);
  });

  it('이미 파싱된 값은 그대로 통과시킨다', () => {
    expect(parseJsonField<string[]>(['a'], [])).toEqual(['a']);
  });

  it('깨진 JSON을 fallback으로 덮지 않는다', () => {
    expect(() => parseJsonField<string[]>('[1,', [])).toThrow(SyntaxError);
  });
});

describe('parseOrcaTimestamp', () => {
  it('Run의 ISO8601 UTC를 읽는다', () => {
    expect(parseOrcaTimestamp('2026-08-21T14:32:45Z').toISOString()).toBe('2026-08-21T14:32:45.000Z');
  });

  it('Task/Gate의 타임존 없는 형식을 UTC로 읽는다', () => {
    expect(parseOrcaTimestamp('2026-08-21 14:33:10').toISOString()).toBe('2026-08-21T14:33:10.000Z');
  });

  it('두 형식이 같은 시각이면 같은 값이 된다', () => {
    expect(parseOrcaTimestamp('2026-08-21 14:33:10').getTime()).toBe(
      parseOrcaTimestamp('2026-08-21T14:33:10Z').getTime(),
    );
  });

  it('해석할 수 없으면 던진다', () => {
    expect(() => parseOrcaTimestamp('어제')).toThrow(RangeError);
  });
});

describe('worktree 경로 추출', () => {
  it('ORCA_WORKTREE_ID에서 경로를 꺼낸다', () => {
    expect(worktreePathFromId('ccb3c8ee-6d9e-42af-af36-9fdac6566fcc::D:/dev-infra')).toBe('D:/dev-infra');
  });

  it('task의 process incarnation에서 경로만 꺼낸다', () => {
    const inc = 'ccb3c8ee-6d9e-42af-af36-9fdac6566fcc::D:/dev-infra@@8c25bfec:f126ab2a-77e6-46b6-a862-3dd75ec962bd';
    expect(worktreePathFromIncarnation(inc)).toBe('D:/dev-infra');
  });

  it('형식이 다르면 추측하지 않고 null', () => {
    expect(worktreePathFromId('no-separator')).toBeNull();
    expect(worktreePathFromIncarnation('no-separator')).toBeNull();
  });
});
