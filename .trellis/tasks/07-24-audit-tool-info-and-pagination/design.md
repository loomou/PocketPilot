# Design — 审计记录工具信息与服务端分页

## Boundaries

改动集中在两条既有链路,不引入新模块:

1. **审计写入链路**（后端）：`applyApprovalResponse` (task-manager) → `executeIdempotent` → `persistOperation` (task-repository) → `audit_records` 表。
2. **审计读取链路**：`GET /admin/audits` (configuration-routes) → `local-admin.ts` API 客户端 → `audit-view.tsx`。

不改动移动端契约（`/v1/tasks/:taskId/approvals/:requestId` 请求体不变）。工具信息在服务端从 `pending.approval` 就地取得，移动端无需传任何新字段。

## Part A — 审计记录“批准了什么”

### A1. Spec 契约修订（前置，必须先做）

`local-admin-contracts.md` 现规定 `/admin/audits` 只返回 6 字段且“tool parameters ... have no response field”。本任务新增 `toolName` 列直接与之冲突，必须修订该契约，重画边界：

- **允许**：受控工具元数据 —— 工具名（`Skill`/`Bash`/`Edit`...）加稳定标识符摘要（skill 名 `claude-api`、MCP 工具名）。
- **仍禁止**：任何用户内容 —— Bash 命令串、文件路径与内容、prompt 文本、URL、凭据、密钥。

新增字段命名 `toolName`（可空 text 列）。语义：`<工具名>` 或 `<工具名>:<安全标识符>`。仅在 approval 类审计行有值，其它操作行为 `null`。

### A2. 数据库

`audit_records` 加一列 `tool_name text`（可空）。走 drizzle：改 `schema.ts` → `pnpm exec drizzle-kit generate` 生成 `0006_*.sql` + 快照 + `_journal.json`，同一提交一起改。可空列，纯 additive，历史行为 `null`，无数据迁移风险。

30 天保留清理（`maintenance.ts`）不受影响（按 `occurred_at` 删整行）。

### A3. 安全摘要提取器（新纯函数）

新增 `src/tasks/audit-tool-summary.ts`，导出 `summarizeToolForAudit(toolName: string, input: Record<string, unknown>): string`。

规则（白名单，默认只吐工具名）：

| 工具 | 摘要输出 | 来源字段 |
|---|---|---|
| `Skill` | `Skill:<command>` | 防御式取 `command` → `skill` → `name`，取字符串则拼接 |
| MCP 工具（`mcp__*`） | 原样工具名（已含 server/tool） | — |
| 其它（Bash/Edit/Read/Write/...） | 仅 `toolName` | 不读 input |

约束：
- 只接受 `string` 类型的标识符值；非字符串或缺失则退回纯工具名。
- 标识符做 `[A-Za-z0-9._:-]` 白名单过滤 + 截断（上限 64 字符），杜绝任何自由文本泄漏。
- 永不读取 `command`（Bash）、`file_path`、`content`、`prompt`、`url`、`pattern` 等可含用户内容的字段。

设计成独立纯函数便于单测穷举，且让“哪些字段安全”这一决策集中在一处、可审查。

### A4. 写入点接线

- `applyApprovalResponse` 的返回结构 `OperationExecution`（含 `action`/`auditResult`/`task`）新增可选 `auditToolName?: string`。此处 `pending.approval` 仍在作用域内，可读 `pending.approval.toolName` 与 `pending.approval.input`，调用 A3 得到摘要。
- `executeIdempotent` 把 `execution.auditToolName` 透传给 `persistOperation`。
- `persistOperation` 入参加可选 `toolName?: string | null`，写入 `audit_records.tool_name`。
- `recordAudit` 与其它 `recordAudit`/`persistOperation` 调用点：`toolName` 省略 → 存 `null`，行为不变。

### A5. 读取与前端

- `GET /admin/audits` 的 `auditRecordSchema` + SELECT 增加 `tool_name AS toolName`（`z.string().nullable()`）。
- `local-admin.ts` 的 `auditRecordSchema` 同步加 `toolName`。
- `audit-view.tsx` 表格在“操作”后加一列“工具”，`null` 显示 `-`；搜索过滤范围纳入 `toolName`（见 Part B，过滤移到服务端）。
- i18n：`zh-cn.ts` / `en.ts` 的 `audit.table` 加 `tool` 键。

## Part B — 服务端分页 + 服务端过滤

### B1. 路由契约

`GET /admin/audits` 查询参数（全部可选）：

- `limit`：默认 50，1..200 之间。
- `offset`：默认 0，>=0。
- `q`：模糊匹配（operation / result / toolName / deviceId / taskId，SQL `LIKE`，大小写不敏感）。
- `result`：精确匹配 result。

响应从裸数组改为 `{ items: AuditRecord[]; total: number; limit: number; offset: number }`。`total` 是应用过滤后、分页前的总数（`COUNT(*)`），驱动前端分页控件。

> 兼容性：`/admin/audits` 仅本地 admin 前端消费（同仓库），无外部客户端，可直接改响应形状。configuration-routes 测试与 local-admin.ts 类型同步更新。

### B2. 查询实现

在 configuration-routes 内用参数化 SQL 构造 `WHERE`（`q` 用 `LIKE ? ESCAPE` 防注入 + 转义 `%_`），`ORDER BY occurred_at DESC LIMIT ? OFFSET ?`；`COUNT(*)` 复用同一 `WHERE`。全部经 `better-sqlite3` prepared statement 绑定参数，不拼接用户输入。

### B3. 前端

`audit-view.tsx` 从“一次性收全部 + 客户端 filter”改为：

- 维护 `page`/`pageSize`/`query`/`resultFilter` 状态；变化时向 API 发起带查询参数的请求。
- `local-admin.ts` 的 `getAudits` 接受这些参数并返回分页结构。
- 底部 summary 改为分页控件（上一页/下一页 + `total` 显示）。`result` 下拉的可选值不能再从当前页 distinct 推导——改为固定的已知结果集（approval 的 `allow`/`deny`、`forwarded`、`accepted`... 用常量列表），避免只反映当前页。
- 现有 `administration-page.tsx` 若在挂载时统一预取 audits，需要调整为分页视图自取（确认数据流后决定改动点）。

## Data flow (approval → audit row)

```
mobile POST approvals/{requestId}{result}
  → task-routes → taskManager.applyApprovalResponse
      pending.approval.{toolName,input} 在作用域内
      → summarizeToolForAudit → auditToolName="Skill:claude-api"
      → executeIdempotent → persistOperation({operation:"task.approval-approved",
                                               resultLabel:"allow",
                                               toolName:"Skill:claude-api"})
      → audit_records 行含 tool_name
GET /admin/audits?limit&offset&q&result
  → {items,total,...} → audit-view 表格“工具”列 + 分页
```

## Tradeoffs / Risks

- **契约边界移动**：这是安全面的放宽（审计现在会含工具/skill 标识符）。通过白名单+字符集过滤+长度截断把风险限定在“稳定标识符”，不触及用户内容。spec 修订与实现同批提交，测试覆盖“Bash 不泄漏命令串”“Skill 只留 command 名”。
- **响应形状变更**：`/admin/audits` 从数组变对象。仅本地前端消费，风险可控；同批更新前端与测试。
- **只对 approval 类审计填 toolName**：`task.sdk-message-submitted`、codex 的 `codex.*`、workspace 变更等审计行 `toolName` 为 `null`，符合“approval 记的是被批准的工具”这一语义；未来若要给 codex approval 也填，走同一字段扩展。

## Rollout / Rollback

- Additive 列 + additive 查询参数（有默认值），旧数据与旧调用兼容。
- 回滚：还原 schema/迁移/路由/前端四处于同一提交，删除 `0006` 迁移。因列可空、无数据回填，回滚无数据损失。
