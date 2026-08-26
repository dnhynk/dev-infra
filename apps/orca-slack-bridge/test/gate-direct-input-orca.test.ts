import { describe, expect, it } from 'vitest';
import {
  OrcaCli,
  orcaServiceEnvironment,
  resolveExactGate,
  type OrcaRunner,
} from '../src/orca/client.js';

const PRIVATE_RESOLUTION = '직접 입력 private resolution NEVER EXPOSE';
const RETRY_REQUEST = '11111111-1111-4111-8111-111111111111';
const IDENTITY = {
  gateId: 'gate_direct_private',
  runId: 'run_direct_private',
  taskId: 'task_direct_private',
  options: ['현행 유지', '변경'],
} as const;

function exposed(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [
    error.name,
    error.message,
    error.stack ?? '',
    JSON.stringify(error),
    String((error as { readonly cause?: unknown }).cause ?? ''),
  ].join('\n');
}

function runShowEnvelope(
  overrides: Readonly<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    id: 'run-show',
    ok: true,
    result: {
      run: {
        id: IDENTITY.runId,
        objective: 'test',
        home_database: 'this_database',
        coordinator_handle: 'term_current_coordinator',
        coordinator_pane_key: 'tab:pane',
        consumer_generation: 2,
        legacy: 0,
        created_at: '2026-08-26T09:00:00Z',
        updated_at: '2026-08-26T09:01:00Z',
        ...overrides,
      },
    },
  });
}

describe('direct-input Orca mutation privacy boundary', () => {
  it('uses the exact Run current coordinator instead of ambient CLI state', async () => {
    const calls: string[][] = [];
    const runner: OrcaRunner = {
      run: (args) => {
        calls.push([...args]);
        if (args[1] === 'run-show') {
          return Promise.resolve(JSON.stringify({
            id: 'run-show',
            ok: true,
            result: {
              run: {
                id: IDENTITY.runId,
                objective: 'test',
                home_database: 'this_database',
                coordinator_handle: 'term_current_coordinator',
                coordinator_pane_key: 'tab:pane',
                consumer_generation: 2,
                legacy: 0,
                created_at: '2026-08-26T09:00:00Z',
                updated_at: '2026-08-26T09:01:00Z',
              },
            },
          }));
        }
        return Promise.resolve(JSON.stringify({
          id: 'resolve',
          ok: true,
          result: {
            gate: {
              id: IDENTITY.gateId,
              run_id: IDENTITY.runId,
              task_id: IDENTITY.taskId,
              question: 'continue?',
              options: JSON.stringify(IDENTITY.options),
              status: 'resolved',
              resolution: '현행 유지',
              created_at: '2026-08-26 09:00:00',
              resolved_at: '2026-08-26 09:01:00',
            },
            mutation: { requestId: RETRY_REQUEST, replayed: false },
          },
        }));
      },
    };

    await resolveExactGate(runner, IDENTITY, '현행 유지', RETRY_REQUEST);

    expect(calls).toEqual([
      ['orchestration', 'run-show', '--id', IDENTITY.runId, '--json'],
      [
        'orchestration', 'gate-resolve',
        '--from', 'term_current_coordinator',
        '--id', IDENTITY.gateId,
        '--resolution', '현행 유지',
        '--retry-request', RETRY_REQUEST,
        '--json',
      ],
    ]);
  });

  it('drops only the launching terminal attestation from service CLI children', () => {
    const source = {
      PATH: 'bin',
      ORCA_AGENT_LAUNCH_TOKEN: 'terminal-attestation',
      ORCA_USER_DATA_PATH: 'runtime-discovery',
      ORCA_TERMINAL_HANDLE: 'diagnostic-only',
    };

    expect(orcaServiceEnvironment(source)).toEqual({
      PATH: 'bin',
      ORCA_USER_DATA_PATH: 'runtime-discovery',
      ORCA_TERMINAL_HANDLE: 'diagnostic-only',
    });
    expect(source.ORCA_AGENT_LAUNCH_TOKEN).toBe('terminal-attestation');
  });

  it('applies the service environment to the real OrcaCli child process', async () => {
    const previousToken = process.env['ORCA_AGENT_LAUNCH_TOKEN'];
    const previousDiscovery = process.env['ORCA_USER_DATA_PATH'];
    process.env['ORCA_AGENT_LAUNCH_TOKEN'] = 'must-not-reach-child';
    process.env['ORCA_USER_DATA_PATH'] = 'runtime-discovery-sentinel';
    try {
      const runner = new OrcaCli(process.execPath);
      const output = await runner.run([
        '-e',
        "process.stdout.write(JSON.stringify({tokenPresent:Object.hasOwn(process.env,'ORCA_AGENT_LAUNCH_TOKEN'),discovery:process.env.ORCA_USER_DATA_PATH}))",
      ]);
      expect(JSON.parse(output)).toEqual({
        tokenPresent: false,
        discovery: 'runtime-discovery-sentinel',
      });
    } finally {
      if (previousToken === undefined) delete process.env['ORCA_AGENT_LAUNCH_TOKEN'];
      else process.env['ORCA_AGENT_LAUNCH_TOKEN'] = previousToken;
      if (previousDiscovery === undefined) delete process.env['ORCA_USER_DATA_PATH'];
      else process.env['ORCA_USER_DATA_PATH'] = previousDiscovery;
    }
  });

  it.each([
    {
      label: 'missing run',
      output: JSON.stringify({ id: 'run-show', ok: true, result: {} }),
    },
    {
      label: 'mismatched run id',
      output: runShowEnvelope({ id: 'run_other' }),
    },
    {
      label: 'missing coordinator',
      output: runShowEnvelope({ coordinator_handle: null }),
    },
    {
      label: 'unexpected authority field',
      output: runShowEnvelope({ unexpected: 'not-allowed' }),
    },
  ])('fails closed before gate-resolve for $label', async ({ output }) => {
    const calls: string[][] = [];
    const runner: OrcaRunner = {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve(output);
      },
    };

    await expect(resolveExactGate(
      runner,
      IDENTITY,
      '현행 유지',
      RETRY_REQUEST,
    )).rejects.toThrow('Orca gate-resolve failed');
    expect(calls).toEqual([
      ['orchestration', 'run-show', '--id', IDENTITY.runId, '--json'],
    ]);
  });

  it('treats a coordinator takeover fence as response-unknown and never retries the mutation', async () => {
    const calls: string[][] = [];
    const runner: OrcaRunner = {
      run: (args) => {
        calls.push([...args]);
        if (args[1] === 'run-show') return Promise.resolve(runShowEnvelope());
        return Promise.resolve(JSON.stringify({
          id: 'gate-resolve',
          ok: false,
          error: {
            code: 'consumer_fenced',
            message: 'coordinator changed after authority reread',
          },
        }));
      },
    };

    await expect(resolveExactGate(
      runner,
      IDENTITY,
      '현행 유지',
      RETRY_REQUEST,
    )).rejects.toThrow('Orca gate-resolve failed');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toBe('run-show');
    expect(calls[1]?.slice(0, 4)).toEqual([
      'orchestration', 'gate-resolve', '--from', 'term_current_coordinator',
    ]);
  });

  it.each([
    {
      label: 'runner rejection',
      run: () => Promise.reject(new Error(`argv contained ${PRIVATE_RESOLUTION}`)),
    },
    {
      label: 'non-JSON output',
      run: () => Promise.resolve(`not-json ${PRIVATE_RESOLUTION}`),
    },
    {
      label: 'Orca error envelope',
      run: () => Promise.resolve(JSON.stringify({
        id: 'resolve',
        ok: false,
        error: {
          code: 'invalid_resolution',
          message: `rejected ${PRIVATE_RESOLUTION}`,
          data: { nextSteps: [`retry ${PRIVATE_RESOLUTION}`] },
        },
      })),
    },
  ])('redacts resolution text from a $label', async ({ run }) => {
    const runner: OrcaRunner = { run };
    const error = await resolveExactGate(
      runner,
      IDENTITY,
      PRIVATE_RESOLUTION,
      RETRY_REQUEST,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(exposed(error)).not.toContain(PRIVATE_RESOLUTION);
    expect(Object.hasOwn(error as object, 'cause')).toBe(false);
    expect(Object.hasOwn(error as object, 'data')).toBe(false);
  });
});
