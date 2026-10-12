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
  code_challenge: string;
  code_challenge_method: string;
  expires_at: number;
}

export interface TokenRecord {
  token: string;
  client_id: string;
  expires_at: number;
}

export interface RefreshTokenRecord {
  refresh_token: string;
  client_id: string;
  expires_at: number;
}

// Officially documented OAuth callback patterns for Claude and ChatGPT:
// Claude AI MCP custom connectors: https://claude.ai/api/mcp/auth_callback, https://claude.ai/oauth/callback
// ChatGPT Custom Actions & MCP: https://chat.openai.com/aip/plugin-*/oauth/callback, https://chatgpt.com/aip/*/oauth/callback
export const DOCUMENTED_REDIRECT_URI_PATTERNS = [
  /^https:\/\/(?:[a-zA-Z0-9-]+\.)?claude\.ai\/.*/,
  /^https:\/\/(?:[a-zA-Z0-9-]+\.)?anthropic\.com\/.*/,
  /^https:\/\/(?:[a-zA-Z0-9-]+\.)?openai\.com\/.*/,
  /^https:\/\/(?:[a-zA-Z0-9-]+\.)?chatgpt\.com\/.*/,
  /^http:\/\/localhost(?::\d+)?\/.*/,
  /^http:\/\/127\.0\.0\.1(?::\d+)?\/.*/,
];

export function isRedirectUriAllowed(uri: string): boolean {
  return DOCUMENTED_REDIRECT_URI_PATTERNS.some((pattern) => pattern.test(uri));
}

export function createOAuthRouter(options: {
  publicBaseUrl: string | (() => string);
  adminPassword?: string;
}) {
  const router = new Hono();
  const clients = new Map<string, OAuthClient>();
  const authCodes = new Map<string, AuthCode>();
  const accessTokens = new Map<string, TokenRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();

  // Login attempt tracking & lockout (max 5 failed attempts -> 15 min lockout)
  const loginAttempts = new Map<string, { attempts: number; lockoutUntil: number }>();

  function getBaseUrl(): string {
    const raw = typeof options.publicBaseUrl === 'function' ? options.publicBaseUrl() : options.publicBaseUrl;
    return raw.replace(/\/+$/, '');
  }

  function verifyPkceS256(verifier: string, challenge: string): boolean {
    const computed = crypto.createHash('sha256').update(verifier).digest('base64url');
    return computed === challenge;
  }

  // RFC 9728: OAuth 2.0 Protected Resource Metadata
  router.get('/.well-known/oauth-protected-resource', (c) => {
    const base = getBaseUrl();
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['tools', 'mcp'],
      bearer_methods_supported: ['header'],
    });
  });

  // RFC 8414: OAuth 2.0 Authorization Server Metadata (S256 only)
  router.get('/.well-known/oauth-authorization-server', (c) => {
    const base = getBaseUrl();
    return c.json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    });
  });

  // RFC 7591: Dynamic Client Registration
  router.post('/oauth/register', async (c) => {
    try {
      const body = await c.req.json();
      const redirectUris: string[] = body.redirect_uris || [];

      // Validate redirect URIs
      for (const uri of redirectUris) {
        if (!isRedirectUriAllowed(uri)) {
          return c.json({
            error: 'invalid_redirect_uri',
            error_description: `Redirect URI '${uri}' is not permitted by allow-list.`,
          }, 400);
        }
      }

      const clientId = `client_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
      const clientSecret = crypto.randomBytes(16).toString('hex');
      const client: OAuthClient = {
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uris: redirectUris,
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

  // Authorization Endpoint
  router.get('/oauth/authorize', (c) => {
    const clientId = c.req.query('client_id');
    const redirectUri = c.req.query('redirect_uri');
    const state = c.req.query('state') || '';
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method') || 'S256';

    if (!clientId || !redirectUri) {
      return c.text('Missing client_id or redirect_uri', 400);
    }

    if (!isRedirectUriAllowed(redirectUri)) {
      return c.text('Unauthorized redirect_uri', 400);
    }

    // Require PKCE and reject anything other than S256
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return c.text('PKCE S256 is required. Plain or missing code challenge is rejected.', 400);
    }

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
            <input type="hidden" name="code_challenge" value="${codeChallenge}">
            <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod}">
            <label>Master Password:</label>
            <input type="password" name="password" placeholder="Enter password (min 16 chars)..." required autofocus>
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

    const ip = c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'client';
    const now = Date.now();
    const attempt = loginAttempts.get(ip) || { attempts: 0, lockoutUntil: 0 };

    if (now < attempt.lockoutUntil) {
      const waitSec = Math.ceil((attempt.lockoutUntil - now) / 1000);
      return c.text(`Account locked due to too many failed attempts. Try again in ${waitSec} seconds.`, 429);
    }

    // Require PKCE S256
    if (!codeChallenge || codeChallengeMethod !== 'S256') {
      return c.text('PKCE S256 is required. Plain code challenge is rejected.', 400);
    }

    if (!options.adminPassword || password !== options.adminPassword) {
      attempt.attempts++;
      if (attempt.attempts >= 5) {
        attempt.lockoutUntil = now + 15 * 60 * 1000; // 15 min lockout
        loginAttempts.set(ip, attempt);
        return c.text('Account locked due to too many failed attempts. Locked for 15 minutes.', 429);
      }
      loginAttempts.set(ip, attempt);
      const remaining = 5 - attempt.attempts;
      return c.text(`Invalid Master Password. ${remaining} attempt(s) remaining before lockout.`, 403);
    }

    // Successful login: reset attempts
    loginAttempts.delete(ip);

    const code = `code_${crypto.randomBytes(16).toString('hex')}`;
    authCodes.set(code, {
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      expires_at: Date.now() + 300000, // 5 min
    });

    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) target.searchParams.set('state', state);

    return c.redirect(target.toString(), 302);
  });

  // Token Endpoint (authorization_code and refresh_token)
  router.post('/oauth/token', async (c) => {
    try {
      const body = await c.req.parseBody();
      const grantType = body.grant_type;

      if (grantType === 'authorization_code') {
        const code = body.code as string;
        const codeVerifier = body.code_verifier as string;

        const authCode = authCodes.get(code);
        if (!authCode || Date.now() > authCode.expires_at) {
          return c.json({ error: 'invalid_grant', error_description: 'Code expired or invalid' }, 400);
        }

        // S256 verification
        if (!codeVerifier || !verifyPkceS256(codeVerifier, authCode.code_challenge)) {
          return c.json({ error: 'invalid_grant', error_description: 'PKCE S256 verification failed' }, 400);
        }

        authCodes.delete(code);
        const accessToken = `mcp_token_${crypto.randomBytes(24).toString('hex')}`;
        const refreshToken = `mcp_refresh_${crypto.randomBytes(24).toString('hex')}`;
        const now = Date.now();

        accessTokens.set(accessToken, {
          token: accessToken,
          client_id: authCode.client_id,
          expires_at: now + 3600 * 1000, // 1 hour expiry
        });

        refreshTokens.set(refreshToken, {
          refresh_token: refreshToken,
          client_id: authCode.client_id,
          expires_at: now + 86400 * 30 * 1000, // 30 days
        });

        return c.json({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: refreshToken,
        });
      } else if (grantType === 'refresh_token') {
        const refreshToken = body.refresh_token as string;
        const record = refreshTokens.get(refreshToken);
        if (!record || Date.now() > record.expires_at) {
          return c.json({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' }, 400);
        }

        const newAccessToken = `mcp_token_${crypto.randomBytes(24).toString('hex')}`;
        const now = Date.now();
        accessTokens.set(newAccessToken, {
          token: newAccessToken,
          client_id: record.client_id,
          expires_at: now + 3600 * 1000,
        });

        return c.json({
          access_token: newAccessToken,
          token_type: 'Bearer',
          expires_in: 3600,
        });
      } else {
        return c.json({ error: 'unsupported_grant_type' }, 400);
      }
    } catch (e: any) {
      return c.json({ error: 'invalid_request', error_description: e.message }, 400);
    }
  });

  // RFC 7009: Token Revocation
  router.post('/oauth/revoke', async (c) => {
    try {
      const body = await c.req.parseBody();
      const token = body.token as string;
      if (token) {
        accessTokens.delete(token);
        refreshTokens.delete(token);
      }
      return c.json({ status: 'revoked' }, 200);
    } catch (e: any) {
      return c.json({ error: 'invalid_request' }, 400);
    }
  });

  return {
    router,
    isTokenValid: (token: string) => {
      const record = accessTokens.get(token);
      if (!record) return false;
      return Date.now() < record.expires_at;
    },
    revokeToken: (token: string) => {
      accessTokens.delete(token);
      refreshTokens.delete(token);
    },
  };
}
