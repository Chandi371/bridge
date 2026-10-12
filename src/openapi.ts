export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Bridge API",
    version: "1.0.0",
    description: "Connect cloud chat models with local AI agents via tool calls in both directions."
  },
  servers: [
    {
      url: "http://localhost:3000",
      description: "Bridge Public Server"
    }
  ],
  paths: {
    "/api/list_agents": {
      get: {
        operationId: "list_agents",
        summary: "List all available agents and their status",
        description: "Call this first. Returns registered agents with capability tags, duration expectations, online (connected) status, listening presence, and last_claim_at.",
        responses: {
          "200": {
            "description": "Agent list",
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "properties": {
                      "id": { "type": "string" },
                      "name": { "type": "string" },
                      "description": { "type": "string" },
                      "capabilities": { "type": "array", "items": { "type": "string" } },
                      "expected_duration": { "type": "string" },
                      "online": { "type": "boolean", "description": "Whether WebSocket connection is alive" },
                      "listening": { "type": "boolean", "description": "Whether agent called claim_task within last 60s" },
                      "last_claim_at": { "type": ["number", "null"] },
                      "kind": { "type": "string" },
                      "last_seen": { "type": ["number", "null"] }
                    },
                    "required": ["id", "name", "description", "capabilities", "expected_duration", "online", "listening"]
                  }
                }
              }
            }
          }
        }
      }
    },
    "/api/send": {
      post: {
        operationId: "send",
        summary: "Send a message or start a task",
        description: "Dispatches a message/task to an agent or participant. Waits up to wait_seconds (max 28s). If status is 'running', call listen with task_id until done; do not answer the user before then.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "to": { "type": "string", "description": "Agent or participant name" },
                  "content": { "type": "string", "description": "Message prompt or reply" },
                  "room_id": { "type": "string", "description": "Optional room ID" },
                  "reply_to": { "type": "string", "description": "Optional message ID being answered" },
                  "client_request_id": { "type": "string", "description": "Optional client idempotency ID" },
                  "wait_seconds": { "type": "number", "default": 25, "maximum": 28, "description": "Wait seconds (max 28)" }
                },
                "required": ["to", "content"]
              }
            }
          }
        },
        responses: {
          "200": {
            "description": "Task or message status",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "room_id": { "type": "string" },
                    "task_id": { "type": "string" },
                    "status": { "type": "string" },
                    "messages": { "type": "array" },
                    "next_step": { "type": "string" }
                  },
                  "required": ["room_id", "status", "messages", "next_step"]
                }
              }
            }
          }
        }
      }
    },
    "/api/listen": {
      post: {
        operationId: "listen",
        summary: "Long-poll for task updates or room activity",
        description: "Waits up to wait_seconds (max 28s) for task results, progress, or incoming messages. If status is 'running', call listen with task_id until done; do not answer the user before then.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "room_id": { "type": "string" },
                  "task_id": { "type": "string" },
                  "wait_seconds": { "type": "number", "default": 25, "maximum": 28 },
                  "cursor": { "type": "number" }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            "description": "Listen poll result",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "status": { "type": "string" },
                    "messages": { "type": "array" },
                    "progress": { "type": ["object", "null"] },
                    "partial_output": { "type": ["string", "null"] },
                    "truncated": { "type": "boolean" },
                    "cursor": { "type": "number" },
                    "next_step": { "type": "string" }
                  },
                  "required": ["status", "messages", "truncated", "next_step"]
                }
              }
            }
          }
        }
      }
    },
    "/api/check_inbox": {
      get: {
        operationId: "check_inbox",
        summary: "Check unread messages and unanswered questions",
        description: "Returns unread messages, questions awaiting answers, and recent tasks.",
        parameters: [
          {
            name: "status",
            in: "query",
            required: false,
            schema: { type: "string" }
          },
          {
            name: "limit",
            in: "query",
            required: false,
            schema: { type: "number", default: 5 }
          }
        ],
        responses: {
          "200": {
            "description": "Inbox summary",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "unanswered_questions": { "type": "array" },
                    "recent_tasks": { "type": "array" },
                    "recent_messages": { "type": "array" },
                    "next_step": { "type": "string" }
                  },
                  "required": ["unanswered_questions", "recent_tasks", "recent_messages", "next_step"]
                }
              }
            }
          }
        }
      }
    },
    "/api/cancel": {
      post: {
        operationId: "cancel",
        summary: "Cancel a running task",
        description: "Cancels the specified task.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              "schema": {
                "type": "object",
                "properties": {
                  "task_id": { "type": "string" }
                },
                "required": ["task_id"]
              }
            }
          }
        },
        responses: {
          "200": {
            "description": "Cancellation status",
            "content": {
              "application/json": {
                "schema": {
                  "type": "object",
                  "properties": {
                    "success": { "type": "boolean" },
                    "task_id": { "type": "string" },
                    "message": { "type": "string" }
                  },
                  "required": ["success", "task_id", "message"]
                }
              }
            }
          }
        }
      }
    }
  }
};
