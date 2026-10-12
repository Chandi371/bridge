import crypto from 'crypto';
import { Hono } from 'hono';

export interface OAuthClient {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
  client_name?: string;
}

export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge?: string;
  code_challenge_method?: string;
  expires_at: number;
}

export function createOAuthRouter(options: {
  publicBaseUrl: string;
  adminPassword?: string;
}) {
  const router = new Hono();
  const clients = new Map<string, OAuthClient>();
  const authCodes = new Map<string, AuthCode>();
  const accessTokens = new Set<string>();

  // Helper: verify PKCE S256 or plain
  function verifyPkce(verifier: string, challenge: string, method = 'S256'): boolean {
    if (method === 'plain') return verifier === challenge;
    const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
    return computed === challenge;
  }

  // 1. Well-known OAuth Authorization Server Metadata (RFC 8414)
  router.get('/.well-known/oauth-authorization-server', (c) => {
    const base = options.publicBaseUrl.replace(/\/+$/, '');
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    });
  });

  // 2. Dynamic Client Registration (RFC 7591)
  router.post('/oauth/register', async (c) => {
    try {
      const body = await c.req.json();
      const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const clientSecret = crypto.randomBytes(16).toString('hex');
      const client: OAuthClient = {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: body.redirect_uris || [],
        client_name: body.client_name || 'Claude / Custom Client',
      };
      clients.set(clientId, client);

      return c.json({
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uris: client.redirect_uris,
        client_name: client.client_name,
      }, 201);
    } catch (e: any) {
      return c.json({ error: 'invalid_request', error_description: e.message }, 400);
    }
  });

  // 3. Authorization Endpoint
  router.get('/oauth/authorize', (c) => {
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const state = c.req.query('state') || '';
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method') || 'S256';

    if (!clientId || !redirectUri) {
      return c.text('Missing client_id or redirect_uri', 400);
    }

    // Minimal single-user approval / login screen
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bridge Authorization</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; background: #0f172a; color: #f8fafc; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
          .card { background: #1e293b; padding: 2rem; border-radius: 8px; width: 100%; max-width: 400px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
          h2 { margin-top: 0; color: #38bdf8; }
          input { width: 100%; padding: 0.75rem; margin: 1rem 0; border: 1px solid #334155; border-radius: 4px; background: #0f172a; color: white; box-sizing: border-box; }
          button { width: 100%; padding: 0.75rem; background: #0284c7; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; }
          button:hover { background: #0369a1; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>Authorize Claude / Client</h2>
          <p>Authorize access to your local agents via Bridge.</p>
          <form method="POST" action="/oauth/authorize">
            <input type="hidden" name="client_id" value="${clientId}">
            <input type="hidden" name="redirect_uri" value="${redirectUri}">
            <input type="hidden" name="state" value="${state}">
            <input type="hidden" name="code_challenge" value="${codeChallenge || ''}">
            <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
            <label>Master Password:</label>
            <input type="password" name="password" placeholder="Enter password..." required autofocus>
            <button type="submit">Approve Connection</button>
          </form>
        </div>
      </body>
      </html>
    `;
    return c.html(html);
  });

  router.post('/oauth/authorize', async (c) => {
    const body = await c.req.parseBody();
    const clientId = body.client_id as string;
    const redirectUri = body.redirect_uri as string;
    const state = body.state as string;
    const codeChallenge = body.code_challenge as string;
    const codeChallengeMethod = (body.code_challenge_method as string) || 'S256';
    const password = body.password as string;

    if (options.adminPassword && password !== options.adminPassword) {
      return c.text('Invalid Master Password', 403);
    }

    const code = `code_${crypto.randomBytes(16).toString('hex')}`;
    authCodes.set(code, {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      expires_at: Date.now() + 300000, // 5 min
    });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);

    return c.redirect(target.toString(), 302);
  });

  // 4. Token Endpoint
  router.post('/oauth/token', async (c) => {
    try {
      const body = await c.req.parseBody();
      const grantType = body.grant_type;
      const code = body.code as string;
      const redirectUri = body.redirect_uri as string;
      const clientId = body.client_id as string;
      const codeVerifier = body.code_verifier as string;

      if (grantType !== 'authorization_code') {
        return c.json({ error: 'unsupported_grant_type' }, 400);
      }

      const authCode = authCodes.get(code);
      if (!authCode || Date.now() > authCode.expires_at) {
        return c.json({ error: 'invalid_grant', error_description: 'Code expired or invalid' }, 400);
      }

      if (authCode.code_challenge) {
        if (!codeVerifier || !verifyPkce(codeVerifier, authCode.code_challenge, authCode.code_challenge_method)) {
          return c.json({ error: 'invalid_grant', error_description: 'PKCE challenge verification failed' }, 400);
        }
      }

      authCodes.delete(code);
      const token = `mcp_token_${crypto.randomBytes(24).toString('hex')}`;
      accessTokens.add(token);

      return c.json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 86400 * 30, // 30 days
      });
    } catch (e: any) {
      return c.json({ error: 'invalid_request', error_description: e.message }, 400);
    }
  });

  return {
    router,
    isTokenValid: (token: string) => accessTokens.has(token),
  };
}
