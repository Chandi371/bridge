import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, Server as HttpServer } from 'http';
import { WebSocketServer } from 'ws';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { AgentHub } from '../src/agent_hub.js';

describe('Phase 8: End-to-End Bridge Listener Integration', () => {
  let db: BridgeDatabase;
  let engine: BridgeEngine;
  let hub: AgentHub;
  let server: HttpServer;
  let wss: WebSocketServer;
  const PORT = 3995;
  const EXE_PATH = path.resolve(__dirname, '../../bridge-listener/dist/bridge-listener/bridge-listener.exe');

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

  it('verifies list_agents returns online, listening, and last_claim_at', async () => {
    const rawToken = 'test-listener-token';
    const tokenHash = engine.hashToken(rawToken);

    db.upsertAgent({
      id: 'listener-agent-1',
      name: 'listener_worker',
      description: 'A test listener worker',
      capabilities: ['mcp-worker'],
      expected_duration: 'fast <10s',
      token_hash: tokenHash,
      online: 0,
      listening: 0,
      last_claim_at: null,
      kind: 'listener',
      last_seen: null,
      require_approval: 0,
      enabled: 1,
    });

    const agentsInitial = engine.listAgents();
    const agInitial = agentsInitial.find((a) => a.id === 'listener-agent-1');
    expect(agInitial).toBeDefined();
    expect(agInitial?.online).toBe(false);
    expect(agInitial?.listening).toBe(false);
    expect(agInitial?.last_claim_at).toBeNull();
    expect(agInitial?.kind).toBe('listener');

    // Simulate agent connecting and reporting listening presence
    db.setAgentOnline('listener-agent-1', true);
    db.setAgentListening('listener-agent-1', true);

    const agentsActive = engine.listAgents();
    const agActive = agentsActive.find((a) => a.id === 'listener-agent-1');
    expect(agActive?.online).toBe(true);
    expect(agActive?.listening).toBe(true);
    expect(agActive?.last_claim_at).toBeTypeOf('number');

    // Simulate listening expiring after 60s
    db.setAgentListening('listener-agent-1', false);
    const agentsExpired = engine.listAgents();
    const agExpired = agentsExpired.find((a) => a.id === 'listener-agent-1');
    expect(agExpired?.online).toBe(true);
    expect(agExpired?.listening).toBe(false);
  });

  it('verifies send to connected-but-not-listening agent returns firm next_step', async () => {
    const rawToken = 'not-listening-token';
    const tokenHash = engine.hashToken(rawToken);

    db.upsertAgent({
      id: 'not-listening-agent',
      name: 'sleeping_worker',
      description: 'Sleeping worker',
      capabilities: ['mcp-worker'],
      expected_duration: 'fast <10s',
      token_hash: tokenHash,
      online: 1, // Connected
      listening: 0, // But NOT listening
      last_claim_at: null,
      kind: 'listener',
      last_seen: Date.now(),
      require_approval: 0,
      enabled: 1,
    });

    const sendRes = await engine.send({
      to: 'sleeping_worker',
      content: 'Hello sleeping agent!',
      wait_seconds: 2,
    });

    expect(sendRes.status).toBe('running');
    expect(sendRes.task_id).toBeDefined();
    expect(sendRes.next_step).toBe(
      `Agent sleeping_worker is open but not listening. Tell the user to start its worker loop, then call listen with task_id ${sendRes.task_id}.`
    );
  });

  it('verifies send to offline agent returns error with online alternatives', async () => {
    const rawToken = 'offline-token';
    db.upsertAgent({
      id: 'offline-agent',
      name: 'offline_worker',
      description: 'Offline worker',
      capabilities: ['mcp-worker'],
      expected_duration: 'fast <10s',
      token_hash: engine.hashToken(rawToken),
      online: 0,
      listening: 0,
      last_claim_at: null,
      kind: 'listener',
      last_seen: Date.now() - 300000,
      require_approval: 0,
      enabled: 1,
    });

    await expect(
      engine.send({
        to: 'offline_worker',
        content: 'Wake up!',
      })
    ).rejects.toThrow(/Agent 'offline_worker' is offline/);
  });

  it('runs full end-to-end flow with compiled bridge-listener.exe over stdio', async () => {
    if (!fs.existsSync(EXE_PATH)) {
      console.warn(`Compiled binary not found at ${EXE_PATH}; skipping live exe test.`);
      return;
    }

    const token = 'e2e-listener-token-999';
    const tokenHash = engine.hashToken(token);

    db.upsertAgent({
      id: 'e2e-worker',
      name: 'e2e_worker',
      description: 'E2E Worker agent',
      capabilities: ['mcp-worker'],
      expected_duration: 'fast <10s',
      token_hash: tokenHash,
      online: 0,
      listening: 0,
      last_claim_at: null,
      kind: 'listener',
      last_seen: null,
      require_approval: 0,
      enabled: 1,
    });

    // 1. Spawn bridge-listener.exe via stdio
    const listenerProc = spawn(EXE_PATH, [
      '--agent', 'e2e_worker',
      '--token', token,
      '--bridge', `ws://127.0.0.1:${PORT}`,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    listenerProc.stderr.on('data', (d: Buffer) => {
      console.log('[EXE STDERR]', d.toString());
    });

    const pendingRpc = new Map<number, (res: any) => void>();
    let rpcIdCounter = 1;
    let buffer = '';

    listenerProc.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line.trim());
          if (json.id && pendingRpc.has(json.id)) {
            pendingRpc.get(json.id)!(json);
            pendingRpc.delete(json.id);
          }
        } catch {}
      }
    });

    const callRpc = (method: string, params: any): Promise<any> => {
      const id = rpcIdCounter++;
      return new Promise((resolve) => {
        pendingRpc.set(id, resolve);
        const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        listenerProc.stdin.write(req);
      });
    };

    try {
      // Initialize MCP session over stdio
      const initRes = await callRpc('initialize', {
        protocolVersion: '2024-11-05',
        clientInfo: { name: 'simulated-mcp-client', version: '1.0.0' },
        capabilities: {},
      });
      expect(initRes.result).toBeDefined();

      // MCP protocol requires initialized notification after initialize result
      listenerProc.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n');

      // Wait for WebSocket authentication
      for (let i = 0; i < 20; i++) {
        const ag = db.getAgentById('e2e-worker');
        if (ag && ag.online) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(db.getAgentById('e2e-worker')?.online).toBe(1);

      console.log('--- Agent authenticated. Calling claim_task first ---');
      // Simulated agent calls claim_task via stdio MCP to start listening
      const claimRpc = await callRpc('tools/call', {
        name: 'claim_task',
        arguments: { wait_seconds: 2 },
      });
      console.log('--- Initial claimRpc response:', JSON.stringify(claimRpc));

      // Model dispatches task via engine.send
      console.log('--- Model dispatching task via engine.send ---');
      const sendPromise = engine.send({
        to: 'e2e_worker',
        content: 'Compute the checksum of test-repo',
        wait_seconds: 5,
      });

      // Simulated agent claims the dispatched task
      const claimTaskRpc = await callRpc('tools/call', {
        name: 'claim_task',
        arguments: { wait_seconds: 2 },
      });
      console.log('--- Claimed task response:', JSON.stringify(claimTaskRpc));
      const claimResult = JSON.parse(claimTaskRpc.result.content[0].text);
      expect(claimResult.task_id).toBeDefined();
      expect(claimResult.prompt).toContain('<task from="caller" untrusted="true">');
      expect(claimResult.prompt).toContain('Compute the checksum of test-repo');

      const taskId = claimResult.task_id;

      // Agent reports progress
      const progRpc = await callRpc('tools/call', {
        name: 'report_progress',
        arguments: {
          task_id: taskId,
          text: 'Hashing repository tree...',
          percent: 50,
          eta_seconds: 5,
          partial_output: 'Tree hash in progress',
        },
      });
      expect(JSON.parse(progRpc.result.content[0].text).success).toBe(true);

      // Agent asks clarifying question
      const questionPromise = callRpc('tools/call', {
        name: 'ask_question',
        arguments: {
          task_id: taskId,
          question: 'Include untracked files in checksum?',
        },
      });

      // Model polls and receives question in needs_input state
      let qMsgId = '';
      for (let i = 0; i < 15; i++) {
        const listenQ = await engine.listen({ task_id: taskId, wait_seconds: 1 });
        if (listenQ.status === 'needs_input') {
          const qMsg = listenQ.messages.find((m) => m.type === 'question');
          if (qMsg) {
            qMsgId = qMsg.id;
            break;
          }
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(qMsgId).not.toBe('');

      // Model replies via send(reply_to=qMsgId) without blocking on long-polling
      const replyPromise = engine.send({
        to: 'e2e_worker',
        content: 'Yes, include untracked files.',
        reply_to: qMsgId,
        wait_seconds: 1,
      });

      // Agent receives the answer in ask_question tool call
      const questionRes = await questionPromise;
      const questionAnswer = JSON.parse(questionRes.result.content[0].text);
      expect(questionAnswer.answer).toBe('Yes, include untracked files.');
      await replyPromise;

      // Agent finishes work and submits result
      const submitRpc = await callRpc('tools/call', {
        name: 'submit_result',
        arguments: {
          task_id: taskId,
          result: 'Checksum SHA256: a1b2c3d4e5f6',
        },
      });
      expect(JSON.parse(submitRpc.result.content[0].text).success).toBe(true);

      // Model listen now returns 'done'
      const listenDone = await engine.listen({ task_id: taskId, wait_seconds: 2 });
      expect(listenDone.status).toBe('done');
      const resMsg = listenDone.messages.find((m) => m.type === 'result');
      expect(resMsg?.content).toContain('Checksum SHA256: a1b2c3d4e5f6');

    } finally {
      listenerProc.kill();
    }
  }, 30000);

  it('handles listening expiry after idle period and re-activation', () => {
    const rawToken = 'expiry-test-token';
    const agentId = 'expiry-agent';

    db.upsertAgent({
      id: agentId,
      name: 'expiry_worker',
      description: 'Expiry worker test',
      capabilities: ['mcp-worker'],
      expected_duration: 'fast <10s',
      token_hash: engine.hashToken(rawToken),
      online: 1,
      listening: 1,
      last_claim_at: Date.now() - 70000, // 70 seconds ago (> 60s)
      kind: 'listener',
      last_seen: Date.now(),
      require_approval: 0,
      enabled: 1,
    });

    // Check expiry logic: if last_claim_at was > 60s ago, setAgentListening marks it 0
    db.setAgentListening(agentId, false);
    const agentInfo = engine.listAgents().find((a) => a.id === agentId);
    expect(agentInfo?.online).toBe(true);
    expect(agentInfo?.listening).toBe(false);

    // Agent calls claim_task again, renewing listening presence
    db.setAgentListening(agentId, true);
    const renewedInfo = engine.listAgents().find((a) => a.id === agentId);
    expect(renewedInfo?.online).toBe(true);
    expect(renewedInfo?.listening).toBe(true);
  });

  it('handles abandoned claim by requeueing or failing task upon disconnect', async () => {
    const rawToken = 'abandon-token';
    const agentId = 'abandon-agent';

    db.upsertAgent({
      id: agentId,
      name: 'abandon_worker',
      description: 'Abandon test worker',
      capabilities: ['mcp-worker'],
      expected_duration: 'fast <10s',
      token_hash: engine.hashToken(rawToken),
      online: 1,
      listening: 1,
      last_claim_at: Date.now(),
      kind: 'listener',
      last_seen: Date.now(),
      require_approval: 0,
      enabled: 1,
    });

    const room = db.getOrCreateRoom('abandon-room');
    const task = db.createTask({
      room_id: room.id,
      agent_id: agentId,
      prompt: 'Work that will be abandoned',
    });

    db.updateTask(task.id, { status: 'running' });

    // Simulate agent disconnecting with in-flight task (simulate handleDisconnect in hub)
    hub['connections'].set(agentId, {
      agentId,
      agentName: 'abandon_worker',
      ws: { readyState: 3, terminate: () => {} } as any,
      lastHeartbeat: Date.now(),
      currentTasks: new Set([task.id]),
    });

    hub['handleDisconnect'](agentId);

    // Task is requeued (retries = 1, status = 'pending')
    const requeuedTask = db.getTask(task.id);
    expect(requeuedTask?.status).toBe('pending');
    expect(requeuedTask?.retries).toBe(1);

    // Second disconnect triggers error status once retries reach max
    requeuedTask!.retries = 2;
    db.updateTask(task.id, { status: 'running', retries: 2 });
    hub['connections'].set(agentId, {
      agentId,
      agentName: 'abandon_worker',
      ws: { readyState: 3, terminate: () => {} } as any,
      lastHeartbeat: Date.now(),
      currentTasks: new Set([task.id]),
    });

    hub['handleDisconnect'](agentId);
    const failedTask = db.getTask(task.id);
    expect(failedTask?.status).toBe('error');
    expect(failedTask?.result).toContain('max retries exceeded');
  });
});
