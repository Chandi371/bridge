import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { createOAuthRouter } from '../src/oauth.js';
import { createMcpRouter } from '../src/mcp_adapter.js';

describe('Phase 6: MCP Adapter & OAuth 2.1 with PKCE & RFC Metadata', () => {
  let db: BridgeDatabase;
  let engine: BridgeEngine;
  let oauth: ReturnType<typeof createOAuthRouter>;
  let mcp: ReturnType<typeof createMcpRouter>;
  const BASE_URL = 'https://bridge.example.com';
  const ADMIN_PASS = 'mcp-secret-pass';

  beforeEach(() => {
    db = new BridgeDatabase(':memory:');
    engine = new BridgeEngine(db);
    oauth = createOAuthRouter({ publicBaseUrl: BASE_URL, adminPassword: ADMIN_PASS });
    mcp = createMcpRouter({
      engine,
      isTokenAuthorized: (t) => oauth.isTokenValid(t) || t === 'static-bearer-key',
    });
  });

  it('serves RFC 8414 OAuth authorization server metadata at /.well-known/oauth-authorization-server', async () => {
    const res = await oauth.router.fetch(new Request(`${BASE_URL}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.issuer).toBe(BASE_URL);
    expect(meta.authorization_endpoint).toBe(`${BASE_URL}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${BASE_URL}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${BASE_URL}/oauth/register`);
    expect(meta.code_challenge_methods_supported).toContain('S256');
  });

  it('supports RFC 7591 dynamic client registration', async () => {
    const regRes = await oauth.router.fetch(
      new Request(`${BASE_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude Test Client',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        }),
      })
    );
    expect(regRes.status).toBe(201);
    const reg = await regRes.json();
    expect(reg.client_id).toBeDefined();
    expect(reg.redirect_uris).toContain('https://claude.ai/api/mcp/auth_callback');
  });

  it('completes full PKCE authorization code exchange and authorizes MCP access', async () => {
    // 1. Generate PKCE code_verifier and code_challenge (S256)
    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // 2. Client submits approval POST with Master Password
    const authFormData = new URLSearchParams({
      client_id: 'client_123',
      redirect_uri: 'https://claude.ai/callback',
      state: 'xyzState',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      password: ADMIN_PASS,
    });

    const approveRes = await oauth.router.fetch(
      new Request(`${BASE_URL}/oauth/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: authFormData.toString(),
      })
    );

    expect(approveRes.status).toBe(302);
    const location = approveRes.headers.get('location')!;
    const locUrl = new URL(location);
    const code = locUrl.searchParams.get('code')!;
    expect(code).toBeDefined();
    expect(locUrl.searchParams.get('state')).toBe('xyzState');

    // 3. Exchange code for access_token with code_verifier
    const tokenFormData = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://claude.ai/callback',
      client_id: 'client_123',
      code_verifier: codeVerifier,
    });

    const tokenRes = await oauth.router.fetch(
      new Request(`${BASE_URL}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenFormData.toString(),
      })
    );

    expect(tokenRes.status).toBe(200);
    const tokenJson = await tokenRes.json();
    expect(tokenJson.access_token).toBeDefined();
    const token = tokenJson.access_token;

    // Verify token validity
    expect(oauth.isTokenValid(token)).toBe(true);
  });

  it('MCP server exposes exactly 5 tools matching engine semantics', async () => {
    const mcpServer = mcp.setupMcpServer(engine);
    // Directly test tools list
    const toolListHandler = (mcpServer as any)._requestHandlers.get('tools/list');
    const toolsResult = await toolListHandler({ method: 'tools/list', params: {} });
    expect(toolsResult.tools.length).toBe(5);
    const names = toolsResult.tools.map((t: any) => t.name);
    expect(names).toEqual(['list_agents', 'send', 'listen', 'check_inbox', 'cancel']);
  });
});
