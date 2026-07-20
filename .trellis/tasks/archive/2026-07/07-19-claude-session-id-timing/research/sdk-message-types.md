# Claude Agent SDK message types

## Scope and sources

This inventory follows the `SDKMessage` union shipped by the repository's installed `@anthropic-ai/claude-agent-sdk` (`0.3.210`). The official reference pages are:

- https://platform.claude.com/docs/en/agent-sdk/typescript#message-types
- https://platform.claude.com/docs/en/agent-sdk/agent-loop#message-types
- https://platform.claude.com/docs/en/agent-sdk/streaming-output

The examples below are representative wire shapes. Values such as UUIDs, timestamps, usage counters, and model names are illustrative. Unless shown otherwise, messages also carry `uuid` and `session_id`.

The generated reference page and the installed declaration are not guaranteed to update in lockstep. In particular, the installed `0.3.210` union includes the newer `control_request_progress`, `model_refusal_fallback`, and `model_refusal_no_fallback` variants; clients should follow the SDK package version actually used by the host and tolerate unknown future variants.

## Two levels of routing

The SDK does not return only model text. A client must route in this order:

```ts
if (message.type === "system") {
  switch (message.subtype) {
    // system event subtype
  }
} else {
  switch (message.type) {
    // assistant, user, result, stream_event, ...
  }
}
```

`type: "assistant"` contains an Anthropic `BetaMessage`. Its `message.content[]` is a second, different union. Typical content blocks are:

```json
{"type":"text","text":"我会先检查项目结构。"}
{"type":"thinking","thinking":"先确定需要读取哪些文件。","signature":"..."}
{"type":"redacted_thinking","data":"..."}
{"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"README.md"}}
```

The installed Anthropic SDK also declares server/MCP/tool-result blocks (`server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`, `mcp_tool_use`, `mcp_tool_result`, code-execution result blocks, `tool_search_tool_result`, `container_upload`, `compaction`, and `fallback`). They should remain raw and be rendered only when their `type` is understood.

## Conversation messages

### `SDKAssistantMessage` (`type: "assistant"`)

Complete assistant response for one model request. It can contain text, thinking, and/or tool-use blocks. `parent_tool_use_id` identifies a subagent when applicable.

```json
{
  "type":"assistant",
  "message":{
    "id":"msg_01",
    "type":"message",
    "role":"assistant",
    "content":[{"type":"text","text":"我找到了两个测试失败。"}],
    "model":"claude-sonnet-4-20250514",
    "stop_reason":"end_turn"
  },
  "parent_tool_use_id":null,
  "session_id":"sess-1"
}
```

### `SDKUserMessage` (`type: "user"`)

User input or a tool result fed back to the model. In a PocketPilot client, a human message should carry `origin: { kind: "human" }`. `shouldQuery: false` appends context without starting an assistant turn.

```json
{
  "type":"user",
  "message":{"role":"user","content":"请修复这个测试。"},
  "parent_tool_use_id":null,
  "origin":{"kind":"human"},
  "shouldQuery":true
}
```

### `SDKUserMessageReplay` (`type: "user"`, `isReplay: true`)

An injected peer/channel/task message replayed into the stream. It has the same top-level `type` as a user message, so clients must check `isReplay` when they need to distinguish it.

```json
{
  "type":"user",
  "message":{"role":"user","content":"来自另一个 agent 的结果"},
  "parent_tool_use_id":null,
  "origin":{"kind":"peer","from":"agent-2","body":"来自另一个 agent 的结果"},
  "isReplay":true,
  "session_id":"sess-1"
}
```

### `SDKResultMessage` (`type: "result"`)

End-of-turn result. Use `subtype: "success"` for a completed turn; error subtypes include `error_max_turns`, `error_during_execution`, `error_max_budget_usd`, and `error_max_structured_output_retries`.

```json
{
  "type":"result",
  "subtype":"success",
  "is_error":false,
  "result":"已完成修复并通过测试。",
  "num_turns":3,
  "duration_ms":8420,
  "total_cost_usd":0.031,
  "stop_reason":"completed",
  "permission_denials":[],
  "session_id":"sess-1"
}
```

### `SDKSystemMessage` (`type: "system", subtype: "init"`)

Initial session metadata. This is where the client first receives the Claude `session_id`, together with model, cwd, tools, MCP servers, permission mode, slash commands, skills, and plugins.

```json
{
  "type":"system","subtype":"init","session_id":"sess-1",
  "cwd":"L:/code/test/js/claude-test",
  "model":"claude-sonnet-4-20250514",
  "permissionMode":"default",
  "tools":["Read","Edit","Bash"],
  "mcp_servers":[],
  "slash_commands":["clear","review"],
  "skills":[],"plugins":[]
}
```

### `SDKPartialAssistantMessage` (`type: "stream_event"`)

Raw Claude API streaming event. It is emitted only when `includePartialMessages: true`; it is not accumulated text. The nested `event.type` is usually `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, or `message_stop`.

```json
{
  "type":"stream_event",
  "event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"我会先"}},
  "parent_tool_use_id":null,
  "session_id":"sess-1"
}
```

For a tool call, the nested delta is commonly `{"type":"input_json_delta","partial_json":"..."}`. Clients must accumulate those fragments before parsing tool input.

### `SDKCompactBoundaryMessage` (`type: "system", subtype: "compact_boundary"`)

Conversation compaction boundary. `trigger` is `manual` or `auto`; `pre_tokens` is the token count before compaction.

```json
{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":184000},"session_id":"sess-1"}
```

### `SDKConversationResetMessage` (`type: "conversation_reset"`)

The conversation transcript was replaced without ending the runtime, such as `/clear`, plan-mode exit, or a fresh conversation. Keep the same `session_id`, but mount a new UI transcript under `new_conversation_id`.

```json
{"type":"conversation_reset","new_conversation_id":"conv-2","session_id":"sess-1"}
```

## Runtime and status messages

The following are not ordinary assistant bubbles. Preserve them as raw events and use them for status panels, progress indicators, or diagnostics.

| SDK variant | Route key | Meaning | Representative payload (common `uuid`/`session_id` omitted) |
|---|---|---|---|
| `SDKStatusMessage` | `system/status` | Compaction/requesting status | `{"type":"system","subtype":"status","status":"compacting"}` |
| `SDKInformationalMessage` | `system/informational` | Plaintext banner, hook feedback, warning | `{"type":"system","subtype":"informational","level":"warning","content":"Hook blocked the request"}` |
| `SDKLocalCommandOutputMessage` | `system/local_command_output` | Output from local slash commands such as `/usage` | `{"type":"system","subtype":"local_command_output","content":"Current usage: ..."}` |
| `SDKNotificationMessage` | `system/notification` | Loop-side notification with priority | `{"type":"system","subtype":"notification","key":"task","text":"后台任务已完成","priority":"medium"}` |
| `SDKPromptSuggestionMessage` | `prompt_suggestion` | Predicted next prompt when enabled | `{"type":"prompt_suggestion","suggestion":"继续运行测试"}` |
| `SDKCommandsChangedMessage` | `system/commands_changed` | Full replacement slash-command list after dynamic discovery | `{"type":"system","subtype":"commands_changed","commands":[{"name":"review","description":"Review code"}]}` |
| `SDKSessionStateChangedMessage` | `system/session_state_changed` | Runtime state `running`, `idle`, or `requires_action` | `{"type":"system","subtype":"session_state_changed","state":"idle"}` |
| `SDKToolUseSummaryMessage` | `tool_use_summary` | Human-readable summary for preceding tools | `{"type":"tool_use_summary","summary":"读取了 3 个文件","preceding_tool_use_ids":["toolu_01"]}` |
| `SDKToolProgressMessage` | `tool_progress` | Elapsed time while a tool is running | `{"type":"tool_progress","tool_use_id":"toolu_01","tool_name":"Bash","elapsed_time_seconds":2.4}` |
| `SDKThinkingTokensMessage` | `system/thinking_tokens` | Approximate live thinking-token counter | `{"type":"system","subtype":"thinking_tokens","estimated_tokens":1200,"estimated_tokens_delta":96}` |

## Hooks, tools, tasks, and persistence

| SDK variant | Route key | Meaning | Representative payload (common `uuid`/`session_id` omitted) |
|---|---|---|---|
| `SDKHookStartedMessage` | `system/hook_started` | Hook started | `{"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"lint","hook_event":"PreToolUse"}` |
| `SDKHookProgressMessage` | `system/hook_progress` | Hook stdout/stderr while running | `{"type":"system","subtype":"hook_progress","hook_id":"h1","stdout":"checking...","stderr":"","output":"checking..."}` |
| `SDKHookResponseMessage` | `system/hook_response` | Hook finished | `{"type":"system","subtype":"hook_response","hook_id":"h1","outcome":"success","exit_code":0,"output":"ok","stdout":"ok","stderr":""}` |
| `SDKTaskStartedMessage` | `system/task_started` | Background Bash/subagent task started | `{"type":"system","subtype":"task_started","task_id":"task-1","description":"运行测试","task_type":"local_bash"}` |
| `SDKTaskProgressMessage` | `system/task_progress` | Periodic background/subagent progress | `{"type":"system","subtype":"task_progress","task_id":"task-1","description":"运行测试","usage":{"total_tokens":400,"tool_uses":2,"duration_ms":1800}}` |
| `SDKTaskUpdatedMessage` | `system/task_updated` | Patch to a task state | `{"type":"system","subtype":"task_updated","task_id":"task-1","patch":{"status":"completed","end_time":1780000000000}}` |
| `SDKTaskNotificationMessage` | `system/task_notification` | Background task completed/failed/stopped | `{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed","output_file":"C:/tmp/task-1.txt","summary":"测试通过"}` |
| `SDKBackgroundTasksChangedMessage` | `system/background_tasks_changed` | Full replacement set of live background tasks | `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"task-1","task_type":"local_bash","description":"运行测试"}]}` |
| `SDKFilesPersistedEvent` | `system/files_persisted` | File checkpoint persistence result | `{"type":"system","subtype":"files_persisted","files":[{"filename":"src/a.ts","file_id":"f1"}],"failed":[],"processed_at":"2026-07-19T04:00:00Z"}` |
| `SDKMemoryRecallMessage` | `system/memory_recall` | Relevant memory files surfaced into a turn | `{"type":"system","subtype":"memory_recall","mode":"select","memories":[{"path":"C:/memory/project.md","scope":"personal"}]}` |
| `SDKPluginInstallMessage` | `system/plugin_install` | Plugin installation progress | `{"type":"system","subtype":"plugin_install","status":"installed","name":"review-plugin"}` |
| `SDKElicitationCompleteMessage` | `system/elicitation_complete` | MCP URL elicitation completed | `{"type":"system","subtype":"elicitation_complete","mcp_server_name":"github","elicitation_id":"e1"}` |

## Authentication, limits, retries, and refusal

| SDK variant | Route key | Meaning | Representative payload (common `uuid`/`session_id` omitted) |
|---|---|---|---|
| `SDKAuthStatusMessage` | `auth_status` | Authentication progress/output | `{"type":"auth_status","isAuthenticating":true,"output":["Opening browser..."]}` |
| `SDKAPIRetryMessage` | `system/api_retry` | Retryable API failure before retry | `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"retry_delay_ms":1000,"error_status":429,"error":"rate_limit"}` |
| `SDKControlRequestProgressMessage` | `system/control_request_progress` | Progress for long-running client control request | `{"type":"system","subtype":"control_request_progress","request_id":"r1","status":"api_retry","attempt":2,"retry_delay_ms":500}` |
| `SDKPermissionDeniedMessage` | `system/permission_denied` | Automatic tool denial without interactive approval | `{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_01","message":"Permission denied by policy"}` |
| `SDKRateLimitEvent` | `rate_limit_event` | Subscription rate-limit state | `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1780003600000,"utilization":0.86}}` |
| `SDKModelRefusalFallbackMessage` | `system/model_refusal_fallback` | Refusal caused a fallback-model retry | `{"type":"system","subtype":"model_refusal_fallback","trigger":"refusal","direction":"retry","original_model":"claude-opus-4","fallback_model":"claude-sonnet-4","request_id":"req-1","content":"Retrying with fallback model"}` |
| `SDKModelRefusalNoFallbackMessage` | `system/model_refusal_no_fallback` | Refusal ended without fallback | `{"type":"system","subtype":"model_refusal_no_fallback","original_model":"claude-opus-4","request_id":"req-1","content":"The model declined this request"}` |
| `SDKMirrorErrorMessage` | `system/mirror_error` | External transcript mirror append failed | `{"type":"system","subtype":"mirror_error","error":"append timed out","key":{"projectKey":"project","sessionId":"sess-1"}}` |
| `SDKWorkerShuttingDownMessage` | `system/worker_shutting_down` | Graceful worker teardown reason | `{"type":"system","subtype":"worker_shutting_down","reason":"host_exit"}` |

## Mobile handling recommendations

1. Preserve every raw SDK message. Do not convert it into a PocketPilot-specific nested `event` envelope when the contract is raw SDK forwarding.
2. For transcript rendering, handle `assistant`, `user`, `result`, `system/init`, `system/compact_boundary`, and `conversation_reset` first. Treat `stream_event` as an optional incremental layer that is reconciled with the later complete `assistant` message.
3. For all `system/*`, `tool_progress`, `tool_use_summary`, `prompt_suggestion`, and `rate_limit_event` messages, update status/progress UI rather than inserting an assistant chat bubble by default.
4. Unknown future `type` or `subtype` values must be retained and ignored for rendering. The official docs explicitly describe capability arrays and several event fields as open sets.
5. Use `session_id` for Claude history/resume. Use `taskId` only for PocketPilot routing. On `conversation_reset`, keep the same runtime/session channel, clear the visible transcript, and switch the UI transcript key to `new_conversation_id`.
