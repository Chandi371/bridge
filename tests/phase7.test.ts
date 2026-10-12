import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { createViewsAndPasteRouter } from '../src/views.js';
import { createDashboardRouter } from '../src/dashboard.js';
import { ExternalAgentRunner } from '../src/agent_runners.js';

describe('Phase 7: Dashboard, /paste, /room/:id/view, and External Runners', () => {
  let db: BridgeDatabase;
  let engine: BridgeEngine;
  let viewsRouter: ReturnType<typeof createViewsAndPasteRouter>;
  let dashRouter: ReturnType<typeof createDashboardRouter>;

  beforeEach(() => {
    db = new BridgeDatabase(':memory:');
    engine = new BridgeEngine(db);
    viewsRouter = createViewsAndPasteRouter(engine, 'secret-api-key');
    dashRouter = createDashboardRouter(engine, 'http://localhost:3000');
  });

  it('rejects unauthenticated access to /paste with 401 and serves page on valid key', async () => {
    // Unauthenticated
    const unauth = await viewsRouter.fetch(new Request('http://localhost:3000/paste'));
    expect(unauth.status).toBe(401);

    // Authenticated via query key
    const res = await viewsRouter.fetch(new Request('http://localhost:3000/paste?key=secret-api-key'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Bridge Copy-Paste Fallback');
    expect(html).toContain('```bridge');
    expect(html).toContain('Copy Response');
  });

  it('serves /room/:id/view plain text with unguessable key check', async () => {
    const room = db.getOrCreateRoom('room-secret-view', 'Secret Project');
    db.addMessage({
      room_id: room.id,
      sender: 'Alice',
      recipient: 'Bob',
      type: 'message',
      content: 'Classified plan details',
    });

    const expectedKey = engine.hashToken(room.id).slice(0, 16);

    // 403 on invalid key
    const denied = await viewsRouter.fetch(new Request(`http://localhost:3000/room/${room.id}/view?key=wrong`));
    expect(denied.status).toBe(403);

    // 200 with plain readable text on valid key
    const granted = await viewsRouter.fetch(new Request(`http://localhost:3000/room/${room.id}/view?key=${expectedKey}`));
    expect(granted.status).toBe(200);
    const text = await granted.text();
    expect(text).toContain('=== ROOM STATE: Secret Project');
    expect(text).toContain('Alice -> Bob (message):');
    expect(text).toContain('Classified plan details');
  });

  it('serves local admin dashboard at /admin', async () => {
    const res = await dashRouter.fetch(new Request('http://127.0.0.1:3001/admin'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Bridge Local Admin Dashboard');
    expect(html).toContain('Registered Agents & Kill Switch');
    expect(html).toContain('Claude & ChatGPT Connector Settings');
  });
});
