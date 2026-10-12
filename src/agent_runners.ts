import { spawn } from 'child_process';
import crypto from 'crypto';
import { BridgeDatabase } from './db.js';
import { BridgeAgentNode } from './sdk.js';

export interface CommandAgentConfig {
  id: string;
  name: string;
  description: string;
  command: string;
  args?: string[];
  capabilities?: string[];
  expected_duration?: string;
  require_approval?: boolean;
}

export interface WebhookAgentConfig {
  id: string;
  name: string;
  description: string;
  url: string;
  capabilities?: string[];
  expected_duration?: string;
  require_approval?: boolean;
}

export class ExternalAgentRunner {
  private db: BridgeDatabase;
  private bridgeWsUrl: string;
  private runningAgents: BridgeAgentNode[] = [];

  constructor(db: BridgeDatabase, bridgeWsUrl = 'ws://127.0.0.1:3001/agent/ws') {
    this.db = db;
    this.bridgeWsUrl = bridgeWsUrl;
  }

  public registerAndStartCommandAgent(cfg: CommandAgentConfig, token: string) {
    // Upsert into DB
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    this.db.upsertAgent({
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      capabilities: cfg.capabilities || ['cli'],
      expected_duration: cfg.expected_duration || 'fast <10s',
      token_hash: tokenHash,
      online: 0,
      last_seen: null,
      require_approval: cfg.require_approval ? 1 : 0,
      enabled: 1,
    });

    const agent = new BridgeAgentNode({
      agentId: cfg.id,
      token,
      bridgeWsUrl: this.bridgeWsUrl,
    });

    agent.onTask(async (ctx) => {
      return new Promise<string>((resolve, reject) => {
        const proc = spawn(cfg.command, cfg.args || [], {
          shell: true,
        });

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (d) => {
          stdout += d.toString();
          ctx.progress('Running command...', undefined, undefined, stdout.slice(-200));
        });

        proc.stderr.on('data', (d) => {
          stderr += d.toString();
        });

        proc.stdin.write(ctx.prompt);
        proc.stdin.end();

        proc.on('close', (code) => {
          if (code === 0) {
            resolve(stdout.trim());
          } else {
            reject(new Error(`Command exited with code ${code}: ${stderr}`));
          }
        });

        proc.on('error', (err) => {
          reject(err);
        });
      });
    });

    agent.start();
    this.runningAgents.push(agent);
    return agent;
  }

  public registerAndStartWebhookAgent(cfg: WebhookAgentConfig, token: string) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    this.db.upsertAgent({
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      capabilities: cfg.capabilities || ['webhook'],
      expected_duration: cfg.expected_duration || 'fast <10s',
      token_hash: tokenHash,
      online: 0,
      last_seen: null,
      require_approval: cfg.require_approval ? 1 : 0,
      enabled: 1,
    });

    const agent = new BridgeAgentNode({
      agentId: cfg.id,
      token,
      bridgeWsUrl: this.bridgeWsUrl,
    });

    agent.onTask(async (ctx) => {
      const res = await fetch(cfg.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_id: ctx.taskId,
          room_id: ctx.roomId,
          prompt: ctx.prompt,
        }),
      });

      if (!res.ok) {
        throw new Error(`Webhook returned status ${res.status}: ${await res.text()}`);
      }

      const json = await res.json().catch(() => null);
      if (json && json.result) return json.result;
      return typeof json === 'string' ? json : JSON.stringify(json);
    });

    agent.start();
    this.runningAgents.push(agent);
    return agent;
  }

  public stopAll() {
    for (const a of this.runningAgents) {
      a.stop();
    }
    this.runningAgents = [];
  }
}
