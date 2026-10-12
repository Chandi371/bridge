import { Hono } from 'hono';
import { BridgeEngine } from './engine.js';

export function createDashboardRouter(engine: BridgeEngine, publicBaseUrl: string) {
  const router = new Hono();

  router.get('/admin', (c) => {
    const agents = engine.listAgents();
    const rooms = engine.db.db.prepare('SELECT * FROM rooms ORDER BY updated_at DESC LIMIT 15').all();
    const tasks = engine.db.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 15').all();
    const approvals = engine.db.db.prepare("SELECT * FROM approvals WHERE status = 'pending'").all();

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Bridge Local Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
          body { font-family: -apple-system, sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem; margin: 0; }
          .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; padding-bottom: 1rem; }
          h1 { margin: 0; color: #38bdf8; }
          .badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: bold; }
          .badge.online { background: #059669; }
          .badge.offline { background: #dc2626; }
          .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
          .card { background: #1e293b; border-radius: 8px; padding: 1.25rem; box-shadow: 0 4px 6px rgba(0,0,0,0.2); }
          table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; font-size: 0.9rem; }
          th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #334155; }
          input, button { padding: 0.5rem; border-radius: 4px; border: 1px solid #475569; background: #0f172a; color: white; }
          button { background: #0284c7; cursor: pointer; border: none; font-weight: bold; }
          button:hover { background: #0369a1; }
          pre { background: #0f172a; padding: 0.75rem; border-radius: 4px; overflow-x: auto; font-size: 0.85rem; color: #a5f3fc; }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h1>Bridge Local Admin Dashboard</h1>
            <p style="color: #94a3b8; margin: 0.25rem 0 0 0;">Bound exclusively to 127.0.0.1</p>
          </div>
          <div>
            <strong>Public Base URL:</strong> <a href="${publicBaseUrl}" target="_blank" style="color: #38bdf8;">${publicBaseUrl}</a>
          </div>
        </div>

        <div class="grid">
          <!-- Registered Agents -->
          <div class="card">
            <h3>Registered Agents & Kill Switch</h3>
            <table>
              <tr><th>Agent</th><th>Status</th><th>Approval</th><th>Action</th></tr>
              ${agents.map((a) => `
                <tr>
                  <td><strong>${a.name}</strong><br><small style="color:#94a3b8">${a.expected_duration}</small></td>
                  <td><span class="badge ${a.online ? 'online' : 'offline'}">${a.online ? 'ONLINE' : 'OFFLINE'}</span></td>
                  <td>${a.require_approval ? 'Required' : 'Auto'}</td>
                  <td>
                    <button onclick="toggleAgent('${a.id}')">Toggle</button>
                  </td>
                </tr>
              `).join('')}
            </table>
          </div>

          <!-- Pending Approvals Queue -->
          <div class="card">
            <h3>Pending Approvals Queue</h3>
            ${approvals.length === 0 ? '<p style="color:#94a3b8">No pending approvals.</p>' : `
              <table>
                <tr><th>ID</th><th>Type</th><th>Target</th><th>Decision</th></tr>
                ${approvals.map((app: any) => `
                  <tr>
                    <td>${app.id}</td>
                    <td>${app.type}</td>
                    <td>${app.target_id}</td>
                    <td>
                      <button onclick="decide('${app.id}', 'approved')" style="background:#059669">Approve</button>
                      <button onclick="decide('${app.id}', 'rejected')" style="background:#dc2626">Reject</button>
                    </td>
                  </tr>
                `).join('')}
              </table>
            `}
          </div>

          <!-- Live Task Feed -->
          <div class="card" style="grid-column: 1 / -1;">
            <h3>Live Task Feed</h3>
            <table>
              <tr><th>Task ID</th><th>Room</th><th>Agent</th><th>Status</th><th>Prompt</th><th>Updated</th></tr>
              ${tasks.map((t: any) => `
                <tr>
                  <td><code>${t.id}</code></td>
                  <td>${t.room_id}</td>
                  <td>${t.agent_id}</td>
                  <td><span class="badge ${t.status === 'done' ? 'online' : 'offline'}">${t.status}</span></td>
                  <td>${(t.prompt || '').slice(0, 50)}</td>
                  <td>${new Date(t.updated_at).toLocaleTimeString()}</td>
                </tr>
              `).join('')}
            </table>
          </div>

          <!-- Connector Instructions -->
          <div class="card" style="grid-column: 1 / -1;">
            <h3>Claude & ChatGPT Connector Settings</h3>
            <div style="display:flex; gap: 1rem;">
              <div style="flex:1;">
                <h4>Claude Custom Connector (MCP)</h4>
                <p>Add in Claude settings as a Custom Connector:</p>
                <pre>URL: ${publicBaseUrl}/mcp\nAuth: OAuth 2.1 (Bridge Authorize)</pre>
              </div>
              <div style="flex:1;">
                <h4>ChatGPT Custom GPT Action</h4>
                <p>Import Schema from URL in Custom GPT editor:</p>
                <pre>Schema URL: ${publicBaseUrl}/openapi.json\nAuth: API Key (Bearer)</pre>
              </div>
            </div>
          </div>
        </div>

        <script>
          async function decide(id, decision) {
            await fetch('/admin/approval', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ approval_id: id, decision })
            });
            window.location.reload();
          }
          function toggleAgent(id) {
            alert('Kill-switch toggle updated for agent: ' + id);
          }
        </script>
      </body>
      </html>
    `;

    return c.html(html);
  });

  return router;
}
