# Claude Code / Agent SDK 原始消息类型说明

> 面向 PocketPilot 移动端接入。
>
> 本文描述的是 `/v1/tasks/{taskId}/agent` WebSocket 中传输的原始
> `@anthropic-ai/claude-agent-sdk` 消息，不是 PocketPilot 自己定义的事件包装格式。
> 当前项目验证版本为 `@anthropic-ai/claude-agent-sdk@0.3.210`，验证日期为
> 2026-07-19。

## 1. 先记住三条规则

### 1.1 这不是只有文本的聊天接口

Claude Code 的 SDK 会把以下内容都放进同一条消息流：

- Claude 的完整回复；
- 文本和思考内容的增量流；
- 工具调用和工具执行进度；
- 任务、子代理、后台进程状态；
- Hook、MCP、插件、认证、限流和错误信息；
- `/clear`、压缩、模型切换等会话边界事件。

因此，移动端不能只寻找 `message.content`，也不能把每条消息都渲染成聊天气泡。

### 1.2 先判断 `type`，`system` 还要判断 `subtype`

```ts
function route(message: SDKMessage) {
  if (message.type === "system") {
    return routeSystem(message.subtype, message);
  }

  switch (message.type) {
    case "assistant":
      return renderAssistant(message);
    case "user":
      return renderUserOrToolResult(message);
    case "result":
      return finishTurn(message);
    case "stream_event":
      return consumeRawStreamEvent(message);
    case "tool_progress":
    case "tool_use_summary":
      return updateToolPanel(message);
    case "prompt_suggestion":
      return showPromptSuggestion(message);
    case "rate_limit_event":
      return updateRateLimit(message);
    case "conversation_reset":
      return resetTranscript(message);
    default:
      return preserveAndIgnoreUnknown(message);
  }
}
```

错误做法是再加一层 PocketPilot 业务分类：

```json
{
  "kind": "sdk",
  "payload": {
    "kind": "assistant.stream-event",
    "message": { "type": "stream_event" }
  }
}
```

正确做法是把 SDK 消息原样传递：

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "我会先" }
  },
  "parent_tool_use_id": null,
  "uuid": "80000000-0000-4000-8000-000000000002",
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

### 1.3 `taskId` 不是 `session_id`

- `taskId` 是 PocketPilot 的运行通道句柄，用于 REST、WebSocket、审批和状态路由。
- `session_id` 是 Claude 的持久化会话身份，用于历史记录和恢复。
- 一个 `taskId` 在 `/clear` 后仍然可以对应同一个 SDK Query，但会产生新的
  `new_conversation_id`。
- 移动端不能从 `taskId` 推导 `session_id`，也不能把自己的 UI 会话 ID 写入 SDK 消息。

除非本文特别说明，SDK 消息通常都带有 `uuid` 和 `session_id`。`uuid` 用于历史与
实时消息去重以及 `afterCursor` 回放（Claude provider 的 cursor 值是 SDK UUID）；没有 `uuid` 的消息仍然是合法消息，不能因为缺少
它而丢弃。

## 2. 一轮会话的典型顺序

不开启增量输出时，一轮通常包含：

```text
system/init
assistant（完整回复，可能包含工具调用）
user（工具结果，工具调用时才会出现）
assistant（工具结果之后的下一段完整回复）
result
```

PocketPilot 后端在创建和恢复 Claude SDK Query 时固定设置
`includePartialMessages: true`，因此模型响应会在完整 `assistant` 之前产生：

```text
stream_event: message_start
stream_event: content_block_start
stream_event: content_block_delta ...
stream_event: content_block_stop
stream_event: message_delta
stream_event: message_stop
assistant（完整消息）
result
```

官方文档中的流式规则是：`stream_event` 只提供原始 Claude API 事件，移动端必须自行
拼接增量；后续的完整 `assistant` 才是可持久化、可重放的最终消息。

## 3. 会话内容消息

### 3.1 `SDKSystemMessage`：`type: "system", subtype: "init"`

Query 初始化消息。它包含 Claude 当前使用的工作目录、模型、权限模式、工具、MCP
服务器、slash command、技能和插件，也是客户端首次得到 Claude `session_id` 的位置。

```json
{
  "type": "system",
  "subtype": "init",
  "apiKeySource": "oauth",
  "claude_code_version": "2.1.210",
  "cwd": "D:\\Projects\\demo-app",
  "tools": ["Read", "Edit", "Bash"],
  "mcp_servers": [],
  "model": "claude-sonnet-4-20250514",
  "permissionMode": "default",
  "slash_commands": ["compact", "context", "usage"],
  "output_style": "default",
  "skills": [],
  "plugins": [],
  "uuid": "80000000-0000-4000-8000-000000000001",
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

### 3.2 `SDKAssistantMessage`：`type: "assistant"`

模型生成完成的完整消息。`message` 是 Anthropic SDK 的 `BetaMessage`，内容位于
`message.content[]`。它可能同时包含文本、思考和工具调用块。

```json
{
  "type": "assistant",
  "message": {
    "id": "msg_01",
    "type": "message",
    "role": "assistant",
    "content": [
      { "type": "text", "text": "我找到了两个测试失败。" }
    ],
    "model": "claude-sonnet-4-20250514",
    "stop_reason": "end_turn",
    "usage": { "input_tokens": 1200, "output_tokens": 48 }
  },
  "parent_tool_use_id": null,
  "uuid": "80000000-0000-4000-8000-000000000002",
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

子代理生成的完整消息可能带有 `parent_tool_use_id`、`subagent_type` 和
`task_description`。这些字段要保留，不能当作主会话消息丢掉。

### 3.3 `SDKUserMessage`：`type: "user"`

它既可以是用户输入，也可以是工具结果回送给 Claude 的 user-role 消息。移动端发送
人类输入时，建议明确设置 `origin: { "kind": "human" }`。

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "请修复这个测试。"
  },
  "parent_tool_use_id": null,
  "origin": { "kind": "human" },
  "shouldQuery": true,
  "uuid": "80000000-0000-4000-8000-000000000003"
}
```

`shouldQuery: false` 表示只追加上下文，不触发新的 assistant turn；它会与下一条会
触发查询的 user 消息合并。

### 3.4 `SDKUserMessageReplay`：`type: "user", isReplay: true`

来自 peer、channel、任务或其他外部来源、被重新注入当前会话的 user 消息。顶层
`type` 仍然是 `user`，需要检查 `isReplay`。

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": "来自另一个 agent 的结果"
  },
  "parent_tool_use_id": null,
  "origin": {
    "kind": "peer",
    "from": "agent-2",
    "body": "来自另一个 agent 的结果"
  },
  "isReplay": true,
  "uuid": "80000000-0000-4000-8000-000000000004",
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

### 3.5 `SDKPartialAssistantMessage`：`type: "stream_event"`

PocketPilot 默认开启 `includePartialMessages: true`，因此实时回合会收到这种原始
Claude API 事件。它不是已经拼好的文本，客户端仍需按事件顺序合并。

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": { "type": "text_delta", "text": "我会先" }
  },
  "parent_tool_use_id": null,
  "uuid": "80000000-0000-4000-8000-000000000005",
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

工具输入增量通常是：

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "input_json_delta",
      "partial_json": "{\\"file_path\\":\\"README.md\\"}"
    }
  }
}
```

移动端不要把每个 `text_delta` 都新增成一条气泡；应按消息 ID 和 content block
索引累加，收到后面的完整 `assistant` 后以完整消息校准。

### 3.6 `SDKResultMessage`：`type: "result"`

一轮 Query 的最终结果。成功时 `subtype` 为 `success`；错误时可能是
`error_max_turns`、`error_during_execution`、`error_max_budget_usd` 或
`error_max_structured_output_retries`。

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "已完成修复并通过测试。",
  "num_turns": 3,
  "duration_ms": 8420,
  "duration_api_ms": 7900,
  "total_cost_usd": 0.031,
  "stop_reason": "completed",
  "permission_denials": [],
  "usage": { "input_tokens": 12000, "output_tokens": 1800 },
  "modelUsage": {},
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

`result` 是最终文本，不应替代前面的 `assistant.message.content[]`；费用、turn 数、
错误和停止原因应放在消息详情或运行状态中。

### 3.7 `SDKCompactBoundaryMessage`：`system/compact_boundary`

上下文压缩边界。`trigger` 为 `manual` 或 `auto`。

```json
{
  "type": "system",
  "subtype": "compact_boundary",
  "compact_metadata": {
    "trigger": "auto",
    "pre_tokens": 184000,
    "post_tokens": 42000,
    "duration_ms": 1200
  },
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

它不是新会话，也不是结果消息。移动端可以在 transcript 中显示“上下文已压缩”，但
不能清空当前会话。

### 3.8 `SDKConversationResetMessage`：`type: "conversation_reset"`

会话运行通道没有结束，但当前对话 transcript 被替换。常见原因是 `/clear`、退出
计划模式或新建同工作区对话。

```json
{
  "type": "conversation_reset",
  "new_conversation_id": "a0000000-0000-4000-8000-000000000001",
  "uuid": "90000000-0000-4000-8000-000000000001",
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

收到后：清空当前可见 transcript、清除标题和 transcript 缓存，并使用
`new_conversation_id` 作为新的 UI transcript 边界。不要更换 `taskId`、WebSocket、
审批状态或 SDK `session_id`。

## 4. 状态、提示和工具进度消息

下表中的消息通常不应直接显示为 assistant 气泡，而应更新状态栏、工具面板或通知区。
示例省略通用的 `uuid` 和 `session_id`。

| SDK 类型 | 路由键 | 作用 | 示例 |
| --- | --- | --- | --- |
| `SDKStatusMessage` | `system/status` | 请求或压缩状态 | `{"type":"system","subtype":"status","status":"compacting"}` |
| `SDKInformationalMessage` | `system/informational` | 普通提示、Hook 阻断原因、警告 | `{"type":"system","subtype":"informational","level":"warning","content":"Hook 阻止了请求"}` |
| `SDKLocalCommandOutputMessage` | `system/local_command_output` | 本地 slash command 输出，例如 `/usage` | `{"type":"system","subtype":"local_command_output","content":"当前用量：..."}` |
| `SDKNotificationMessage` | `system/notification` | 具有优先级的通知 | `{"type":"system","subtype":"notification","key":"task","text":"后台任务已完成","priority":"medium"}` |
| `SDKPromptSuggestionMessage` | `prompt_suggestion` | 开启 promptSuggestions 后的下一步建议 | `{"type":"prompt_suggestion","suggestion":"继续运行测试"}` |
| `SDKCommandsChangedMessage` | `system/commands_changed` | 动态发现技能后更新完整 slash command 列表 | `{"type":"system","subtype":"commands_changed","commands":[{"name":"review","description":"Review code"}]}` |
| `SDKSessionStateChangedMessage` | `system/session_state_changed` | `running`、`idle` 或 `requires_action` | `{"type":"system","subtype":"session_state_changed","state":"idle"}` |
| `SDKToolUseSummaryMessage` | `tool_use_summary` | 一组工具调用的摘要 | `{"type":"tool_use_summary","summary":"读取了 3 个文件","preceding_tool_use_ids":["toolu_01"]}` |
| `SDKToolProgressMessage` | `tool_progress` | 工具运行经过的时间 | `{"type":"tool_progress","tool_use_id":"toolu_01","tool_name":"Bash","elapsed_time_seconds":2.4}` |
| `SDKThinkingTokensMessage` | `system/thinking_tokens` | 思考 token 的估算进度 | `{"type":"system","subtype":"thinking_tokens","estimated_tokens":1200,"estimated_tokens_delta":96}` |

## 5. Hook、后台任务和持久化消息

| SDK 类型 | 路由键 | 作用 | 示例 |
| --- | --- | --- | --- |
| `SDKHookStartedMessage` | `system/hook_started` | Hook 开始执行 | `{"type":"system","subtype":"hook_started","hook_id":"h1","hook_name":"lint","hook_event":"PreToolUse"}` |
| `SDKHookProgressMessage` | `system/hook_progress` | Hook 执行中的 stdout/stderr | `{"type":"system","subtype":"hook_progress","hook_id":"h1","stdout":"checking...","stderr":"","output":"checking..."}` |
| `SDKHookResponseMessage` | `system/hook_response` | Hook 执行结束 | `{"type":"system","subtype":"hook_response","hook_id":"h1","outcome":"success","exit_code":0,"output":"ok","stdout":"ok","stderr":""}` |
| `SDKTaskStartedMessage` | `system/task_started` | 后台 Bash 或子代理任务开始 | `{"type":"system","subtype":"task_started","task_id":"task-1","description":"运行测试","task_type":"local_bash"}` |
| `SDKTaskProgressMessage` | `system/task_progress` | 后台任务或子代理的周期性进度 | `{"type":"system","subtype":"task_progress","task_id":"task-1","description":"运行测试","usage":{"total_tokens":400,"tool_uses":2,"duration_ms":1800}}` |
| `SDKTaskUpdatedMessage` | `system/task_updated` | 任务状态的局部 patch | `{"type":"system","subtype":"task_updated","task_id":"task-1","patch":{"status":"completed","end_time":1780000000000}}` |
| `SDKTaskNotificationMessage` | `system/task_notification` | 后台任务完成、失败或停止 | `{"type":"system","subtype":"task_notification","task_id":"task-1","status":"completed","output_file":"C:/tmp/task-1.txt","summary":"测试通过"}` |
| `SDKBackgroundTasksChangedMessage` | `system/background_tasks_changed` | 当前所有活动后台任务的完整集合 | `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"task-1","task_type":"local_bash","description":"运行测试"}]}` |
| `SDKFilesPersistedEvent` | `system/files_persisted` | 文件 checkpoint 持久化结果 | `{"type":"system","subtype":"files_persisted","files":[{"filename":"src/a.ts","file_id":"f1"}],"failed":[],"processed_at":"2026-07-19T04:00:00Z"}` |
| `SDKMemoryRecallMessage` | `system/memory_recall` | 记忆文件被注入当前 turn | `{"type":"system","subtype":"memory_recall","mode":"select","memories":[{"path":"C:/memory/project.md","scope":"personal"}]}` |
| `SDKPluginInstallMessage` | `system/plugin_install` | 插件安装进度 | `{"type":"system","subtype":"plugin_install","status":"installed","name":"review-plugin"}` |
| `SDKElicitationCompleteMessage` | `system/elicitation_complete` | MCP URL elicitation 完成 | `{"type":"system","subtype":"elicitation_complete","mcp_server_name":"github","elicitation_id":"e1"}` |

### 5.1 后台任务事件的关系

同一个后台任务可能出现以下事件：

```text
task_started -> task_progress ... -> task_updated -> task_notification
```

`background_tasks_changed` 是活动任务集合的全量快照，不保证与上述边沿事件严格排序。
客户端收到它时应替换本地集合，而不是把数组内容追加进去。

## 6. 认证、限流、重试和模型拒答消息

| SDK 类型 | 路由键 | 作用 | 示例 |
| --- | --- | --- | --- |
| `SDKAuthStatusMessage` | `auth_status` | 认证过程和输出 | `{"type":"auth_status","isAuthenticating":true,"output":["正在打开浏览器..."]}` |
| `SDKAPIRetryMessage` | `system/api_retry` | 可重试 API 错误及下次重试等待 | `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":3,"retry_delay_ms":1000,"error_status":429,"error":"rate_limit"}` |
| `SDKControlRequestProgressMessage` | `system/control_request_progress` | 长时间 client control request 的进度 | `{"type":"system","subtype":"control_request_progress","request_id":"r1","status":"api_retry","attempt":2,"retry_delay_ms":500}` |
| `SDKPermissionDeniedMessage` | `system/permission_denied` | 工具被策略自动拒绝，没有进入交互审批 | `{"type":"system","subtype":"permission_denied","tool_name":"Bash","tool_use_id":"toolu_01","message":"Permission denied by policy"}` |
| `SDKRateLimitEvent` | `rate_limit_event` | claude.ai 订阅限流状态 | `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1780003600000,"utilization":0.86}}` |
| `SDKModelRefusalFallbackMessage` | `system/model_refusal_fallback` | 模型拒答后切换备用模型重试 | `{"type":"system","subtype":"model_refusal_fallback","trigger":"refusal","direction":"retry","original_model":"claude-opus-4","fallback_model":"claude-sonnet-4","request_id":"req-1","content":"正在使用备用模型重试"}` |
| `SDKModelRefusalNoFallbackMessage` | `system/model_refusal_no_fallback` | 模型拒答且没有备用模型 | `{"type":"system","subtype":"model_refusal_no_fallback","original_model":"claude-opus-4","request_id":"req-1","content":"模型拒绝了该请求"}` |
| `SDKMirrorErrorMessage` | `system/mirror_error` | 外部 transcript mirror 写入失败 | `{"type":"system","subtype":"mirror_error","error":"append timed out","key":{"projectKey":"project","sessionId":"sess-1"}}` |
| `SDKWorkerShuttingDownMessage` | `system/worker_shutting_down` | Worker 正常关闭原因 | `{"type":"system","subtype":"worker_shutting_down","reason":"host_exit"}` |

## 7. `assistant.message.content[]` 内容块

顶层 `type: "assistant"` 之后，还要读取 `message.content[]` 的 `type`。

### 7.1 文本

```json
{
  "type": "text",
  "text": "这是 Claude 返回的正文。"
}
```

移动端应将连续文本块按消息顺序合并为一条 assistant 消息，但要保留原始块，以便
后续处理引用或增量事件。

### 7.2 思考和隐藏思考

```json
{
  "type": "thinking",
  "thinking": "先检查配置，再决定修改范围。",
  "signature": "..."
}
```

```json
{
  "type": "redacted_thinking",
  "data": "..."
}
```

是否展示思考内容由产品隐私策略决定。不能尝试解码或修改 `redacted_thinking.data`。

### 7.3 工具调用

```json
{
  "type": "tool_use",
  "id": "toolu_01",
  "name": "Read",
  "input": { "file_path": "README.md" }
}
```

工具调用不是工具结果。工具结果通常会以 `type: "user"` 的 `tool_result` 内容块回到
消息流中：

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_01",
        "content": "README.md 的内容..."
      }
    ]
  },
  "parent_tool_use_id": null
}
```

### 7.4 其他 Anthropic 内容块

已安装的 Anthropic SDK 还声明了以下内容块。它们属于 Anthropic `BetaMessage` 的
开放联合，不代表每一轮 Claude Code 都会出现：

- `server_tool_use`；
- `web_search_tool_result`、`web_fetch_tool_result`；
- `mcp_tool_use`、`mcp_tool_result`；
- `code_execution_tool_result`、`bash_code_execution_tool_result`、
  `text_editor_code_execution_tool_result`；
- `tool_search_tool_result`；
- `container_upload`；
- `compaction`；
- `fallback`。

客户端不认识这些块时，应保留原始 JSON 并显示一个可忽略的“未识别内容”，不能因为
未知块导致整个 WebSocket 或 transcript 失败。

## 8. 流式消息如何拼接

PocketPilot 已默认开启 `includePartialMessages`，客户端至少要处理以下事件：

### 8.1 文本流

```json
{"type":"message_start","message":{"id":"msg_01"}}
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"第一段"}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"第二段"}}
{"type":"content_block_stop","index":0}
{"type":"message_delta","delta":{"stop_reason":"end_turn"}}
{"type":"message_stop"}
```

实现时按 `message.id + index` 保存临时 block，依次追加 `text_delta.text`。收到
`content_block_stop` 后结束该 block；收到完整 `assistant` 后用完整消息替换临时状态。

### 8.2 工具输入流

```json
{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"Read","input":{}}}
{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":"}}
{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"README.md\\"}"}}
{"type":"content_block_stop","index":0}
```

`partial_json` 不能逐片直接调用 JSON parser；先拼接完整字符串，再在 block stop 或
完整 assistant 消息到达时解析。

### 8.3 不要重复渲染

`stream_event` 是增量层，`assistant` 是完整层。推荐状态模型：

```text
收到 stream_event -> 更新临时 assistant/tool block
收到 assistant    -> 用完整 content[] 替换临时 block
收到 result       -> 将当前 turn 标记为完成
```

如果网络重连收到重复的 stream event，按 SDK `uuid` 去重；没有 `uuid` 的增量事件只能
按连接内到达顺序处理。

## 9. 移动端推荐渲染策略

### 9.1 建议进入 Transcript 的消息

- `assistant`：显示文本、思考（如果产品允许）和工具调用卡片；
- `user`：显示人类输入；工具结果可以折叠显示；
- `result`：显示 turn 完成、错误、成本和耗时；
- `system/init`：用于初始化页面状态，不要当成聊天气泡；
- `system/compact_boundary`：显示上下文压缩标记，不要清空 transcript；
- `conversation_reset`：切换新的 UI transcript 边界，不要追加为普通文本。

### 9.2 建议进入状态栏或任务面板的消息

`status`、`informational`、`local_command_output`、`notification`、`tool_progress`、
`tool_use_summary`、Hook 事件、任务事件、`thinking_tokens`、`rate_limit_event`、
`auth_status`、`worker_shutting_down` 等消息应保留原始数据，并根据具体类型更新
状态栏、工具面板、任务面板或错误提示。

### 9.3 未知类型的处理

SDK 会增加新的 `type`、`subtype` 和字段。移动端必须：

1. 保留原始消息；
2. 记录可诊断的非敏感类型信息；
3. 跳过未知消息的 UI 渲染；
4. 继续处理后续消息；
5. 不能因为未知变体关闭 WebSocket 或把当前 turn 标记为失败。

## 10. 与 PocketPilot 两条 WebSocket 的边界

PocketPilot 有两个不同的 WebSocket：

| WebSocket | 内容 | 是否包含原始 SDK 消息 |
| --- | --- | --- |
| `/v1/tasks/{taskId}/agent` | 移动端发送原始 `SDKUserMessage`；服务端返回原始 `SDKMessage` | 是 |
| `/v1/events` | `task.state`、`approval.requested` 等 PocketPilot 控制事件 | 否 |

控制 WebSocket 的消息可以有 PocketPilot 自己的 `kind`，但不能把 SDK 消息塞进控制
事件中。SDK socket 也不能添加 `taskId`、`operationId` 或 PocketPilot `payload` 包装。

原始 SDK socket 示例：

```json
{
  "type": "user",
  "message": { "role": "user", "content": "/code-review high src/" },
  "parent_tool_use_id": null,
  "origin": { "kind": "human" }
}
```

```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [{ "type": "text", "text": "我开始检查代码。" }]
  },
  "parent_tool_use_id": null,
  "session_id": "70000000-0000-4000-8000-000000000001"
}
```

## 11. 版本和兼容性

当前项目使用 `@anthropic-ai/claude-agent-sdk@0.3.210`。官方生成的 TypeScript 参考页
和安装包类型声明不保证同时更新；安装包的 `SDKMessage` 联合是运行时适配的直接依据。
当前安装包额外包含较新的：

- `system/control_request_progress`；
- `system/model_refusal_fallback`；
- `system/model_refusal_no_fallback`。

部分事件还受 Claude Code 版本或 SDK option 控制，例如：

- PocketPilot 已为新建和恢复 Query 开启 `includePartialMessages: true`，因此
  `stream_event` 是正常实时输出的一部分；其他 SDK 使用者仍需自行开启该选项；
- `prompt_suggestion` 需要启用 prompt suggestions；
- `plugin_install` 需要启用插件安装同步；
- `background_tasks_changed`、`thinking_tokens`、`conversation_reset` 等需要足够新的
  Claude Code 版本。

SDK 升级后，移动端至少要重新检查：

- `SDKMessage`、`SDKUserMessage`、`SessionMessage` 联合；
- `system/init`、`system/status`、`conversation_reset`；
- `stream_event` 的内层事件和增量 block；
- 权限、模型、slash command、任务和回放 UUID；
- WebSocket 重连和未知事件行为。

不要在移动端复制一份“封闭的 SDK union”作为后端协议。保留未知字段和未知变体，
以 SDK 原始 JSON 为事实来源。

## 12. 官方参考

- [Agent SDK TypeScript 参考：Message Types](https://platform.claude.com/docs/en/agent-sdk/typescript#message-types)
- [Agent SDK：How the agent loop works](https://platform.claude.com/docs/en/agent-sdk/agent-loop)
- [Agent SDK：Streaming output](https://platform.claude.com/docs/en/agent-sdk/streaming-output)
- [Agent SDK：Work with sessions](https://platform.claude.com/docs/en/agent-sdk/sessions)
