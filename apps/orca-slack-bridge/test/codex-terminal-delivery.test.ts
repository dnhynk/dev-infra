import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CodexTerminalDeliveryTransport,
  CoordinatorDeliveryTransport,
} from '../src/channel/codex-terminal.js';
import type { GateChannelDeliveryTransport } from '../src/channel/delivery.js';
import type { ChannelDeliverySendResult } from '../src/channel/pipe-server.js';
import type { OrcaRunner } from '../src/orca/client.js';

const RUN_ID = 'run_codex_route';
const GATE_ID = 'gate_codex_route';
const HANDLE = 'term_11111111-1111-4111-8111-111111111111';
const PANE = '22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333';
const WORKTREE = resolve(tmpdir(), 'worktrees', 'codex-route');

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-codex-route-'));
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function envelope(result: unknown): string {
  return JSON.stringify({ id: 'test', ok: true, result });
}

function marker(generation = 4, worktreePath = WORKTREE): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${RUN_ID}.json`), JSON.stringify({
    schema_version: 1,
    provider: 'codex',
    run_id: RUN_ID,
    worktree_path: worktreePath,
    coordinator_session_id: 'session-codex-route',
    coordinator_terminal_handle: HANDLE,
    coordinator_pane_key: PANE,
    coordinator_generation: generation,
  }));
}

class FakeOrca implements OrcaRunner {
  readonly calls: string[][] = [];
  generation = 4;
  worktreePath = WORKTREE;
  worktreeAfterSend: string | null = null;

  run(args: readonly string[]): Promise<string> {
    this.calls.push([...args]);
    if (args.join(' ') === 'orchestration run-list --json') {
      return Promise.resolve(envelope({ runs: [{
        id: RUN_ID,
        objective: 'test Codex route',
        coordinator_handle: HANDLE,
        coordinator_pane_key: PANE,
        consumer_generation: this.generation,
        legacy: false,
        created_at: '2026-09-07T00:00:00.000Z',
        updated_at: '2026-09-07T00:00:01.000Z',
      }] }));
    }
    if (args[0] === 'terminal' && args[1] === 'show') {
      const [tabId, leafId] = PANE.split(':');
      return Promise.resolve(envelope({ terminal: {
        handle: HANDLE,
        tabId,
        leafId,
        worktreePath: this.worktreePath,
        connected: true,
        writable: true,
      } }));
    }
    if (args[0] === 'terminal' && args[1] === 'send') {
      if (this.worktreeAfterSend !== null) this.worktreePath = this.worktreeAfterSend;
      return Promise.resolve(envelope({ send: { accepted: true } }));
    }
    return Promise.reject(new Error('unexpected fake Orca command'));
  }
}

describe('Codex terminal Gate delivery', () => {
  it('queues a wake-only prompt without terminating an idle Codex session', async () => {
    marker();
    const orca = new FakeOrca();
    const transport = new CodexTerminalDeliveryTransport({ orca, markerRoot: directory });

    await expect(transport.deliverGate(RUN_ID, GATE_ID)).resolves.toEqual({
      kind: 'sent',
      epoch: 'codex:session-codex-route',
      generation: 4,
      receipt: 'application_queued',
    });
    expect(orca.calls.filter((args) => args[0] === 'orchestration')).toHaveLength(2);
    const send = orca.calls.find((args) => args[0] === 'terminal' && args[1] === 'send')!;
    // Orca --interrupt exits an idle Codex 0.153.4 TUI before it can consume the prompt.
    expect(send).not.toContain('--interrupt');
    expect(send).toContain('--enter');
    expect(send[send.indexOf('--text') + 1]).toContain(
      `[orca-gate-wakeup v1 run_id=${RUN_ID} gate_id=${GATE_ID}]`,
    );
    expect(send[send.indexOf('--text') + 1]).toContain('do not infer a decision');
  });

  it('fails closed before terminal I/O when the marker generation is stale', async () => {
    marker(3);
    const orca = new FakeOrca();
    const transport = new CodexTerminalDeliveryTransport({ orca, markerRoot: directory });

    await expect(transport.deliverGate(RUN_ID, GATE_ID)).resolves.toEqual({
      kind: 'pending', code: 'stale_generation',
    });
    expect(orca.calls).toHaveLength(1);
  });

  it('rejects a relative marker worktree before terminal I/O', async () => {
    marker(4, 'relative/worktree');
    const orca = new FakeOrca();
    const transport = new CodexTerminalDeliveryTransport({ orca, markerRoot: directory });

    await expect(transport.deliverGate(RUN_ID, GATE_ID)).resolves.toEqual({
      kind: 'pending', code: 'unverified',
    });
    expect(orca.calls).toHaveLength(1);
  });

  it('withholds the receipt when the terminal route changes after queue acceptance', async () => {
    marker();
    const orca = new FakeOrca();
    orca.worktreeAfterSend = resolve(tmpdir(), 'worktrees', 'replacement');
    const transport = new CodexTerminalDeliveryTransport({ orca, markerRoot: directory });

    await expect(transport.deliverGate(RUN_ID, GATE_ID)).resolves.toEqual({
      kind: 'pending', code: 'unverified',
    });
    expect(orca.calls.filter((args) => args[0] === 'terminal' && args[1] === 'send')).toHaveLength(1);
  });

  it.each(['show', 'send'])('cancels an in-flight terminal %s with the delivery deadline', async (command) => {
    marker();
    const fake = new FakeOrca();
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let started!: () => void;
    const commandStarted = new Promise<void>((resolve) => { started = resolve; });
    const orca: OrcaRunner = {
      run: (args, options) => {
        if (args[0] !== 'terminal' || args[1] !== command) return fake.run(args);
        observedSignal = options?.signal;
        started();
        if (observedSignal === undefined) return Promise.reject(new Error('missing cancellation'));
        return new Promise((_resolve, reject) => {
          observedSignal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
      },
    };
    const delivery = new CodexTerminalDeliveryTransport({ orca, markerRoot: directory })
      .deliverGate(RUN_ID, GATE_ID, controller.signal);
    await commandStarted;
    controller.abort();

    await expect(delivery).resolves.toMatchObject({ kind: 'pending' });
    expect(observedSignal).toBe(controller.signal);
    expect(fake.calls.filter((args) => args[1] === 'send')).toHaveLength(0);
  });

  it('uses Codex only when the authenticated Channel route has no candidate', async () => {
    const calls: string[] = [];
    const channel: GateChannelDeliveryTransport = {
      deliverGate: () => {
        calls.push('channel');
        return Promise.resolve({ kind: 'pending', code: 'no_candidate' });
      },
    };
    const codex: GateChannelDeliveryTransport = {
      deliverGate: () => {
        calls.push('codex');
        return Promise.resolve({
          kind: 'sent', epoch: 'codex:test', generation: 1,
          receipt: 'application_queued',
        });
      },
    };
    const transport = new CoordinatorDeliveryTransport(channel, codex);

    await expect(transport.deliverGate(RUN_ID, GATE_ID)).resolves.toMatchObject({ kind: 'sent' });
    expect(calls).toEqual(['channel', 'codex']);

    const blocked: GateChannelDeliveryTransport = {
      deliverGate: () => Promise.resolve({ kind: 'pending', code: 'unverified' }),
    };
    const never: GateChannelDeliveryTransport = {
      deliverGate: (): Promise<ChannelDeliverySendResult> => {
        throw new Error('Codex fallback must not bypass an unverified Channel route');
      },
    };
    await expect(new CoordinatorDeliveryTransport(blocked, never).deliverGate(RUN_ID, GATE_ID))
      .resolves.toEqual({ kind: 'pending', code: 'unverified' });
  });
});
