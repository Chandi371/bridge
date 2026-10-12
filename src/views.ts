import { Hono } from 'hono';
import { BridgeEngine } from './engine.js';

export function createViewsAndPasteRouter(engine: BridgeEngine, apiKey?: string) {
  const router = new Hono();

  // /room/:id/view?key=SECRET
  router.get('/room/:id/view', (c) => {
    const roomId = c.req.param('id');
    const key = c.req.query('key');

    const room = engine.db.getRoom(roomId);
    if (!room) {
      return c.text(`Room '${roomId}' not found.`, 404);
    }

    // Unguessable revocable key validation
    const expectedKey = engine.hashToken(roomId).slice(0, 16);
    if (!key || key !== expectedKey) {
      return c.text('Invalid or missing room view access key.', 403);
    }

    const messages = engine.db.getMessages(roomId, 0, 100);
    let output = `=== ROOM STATE: ${room.title} (ID: ${room.id}) ===\n`;
    output += `Status: ${room.status} | Messages: ${room.message_count}\n\n`;

    for (const m of messages) {
      const time = new Date(m.created_at).toISOString();
      output += `[${time}] ${m.sender} -> ${m.recipient} (${m.type}):\n${m.content}\n\n`;
    }

    return c.text(output);
  });

  // /paste: Copy-paste fallback page (Protected by key query param or Authorization header)
  router.get('/paste', (c) => {
    const key = c.req.query('key') || c.req.header('x-api-key') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (apiKey && key !== apiKey) {
      return c.text('Unauthorized. Provide valid access key: /paste?key=YOUR_API_KEY', 401);
    }

    const promptSnippet = `You do not have native tool access to the local Bridge server. 
Whenever you wish to interact with agents or query information, respond strictly with a fenced code block:
\`\`\`bridge
{
  "to": "agent_name",
  "content": "your message or question",
  "room_id": "optional_room_id"
}
\`\`\`
I will paste your request into Bridge and paste back the response.`;

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bridge Copy-Paste Fallback</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; max-width: 800px; margin: 0 auto; }
          h1 { color: #38bdf8; }
          textarea { width: 100%; height: 120px; background: #1e293b; color: #fff; border: 1px solid #334155; border-radius: 6px; padding: 1rem; box-sizing: border-box; font-family: monospace; }
          button { background: #0284c7; color: white; border: none; padding: 0.75rem 1.5rem; border-radius: 4px; font-weight: bold; cursor: pointer; margin-top: 0.5rem; }
          button:hover { background: #0369a1; }
          .card { background: #1e293b; padding: 1.5rem; border-radius: 8px; margin-top: 1.5rem; }
          pre { background: #0f172a; padding: 1rem; border-radius: 4px; overflow-x: auto; color: #a5f3fc; }
        </style>
      </head>
      <body>
        <h1>Bridge Copy-Paste Fallback</h1>
        <p>Use this page for chat models with no native tool support (e.g. standard ChatGPT/Claude free web chat).</p>
        
        <div class="card">
          <h3>1. Instructions to Paste to Your Model:</h3>
          <pre>${promptSnippet.replace(/</g, '&lt;')}</pre>
        </div>

        <div class="card">
          <h3>2. Paste Model Output Here:</h3>
          <textarea id="pasteInput" placeholder='Paste the \`\`\`bridge JSON block here...'></textarea>
          <br>
          <button onclick="submitPayload()">Submit to Bridge</button>
        </div>

        <div class="card" id="resultCard" style="display:none;">
          <h3>3. Response (Copy Back to Chat):</h3>
          <pre id="resultOutput"></pre>
          <button onclick="copyResult()">Copy Response</button>
        </div>

        <script>
          const authKey = "${key || ''}";
          async function submitPayload() {
            const raw = document.getElementById('pasteInput').value;
            const match = raw.match(/\`\`\`(?:bridge)?\\s*([\\s\\S]*?)\`\`\`/);
            const jsonText = match ? match[1].trim() : raw.trim();

            try {
              const payload = JSON.parse(jsonText);
              const headers = { 'Content-Type': 'application/json' };
              if (authKey) headers['Authorization'] = 'Bearer ' + authKey;

              const res = await fetch('/api/send', {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
              });
              const data = await res.json();
              document.getElementById('resultOutput').innerText = JSON.stringify(data, null, 2);
              document.getElementById('resultCard').style.display = 'block';
            } catch (err) {
              alert('Error processing payload: ' + err.message);
            }
          }

          function copyResult() {
            const text = document.getElementById('resultOutput').innerText;
            navigator.clipboard.writeText(text);
            alert('Copied to clipboard!');
          }
        </script>
      </body>
      </html>
    `;
    return c.html(html);
  });

  return router;
}
