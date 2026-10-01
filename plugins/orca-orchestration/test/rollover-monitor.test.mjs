import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = resolve(here, '..', 'skills', 'init-orchestrate');
const markerScript = join(skillRoot, 'scripts', 'run-marker.mjs');
const monitorScript = join(skillRoot, 'scripts', 'rollover-monitor.mjs');
const RUN_ID = 'run_monitor_test';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const HANDLE = 'term_55555555-5555-4555-8555-555555555555';
const PANE = '66666666-6666-4666-8666-666666666666:77777777-7777-4777-8777-777777777777';

let root;
let worktree;
let transcript;

function run(script, args, input = '') {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ORCA_CODEX_MARKER_ROOT: root },
  });
}

function writeMarker(extra = [], approved = true) {
  const result = run(markerScript, [
    'write',
    '--run-id', RUN_ID,
    '--worktree', worktree,
    '--session-id', SESSION_ID,
    '--terminal-handle', HANDLE,
    '--pane-key', PANE,
    '--generation', '2',
    '--model', 'gpt-6-astra',
    '--effort', 'xhigh',
    '--context-window', '1050000',
    '--handoff-path', join(worktree, 'HANDOFF.md'),
    ...extra,
    ...(approved ? ['--rollover-approved'] : []),
  ]);
  assert.equal(result.status, 0, result.stderr);
}

function hook(used, contextWindow = 1_050_000, extra = {}) {
  writeFileSync(transcript, `${JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: used - 100, output_tokens: 100, total_tokens: used },
        total_token_usage: { total_tokens: 9_999_999 },
        model_context_window: contextWindow,
      },
    },
  })}\n`);
  return run(monitorScript, [], JSON.stringify({
    cwd: worktree,
    transcript_path: transcript,
    session_id: SESSION_ID,
    stop_hook_active: false,
    ...extra,
  }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'codex-marker-root-'));
  worktree = mkdtempSync(join(tmpdir(), 'codex-marker-worktree-'));
  transcript = join(root, 'transcript.jsonl');
  writeMarker();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(worktree, { recursive: true, force: true });
});

describe('Codex rollover scripts', () => {
  it('uses last request context rather than cumulative thread usage', () => {
    const result = hook(800_000);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });

  it('blocks Stop inside the reserve and records the bounded trigger', () => {
    const result = hook(950_000);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /gpt-6-astra at xhigh/);
    assert.match(output.reason, new RegExp(RUN_ID));

    const marker = JSON.parse(readFileSync(join(root, `${RUN_ID}.json`), 'utf8'));
    assert.equal(marker.rollover.triggered_count, 1);
    assert.equal(marker.rollover.last_context_window, 1_050_000);
  });

  it('passes through a recursive Stop hook invocation', () => {
    const result = hook(950_000, 1_050_000, { stop_hook_active: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
  });

  it('uses the effective transcript window even when the marker fallback is larger', () => {
    const result = hook(220_000, 258_400);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, 'block');
    const marker = JSON.parse(readFileSync(join(root, `${RUN_ID}.json`), 'utf8'));
    assert.equal(marker.rollover.last_context_window, 258_400);
    assert.equal(marker.rollover.last_remaining_tokens, 38_400);
  });

  it('keeps Slack-only markers usable without opting them into rollover', () => {
    writeMarker([], false);
    const result = hook(950_000);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    const marker = JSON.parse(readFileSync(join(root, `${RUN_ID}.json`), 'utf8'));
    assert.equal(marker.rollover_approved, false);
    assert.equal(marker.rollover, undefined);
  });

  it('ignores hooks from a different session or worktree', () => {
    const original = readFileSync(join(root, `${RUN_ID}.json`), 'utf8');
    for (const identity of [{ session_id: 'other-session' }, { cwd: root }]) {
      const result = hook(950_000, 1_050_000, identity);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {});
      assert.equal(readFileSync(join(root, `${RUN_ID}.json`), 'utf8'), original);
    }
  });

  it('bounds rollover instructions across separate hook processes', () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = hook(950_000);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).decision, 'block');
    }
    const result = hook(950_000);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {});
    assert.match(result.stderr, /instruction limit 3 reached/);
  });

  it('writes a bounded reserve through the helper and rejects unknown options', () => {
    writeMarker(['--reserve-tokens', '100000']);
    const marker = JSON.parse(readFileSync(join(root, `${RUN_ID}.json`), 'utf8'));
    assert.equal(marker.reserve_tokens, 100_000);

    const invalid = run(markerScript, ['show', '--run-id', RUN_ID, '--unexpected', 'value']);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /unknown --unexpected/);
  });
});
