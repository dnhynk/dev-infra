#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_MARKERS = 256;
const MAX_MARKER_BYTES = 64 * 1024;
const MAX_TRIGGERS = 3;
const RUN_ID = /^run_[A-Za-z0-9_-]+$/;
const TERMINAL_HANDLE = /^term_[A-Za-z0-9-]+$/;
const PANE_KEY = /^[A-Za-z0-9-]+:[A-Za-z0-9-]+$/;
const SESSION_ID = /^[A-Za-z0-9._:-]+$/;
const MODEL = /^gpt-[A-Za-z0-9.-]+$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function markerRoot() {
  const override = process.env.ORCA_CODEX_MARKER_ROOT;
  return override ? resolve(override) : join(homedir(), '.codex', 'orchestration', 'runs');
}

function passthrough(note) {
  if (note) process.stderr.write(`[codex-rollover-monitor] ${note}\n`);
  process.stdout.write('{}');
  process.exit(0);
}

function samePath(left, right) {
  const normalizedLeft = resolve(left).replaceAll('\\', '/');
  const normalizedRight = resolve(right).replaceAll('\\', '/');
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function readMarker(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    if (size < 2 || size > MAX_MARKER_BYTES) return null;
    const bytes = Buffer.alloc(size);
    readSync(fd, bytes, 0, size, 0);
    return JSON.parse(bytes.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

function matchingMarker(hook) {
  let entries;
  try {
    entries = readdirSync(markerRoot(), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (entries.length > MAX_MARKERS) throw new Error('too many active Run markers');
  const matches = [];
  for (const entry of entries) {
    let marker;
    try { marker = readMarker(join(markerRoot(), entry.name)); } catch { continue; }
    if (
      marker?.schema_version !== 1 ||
      marker?.provider !== 'codex' ||
      marker?.rollover_approved !== true ||
      typeof marker?.run_id !== 'string' ||
      !RUN_ID.test(marker.run_id) ||
      entry.name !== `${marker.run_id}.json` ||
      typeof marker?.coordinator_session_id !== 'string' ||
      !SESSION_ID.test(marker.coordinator_session_id) ||
      marker?.coordinator_session_id !== hook.session_id ||
      typeof marker?.worktree_path !== 'string' ||
      !isAbsolute(marker.worktree_path) ||
      typeof marker?.handoff_path !== 'string' ||
      !isAbsolute(marker.handoff_path) ||
      typeof marker?.coordinator_terminal_handle !== 'string' ||
      !TERMINAL_HANDLE.test(marker.coordinator_terminal_handle) ||
      typeof marker?.coordinator_pane_key !== 'string' ||
      !PANE_KEY.test(marker.coordinator_pane_key) ||
      !Number.isSafeInteger(marker?.coordinator_generation) ||
      marker.coordinator_generation < 0 ||
      typeof marker?.coordinator_model !== 'string' ||
      !MODEL.test(marker.coordinator_model) ||
      !EFFORTS.has(marker?.coordinator_effort) ||
      !Number.isSafeInteger(marker?.context_window) ||
      marker.context_window <= 0 ||
      (marker.reserve_tokens !== undefined &&
        (!Number.isSafeInteger(marker.reserve_tokens) || marker.reserve_tokens <= 0 ||
          marker.reserve_tokens >= marker.context_window)) ||
      !samePath(marker.worktree_path, hook.cwd)
    ) continue;
    matches.push({ path: join(markerRoot(), entry.name), marker });
  }
  if (matches.length > 1) throw new Error('multiple markers claim this coordinator session');
  return matches[0] ?? null;
}

function readTail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    readSync(fd, bytes, 0, length, size - length);
    const text = bytes.toString('utf8');
    if (size <= length) return text;
    const firstNewline = text.indexOf('\n');
    return firstNewline < 0 ? '' : text.slice(firstNewline + 1);
  } finally {
    closeSync(fd);
  }
}

function latestUsage(transcriptPath) {
  const lines = readTail(transcriptPath).split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'event_msg' || record?.payload?.type !== 'token_count') continue;
    const info = record.payload.info;
    const usage = info?.last_token_usage;
    if (!usage || typeof info !== 'object') continue;
    const summed = Number(usage.input_tokens) + Number(usage.output_tokens);
    const used = Number.isFinite(usage.total_tokens) ? Number(usage.total_tokens) : summed;
    const contextWindow = Number(info.model_context_window);
    if (!Number.isFinite(used) || used < 0) continue;
    return { used, contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null };
  }
  return null;
}

function reserveFor(marker, contextWindow) {
  if (Number.isFinite(marker.reserve_tokens) && marker.reserve_tokens > 0) {
    return Math.min(Math.trunc(marker.reserve_tokens), contextWindow - 1);
  }
  const proportional = Math.round(contextWindow * 0.12);
  return Math.min(contextWindow - 1, Math.max(64_000, Math.min(128_000, proportional)));
}

function atomicWrite(path, value) {
  const temporary = join(markerRoot(), `.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
    throw error;
  }
}

function main() {
  let hook;
  try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { return passthrough(); }
  if (hook?.stop_hook_active === true) return passthrough();
  if (
    typeof hook?.cwd !== 'string' ||
    !isAbsolute(hook.cwd) ||
    typeof hook?.transcript_path !== 'string' ||
    !isAbsolute(hook.transcript_path) ||
    typeof hook?.session_id !== 'string'
  ) return passthrough();

  let selected;
  try { selected = matchingMarker(hook); } catch (error) {
    return passthrough(error instanceof Error ? error.message : String(error));
  }
  if (selected === null) return passthrough();

  let usage;
  try { usage = latestUsage(hook.transcript_path); } catch {
    return passthrough('could not read Codex token_count transcript events');
  }
  if (usage === null) return passthrough('no usable Codex token_count event');
  const fallbackWindow = Number(selected.marker.context_window);
  const contextWindow = usage.contextWindow ?? fallbackWindow;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return passthrough('context window is unavailable');
  }

  const reserve = reserveFor(selected.marker, contextWindow);
  const remaining = contextWindow - usage.used;
  if (remaining > reserve) return passthrough();

  const previous = selected.marker.rollover ?? { triggered_count: 0 };
  const state = previous.last_session_id === hook.session_id
    ? previous
    : { triggered_count: 0 };
  if (Number(state.triggered_count) >= MAX_TRIGGERS) {
    return passthrough(`rollover instruction limit ${MAX_TRIGGERS} reached for this session`);
  }

  selected.marker.rollover = {
    triggered_count: Number(state.triggered_count) + 1,
    last_triggered_at: new Date().toISOString(),
    last_remaining_tokens: remaining,
    last_context_window: contextWindow,
    last_session_id: hook.session_id,
  };
  selected.marker.updated_at = new Date().toISOString();
  try { atomicWrite(selected.path, selected.marker); } catch {
    // The instruction is still safe: the marker already contains explicit prior approval.
  }

  const reason =
    `[codex-rollover-monitor] ${remaining} tokens remain; reserve is ${reserve}. ` +
    `Start the pre-approved rollover for Run ${selected.marker.run_id} now. Do not start a new ` +
    `dispatch or merge. Follow $init-orchestrate run-lifecycle in order: fence this coordinator, ` +
    `atomically finalize the handoff, launch ${selected.marker.coordinator_model} at ` +
    `${selected.marker.coordinator_effort}, inject ` +
    `$init-orchestrate --resume ${selected.marker.run_id}, observe ownership transfer, then exit. ` +
    `Resume the existing Run; never create a replacement Run.`;
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

main();
