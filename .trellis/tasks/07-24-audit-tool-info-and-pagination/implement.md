# 执行计划 — 审计工具信息与服务端分页

分两阶段串行推进。两阶段都改同一路由与同一前端页面,故置于单任务、顺序执行,避免合并冲突。每阶段结束跑一次验证再进入下一阶段。

---

## 阶段 0 — 准备

- [ ] 阅读 spec:`database-guidelines.md`、`local-admin-contracts.md`、`logging-guidelines.md`、`quality-guidelines.md`、`error-handling.md`。
- [ ] 确认基线绿:`pnpm lint`、`pnpm typecheck`、`pnpm test`。

---

## 阶段 1 — 审计工具元数据列

### 1a. 工具标识提取器(纯函数 + 单测先行)
- [ ] 新增 `src/tasks/audit-tool-summary.ts`:导出 `summarizeToolForAudit(toolName: string, input: unknown): string | null`。
  - Skill 工具:按优先级探 `input.command` → `input.skill` → `input.name`,取第一个非空字符串,产出 `Skill:<name>`;取不到则退化为 `Skill`。
  - 其余工具:直接返回 `toolName`。
  - 只接受字符串标识;对取到的标识做长度截断(如 ≤64)+ 控制字符无害化;绝不拼接命令串/路径/内容。
- [ ] 新增 `test/tasks/audit-tool-summary.test.ts`:覆盖 Skill 各键、缺键退化、普通工具、超长截断、非法/缺失 input。

### 1b. 审计写入携带工具标识
- [ ] `task-repository.ts`:`auditRecords` schema 新增可空 `toolName: text("tool_name")`(列名 `tool_name`)。
- [ ] `recordAudit` 与 `persistOperation` 的输入类型与 insert values 增加可选 `toolName`(默认 `null`)。
- [ ] `task-manager.ts` `applyApprovalResponse`:在 `pending.approval` 仍可读时,用 `summarizeToolForAudit(pending.approval.toolName, pending.approval.input)` 得到标识,经 `OperationExecution` → `executeIdempotent` → `persistOperation` 落到审计行。
  - 扩展 `OperationExecution` / `TaskOperationResult` 相关类型,新增可选 `auditToolName`;仅批准/拒绝路径填充,其余操作不填(保持为空)。
- [ ] 生成迁移:`pnpm exec drizzle-kit generate`;确认新增 SQL、`schema.ts`、`drizzle/meta` 同批。

### 1c. 读路径与前端展示
- [ ] `configuration-routes.ts`:`auditRecordSchema` 增加 `toolName: z.string().nullable()`;SELECT 增补 `tool_name AS toolName`。
- [ ] `apps/local-admin/src/api/local-admin.ts`:`auditRecordSchema` 同步加 `toolName`。
- [ ] `audit-view.tsx`:表格新增"工具"列展示 `toolName`(空显示 `-`);搜索匹配项纳入 `toolName`。
- [ ] i18n `zh-cn` + `en`:`audit.table` 新增 `tool` 表头文案。

### 1d. 阶段 1 验证
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test` 全绿。
- [ ] `configuration-routes.test.ts` 补测:审计响应含 `toolName`;并**负向断言**响应不含命令串/路径/prompt 等用户内容字段。
- [ ] 迁移 smoke:既有行迁移后 `toolName` 为空且查询正常。

---

## 阶段 2 — 服务端分页 + 服务端过滤

### 2a. 后端路由
- [ ] `GET /admin/audits` 新增 query 参数:`limit`(默认如 50,上限如 200)、`offset`(默认 0)、可选 `search`、可选 `result`。用 Zod 校验并夹取上下限。
- [ ] 响应结构改为 `{ items: AuditRecord[], total: number, limit: number, offset: number }`(total 为**过滤后**总数)。
- [ ] SQL:构造带 `WHERE`(search 命中 operation/result/device_id/task_id/tool_name;result 精确匹配)、`ORDER BY occurred_at DESC`、`LIMIT/OFFSET` 的查询;另跑一条 `COUNT(*)` 同条件取 total。参数化,杜绝注入。

### 2b. 前端服务端驱动
- [ ] `local-admin.ts`:audits 拉取函数支持分页/过滤参数,解析新响应结构。
- [ ] 数据装载处(`administration-page.tsx` / shell):审计数据改为按需分页请求,不再首屏全量。
- [ ] `audit-view.tsx`:搜索/筛选/翻页触发后端请求(带防抖);移除客户端全量 `filter`;新增分页控件(上一页/下一页 + 页信息);沿用现有 `summary` 展示"当前页/总数"。
- [ ] i18n `zh-cn` + `en`:分页控件文案(上一页/下一页/页码/每页)。

### 2c. 契约与文档
- [ ] 修订 `.trellis/spec/backend/local-admin-contracts.md`:
  - 审计响应字段列表加入 `toolName`,明确其只含工具/技能标识、仍禁止工具参数/用户内容/密钥。
  - `GET /admin/audits` 契约更新为分页 + 服务端过滤:参数、`{ items, total, limit, offset }` 响应、边界(空表→空 items + total 0、limit 夹取)。
  - 更新 §7 Wrong/Correct 与 §6 Tests Required 对应条目。
- [ ] 更新 mobile/openapi 文档若涉及(本路由为 local-only,通常不在 mobile openapi;确认后决定)。

### 2d. 阶段 2 验证
- [ ] `configuration-routes.test.ts` 补测:分页(limit/offset)、服务端 search、result 过滤、total 正确、空表边界、limit 夹取;远端 404 隔离仍通过。
- [ ] 前端测试(`apps/local-admin/test`)更新:服务端驱动的搜索/翻页交互。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test` 全绿。

---

## 收尾(Phase 3)

- [ ] 全量质量检查:`get_context.py --mode packages` 列出受影响包,逐个过 Quality Check。
- [ ] Spec 更新回填(阶段 2c 已含契约;检查是否还有 logging/database 约定需补)。
- [ ] 分支 + 提交(遵循 no-direct-commits-to-main);建 PR 目标 `main`。

## 回滚点
- 阶段 1 与阶段 2 各自独立可回滚;迁移一旦提交,回滚需新迁移撤列而非删历史迁移。
- 若阶段 2 前端改动过大,可先只上后端分页(保持前端兼容旧结构一版),分两次 PR。
