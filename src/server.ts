import { serve } from '@hono/node-server';
import { WebSocketServer } from 'ws';
import { Hono } from 'hono';
import { BridgeDatabase } from './db.js';
import { BridgeEngine } from './engine.js';
import { AgentHub } from './agent_hub.js';
import { createPublicApp, createLocalApp } from './server_apps.js';
import { createOAuthRouter } from './oauth.js';
import { createMcpRouter } from './mcp_adapter.js';
import { createViewsAndPasteRouter } from './views.js';
import { createDashboardRouter } from './dashboard.js';
import { ExternalAgentRunner } from './agent_runners.js';

export interface BridgeConfig {
  publicPort: number;
  localPort: number;
  publicBaseUrl: string;
  apiKey: string;
  adminPassword?: string;
  dbPath?: string;
  rateLimitPerMin?: number;
  maxPromptSizeBytes?: number;
}

export class BridgeServer {
  public config: BridgeConfig;
  public db: BridgeDatabase;
  public engine: BridgeEngine;
  public hub: AgentHub;
  public runner: ExternalAgentRunner;

  private publicServer: any;
  private localServer: any;
  private localWss: WebSocketServer | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.db = new BridgeDatabase(config.dbPath || './bridge.sqlite');
    this.engine = new BridgeEngine(this.db);
    this.hub = new AgentHub(this.engine);
    this.runner = new ExternalAgentRunner(this.db, `ws://127.0.0.1:${config.localPort}/agent/ws`);
  }

  public async start(): Promise<void> {
    // 1. Recover any tasks interrupted in previous run
    const recovered = this.db.recoverDanglingTasks();
    if (recovered > 0) {
      console.log(`[Bridge] Recovered ${recovered} dangling tasks from previous session.`);
    }

    // 2. Setup OAuth router
    const oauth = createOAuthRouter({
      publicBaseUrl: this.config.publicBaseUrl,
      adminPassword: this.config.adminPassword,
    });

    // 3. Setup MCP router
    const mcp = createMcpRouter({
      engine: this.engine,
      isTokenAuthorized: (token) => {
        return oauth.isTokenValid(token) || token === this.config.apiKey;
      },
    });

    // 4. Setup Public App
    const publicApp = createPublicApp({
      engine: this.engine,
      apiKey: this.config.apiKey,
      publicBaseUrl: this.config.publicBaseUrl,
      rateLimitPerMin: this.config.rateLimitPerMin,
      maxPromptSizeBytes: this.config.maxPromptSizeBytes,
    });

    // Mount OAuth endpoints
    publicApp.route('/', oauth.router);
    // Mount MCP endpoints
    publicApp.route('/', mcp.router);
    // Mount Views & Paste
    const views = createViewsAndPasteRouter(this.engine);
    publicApp.route('/', views);

    this.publicServer = serve({
      fetch: publicApp.fetch,
      port: this.config.publicPort,
    });

    // 5. Setup Local App (Admin & Dashboard)
    const localApp = createLocalApp({
      engine: this.engine,
      adminPassword: this.config.adminPassword,
    });
    const dashboard = createDashboardRouter(this.engine, this.config.publicBaseUrl);
    localApp.route('/', dashboard);

    this.localServer = serve({
      fetch: localApp.fetch,
      port: this.config.localPort,
      hostname: '127.0.0.1',
    });

    // Mount Agent WebSocket hub onto local server
    this.localWss = new WebSocketServer({
      server: this.localServer,
      path: '/agent/ws',
    });
    this.hub.setupWebSocket(this.localWss);

    console.log(`[Bridge] Public listener started on port ${this.config.publicPort}`);
    console.log(`[Bridge] Local listener started on 127.0.0.1:${this.config.localPort}`);
  }

  public async stop(): Promise<void> {
    this.runner.stopAll();
    this.hub.stop();
    if (this.localWss) this.localWss.close();
    if (this.publicServer) await new Promise<void>((r) => this.publicServer.close(() => r()));
    if (this.localServer) await new Promise<void>((r) => this.localServer.close(() => r()));
  }
}
