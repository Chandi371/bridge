import { Hono } from 'hono';
import { BridgeEngine } from './engine.js';
import { openApiSpec } from './openapi.js';

export function createRestRouter(
  engine: BridgeEngine,
  apiKey?: string,
  publicBaseUrl?: string | (() => string)
) {
  const app = new Hono();

  // Auth middleware for /api/* (Accepts BOTH Authorization: Bearer <key> AND X-API-Key)
  app.use('/api/*', async (c, next) => {
    if (!apiKey) {
      return next();
    }
    const authHeader = c.req.header('Authorization');
    const xApiKey = c.req.header('X-API-Key');
    const token = authHeader?.replace(/^Bearer\s+/i, '') || xApiKey;

    if (!token || token !== apiKey) {
      return c.json({ error: 'Unauthorized. Invalid or missing API key.' }, 401);
    }
    await next();
  });

  // OpenAPI spec with servers[].url updated to the public URL
  app.get('/openapi.json', (c) => {
    const base = typeof publicBaseUrl === 'function' ? publicBaseUrl() : publicBaseUrl || 'http://localhost:3000';
    const spec = {
      ...openApiSpec,
      servers: [
        {
          url: base.replace(/\/+$/, ''),
          description: 'Bridge Public Server',
        },
      ],
    };
    return c.json(spec);
  });

  // 1. list_agents
  app.get('/api/list_agents', (c) => {
    try {
      const agents = engine.listAgents();
      return c.json(agents);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 2. send
  app.post('/api/send', async (c) => {
    try {
      const body = await c.req.json();
      const res = await engine.send({
        to: body.to,
        content: body.content,
        room_id: body.room_id,
        reply_to: body.reply_to,
        client_request_id: body.client_request_id,
        wait_seconds: body.wait_seconds,
        sender_name: 'chat_model',
        sender_kind: 'model',
      });
      return c.json(res);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // 3. listen
  app.post('/api/listen', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const res = await engine.listen({
        room_id: body.room_id,
        task_id: body.task_id,
        wait_seconds: body.wait_seconds,
        cursor: body.cursor,
        caller_name: 'chat_model',
      });
      return c.json(res);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  // 4. check_inbox
  app.get('/api/check_inbox', (c) => {
    try {
      const status = c.req.query('status');
      const limitStr = c.req.query('limit');
      const limit = limitStr ? parseInt(limitStr, 10) : 5;
      const res = engine.checkInbox({ status, limit });
      return c.json(res);
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // 5. cancel
  app.post('/api/cancel', async (c) => {
    try {
      const body = await c.req.json();
      if (!body.task_id) {
        return c.json({ error: 'task_id is required' }, 400);
      }
      const res = engine.cancel({ task_id: body.task_id });
      return c.json(res);
    } catch (e: any) {
      return c.json({ error: e.message }, 400);
    }
  });

  return app;
}
