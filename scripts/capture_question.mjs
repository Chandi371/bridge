import crypto from 'crypto';
import Database from 'better-sqlite3';
import { WebSocket } from 'ws';
import http from 'http';

const db = new Database('./bridge.sqlite');
const token = 'qa_token_secret_123';
const token_hash = crypto.createHash('sha256').update(token).digest('hex');

db.prepare(`
  INSERT OR REPLACE INTO agents (id, name, description, capabilities, expected_duration, token_hash, online, last_seen, require_approval, enabled)
  VALUES ('qa-agent', 'qa_agent', 'Agent that asks clarifying questions', '["qa"]', 'fast <10s', ?, 0, 0, 0, 1)
`).run(token_hash);

const ws = new WebSocket('ws://127.0.0.1:3001/agent/ws');
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'hello', agent_id: 'qa-agent', token }));
});

ws.on('message', (d) => {
  const msg = JSON.parse(d.toString());
  if (msg.type === 'task') {
    ws.send(JSON.stringify({ type: 'ack', task_id: msg.task_id }));
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'question',
        task_id: msg.task_id,
        question: 'Which target environment should I run migrations against: staging or production?',
        to: 'caller',
      }));
    }, 400);
  }
});

setTimeout(() => {
  const sendData = JSON.stringify({ to: 'qa_agent', content: 'Run database updates', wait_seconds: 3 });
  const req = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/send',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer test-bridge-api-key-secret-123',
      'Content-Length': Buffer.byteLength(sendData),
    },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log('REAL_QUESTION_RES:', body);
      ws.close();
      process.exit(0);
    });
  });
  req.write(sendData);
  req.end();
}, 1000);
