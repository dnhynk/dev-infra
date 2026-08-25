import { describe, expect, it } from 'vitest';
import {
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

describe('direct-input Orca mutation privacy boundary', () => {
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
