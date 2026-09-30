#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const RUN_ID = /^run_[A-Za-z0-9_-]+$/;
const TERMINAL_HANDLE = /^term_[A-Za-z0-9-]+$/;
const PANE_KEY = /^[A-Za-z0-9-]+:[A-Za-z0-9-]+$/;
const MODEL = /^gpt-[A-Za-z0-9.-]+$/;
const SESSION_ID = /^[A-Za-z0-9._:-]+$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const WRITE_VALUES = new Set([
  'run-id', 'worktree', 'session-id', 'terminal-handle', 'pane-key', 'generation', 'model',
  'effort', 'context-window', 'handoff-path', 'reserve-tokens',
]);

function markerRoot() {
  const override = process.env.ORCA_CODEX_MARKER_ROOT;
  return override ? resolve(override) : join(homedir(), '.codex', 'orchestration', 'runs');
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token?.startsWith('--')) throw new TypeError(`unexpected argument: ${token ?? ''}`);
    const name = token.slice(2);
    if (name === '' || values.has(name) || flags.has(name)) {
      throw new TypeError(`duplicate or empty option: ${token}`);
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) flags.add(name);
    else {
      values.set(name, next);
      i += 1;
    }
  }
  return { command, values, flags };
}

function validateOptions(command, values, flags) {
  const allowedValues = command === 'write' ? WRITE_VALUES : new Set(['run-id']);
  const allowedFlags = command === 'write' ? new Set(['rollover-approved']) : new Set();
  for (const name of values.keys()) {
    if (!allowedValues.has(name)) throw new TypeError(`unknown --${name}`);
  }
  for (const name of flags) {
    if (!allowedFlags.has(name)) throw new TypeError(`unknown --${name}`);
  }
}

function required(values, name) {
  const value = values.get(name);
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`missing --${name}`);
  return value;
}

function bounded(value, name, max = 2048) {
  if (value.length > max) throw new TypeError(`--${name} is too long`);
  return value;
}

function runId(values) {
  const value = required(values, 'run-id');
  if (!RUN_ID.test(value)) throw new TypeError('invalid --run-id');
  return value;
}

function markerPath(id) {
  return join(markerRoot(), `${id}.json`);
}

function positiveInteger(raw, name, allowZero = false) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`invalid --${name}`);
  }
  return value;
}

function absolutePath(values, name) {
  const value = bounded(required(values, name), name, 8192);
  if (!isAbsolute(value)) throw new TypeError(`--${name} must be absolute`);
  return resolve(value);
}

function oldRollover(path, id) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value?.run_id === id && value?.rollover && typeof value.rollover === 'object'
      ? value.rollover
      : undefined;
  } catch {
    return undefined;
  }
}

function atomicWrite(path, value) {
  const directory = markerRoot();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
    throw error;
  }
}

function write(values, flags) {
  const id = runId(values);
  const terminalHandle = bounded(required(values, 'terminal-handle'), 'terminal-handle', 256);
  const paneKey = bounded(required(values, 'pane-key'), 'pane-key', 256);
  const model = bounded(required(values, 'model'), 'model', 128);
  const effort = required(values, 'effort');
  const sessionId = bounded(required(values, 'session-id'), 'session-id', 256);
  const contextWindow = positiveInteger(required(values, 'context-window'), 'context-window');
  const reserveRaw = values.get('reserve-tokens');
  if (!TERMINAL_HANDLE.test(terminalHandle)) throw new TypeError('invalid --terminal-handle');
  if (!PANE_KEY.test(paneKey)) throw new TypeError('invalid --pane-key');
  if (!MODEL.test(model)) throw new TypeError('invalid --model');
  if (!SESSION_ID.test(sessionId)) throw new TypeError('invalid --session-id');
  if (!EFFORTS.has(effort)) throw new TypeError('invalid --effort');
  const reserveTokens = reserveRaw === undefined
    ? undefined
    : positiveInteger(reserveRaw, 'reserve-tokens');
  if (reserveTokens !== undefined && reserveTokens >= contextWindow) {
    throw new TypeError('--reserve-tokens must be smaller than --context-window');
  }

  const path = markerPath(id);
  const marker = {
    schema_version: 1,
    provider: 'codex',
    run_id: id,
    worktree_path: absolutePath(values, 'worktree'),
    coordinator_session_id: sessionId,
    coordinator_terminal_handle: terminalHandle,
    coordinator_pane_key: paneKey,
    coordinator_generation: positiveInteger(required(values, 'generation'), 'generation', true),
    coordinator_model: model,
    coordinator_effort: effort,
    context_window: contextWindow,
    ...(reserveTokens === undefined ? {} : { reserve_tokens: reserveTokens }),
    rollover_approved: flags.has('rollover-approved'),
    handoff_path: absolutePath(values, 'handoff-path'),
    updated_at: new Date().toISOString(),
  };
  const rollover = oldRollover(path, id);
  if (rollover !== undefined) marker.rollover = rollover;
  atomicWrite(path, marker);
  process.stdout.write(`${JSON.stringify({ ok: true, marker: path })}\n`);
}

function remove(values) {
  const id = runId(values);
  const path = markerPath(id);
  try {
    unlinkSync(path);
    process.stdout.write(`${JSON.stringify({ ok: true, marker: path, removed: true })}\n`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    process.stdout.write(`${JSON.stringify({ ok: true, marker: path, removed: false })}\n`);
  }
}

function show(values) {
  const path = markerPath(runId(values));
  const marker = JSON.parse(readFileSync(path, 'utf8'));
  process.stdout.write(`${JSON.stringify({ ok: true, marker: path, value: marker }, null, 2)}\n`);
}

function main() {
  const { command, values, flags } = parseArgs(process.argv.slice(2));
  if (command !== 'write' && command !== 'remove' && command !== 'show') {
    throw new TypeError('usage: run-marker.mjs write|show|remove --run-id <run_id> ...');
  }
  validateOptions(command, values, flags);
  if (command === 'write') return write(values, flags);
  if (command === 'remove') return remove(values);
  if (command === 'show') return show(values);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[codex-run-marker] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
