import { describe, it, expect } from 'vitest';
import { parseCorrelationMetadata } from '../src/correlate/metadata.js';
import { resolveCorrelation, type OrcaCorrelationView } from '../src/correlate/resolve.js';
import { DEFAULT_CORRELATION_KEYS as K } from '../src/project/config.js';

const orca: OrcaCorrelationView = {
  runIds: new Set(['run_a48566be983b']),
  taskToRun: new Map([['task_cd1991c049a8', 'run_a48566be983b']]),
};

describe('metadata 파싱', () => {
  it('HTML comment에서 id를 읽는다', () => {
    const body = `## Task\n\n<!-- orca-run: run_a48566be983b -->\n<!-- orca-task: task_cd1991c049a8 -->\n본문`;
    const m = parseCorrelationMetadata(body, K);
    expect(m.runId).toBe('run_a48566be983b');
    expect(m.taskId).toBe('task_cd1991c049a8');
    expect(m.dispatchId).toBeNull();
  });

  it('공백에 관대하다', () => {
    const m = parseCorrelationMetadata('<!--orca-run:run_x-->', K);
    expect(m.runId).toBe('run_x');
  });

  it('같은 key가 다른 값으로 여러 번이면 첫 값을 고르지 않는다', () => {
    const m = parseCorrelationMetadata('<!-- orca-run: a -->\n<!-- orca-run: b -->', K);
    expect(m.runId).toBeNull();
    expect(m.duplicates).toContain('orca-run');
  });

  it('같은 값이 반복되는 것은 중복이 아니다', () => {
    const m = parseCorrelationMetadata('<!-- orca-run: a -->\n<!-- orca-run: a -->', K);
    expect(m.runId).toBe('a');
    expect(m.duplicates).toHaveLength(0);
  });

  it('body가 없으면 빈 metadata', () => {
    expect(parseCorrelationMetadata(null, K).runId).toBeNull();
  });
});

describe('correlation 판정', () => {
  it('metadata가 없으면 no_metadata', () => {
    // 실측된 vertical-live PR body는 ## Task / ## Why / ## What 구조이고 orca id가 없다
    const body = '## Task\n\n- T-ID: T8e\n\n## Why\n...';
    const r = resolveCorrelation(parseCorrelationMetadata(body, K), orca);
    expect(r).toEqual({ kind: 'uncorrelated', reason: 'no_metadata' });
  });

  it('branch나 제목으로 추측하지 않는다', () => {
    const body = 'head: dnhynk/t8e-clock-jump-flaky\nrun_a48566be983b 라고 본문에 적혀 있어도';
    const r = resolveCorrelation(parseCorrelationMetadata(body, K), orca);
    expect(r.kind).toBe('uncorrelated');
  });

  it('run만 있으면 correlated', () => {
    const r = resolveCorrelation(parseCorrelationMetadata('<!-- orca-run: run_a48566be983b -->', K), orca);
    expect(r).toEqual({ kind: 'correlated', run: 'run:run_a48566be983b', task: null, dispatch: null });
  });

  it('run과 task가 맞으면 correlated', () => {
    const body = '<!-- orca-run: run_a48566be983b -->\n<!-- orca-task: task_cd1991c049a8 -->';
    const r = resolveCorrelation(parseCorrelationMetadata(body, K), orca);
    expect(r).toEqual({
      kind: 'correlated', run: 'run:run_a48566be983b', task: 'task:task_cd1991c049a8', dispatch: null,
    });
  });

  it('task만 있으면 Run을 확정하지 않는다', () => {
    const r = resolveCorrelation(parseCorrelationMetadata('<!-- orca-task: task_cd1991c049a8 -->', K), orca);
    expect(r).toEqual({ kind: 'uncorrelated', reason: 'run_missing' });
  });

  it('없는 Run을 가리키면 run_not_found', () => {
    const r = resolveCorrelation(parseCorrelationMetadata('<!-- orca-run: run_gone -->', K), orca);
    expect(r).toEqual({ kind: 'uncorrelated', reason: 'run_not_found' });
  });

  it('task가 다른 Run에 속하면 conflict — 어느 쪽으로도 덮지 않는다', () => {
    const view: OrcaCorrelationView = {
      runIds: new Set(['run_a', 'run_b']),
      taskToRun: new Map([['task_x', 'run_b']]),
    };
    const body = '<!-- orca-run: run_a -->\n<!-- orca-task: task_x -->';
    const r = resolveCorrelation(parseCorrelationMetadata(body, K), view);
    expect(r.kind).toBe('conflict');
  });

  it('metadata가 모순되면 conflict', () => {
    const r = resolveCorrelation(parseCorrelationMetadata('<!-- orca-run: a -->\n<!-- orca-run: b -->', K), orca);
    expect(r.kind).toBe('conflict');
  });
});
