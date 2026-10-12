import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { createOAuthRouter } from '../src/oauth.js';
import { createMcpRouter } from '../src/mcp_adapter.js';

describe('Phase 6: MCP Adapter & OAuth 2.1 with PKCE, RFC 9728, RFC 8414, Streamable HTTP', () => {
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
      publicBaseUrl: BASE_URL,
      isTokenAuthorized: (t) => oauth.isTokenValid(t) || t === 'static-bearer-key',
    });
  });

  it('unauthenticated request to /mcp returns 401 with WWW-Authenticate pointing to protected-resource metadata', async () => {
    const res = await mcp.router.fetch(new Request(`${BASE_URL}/mcp`));
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('WWW-Authenticate');
    expect(wwwAuth).toBeDefined();
    expect(wwwAuth).toContain(`resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`);
  });

  it('serves RFC 9728 OAuth Protected Resource Metadata at /.well-known/oauth-protected-resource', async () => {
    const res = await oauth.router.fetch(new Request(`${BASE_URL}/.well-known/oauth-protected-resource`));
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.resource).toBe(`${BASE_URL}/mcp`);
    expect(meta.authorization_servers).toEqual([BASE_URL]);
  });

  it('serves RFC 8414 OAuth authorization server metadata at /.well-known/oauth-authorization-server using PUBLIC_BASE_URL', async () => {
    const res = await oauth.router.fetch(new Request(`${BASE_URL}/.well-known/oauth-authorization-server`));
    expect(res.status).toBe(200);
    const meta = await res.json();
    expect(meta.issuer).toBe(BASE_URL);
    expect(meta.authorization_endpoint).toBe(`${BASE_URL}/oauth/authorize`);
    expect(meta.token_endpoint).toBe(`${BASE_URL}/oauth/token`);
    expect(meta.registration_endpoint).toBe(`${BASE_URL}/oauth/register`);
    expect(meta.revocation_endpoint).toBe(`${BASE_URL}/oauth/revoke`);
    expect(meta.grant_types_supported).toContain('refresh_token');
  });

  it('validates redirect URIs against documented Claude and ChatGPT allow-list patterns', async () => {
    // Valid Claude URI
    const validClaude = await oauth.router.fetch(
      new Request(`${BASE_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Claude Test Client',
          redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        }),
      })
    );
    expect(validClaude.status).toBe(201);

    // Disallowed untrusted URI
    const invalidUri = await oauth.router.fetch(
      new Request(`${BASE_URL}/oauth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Attacker Client',
          redirect_uris: ['https://malicious-site.com/steal_token'],
        }),
      })
    );
    expect(invalidUri.status).toBe(400);
    const err = await invalidUri.json();
    expect(err.error).toBe('invalid_redirect_uri');
  });

  it('completes PKCE exchange, refreshes token, and revokes token', async () => {
    const codeVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // 1. Authorize POST
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
    const loc = new URL(approveRes.headers.get('location')!);
    const code = loc.searchParams.get('code')!;

    // 2. Token Exchange
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
    const accessToken = tokenJson.access_token;
    const refreshToken = tokenJson.refresh_token;
    expect(accessToken).toBeDefined();
    expect(refreshToken).toBeDefined();
    expect(oauth.isTokenValid(accessToken)).toBe(true);

    // 3. Refresh Token Exchange
    const refreshFormData = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const refreshRes = await oauth.router.fetch(
      new Request(`${BASE_URL}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshFormData.toString(),
      })
    );
    expect(refreshRes.status).toBe(200);
    const refreshedJson = await refreshRes.json();
    const newAccessToken = refreshedJson.access_token;
    expect(newAccessToken).toBeDefined();
    expect(oauth.isTokenValid(newAccessToken)).toBe(true);

    // 4. Token Revocation
    const revokeFormData = new URLSearchParams({
      token: newAccessToken,
    });
    const revokeRes = await oauth.router.fetch(
      new Request(`${BASE_URL}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: revokeFormData.toString(),
      })
    );
    expect(revokeRes.status).toBe(200);
    expect(oauth.isTokenValid(newAccessToken)).toBe(false);
  });

  it('supports Streamable HTTP transport methods: GET, POST /mcp/messages, DELETE', async () => {
    // GET SSE initiation
    const sseRes = await mcp.router.fetch(
      new Request(`${BASE_URL}/mcp`, {
        headers: {
          Authorization: 'Bearer static-bearer-key',
          Accept: 'text/event-stream',
        },
      })
    );
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('Content-Type')).toContain('text/event-stream');
    const sseBody = await sseRes.text();
    expect(sseBody).toContain('event: endpoint');

    // POST /mcp/messages JSON-RPC tools/list
    const msgRes = await mcp.router.fetch(
      new Request(`${BASE_URL}/mcp/messages`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer static-bearer-key',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      })
    );
    expect(msgRes.status).toBe(200);
    const rpcJson = await msgRes.json();
    expect(rpcJson.result.tools.length).toBe(5);

    // DELETE session termination
    const delRes = await mcp.router.fetch(
      new Request(`${BASE_URL}/mcp?sessionId=test-sess`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer static-bearer-key' },
      })
    );
    expect(delRes.status).toBe(200);
  });
});
