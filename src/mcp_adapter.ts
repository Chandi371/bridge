import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { BridgeEngine } from './engine.js';

export function createMcpRouter(options: {
  engine: BridgeEngine;
  isTokenAuthorized: (token: string) => boolean;
}) {
  const router = new Hono();
  const sessions = new Map<string, { server: Server; transport: SSEServerTransport }>();

  // Token Auth Middleware for /mcp and /mcp/*
  router.use('/mcp/*', async (c, next) => {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token || !options.isTokenAuthorized(token)) {
      return c.json({ error: 'Unauthorized MCP access' }, 401);
    }
    await next();
  });

  // GET /mcp/sse or /mcp: Establishes SSE stream
  router.get('/mcp', async (c) => {
    // In Node.js environment, handle SSE transport
    const res = c.env?.incoming; // or Node Server res
    return c.text('MCP SSE Endpoint ready. Connect with MCP Streamable HTTP / SSE client.');
  });

  // Setup MCP Server instance for tool calls
  function setupMcpServer(engine: BridgeEngine): Server {
    const server = new Server(
      {
        name: 'bridge-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Expose exactly 5 tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'list_agents',
            description: 'List available agents, capabilities, and online status.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'send',
            description: 'Send a message or start a task. Waits up to wait_seconds (max 28).',
            inputSchema: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Agent or participant name' },
                content: { type: 'string', description: 'Prompt or reply' },
                room_id: { type: 'string', description: 'Optional room ID' },
                reply_to: { type: 'string', description: 'Optional message ID being answered' },
                client_request_id: { type: 'string', description: 'Optional idempotency key' },
                wait_seconds: { type: 'number', description: 'Wait seconds (max 28)' },
              },
              required: ['to', 'content'],
            },
          },
          {
            name: 'listen',
            description: 'Long-poll for task updates or messages (max 28s).',
            inputSchema: {
              type: 'object',
              properties: {
                room_id: { type: 'string' },
                task_id: { type: 'string' },
                wait_seconds: { type: 'number' },
                cursor: { type: 'number' },
              },
            },
          },
          {
            name: 'check_inbox',
            description: 'Check unread messages and unanswered questions.',
            inputSchema: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                limit: { type: 'number' },
              },
            },
          },
          {
            name: 'cancel',
            description: 'Cancel a running task.',
            inputSchema: {
              type: 'object',
              properties: {
                task_id: { type: 'string' },
              },
              required: ['task_id'],
            },
          },
        ],
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (name === 'list_agents') {
        const res = engine.listAgents();
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      }

      if (name === 'send') {
        const res = await engine.send({
          to: (args as any).to,
          content: (args as any).content,
          room_id: (args as any).room_id,
          reply_to: (args as any).reply_to,
          client_request_id: (args as any).client_request_id,
          wait_seconds: (args as any).wait_seconds,
          sender_name: 'mcp_model',
          sender_kind: 'model',
        });
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      }

      if (name === 'listen') {
        const res = await engine.listen({
          room_id: (args as any).room_id,
          task_id: (args as any).task_id,
          wait_seconds: (args as any).wait_seconds,
          cursor: (args as any).cursor,
          caller_name: 'mcp_model',
        });
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      }

      if (name === 'check_inbox') {
        const res = engine.checkInbox({
          status: (args as any).status,
          limit: (args as any).limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      }

      if (name === 'cancel') {
        const res = engine.cancel({
          task_id: (args as any).task_id,
        });
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      }

      throw new Error(`Unknown tool: ${name}`);
    });

    return server;
  }

  return {
    router,
    setupMcpServer,
  };
}
