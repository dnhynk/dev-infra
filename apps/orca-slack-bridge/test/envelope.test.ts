import { describe, it, expect } from 'vitest';
import { unwrap, OrcaCommandError } from '../src/orca/envelope.js';

describe('unwrap', () => {
  it('ok:true면 result를 꺼낸다', () => {
    const raw = {
      id: '549a03a2-37aa-447b-9e91-7374a82677ed',
      ok: true,
      result: { runs: [], nextCursor: null },
      _meta: { runtimeId: '9abb762b-9b3d-4bc7-8e72-872ab1021ccf' },
    };
    expect(unwrap<{ runs: unknown[] }>(raw).runs).toEqual([]);
  });

  it('ok:false면 code와 nextSteps를 보존해 던진다', () => {
    // 실측: --run 없는 gate-list
    const raw = {
      id: 'da72961d-525b-4014-9210-4ba91b6ea378',
      ok: false,
      error: {
        code: 'run_required',
        message: 'No Run is bound. Use orchestration run-create or run-use first. No effects were applied.',
        data: {
          effectsApplied: false,
          nextSteps: ['Using this same Orca CLI executable, run: skills get orchestration --full'],
        },
      },
    };
    try {
      unwrap(raw);
      expect.unreachable('던졌어야 한다');
    } catch (e) {
      expect(e).toBeInstanceOf(OrcaCommandError);
      const err = e as OrcaCommandError;
      expect(err.code).toBe('run_required');
      expect(err.effectsApplied).toBe(false);
      expect(err.nextSteps).toHaveLength(1);
    }
  });

  it('effectsApplied가 없으면 false로 단정하지 않는다', () => {
    const raw = { id: 'x', ok: false, error: { code: 'boom', message: 'boom' } };
    try {
      unwrap(raw);
      expect.unreachable('던졌어야 한다');
    } catch (e) {
      expect((e as OrcaCommandError).effectsApplied).toBeUndefined();
    }
  });

  it('ok 필드가 없으면 조용히 통과시키지 않는다', () => {
    expect(() => unwrap({ result: {} })).toThrow(TypeError);
    expect(() => unwrap('nope')).toThrow(TypeError);
  });
});
