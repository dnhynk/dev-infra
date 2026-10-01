import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveGateMetadata, derivedOptionId } from '../src/gate/derive.js';
import { persistGateMetadata } from '../src/gate/register.js';
import type { GateMetadata } from '../src/gate/types.js';
import { dispatchKey, gateKey, runKey, taskKey } from '../src/identity/keys.js';
import type { OrcaGate } from '../src/orca/client.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';

const AT = '2026-08-29T00:00:00.000Z';

function gate(options: OrcaGate['options'], overrides: Partial<OrcaGate> = {}): OrcaGate {
  return {
    id: 'gate_derive',
    runId: 'run_derive',
    taskId: 'task_derive',
    question: '설치할 것을 정해 주세요',
    options,
    status: 'pending',
    resolution: null,
    resolvedAt: null,
    ...overrides,
  } as OrcaGate;
}

const readable = (value: readonly string[]): OrcaGate['options'] =>
  ({ kind: 'value', value }) as OrcaGate['options'];

describe('sidecar 없는 Gate의 파생 metadata', () => {
  it('Orca options만으로 누를 수 있는 행을 만든다', () => {
    const derived = deriveGateMetadata(gate(readable(['설치한다', '설치하지 않는다'])), AT);
    if (derived === null) throw new Error('파생이 null이다');
    expect(derived.source).toBe('derived');
    expect(derived.recommendation).toBeNull();
    expect(derived.impact).toBeNull();
    expect(derived.options.map((option) => option.label)).toEqual(['설치한다', '설치하지 않는다']);
    // resolution은 Orca에 그대로 되돌려 쓰는 값이라 label과 같아야 한다.
    expect(derived.options.map((option) => option.resolution)).toEqual([
      '설치한다',
      '설치하지 않는다',
    ]);
    expect(derived.options.every((option) => option.description === null)).toBe(true);
    expect(derived.options.every((option) => /^orca_[0-9a-f]{16}$/.test(option.id))).toBe(true);
  });

  it('같은 Gate를 다시 관측해도 같은 option ID를 준다', () => {
    const first = deriveGateMetadata(gate(readable(['예', '아니오'])), AT);
    const second = deriveGateMetadata(gate(readable(['예', '아니오'])), '2026-09-01T00:00:00.000Z');
    expect(first?.options.map((option) => option.id)).toEqual(
      second?.options.map((option) => option.id),
    );
  });

  it('label이 겹쳐도 option ID가 겹치지 않는다', () => {
    const derived = deriveGateMetadata(gate(readable(['예', '예'])), AT);
    const ids = derived?.options.map((option) => option.id) ?? [];
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe(derivedOptionId('예', 0));
    expect(ids[1]).toBe(derivedOptionId('예', 1));
  });

  it('options를 읽지 못하거나 상한을 넘으면 파생하지 않는다', () => {
    expect(deriveGateMetadata(gate({ kind: 'unreadable', reason: 'not json' } as OrcaGate['options']), AT))
      .toBeNull();
    expect(deriveGateMetadata(gate(readable([])), AT)).toBeNull();
    expect(deriveGateMetadata(gate(readable(['   '])), AT)).toBeNull();
    // 자르면 Orca에 쓰는 resolution이 사용자가 고른 원문과 달라지므로 파생을 포기한다.
    expect(deriveGateMetadata(gate(readable(['가'.repeat(76)])), AT)).toBeNull();
  });
});

describe('파생 행과 등록의 관계', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-gate-derive-'));
    path = join(dir, 'state.db');
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows에서 열린 핸들이 남으면 지워지지 않는다. 테스트 결과와 무관하다.
    }
  });

  const registered: GateMetadata = {
    gateKey: gateKey('gate_derive'),
    runKey: runKey('run_derive'),
    taskKey: taskKey('task_derive'),
    dispatchKey: dispatchKey('ctx_real'),
    askMessageId: 'msg_real',
    questionThreadId: 'thread_real',
    options: [
      { id: 'install', label: '설치한다', description: '고정 툴체인을 쓴다', resolution: '설치한다' },
      { id: 'skip', label: '설치하지 않는다', description: '공백으로 남긴다', resolution: '설치하지 않는다' },
    ],
    source: 'registered',
    recommendation: { optionId: 'install', reason: '문서화된 고정 툴체인이 있다' },
    impact: '이 머신에 소프트웨어가 하나 늘어난다',
    registeredAt: AT,
  };

  it('등록이 파생 행을 대체하고 파생은 등록을 막지 않는다', () => {
    const store = new SqliteDigestStore(path);
    try {
      const derived = deriveGateMetadata(gate(readable(['설치한다', '설치하지 않는다'])), AT);
      if (derived === null) throw new Error('파생이 null이다');
      store.insertGateMetadata(derived);
      expect(store.findGateMetadata(derived.gateKey)?.source).toBe('derived');

      const result = persistGateMetadata(store, registered);
      expect(result.action).toBe('registered');
      const stored = store.findGateMetadata(registered.gateKey);
      expect(stored?.source).toBe('registered');
      expect(stored?.recommendation?.optionId).toBe('install');
      expect(stored?.options.map((option) => option.id)).toEqual(['install', 'skip']);
    } finally {
      store.close();
    }
  });

  it('등록된 행은 다른 등록으로 덮이지 않는다', () => {
    const store = new SqliteDigestStore(path);
    try {
      persistGateMetadata(store, registered);
      expect(persistGateMetadata(store, registered).action).toBe('already_registered');
      expect(() =>
        persistGateMetadata(store, { ...registered, impact: '다른 영향' }),
      ).toThrow(/이미 다른 sidecar metadata로 등록돼 있다/);
    } finally {
      store.close();
    }
  });
});
