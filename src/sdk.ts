import WebSocket from 'ws';

export interface BridgeContext {
  taskId: string;
  roomId: string;
  prompt: string;
  progress: (text: string, percent?: number, etaSeconds?: number, partialOutput?: string) => Promise<void>;
  ask: (question: string, to?: string, timeoutMs?: number) => Promise<string>;
  notify: (message: string, to?: string) => Promise<void>;
}

export type TaskHandler = (ctx: BridgeContext) => Promise<string> | string;

export class BridgeAgentNode {
  private agentId: string;
  private token: string;
  private bridgeWsUrl: string;
  private handler: TaskHandler | null = null;
  private ws: WebSocket | null = null;
  private pendingQuestions: Map<string, { resolve: (ans: string) => void; reject: (err: any) => void }> = new Map();
  private running = false;

  constructor(options: { agentId: string; token: string; bridgeWsUrl?: string }) {
    this.agentId = options.agentId;
    this.token = options.token;
    this.bridgeWsUrl = options.bridgeWsUrl || 'ws://127.0.0.1:3001/agent/ws';
  }

  public onTask(handler: TaskHandler) {
    this.handler = handler;
  }

  public async start(): Promise<void> {
    this.running = true;
    this.connect();
  }

  public stop() {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect() {
    if (!this.running) return;

    this.ws = new WebSocket(this.bridgeWsUrl);

    this.ws.on('open', () => {
      this.send({
        type: 'hello',
        agent_id: this.agentId,
        token: this.token,
      });
    });

    this.ws.on('message', async (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') {
          this.send({ type: 'pong' });
        } else if (msg.type === 'task') {
          this.handleTask(msg);
        } else if (msg.type === 'answer') {
          const waiter = this.pendingQuestions.get(msg.task_id);
          if (waiter) {
            waiter.resolve(msg.answer);
            this.pendingQuestions.delete(msg.task_id);
          }
        }
      } catch (e) {
        console.error('Error handling WS message in agent:', e);
      }
    });

    this.ws.on('close', () => {
      if (this.running) {
        setTimeout(() => this.connect(), 1000);
      }
    });

    this.ws.on('error', (err) => {
      // Reconnect will happen on close
    });
  }

  private send(payload: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private async handleTask(taskMsg: { task_id: string; room_id: string; prompt: string }) {
    const { task_id, room_id, prompt } = taskMsg;
    this.send({ type: 'ack', task_id });

    const ctx: BridgeContext = {
      taskId: task_id,
      roomId: room_id,
      prompt,
      progress: async (text, percent, etaSeconds, partialOutput) => {
        this.send({
          type: 'progress',
          task_id,
          text,
          percent,
          eta_seconds: etaSeconds,
          partial_output: partialOutput,
        });
      },
      ask: async (question, to = 'caller', timeoutMs = 60000) => {
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingQuestions.delete(task_id);
            reject(new Error(`Timeout waiting for answer to: "${question}"`));
          }, timeoutMs);

          this.pendingQuestions.set(task_id, {
            resolve: (ans) => {
              clearTimeout(timer);
              resolve(ans);
            },
            reject: (err) => {
              clearTimeout(timer);
              reject(err);
            },
          });

          this.send({
            type: 'question',
            task_id,
            question,
            to,
          });
        });
      },
      notify: async (message, to = 'all') => {
        this.send({
          type: 'progress',
          task_id,
          text: `Notification to ${to}: ${message}`,
          partial_output: message,
        });
      },
    };

    try {
      if (!this.handler) throw new Error('No task handler registered');
      const result = await this.handler(ctx);
      this.send({
        type: 'result',
        task_id,
        result,
      });
    } catch (err: any) {
      this.send({
        type: 'error',
        task_id,
        error: err?.message || String(err),
      });
    }
  }
}
