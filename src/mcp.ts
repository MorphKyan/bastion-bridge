#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomUUID } from 'node:crypto';
import { actions, agentActions, descriptions } from './actions.js';
import { ensureDaemon, rpc } from './client.js';
import { ToolError } from './shared.js';

const server = new McpServer({ name: 'bastion-bridge', version: '0.1.0' });
const owner = `Agent ${randomUUID().slice(0, 8)}`;
for (const action of agentActions) {
  server.registerTool(
    action,
    {
      description: descriptions[action],
      inputSchema: actions[action].shape,
      annotations: {
        readOnlyHint: ['list', 'operation_read'].includes(action),
        destructiveHint: ['exec', 'subshell_exec', 'subshell_batch', 'send', 'key'].includes(
          action,
        ),
        idempotentHint: ['list', 'renew', 'read', 'operation_wait', 'operation_read'].includes(
          action,
        ),
      },
    },
    async (args: any) => {
      try {
        await ensureDaemon();
        const result = await rpc(action, args, owner);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          structuredContent: { result },
        };
      } catch (e) {
        const error =
          e instanceof ToolError
            ? { code: e.code, message: e.message, details: e.details }
            : { code: 'TOOL_ERROR', message: '调用失败，请检查本机状态。' };
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error) }] };
      }
    },
  );
}
server.connect(new StdioServerTransport()).catch(() => {
  process.stderr.write('MCP initialization failed.\n');
  process.exitCode = 1;
});
