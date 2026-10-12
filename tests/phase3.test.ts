import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer, Server } from 'http';
import { BridgeDatabase } from '../src/db.js';
import { BridgeEngine } from '../src/engine.js';
import { AgentHub } from '../src/agent_hub.js';
import { BridgeAgentNode } from '../src/sdk.js';

describe('Phase 3: Questions Flow (ctx.ask), needs_input, check_inbox, and Loop Protection', () => {
  let db: BridgeDatabase;
  let engine: BridgeEngine;
  let hub: AgentHub;
  let server: Server;
  let wss: WebSocketServer;
  const PORT = 3993;

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

  it('scripted agent asks 2 questions mid-task, model answers via listen and send, completing successfully', async () => {
    const token = 'question-agent-token';
    db.upsertAgent({
      id: 'qa-agent-id',
      name: 'qa-agent',
      description: 'Asks 2 questions mid-task',
      capabilities: ['interactive'],
      expected_duration: 'slow 1-3 min',
      token_hash: engine.hashToken(token),
      online: 0,
      last_seen: null,
      require_approval: 0,
      enabled: 1,
    });

    const qaAgent = new BridgeAgentNode({
      agentId: 'qa-agent',
      token,
      bridgeWsUrl: `ws://127.0.0.1:${PORT}`,
    });

    qaAgent.onTask(async (ctx) => {
      // Question 1
      const ans1 = await ctx.ask('What is your favorite color?');
      // Question 2
      const ans2 = await ctx.ask(`Why do you like ${ans1}?`);
      return `Final result: Color is ${ans1} because ${ans2}`;
    });

    await qaAgent.start();
    await new Promise((r) => setTimeout(r, 400));

    // Model sends initial task
    const send1 = await engine.send({
      to: 'qa-agent',
      content: 'Start the questionnaire',
      wait_seconds: 3,
    });

    expect(send1.task_id).toBeDefined();
    const taskId = send1.task_id!;

    // Model listens and receives Question 1 (status: needs_input)
    const listen1 = await engine.listen({
      task_id: taskId,
      wait_seconds: 3,
    });

    expect(listen1.status).toBe('needs_input');
    expect(listen1.next_step).toContain('The agent asked you a question. Answer it with send(reply_to=');
    const question1Msg = listen1.messages.find((m) => m.type === 'question');
    expect(question1Msg).toBeDefined();
    expect(question1Msg?.content).toContain('What is your favorite color?');

    // Model answers Question 1
    const sendAns1 = await engine.send({
      to: 'qa-agent',
      room_id: send1.room_id,
      reply_to: question1Msg!.id,
      content: 'Blue',
      wait_seconds: 3,
    });

    // Model listens and receives Question 2
    const listen2 = await engine.listen({
      task_id: taskId,
      cursor: listen1.cursor,
      wait_seconds: 3,
    });

    expect(listen2.status).toBe('needs_input');
    const question2Msg = listen2.messages.find((m) => m.type === 'question');
    expect(question2Msg).toBeDefined();
    expect(question2Msg?.content).toContain('Why do you like Blue?');

    // Model answers Question 2
    await engine.send({
      to: 'qa-agent',
      room_id: send1.room_id,
      reply_to: question2Msg!.id,
      content: 'it looks like the sky',
      wait_seconds: 3,
    });

    // Final listen retrieves completed task result
    const finalListen = await engine.listen({
      task_id: taskId,
      cursor: listen2.cursor,
      wait_seconds: 3,
    });

    expect(finalListen.status).toBe('done');
    expect(finalListen.next_step).toBe('Task complete. Summarize the result for the user.');
    const resultMsg = finalListen.messages.find((m) => m.type === 'result');
    expect(resultMsg?.content).toContain('Final result: Color is Blue because it looks like the sky');

    qaAgent.stop();
  }, 20000);

  it('no-poll case: unanswered question surfaces via check_inbox', async () => {
    const room = db.getOrCreateRoom('room-inbox-test');
    db.addMessage({
      room_id: room.id,
      sender: 'test-agent',
      recipient: 'chat_model',
      type: 'question',
      content: 'Are you ready?',
    });

    const inbox = engine.checkInbox();
    expect(inbox.unanswered_questions.length).toBeGreaterThan(0);
    expect(inbox.unanswered_questions[0].content).toContain('Are you ready?');
    expect(inbox.next_step).toContain('You have pending questions from agents.');
  });

  it('loop protection: stops automated ping-pong loop when limits are reached', async () => {
    const room = db.getOrCreateRoom('loop-room');
    db.db.prepare('UPDATE rooms SET max_consecutive_turns = 3 WHERE id = ?').run(room.id);

    // Turn 1
    await engine.send({
      to: 'participantB',
      room_id: room.id,
      content: 'Turn 1',
      sender_name: 'model1',
      sender_kind: 'model',
      wait_seconds: 1,
    });

    // Turn 2
    await engine.send({
      to: 'participantA',
      room_id: room.id,
      content: 'Turn 2',
      sender_name: 'model2',
      sender_kind: 'model',
      wait_seconds: 1,
    });

    // Turn 3
    await engine.send({
      to: 'participantB',
      room_id: room.id,
      content: 'Turn 3',
      sender_name: 'model1',
      sender_kind: 'model',
      wait_seconds: 1,
    });

    // Turn 4 should exceed max_consecutive_turns (3) and pause room
    await expect(
      engine.send({
        to: 'participantA',
        room_id: room.id,
        content: 'Turn 4',
        sender_name: 'model2',
        sender_kind: 'model',
        wait_seconds: 1,
      })
    ).rejects.toThrow(/exceeded max consecutive automated turns/);

    const updatedRoom = db.getRoom(room.id);
    expect(updatedRoom?.status).toBe('paused');
  });
});
