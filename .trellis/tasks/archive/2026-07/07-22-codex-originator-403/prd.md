# PRD: Fix Codex live 403 originator whitelist

## Goal

消除 Codex App Server 调用 ChatGPT 时因 `originator=pocketpilot` 不在 endpoint 白名单导致的 HTTP 403，恢复 live contract / 生产 ChatGPT 路径。

## Background

### 现象

Live / ChatGPT 请求失败：

`unexpected status 403 Forbidden: ... originator not in endpoint whitelist (originator=pocketpilot)`

### 根因（已确认）

这不是官方 `config.toml` / `CODEX_HOME` 配置被覆盖。

PocketPilot 不是直接跑 Codex TUI CLI，而是 spawn `codex app-server` 后作为 **App Server 客户端** 发 `initialize`。当前硬编码：

- 文件：`src/codex-app-server/bridge.ts`
- 字段：`clientInfo.name = "pocketpilot"`

Codex App Server 会把 `clientInfo.name` 设为会话 originator。ChatGPT 后端只接受白名单 originator（如 `codex_cli_rs`），因此拒绝 `pocketpilot`。

官方 CLI 默认 originator 是 `codex_cli_rs`；官方 TS SDK 还会写 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts`。  
PocketPilot 的 config/auth 可与官方 CLI 一致，但 **App Server handshake 身份** 仍是 `pocketpilot`，所以仍会 403。

### 决策

用户已确认：

1. **`clientInfo.name` 改为 `codex_cli_rs`**
2. **`clientInfo.title` 仍为 `PocketPilot`**

不采用“仅 live 注入 env override、生产仍保留 pocketpilot name”的路径。

## Requirements

- **R1** `CodexAppServerBridge` 在 `initialize` 中发送 `clientInfo.name = "codex_cli_rs"`。
- **R2** 保留 `clientInfo.title = "PocketPilot"` 与现有 `version`，便于本地/日志识别产品名；不把 title 改成 Codex。
- **R3** 不依赖修改用户 `config.toml` / `CODEX_HOME` 来修 403；不把 ChatGPT token 写入仓库。
- **R4** 单测断言 initialize 帧的 `clientInfo.name` 为 `codex_cli_rs`，且 title 仍为 `PocketPilot`。
- **R5** 已鉴权 ChatGPT 环境下，live contract 的 initialize / model 相关调用不再因 originator whitelist 返回 403。
- **R6** 更新 backend contract / 任务记录，说明 App Server client originator 使用 `codex_cli_rs`，与官方 CLI 对齐；并注明这与 config.toml 身份无关。

## Acceptance Criteria

- **AC1** `src/codex-app-server/bridge.ts` 的 initialize `clientInfo.name` 为 `codex_cli_rs`（对应 R1）。
- **AC2** `clientInfo.title` 仍为 `PocketPilot`（对应 R2）。
- **AC3** `test/codex-app-server/bridge.test.ts`（及如有必要的相关测试）覆盖 initialize clientInfo 断言，且现有 bridge 单测通过（对应 R4）。
- **AC4** 在已登录 ChatGPT 的机器上跑 live contract 时，不再出现 `originator=pocketpilot` / originator whitelist 403（对应 R5）。若本机无 ChatGPT 登录，记录 skip 条件，不以假绿代替。
- **AC5** `.trellis/spec/backend/codex-app-server-contracts.md` 或等价契约说明已记录 originator/clientInfo 决策（对应 R6）。

## Out of Scope

- `07-22-codex-live-test-parity` 的全量 live 场景对齐（thread/turn/interrupt 等）。
- ChatGPT 登录流程、token 刷新、换鉴权方式。
- 修改 Codex 上游二进制或申请新的 `pocketpilot` 白名单。
- 非 Codex provider 的 403。
- 额外引入 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`（本任务以 `clientInfo.name` 为准；除非 live 验证证明 name 改完仍不够）。

## Technical Notes

- 改动中心：`src/codex-app-server/bridge.ts` initialize 的 `clientInfo`。
- Bridge 的 `environment` 透传能力已存在，但本任务默认不靠 env 修 403。
- Request id 前缀 `pocketpilot:...` 与 originator 无关，保持不变。
- Fake process 单测目前不校验 clientInfo 内容，需补断言。

## Risks

- ChatGPT 后端若对 `codex_cli_rs` 还有额外客户端校验，仅改 name 可能不够；届时再评估 env override 作为补救，不在当前默认方案内。
- 遥测/用量侧会显示为 CLI originator，而不再是 `pocketpilot`。这是接受的产品代价。
