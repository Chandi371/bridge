import { Hono } from 'hono';
import { BridgeEngine } from './engine.js';
import { createRestRouter } from './rest_adapter.js';

export interface PublicServerOptions {
  engine: BridgeEngine;
  apiKey?: string;
  publicBaseUrl?: string | (() => string);
  rateLimitPerMin?: number;
  maxPromptSizeBytes?: number;
}

export function createPublicApp(options: PublicServerOptions) {
  const app = new Hono();
  const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
  const limitPerMin = options.rateLimitPerMin ?? 60;
  const maxBytes = options.maxPromptSizeBytes ?? 65536;

  // Rate Limiter Middleware
  app.use('*', async (c, next) => {
    const ip = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'unknown-client';
    const now = Date.now();
    let record = rateLimitMap.get(ip);
    if (!record || now > record.resetAt) {
      record = { count: 1, resetAt: now + 60000 };
      rateLimitMap.set(ip, record);
    } else {
      record.count++;
      if (record.count > limitPerMin) {
        const secondsToWait = Math.ceil((record.resetAt - now) / 1000);
        return c.json({
          error: 'Too many requests. Rate limit exceeded.',
          retry_after_seconds: secondsToWait,
          next_step: `Rate limit exceeded. Please wait ${secondsToWait} seconds before calling this tool again.`,
        }, 429);
      }
    }
    await next();
  });

  // Body Size Enforcement
  app.use('*', async (c, next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return c.json({ error: `Payload too large. Maximum size is ${maxBytes} bytes.` }, 413);
    }
    await next();
  });

  // REST API and OpenAPI (servers[].url set to publicBaseUrl)
  const restRouter = createRestRouter(options.engine, options.apiKey, options.publicBaseUrl);
  app.route('/', restRouter);

  // Health check for tunnel and launcher
  app.get('/health', (c) => {
    return c.json({ status: 'ok', time: Date.now() });
  });

  return app;
}

export function createLocalApp(options: { engine: BridgeEngine; adminPassword?: string }) {
  const app = new Hono();

  // Admin authentication middleware
  app.use('/admin/*', async (c, next) => {
    if (!options.adminPassword) return next();
    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${options.adminPassword}`) {
      return c.json({ error: 'Unauthorized admin access.' }, 401);
    }
    await next();
  });

  // Local Admin API
  app.get('/admin/overview', (c) => {
    const agents = options.engine.listAgents();
    const rooms = options.engine.db.db.prepare('SELECT * FROM rooms ORDER BY updated_at DESC LIMIT 20').all();
    const tasks = options.engine.db.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 20').all();
    const approvals = options.engine.db.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").all();

    return c.json({
      agents,
      rooms,
      tasks,
      approvals,
    });
  });

  // Admin approval action
  app.post('/admin/approval', async (c) => {
    const body = await c.req.json();
    const { approval_id, decision } = body; // 'approved' | 'rejected'
    options.engine.db.db.prepare('UPDATE approvals SET status = ? WHERE id = ?').run(decision, approval_id);
    return c.json({ success: true, approval_id, decision });
  });

  return app;
}
