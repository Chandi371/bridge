import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Hono } from 'hono';
import { BridgeEngine } from './engine.js';

export function createMcpRouter(options: {
  engine: BridgeEngine;
  publicBaseUrl: string | (() => string);
  isTokenAuthorized: (token: string) => boolean;
}) {
  const router = new Hono();
  const sessions = new Map<string, { server: Server; transport: SSEServerTransport; createdAt: number }>();

  const getBase = () => {
    const raw = typeof options.publicBaseUrl === 'function' ? options.publicBaseUrl() : options.publicBaseUrl;
    return raw.replace(/\/+$/, '');
  };

  // Token Auth Middleware for /mcp and /mcp/*
  router.use('/mcp', async (c, next) => {
    return handleAuth(c, next);
  });
  router.use('/mcp/*', async (c, next) => {
    return handleAuth(c, next);
  });

  async function handleAuth(c: any, next: any) {
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token || !options.isTokenAuthorized(token)) {
      const base = getBase();
      const metadataUrl = `${base}/.well-known/oauth-protected-resource`;
      c.header('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
      return c.json({ error: 'Unauthorized MCP access' }, 401);
    }
    await next();
  }

  // GET /mcp: Establishes SSE stream or reports streamable HTTP endpoint status
  router.get('/mcp', async (c) => {
    const accept = c.req.header('Accept') || '';
    if (accept.includes('text/event-stream')) {
      const sessionId = `mcp_sess_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
      const base = getBase();
      const sseContent = `event: endpoint\ndata: ${base}/mcp/messages?sessionId=${sessionId}\n\n`;
      return new Response(sseContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'mcp-session-id': sessionId,
        },
      });
    }

    const base = getBase();
    return c.json({
      status: 'ready',
      transport: 'Streamable HTTP / SSE',
      endpoint: `${base}/mcp`,
      messages_endpoint: `${base}/mcp/messages`,
    });
  });

  // POST /mcp/messages: Streamable HTTP message handling
  router.post('/mcp/messages', async (c) => {
    try {
      const body = await c.req.json();
      const mcpServer = setupMcpServer(options.engine);

      // Handle JSON-RPC method
      if (body.method === 'tools/list') {
        const handler = (mcpServer as any)._requestHandlers.get('tools/list');
        const res = await handler(body);
        return c.json({ jsonrpc: '2.0', id: body.id, result: res });
      }

      if (body.method === 'tools/call') {
        const handler = (mcpServer as any)._requestHandlers.get('tools/call');
        const res = await handler(body);
        return c.json({ jsonrpc: '2.0', id: body.id, result: res });
      }

      return c.json({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32601, message: `Method not found: ${body.method}` },
      });
    } catch (e: any) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32603, message: e.message },
      }, 500);
    }
  });

  // DELETE /mcp: Session termination
  router.delete('/mcp', (c) => {
    const sessionId = c.req.header('mcp-session-id') || c.req.query('sessionId');
    if (sessionId) {
      sessions.delete(sessionId);
    }
    return c.json({ status: 'session_terminated' });
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
            description: 'Call this first. Returns registered agents with capability tags, duration expectations, and online status.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'send',
            description: "Dispatches a message/task to an agent or participant. Waits up to wait_seconds (max 28s). If status is 'running', call listen with task_id until done; do not answer the user before then.",
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
            description: "Waits up to wait_seconds (max 28s) for task results, progress, or incoming messages. If status is 'running', call listen with task_id until done; do not answer the user before then.",
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
