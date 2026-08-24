import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrcaRunner } from '../src/orca/client.js';
import {
  parseGateRegistrationDocument,
  registerGateMetadata,
} from '../src/gate/register.js';
import type { GateRegistrationDocument } from '../src/gate/types.js';
import { gateKey, runKey } from '../src/identity/keys.js';
import { SqliteDigestStore } from '../src/store/sqlite.js';
import { parseArgs, runGateRegisterCommand } from '../src/cli.js';

const RUN_ID = 'run_d2a';
const TASK_ID = 'task_gate';
const GATE_ID = 'gate_static';
const AT = '2026-08-24T07:00:00.000Z';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-gate-register-'));
  dbPath = join(dir, 'state.db');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rawDocument(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    askMessageId: 'msg_ask_1',
    questionThreadId: 'thread_question_1',
    dispatchId: 'ctx_gate',
    taskId: TASK_ID,
    gateId: GATE_ID,
    options: [
      {
        id: 'keep',
        label: '기존 계약 유지',
        description: '현재 배선과 호환된다',
        resolution: '기존 계약을 유지한다',
      },
      {
        id: 'change',
        label: '계약 변경',
        description: '새 계약으로 전환한다',
        resolution: '새 계약으로 변경한다',
      },
    ],
    recommendation: { optionId: 'keep', reason: '하위 호환성을 보존한다' },
    impact: '후속 Task 두 개의 구현 방향을 고정한다',
    ...over,
  };
}

function document(over: Record<string, unknown> = {}): GateRegistrationDocument {
  return parseGateRegistrationDocument(rawDocument(over));
}

function gateRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: GATE_ID,
    run_id: RUN_ID,
    task_id: TASK_ID,
    question: '어느 계약을 채택할까?',
    options: JSON.stringify(['기존 계약 유지', '계약 변경']),
    status: 'pending',
    resolution: null,
    created_at: '2026-08-24T06:00:00Z',
    resolved_at: null,
    ...over,
  };
}

class FakeOrca implements OrcaRunner {
  readonly calls: string[][] = [];

  constructor(private readonly gates: readonly Record<string, unknown>[]) {}

  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args[1] !== 'gate-list') throw new Error(`예상치 못한 Orca 호출: ${args.join(' ')}`);
    return Promise.resolve(
      JSON.stringify({ id: 'x', ok: true, result: { gates: this.gates } }),
    );
  }
}

describe('strict Gate registration document', () => {
  it('unknown, missing, contradictory field를 거부한다', () => {
    expect(() => parseGateRegistrationDocument(rawDocument({ surprise: true }))).toThrow(
      /알 수 없는 필드.*surprise/,
    );
    const missing = rawDocument();
    delete missing['askMessageId'];
    expect(() => parseGateRegistrationDocument(missing)).toThrow(/필수 필드.*askMessageId/);
    expect(() =>
      parseGateRegistrationDocument(
        rawDocument({ recommendation: { optionId: 'unknown', reason: '아무 이유' } }),
      ),
    ).toThrow(/optionId가 options에 없다/);
  });

  it('option shape와 stable id를 strict하게 검증한다', () => {
    const duplicate = rawDocument({
      options: [
        { id: 'same', label: 'A', description: 'A 설명', resolution: 'A 결정' },
        { id: 'same', label: 'B', description: 'B 설명', resolution: 'B 결정' },
      ],
      recommendation: { optionId: 'same', reason: '테스트' },
    });
    expect(() => parseGateRegistrationDocument(duplicate)).toThrow(/중복 option id/);
    expect(() =>
      parseGateRegistrationDocument(
        rawDocument({
          options: [
            {
              id: 'keep',
              label: '기존 계약 유지',
              description: '설명',
              resolution: '결정',
              extra: '금지',
            },
          ],
          recommendation: { optionId: 'keep', reason: '테스트' },
        }),
      ),
    ).toThrow(/알 수 없는 필드.*extra/);
  });
});

describe('read-only Orca identity 확인 뒤 local registration', () => {
  it('정확한 run/task/options를 재조회하고 sidecar의 모든 mapping과 의미를 보존한다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const orca = new FakeOrca([gateRow()]);
    try {
      const result = await registerGateMetadata(
        orca,
        store,
        document(),
        () => new Date(AT),
      );

      expect(result.action).toBe('registered');
      expect(orca.calls).toEqual([
        ['orchestration', 'gate-list', '--run', RUN_ID, '--json'],
      ]);
      expect(store.listGateMetadata(runKey(RUN_ID))).toEqual([
        expect.objectContaining({
          gateKey: gateKey(GATE_ID),
          askMessageId: 'msg_ask_1',
          questionThreadId: 'thread_question_1',
          recommendation: { optionId: 'keep', reason: '하위 호환성을 보존한다' },
          impact: '후속 Task 두 개의 구현 방향을 고정한다',
          registeredAt: AT,
        }),
      ]);
      expect(result.metadata.options[0]).toEqual({
        id: 'keep',
        label: '기존 계약 유지',
        description: '현재 배선과 호환된다',
        resolution: '기존 계약을 유지한다',
      });
    } finally {
      store.close();
    }
  });

  it('같은 문서의 반복 등록은 exact idempotent이고 row를 늘리지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const orca = new FakeOrca([gateRow()]);
    try {
      const first = await registerGateMetadata(orca, store, document(), () => new Date(AT));
      const second = await registerGateMetadata(
        orca,
        store,
        document(),
        () => new Date('2026-08-24T09:00:00Z'),
      );
      expect(first.action).toBe('registered');
      expect(second.action).toBe('already_registered');
      expect(second.metadata.registeredAt).toBe(AT);
      expect(store.listGateMetadata(runKey(RUN_ID))).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('같은 Task의 복수 ask/Gate를 gate id와 ask id로 exact하게 나눈다', async () => {
    const secondId = 'gate_second';
    const store = new SqliteDigestStore(dbPath);
    const orca = new FakeOrca([gateRow(), gateRow({ id: secondId })]);
    try {
      await registerGateMetadata(orca, store, document(), () => new Date(AT));
      await registerGateMetadata(
        orca,
        store,
        document({ gateId: secondId, askMessageId: 'msg_ask_2', questionThreadId: 'thread_2' }),
        () => new Date(AT),
      );
      const rows = store.listGateMetadata(runKey(RUN_ID));
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => [row.gateKey, row.askMessageId])).toEqual([
        [gateKey(secondId), 'msg_ask_2'],
        [gateKey(GATE_ID), 'msg_ask_1'],
      ]);
    } finally {
      store.close();
    }
  });

  it('run/task/options identity가 어긋나거나 options를 읽지 못하면 아무 row도 기록하지 않는다', async () => {
    for (const [row, message] of [
      [gateRow({ task_id: 'task_other' }), /taskId가 입력과 어긋난다/],
      [gateRow({ options: JSON.stringify(['계약 변경', '기존 계약 유지']) }), /options가 입력과 어긋난다/],
      [gateRow({ options: '[기존 계약 유지,계약 변경]' }), /options를 읽지 못해/],
    ] as const) {
      const isolated = join(dir, `${String(row['task_id'])}-${String(row['options']).length}.db`);
      const store = new SqliteDigestStore(isolated);
      try {
        await expect(registerGateMetadata(new FakeOrca([row]), store, document())).rejects.toThrow(
          message,
        );
        expect(store.listGateMetadata(runKey(RUN_ID))).toEqual([]);
      } finally {
        store.close();
      }
    }
  });

  it('기존 Gate row와 다른 sidecar로 덮어쓰지 않는다', async () => {
    const store = new SqliteDigestStore(dbPath);
    const orca = new FakeOrca([gateRow()]);
    try {
      await registerGateMetadata(orca, store, document(), () => new Date(AT));
      await expect(
        registerGateMetadata(
          orca,
          store,
          document({ impact: '서로 다른 영향' }),
          () => new Date(AT),
        ),
      ).rejects.toThrow(/이미 다른 sidecar metadata/);
      expect(store.findGateMetadata(gateKey(GATE_ID))?.impact).toContain('후속 Task');
    } finally {
      store.close();
    }
  });
});

describe('gate-register production CLI path', () => {
  it('JSON 파일 → gate-list read → temp SQLite write를 config/Slack 없이 관통한다', async () => {
    const inputPath = join(dir, 'gate-registration.json');
    writeFileSync(inputPath, JSON.stringify(rawDocument()), 'utf8');
    const parsed = parseArgs([
      'gate-register',
      '--input',
      inputPath,
      '--state',
      dbPath,
      '--json',
    ]);
    if (parsed.kind !== 'run') throw new Error(`run args가 아니다: ${JSON.stringify(parsed)}`);
    const orca = new FakeOrca([gateRow()]);
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      output.push(String(chunk));
      return true;
    });
    try {
      expect(await runGateRegisterCommand(parsed, orca)).toBe(0);
    } finally {
      stdout.mockRestore();
    }

    expect(orca.calls).toEqual([
      ['orchestration', 'gate-list', '--run', RUN_ID, '--json'],
    ]);
    expect(output.join('')).toContain('"action": "registered"');
    const reopened = new SqliteDigestStore(dbPath);
    try {
      expect(reopened.findGateMetadata(gateKey(GATE_ID))?.askMessageId).toBe('msg_ask_1');
    } finally {
      reopened.close();
    }
  });
});
