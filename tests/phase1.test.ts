import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer, Server } from 'http';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { AgentHub } from '../src/agent_hub.js';
import { BridgeAgentNode } from '../src/sdk.js';

describe('Phase 1: Engine + SQLite + Agent WebSocket Hub + SDK Integration', () => {
  let db: BridgeDatabase;
  let engine: BridgeEngine;
  let hub: AgentHub;
  let server: Server;
  let wss: WebSocketServer;
  const PORT = 3991;

  beforeEach(async () => {
    db = new BridgeDatabase(':memory:');
    engine = new BridgeEngine(db);
    hub = new AgentHub(engine);

    server = createServer();
    wss = new WebSocketServer({ server });
    hub.setupWebSocket(wss);

    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterEach(async () => {
    hub.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects echo agent, executes task, and receives result with untrusted wrapping', async () => {
    const rawToken = 'echo-secret-token';
    const tokenHash = engine.hashToken(rawToken);

    // Register echo agent in DB
    db.upsertAgent({
      id: 'echo-agent-id',
      name: 'echo',
      description: 'An agent that echoes back prompts',
      capabilities: ['echo', 'test'],
      expected_duration: 'fast <10s',
      token_hash: tokenHash,
      online: 0,
      last_seen: null,
      require_approval: 0,
      enabled: 1,
    });

    // Start Echo Agent via SDK
    const agent = new BridgeAgentNode({
      agentId: 'echo',
      token: rawToken,
      bridgeWsUrl: `ws://127.0.0.1:${PORT}`,
    });

    agent.onTask(async (ctx) => {
      await ctx.progress('Processing echo...', 50);
      return `Echo: ${ctx.prompt}`;
    });

    await agent.start();

    // Wait for agent to authenticate
    await new Promise((r) => setTimeout(r, 500));

    const agentRecord = db.getAgentById('echo-agent-id');
    expect(agentRecord?.online).toBe(1);

    // Call engine.send to trigger task
    const sendResult = await engine.send({
      to: 'echo',
      content: 'Hello Antigravity!',
      wait_seconds: 5,
    });

    expect(sendResult.room_id).toBeDefined();
    expect(sendResult.task_id).toBeDefined();

    // Listen to retrieve completed result
    const listenResult = await engine.listen({
      task_id: sendResult.task_id,
      wait_seconds: 3,
    });

    expect(listenResult.status).toBe('done');
    expect(listenResult.next_step).toBe('Task complete. Summarize the result for the user.');
    expect(listenResult.messages.length).toBeGreaterThan(0);

    const resultMsg = listenResult.messages.find((m) => m.type === 'result');
    expect(resultMsg).toBeDefined();
    expect(resultMsg?.content).toContain('<message from="echo" untrusted="true">');
    expect(resultMsg?.content).toContain('Echo: Hello Antigravity!');

    agent.stop();
  });

  it('handles agent disconnect and task requeue', async () => {
    const rawToken = 'disconnect-token';
    db.upsertAgent({
      id: 'disconnect-agent',
      name: 'disconnector',
      description: 'Disconnects mid-task',
      capabilities: ['test'],
      expected_duration: 'fast <10s',
      token_hash: engine.hashToken(rawToken),
      online: 0,
      last_seen: null,
      require_approval: 0,
      enabled: 1,
    });

    const agent = new BridgeAgentNode({
      agentId: 'disconnector',
      token: rawToken,
      bridgeWsUrl: `ws://127.0.0.1:${PORT}`,
    });

    agent.onTask(async (ctx) => {
      // Simulate crash right away
      agent.stop();
      return 'will not reach';
    });

    await agent.start();
    await new Promise((r) => setTimeout(r, 300));

    // Send task
    await engine.send({
      to: 'disconnector',
      content: 'Should crash and requeue',
      wait_seconds: 1,
    });

    await new Promise((r) => setTimeout(r, 500));

    // Check DB task status
    const tasks = db.getActiveTasksForAgent('disconnect-agent');
    expect(tasks.length).toBe(1);
    expect(tasks[0].retries).toBe(1);
    expect(tasks[0].status).toBe('pending');
  });

  it('recovers pending tasks on engine/db restart', () => {
    db.upsertAgent({
      id: 'restart-agent',
      name: 'restarter',
      description: 'Restart test agent',
      capabilities: ['test'],
      expected_duration: 'fast <10s',
      token_hash: 'hash',
      online: 0,
      last_seen: null,
      require_approval: 0,
      enabled: 1,
    });
    const room = db.getOrCreateRoom('room-restart-test');
    const task = db.createTask({
      room_id: room.id,
      agent_id: 'restart-agent',
      prompt: 'Recover me',
    });

    db.updateTask(task.id, { status: 'running' });
    expect(db.getTask(task.id)?.status).toBe('running');

    // Simulate recovery
    const recovered = db.recoverDanglingTasks();
    expect(recovered).toBe(1);
    expect(db.getTask(task.id)?.status).toBe('pending');
  });
});
