# Bridge: Bidirectional LLM-to-Agent Service

Bridge connects text-only cloud chat models (Claude, ChatGPT) with local AI agents executing on your laptop through tool calls in both directions.

---

## 1. Architecture Overview

```
                                  CLOUD INTERNET
                     Claude Custom Connector / ChatGPT Actions
                                        │
                                        ▼
                     Cloudflare Tunnel (Single Public Ingress)
                                        │
┌───────────────────────────────────────┼────────────────────────────────────────┐
│ LAPTOP (LOCAL MACHINE)                │                                        │
│                                       ▼                                        │
│                        PUBLIC LISTENER (Port 3000)                             │
│       ┌────────────────────────────────────────────────────────┐               │
│       │ • /mcp (Streamable HTTP MCP with OAuth 2.1 PKCE)       │               │
│       │ • /api/* (5 Tools: list_agents, send, listen, etc.)    │               │
│       │ • /openapi.json (OpenAPI 3.1 Spec)                     │               │
│       │ • /paste (Copy-Paste UI Fallback)                      │               │
│       │ • /room/:id/view?key=... (Read-Only Text Feed)         │               │
│       │ • Rate Limiting & Payload Size Protection              │               │
│       └───────────────────────────┬────────────────────────────┘               │
│                                   │                                            │
│                                   ▼                                            │
│                          SHARED BRIDGE ENGINE                                  │
│                 (Loop Protection, Untrusted Tagging,                           │
│                  Idempotency, Room Budget, SQLite DB)                          │
│                                   │                                            │
│       ┌───────────────────────────┴────────────────────────────┐               │
│       │                                                        │               │
│       ▼                                                        ▼               │
│ LOCAL LISTENER (127.0.0.1:3001)                      LOCAL AGENT HUB (WS)      │
│ • /admin (Admin Dashboard)                           • ws://127.0.0.1:3001     │
│ • Kill-Switch Management                               /agent/ws               │
│ • Approval Queue                                               │               │
│ • Token Rotation                                               ▼               │
│                                                   Local Agents (Python / Node) │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Hard Constraints & Model Safety Design

1. **Passive Turn Model**: Models poll via `listen` or `check_inbox`. Agents never push directly into chat windows.
2. **28-Second Tool Call Cap**: Cloud tool calls time out in 30–60s. Bridge strictly limits tool execution time to 28s and long-polls asynchronously.
3. **5 Compact Tools**: Exactly 5 tools are exposed across MCP and REST (`list_agents`, `send`, `listen`, `check_inbox`, `cancel`).
4. **Untrusted Agent Output Wrapping**: Untrusted content is wrapped in `<message from="NAME" untrusted="true">...</message>` with strict prompt-injection warnings.
5. **Two-Listener Isolation**: Admin dashboard and agent WebSocket endpoints are bound strictly to `127.0.0.1` and physically unroutable from the public port.

---

## 3. Quick Start

### 1. Install & Configure
```bash
npm install
cp .env.example .env
```

### 2. Run Bridge
```bash
npm run bridge start
```

This single command:
1. Recovers dangling tasks from SQLite WAL storage.
2. Starts the public listener on port `3000`.
3. Starts the local listener & agent hub on `127.0.0.1:3001`.
4. Spawns agents configured in `agents.yaml`.
5. Prints all connector URLs and endpoints.

---

## 4. Cloudflare Tunnel Configuration

### Option A: Custom Domain (Recommended & Stable)
1. Log in via browser:
   ```bash
   cloudflared tunnel login
   ```
2. Create tunnel:
   ```bash
   cloudflared tunnel create bridge
   cloudflared tunnel route dns bridge bridge.YOURDOMAIN.COM
   ```
3. Run tunnel targeting port 3000:
   ```bash
   cloudflared tunnel run bridge
   ```
4. Set `PUBLIC_BASE_URL=https://bridge.YOURDOMAIN.COM` in `.env`.

### Option B: Quick Tunnel (Testing Only)
Set in `.env`:
```env
CLOUDFLARE_TUNNEL_MODE=quick
```
*Note: Quick tunnels provide ephemeral URLs (`*.trycloudflare.com`) that change on every restart.*

---

## 5. Laptop Caveats & Reliability

- **Prevent Sleep / Lid Closing**:
  - Windows: Use `powercfg /change standby-timeout-ac 0` or keep plugged in with display sleep only.
  - macOS: Run `caffeinate -d -s -u`.
- **Network Changes**: If your local IP changes, cloudflared maintains outbound connections automatically without needing port-forwarding.
- **Key Rotation**: Rotate `BRIDGE_API_KEY` and `ADMIN_PASSWORD` in `.env` and restart.

---

## 6. Testing

Run all unit and integration test suites:
```bash
npm test
```
Passing test suites:
- Phase 1: SQLite Engine, WS Agent Hub, SDKs, untrusted wrapping.
- Phase 2: REST adapter, OpenAPI 3.1, 28s cap, slow agent progression & 5-poll fallback.
- Phase 3: Interactive questions (`ctx.ask`), `needs_input`, inbox checking, loop protection.
- Phase 4: Two-listener route isolation, rate limits, sensitive action approvals.
- Phase 6: MCP adapter, OAuth 2.1 PKCE, dynamic client registration.
- Phase 7: Local admin dashboard, `/paste` fallback, and `/room/:id/view`.
