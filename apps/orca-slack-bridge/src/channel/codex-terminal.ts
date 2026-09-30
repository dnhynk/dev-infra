import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { listRuns, type OrcaRun, type OrcaRunner } from '../orca/client.js';
import { sendTerminalInput, readTerminalRoute } from '../terminal/client.js';
import type { GateChannelDeliveryTransport } from './delivery.js';
import type { ChannelDeliverySendResult } from './pipe-server.js';

const RUN_ID = /^run_[A-Za-z0-9_-]+$/;
const GATE_ID = /^gate_[A-Za-z0-9_-]+$/;
const TERMINAL_HANDLE = /^term_[A-Za-z0-9-]+$/;
const PANE_KEY = /^[A-Za-z0-9-]+:[A-Za-z0-9-]+$/;
const SESSION_ID = /^[A-Za-z0-9._:-]+$/;
const MAX_MARKER_BYTES = 64 * 1024;

type CodexRunMarker = {
  readonly runId: string;
  readonly worktreePath: string;
  readonly sessionId: string;
  readonly terminalHandle: string;
  readonly paneKey: string;
  readonly generation: number;
};

export type CodexTerminalDeliveryOptions = {
  readonly orca: OrcaRunner;
  /** Test/operations seam. Production defaults to the user-owned shared Codex marker directory. */
  readonly markerRoot?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedPath(value: string): string {
  const normalized = resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

function exactRun(runs: readonly OrcaRun[], runId: string): OrcaRun | ChannelDeliverySendResult {
  const matches = runs.filter((run) => run.id === runId);
  if (matches.length === 0) return { kind: 'pending', code: 'run_missing' };
  if (matches.length > 1) return { kind: 'ambiguous', code: 'duplicate_run' };
  return matches[0]!;
}

function currentGeneration(run: OrcaRun): number | null {
  return run.consumerGeneration.kind === 'value' ? run.consumerGeneration.value : null;
}

function parseMarker(value: unknown, runId: string): CodexRunMarker | null {
  if (!isRecord(value) || value['schema_version'] !== 1 || value['provider'] !== 'codex') return null;
  const generation = value['coordinator_generation'];
  const worktreePath = value['worktree_path'];
  const sessionId = value['coordinator_session_id'];
  const terminalHandle = value['coordinator_terminal_handle'];
  const paneKey = value['coordinator_pane_key'];
  if (
    value['run_id'] !== runId ||
    typeof worktreePath !== 'string' || worktreePath === '' || !isAbsolute(worktreePath) ||
    typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) ||
    typeof terminalHandle !== 'string' || !TERMINAL_HANDLE.test(terminalHandle) ||
    typeof paneKey !== 'string' || !PANE_KEY.test(paneKey) ||
    typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0
  ) return null;
  return { runId, worktreePath, sessionId, terminalHandle, paneKey, generation };
}

function sameOwner(run: OrcaRun, marker: CodexRunMarker): boolean {
  return run.coordinatorHandle === marker.terminalHandle &&
    run.coordinatorPaneKey === marker.paneKey &&
    currentGeneration(run) === marker.generation;
}

function sameMarker(left: CodexRunMarker, right: CodexRunMarker): boolean {
  return left.runId === right.runId &&
    left.sessionId === right.sessionId &&
    left.terminalHandle === right.terminalHandle &&
    left.paneKey === right.paneKey &&
    left.generation === right.generation &&
    samePath(left.worktreePath, right.worktreePath);
}

function sameTerminal(marker: CodexRunMarker, terminal: Awaited<ReturnType<typeof readTerminalRoute>>): boolean {
  return terminal !== null && terminal.connected && terminal.writable &&
    terminal.handle === marker.terminalHandle &&
    terminal.paneKey === marker.paneKey &&
    samePath(terminal.worktreePath, marker.worktreePath);
}

function wakePrompt(runId: string, gateId: string): string {
  return `[orca-gate-wakeup v1 run_id=${runId} gate_id=${gateId}] ` +
    'Wake only: re-read this exact Orca Gate and current Run; do not infer a decision from this ' +
    'message. Apply the observed resolution idempotently, then continue the coordinator loop.';
}

/**
 * Queue a Gate identity for a marker-authorized Codex coordinator through Orca terminal input.
 *
 * The marker alone is never enough: the current Run row, terminal route, worktree, pane, and
 * generation must all agree both before and after the prompt is queued.
 */
export class CodexTerminalDeliveryTransport implements GateChannelDeliveryTransport {
  readonly #orca: OrcaRunner;
  readonly #markerRoot: string;

  constructor(options: CodexTerminalDeliveryOptions) {
    this.#orca = options.orca;
    this.#markerRoot = resolve(
      options.markerRoot ?? process.env['ORCA_CODEX_MARKER_ROOT'] ??
        join(homedir(), '.codex', 'orchestration', 'runs'),
    );
  }

  async #readMarker(runId: string): Promise<CodexRunMarker | 'missing' | 'invalid'> {
    if (!RUN_ID.test(runId)) return 'invalid';
    const path = join(this.#markerRoot, `${runId}.json`);
    let facts;
    try { facts = await stat(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      return 'invalid';
    }
    if (!facts.isFile() || facts.size < 2 || facts.size > MAX_MARKER_BYTES) return 'invalid';
    try {
      return parseMarker(JSON.parse(await readFile(path, 'utf8')), runId) ?? 'invalid';
    } catch {
      return 'invalid';
    }
  }

  async deliverGate(
    runId: string,
    gateId: string,
    signal?: AbortSignal,
  ): Promise<ChannelDeliverySendResult> {
    if (!RUN_ID.test(runId) || !GATE_ID.test(gateId)) {
      return { kind: 'pending', code: 'unverified' };
    }
    if (signal?.aborted) return { kind: 'pending', code: 'no_candidate' };
    const options = signal === undefined ? undefined : { signal };
    let runs;
    try { runs = await listRuns(this.#orca, options); } catch {
      return { kind: 'pending', code: 'run_read_failed' };
    }
    const selected = exactRun(runs, runId);
    if ('kind' in selected) return selected;
    if (selected.consumerGeneration.kind !== 'value') {
      return { kind: 'pending', code: 'run_unreadable' };
    }

    const marker = await this.#readMarker(runId);
    if (marker === 'missing') return { kind: 'pending', code: 'no_candidate' };
    if (marker === 'invalid') return { kind: 'pending', code: 'unverified' };
    if (!sameOwner(selected, marker)) return { kind: 'pending', code: 'stale_generation' };

    let terminal;
    try { terminal = await readTerminalRoute(this.#orca, marker.terminalHandle, options); } catch {
      return { kind: 'pending', code: 'run_read_failed' };
    }
    if (terminal === null || !terminal.connected || !terminal.writable) {
      return { kind: 'pending', code: 'no_candidate' };
    }
    if (!sameTerminal(marker, terminal)) return { kind: 'pending', code: 'unverified' };
    if (signal?.aborted) return { kind: 'pending', code: 'no_candidate' };

    let accepted;
    try {
      // --interrupt terminates an idle Codex TUI (0.153.4). Enter submits or queues the prompt
      // without sending a process interrupt, including when the coordinator is already working.
      accepted = await sendTerminalInput(
        this.#orca,
        marker.terminalHandle,
        { text: wakePrompt(runId, gateId), enter: true },
        options,
      );
    } catch {
      return { kind: 'pending', code: 'write_failed' };
    }
    if (!accepted || signal?.aborted) return { kind: 'pending', code: 'write_failed' };

    // Close the longest races available through the public CLI: marker replacement, terminal
    // movement, or Run takeover after the first reads but before queue acceptance. The
    // prompt is harmless identity-only data, but no application receipt is issued for a stale
    // route. This remains a queue receipt, never Gate evidence.
    const afterMarker = await this.#readMarker(runId);
    if (afterMarker === 'missing') return { kind: 'pending', code: 'stale_generation' };
    if (afterMarker === 'invalid' || !sameMarker(marker, afterMarker)) {
      return { kind: 'pending', code: 'unverified' };
    }
    let afterTerminal;
    try { afterTerminal = await readTerminalRoute(this.#orca, marker.terminalHandle, options); } catch {
      return { kind: 'pending', code: 'run_read_failed' };
    }
    if (!sameTerminal(marker, afterTerminal)) return { kind: 'pending', code: 'unverified' };

    let afterRuns;
    try {
      afterRuns = await listRuns(this.#orca, options);
    } catch {
      return { kind: 'pending', code: 'run_read_failed' };
    }
    const after = exactRun(afterRuns, runId);
    if ('kind' in after || !sameOwner(after, marker)) {
      return { kind: 'pending', code: 'stale_generation' };
    }
    if (signal?.aborted) return { kind: 'pending', code: 'write_failed' };
    return {
      kind: 'sent',
      epoch: `codex:${marker.sessionId}`,
      generation: marker.generation,
      receipt: 'application_queued',
    };
  }
}

/** Prefer the authenticated Claude Channel route, then use Codex only when no Adapter exists. */
export class CoordinatorDeliveryTransport implements GateChannelDeliveryTransport {
  constructor(
    private readonly channel: GateChannelDeliveryTransport,
    private readonly codex: GateChannelDeliveryTransport,
  ) {}

  async deliverGate(
    runId: string,
    gateId: string,
    signal?: AbortSignal,
  ): Promise<ChannelDeliverySendResult> {
    const channelResult = await this.channel.deliverGate(runId, gateId, signal);
    if (channelResult.kind !== 'pending' || channelResult.code !== 'no_candidate') {
      return channelResult;
    }
    return this.codex.deliverGate(runId, gateId, signal);
  }
}
