# REPORT.md: Bridge Architecture & Connector Verification

## 1. System Architecture

Bridge mediates between cloud chat models and local laptop agents with safety isolation:
- **Public Port (3000)**: Cloudflare Tunnel ingress -> `/mcp`, `/api/*`, `/openapi.json`, `/paste`, `/room/:id/view`, OAuth endpoints.
- **Local Port (3001)**: Bound strictly to `127.0.0.1` -> `/admin` Dashboard, `/agent/ws` WebSocket hub, Approval Queue.

---

## 2. Model-Facing Tools (Exact Schemas)

1. `list_agents`
   - **Input**: `{}`
   - **Output**: `[{ "id": string, "name": string, "description": string, "capabilities": string[], "expected_duration": string, "online": boolean, "last_seen": number | null }]`

2. `send`
   - **Input**:
     ```json
     {
       "to": "string (agent name)",
       "content": "string (prompt or reply)",
       "room_id": "optional string",
       "reply_to": "optional string (question msg id)",
       "client_request_id": "optional string",
       "wait_seconds": "optional number (default 25, clamped to 28)"
     }
     ```
   - **Output**:
     ```json
     {
       "room_id": "string",
       "task_id": "optional string",
       "status": "running | needs_input | done | idle | approval_required",
       "messages": [{ "id": string, "seq": number, "sender": string, "type": string, "content": string }],
       "next_step": "string"
     }
     ```

3. `listen`
   - **Input**:
     ```json
     {
       "room_id": "optional string",
       "task_id": "optional string",
       "wait_seconds": "optional number (default 25, clamped to 28)",
       "cursor": "optional number"
     }
     ```
   - **Output**:
     ```json
     {
       "status": "message | needs_input | running | done | idle",
       "messages": [{ "id": string, "seq": number, "sender": string, "type": string, "content": string }],
       "progress": { "text": string, "percent": number, "eta_seconds": number },
       "partial_output": "string",
       "truncated": boolean,
       "cursor": number,
       "next_step": "string"
     }
     ```

4. `check_inbox`
   - **Input**: `{ "status": "optional string", "limit": "optional number (default 5)" }`
   - **Output**:
     ```json
     {
       "unanswered_questions": [{ "id": string, "room_id": string, "sender": string, "content": string, "action": string }],
       "recent_tasks": [{ "id": string, "room_id": string, "agent_id": string, "status": string, "progress": string, "next_step": string }],
       "recent_messages": [{ "id": string, "room_id": string, "sender": string, "type": string, "content": string }],
       "next_step": "string"
     }
     ```

5. `cancel`
   - **Input**: `{ "task_id": "string" }`
   - **Output**: `{ "success": boolean, "task_id": "string", "message": "string" }`

---

## 3. Exact next_step Directive Strings

- **Task running**:
  `"Task still running. This is NOT the final answer. Call listen with task_id <ID> again immediately. Do not answer the user yet."`
- **Question pending**:
  `"The agent asked you a question. Answer it with send(reply_to=\"<MSG_ID>\", ...). Do not ask the user unless you truly cannot answer."`
- **Done**:
  `"Task complete. Summarize the result for the user."`
- **5 Consecutive Polls Fallback**:
  `"This is taking long. Tell the user the room_id/task_id and that it is still running; offer to check again when they ask."`

---

## 4. Setup in Claude & ChatGPT

### Claude Custom Connector (Remote MCP)
1. Go to Claude Settings -> **Connectors / Integrations** -> **Add Custom Connector**.
2. **Server URL**: `<PUBLIC_BASE_URL>/mcp`
3. **Authentication**: Choose **OAuth 2.1**.
4. Claude automatically queries `/.well-known/oauth-authorization-server`, registers dynamically via `/oauth/register`, and displays the Bridge approval login window.
5. Enter your Master Admin Password to grant authorization.

### ChatGPT Custom GPT Action
1. Open the GPT Builder -> **Configure** -> **Actions** -> **Create new action**.
2. Choose **Import from URL** and enter:
   `<PUBLIC_BASE_URL>/openapi.json`
3. Set **Authentication**: **API Key**, Auth Type: **Bearer**, and paste your `BRIDGE_API_KEY`.
4. ChatGPT will register all 5 tools (`list_agents`, `send`, `listen`, `check_inbox`, `cancel`).
