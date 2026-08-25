import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Notification } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import {
  CHANNEL_MCP_INSTRUCTIONS,
  CHANNEL_MCP_SERVER_NAME,
  CHANNEL_MCP_SERVER_VERSION,
  CHANNEL_RECEIPT_TOOL,
  ChannelMcpServer,
} from '../src/channel/mcp-server.js';

async function connected(receipt: (gateId: string) => Promise<'accepted' | 'duplicate'>): Promise<{
  readonly mcp: ChannelMcpServer;
  readonly client: Client;
  readonly notifications: Notification[];
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new ChannelMcpServer({ receipt });
  const client = new Client({ name: 'fake-claude-code', version: '0.0.0' }, { capabilities: {} });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification);
  };
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  return { mcp, client, notifications };
}

describe('stdio MCP Channel server surface', () => {
  it('declares only the exact Channel and tool capabilities with safe instructions', async () => {
    const { mcp, client } = await connected(async () => 'accepted');
    expect(client.getServerVersion()).toEqual({
      name: CHANNEL_MCP_SERVER_NAME,
      version: CHANNEL_MCP_SERVER_VERSION,
    });
    expect(client.getServerCapabilities()).toEqual({
      experimental: { 'claude/channel': {} },
      tools: {},
    });
    expect(client.getInstructions()).toBe(CHANNEL_MCP_INSTRUCTIONS);
    expect(client.getServerCapabilities()?.experimental).not.toHaveProperty('claude/channel/permission');
    await client.close();
    await mcp.close();
  });

  it('advertises one strict gate_id-only receipt tool', async () => {
    const calls: string[] = [];
    const { mcp, client } = await connected(async (gateId) => {
      calls.push(gateId);
      return calls.length === 1 ? 'accepted' : 'duplicate';
    });
    const listed = await client.listTools();
    expect(listed.tools).toEqual([
      {
        name: CHANNEL_RECEIPT_TOOL,
        description: expect.any(String),
        inputSchema: {
          type: 'object',
          properties: {
            gate_id: {
              type: 'string',
              pattern: '^gate_[a-z0-9]{12}$',
              description: expect.any(String),
            },
          },
          required: ['gate_id'],
          additionalProperties: false,
        },
      },
    ]);

    const accepted = await client.callTool({
      name: CHANNEL_RECEIPT_TOOL,
      arguments: { gate_id: 'gate_1234abcdef56' },
    });
    const duplicate = await client.callTool({
      name: CHANNEL_RECEIPT_TOOL,
      arguments: { gate_id: 'gate_1234abcdef56' },
    });
    expect(accepted).toMatchObject({ content: [{ type: 'text', text: 'receipt_accepted' }] });
    expect(duplicate).toMatchObject({ content: [{ type: 'text', text: 'receipt_duplicate' }] });
    expect(calls).toEqual(['gate_1234abcdef56', 'gate_1234abcdef56']);

    for (const request of [
      { name: CHANNEL_RECEIPT_TOOL, arguments: {} },
      { name: CHANNEL_RECEIPT_TOOL, arguments: { gate_id: 'gate_1234abcdef56', status: 'done' } },
      { name: CHANNEL_RECEIPT_TOOL, arguments: { gate_id: 'wrong' } },
      { name: 'other_tool', arguments: { gate_id: 'gate_1234abcdef56' } },
    ]) {
      const result = await client.callTool(request);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: expect.stringMatching(/^(invalid_receipt|unknown_tool)$/) }]);
    }
    expect(calls).toHaveLength(2);
    await client.close();
    await mcp.close();
  });

  it('writes empty content plus only meta.gate_id and does not manufacture a receipt', async () => {
    const receipts: string[] = [];
    const { mcp, client, notifications } = await connected(async (gateId) => {
      receipts.push(gateId);
      return 'accepted';
    });
    await mcp.notifyGate('gate_abcdef123456');
    expect(notifications).toEqual([
      {
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: { content: '', meta: { gate_id: 'gate_abcdef123456' } },
      },
    ]);
    expect(Object.keys((notifications[0]!.params as { meta: object }).meta)).toEqual(['gate_id']);
    expect(receipts).toEqual([]);
    await client.close();
    await mcp.close();
  });

  it('does not treat MCP connect as initialized/readiness', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new ChannelMcpServer({ receipt: async () => 'accepted' });
    await mcp.connect(serverTransport);
    await expect(mcp.notifyGate('gate_abcdef123456')).rejects.toThrowError('mcp_not_initialized');
    await clientTransport.close();
    await mcp.close();
  });
});
