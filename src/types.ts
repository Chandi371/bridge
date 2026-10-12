import { z } from 'zod';

export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  capabilities: z.array(z.string()),
  expected_duration: z.string(), // e.g. "fast <10s" | "slow 1-3 min"
  token_hash: z.string(),
  online: z.number().int().default(0), // 0 or 1 in SQLite
  last_seen: z.number().int().nullable().default(null),
  require_approval: z.number().int().default(0), // 0 or 1
  enabled: z.number().int().default(1), // 0 or 1
});
export type Agent = z.infer<typeof AgentSchema>;

export const RoomStatusSchema = z.enum(['active', 'paused', 'ended']);
export type RoomStatus = z.infer<typeof RoomStatusSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: RoomStatusSchema.default('active'),
  message_count: z.number().int().default(0),
  max_messages: z.number().int().default(50),
  max_consecutive_turns: z.number().int().default(10),
  consecutive_turns: z.number().int().default(0),
  require_approval: z.number().int().default(0),
  spend_cap_cents: z.number().int().default(100),
  created_at: z.number().int(),
  updated_at: z.number().int(),
});
export type Room = z.infer<typeof RoomSchema>;

export const ParticipantKindSchema = z.enum(['model', 'agent', 'human']);
export type ParticipantKind = z.infer<typeof ParticipantKindSchema>;

export const ParticipantSchema = z.object({
  room_id: z.string(),
  name: z.string(),
  kind: ParticipantKindSchema,
  verified_identity: z.string(),
  read_cursor: z.number().int().default(0),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const MessageTypeSchema = z.enum([
  'message',
  'question',
  'answer',
  'progress',
  'result',
  'error',
]);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  room_id: z.string(),
  sender: z.string(),
  recipient: z.string(), // name or "all"
  reply_to: z.string().nullable().default(null),
  type: MessageTypeSchema,
  content: z.string(),
  created_at: z.number().int(),
});
export type Message = z.infer<typeof MessageSchema>;

export const TaskStatusSchema = z.enum([
  'pending',
  'running',
  'needs_input',
  'done',
  'error',
  'cancelled',
  'timeout',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  agent_id: z.string(),
  prompt: z.string(),
  result: z.string().nullable().default(null),
  progress_text: z.string().nullable().default(null),
  progress_percent: z.number().nullable().default(null),
  progress_eta_seconds: z.number().nullable().default(null),
  partial_output: z.string().nullable().default(null),
  status: TaskStatusSchema.default('pending'),
  retries: z.number().int().default(0),
  client_request_id: z.string().nullable().default(null),
  created_at: z.number().int(),
  updated_at: z.number().int(),
  ttl_seconds: z.number().int().default(1800), // 30 min
});
export type Task = z.infer<typeof TaskSchema>;
