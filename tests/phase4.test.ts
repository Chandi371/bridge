import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer, Server } from 'http';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { AgentHub } from '../src/agent_hub.js';
import { createPublicApp, createLocalApp } from '../src/server_apps.js';

import { serve } from '@hono/node-server';

describe('Phase 4: Two-Listener Split, Route Isolation, Rate Limits, and Approval', () => {
  let db: BridgeDatabase;
  let engine: BridgeEngine;
  let hub: AgentHub;
  let publicServer: any;
  let localServer: any;
  let localWss: WebSocketServer;

  const PUBLIC_PORT = 3994;
  const LOCAL_PORT = 3995;
  const API_KEY = 'public-model-key';
  const ADMIN_PASS = 'local-admin-pass';

  beforeEach(async () => {
    db = new BridgeDatabase(':memory:');
    engine = new BridgeEngine(db);
    hub = new AgentHub(engine);

    // Setup Public Listener
    const publicApp = createPublicApp({
      engine,
      apiKey: API_KEY,
      rateLimitPerMin: 5,
      maxPromptSizeBytes: 1024,
    });

    publicServer = serve({
      fetch: publicApp.fetch,
      port: PUBLIC_PORT,
    });

    // Setup Local Listener bound only to 127.0.0.1
    const localApp = createLocalApp({
      engine,
      adminPassword: ADMIN_PASS,
    });

    localServer = serve({
      fetch: localApp.fetch,
      port: LOCAL_PORT,
      hostname: '127.0.0.1',
    });

    localWss = new WebSocketServer({ server: localServer, path: '/agent/ws' });
    hub.setupWebSocket(localWss);

    await new Promise((r) => setTimeout(r, 200));
  });

  afterEach(async () => {
    hub.stop();
    await new Promise<void>((resolve) => publicServer.close(() => resolve()));
    await new Promise<void>((resolve) => localServer.close(() => resolve()));
  });

  it('guarantees /admin is unreachable via the public port (returns 404)', async () => {
    const publicAdminRes = await fetch(`http://localhost:${PUBLIC_PORT}/admin/overview`, {
      headers: { Authorization: `Bearer ${ADMIN_PASS}` },
    });
    // Public router has no /admin routes at all!
    expect(publicAdminRes.status).toBe(404);

    // But local port can reach it
    const localAdminRes = await fetch(`http://127.0.0.1:${LOCAL_PORT}/admin/overview`, {
      headers: { Authorization: `Bearer ${ADMIN_PASS}` },
    });
    expect(localAdminRes.status).toBe(200);
  });

  it('guarantees /agent/ws is not exposed on public port', async () => {
    // Attempting HTTP or WS to /agent/ws on public port
    const res = await fetch(`http://localhost:${PUBLIC_PORT}/agent/ws`, {
      headers: { 'x-forwarded-for': 'ws-probe' },
    });
    expect(res.status).toBe(404);
  });

  it('enforces rate limits per client on public port', async () => {
    // 5 allowed requests per minute
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`http://localhost:${PUBLIC_PORT}/health`, {
        headers: { 'x-forwarded-for': 'rate-limit-client' },
      });
      expect(res.status).toBe(200);
    }
    // 6th request triggers 429
    const blockedRes = await fetch(`http://localhost:${PUBLIC_PORT}/health`, {
      headers: { 'x-forwarded-for': 'rate-limit-client' },
    });
    expect(blockedRes.status).toBe(429);
  });

  it('enforces maximum payload size on public port', async () => {
    const hugeBody = JSON.stringify({ to: 'agent', content: 'A'.repeat(2000) });
    const res = await fetch(`http://localhost:${PUBLIC_PORT}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
        'x-forwarded-for': 'payload-test-client',
      },
      body: hugeBody,
    });
    expect(res.status).toBe(413);
  });

  it('supports require_approval flow holding task until admin approves', async () => {
    db.upsertAgent({
      id: 'sensitive-agent',
      name: 'sensitive',
      description: 'Agent requiring admin approval',
      capabilities: ['sensitive'],
      expected_duration: 'fast <10s',
      token_hash: 'hash',
      online: 1,
      last_seen: Date.now(),
      require_approval: 1, // sensitive flag!
      enabled: 1,
    });

    const sendRes = await fetch(`http://localhost:${PUBLIC_PORT}/api/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        to: 'sensitive',
        content: 'Perform high-stakes action',
      }),
    });

    const json = await sendRes.json();
    expect(json.status).toBe('approval_required');
    expect(json.next_step).toContain('held for human approval in the dashboard');

    // Check approval on local admin endpoint
    const overviewRes = await fetch(`http://127.0.0.1:${LOCAL_PORT}/admin/overview`, {
      headers: { Authorization: `Bearer ${ADMIN_PASS}` },
    });
    const overview = await overviewRes.json();
    expect(overview.approvals.length).toBe(1);
    expect(overview.approvals[0].status).toBe('pending');
  });
});
