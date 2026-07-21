# PocketPilot Codex 移动端对接指南

本文是 Codex 专用的客户端接入路径：移动端只连接 PocketPilot 的远程 `/v1` API。
PocketPilot 负责连接电脑上已经安装并登录的官方 Codex App Server。移动端不得直接
连接 App Server，也不得把 Codex 帧翻译成 Claude SDK 消息。

- REST 字段事实来源：本机 Swagger `/documentation/` 或随包
  [`dist/openapi/mobile-v1.json`](../dist/openapi/mobile-v1.json)
- 原生 JSON-RPC 字段事实来源：当前安装的 Codex App Server schema
- 共享认证、配对、工作区与控制 socket 规则：
  [通用移动端接入指南](./mobile-integration-guide.zh-CN.md)
- App Server 协议/生命周期说明：
  [Codex App Server 对接](./codex-app-server-integration.en.md)
- 英文等价文档：
  [Codex mobile guide (en)](./codex-mobile-integration-guide.en.md)

## 指南地图

1. [传输、认证与工作区](#1-传输认证与工作区)
2. [发现 readiness 与 capabilities](#2-发现-readiness-与-capabilities)
3. [会话 REST 生命周期](#3-会话-rest-生命周期)
4. [Agent WebSocket](#4-agent-websocket)
5. [审批](#5-审批)
6. [重连、afterCursor 与 checkpoint](#6-重连aftercursor-与-checkpoint)
7. [推荐状态机](#7-推荐状态机)
8. [错误与恢复](#8-错误与恢复)
9. [与 Claude 的差异矩阵](#9-与-claude-的差异矩阵)
10. [应该做 / 不要做](#10-应该做--不要做)

---

## 1. 传输、认证与工作区

### 1.1 两个 socket，两种职责

| 端点 | 职责 | Codex 客户端行为 |
| --- | --- | --- |
| `/v1/events` | PocketPilot 控制事件与任务控制状态 | 只解析 PocketPilot 控制信封；不要在这里找 Codex 文本或 item |
| `/v1/tasks/{taskId}/agent` | 单个任务的双向 provider-native 流 | Codex 原生 JSON-RPC 帧，外加订阅时在保留回放前发送的一帧 `agent.checkpoint` |

Agent WebSocket **不会**把帧包装成 `{ kind: "sdk", payload }` 或
`{ kind: "agent", payload }`。服务端流量是纯 Codex App Server JSON-RPC，唯一例外
是 Codex 专用的订阅时控制帧：

```json
{
  "kind": "agent.checkpoint",
  "payload": {
    "provider": "codex",
    "cursor": "180"
  }
}
```

该帧在保留的原生回放之前只发送一次。之后每个服务端帧都是一个 Codex 原生 JSON
对象。客户端每个帧必须是允许的原生 Codex 请求，或对原生 server request 的响应。

PocketPilot 通过 stdio 自行启动并初始化 App Server。移动端绝不要在 Agent
WebSocket 上发送 `initialize`、`initialized`、`thread/start`、`thread/resume`、
archive、delete 或其他会话生命周期 mutation。这些动作走 REST。

### 1.2 保持身份分离

| 标识 | 所有者 | 用途 |
| --- | --- | --- |
| `taskId` | PocketPilot | REST、Agent WebSocket、任务状态、重连与路由 |
| `threadId` / `nativeConversationId` | Codex | 一个持久对话分支；REST 路径参数 `conversationId` 就是它 |
| `sessionId` / `nativeSessionId` | Codex | Codex 会话树根身份；fork 可能共享它 |
| `turnId` / `activeTurnId` | Codex / PocketPilot | 一次正在执行的用户请求 |
| `itemId` | Codex | 用户消息、助手消息、推理、命令、文件变更或工具 item |
| JSON-RPC `id` | 请求方 | 关联一条请求与响应，包括审批 server request |
| `afterCursor` | PocketPilot transport | Agent 流回放位置；不是 Codex 的 thread/turn/item ID |
| REST `operationId` | 移动端 | 仅用于 HTTP mutation 幂等；绝不能放进原生 Codex 帧 |

`taskId` 既不是 `threadId` 也不是 `sessionId`。同一个 Codex thread 可以在不同时间
绑定到不同 PocketPilot task；同一个 task 也会连续承载多个 turn。

### 1.3 认证

除公开配对引导接口外，所有 `/v1` 请求都携带：

```http
Authorization: Bearer <accessToken>
```

两个 WebSocket 握手使用同一个 `Authorization` header。绝不要把凭据放进 URL、
query string、日志、分析、崩溃报告或截图。把 QR `baseUrl` 转成 WebSocket URL 时，
`http` → `ws`，`https` → `wss`。

配对、凭据刷新与设备撤销流程复用
[通用移动端指南](./mobile-integration-guide.zh-CN.md)。Codex 不改变 PocketPilot
设备认证。

### 1.4 选择已授权工作区

```http
GET /v1/workspaces
```

```json
{
  "workspaceRoots": [
    "D:\\Projects\\demo",
    "D:\\Projects\\another-repo"
  ]
}
```

会话列表、创建、attach、生命周期 mutation 与 Agent 请求都要求已授权工作区。让
用户选择端点返回的**完全相同**字符串。不要在客户端拼接路径、自行规范化，或改写
路径分隔符。空数组表示电脑用户尚未授权任何根目录；移动端不能发明路径。

create/attach/fork 以及需要确认的 mutation，请求体还需要
`workspaceRiskAccepted: true`。授权根目录约束初始 `cwd`，不是 Codex 工具的文件
系统沙箱。

---

## 2. 发现 readiness 与 capabilities

在把 Codex 标为可用之前，先调用：

```http
GET /v1/providers
GET /v1/providers/codex/capabilities
```

仅当 `status` 为 `available` 时展示 Codex。discovery 与 capabilities 会按短 TTL
（约 30s）在服务端刷新 readiness。不可用的 provider 仍会列出，并带稳定
`reasonCode`，例如：

| `status` | 典型 `reasonCode` | 客户端处理 |
| --- | --- | --- |
| `available` | 省略 | 在 provider 选择中提供 Codex |
| `not_installed` | `CODEX_COMMAND_NOT_FOUND` | 提示用户在电脑上安装 Codex CLI |
| `unsupported_version` | `CODEX_APP_SERVER_VERSION_UNSUPPORTED` | 提示升级/降级到受支持的 App Server |
| `unhealthy` | `CODEX_APP_SERVER_PROBE_FAILED` | 稍后重试 discovery；不要发明本机路径诊断 |
| `disabled` | 配置态稳定 reason（如有） | 隐藏执行控件；保持 discovery 诚实 |

这些响应从不包含安装路径、凭据、环境转储、原始 stderr 或堆栈。不要用本机可执行
文件路径或客户端私有 provider 列表推断可用性。主机可能安装/升级/移除 Codex 后，
重新读取 providers/capabilities。

### 2.1 封闭 capability 形状

成功的 Codex capability 快照类似如下。始终信任服务端返回的协议版本与字段：

```json
{
  "id": "codex",
  "displayName": "Codex CLI",
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

产品 UI 必须把下列对象视为封闭集合：

| Capability 对象 | 封闭键 | 说明 |
| --- | --- | --- |
| `historyFilters` | `includeSystemMessages` | Codex 发布 `false` |
| `nativeActions` | 仅 `review`、`rename`、`compact` | 未知 action 键会在服务端丢弃 |
| `statusCatalogs` | `account`、`rateLimits`、`skills`、`hooks`、`mcpServers` | 仅布尔存在性 |
| `threadManagement` | `archive`、`delete`、`fork`、`includeArchived`、`search`、`unarchive` | 仅布尔存在性 |
| `attachments` | boolean | Codex 为 `false`；不要发明附件输入 |

每个 UI 控件都应用这些封闭标志门控。capability 元数据只是描述性的；执行仍落在已
评审的 REST 或原生 Agent WebSocket 表面上。

---

## 3. 会话 REST 生命周期

所有会话 REST 路由都受 Bearer 保护，并挂在
`/v1/providers/codex/...` 下。请求/响应类型请从 OpenAPI 生成；本节负责工作流，
不复制全部 schema 字段。

### 3.1 列 thread

```http
GET /v1/providers/codex/conversations?workspace=<urlEncodedWorkspace>&limit=50&includeArchived=true&searchTerm=review
```

可选查询参数：

| Query | 何时发送 | 行为 |
| --- | --- | --- |
| `cursor` | 分页 | 不透明；在 `page.hasMore` 为 true 时原样回传 |
| `limit` | 页大小 | 最多 50 |
| `includeArchived=true` | 仅当 `threadManagement.includeArchived` 为 true | 转发为原生 `archived: true` |
| `searchTerm` | 仅当 `threadManagement.search` 为 true | trim 后原样转发 |

响应字段是 `conversations`，不是 `items`：

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

每条都是原生 Codex thread，后续版本可能新增字段。保留未知字段。PocketPilot 会
请求 CLI、VS Code 与 App Server 三类来源，然后只返回当前工作区授权范围内的
thread。

### 3.2 读历史

```http
GET /v1/providers/codex/conversations/{threadId}?workspace=<urlEncodedWorkspace>&limit=50
```

外层字段叫 `messages`，但条目是原生 Codex turns/items：

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

规则：

- 先加载最新页（省略 `cursor`），再用 `page.cursor` 向前翻更旧页并 prepend。
- 长历史必须虚拟化。若同一内容也从 live 到达，按 turn/item ID 去重。
- Codex 发布 `historyFilters.includeSystemMessages: false`。省略该 query 或发送
  `includeSystemMessages=false`。发送 `true` 会在**任何原生历史请求之前**返回
  `409 HISTORY_FILTER_NOT_SUPPORTED`。
- 绝不要把历史 item 重新拼成新的 `turn/start` 输入。

### 3.3 Attach 已有会话

```http
POST /v1/providers/codex/conversations/{threadId}/attach
Content-Type: application/json

{
  "operationId": "0c4cde63-e7a6-4a2d-a2d5-2c3a6bb16f19",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

响应是带非空 `task` 的 task operation result：

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

若该 thread 已绑定非 terminal 的 PocketPilot task，后端会复用该 task。始终使用
返回的 `task.id`。

### 3.4 创建空会话

```http
POST /v1/providers/codex/conversations
Content-Type: application/json

{
  "operationId": "d1b3a5f1-7537-440d-a64a-5c4f2a8de8a7",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

PocketPilot 调用原生 `thread/start`，返回
`{ action: "created", task }`，其中含 `taskId`、`nativeConversationId`、
`nativeSessionId`。这**不会**提交用户 prompt。打开 Agent WebSocket 后再用
`turn/start` 发送第一条用户消息。

### 3.5 Fork

```http
POST /v1/providers/codex/conversations/{threadId}/fork
Content-Type: application/json

{
  "operationId": "00000000-0000-4000-8000-000000000040",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

仅当 `threadManagement.fork` 为 true。Fork 创建新的原生 thread，并返回绑定到该
**新**会话的 `{ action: "forked", task }`。随后在返回 task 的
`/v1/tasks/{taskId}/agent` 上继续。

### 3.6 Archive / unarchive

```http
POST /v1/providers/codex/conversations/{threadId}/archive
POST /v1/providers/codex/conversations/{threadId}/unarchive
```

| 动作 | Capability | Confirm | 结果 | Task 影响 |
| --- | --- | --- | --- | --- |
| Archive | `threadManagement.archive` | 必须 `confirm: true` | `{ action: "archived", task: null }` | **不会**自动关闭已绑定 task |
| Unarchive | `threadManagement.unarchive` | 不需要 | `{ action: "unarchived", task: null }` | 不创建本地 task；Agent WS 前需重新 attach |

archive 缺少或为 false 的 `confirm` 返回 `409 CONFIRMATION_REQUIRED`。

### 3.7 Delete

```http
POST /v1/providers/codex/conversations/{threadId}/delete
Content-Type: application/json

{
  "confirm": true,
  "operationId": "00000000-0000-4000-8000-000000000041",
  "workspace": "D:\\Projects\\demo",
  "workspaceRiskAccepted": true
}
```

仅当 `threadManagement.delete` 为 true。Delete 必须 `confirm: true`，否则返回
`409 CONFIRMATION_REQUIRED`。成功返回 `{ action: "deleted", task: null }`，并在
原生 delete 成功后把绑定到该会话的本地非 terminal task 置为 terminal。从移动端
视角把 delete 视为不可逆。

### 3.8 生命周期 UI 的 capability 门控

仅当对应 `threadManagement` 布尔为 true 时渲染 fork/archive/unarchive/delete
控件。Claude 当前把这些标志全部发布为 `false`。不要发明替代 REST mutation 路由，
也不要把 archive/delete 发到 Agent WebSocket。

---

## 4. Agent WebSocket

### 4.1 attach/create 之后打开

```text
GET /v1/tasks/{taskId}/agent?afterCursor=<optional-opaque-cursor>
```

握手使用同一 Bearer 访问凭据。推荐顺序：

1. attach 或 create → 保存 `task.id`、`nativeConversationId`、`nativeSessionId`。
2. 可选加载最新历史用于展示。
3. 打开 `/v1/events` 并订阅 `taskId` 获取控制状态。
4. 打开 `/v1/tasks/{taskId}/agent`（可选 `afterCursor`）。
5. 区分首帧：`agent.checkpoint` 还是原生 JSON-RPC。
6. 先应用保留的原生帧，再消费 live 原生帧。
7. 之后才发送 `turn/start` 或目录读取等方法。

服务端会在激活前安装 native 订阅者，避免丢失早期保留或 init 流量。

### 4.2 允许的客户端方法

PocketPilot 当前在 Codex Agent socket 上接受这些客户端请求方法：

| 分组 | 方法 | 通道说明 |
| --- | --- | --- |
| Turn 启动 | `turn/start`、`review/start`、`thread/compact/start` | 仅 idle；预留共享容量；开始活动 turn 保留 |
| 活动 turn | `turn/steer`、`turn/interrupt` | 仅普通 turn 可 steer；interrupt 为 P1 |
| 重命名 | `thread/name/set` | P2；不启动 turn；不预留容量 |
| 历史读取 | `thread/read`、`thread/turns/list`、`thread/items/list` | P3 |
| 目录 | `model/list`、`collaborationMode/list`、`permissionProfile/list` | P3 |
| 状态目录 | `account/read`、`account/rateLimits/read`、`skills/list`、`hooks/list`、`mcpServerStatus/list` | P3；路径安全投影 |

会话 create/attach/fork/archive/unarchive/delete 仍走 REST。不要在该 socket 上
发送 `thread/start`、`thread/resume`、archive、delete、账户登录/登出、配置写入、
文件系统/进程 RPC、插件安装、任意 MCP 调用、detached review 或未知特权方法。

### 4.3 原生动作

读取 `capabilities.nativeActions` 获取精确方法：

| Action 键 | 方法 | Availability | 是否启动 turn | 说明 |
| --- | --- | --- | --- | --- |
| `review` | `review/start` | `idle` | 是 | `delivery` 仅允许省略/`null`/`"inline"`；拒绝 `detached` |
| `rename` | `thread/name/set` | `always` | 否 | 非空且有界的 `name`；绑定当前 task thread |
| `compact` | `thread/compact/start` | `idle` | 是 | 仅绑定当前 task thread |

review 或 compact turn 活动期间，本地应禁用 `turn/steer` UI；对当前
`activeTurnId` 的 interrupt 仍允许。运行时 turn kind 不会写入 task 行。

### 4.4 状态目录

读取 `capabilities.statusCatalogs`。Codex 当前发布：

- `account` → `account/read`
- `rateLimits` → `account/rateLimits/read`
- `skills` → `skills/list`
- `hooks` → `hooks/list`
- `mcpServers` → `mcpServerStatus/list`

客户端规则：

- 不要发送 `account/read` 且 `refreshToken: true`。
- skills/hooks 使用官方 `cwds[]`；遗留单个 `cwd` 会在服务端改写。若未提供路径根，
  PocketPilot 注入当前已授权 task 工作区，并授权每个请求根。
- 响应与白名单通知会做路径安全投影：绝对路径、邮箱、refresh token、hook
  command、原始 env/command 材料会在交付前丢弃。
- 白名单通知：`account/updated`、`account/rateLimits/updated`、`skills/changed`、
  `hook/started`、`hook/completed`、`mcpServer/startupStatus/updated`。
- 不要为状态目录发明 REST mutation 路由。

### 4.5 帧格式

客户端请求：

```json
{
  "id": "mobile-42",
  "method": "turn/start",
  "params": {
    "input": [
      {
        "type": "text",
        "text": "Explain the failing test.",
        "text_elements": []
      }
    ]
  }
}
```

服务端通知（示例）：

```json
{
  "method": "turn/started",
  "params": {
    "turn": {
      "id": "turn_019xyz",
      "status": "inProgress"
    }
  }
}
```

PocketPilot 可能跨 task 私有重映射重复的客户端 JSON-RPC ID，并仅在所属 task 流
上恢复客户端原始 ID。把 `item/agentMessage/delta` 与后续 `item/completed` 当作
常规文本路径。保留未知方法/字段；不要把 Codex item 映射成 Claude
`assistant` / `tool_use` / `stream_event` 形状。

### 4.6 Turn 生命周期摘要

```text
idle
  --turn/start | review/start | thread/compact/start--> executing
  --native server request--> awaiting_approval（任务状态经 /v1/events）
  --turn/completed | interrupt cleanup--> idle
```

- 权威活动 turn ID 来自 `turn/started`，不能只依赖请求响应。
- 当普通 turn 的 `activeTurnId` 已设置时，后续用户输入使用带该 expected turn ID
  的 `turn/steer`。
- interrupt 对 normal、review、compact 的当前活动 turn ID 都允许。
- Claude 专用 REST composer/model/mode/effort/审批路由对 Codex task 返回
  `409 TASK_CONTROL_NOT_SUPPORTED`。请改用原生目录与原生审批响应。
- Codex 远程 task 发布 `attachments: false`。不要在远程 `turn/start` 上发明附件
  输入。

---

## 5. 审批

Codex 审批是 Agent WebSocket 上的原生 App Server server-request。通过返回带相同
请求 `id` 的原生 JSON-RPC **result**（或 error）来解决。不要对 Codex 调用 Claude
的 `POST /v1/tasks/{taskId}/approvals/{requestId}`。

PocketPilot 还可能在 `/v1/events` 上投影仅含元数据的控制事件：

```json
{
  "kind": "approval.requested",
  "payload": {
    "provider": "codex",
    "requestId": "42",
    "method": "item/commandExecution/requestApproval",
    "params": {}
  }
}
```

该投影只用于任务 UI/状态。答案仍由拥有设备与 bridge generation 在 Agent
WebSocket 上以未改动的原生响应返回。对已清除、前一代或其他设备请求的响应返回
`409 STALE_APPROVAL`。

不同 method 的 result schema 不同。生产类型请从当前 App Server schema 生成，并
保留未知字段。不要把审批折叠成 `{ allowed: true }` 或 Claude
`behavior: "allow"`。

---

## 6. 重连、afterCursor 与 checkpoint

`afterCursor` 是 PocketPilot transport 元数据，不是 Codex JSON-RPC 帧内部字段：

```text
GET /v1/tasks/{taskId}/agent?afterCursor=<opaque-cursor>
```

### 6.1 订阅时 checkpoint 规则

每次成功的 Codex Agent 订阅，在任何保留原生帧之前，socket 都会发送恰好一帧
带外控制帧：

```json
{
  "kind": "agent.checkpoint",
  "payload": {
    "provider": "codex",
    "cursor": "180"
  }
}
```

| 规则 | 细节 |
| --- | --- |
| 节奏 | 仅订阅时；不是每次原生 publish 之后 |
| `payload.cursor` | 发送时最新保留 journal cursor，或窗口不存在时为 `null` |
| 区分 | `kind === "agent.checkpoint"` 且无 `jsonrpc` → 控制帧；之后帧为纯原生 |
| 已知 cursor | 只回放该 cursor 之后的原生帧 |
| 缺失 / 无效 / 未知 / 已淘汰 cursor | 回放完整保留的活动 turn |
| 保留窗口 | 仅活动 turn；新 turn 开始清空前窗口；complete/interrupt/close/revoke 清空 |
| 延迟诚实性 | checkpoint 可能在 turn 中途滞后；重连后短尾重复回放是正确行为 |

Claude 在此表面**不会**发送 `agent.checkpoint`。

### 6.2 推荐重连流程

1. 若断开原因不明，先刷新 task 元数据。
2. 重新打开 `/v1/tasks/{taskId}/agent`，任选：
   - 不带 `afterCursor`，完整重建活动 turn 投影；或
   - 在 `lastCheckpoint` 非 null 时带 `afterCursor=lastCheckpoint`，并接受该
     checkpoint 之后可能的短尾重复回放。
3. 打开后若首帧是 `agent.checkpoint`，在 `payload.cursor` 非 null 时存为
   `lastCheckpoint`。
4. 只把保留/live **原生**帧应用到 transcript；构建投影时跳过非原生控制帧。
5. 不要把回放的 text/reasoning delta 直接追加到断线前的部分缓冲区；先重置这些
   缓冲区。
6. 绝不要用 `threadId`、`turnId`、`itemId` 或消息 UUID 替代 transport cursor。
   需要时从原生历史核对已完成工作。

### 6.3 App Server 重启

App Server 进程重启会创建新的 bridge generation。PocketPilot 初始化新的内部连接
并在转发新工作前 resume 已 attach 的 thread。旧 generation 的审批 request ID
不会转移；旧 pending 请求变为 `STALE_APPROVAL`。

### 6.4 控制 socket 重连

`/v1/events` 是独立通道。为每个 `taskId` 保存单独的控制 `afterCursor`。控制回放
从不携带 Codex item。若控制回放报告 `EVENT_REPLAY_STORAGE_LIMIT_REACHED`，继续
接收 live，并从 REST 刷新 task 状态，因为缺口无法完整回放。

---

## 7. 推荐状态机

```text
选择 provider（status === available）
  -> 读取 capabilities（封闭对象）
  -> 选择已授权 workspace
  -> GET conversations（可选 includeArchived / searchTerm）
  -> 选择 thread / 创建会话 / fork
  -> attach 或 create；保存 taskId + threadId + sessionId
  -> GET 最新历史页（不要 includeSystemMessages=true）
  -> 打开 /v1/events 并 subscribe(taskId)
  -> 打开 /v1/tasks/{taskId}/agent[?afterCursor]
  -> 首帧：agent.checkpoint? 存 cursor : 按原生处理
  -> 应用保留原生帧，再应用 live 帧
  -> idle: turn/start | review/start | thread/compact/start | thread/name/set | catalogs
  -> executing: 按 itemId/turnId 归约原生通知与 item
  -> 普通活动输入: turn/steer(expectedTurnId)
  -> review/compact 活动中: 仅 interrupt（不可 steer）
  -> 审批 server request: 用相同 JSON-RPC id 返回原生 result
  -> turn/completed 或 interrupt 清理: 清除 activeTurnId -> idle
  -> 断线:
       如需则刷新 task
       丢弃部分活动投影缓冲区
       用 lastCheckpoint 或全窗口回退重连
       重新应用 checkpoint + 保留/live 原生帧
  -> archive/unarchive/delete: 仅 REST；遵守 confirm 与 task 影响
```

用 `taskId` 作为传输与运行时缓存键。用 `threadId` 作为 Codex 会话键。UI 可以展示
一个会话，但客户端不能合并这些标识。模型、effort、模式与权限选择只影响后续原生
turn，不会创建新 thread 或新 task。

---

## 8. 错误与恢复

### 8.1 常见 REST / task 错误

按稳定 `{ code, message }` 分支。`message` 仅作用户安全上下文展示。

| 错误码 | 含义 | 建议处理 |
| --- | --- | --- |
| `AGENT_PROVIDER_NOT_FOUND` | 未知 provider id | 修正客户端路由；重读 `/v1/providers` |
| `AGENT_PROVIDER_UNAVAILABLE` | Codex 已注册但不可执行 | 刷新 provider 状态；引导用户到电脑端 |
| `CODEX_THREAD_NOT_FOUND` | thread 缺失、不可读或不在工作区 | 删除过期行；重载会话列表 |
| `CODEX_HISTORY_UNAVAILABLE` | 原生历史暂时不可用 | 保留当前 UI；稍后重试历史；绝不要把历史当 prompt |
| `HISTORY_FILTER_NOT_SUPPORTED` | 不支持的历史过滤（例如 `includeSystemMessages=true`） | 去掉该过滤；Codex 仅接受 omit/`false` |
| `HISTORY_CURSOR_STALE` | 历史 cursor 已失效 | 不带 cursor 重载最新页 |
| `CONFIRMATION_REQUIRED` | archive/delete 缺少 `confirm: true` | 展示明确确认 UI，再带 `confirm: true` 重试 |
| `WORKSPACE_NOT_AUTHORIZED` | 工作区或路径越权 | 重载 `/v1/workspaces`；停止请求 |
| `WORKSPACE_SCOPE_RISK_NOT_ACCEPTED` | create/attach 体缺少风险接受 | 取得明确接受并发出新 operation |
| `TASK_BUSY` | turn 前置条件过期或状态拒绝动作 | 刷新 task 与活动 turn 状态 |
| `CONCURRENT_TASK_LIMIT_REACHED` | idle turn 会超过 Claude/Codex 共享容量 | 保留 composer 输入；等其他活动 task 变 idle 再试 |
| `TASK_OPERATION_SUPERSEDED` | P0/P1 使旧排队操作失效 | 丢弃该旧操作；不要在新 generation 上自动重试它 |
| `TASK_CONTROL_NOT_SUPPORTED` | 对 Codex task 使用了 Claude 专用 REST 控制 | 改用 Codex 原生目录、turn 参数或原生审批响应 |
| `STALE_APPROVAL` | server request 已不再对当前设备/generation 有效 | 移除本地审批 UI；不要重放 |
| `CODEX_REQUEST_NOT_ALLOWED` | 方法/参数被拒绝（detached review、空 rename、未授权路径等） | 修正客户端载荷；不要创造性转发 |
| `CODEX_APP_SERVER_UNAVAILABLE` | App Server 不可用或契约无效 | 展示 provider 不可用；等待重连 |
| `TASK_NOT_FOUND` / `TASK_TERMINAL` / `TASK_SESSION_UNAVAILABLE` | 运行时缺失或不可用 | 重新 attach 或 create；terminal 时停止重连环 |

### 8.2 Agent WebSocket 关闭码

| 码 | reason | 处理 |
| ---: | --- | --- |
| `4000` | `SDK_MESSAGE_INVALID` | 无效 JSON、二进制帧或非白名单方法；修正客户端，不要原样重发 |
| `4003` | `AUTHENTICATION_FAILED` | 刷新凭据或重新配对 |
| `4004` | `TASK_NOT_FOUND` | 重新获取 task 或重新 attach 原生 thread |
| `4009` | `TASK_SESSION_UNAVAILABLE` | 刷新 task 状态；interrupted/terminal/revoked task 不能打开该流 |
| `4011` | `SDK_TRANSPORT_FAILED` | provider 桥接失败；指数退避加抖动后重连 |

关闭 reason 中的 `SDK_*` 措辞是传输兼容保留名。对 Codex task，它描述的是
provider-native transport，不是 Claude SDK 消息。

---

## 9. 与 Claude 的差异矩阵

| 领域 | Codex | Claude |
| --- | --- | --- |
| Agent WebSocket 帧 | Codex App Server JSON-RPC 风格对象 | 原始 Claude Agent SDK `SDKUserMessage` / `SDKMessage` |
| 订阅首帧 | 可能是 `agent.checkpoint`，之后纯原生 | 无 `agent.checkpoint`；仅原始 SDK 帧 |
| 初始化 | PocketPilot 内部处理 App Server init | PocketPilot 内部创建或恢复 SDK Query |
| 历史行 | REST `messages` 下的原生 turns/items | SDK `SessionMessage` 历史 |
| `historyFilters.includeSystemMessages` | `false`；`true` → `HISTORY_FILTER_NOT_SUPPORTED` | `true`；过滤生效 |
| 流式文本 | `item/agentMessage/delta` + `item/completed` | `stream_event`、`content_block_delta` 及相关消息 |
| 活动输入 | 普通 turn 用 `turn/steer(expectedTurnId)` | 原生 Claude SDK 消息行为 |
| 审批 | 按 JSON-RPC ID 的原生 server request；`/v1/events` 另有 provider 标记投影 | Claude SDK `PermissionResult` 经审批 REST |
| 模型 / 模式 / effort | 原生 `model/list`、collaboration mode、permission profile 目录 | task composer-options + model/mode/effort REST |
| 原生动作 | 封闭的 `review` / `rename` / `compact` | 在已评审表面落地前为空 |
| 状态目录 | 封闭 account/rateLimits/skills/hooks/mcpServers | 在已评审前为空 / false |
| 线程管理 | 封闭 archive/delete/fork/includeArchived/search/unarchive | 当前全 false |
| 附件 | `false` | 视 provider；不要假设 Codex 支持 |
| 身份 | `taskId` ≠ Codex `threadId` | `taskId` ≠ Claude `sdkSessionId` |

在选择编解码前先读 `task.provider` 与 `nativeProtocolVersion`。绝不要从路径、
历史形状或消息 `type` 成员推断 provider。

---

## 10. 应该做 / 不要做

### 应该做

- 配对一次，之后对每个受保护 REST 与 WebSocket 使用 Bearer 访问凭据。
- 渲染 Codex 控件前先发现 readiness 与封闭 capabilities。
- 把 `taskId`、`threadId`、`turnId`、item ID、JSON-RPC ID、REST `operationId`
  与 transport `afterCursor` 分开放在类型化存储中。
- 加载最新历史、虚拟化，并 prepend 更旧页。
- attach/create 后打开控制 + Agent socket；在原生回放前处理订阅时
  `agent.checkpoint`。
- 只发送白名单原生方法；在 Agent socket 上原生回答审批。
- 用 capability 标志门控 fork/archive/unarchive/delete 与原生动作。
- archive 与 delete 要求显式 `confirm: true`。
- 用 last checkpoint 或全窗口回退重连；接受短尾重复回放。
- 按稳定错误码与 WebSocket 关闭码分支恢复。

### 不要做

- 不要从移动设备直接连接 Codex App Server。
- 不要包装原生帧，也不要发明超出唯一已评审 `agent.checkpoint` 的
  `{ kind: "codex", payload }` 信封。
- 不要在 Agent WebSocket 上发送 `initialize`、`thread/start`、`thread/resume`、
  archive 或 delete。
- 不要对 Codex 历史发送 `includeSystemMessages=true`。
- 不要对 Codex task 调用 Claude composer/model/mode/effort/审批 REST。
- 不要发明附件、detached review、开放式 action 目录或未评审的状态 mutation REST
  路由。
- 不要把 archive 当成已绑定 task 的自动关闭。
- 不要用原生 ID 替代 PocketPilot transport cursor。
- 不要把凭据、prompt、工具输入、主机绝对路径或原始进程诊断写入日志/分析。
- 不要在未先检查订阅时 checkpoint 例外的情况下，假定每个服务端帧都是纯原生。

---

## 完整请求序列

已有 thread 的最短成功流程：

```text
1. GET /v1/providers
2. GET /v1/providers/codex/capabilities
3. GET /v1/workspaces
4. GET /v1/providers/codex/conversations?workspace=...
5. GET /v1/providers/codex/conversations/{threadId}?workspace=...&limit=50
6. POST /v1/providers/codex/conversations/{threadId}/attach
7. 保存 task.id、task.nativeConversationId、task.nativeSessionId
8. 打开 /v1/events 并 subscribe(taskId)
9. 打开 /v1/tasks/{taskId}/agent
10. 处理 agent.checkpoint（如有），再处理保留/live 原生帧
11. 发送 turn/start
12. 按 itemId 归约 delta 与 item/completed
13. 从 turn/started 存储 activeTurnId
14. 在普通 activeTurnId 存在时使用 turn/steer
15. turn/completed 后清除 activeTurnId 并刷新历史
```

新 thread 用 `POST /v1/providers/codex/conversations` 替换步骤 5–6。不要仅为创建
空会话 UI 而发送占位 prompt。

---

## 参考与验证

- [PocketPilot mobile OpenAPI 产物](../dist/openapi/mobile-v1.json)
- [Codex App Server provider-native 契约](./codex-app-server-integration.en.md)
- [通用移动端接入指南](./mobile-integration-guide.zh-CN.md)
- [OpenAI Codex App Server 文档](https://learn.chatgpt.com/docs/app-server.md)
- [Codex App Server 源码](https://github.com/openai/codex/tree/main/codex-rs/app-server)

后端 live suite 需要调用方提供的工作区。绝不要把开发者本机绝对路径提交到客户端
或仓库：

```powershell
$env:CODEX_APP_SERVER_TEST_CWD = "<absolute-workspace-path>"
pnpm test:codex:live
Remove-Item Env:CODEX_APP_SERVER_TEST_CWD
```

Live 覆盖包括 readiness discovery、只读状态目录
（`account` / `rateLimits` / `skills` / `hooks` / `mcpServers`）、rename、列表
过滤，以及仅对可丢弃 thread 的 fork+cleanup。普通 `pnpm test` 不会启动 Codex App
Server。移动端集成测试必须使用运行中的 PocketPilot `/v1` 服务及其配对设备凭据；
不得绕过 PocketPilot 直接连接本机 App Server。
