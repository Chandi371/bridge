import { WebSocket, WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { BridgeEngine } from './engine.js';
import { Task } from './types.js';

export interface AgentConnection {
  agentId: string;
  agentName: string;
  ws: WebSocket;
  lastHeartbeat: number;
  currentTasks: Set<string>;
}

export class AgentHub {
  private engine: BridgeEngine;
  private connections: Map<string, AgentConnection> = new Map(); // agentId -> AgentConnection
  private pingInterval: NodeJS.Timeout | null = null;
  public wss: WebSocketServer | null = null;

  constructor(engine: BridgeEngine) {
    this.engine = engine;

    // Listen to engine task creation
    this.engine.on('task:created', (task: Task) => {
      this.dispatchTask(task);
    });

    this.engine.on('task:cancelled', (taskId: string) => {
      this.notifyCancel(taskId);
    });

    this.engine.on('task:answered', (event: { task_id: string; question_id: string; answer: string }) => {
      this.dispatchAnswer(event.task_id, event.answer);
    });
  }

  public dispatchAnswer(taskId: string, answer: string) {
    const task = this.engine.db.getTask(taskId);
    if (!task) return;
    const conn = this.connections.get(task.agent_id);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify({
        type: 'answer',
        task_id: taskId,
        answer,
      }));
    }
  }

  public setupWebSocket(wss: WebSocketServer) {
    this.wss = wss;

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Start 20s ping/pong heartbeat check
    this.pingInterval = setInterval(() => {
      this.checkHeartbeats();
    }, 20000);
  }

  public stop() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    if (this.wss) this.wss.close();
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage) {
    let authenticatedAgentId: string | null = null;

    ws.on('message', (data: string | Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        const { type } = msg;

        if (type === 'hello') {
          // Authentication: token must match token_hash in DB
          const { agent_id, token, capabilities, version } = msg;
          const agent = this.engine.db.getAgentById(agent_id) || this.engine.db.getAgentByName(agent_id);
          if (!agent) {
            ws.send(JSON.stringify({ type: 'error', message: `Unknown agent '${agent_id}'` }));
            ws.close();
            return;
          }

          const tokenHash = this.engine.hashToken(token);
          if (tokenHash !== agent.token_hash) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid authentication token' }));
            ws.close();
            return;
          }

          // If capabilities provided in hello, update agent capabilities in DB
          if (Array.isArray(capabilities) && capabilities.length > 0) {
            this.engine.db.db.prepare('UPDATE agents SET capabilities = ? WHERE id = ?').run(
              JSON.stringify(capabilities),
              agent.id
            );
          }

          // If listener explicitly provides version or kind === 'listener'
          const agentKind = msg.kind || (version ? 'listener' : agent.kind || 'sdk');
          this.engine.db.db.prepare('UPDATE agents SET kind = ? WHERE id = ?').run(agentKind, agent.id);

          authenticatedAgentId = agent.id;
          this.connections.set(agent.id, {
            agentId: agent.id,
            agentName: agent.name,
            ws,
            lastHeartbeat: Date.now(),
            currentTasks: new Set(),
          });

          this.engine.db.setAgentOnline(agent.id, true);
          // SDK and command agents are listening immediately; listener agents report presence explicitly
          if (agentKind !== 'listener') {
            this.engine.db.setAgentListening(agent.id, true);
          }

          ws.send(JSON.stringify({ type: 'ack', status: 'authenticated', agent_id: agent.id }));

          // Check if any pending tasks waiting for this agent
          this.checkPendingTasks(agent.id);
          return;
        }

        if (!authenticatedAgentId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthenticated. Send hello first.' }));
          ws.close();
          return;
        }

        const conn = this.connections.get(authenticatedAgentId);
        if (conn) {
          conn.lastHeartbeat = Date.now();
        }

        if (type === 'presence') {
          // Presence update from listener agent (listening: true/false or status: 'listening'|'connected')
          const isListening = msg.listening === true || msg.status === 'listening';
          this.engine.db.setAgentListening(authenticatedAgentId, isListening);
          return;
        }

        if (type === 'pong' || type === 'ping') {
          if (type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          return;
        }

        if (type === 'ack') {
          // Task acknowledged by agent
          const { task_id } = msg;
          if (task_id) {
            this.engine.db.updateTask(task_id, { status: 'running' });
            conn?.currentTasks.add(task_id);
          }
          return;
        }

        if (type === 'progress') {
          const { task_id, text, percent, eta_seconds, partial_output } = msg;
          if (task_id) {
            this.engine.db.updateTask(task_id, {
              status: 'running',
              progress_text: text || null,
              progress_percent: typeof percent === 'number' ? percent : null,
              progress_eta_seconds: typeof eta_seconds === 'number' ? eta_seconds : null,
              partial_output: partial_output || null,
            });
          }
          return;
        }

        if (type === 'question') {
          // Agent asks a question
          const { task_id, question, to } = msg;
          const task = this.engine.db.getTask(task_id);
          if (task) {
            // Post question message to room
            const qMsg = this.engine.db.addMessage({
              room_id: task.room_id,
              sender: conn?.agentName || authenticatedAgentId,
              recipient: to || 'all',
              type: 'question',
              content: question,
            });

            this.engine.db.updateTask(task_id, {
              status: 'needs_input',
              progress_text: `Agent asked question: ${question}`,
            });

            // Ack to agent with question_id
            ws.send(JSON.stringify({
              type: 'question_ack',
              task_id,
              message_id: qMsg.id,
            }));
          }
          return;
        }

        if (type === 'result') {
          const { task_id, result } = msg;
          const task = this.engine.db.getTask(task_id);
          if (task) {
            this.engine.db.addMessage({
              room_id: task.room_id,
              sender: conn?.agentName || authenticatedAgentId,
              recipient: 'all',
              type: 'result',
              content: typeof result === 'string' ? result : JSON.stringify(result),
            });

            this.engine.db.updateTask(task_id, {
              status: 'done',
              result: typeof result === 'string' ? result : JSON.stringify(result),
            });

            conn?.currentTasks.delete(task_id);
          }
          return;
        }

        if (type === 'error') {
          const { task_id, error } = msg;
          if (task_id) {
            const task = this.engine.db.getTask(task_id);
            if (task) {
              this.engine.db.addMessage({
                room_id: task.room_id,
                sender: conn?.agentName || authenticatedAgentId,
                recipient: 'all',
                type: 'error',
                content: error || 'Agent encountered an error',
              });

              this.engine.db.updateTask(task_id, {
                status: 'error',
                result: error || 'Error',
              });

              conn?.currentTasks.delete(task_id);
            }
          }
          return;
        }
      } catch (err: any) {
        console.error('Agent WS parse error:', err);
      }
    });

    ws.on('close', () => {
      if (authenticatedAgentId) {
        this.handleDisconnect(authenticatedAgentId);
      }
    });

    ws.on('error', (err) => {
      console.error(`Agent WS error for ${authenticatedAgentId}:`, err);
    });
  }

  private handleDisconnect(agentId: string) {
    const conn = this.connections.get(agentId);
    if (!conn) return;

    this.engine.db.setAgentOnline(agentId, false);
    this.connections.delete(agentId);

    // Requeue or mark error for tasks that were in running state
    for (const taskId of conn.currentTasks) {
      const task = this.engine.db.getTask(taskId);
      if (task && (task.status === 'running' || task.status === 'pending')) {
        if (task.retries < 2) {
          console.log(`Requeueing task ${taskId} (retry ${task.retries + 1}/2)`);
          this.engine.db.updateTask(taskId, {
            status: 'pending',
            retries: task.retries + 1,
          });
        } else {
          console.log(`Task ${taskId} reached max retries, setting error.`);
          this.engine.db.updateTask(taskId, {
            status: 'error',
            result: 'Agent disconnected unexpectedly and max retries exceeded',
          });
        }
      }
    }
  }

  private checkHeartbeats() {
    const now = Date.now();
    for (const [agentId, conn] of this.connections.entries()) {
      if (now - conn.lastHeartbeat > 40000) {
        // Over 40s with no ping/pong -> terminate connection
        console.log(`Agent ${agentId} heartbeat timeout. Closing.`);
        conn.ws.terminate();
        this.handleDisconnect(agentId);
      } else {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify({ type: 'ping' }));
        }
      }
    }
  }

  public dispatchTask(task: Task) {
    const conn = this.connections.get(task.agent_id);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      // Agent not online; remains pending in DB
      return;
    }

    conn.currentTasks.add(task.id);
    conn.ws.send(
      JSON.stringify({
        type: 'task',
        task_id: task.id,
        room_id: task.room_id,
        prompt: task.prompt,
      })
    );
  }

  public notifyCancel(taskId: string) {
    for (const conn of this.connections.values()) {
      if (conn.currentTasks.has(taskId)) {
        if (conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.send(JSON.stringify({ type: 'cancel', task_id: taskId }));
        }
        conn.currentTasks.delete(taskId);
      }
    }
  }

  public checkPendingTasks(agentId: string) {
    const pendingTasks = this.engine.db.db
      .prepare(`SELECT * FROM tasks WHERE agent_id = ? AND status = 'pending' ORDER BY created_at ASC`)
      .all(agentId) as Task[];

    for (const task of pendingTasks) {
      this.dispatchTask(task);
    }
  }
}
