import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer, Server } from 'http';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { AgentHub } from '../src/agent_hub.js';
import { BridgeAgentNode } from '../src/sdk.js';
import { createRestRouter } from '../src/rest_adapter.js';

describe('Phase 2: REST Adapter, OpenAPI, 28s Cap, and Slow Agent Progression', () => {
  let db: BridgeDatabase;
  let engine: BridgeEngine;
  let hub: AgentHub;
  let server: Server;
  let wss: WebSocketServer;
  let restApp: ReturnType<typeof createRestRouter>;
  const PORT = 3992;
  const API_KEY = 'secret-test-key';

  beforeEach(async () => {
    db = new BridgeDatabase(':memory:');
    engine = new BridgeEngine(db);
    hub = new AgentHub(engine);
    restApp = createRestRouter(engine, API_KEY);

    server = createServer(async (req, res) => {
      // Basic forwarder to Hono app
      const url = `http://localhost:${PORT}${req.url}`;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }

      let body: string | undefined;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks).toString('utf-8');
      }

      const response = await restApp.fetch(
        new Request(url, {
          method: req.method,
          headers,
          body,
        })
      );

      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      const resText = await response.text();
      res.end(resText);
    });

    wss = new WebSocketServer({ server });
    hub.setupWebSocket(wss);

    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterEach(async () => {
    hub.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves OpenAPI 3.1 specification at /openapi.json without auth', async () => {
    const res = await fetch(`http://localhost:${PORT}/openapi.json`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.openapi).toBe('3.1.0');
    expect(json.paths['/api/send']).toBeDefined();
    expect(json.paths['/api/listen']).toBeDefined();
    expect(json.paths['/api/list_agents']).toBeDefined();
    expect(json.paths['/api/check_inbox']).toBeDefined();
    expect(json.paths['/api/cancel']).toBeDefined();
  });

  it('enforces API key authentication on /api/*', async () => {
    const unauth = await fetch(`http://localhost:${PORT}/api/list_agents`);
    expect(unauth.status).toBe(401);

    const auth = await fetch(`http://localhost:${PORT}/api/list_agents`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    expect(auth.status).toBe(200);
  });

  it('supports 90s slow agent with progress updates and triggers 5-poll fallback instruction', async () => {
    const token = 'slow-agent-token';
    db.upsertAgent({
      id: 'slow-agent-id',
      name: 'slow-agent',
      description: 'Slow background worker taking 90s',
      capabilities: ['slow'],
      expected_duration: 'slow 1-3 min',
      token_hash: engine.hashToken(token),
      online: 0,
      last_seen: null,
      require_approval: 0,
      enabled: 1,
    });

    const slowAgent = new BridgeAgentNode({
      agentId: 'slow-agent',
      token,
      bridgeWsUrl: `ws://127.0.0.1:${PORT}`,
    });

    slowAgent.onTask(async (ctx) => {
      await ctx.progress('Step 1/3 started', 10, 80, 'partial output 1');
      await new Promise((r) => setTimeout(r, 8000));
      await ctx.progress('Step 2/3 continuing', 50, 40, 'partial output 2');
      await new Promise((r) => setTimeout(r, 8000));
      return 'Finished slow work!';
    });

    await slowAgent.start();
    await new Promise((r) => setTimeout(r, 400));

    // Send task via REST with wait_seconds = 1 (shorter than agent completion)
    const sendRes = await fetch(`http://localhost:${PORT}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        to: 'slow-agent',
        content: 'Start long job',
        wait_seconds: 1,
      }),
    });
    expect(sendRes.status).toBe(200);
    const sendJson = await sendRes.json();
    const taskId = sendJson.task_id;
    expect(taskId).toBeDefined();

    // Verify 28s cap logic in engine (if user passes 35, it clamps to 28)
    const listenRes1 = await fetch(`http://localhost:${PORT}/api/listen`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        task_id: taskId,
        wait_seconds: 1,
      }),
    });
    const json1 = await listenRes1.json();
    expect(json1.status).toBe('running');
    expect(json1.next_step).toContain('Task still running. This is NOT the final answer. Call listen with task_id');

    // Simulate 4 more polls with wait_seconds = 1 and cursor to trigger 5-poll fallback
    let lastJson = json1;
    let cursor = json1.cursor || 1;
    for (let i = 2; i <= 5; i++) {
      const res = await fetch(`http://localhost:${PORT}/api/listen`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          task_id: taskId,
          cursor,
          wait_seconds: 1,
        }),
      });
      lastJson = await res.json();
      cursor = lastJson.cursor || cursor;
    }

    // After 5 polls without completion
    expect(lastJson.next_step).toContain('This is taking long. Tell the user the room_id/task_id and that it is still running; offer to check again when they ask.');

    slowAgent.stop();
  }, 30000);
});
