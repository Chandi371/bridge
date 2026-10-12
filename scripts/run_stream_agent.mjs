import crypto from 'crypto';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';

const db = new Database('./bridge.sqlite');
const token = 'stream_token_secret_123';
const token_hash = crypto.createHash('sha256').update(token).digest('hex');

db.prepare(`
  INSERT OR REPLACE INTO agents (id, name, description, capabilities, expected_duration, token_hash, online, last_seen, require_approval, enabled)
  VALUES ('stream-agent', 'stream_agent', 'Slow Node SDK agent reporting progress and partial output', '["streaming"]', 'slow 1-3 min', ?, 0, 0, 0, 1)
`).run(token_hash);

const ws = new WebSocket('ws://127.0.0.1:3001/agent/ws');

ws.on('open', () => {
  console.log('[StreamAgent] WebSocket opened, sending hello');
  ws.send(JSON.stringify({ type: 'hello', agent_id: 'stream-agent', token }));
});

ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  console.log('[StreamAgent] Message:', msg.type);
  if (msg.type === 'task') {
    ws.send(JSON.stringify({ type: 'ack', task_id: msg.task_id }));
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'progress',
        task_id: msg.task_id,
        text: 'Phase 1: Ingesting dataset',
        percent: 45,
        eta_seconds: 15,
        partial_output: 'Aggregated interim count: 250 items.',
      }));
    }, 500);

    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'result',
        task_id: msg.task_id,
        result: 'Computation complete. Processed 500 records successfully.',
      }));
    }, 4000);
  }
});
