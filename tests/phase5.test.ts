import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { BridgeServer } from '../src/server.js';

describe('Phase 5: Launcher, Dual Listeners, and Healthcheck Integration', () => {
  let server: BridgeServer;
  const PUBLIC_PORT = 3996;
  const LOCAL_PORT = 3997;
  const API_KEY = 'phase5-test-key';

  beforeEach(async () => {
    server = new BridgeServer({
      publicPort: PUBLIC_PORT,
      localPort: LOCAL_PORT,
      publicBaseUrl: `http://localhost:${PUBLIC_PORT}`,
      apiKey: API_KEY,
      dbPath: ':memory:',
    });

    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('launcher starts both listeners and public health check answers successfully', async () => {
    // 1. Check Public Listener health check
    const healthRes = await fetch(`http://localhost:${PUBLIC_PORT}/health`);
    expect(healthRes.status).toBe(200);
    const healthJson = await healthRes.json();
    expect(healthJson.status).toBe('ok');

    // 2. Check OpenAPI specification endpoint on public listener
    const openApiRes = await fetch(`http://localhost:${PUBLIC_PORT}/openapi.json`);
    expect(openApiRes.status).toBe(200);

    // 3. Check Local Listener admin overview
    const localRes = await fetch(`http://127.0.0.1:${LOCAL_PORT}/admin/overview`);
    expect(localRes.status).toBe(200);
    const overview = await localRes.json();
    expect(overview.agents).toBeDefined();

    // 4. Verify Route Isolation: Admin is NOT accessible on public port
    const publicAdminRes = await fetch(`http://localhost:${PUBLIC_PORT}/admin/overview`);
    expect(publicAdminRes.status).toBe(404);
  });
});
