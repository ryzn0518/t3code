import * as Schema from "effect/Schema";

export const CCDriverDescriptor = Schema.Struct({
  server_id: Schema.String,
  protocol: Schema.Literal("ccdriver-client-v1"),
  capabilities: Schema.Struct({
    device_sessions: Schema.Boolean,
    session_refresh: Schema.Boolean,
    websocket_tickets: Schema.Boolean,
    native_requests: Schema.optionalKey(Schema.Boolean),
  }),
});

export const CCDriverSession = Schema.Struct({
  id: Schema.String,
  human_id: Schema.String,
  organization_id: Schema.String,
  project_id: Schema.String,
  device_name: Schema.String,
  created_at: Schema.String,
  expires_at: Schema.String,
});

export const CCDriverSessionSecret = Schema.Struct({
  session: CCDriverSession,
  token: Schema.String,
});

export const CCDriverConnection = Schema.Struct({
  origin: Schema.String,
  server_id: Schema.String,
  session: CCDriverSession,
  token: Schema.String,
});
export type CCDriverConnection = typeof CCDriverConnection.Type;

export const CCDriverWorkspace = Schema.Struct({
  channel: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
  main_agent: Schema.NullOr(Schema.Struct({ id: Schema.String, name: Schema.String })),
});
export type CCDriverWorkspace = typeof CCDriverWorkspace.Type;

export const CCDriverMessage = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  channel_seq: Schema.Int,
  author_type: Schema.String,
  content_markdown: Schema.String,
  created_at: Schema.String,
});
export type CCDriverMessage = typeof CCDriverMessage.Type;

export const CCDriverMessagePage = Schema.Struct({
  workspace_id: Schema.String,
  messages: Schema.Array(CCDriverMessage),
  next_cursor: Schema.String,
  has_more: Schema.Boolean,
});

export const CCDriverTask = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  prompt: Schema.String,
  result: Schema.String,
  error: Schema.String,
  created_at: Schema.String,
  worker: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      temporary: Schema.Boolean,
      released: Schema.Boolean,
    }),
  ),
});
export type CCDriverTask = typeof CCDriverTask.Type;

export const CCDriverConversationCache = Schema.Struct({
  server_id: Schema.String,
  human_id: Schema.String,
  project_id: Schema.String,
  workspace_id: Schema.String,
  cursor: Schema.String,
  messages: Schema.Array(CCDriverMessage),
});
export type CCDriverConversationCache = typeof CCDriverConversationCache.Type;

export const CCDriverPendingMessage = Schema.Struct({
  server_id: Schema.String,
  human_id: Schema.String,
  project_id: Schema.String,
  workspace_id: Schema.String,
  content: Schema.String,
  idempotency_key: Schema.String,
});
export type CCDriverPendingMessage = typeof CCDriverPendingMessage.Type;

export const CCDriverQuestion = Schema.Struct({
  id: Schema.String,
  header: Schema.String,
  question: Schema.String,
  isOther: Schema.optionalKey(Schema.Boolean),
  isSecret: Schema.optionalKey(Schema.Boolean),
  options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ label: Schema.String, description: Schema.optionalKey(Schema.String) }),
    ),
  ),
});
export type CCDriverQuestion = typeof CCDriverQuestion.Type;

export const CCDriverNativeRequest = Schema.Struct({
  id: Schema.String,
  method: Schema.String,
  params: Schema.Record(Schema.String, Schema.Unknown),
  choices: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String, kind: Schema.String }))),
  files: Schema.optionalKey(
    Schema.Array(Schema.Struct({ path: Schema.String, kind: Schema.String, diff: Schema.String })),
  ),
});
export type CCDriverNativeRequest = typeof CCDriverNativeRequest.Type;

export const CCDriverNativeSession = Schema.Struct({
  connection_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
  requests: Schema.Array(CCDriverNativeRequest),
});
export type CCDriverNativeSession = typeof CCDriverNativeSession.Type;

export const CCDriverPendingItem = Schema.Struct({
  task_id: Schema.String,
  agent_name: Schema.String,
  session: CCDriverNativeSession,
});
export type CCDriverPendingItem = typeof CCDriverPendingItem.Type;
export const CCDriverRequests = Schema.Struct({
  items: Schema.Array(CCDriverPendingItem),
  unavailable_task_ids: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
});
export type CCDriverRequests = typeof CCDriverRequests.Type;

export const CCDriverControlMarker = Schema.Struct({
  task_id: Schema.String,
  idempotency_key: Schema.String,
  connection_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
  request_id: Schema.String,
});
export type CCDriverControlMarker = typeof CCDriverControlMarker.Type;
export const CCDriverControlReceipt = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  connection_id: Schema.String,
  thread_id: Schema.String,
  turn_id: Schema.String,
  request_id: Schema.optionalKey(Schema.String),
  provider_resolved: Schema.optionalKey(Schema.Boolean),
});
export const CCDriverControlReply = Schema.Struct({
  delivered: Schema.Boolean,
  receipt: CCDriverControlReceipt,
});
