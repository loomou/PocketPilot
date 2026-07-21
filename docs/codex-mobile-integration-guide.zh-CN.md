# PocketPilot Codex 移动端对接指南

本文是移动端接入 PocketPilot 的 Codex 专用指南。PocketPilot 连接电脑上已经安装并登录的官方 Codex App Server，移动端只连接 PocketPilot 的 `/v1` API；移动端不应直接连接 Codex App Server，也不应把 Codex 消息转换成 Claude SDK 消息。

本文描述当前后端实现的可用协议。PocketPilot 的 OpenAPI 文档位于本机管理端的 `/documentation/`，原始文档位于 `/documentation/json`。REST 字段以运行中的 OpenAPI 和当前服务版本为准，Codex 原生 JSON-RPC 字段以安装的 Codex App Server 版本为准。

## 1. 必须遵守的边界

### 1.1 两个 WebSocket，各自负责不同内容

| 地址 | 作用 | Codex 移动端处理方式 |
| --- | --- | --- |
| `/v1/events` | PocketPilot 控制事件、任务状态和控制流 | 只按 PocketPilot 控制事件解析，不在这里寻找 Codex 文本或 item |
| `/v1/tasks/{taskId}/agent` | 当前任务的 provider 原生双向流 | Codex 原生 JSON-RPC 帧，另加订阅时在保留回放前发送的一帧 `agent.checkpoint` 控制帧（§10.2） |

Agent WebSocket 上没有 `event` 外壳，也没有 `kind: "sdk"` 包装。服务端流量是原生 Codex App Server JSON-RPC，唯一例外是 Codex 专用的订阅时控制帧：在保留的原生回放之前只发送一次 `{ kind: "agent.checkpoint", payload: { provider: "codex", cursor } }`（见 §10.2）。之后的每个服务端文本帧都是一个 Codex 原生 JSON 对象。客户端发送的每个请求也必须是 Codex 原生请求或对原生 server request 的响应。

PocketPilot 自己在内部通过 stdio 启动并初始化 App Server。移动端连接 PocketPilot 时不要发送 `initialize` 或 `initialized`，也不要自行发送 `thread/start`、`thread/resume`。会话创建和绑定由 PocketPilot REST 完成，任务 WebSocket 只允许文档列出的原生方法。

### 1.2 不要混用身份

| 标识 | 所属方 | 用途 |
| --- | --- | --- |
| `taskId` | PocketPilot | REST、Agent WebSocket、任务状态、重连和路由 |
| `threadId` / `nativeConversationId` | Codex | 一个持久化对话分支；REST 路径中的 `conversationId` 对应它 |
| `sessionId` / `nativeSessionId` | Codex | Codex 会话树的根身份，分支可能共享它 |
| `turnId` / `activeTurnId` | Codex/PocketPilot | 一次正在执行的用户请求 |
| `itemId` | Codex | 用户消息、助手消息、推理、命令、文件变更或工具 item |
| JSON-RPC `id` | 发起请求的一方 | 关联一条请求与响应，也用于关联审批 server request |
| `afterCursor` | PocketPilot transport | Agent 流的重放位置，不是 Codex 的 thread、turn 或 item ID |

`taskId` 不是 `threadId`，也不是 `sessionId`。同一个 Codex thread 可以在不同时间绑定到 PocketPilot task；同一个 task 也会连续承载多个 turn。

## 2. 连接前准备

### 2.1 认证

除配对引导接口外，所有 `/v1` 请求都带访问令牌：

```http
Authorization: Bearer <accessToken>
```

WebSocket 握手也使用同一个 `Authorization` header。不要把令牌放进 URL、查询参数、日志、埋点或截图。把 QR 返回的 HTTP base URL 转成 WebSocket 地址时，`http` 改为 `ws`，`https` 改为 `wss`。

配对、刷新令牌和设备撤销流程请复用通用的[移动端对接指南](./mobile-integration-guide.zh-CN.md)。Codex 本身不改变 PocketPilot 的设备认证流程。

### 2.2 检查 provider 和能力

先调用：

```http
GET /v1/providers
GET /v1/providers/codex/capabilities
```

只有 `status` 为 `available` 时才显示 Codex。能力快照的结构如下，具体协议版本以服务返回值为准：
服务端会在 `GET /v1/providers` 与 capabilities 路由上按短 TTL 刷新 readiness。不可用时仍会返回稳定 `reasonCode`（例如 `CODEX_COMMAND_NOT_FOUND`、`CODEX_APP_SERVER_VERSION_UNSUPPORTED`、`CODEX_APP_SERVER_PROBE_FAILED`），且从不暴露安装路径、凭证或原始进程诊断。

```json
{
  "id": "codex",
  "status": "available",
  "protocolVersion": "codex-app-server@0.144",
  "capabilities": {
    "activeTurnSteering": true,
    "approvals": true,
    "attachments": false,
    "effort": true,
    "historyFilters": {
      "includeSystemMessages": false
    },
    "historyPagination": "cursor",
    "interrupt": true,
    "modes": true,
    "models": true,
    "nativeActions": {
      "compact": {
        "availability": "idle",
        "method": "thread/compact/start",
        "startsTurn": true
      },
      "rename": {
        "availability": "always",
        "method": "thread/name/set",
        "startsTurn": false
      },
      "review": {
        "availability": "idle",
        "deliveries": ["inline"],
        "method": "review/start",
        "startsTurn": true,
        "targetTypes": [
          "uncommittedChanges",
          "baseBranch",
          "commit",
          "custom"
        ]
      }
    },
    "newConversation": true,
    "resumeConversation": true,
    "statusCatalogs": {
      "account": true,
      "hooks": true,
      "mcpServers": true,
      "rateLimits": true,
      "skills": true
    },
    "streamProtocol": "codex-app-server-json-rpc",
    "threadManagement": {
      "archive": true,
      "delete": true,
      "fork": true,
      "includeArchived": true,
      "search": true,
      "unarchive": true
    }
  }
}
```

不要根据电脑上是否存在某个可执行文件、上一次启动结果或客户端自己的 provider 列表推断可用性。若 provider 不可用，保留服务返回的 `reasonCode`，并提示用户在电脑端处理安装或登录问题。

### 2.3 选择授权工作区

```http
GET /v1/workspaces
```

响应示例：

```json
{
  "workspaceRoots": [
    "D:\\Projects\\demo",
    "D:\\Projects\\another-repo"
  ]
}
```

会话列表、创建、绑定和 Agent 请求都必须使用授权工作区。移动端让用户选择列表中的原始字符串，不要自行拼接、规范化或替换路径分隔符。

## 3. 会话列表、历史和绑定

### 3.1 列出工作区中的 Codex threads

```http
GET /v1/providers/codex/conversations?workspace=<urlEncodedWorkspace>&limit=50&includeArchived=true&searchTerm=review
```

可选分页参数是 `cursor` 和 `limit`，`cursor` 必须原样回传。PocketPilot 会向 App Server 请求 CLI、VS Code 和 App Server 三类来源的 thread，然后只返回工作区授权范围内的原生 thread。

响应外层字段是 `conversations`，不是通用的 `items`：

```json
{
  "conversations": [
    {
      "id": "thr_019abc",
      "sessionId": "sess_019abc",
      "cwd": "D:\\Projects\\demo",
      "turns": []
    }
  ],
  "page": {
    "cursor": null,
    "hasMore": false
  }
}
```

`conversations` 中的对象是 Codex 原生对象，可能包含当前版本新增字段。客户端应保留未知字段，不要因为新增字段拒绝整条记录。显示标题时优先使用 Codex 返回的名称字段，没有名称时再使用首条用户消息或 thread ID 的短形式。

### 3.2 读取历史

```http
GET /v1/providers/codex/conversations/{threadId}?workspace=<urlEncodedWorkspace>&limit=50
```

响应外层字段是 `messages`：

```json
{
  "messages": [
    {
      "id": "turn_019abc",
      "status": "completed",
      "items": [
        {
          "id": "item_019abc",
          "type": "agentMessage"
        }
      ]
    }
  ],
  "page": {
    "cursor": "next-page-token",
    "hasMore": true
  }
}
```

这里的 `messages` 实际上是 Codex 原生 turn 列表，`items` 中的具体变体由已安装的 App Server 版本决定。PocketPilot 会按时间正序返回当前页，移动端可以从底部加载更旧页，并在列表顶部插入；不要把历史 item 重新组装成新的 `turn/start` 输入。

Codex 会声明 `capabilities.historyFilters.includeSystemMessages: false`。省略该查询参数或发送 `includeSystemMessages=false` 都会原样返回原生 turn/item 行。`includeSystemMessages=true` 会在发起任何原生历史请求前返回 `409 HISTORY_FILTER_NOT_SUPPORTED`。不要为 Codex 发明 Claude 风格的系统消息过滤。

长会话必须使用虚拟列表或分段渲染。建议流程是：先请求最新一页并展示，用户滚动到顶部时用 `page.cursor` 请求旧页，再按 `itemId` 或 turn ID 去重。历史记录和实时流的同一个 item 可能同时出现，最终以 `item/completed` 或最新历史结果校正。

### 3.3 绑定已有会话

用户选择 thread 后调用：

```http
POST /v1/providers/codex/conversations/thr_019abc/attach
Content-Type: application/json

{
  "operationId": "0c4cde63-e7a6-4a2d-a2d5-2c3a6bb16f19",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

`operationId` 是移动端为本次 HTTP mutation 生成的 UUID。网络超时重试同一个操作时复用原值；新的操作必须使用新的值。

响应是任务操作结果：

```json
{
  "action": "attached",
  "task": {
    "id": "8d0d6d3b-4dc4-4c65-95e3-0a6d47a6f812",
    "provider": "codex",
    "state": "idle",
    "initialCwd": "D:\\Projects\\demo",
    "nativeConversationId": "thr_019abc",
    "nativeSessionId": "sess_019abc",
    "nativeProtocolVersion": "codex-app-server@0.144",
    "activeTurnId": null,
    "model": null,
    "permissionMode": null,
    "sdkSessionId": null,
    "origin": "agent-conversation",
    "createdAt": 1780000000000,
    "updatedAt": 1780000000000,
    "interruptedAt": null,
    "terminalAt": null
  }
}
```

如果该 thread 已经绑定到一个未结束的 PocketPilot task，服务端会复用该 task。移动端应使用返回的 `task.id`，不要自己根据 thread ID 生成 task ID。

### 3.4 创建空会话

若产品需要“新建对话”，调用：

```http
POST /v1/providers/codex/conversations
Content-Type: application/json

{
  "operationId": "d1b3a5f1-7537-440d-a64a-5c4f2a8de8a7",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

PocketPilot 会在本机调用原生 `thread/start`，再返回新的 `taskId`、`nativeConversationId` 和 `nativeSessionId`。创建请求不会发送用户 prompt；用户第一条消息要在 Agent WebSocket 建立后通过 `turn/start` 发送。

### 3.5 Fork 会话

```http
POST /v1/providers/codex/conversations/{threadId}/fork
Content-Type: application/json

{
  "operationId": "00000000-0000-4000-8000-000000000040",
  "workspace": "D:\Projects\demo",
  "workspaceRiskAccepted": true
}
```

Fork 会从选中的源 thread 创建新的原生 Codex thread，并绑定一个新的 PocketPilot task，返回 `{ action: "forked", task }`。后续在 `/v1/tasks/{taskId}/agent` 上继续该 fork。

### 3.6 归档与取消归档

```http
POST /v1/providers/codex/conversations/{threadId}/archive
POST /v1/providers/codex/conversations/{threadId}/unarchive
```

archive 需要共享 operation 请求体，并额外携带 `confirm: true`；缺少或为 false
时返回 `CONFIRMATION_REQUIRED`。unarchive 与 create/attach/fork 使用相同请求体，
不需要 confirm。两者都返回 `{ action, task: null }`。archive 可逆，**不会**自动
关闭绑定的 PocketPilot task；如需结束 task，请另行 close。unarchive 不会创建本地
task；重新连接 Agent WebSocket 前需再次 attach。

### 3.7 删除会话

```http
POST /v1/providers/codex/conversations/{threadId}/delete
Content-Type: application/json

{
  "confirm": true,
  "operationId": "00000000-0000-4000-8000-000000000041",
  "workspace": "D:\Projects\demo",
  "workspaceRiskAccepted": true
}
```

删除必须携带 `confirm: true`，否则返回 `CONFIRMATION_REQUIRED`。成功时返回
`{ action: "deleted", task: null }`，并终止绑定该会话的本地非终态 task。客户端
应把删除视为不可逆操作。

### 3.8 按能力开关渲染

仅在 `capabilities.threadManagement` 对应布尔值为 `true` 时渲染 fork/archive/unarchive/delete 控件。Claude 当前会把这些标志全部标为 `false`。不要发明额外 REST 变更路由，也不要在 Agent WebSocket 上发送 archive/delete。

## 4. 连接 Agent WebSocket

### 4.1 建立连接

```text
GET /v1/tasks/{taskId}/agent
```

示例：

```text
WebSocket.connect(
  "ws://192.168.31.223:43182/v1/tasks/8d0d6d3b-4dc4-4c65-95e3-0a6d47a6f812/agent",
  headers = { "Authorization": "Bearer <accessToken>" },
)
```

不同客户端库的 header 配置方式不同，但认证必须放在 WebSocket handshake 的 `Authorization` header 中。PocketPilot 在订阅原生流之后才激活 task，所以不会漏掉激活时产生的首批通知。

连接成功后不要发送 `initialize`、`initialized`、`thread/start` 或 `thread/resume`。这些是 PocketPilot 到本机 App Server 的内部生命周期消息。

### 4.2 PocketPilot 当前允许的客户端方法

```text
turn/start
turn/steer
turn/interrupt
review/start
thread/name/set
thread/compact/start
thread/read
thread/turns/list
thread/items/list
model/list
collaborationMode/list
permissionProfile/list
```

会话创建、会话绑定和关闭使用 REST。`account/*`、配置写入、文件系统、进程、插件、任意 MCP 方法以及未列出的新方法不会因为本机 App Server 支持就自动开放。

PocketPilot 会把 task 绑定的 `threadId` 注入到大多数请求中。客户端如果提供了 `threadId`，必须与 task 的 `nativeConversationId` 一致；冲突会被拒绝。`model/list` 是不绑定 thread 的目录请求。

`turn/start`、`review/start`、`thread/compact/start`、`turn/steer` 和原生 server-request 响应遵循共享的 task P2 顺序；`turn/interrupt` 是 P1，会先让旧的活动或排队 P2 操作失效再转发。目录和历史方法属于 P3 读取，不等待 turn 队列也不占用 turn 容量，但 PocketPilot 会在转发前后重新检查 task 可用性和当前工作区授权。空闲 task 的 `turn/start`、review 和 compact 与 Claude task 共用同一套活动任务容量限制。`thread/name/set` 始终可用，不会启动 turn，也不占用 turn 容量。

Codex 远程能力会声明 `attachments: false`。不要为远程 Codex task 发明附件输入。请读取 `capabilities.nativeActions` 获取 review、rename 和 compact 的确切方法。detached review 会被拒绝；只允许 inline review delivery。

请读取 `capabilities.statusCatalogs` 获取封闭的只读状态目录面。Codex 当前会声明 `account`、`rateLimits`、`skills`、`hooks` 和 `mcpServers`。这些目录保持在原生 Agent WebSocket 上，作为 P3 只读请求转发。PocketPilot 会校验可选的 `cwd`/`cwds`，在 `skills/list` 和 `hooks/list` 未提供路径时注入 task 工作区，拒绝 `account/read` 的 `refreshToken: true`，并在下发前剔除 email/token/path/command 字段。不要发明 REST 变更路由、`account/login`、`account/logout`、plugin 管理、MCP 安装，或任意带路径的目录写操作。

### 4.3 帧格式

Codex App Server 在传输层使用省略 `jsonrpc: "2.0"` 的 JSON-RPC 风格对象。PocketPilot 不增加外层：

```json
{
  "id": "mobile-42",
  "method": "turn/start",
  "params": {
    "input": [
      {
        "type": "text",
        "text": "解释这个失败的测试。",
        "text_elements": []
      }
    ]
  }
}
```

响应带同一个 `id`：

```json
{
  "id": "mobile-42",
  "result": {
    "turn": {
      "id": "turn_019abc"
    }
  }
}
```

通知没有 `id`：

```json
{
  "method": "turn/started",
  "params": {
    "threadId": "thr_019abc",
    "turn": {
      "id": "turn_019abc"
    }
  }
}
```

JSON-RPC error 也是原生对象，客户端应保存 `code`、`message` 和未知字段：

```json
{
  "id": "mobile-42",
  "error": {
    "code": -32600,
    "message": "Invalid request"
  }
}
```

客户端生成的请求 ID 只需在本连接内唯一，建议使用递增数字或带前缀的 UUID。不要把 `taskId` 当作 JSON-RPC ID。

## 5. Turn 生命周期和发送消息

### 5.1 空闲 task 使用 `turn/start`

当 task 的 `activeTurnId` 为 `null`、状态为 `idle` 时发送：

```json
{
  "id": "mobile-43",
  "method": "turn/start",
  "params": {
    "input": [
      {
        "type": "text",
        "text": "请检查当前仓库的 TypeScript 类型错误。",
        "text_elements": []
      }
    ]
  }
}
```

`turn/start` 是异步操作。请求响应中的 `turn.id` 可以用于关联请求，但移动端必须以之后收到的 `turn/started` 通知作为当前活动 turn 的权威来源，并保存其中的 `params.turn.id`。

典型顺序是：

```text
turn/start response
turn/started
item/started
item/agentMessage/delta        (可能为零条或多条)
item/completed
turn/completed
```

实际执行还可能包含命令输出、文件变更、推理、计划、MCP、图片、压缩和其他原生 item。不要依赖固定事件数量或固定顺序之外的非必要通知。

PocketPilot 会独立地把生命周期投影到 `/v1/events`：`turn/started` 对应 `task.state = executing`，存在原生 server request 时对应 `awaiting_approval`，最后一个 request 解决后回到 `executing`，`turn/completed` 后回到 `idle`。通用任务 UI 使用这些控制事件；会话内容仍以原生 Agent 帧为准。

### 5.2 活动 turn 使用 `turn/steer`

如果当前已有活动 turn，用户追加指令时不要再次调用 `turn/start`，而是发送：

```json
{
  "id": "mobile-44",
  "method": "turn/steer",
  "params": {
    "expectedTurnId": "turn_019abc",
    "input": [
      {
        "type": "text",
        "text": "优先检查 parser 相关文件。",
        "text_elements": []
      }
    ]
  }
}
```

`expectedTurnId` 必须等于最近一次 `turn/started` 的 turn ID。PocketPilot 会校验它；过期或缺失会返回 task busy 错误。Codex 没有 Claude 的 `priority` 或 `shouldQuery` 字段，不要发送或转换这些字段。

### 5.3 中断

普通 UI 的停止按钮建议调用：

```http
POST /v1/tasks/{taskId}/interrupt
Content-Type: application/json

{
  "operationId": "f97fa0c3-b1b4-48b5-8e12-ec7e88a9766f"
}
```

PocketPilot 会使用当前 `activeTurnId` 调用原生 `turn/interrupt(threadId, turnId)`。也可以在 Agent WebSocket 中发送原生请求：

```json
{
  "id": "mobile-45",
  "method": "turn/interrupt",
  "params": {
    "turnId": "turn_019abc"
  }
}
```

两种方式都必须使用当前活动 turn。中断后仍以原生 `turn/completed` 为最终结果；不要只因为 HTTP 操作返回成功就把 UI 当作已经完成。

关闭 task 使用 `POST /v1/tasks/{taskId}/close`，它会让 PocketPilot task 进入终止状态。关闭不会归档或删除 Codex thread；之后需要重新选择该 thread 并绑定新的可用 task。

## 6. 流式 item 的消费方式

### 6.1 文本增量

Codex 文本通常通过 `item/agentMessage/delta` 增量发送：

```json
{
  "method": "item/agentMessage/delta",
  "params": {
    "threadId": "thr_019abc",
    "turnId": "turn_019abc",
    "itemId": "item_019abc",
    "delta": "正在检查测试文件"
  }
}
```

客户端按 `itemId` 保存增量缓冲，在 UI 中追加 `delta`。收到该 item 的 `item/completed` 后，用完成事件中的完整 item 校正缓冲；如果没有收到任何 delta，不要伪造逐字动画。

### 6.2 其他 item

目前可见的原生通知包括：

```text
item/started
item/completed
item/commandExecution/outputDelta
item/commandExecution/terminalInteraction
item/fileChange/patchUpdated
item/mcpToolCall/progress
item/plan/delta
item/reasoning/summaryPartAdded
item/reasoning/summaryTextDelta
item/reasoning/textDelta
turn/diff/updated
turn/plan/updated
thread/status/changed
thread/tokenUsage/updated
```

这些名称是 Codex 原生名称。客户端应采用基于 `method` 的可扩展分发：已知类型做 UI 展示，未知类型保存或忽略，不要把它们映射成 Claude `assistant`、`tool_use` 或 `stream_event`。

`item/completed` 是 item 的最终版本，`turn/completed` 是 turn 的最终版本。UI 可以先显示增量，再在完成事件到达时以原生完整对象替换。建议使用 `(threadId, turnId, itemId)` 作为实时去重键。

## 7. 模型、推理强度、模式和权限

不要复用 Claude 的模型、effort 或 permission-mode 枚举。打开 composer 时通过 Agent WebSocket 查询本机 Codex 版本实际提供的目录：

```json
{
  "id": "catalog-models",
  "method": "model/list",
  "params": {}
}
```

```json
{
  "id": "catalog-modes",
  "method": "collaborationMode/list",
  "params": {}
}
```

```json
{
  "id": "catalog-permissions",
  "method": "permissionProfile/list",
  "params": {}
}
```

响应保持 Codex 原生结构，通常从 `result.data` 读取列表，但不要在客户端写死字段或枚举。渲染当前安装版本返回的模型、支持的 reasoning effort、collaboration mode 和 permission profile。

用户发送下一条消息时，把选择值作为 Codex 原生 `turn/start` 或 `turn/steer` 参数传递，例如：

```json
{
  "id": "mobile-46",
  "method": "turn/start",
  "params": {
    "model": "<来自 model/list>",
    "effort": "<来自所选模型的 supportedReasoningEfforts>",
    "collaborationMode": "<来自 collaborationMode/list>",
    "approvalPolicy": "<来自 Codex 配置或产品选择>",
    "permissions": "<来自 permissionProfile/list>",
    "sandboxPolicy": "<与授权工作区匹配的原生值>",
    "input": [
      {
        "type": "text",
        "text": "开始处理这个问题。",
        "text_elements": []
      }
    ]
  }
}
```

上面的尖括号只是说明，不能作为实际值发送。`model`、`effort`、`collaborationMode`、`permissions` 和 `sandboxPolicy` 的确切类型由当前 Codex App Server schema 决定。选择项变化不会创建新的 PocketPilot task，也不会改变 Codex thread ID。

Codex task 不要调用 Claude 专用的 `/composer-options`、`/model`、`/effort`、`/permission-mode` 或审批 REST 控制；这些接口会返回 `TASK_CONTROL_NOT_SUPPORTED`。Codex 的配置选择和审批响应必须使用 Agent WebSocket 上的原生协议。

PocketPilot 不为 Codex 提供写死的 slash command 面板。不要把 Claude 的 `/clear`、`/compact`、`/review`、`/security-review`、`/code-review` 或别名复制给 Codex。新建 Codex 会话要调用 provider conversation REST 接口并使用原生 `thread/start`；选择已有会话就是继续对应的原生 thread。

请使用 `capabilities.nativeActions` 公布的 Codex 原生方法：

```json
{
  "id": "mobile-60",
  "method": "review/start",
  "params": {
    "delivery": "inline",
    "target": { "type": "uncommittedChanges" }
  }
}
```

```json
{
  "id": "mobile-61",
  "method": "thread/name/set",
  "params": {
    "name": "Provider parity audit"
  }
}
```

```json
{
  "id": "mobile-62",
  "method": "thread/compact/start",
  "params": {}
}
```

review 和 compact 要求 task 处于 idle，与 `turn/start` 共享 turn 容量，并在收到 `turn/started` 后把 task 移到 `executing`。detached review 会被拒绝。rename 始终可用，且不会启动 turn。

## 8. Codex 原生审批和用户输入

Codex 审批不是 Claude 的 `PermissionResult`。原生 server request 会不加包装地出现在 Agent WebSocket：

```json
{
  "id": "approval-42",
  "method": "item/commandExecution/requestApproval",
  "params": {
    "threadId": "thr_019abc",
    "turnId": "turn_019abc",
    "command": "git status"
  }
}
```

PocketPilot 同时会在 `/v1/events` 发布用于 UI 展示的投影：

```json
{
  "type": "event",
  "event": {
    "cursor": 42,
    "taskId": "8d0d6d3b-4dc4-4c65-95e3-0a6d47a6f812",
    "occurredAt": 1780000000000,
    "event": {
      "kind": "approval.requested",
      "payload": {
        "provider": "codex",
        "requestId": "approval-42",
        "method": "item/commandExecution/requestApproval",
        "params": {
          "threadId": "thr_019abc",
          "turnId": "turn_019abc",
          "itemId": "item_019abc",
          "command": "git status"
        }
      }
    }
  }
}
```

这个 control event 只用于渲染，不会替换或包装原生请求。客户端通过 `requestId` 对应两条消息，再在 Agent WebSocket 上使用同一个原生 JSON-RPC `id` 返回该方法要求的 result。

当前 PocketPilot 转发的 server request 方法是：

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
item/tool/requestUserInput
mcpServer/elicitation/request
```

移动端必须显示请求的原生字段，并用同一个 JSON-RPC `id` 返回该方法要求的原生 result。例如测试环境中的命令审批响应可以是：

```json
{
  "id": "approval-42",
  "result": {
    "decision": "accept"
  }
}
```

不同方法的 result 不能互相套用。生产客户端应依据当前 Codex App Server 生成的 schema 生成响应，并把未识别字段原样保留。不要把所有审批统一成 `{ allowed: true }`、Claude `behavior: "allow"` 或一个自定义 `approvalId`。

服务端会同时处理多个未完成的 server request。客户端按 JSON-RPC `id` 建立 pending map，不能用 `turnId` 或 `itemId` 替代。turn 完成、中断、task 关闭、工作区撤销或 App Server 重启后，旧 request 会失效；收到 `STALE_APPROVAL` 时移除本地 pending 状态，不要重试旧响应。

## 9. 工作区和路径安全

PocketPilot 会对 Codex 请求中的路径字段做授权校验。对 `turn/start` 和 `turn/steer`，受校验的字段包括 `cwd`、`runtimeWorkspaceRoots`、sandbox root、环境对象中的路径，以及 `localImage`、`skill`、`mention` 输入的路径。审批请求中的命名路径也会校验。

普通 prompt 文本不会被当作路径解析，因此用户可以正常输入类似 `D:\\outside\\file.ts` 的文字；但客户端不能为了“帮助校验”而修改 prompt。只把用户选择的授权工作区作为 `workspace`，并继续使用 Codex 原生 sandbox 和 permission profile。PocketPilot 工作区授权不是 Codex sandbox 的替代品。

## 10. 断线、重连和重放

### 10.1 重连顺序

1. 发现 Agent WebSocket 断开后，先调用 `GET /v1/tasks/{taskId}` 刷新任务状态。
2. 如果 task 是 `terminal`，停止发送；如果是 `interrupted`，按产品流程让用户确认是否重新绑定或调用可用的 resume 流程。
3. 重开 `/v1/tasks/{taskId}/agent` 前，先丢弃已损坏的进行中 delta 缓冲。省略 `afterCursor` 做完整活动 turn 重建；仅当本地已持有到该游标的一致投影、并希望只接收其后帧时，才把最近一次非 null 的订阅 checkpoint 作为 `afterCursor` 做增量回放。
4. 应用本次订阅返回的保留原生帧（完整窗口或仅后续帧），然后接续实时通知；不能把重放的文本/推理 delta 继续追加到断线前的缓冲。
5. 如果没有保留中的活动 turn，或断线期间错过了最终 `turn/completed`，读取原生历史并以历史结果替换最终 item 列表。
6. 对于发送后没有收到响应的 `turn/start`，不要因为网络超时自动再发一次；先依据 `turn/started`、`turn/completed`、task 元数据和历史判断请求是否已经执行。

### 10.2 订阅时 checkpoint 与 `afterCursor`

`afterCursor` 是 PocketPilot 的 transport 元数据，不是 Codex JSON-RPC 帧的一部分：

```text
GET /v1/tasks/{taskId}/agent?afterCursor=<opaque-cursor>
```

每次成功订阅 Codex Agent 流时，在任何保留的原生帧之前，套接字会发送且只发送一帧带外控制帧：

```json
{
  "kind": "agent.checkpoint",
  "payload": {
    "provider": "codex",
    "cursor": "180"
  }
}
```

- `payload.cursor` 是发送时刻最新保留的 journal cursor；没有保留窗口时为 `null`。
- 帧判别：`kind === "agent.checkpoint"`（且没有 `jsonrpc`）是控制帧；其后帧均为纯 Codex App Server JSON-RPC。
- 保留帧与实时原生帧保持不变；不要期望在原生帧内出现 cursor 字段。
- 已知且仍在保留窗口中的 cursor 只回放更晚的原生帧；缺失、未知、过期、格式无效或已被淘汰的 cursor 从当前保留的活动 turn 开头完整回放。新 turn 开始时该窗口会被重置；turn 完成、中断、task 关闭或工作区撤销时窗口会被清空。
- checkpoint 仅在订阅时发送一次。订阅之后发布的帧要到下次重连才会进入 checkpoint，因此可能出现短尾重放。

推荐重连流程：

1. 打开连接后，若首帧是 `agent.checkpoint` 且 `payload.cursor` 非 null，则保存为 `lastCheckpoint`。
2. 只把保留与实时 **原生** 帧应用到 UI；跳过非原生控制帧。
3. 断开后可省略 `afterCursor` 并完整重建活动 turn 投影，或在 `lastCheckpoint` 非 null 时以 `afterCursor=lastCheckpoint` 打开并接受该 checkpoint 之后帧的短尾重放。
4. 不要用 `threadId`、`turnId`、`itemId` 或消息 UUID 代替 transport cursor；需要时用原生历史核对已完成工作。

### 10.3 App Server 重启

本机 App Server 重启后会产生新的 bridge generation。PocketPilot 会重新初始化内部连接，并在继续处理 task 前调用原生 `thread/resume`。旧 generation 的审批 request 不会迁移到新连接；待处理的旧 request 必须标记失效。

## 11. 错误和关闭码

### 11.1 REST 常见错误

移动端至少应识别以下稳定错误码：

| 错误码 | 含义 | 建议处理 |
| --- | --- | --- |
| `AGENT_PROVIDER_UNAVAILABLE` | Codex 未安装、未就绪或不可用 | 刷新 provider 状态并提示电脑端处理 |
| `CODEX_THREAD_NOT_FOUND` | thread 不存在、读取失败或不属于工作区 | 从列表移除该 thread，重新加载列表 |
| `CODEX_HISTORY_UNAVAILABLE` | 历史暂时不可读 | 保留当前 UI，稍后重新读取，不要发新 prompt |
| `HISTORY_FILTER_NOT_SUPPORTED` | provider 拒绝了不支持的历史过滤条件（例如 `includeSystemMessages=true`） | 去掉不支持的过滤条件；Codex 仅接受省略或 `false` |
| `WORKSPACE_NOT_AUTHORIZED` | 请求路径或工作区不在授权范围 | 停止发送该请求，让用户重新选择工作区 |
| `TASK_BUSY` | `turnId` 或 `expectedTurnId` 过期，或当前状态不允许操作 | 刷新 task 和当前 turn 后再决定操作 |
| `CONCURRENT_TASK_LIMIT_REACHED` | 启动这个空闲 turn 会超过 Claude/Codex 共用容量 | 保留输入，等待其他活动 task 回到 idle 后重试 |
| `TASK_OPERATION_SUPERSEDED` | P0 关闭/撤销或 P1 中断使旧的排队操作失效 | 丢弃旧操作，不要自动在新 generation 上重试 |
| `TASK_CONTROL_NOT_SUPPORTED` | 对 Codex task 调用了 Claude 专用 REST 控制 | 使用 Codex 原生目录、turn 参数或原生审批响应 |
| `STALE_APPROVAL` | 审批已经失效 | 删除本地 pending 审批，不要重放 |
| `CODEX_APP_SERVER_UNAVAILABLE` | 本机 App Server 不可用或返回结构无效 | 展示服务不可用，等待下一次重连 |

### 11.2 Agent WebSocket 关闭码

| WebSocket code | reason | 处理 |
| ---: | --- | --- |
| `4000` | `SDK_MESSAGE_INVALID` | 检查是否发送了非 JSON、二进制或未允许的方法 |
| `4003` | `AUTHENTICATION_FAILED` | 刷新访问凭据或重新配对 |
| `4004` | `TASK_NOT_FOUND` | 重新获取 task 或重新绑定 thread |
| `4009` | `TASK_SESSION_UNAVAILABLE` | task 已中断或终止，先刷新任务状态 |
| `4011` | `SDK_TRANSPORT_FAILED` | 本机 provider 或桥接进程失败，指数退避后重连 |

关闭码中的 `SDK` 是历史兼容命名。对 Codex 客户端，它表示当前 provider-native transport 无效，并不代表返回的是 Claude SDK 消息。

## 12. 推荐的移动端状态机

客户端可以用以下最小状态管理，不需要另建一套 PocketPilot task：

```text
选择 provider
  -> 选择 workspace
  -> GET conversations
  -> 选择 thread / 新建 conversation
  -> attach 或 create，保存 taskId + threadId + sessionId
  -> GET 最新历史页
  -> 打开 Agent WebSocket
  -> idle: turn/start
  -> executing: 消费 native notifications/items
  -> active input: turn/steer(expectedTurnId)
  -> approval server request: 同 id 返回 native result
  -> turn/completed: 清除 activeTurnId，刷新为 idle
  -> 断线: 刷新 task，丢弃活动投影，再从完整活动 turn 重放重建
```

`taskId` 应作为网络层和缓存层的运行通道主键，`threadId` 应作为 Codex 对话主键。用户界面可以只显示一个会话，但不要把这两个值合并。模型、effort、模式和权限的选择只影响后续原生 turn，不创建新 thread 或新 task。

## 13. 与 Claude 对接的差异

| 项目 | Codex | Claude |
| --- | --- | --- |
| Agent WebSocket 帧 | Codex App Server JSON-RPC 风格对象 | Claude Agent SDK 原始 `SDKUserMessage` / `SDKMessage` |
| 初始化 | PocketPilot 内部处理，移动端不发送 | PocketPilot 内部创建或恢复 SDK Query |
| 会话历史 | `thread/turns/list`，REST 外层为 `messages` | SDK `SessionMessage` 历史 |
| 流式文本 | `item/agentMessage/delta` + `item/completed` | `stream_event` / `content_block_delta` 等 SDK 消息 |
| 活动输入 | `turn/steer(expectedTurnId)` | 按 Claude SDK 的原生消息契约发送 |
| 审批 | 原生 server request 按 JSON-RPC ID 响应；`/v1/events` 另发 provider-tagged 渲染投影 | Claude SDK `PermissionResult`/通用审批控制 |
| 模型和模式 | `model/list`、`collaborationMode/list`、`permissionProfile/list` | Claude SDK/任务 composer 选项 |
| 任务身份 | `taskId` 与 Codex `threadId` 分离 | `taskId` 与 Claude `sdkSessionId` 分离 |

移动端应先读取 `task.provider` 和 `nativeProtocolVersion`，再选择 codec。不要根据路径名称、历史会话格式或消息中的 `type` 猜测 provider。

## 14. 完整示例顺序

下面是已有 thread 的最短成功路径：

```text
1. GET /v1/providers
2. GET /v1/providers/codex/capabilities
3. GET /v1/workspaces
4. GET /v1/providers/codex/conversations?workspace=...
5. GET /v1/providers/codex/conversations/{threadId}?workspace=...&limit=50
6. POST /v1/providers/codex/conversations/{threadId}/attach
7. 保存返回的 task.id、task.nativeConversationId、task.nativeSessionId
8. GET /v1/tasks/{taskId}
9. 打开 /v1/tasks/{taskId}/agent
10. 发送 turn/start
11. 按 itemId 消费 delta 和 item/completed
12. 以 turn/started 保存 activeTurnId
13. activeTurnId 存在时使用 turn/steer
14. 收到 turn/completed 后清除 activeTurnId 并更新历史
```

新 thread 的路径只需把第 5、6 步替换为 `POST /v1/providers/codex/conversations`；不要为了创建空白 UI 会话先发送一个假的 prompt。

## 15. 参考资料和验证

- [PocketPilot OpenAPI 移动端文档](../dist/openapi/mobile-v1.json)
- [Codex App Server provider-native contract](./codex-app-server-integration.en.md)
- [通用移动端对接指南](./mobile-integration-guide.zh-CN.md)
- [OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server.md)
- [Codex App Server 源码](https://github.com/openai/codex/tree/main/codex-rs/app-server)

后端真实集成测试需要调用方提供工作区，不能把开发者电脑路径写进移动端或仓库：

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
Remove-Item Env:CODEX_APP_SERVER_TEST_CWD
```

Live 测试保持 opt-in，覆盖 readiness 探测、只读 status catalogs
（account/rateLimits/skills/hooks/mcpServers）、list 过滤、rename，以及仅针对
测试创建的 disposable thread 的 fork/archive/unarchive/delete 清理路径。
普通 `pnpm test` 不会启动 Codex App Server。移动端联调时应使用正在运行的
PocketPilot `/v1` 服务和对应访问凭据，不能绕过 PocketPilot 直接连接本机
App Server。
