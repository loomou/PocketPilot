# PocketPilot Local Admin 配置页对接指南

> 本文于 2026 年 7 月 19 日核对。内容描述当前分支的真实实现，不把目标行为写成已经上线的行为。

## 1. 目的与事实来源

本文面向负责 PocketPilot Local Admin 配置页的前端、后端和联调开发者，覆盖本地回环管理监听器、配置持久化、工作区授权、设备配对、设备撤销、审计元数据、维护边界，以及当前前后端流程核对结果。

事实来源按以下优先级排列：

1. 路由与 schema：`src/local-admin/app.ts`、`src/local-admin/configuration-routes.ts`、`src/local-admin/authorized-directory-routes.ts`、`src/auth/local-admin-routes.ts`。
2. 服务与持久化所有者：`src/runtime/settings.ts`、`src/tasks/settings.ts`、`src/tasks/workspace-authorization-coordinator.ts`、`src/tasks/task-manager.ts`、`src/local-admin/directory-selection-service.ts`、`src/auth/device-auth-service.ts`。
3. 浏览器 API 客户端和状态转换：`apps/local-admin/src/api/local-admin.ts` 与 `apps/local-admin/src/features/administration/`。
4. `test/local-admin/`、`test/auth/`、`apps/local-admin/test/` 下的后端和前端测试。

`/documentation/` 的 Swagger UI 只描述远程移动端 `/v1` API，明确排除 `/admin/*` 和 `/_internal/*`。本文是 Local Admin 的对接参考。

## 2. 监听器与安全边界

### 2.1 监听器隔离

| 表面 | 默认地址 | 用途 |
| --- | --- | --- |
| Local Admin | `http://127.0.0.1:43183` | 浏览器页面、`/admin/*`、本地 Swagger UI、终端控制接口 |
| 远程移动端 API | `http://127.0.0.1:43182`，直到被重新配置 | 移动端 `/v1/*` REST 与 WebSocket API |

Runtime 始终把 Local Admin 绑定到 `127.0.0.1`。可配置的远程监听器与它分离。后端测试确认：管理、授权管理和文档路由在远程监听器上均返回 `404`。

`POCKETPILOT_LOCAL_ADMIN_PORT` 可以改变 Local Admin 端口；CSRF 校验所需的 Origin 也会随绑定端口改变。

### 2.2 CSRF 约定

1. 从当前 Local Admin 同源地址请求 `GET /admin/csrf`。
2. 每个不安全方法（`POST`、`PUT`、`PATCH`、`DELETE`）都发送：
   - `Origin: http://127.0.0.1:<local-admin-port>`
   - `x-pocketpilot-csrf-token: <来自 /admin/csrf 的 token>`
3. 浏览器的同源 fetch 会自动发送 Origin。测试客户端或非浏览器集成必须显式发送它。
4. 缺少、错误或 Origin 不同的请求返回 HTTP `403`：

```json
{
  "code": "LOCAL_ADMIN_CSRF_REJECTED",
  "message": "This local administration request was rejected by CSRF protection."
}
```

`GET`、`HEAD`、`OPTIONS` 不要求 CSRF header。内部 shutdown 路由不走 CSRF，因为它使用独立的 runtime control token；它不能暴露成浏览器按钮。

### 2.3 错误和响应处理

`apps/local-admin/src/api/local-admin.ts` 使用 Zod 校验所有成功的浏览器响应。非 2xx 且响应形如 `{ "code": string, "message": string }` 时，会转换为 `LocalAdminApiError`。非法 JSON，或成功响应不符合预期 schema 时，会转换为 `LOCAL_ADMIN_RESPONSE_INVALID`。非 2xx 但没有结构化错误体时，会转换为 `LOCAL_ADMIN_REQUEST_FAILED`。

Fastify 的请求 schema 校验失败通常返回 HTTP `400` 及 Fastify 自带的校验响应，而不是稳定的 `{ code, message }` 应用错误格式。

## 3. 数据所有权与生效时机

| 数据 | 存储/所有者 | 何时变化或生效 |
| --- | --- | --- |
| CSRF token | Runtime 内存 | Agent 每次启动时重新生成 |
| 当前监听器状态 | Runtime 进程 | 表示本次进程真正绑定的监听器 |
| Runtime 配置 | Settings repository，key 为 `runtime` | 立即持久化；监听器与 `mobileBaseUrl` 行为在下次手动启动时读取 |
| 并发容量和工作区根目录 | Settings repository，key 为 `task-runtime` | 通过校验后持久化；工作区授权会立即影响后续任务准入 |
| 配置表单草稿 | 浏览器 React state | 点击保存前不持久化；放弃操作恢复前端最近一次 snapshot |
| 原生 picker 选择 | `DirectorySelectionService` 内存 | 一次性使用，2 分钟后过期，最多保留 32 个选择 |
| 配对请求 | SQLite | 5 分钟后过期，且只能注册一个设备 |
| 已配对设备和凭据 verifier | SQLite | 直到 reset 前持续存在；明文 access/refresh 凭据不存储 |
| 审计记录 | SQLite | 只返回元数据，按最新优先 |

关键区别：保存 `mobileBaseUrl` 或远程监听器不会热更新当前 Runtime。直到 Agent 手动停止并重新启动，`GET /admin/status` 仍然描述当前已绑定的监听器和启动时配置。

## 4. Local Admin 接口清单

以下路径均位于 Local Admin 监听器上。

| 方法 | 路径 | 当前页面使用情况 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/admin/status` | 初始加载、刷新 | 当前 Runtime 监听器和运行状态 |
| `GET` | `/admin/csrf` | 初始加载、刷新 | 获取 CSRF token |
| `GET` | `/admin/configuration` | 初始加载、刷新 | 读取持久化的 Runtime/task 配置 |
| `PUT` | `/admin/configuration/runtime` | 保存配置 | 持久化 Runtime 配置 |
| `PUT` | `/admin/configuration/tasks` | 保存配置 | 校验并持久化并发容量与工作区根目录 |
| `POST` | `/admin/directories/browse` | 已授权目录 tab | 服务端目录浏览器 |
| `POST` | `/admin/directories/inspect` | 已授权目录 tab | 检查可用性、规范路径、覆盖关系和高风险状态 |
| `GET` | `/admin/authorized-directories` | API 客户端存在；页面不调用 | 带 revision 的授权目录 snapshot |
| `POST` | `/admin/authorized-directories/pick` | API 客户端存在；页面不调用 | 打开 Agent 电脑上的原生目录选择器 |
| `POST` | `/admin/authorized-directories` | API 客户端存在；页面不调用 | 消费 picker 选择并立即授权 |
| `POST` | `/admin/authorized-directories/remove` | API 客户端存在；页面不调用 | 带 revision 检查的删除，可能停止受影响任务 |
| `POST` | `/admin/pairings` | 设备页面 | 创建二维码配对请求 |
| `GET` | `/admin/pairings/pending` | 初始加载、刷新 | 列出等待本机批准的移动端注册 |
| `POST` | `/admin/pairings/:pairingId/approve` | 设备页面、二维码弹窗 | 批准匹配的六位移动端验证码 |
| `GET` | `/admin/devices` | 初始加载、刷新 | 列出有效和已撤销设备 |
| `POST` | `/admin/devices/:deviceId/revoke` | 设备页面 | 撤销设备及其当前访问 |
| `GET` | `/admin/audits` | 初始加载、刷新 | 读取只含元数据的审计记录 |
| `POST` | `/_internal/shutdown` | 有意不暴露 | 使用 control token 的终端专用协调关闭 |

## 5. 初始加载与刷新

页面通过 `Promise.all` 并行请求以下六个接口：

```text
GET /admin/csrf
GET /admin/configuration
GET /admin/status
GET /admin/pairings/pending
GET /admin/devices
GET /admin/audits
```

示例响应：

```jsonc
// GET /admin/csrf
{ "token": "runtime-scoped-secret" }
```

```jsonc
// GET /admin/configuration
{
  "runtime": {
    "mobileBaseUrl": "https://agent.example.test",
    "remoteListener": { "host": "0.0.0.0", "port": 43182 }
  },
  "tasks": {
    "concurrentTaskCapacity": 3,
    "workspaceRoots": ["C:\\code"]
  }
}
```

```jsonc
// GET /admin/status
{
  "localAdminListener": { "host": "127.0.0.1", "port": 43183 },
  "mobileBaseUrl": "https://agent.example.test",
  "remoteListener": { "host": "0.0.0.0", "port": 43182 },
  "status": "running"
}
```

全新安装时，不返回 `mobileBaseUrl`，远程监听器为 `127.0.0.1:43182`，默认并发任务数为 `3`，工作区根目录为空。

加载成功后，`AdministrationPage.refresh()` 会同时替换服务端 snapshot 和配置草稿。这一点会影响第 12 节的核对结论。

## 6. Runtime 与 task 配置流程

### 6.1 Runtime 配置

请求：

```http
PUT /admin/configuration/runtime
Origin: http://127.0.0.1:43183
x-pocketpilot-csrf-token: <token returned by /admin/csrf>
Content-Type: application/json
```

```json
{
  "mobileBaseUrl": "https://agent.example.test",
  "remoteListener": {
    "host": "0.0.0.0",
    "port": 43182
  }
}
```

`mobileBaseUrl` 可选，但存在时必须是绝对 URL。`remoteListener.host` 会 trim，长度为 1–255；`port` 必须是 1–65535 的整数。响应返回校验后的对象。

### 6.2 Task 配置

请求：

```http
PUT /admin/configuration/tasks
Origin: http://127.0.0.1:43183
x-pocketpilot-csrf-token: <token returned by /admin/csrf>
Content-Type: application/json
```

```json
{
  "concurrentTaskCapacity": 5,
  "workspaceRoots": ["C:\\code", "D:\\projects"],
  "confirmedHighRiskRoots": []
}
```

响应：

```json
{
  "concurrentTaskCapacity": 5,
  "workspaceRoots": ["C:\\code", "D:\\projects"]
}
```

规则：

- 并发容量必须是 1–1024 的整数。
- 最多 1024 个根目录，每个路径长度为 1–4096 个 trim 后字符。
- 新增根目录必须是现有、可访问、绝对路径的目录。
- 新路径持久化前会 canonicalize。
- canonical 后重复的根目录会被拒绝。
- 新增 filesystem/volume root 时，必须在 `confirmedHighRiskRoots` 中显式确认 canonical 路径。
- 以前保存过但当前不可用或 identity changed 的路径会原样保留，不会静默改写。
- 保存使用 revision 检查和串行提交 lane，避免覆盖并发策略变更；重试耗尽时返回可重试的 workspace-unavailable 错误。

当前页面先 PUT runtime，再 PUT tasks。这是两个独立写入，不是一个事务。如果 runtime 写入成功、task 校验失败，后端会处于部分更新状态，而页面会显示一次整体失败并保留旧 snapshot。

## 7. 工作区授权流程

后端当前提供两套作用于同一个 `workspaceRoots` 配置的管理界面，二者行为不同但可以兼容。

### 7.1 当前页面使用的暂存式浏览流程

Configuration > 已授权目录 tab 使用 `/admin/directories/browse`、`/admin/directories/inspect`，最后调用 `PUT /admin/configuration/tasks`。

浏览请求：

```json
{ "path": "C:\\work" }
```

省略 `path` 或发送 `{}`，会列出平台根目录和 home 位置。响应：

```json
{
  "currentPath": "C:\\work",
  "parentPath": "C:\\",
  "entries": [
    {
      "name": "project-a",
      "path": "C:\\work\\project-a",
      "accessible": true,
      "root": false
    }
  ],
  "truncated": false
}
```

只返回目录。达到上限时将 `truncated` 设为 `true`。重要浏览错误包括 `DIRECTORY_PATH_INVALID`（`400`）和 `DIRECTORY_NOT_ACCESSIBLE`（`422`）。

Inspect 请求与响应：

```json
{ "paths": ["C:\\work\\project-a", "C:\\missing"] }
```

```json
[
  {
    "configuredPath": "C:\\work\\project-a",
    "canonicalPath": "C:\\work\\project-a",
    "status": "available",
    "highRisk": false
  },
  {
    "configuredPath": "C:\\missing",
    "status": "unavailable",
    "highRisk": false
  }
]
```

响应保持请求顺序。当另一个已 inspect 的可用根目录已经覆盖当前路径时，会返回 `coveredBy`。页面添加或删除的行只存在于浏览器草稿中；点击保存才持久化完整替换后的列表；放弃操作恢复最近一次 snapshot。

### 7.2 后端提供的原生 picker 与立即持久化流程

该流程保证 add 接口不会接受任意本地路径。

1. 读取带 revision 的 snapshot：

```jsonc
// GET /admin/authorized-directories
{
  "revision": 7,
  "directories": [
    {
      "path": "C:\\code",
      "status": "available",
      "volumeRoot": false,
      "nonTerminalRuntimeCount": 2
    }
  ]
}
```

2. 打开原生目录选择器：

```http
POST /admin/authorized-directories/pick
```

```json
{
  "status": "selected",
  "selectionId": "00000000-0000-4000-8000-000000000010",
  "path": "D:\\projects",
  "volumeRoot": false,
  "expiresAt": 1900000000000
}
```

取消返回 `{ "status": "cancelled" }`。Windows picker 已实现；不支持的平台返回 `DIRECTORY_PICKER_UNAVAILABLE`（`503`）。同时打开多个 picker 可能返回 `DIRECTORY_PICKER_BUSY`（`409`）。

3. 消费一次性 selection：

```jsonc
// POST /admin/authorized-directories
{
  "selectionId": "00000000-0000-4000-8000-000000000010",
  "volumeRootRiskAccepted": false
}
```

```json
{
  "result": "added",
  "selectedPath": "D:\\projects",
  "removedRedundantPaths": [],
  "snapshot": {
    "revision": 8,
    "directories": [
      {
        "path": "D:\\projects",
        "status": "available",
        "volumeRoot": false,
        "nonTerminalRuntimeCount": 0
      }
    ]
  }
}
```

selection 2 分钟后过期，且在消费时即使后续授权校验失败也会被消耗。重复使用或过期返回 `DIRECTORY_SELECTION_UNAVAILABLE`（`409`）。整个 volume 的授权必须发送 `volumeRootRiskAccepted: true`。添加父目录可能移除冗余子目录；添加已经被覆盖的子目录返回 `result: "already-covered"` 和 `coveringPath`。

4. 使用乐观并发 snapshot 删除：

```jsonc
// POST /admin/authorized-directories/remove
{
  "path": "C:\\code",
  "revision": 8,
  "expectedNonTerminalRuntimeCount": 2,
  "runtimeStopAccepted": true
}
```

```json
{
  "removedPath": "C:\\code",
  "stoppedTaskCount": 2,
  "snapshot": {
    "revision": 9,
    "directories": []
  }
}
```

后端当前要求 `runtimeStopAccepted: true`。revision 或受影响任务数变化时返回 `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE`（`409`）；应重新读取 snapshot，并再次请求用户确认。删除可用根目录可能使失去授权的非终态任务进入终态，并关闭其 SDK 连接。删除不可用的已保存根目录不会影响运行中任务。

## 8. 配对流程

### 8.1 前置条件

必须先持久化移动端可访问的 `mobileBaseUrl`，然后重新启动 Agent 使新配置加载。否则 `POST /admin/pairings` 返回 HTTP `409` 和 `MOBILE_BASE_URL_NOT_CONFIGURED`。

### 8.2 端到端时序

1. 电脑创建有效期五分钟的配对请求：

```jsonc
// POST /admin/pairings — HTTP 201
{
  "pairingId": "00000000-0000-4000-8000-000000000020",
  "expiresAt": 1900000000000,
  "qrPayload": {
    "version": 1,
    "agentId": "00000000-0000-4000-8000-000000000001",
    "baseUrl": "https://agent.example.test",
    "pairingId": "00000000-0000-4000-8000-000000000020",
    "expiresAt": 1900000000000
  }
}
```

浏览器把 `qrPayload` 原样序列化成 JSON 并渲染二维码。payload 不含 access 或 refresh credential。

2. 移动端扫描二维码，生成 Ed25519 密钥对，并通过远程 listener/base URL 注册：

```jsonc
// POST /v1/pair/{pairingId}/register
{
  "deviceDisplayName": "Pixel 9",
  "devicePublicKey": "<32-byte Ed25519 public key in base64url>"
}
```

```json
{
  "pairingId": "00000000-0000-4000-8000-000000000020",
  "verificationCode": "321654",
  "expiresAt": 1900000000000
}
```

注册是一次性的。电脑随后可以通过 `GET /admin/pairings/pending` 获取等待批准的记录。

3. 用户在二维码弹窗或待批准列表中输入移动端显示的六位验证码。电脑在本地批准：

```jsonc
// POST /admin/pairings/{pairingId}/approve
{ "verificationCode": "321654" }
```

```json
{
  "id": "00000000-0000-4000-8000-000000000021",
  "displayName": "Pixel 9",
  "createdAt": 1900000000100,
  "revokedAt": null
}
```

验证码错误返回 `PAIRING_VERIFICATION_CODE_MISMATCH`（`409`）。过期返回 `PAIRING_EXPIRED`（`410`）。不存在或状态不正确的配对返回 `PAIRING_NOT_FOUND`（`404`）或 `PAIRING_NOT_PENDING`（`409`）。

4. 移动端请求 `/v1/pair/{pairingId}/claim-challenge`，用私钥对返回的 `message` 签名，然后把签名和 `challengeId` POST 到 `/v1/pair/{pairingId}/claim`。

5. 远程 API 返回首组 access token、refresh token 和 access 过期时间。PocketPilot 只存加密 verifier，不存凭据明文。若领取响应丢失，移动端可以再次通过签名 claim 恢复；旧凭据会被撤销。

## 9. 设备列表与撤销

`GET /admin/devices` 按创建时间从旧到新返回设备，包括已撤销设备：

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000021",
    "displayName": "Pixel 9",
    "createdAt": 1900000000100,
    "revokedAt": null
  }
]
```

撤销：

```http
POST /admin/devices/00000000-0000-4000-8000-000000000021/revoke
```

```json
{ "revoked": true }
```

首次撤销会写入设备时间、撤销有效 access token，并立即关闭已注册的实时连接。重复请求或传入未知 UUID 返回 `{ "revoked": false }`；从 HTTP 调用方角度看是幂等的。其他独立配对的设备不受影响。

## 10. 审计记录

`GET /admin/audits` 按最新优先返回：

```json
[
  {
    "id": "00000000-0000-4000-8000-000000000030",
    "occurredAt": 1900000000200,
    "operation": "task.created",
    "result": "success",
    "deviceId": null,
    "taskId": null
  }
]
```

该接口只返回元数据。测试确认 prompt、模型输出和 tool input 不会暴露。operation 和 result 是服务端拥有的 opaque 值；前端会展示未知值，不翻译也不重写。

浏览器没有提供过滤、分页、删除或 retention 修改接口。当前过滤在已加载的 snapshot 上由客户端完成。

## 11. 维护边界

浏览器 Maintenance 页面只是说明页。rekey 和破坏性 reset 保留在终端命令：

```text
agent rekey
agent reset --confirm RESET_AGENT_DATA
```

协调关闭接口是：

```http
POST /_internal/shutdown
x-pocketpilot-control-token: <runtime control token>
```

成功返回 HTTP `202` 和 `{ "status": "stopping" }`。该 token 写入 runtime control state，供 CLI 使用。Local Admin UI 不得读取、存储或暴露它。

## 12. 前后端流程核对

分类含义：**Aligned** 表示当前页面遵循后端契约；**Partial** 表示主要请求正确，但状态或 UX 对账不完整；**Mismatch** 表示行为与当前实现契约或预期路由冲突；**Not exposed** 表示后端能力存在，但有意没有浏览器控制。

| 范围 | 结果 | 严重度 | 证据与影响 | 建议 |
| --- | --- | --- | --- | --- |
| 初始 snapshot | Aligned | — | `loadLocalAdminSnapshot()` 调用六个已挂载 GET 路由并校验响应；后端证据为 `src/local-admin/app.ts`、`configuration-routes.ts`、`src/auth/local-admin-routes.ts`。 | 持续同步前端 schema 与后端 route schema。 |
| CSRF | Aligned | — | API 客户端给每个 mutation 添加 `x-pocketpilot-csrf-token`；同源浏览器 fetch 自动提供所需 Origin；后端在 `src/local-admin/csrf.ts` 同时校验两者。 | 非浏览器测试/集成必须显式设置 Origin。 |
| Runtime 配置 | Aligned | — | 表单字段对应 `runtimeSettingsSchema`；页面明确提示监听器变化要重启。 | 继续区分当前 `/admin/status` 和已保存的 `/admin/configuration`。 |
| 组合配置保存 | Partial | 高 | `AdministrationPage.saveConfiguration()` 先 PUT runtime，再 PUT task；后端是两个独立持久化操作，没有事务。task 校验失败时 runtime 可能已经保存，但页面显示一次整体失败并保留旧 snapshot。 | 逐次写入后对账，或新增事务型聚合接口；至少要显示部分保存状态并重新加载持久化数据。 |
| 已授权目录 tab 的暂存流程 | Aligned | — | `workspace-authorization.tsx` 使用 browse/inspect，编辑 `configuration.tasks.workspaceRoots`；`App.test.tsx` 验证改动可放弃且高风险确认会在保存时发送。 | 明确文档化它是暂存式完整替换流程。 |
| 原生 picker 授权 API | Not exposed | 中 | API 客户端实现了 `loadAuthorizedDirectories`、`pickAuthorizedDirectory`、`addAuthorizedDirectory`、`removeAuthorizedDirectory`，但没有组件导入或调用。可见 tab 使用服务端浏览，而不是 Agent 电脑原生 picker，也不使用 revision/受影响任务信息。 | 选择并统一产品契约。如果要求“在电脑上选择目录”，应把 tab 迁移到 `/admin/authorized-directories/*`；否则移除/废弃未使用的客户端接口，并解释两套后端流程为何并存。 |
| 原生删除安全流程 | Not exposed | 若预期使用原生流程则为高 | 当前删除行只修改浏览器草稿，不确认 `nonTerminalRuntimeCount`，不发送 `revision`，不处理 `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE`，也不提示任务可能停止。这些语义仅存在于 `TaskManager.removeAuthorizedDirectory()`。 | 采用原生流程时，删除前刷新 snapshot，展示受影响任务数，要求显式接受停止，并使用返回 snapshot 替换本地状态。 |
| 配对二维码生成 | Aligned | — | 浏览器原样使用后端 `qrPayload` 生成二维码并显示过期时间；`DeviceAuthService.createPairing()` 负责 identity、base URL 和五分钟有效期。 | 不要在浏览器自行构造 QR identity 或 base URL。 |
| 二维码弹窗输入验证码批准 | Aligned | — | `devices-view.tsx` 在同一弹窗同时显示二维码和六位数字输入框；批准向生成的 pairing ID 发送 `{ verificationCode }`。`App.test.tsx` 验证数字过滤和精确请求体。 | 移动端返回的验证码应作为唯一核对来源。 |
| 待批准配对列表 | Aligned | — | 初始加载请求 `/admin/pairings/pending`；后端按注册顺序返回已注册、未过期、未批准配对。 | 如果旧规范声称页面不调用该接口，应更新旧文档，而不是修改当前后端结论。 |
| 配对/设备 mutation 刷新与未保存配置 | Mismatch | 中 | 生成二维码、批准配对或撤销设备后，`refresh(true)` 会用服务端 configuration 覆盖 `configurationDraft`；`preserveNotice` 只保留提示，不保留草稿。未保存的普通配置或目录改动可能无提示丢失。现有测试覆盖语言切换保留草稿，但未覆盖三种 mutation 后的刷新。 | 非配置刷新时保留 dirty draft，或覆盖前提示；为三种 mutation 增加回归测试。 |
| 设备撤销 | 带对账风险的 Aligned | 中 | 接口和响应匹配；后端立即撤销 access 并关闭实时连接。页面刷新设备状态，但同一个 refresh 可能抹掉 dirty configuration draft。 | 保留返回/刷新后的设备状态为权威，并修复草稿保留。 |
| 审计页面 | Aligned | — | 页面读取只含元数据的记录并在客户端搜索/过滤；未知 operation/result 保持 opaque。 | 只有审计量需要时再增加服务端分页。 |
| 响应校验 | Aligned | — | 前端 Zod schema 拒绝非法成功 payload；测试覆盖非法 browse/inspect 和 snapshot。 | 接口字段变化时继续补充 schema 测试。 |
| Maintenance shutdown/rekey/reset | Not exposed | — | 页面只提供终端说明；不会调用 control-token shutdown 接口。 | 保持终端专用信任边界。 |

### 12.1 总体结论

配置页面对于其选定的**暂存式配置流程**，以及配对、设备、审计、状态和 CSRF 契约，与后端一致。但它当前**没有使用后端的原生 picker、revision 和授权目录立即持久化流程**，即使 API 客户端已经实现了对应函数。当前代码还有两个联调风险：组合配置保存可能部分成功；配对或设备相关刷新可能静默覆盖未保存的配置草稿。

## 13. 错误与恢复参考

| code | 常见状态码 | 恢复方式 |
| --- | --- | --- |
| `LOCAL_ADMIN_CSRF_REJECTED` | `403` | 从同一个 Local Admin Origin 重新获取 CSRF token；不要跨 Origin 重试。 |
| `LOCAL_ADMIN_RESPONSE_INVALID` | 客户端生成 | 视为前后端版本不一致；不要渲染未校验数据。 |
| `LOCAL_ADMIN_REQUEST_FAILED` | 客户端生成 | 展示通用 Local Agent 失败并允许重试。 |
| `DIRECTORY_PATH_INVALID` | `400` | 提交绝对目录路径，或返回根目录/home。 |
| `DIRECTORY_NOT_ACCESSIBLE` | `422` | 选择其他可访问目录。 |
| `WORKSPACE_PATH_INVALID` | `422` | 修正容量或根目录 payload。 |
| `WORKSPACE_PATH_UNAVAILABLE` | `422` | 刷新/inspect；移除或恢复不可用的新根目录后重试。 |
| `WORKSPACE_PATH_NOT_DIRECTORY` | `422` | 选择目录而不是文件。 |
| `WORKSPACE_ROOT_DUPLICATE` | `422` | 移除 canonical 后重复的根目录。 |
| `WORKSPACE_ROOT_HIGH_RISK_CONFIRMATION_REQUIRED` | `422` | 展示整卷风险警告，并在 `confirmedHighRiskRoots` 发送 canonical 路径。 |
| `DIRECTORY_PICKER_BUSY` | `409` | 等待正在运行的原生 picker 结束。 |
| `DIRECTORY_PICKER_UNAVAILABLE` | `503` | 说明平台/Runtime 限制；只有产品策略允许时才使用暂存浏览流程。 |
| `DIRECTORY_SELECTION_UNAVAILABLE` | `409` | 重新打开 picker；selection 已过期或被消费。 |
| `VOLUME_ROOT_RISK_NOT_ACCEPTED` | `422` | 获得明确的整卷授权后，用风险标记重试。 |
| `AUTHORIZED_DIRECTORY_INVALID` | `422` | 重新选择可访问目录。 |
| `AUTHORIZED_DIRECTORY_NOT_FOUND` | `404` | 重新加载授权 snapshot。 |
| `AUTHORIZED_DIRECTORY_SNAPSHOT_STALE` | `409` | 用新 revision/count 重新加载 snapshot 并再次请求确认。 |
| `MOBILE_BASE_URL_NOT_CONFIGURED` | `409` | 保存移动端可访问 URL，手动重启 Agent，再创建配对。 |
| `PAIRING_NOT_FOUND` | `404` | 本地请求不存在时生成新二维码。 |
| `PAIRING_ALREADY_USED` | `409` | 生成新二维码；注册只能使用一次。 |
| `PAIRING_NOT_PENDING` | `409` | 刷新待批准配对；它可能已批准或尚未注册。 |
| `PAIRING_VERIFICATION_CODE_MISMATCH` | `409` | 重新输入移动端显示的完整六位验证码。 |
| `PAIRING_EXPIRED` | `410` | 生成并扫描新二维码。 |
| `LOCAL_ADMIN_OPERATION_FAILED` | `500` | 展示通用失败；后端有意隐藏存储/Runtime 细节。 |

## 14. 联调 checklist

### 启动与安全

- [ ] 只从本机回环 Local Admin 监听器打开页面。
- [ ] Agent 重启或页面重新加载后获取新的 CSRF token。
- [ ] 不安全请求同时发送同源 `Origin` 和 CSRF header。
- [ ] 验证 `/admin/*` 和 `/documentation/*` 在远程监听器上不可用。

### 配置

- [ ] 把已保存配置与当前生效状态分开显示。
- [ ] 明确告知监听器和 mobile URL 修改需要手动重启。
- [ ] 把两个 configuration PUT 当作独立可失败写入处理。
- [ ] 刷新和无关 mutation 时保留 dirty 草稿，或明确提示用户丢弃。

### 工作区授权

- [ ] 选择并记录暂存式 browse/inspect/save，或原生 picker/立即持久化作为产品流程。
- [ ] 暂存根目录添加前执行 canonicalize 和 inspect。
- [ ] filesystem/volume root 必须显式确认。
- [ ] 如果使用原生删除，显示受影响任务数，并从最新 GET snapshot 处理 stale 重试。
- [ ] 用 mutation 返回的 snapshot 替换客户端状态，不要预测 revision。

### 配对和设备

- [ ] 创建二维码前配置并激活移动端可访问的 base URL。
- [ ] 原样编码后端返回的 `qrPayload`。
- [ ] 只接受注册移动端返回的六位验证码。
- [ ] 只有本地批准并完成签名 challenge 后，移动端才能领取凭据。
- [ ] 撤销后立即视移动端实时连接和 access token 为无效。

### 审计和维护

- [ ] 把审计 operation/result 作为服务端 opaque 数据渲染。
- [ ] 永不暴露 prompt、输出、tool input、master key、control token 或存储的 credential verifier。
- [ ] 把 shutdown、rekey、reset 保持在终端控制的信任边界内。
