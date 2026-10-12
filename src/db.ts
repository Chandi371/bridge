import Database from 'better-sqlite3';
import { Agent, Room, Participant, Message, Task } from './types.js';

export class BridgeDatabase {
  public db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT NOT NULL,
        capabilities TEXT NOT NULL, -- JSON array
        expected_duration TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER,
        require_approval INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        message_count INTEGER NOT NULL DEFAULT 0,
        max_messages INTEGER NOT NULL DEFAULT 50,
        max_consecutive_turns INTEGER NOT NULL DEFAULT 10,
        consecutive_turns INTEGER NOT NULL DEFAULT 0,
        require_approval INTEGER NOT NULL DEFAULT 0,
        spend_cap_cents INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS participants (
        room_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        verified_identity TEXT NOT NULL,
        read_cursor INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (room_id, name),
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        room_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        reply_to TEXT,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, seq);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        result TEXT,
        progress_text TEXT,
        progress_percent REAL,
        progress_eta_seconds INTEGER,
        partial_output TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        retries INTEGER NOT NULL DEFAULT 0,
        client_request_id TEXT UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ttl_seconds INTEGER NOT NULL DEFAULT 1800,
        FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_client_request ON tasks(client_request_id);

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL, -- 'task' | 'message'
        target_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
        details TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // --- Agents ---
  upsertAgent(agent: Omit<Agent, 'capabilities'> & { capabilities: string[] }) {
    const stmt = this.db.prepare(`
      INSERT INTO agents (id, name, description, capabilities, expected_duration, token_hash, online, last_seen, require_approval, enabled)
      VALUES (@id, @name, @description, @capabilities, @expected_duration, @token_hash, @online, @last_seen, @require_approval, @enabled)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        capabilities = excluded.capabilities,
        expected_duration = excluded.expected_duration,
        token_hash = excluded.token_hash,
        require_approval = excluded.require_approval,
        enabled = excluded.enabled
    `);
    stmt.run({
      ...agent,
      capabilities: JSON.stringify(agent.capabilities),
    });
  }

  getAgentById(id: string): (Agent & { capabilities: string[] }) | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
    if (!row) return null;
    return {
      ...row,
      capabilities: JSON.parse(row.capabilities),
    };
  }

  getAgentByName(name: string): (Agent & { capabilities: string[] }) | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(name) as any;
    if (!row) return null;
    return {
      ...row,
      capabilities: JSON.parse(row.capabilities),
    };
  }

  listAgents(): (Agent & { capabilities: string[] })[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE enabled = 1').all() as any[];
    return rows.map((r) => ({
      ...r,
      capabilities: JSON.parse(r.capabilities),
    }));
  }

  setAgentOnline(id: string, online: boolean) {
    const now = Date.now();
    this.db.prepare('UPDATE agents SET online = ?, last_seen = ? WHERE id = ?').run(
      online ? 1 : 0,
      now,
      id
    );
  }

  // --- Rooms ---
  getOrCreateRoom(roomId?: string, title?: string): Room {
    const id = roomId || `room_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const existing = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Room | undefined;
    if (existing) return existing;

    const now = Date.now();
    const newRoom: Room = {
      id,
      title: title || `Room ${id}`,
      status: 'active',
      message_count: 0,
      max_messages: 50,
      max_consecutive_turns: 10,
      consecutive_turns: 0,
      require_approval: 0,
      spend_cap_cents: 100,
      created_at: now,
      updated_at: now,
    };
    this.db.prepare(`
      INSERT INTO rooms (id, title, status, message_count, max_messages, max_consecutive_turns, consecutive_turns, require_approval, spend_cap_cents, created_at, updated_at)
      VALUES (@id, @title, @status, @message_count, @max_messages, @max_consecutive_turns, @consecutive_turns, @require_approval, @spend_cap_cents, @created_at, @updated_at)
    `).run(newRoom);
    return newRoom;
  }

  getRoom(id: string): Room | null {
    return (this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as Room) || null;
  }

  updateRoomStatus(id: string, status: 'active' | 'paused' | 'ended') {
    this.db.prepare('UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id);
  }

  // --- Participants ---
  addParticipant(room_id: string, name: string, kind: 'model' | 'agent' | 'human', verified_identity: string): Participant {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO participants (room_id, name, kind, verified_identity, read_cursor)
      VALUES (?, ?, ?, ?, 0)
    `);
    stmt.run(room_id, name, kind, verified_identity);
    return this.db.prepare('SELECT * FROM participants WHERE room_id = ? AND name = ?').get(room_id, name) as Participant;
  }

  getParticipant(room_id: string, name: string): Participant | null {
    return (this.db.prepare('SELECT * FROM participants WHERE room_id = ? AND name = ?').get(room_id, name) as Participant) || null;
  }

  updateReadCursor(room_id: string, name: string, cursor: number) {
    this.db.prepare('UPDATE participants SET read_cursor = ? WHERE room_id = ? AND name = ?').run(cursor, room_id, name);
  }

  // --- Messages ---
  addMessage(msg: {
    room_id: string;
    sender: string;
    recipient: string;
    reply_to?: string | null;
    type: Message['type'];
    content: string;
  }): Message {
    const now = Date.now();
    const id = `msg_${now}_${Math.random().toString(36).substring(2, 7)}`;
    
    const insertTransaction = this.db.transaction(() => {
      const room = this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(msg.room_id) as Room;
      if (!room) throw new Error(`Room not found: ${msg.room_id}`);

      const nextSeq = room.message_count + 1;
      this.db.prepare(`
        INSERT INTO messages (id, seq, room_id, sender, recipient, reply_to, type, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, nextSeq, msg.room_id, msg.sender, msg.recipient, msg.reply_to || null, msg.type, msg.content, now);

      this.db.prepare('UPDATE rooms SET message_count = ?, updated_at = ? WHERE id = ?').run(nextSeq, now, msg.room_id);

      return {
        id,
        seq: nextSeq,
        room_id: msg.room_id,
        sender: msg.sender,
        recipient: msg.recipient,
        reply_to: msg.reply_to || null,
        type: msg.type,
        content: msg.content,
        created_at: now,
      } as Message;
    });

    return insertTransaction();
  }

  getMessages(room_id: string, sinceSeq = 0, limit = 50): Message[] {
    return this.db.prepare(`
      SELECT * FROM messages
      WHERE room_id = ? AND seq > ?
      ORDER BY seq ASC
      LIMIT ?
    `).all(room_id, sinceSeq, limit) as Message[];
  }

  getMessageById(id: string): Message | null {
    return (this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message) || null;
  }

  // --- Tasks ---
  createTask(task: {
    room_id: string;
    agent_id: string;
    prompt: string;
    client_request_id?: string | null;
    ttl_seconds?: number;
  }): Task {
    const now = Date.now();
    const id = `task_${now}_${Math.random().toString(36).substring(2, 7)}`;
    const newTask: Task = {
      id,
      room_id: task.room_id,
      agent_id: task.agent_id,
      prompt: task.prompt,
      result: null,
      progress_text: null,
      progress_percent: null,
      progress_eta_seconds: null,
      partial_output: null,
      status: 'pending',
      retries: 0,
      client_request_id: task.client_request_id || null,
      created_at: now,
      updated_at: now,
      ttl_seconds: task.ttl_seconds || 1800,
    };

    this.db.prepare(`
      INSERT INTO tasks (id, room_id, agent_id, prompt, result, progress_text, progress_percent, progress_eta_seconds, partial_output, status, retries, client_request_id, created_at, updated_at, ttl_seconds)
      VALUES (@id, @room_id, @agent_id, @prompt, @result, @progress_text, @progress_percent, @progress_eta_seconds, @partial_output, @status, @retries, @client_request_id, @created_at, @updated_at, @ttl_seconds)
    `).run(newTask);

    return newTask;
  }

  getTask(id: string): Task | null {
    return (this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Task) || null;
  }

  getTaskByClientRequestId(clientRequestId: string): Task | null {
    return (this.db.prepare('SELECT * FROM tasks WHERE client_request_id = ?').get(clientRequestId) as Task) || null;
  }

  updateTask(id: string, updates: Partial<Task>) {
    const fields = Object.keys(updates).filter((k) => k !== 'id');
    if (fields.length === 0) return;
    fields.push('updated_at');
    const setClause = fields.map((f) => `${f} = @${f}`).join(', ');
    const params = {
      ...updates,
      id,
      updated_at: Date.now(),
    };
    this.db.prepare(`UPDATE tasks SET ${setClause} WHERE id = @id`).run(params);
  }

  getActiveTasksForAgent(agentId: string): Task[] {
    return this.db.prepare(`
      SELECT * FROM tasks
      WHERE agent_id = ? AND status IN ('pending', 'running', 'needs_input')
    `).all(agentId) as Task[];
  }

  recoverDanglingTasks(): number {
    // If running when restarted, revert to pending so they can be re-dispatched, or requeue
    const result = this.db.prepare(`
      UPDATE tasks
      SET status = 'pending', updated_at = ?
      WHERE status = 'running'
    `).run(Date.now());
    return result.changes;
  }

  // --- Inbox & Queries ---
  getInbox(status?: string, limit = 5): {
    unread_messages: Message[];
    questions: Message[];
    recent_tasks: Task[];
  } {
    // Questions needing answer
    const questions = this.db.prepare(`
      SELECT * FROM messages
      WHERE type = 'question'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Message[];

    // Recent tasks
    let taskQuery = `SELECT * FROM tasks`;
    const taskParams: any[] = [];
    if (status) {
      taskQuery += ` WHERE status = ?`;
      taskParams.push(status);
    }
    taskQuery += ` ORDER BY updated_at DESC LIMIT ?`;
    taskParams.push(limit);
    const recent_tasks = this.db.prepare(taskQuery).all(...taskParams) as Task[];

    // Recent messages
    const unread_messages = this.db.prepare(`
      SELECT * FROM messages
      WHERE type IN ('message', 'result', 'error')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Message[];

    return {
      unread_messages,
      questions,
      recent_tasks,
    };
  }
}
