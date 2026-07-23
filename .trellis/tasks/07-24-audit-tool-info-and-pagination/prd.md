# 审计记录工具信息与服务端分页

## Goal

让 local-admin 的审计记录页面能回答两个当前无法回答的问题:

1. 一条 `task.approval-approved / allow` 审计到底**批准了什么工具/技能**(例如 `Skill:claude-api`、`Bash`、`Edit`),而不是只看到 `allow`。
2. 当审计记录很多时,页面能**服务端分页**浏览,而不是一次性拉全量再在浏览器里过滤。

## Background

- 审计表 `audit_records` 当前只有 6 列:`id / occurredAt / deviceId / operation / result / taskId`,没有任何字段能表达"批准了哪个工具"。
- 批准审计经 `persistOperation` 写入:`operation = "task." + action`(如 `task.approval-approved`),`result = PermissionResult.behavior`(`allow` / `deny`)。工具名藏在服务端 `liveTask.pendingApproval.approval`(含 `toolName` 与 `input`),批准时可就地读取,**无需修改移动端 `/v1/tasks/:taskId/approvals/:requestId` 契约**。
- `GET /admin/audits` 当前是 `SELECT ... ORDER BY occurred_at DESC` 全量无 `LIMIT`,前端 `audit-view.tsx` 一次收下全部,再纯客户端 `filter`。无分页。
- 现有安全契约 `local-admin-contracts.md` 明确规定审计响应**只返回那 6 个字段**、**禁止携带工具参数/用户内容**。本任务需要**受控地放开"工具元数据"这一类**(稳定标识符),同时继续禁止真正的用户内容,并同步修订该契约。

## Requirements

### R1 审计记录工具信息(元数据)
- 批准/拒绝审计(`approval-approved` / `approval-denied`)须额外记录一个**工具标识**字段,取值形如:
  - `Skill:claude-api`(Skill 工具带其技能名)
  - `Bash` / `Edit` / `Read` 等(其余工具仅工具名)
- 只记录**元数据类稳定标识符**:工具名,以及 Skill 的技能名/斜杠命令名这类枚举式标识。
- **严禁**记录用户内容:Bash 命令串、文件路径与文件内容、prompt、模型输出、任何凭据或密钥。
- 非批准类审计(创建、中断、模型变更等)该字段为空,行为不变。
- 该字段可空,长度受限(截断保护),字符经无害化处理。

### R2 服务端分页 + 服务端过滤
- `GET /admin/audits` 支持分页参数(页大小 + 偏移/页码),返回**当前页数据 + 总条数**。
- 过滤(操作/设备/任务的关键字搜索、结果筛选)改为**服务端**执行,分页在过滤结果之上生效。
- 前端审计页面改为服务端驱动:翻页、搜索、筛选都走后端;新增分页控件与工具列展示;移除"一次拉全量再客户端过滤"的逻辑。

### R3 契约与文档同步
- 修订 `local-admin-contracts.md`:审计响应允许新增受控工具元数据字段,明确其只含工具/技能标识、仍禁止用户内容;并写入新的分页/过滤契约(参数、响应结构、边界)。
- i18n(zh-cn + en)新增工具列表头与分页相关文案。

## Constraints

- 遵循数据库指南:schema 改动用 `pnpm exec drizzle-kit generate` 生成,schema + SQL 迁移 + drizzle 元数据同批提交;`audit_records` 只存元数据。
- `/admin/*` 仍只挂在本地 loopback app,远端 app 对这些路由返回 404;保持 exact-origin + CSRF 保护。
- 审计保留期(30 天清理)等既有行为不变。
- 后端文档语言为英文;前端面向用户文案走 i18n。
- 不改动移动端审批请求/响应契约。

## Acceptance Criteria

- [ ] `audit_records` 新增可空工具标识列;迁移已生成并随 schema、drizzle 元数据同批提交;既有行迁移后该列为空且不报错。
- [ ] 从移动端(default 模式)触发一次 `Skill(claude-api)` 审批并批准后,该条审计的工具字段为 `Skill:claude-api`;`Bash`/`Edit` 等审批记录为对应工具名;非批准审计该字段为空。
- [ ] 审计响应中**不出现**任何 Bash 命令串、文件路径/内容、prompt、模型输出、凭据或密钥(有针对性的负向测试断言)。
- [ ] `GET /admin/audits` 支持分页与服务端过滤,返回当前页 + 总数;空表返回空页与总数 0。
- [ ] 前端审计页面服务端驱动:翻页、搜索、结果筛选正确;新增工具列;分页控件可用。
- [ ] `local-admin-contracts.md` 已更新工具元数据边界与分页/过滤契约;i18n(zh-cn + en)新增文案齐全。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test` 全绿;新增/修改路由的远端 404 隔离测试仍通过。

## Notes

- 工具信息取自服务端 `applyApprovalResponse` 中的 `pending.approval.{toolName,input}`,不经移动端上送,天然可信且不扩大攻击面。
- 分阶段实现(先工具列、后分页),但因两阶段改动同一路由与同一前端页面,置于单任务串行推进,避免合并冲突。
