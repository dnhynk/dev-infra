import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import {
  main,
  parseArgs,
  runChannelAdapterCommand,
  type ChannelAdapterRuntime,
  type ChannelMcpRuntime,
} from '../src/cli.js';
import type { ChannelReceiptHandler } from '../src/channel/mcp-server.js';
import { ChannelPipeServer } from '../src/channel/pipe-server.js';
import type { OrcaRunner } from '../src/orca/client.js';
import { APP_TOKEN_VAR } from '../src/slack/verify.js';

const ENV_VALUES: Readonly<Record<string, string>> = {
  CLAUDE_CODE_SESSION_ID: '11111111-1111-4111-8111-111111111111',
  ORCA_TERMINAL_HANDLE: 'term_22222222-2222-4222-8222-222222222222',
  ORCA_PANE_KEY: '33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444',
};

function parsedAdapter() {
  const parsed = parseArgs(['channel-adapter']);
  if (parsed.kind !== 'run') throw new Error('channel-adapter args failed');
  return parsed;
}

function never(): Promise<void> {
  return new Promise(() => undefined);
}

const EMPTY_ORCA: OrcaRunner = {
  run: (args) => args.join(' ') === 'orchestration run-list --json'
    ? Promise.resolve(JSON.stringify({ id: 'fake', ok: true, result: { runs: [] } }))
    : Promise.reject(new Error('unexpected fake Orca command')),
};

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('cli_channel_test_timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function captureJsonLines(output: PassThrough): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  let buffer = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => {
    buffer += String(chunk);
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line !== '') messages.push(JSON.parse(line) as Record<string, unknown>);
    }
  });
  return messages;
}

describe('channel-adapter production CLI wiring', () => {
  it('runs main through the real stdio MCP server, pipe Adapter, probe, and receipt callback', async () => {
    const daemon = new ChannelPipeServer({
      orca: EMPTY_ORCA,
      probeDelaysMs: [10],
      helloTimeoutMs: 500,
      shutdownTimeoutMs: 500,
    });
    await daemon.start();
    const input = new PassThrough();
    const output = new PassThrough();
    const messages = captureJsonLines(output);
    let running: Promise<number> | null = null;
    try {
      running = main(['channel-adapter'], {
        channelAdapter: { env: { ...ENV_VALUES }, input, output },
      });
      input.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'production-cli-test', version: '0.0.0' },
        },
      })}\n`);
      await waitFor(() => messages.some((message) => message['id'] === 1));
      input.write(`${JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      })}\n`);
      await waitFor(() => messages.some((message) => message['method'] === 'notifications/claude/channel'));
      const notification = messages.find(
        (message) => message['method'] === 'notifications/claude/channel',
      )!;
      expect(notification).toEqual({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: {
          content: '',
          meta: { gate_id: expect.stringMatching(/^gate_[a-z0-9]{12}$/) },
        },
      });
      const gateId = (notification['params'] as { meta: { gate_id: string } }).meta.gate_id;
      input.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'orca_channel_receipt', arguments: { gate_id: gateId } },
      })}\n`);
      await waitFor(() => messages.some((message) => message['id'] === 2));
      expect(messages.find((message) => message['id'] === 2)).toMatchObject({
        jsonrpc: '2.0',
        id: 2,
        result: { content: [{ type: 'text', text: 'receipt_accepted' }] },
      });
      await waitFor(() => daemon.listConnections()[0]?.verified === true);
      expect(daemon.getResourceSnapshot().productionGateWrites).toBe(0);

      input.end();
      expect(await running).toBe(0);
      await waitFor(() => daemon.getResourceSnapshot().sockets === 0);
    } finally {
      input.end();
      await running?.catch(() => undefined);
      await daemon.stop();
    }
  });

  it('runs main daemon with the production fixed-pipe owner and releases it for rebind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-channel-main-'));
    const configPath = join(dir, 'config.json');
    const statePath = join(dir, 'state.db');
    writeFileSync(configPath, JSON.stringify({
      slack: {
        teamId: 'T0TEAM',
        apiAppId: 'A0APP',
        ownerUserIds: ['U0OWNER'],
        channels: { prDigest: 'C0PRDIGEST', agentRuns: 'C0AGENTRUNS' },
      },
      projects: [],
    }));
    process.env[APP_TOKEN_VAR] = ['xapp', 'FAKE', 'NOTAREALTOKEN'].join('-');
    const events: string[] = [];
    let rebound: ChannelPipeServer | null = null;
    try {
      const code = await main([
        'daemon', '--config', configPath, '--state', statePath,
      ], {
        daemon: {
          orca: EMPTY_ORCA,
          slack: {
            post: () => Promise.reject(new Error('unused fake Slack post')),
            update: () => Promise.reject(new Error('unused fake Slack update')),
          },
          connectionFactory: () => ({
            start: () => { events.push('socket:start'); return Promise.resolve({ appId: 'A0APP' }); },
            close: () => { events.push('socket:stop'); return Promise.resolve(); },
          }),
          waitForStop: () => Promise.resolve(),
        },
      });
      expect(code).toBe(0);
      expect(events).toEqual(['socket:start', 'socket:stop']);

      rebound = new ChannelPipeServer({ orca: EMPTY_ORCA });
      await rebound.start();
      expect(rebound.getResourceSnapshot().listening).toBe(true);
    } finally {
      delete process.env[APP_TOKEN_VAR];
      await rebound?.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads only routing claims, connects stdio before the pipe, and forwards receipt callbacks', async () => {
    const environmentReads: string[] = [];
    const env = new Proxy({} as NodeJS.ProcessEnv, {
      get: (_target, property) => {
        if (typeof property !== 'string' || !(property in ENV_VALUES)) {
          throw new Error('unexpected environment read');
        }
        environmentReads.push(property);
        return ENV_VALUES[property];
      },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    const events: string[] = [];
    const receipts: string[] = [];
    let receipt!: ChannelReceiptHandler;
    let mcp!: ChannelMcpRuntime;

    const code = await runChannelAdapterCommand(parsedAdapter(), {
      env,
      input,
      output,
      createMcp: (receivedReceipt) => {
        receipt = receivedReceipt;
        mcp = {
          connectStdio: async (receivedInput, receivedOutput) => {
            expect(receivedInput).toBe(input);
            expect(receivedOutput).toBe(output);
            events.push('mcp:connect');
          },
          notifyGate: () => Promise.resolve(),
          waitClosed: never,
          close: async () => { events.push('mcp:close'); },
        };
        return mcp;
      },
      createAdapter: (identity, writer): ChannelAdapterRuntime => {
        expect(identity).toEqual({
          sessionId: ENV_VALUES['CLAUDE_CODE_SESSION_ID'],
          terminalHandle: ENV_VALUES['ORCA_TERMINAL_HANDLE'],
          paneKey: ENV_VALUES['ORCA_PANE_KEY'],
        });
        expect(writer).toBe(mcp);
        return {
          start: () => { events.push('adapter:start'); },
          stop: async () => { events.push('adapter:stop'); },
          reportReceipt: async (gateId) => {
            receipts.push(gateId);
            return 'accepted';
          },
        };
      },
      waitForStop: async () => {
        expect(events).toEqual(['mcp:connect', 'adapter:start']);
        expect(await receipt('gate_abcdef123456')).toBe('accepted');
        events.push('wait:done');
      },
    });

    expect(code).toBe(0);
    expect(environmentReads).toEqual([
      'CLAUDE_CODE_SESSION_ID',
      'ORCA_TERMINAL_HANDLE',
      'ORCA_PANE_KEY',
    ]);
    expect(receipts).toEqual(['gate_abcdef123456']);
    expect(events).toEqual([
      'mcp:connect',
      'adapter:start',
      'wait:done',
      'adapter:stop',
      'mcp:close',
    ]);
  });

  it('stops on stdio EOF and restores every process signal listener it installed', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.resume();
    const beforeSigint = process.listenerCount('SIGINT');
    const beforeSigterm = process.listenerCount('SIGTERM');
    let stopped = 0;
    let closed = 0;
    const mcp: ChannelMcpRuntime = {
      connectStdio: () => Promise.resolve(),
      notifyGate: () => Promise.resolve(),
      waitClosed: never,
      close: async () => { closed += 1; },
    };

    setImmediate(() => input.end());
    const code = await runChannelAdapterCommand(parsedAdapter(), {
      env: { ...ENV_VALUES },
      input,
      output,
      createMcp: () => mcp,
      createAdapter: () => ({
        start: () => undefined,
        stop: async () => { stopped += 1; },
        reportReceipt: () => Promise.resolve('accepted'),
      }),
    });

    expect(code).toBe(0);
    expect(stopped).toBe(1);
    expect(closed).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });

  it('bounds non-cooperative Adapter and MCP cleanup phases', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const mcp: ChannelMcpRuntime = {
      connectStdio: () => Promise.resolve(),
      notifyGate: () => Promise.resolve(),
      waitClosed: never,
      close: never,
    };
    const began = Date.now();
    const code = await runChannelAdapterCommand(parsedAdapter(), {
      env: { ...ENV_VALUES },
      input,
      output,
      shutdownTimeoutMs: 10,
      createMcp: () => mcp,
      createAdapter: () => ({
        start: () => undefined,
        stop: never,
        reportReceipt: () => Promise.resolve('accepted'),
      }),
      waitForStop: () => Promise.resolve(),
    });

    expect(code).toBe(0);
    expect(Date.now() - began).toBeLessThan(500);
  });

  it('does not hang when stdio had already ended before the Adapter starts waiting', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const ended = new Promise<void>((resolve) => input.once('end', resolve));
    input.resume();
    input.end();
    await ended;
    const beforeSigint = process.listenerCount('SIGINT');
    const beforeSigterm = process.listenerCount('SIGTERM');
    const mcp: ChannelMcpRuntime = {
      connectStdio: () => Promise.resolve(),
      notifyGate: () => Promise.resolve(),
      waitClosed: never,
      close: () => Promise.resolve(),
    };

    const code = await runChannelAdapterCommand(parsedAdapter(), {
      env: { ...ENV_VALUES },
      input,
      output,
      createMcp: () => mcp,
      createAdapter: () => ({
        start: () => undefined,
        stop: () => Promise.resolve(),
        reportReceipt: () => Promise.resolve('accepted'),
      }),
    });

    expect(code).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm);
  });
});
