import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import YAML from 'yaml';
import dotenv from 'dotenv';
import { BridgeServer } from './server.js';

dotenv.config();

const PUBLIC_PORT = parseInt(process.env.PUBLIC_PORT || '3000', 10);
const LOCAL_PORT = parseInt(process.env.LOCAL_PORT || '3001', 10);
let PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PUBLIC_PORT}`;
const API_KEY = process.env.BRIDGE_API_KEY || 'test-bridge-api-key-secret-123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin-secure-password';

async function main() {
  const command = process.argv[2];

  if (command === 'url') {
    console.log(`\n=== Bridge URLs ===`);
    console.log(`Public Base URL:  ${PUBLIC_BASE_URL}`);
    console.log(`MCP Endpoint:     ${PUBLIC_BASE_URL}/mcp`);
    console.log(`OpenAPI Spec:     ${PUBLIC_BASE_URL}/openapi.json`);
    console.log(`Protected Res:    ${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`);
    console.log(`OAuth Metadata:   ${PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`);
    console.log(`Local Dashboard:  http://127.0.0.1:${LOCAL_PORT}/admin\n`);
    process.exit(0);
  }

  if (command !== 'start') {
    console.log(`
Usage:
  npm run bridge start   Start Bridge server, tunnels, and agents
  npm run bridge url     Print current public, MCP, and OpenAPI URLs

Options configured via .env:
  PUBLIC_PORT=${PUBLIC_PORT}
  LOCAL_PORT=${LOCAL_PORT}
  PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
  TUNNEL_MODE=quick | named | ngrok
`);
    process.exit(0);
  }

  console.log('=====================================================');
  console.log('              STARTING BRIDGE SERVICE                ');
  console.log('=====================================================');

  let tunnelProc: any = null;
  const tunnelMode = process.env.TUNNEL_MODE || (process.env.CLOUDFLARE_TUNNEL_MODE === 'quick' ? 'quick' : 'none');

  if (tunnelMode === 'quick') {
    console.log('\n*****************************************************');
    console.log('  WARNING: RUNNING IN QUICK TUNNEL MODE');
    console.log('  The trycloudflare.com URL will change EVERY run.');
    console.log('  This breaks OAuth and connector setups on restart.');
    console.log('  For permanent production use, configure a named');
    console.log('  Cloudflare tunnel or ngrok static domain.');
    console.log('*****************************************************\n');

    console.log(`[Tunnel] Launching Cloudflare quick tunnel to http://127.0.0.1:${PUBLIC_PORT}`);
    tunnelProc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PUBLIC_PORT}`]);

    tunnelProc.stderr.on('data', (d: Buffer) => {
      const line = d.toString();
      const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        PUBLIC_BASE_URL = match[0];
        console.log(`[Tunnel] Quick Tunnel active at: ${PUBLIC_BASE_URL}`);
      }
    });
  } else if (tunnelMode === 'named') {
    const tunnelName = process.env.CLOUDFLARE_TUNNEL_NAME || 'bridge';
    console.log(`[Tunnel] Starting named Cloudflare tunnel '${tunnelName}'...`);
    tunnelProc = spawn('cloudflared', ['tunnel', 'run', tunnelName]);
  } else if (tunnelMode === 'ngrok') {
    const ngrokDomain = process.env.NGROK_DOMAIN;
    console.log(`[Tunnel] Starting ngrok tunnel (domain: ${ngrokDomain || 'dynamic'})...`);
    const args = ['http', `${PUBLIC_PORT}`];
    if (ngrokDomain) args.push(`--domain=${ngrokDomain}`);
    tunnelProc = spawn('ngrok', args);
  }

  // Start Bridge Server
  const server = new BridgeServer({
    publicPort: PUBLIC_PORT,
    localPort: LOCAL_PORT,
    publicBaseUrl: PUBLIC_BASE_URL,
    apiKey: API_KEY,
    adminPassword: ADMIN_PASSWORD,
    dbPath: process.env.DB_PATH || './bridge.sqlite',
  });

  await server.start();

  // Load agents.yaml
  const agentsPath = path.resolve(process.cwd(), 'agents.yaml');
  if (fs.existsSync(agentsPath)) {
    console.log('[Agents] Loading agents from agents.yaml...');
    const fileContent = fs.readFileSync(agentsPath, 'utf8');
    const parsed = YAML.parse(fileContent);

    if (parsed && Array.isArray(parsed.agents)) {
      for (const agentDef of parsed.agents) {
        const token = `token_${agentDef.id}_${Math.random().toString(36).substring(2, 7)}`;
        if (agentDef.kind === 'command') {
          server.runner.registerAndStartCommandAgent(agentDef, token);
          console.log(`  -> Started Command Agent: [${agentDef.name}]`);
        } else if (agentDef.kind === 'webhook') {
          server.runner.registerAndStartWebhookAgent(agentDef, token);
          console.log(`  -> Started Webhook Agent: [${agentDef.name}]`);
        }
      }
    }
  }

  // Print Summary
  console.log('\n=====================================================');
  console.log('               BRIDGE READY & RUNNING                ');
  console.log('=====================================================');
  console.log(`Public Base URL:  ${PUBLIC_BASE_URL}`);
  console.log(`MCP Endpoint:     ${PUBLIC_BASE_URL}/mcp`);
  console.log(`OpenAPI Spec:     ${PUBLIC_BASE_URL}/openapi.json`);
  console.log(`Protected Res:    ${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource`);
  console.log(`OAuth Metadata:   ${PUBLIC_BASE_URL}/.well-known/oauth-authorization-server`);
  console.log(`Copy-Paste View:  ${PUBLIC_BASE_URL}/paste?key=${API_KEY}`);
  console.log(`Local Dashboard:  http://127.0.0.1:${LOCAL_PORT}/admin`);
  console.log(`Agent Hub (WS):   ws://127.0.0.1:${LOCAL_PORT}/agent/ws`);
  console.log(`API Key header:   Authorization: Bearer ${API_KEY}`);
  console.log('=====================================================\n');

  // Handle Clean Shutdown
  const shutdown = async () => {
    console.log('\n[Bridge] Shutting down gracefully...');
    if (tunnelProc) tunnelProc.kill();
    await server.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[Bridge] Fatal error:', err);
  process.exit(1);
});
