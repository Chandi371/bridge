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

  if (command !== 'start') {
    console.log(`
Usage: npm run bridge start

Options configured via .env:
  PUBLIC_PORT=${PUBLIC_PORT}
  LOCAL_PORT=${LOCAL_PORT}
  PUBLIC_BASE_URL=${PUBLIC_BASE_URL}
`);
    process.exit(0);
  }

  console.log('=====================================================');
  console.log('              STARTING BRIDGE SERVICE                ');
  console.log('=====================================================');

  // Check Cloudflare Tunnel flag or quick tunnel
  let tunnelProc: any = null;
  const isCloudflareQuick = process.env.CLOUDFLARE_TUNNEL_MODE === 'quick';

  if (isCloudflareQuick) {
    console.log('[Tunnel] Launching Cloudflare quick tunnel to http://127.0.0.1:' + PUBLIC_PORT);
    tunnelProc = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${PUBLIC_PORT}`]);

    tunnelProc.stderr.on('data', (d: Buffer) => {
      const line = d.toString();
      const match = line.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        PUBLIC_BASE_URL = match[0];
        console.log(`[Tunnel] Quick Tunnel active at: ${PUBLIC_BASE_URL}`);
      }
    });
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
  console.log(`Copy-Paste View:  ${PUBLIC_BASE_URL}/paste`);
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
