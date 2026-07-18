# 简化二维码配对审批

## Goal

二维码生成后立即显示一个六位验证码输入框。用户输入移动端显示的验证码后，页面使用当前二维码的 `pairingId` 调用现有审批接口，由后端直接验证并创建设备；本地管理页不再查询或轮询待审批列表。

## Background

- `DeviceAuthService.registerPairingDevice()` 在手机扫码注册时生成六位 `verificationCode`，加密保存到 pairing，并将验证码返回给移动端。
- `POST /admin/pairings/:pairingId/approve` 已接收 `verificationCode`，后端会检查 pairing 状态、解密验证码并进行常量时间比较，验证成功后创建设备。
- 本地管理页生成 QR 后已经持有当前 `pairingId`，因此审批时不需要先通过 `/admin/pairings/pending` 找回该标识。
- 当前 Pending approvals 列表同时显示后端解密出的 Agent code 和一个 Mobile code 输入框；该列表依赖每秒轮询才能在手机注册后出现，增加了无效请求和日志。

## Requirements

1. 成功生成 QR 后，立即显示绑定当前 `pairingId` 的六位 Mobile code 输入框和 Approve 按钮。
2. 输入仅接受数字，长度达到六位后才能提交。
3. 生成 QR、输入或修改验证码、输入框失焦都不调用审批接口；只有用户点击 Approve 按钮时，才调用现有 `POST /admin/pairings/:pairingId/approve`。后端继续作为验证码、过期、已使用和设备注册状态的唯一校验方。
4. 移除前端 pending-pairing 轮询、`loadPendingPairings()` 和 Pending approvals 列表；本地管理页初始快照不再请求 `/admin/pairings/pending`。
5. 审批成功后使用接口返回的设备更新设备列表，清除当前 QR 和验证码输入，不执行会覆盖未保存配置的完整快照刷新。
6. 审批失败时显示后端安全错误信息，并保留当前 QR 和输入值，允许用户修正或在手机注册完成后重试。
7. 生成新 QR 时替换旧的 active pairing 并清空旧验证码输入。
8. 后端 `/v1/pair/*`、`/admin/pairings/:pairingId/approve` 和 `/admin/pairings/pending` 契约保持不变。

## Acceptance Criteria

- 一次 Generate QR 成功后，QR、有效期、Mobile code 输入框和 Approve 按钮同时出现，无需手机先注册。
- 未生成 QR 时不显示可提交的验证码输入框。
- 整个本地管理页流程不调用 `GET /admin/pairings/pending`，也不存在轮询定时器或事件连接。
- 输入非数字字符会被过滤；少于六位时 Approve 禁用。
- 六位验证码提交时，请求路径包含当前 QR 的 `pairingId`，请求体只包含输入的 `verificationCode`。
- 生成 QR 和修改输入框不会产生审批请求；一次点击 Approve 最多产生一次审批请求。
- 后端返回错误时，QR、验证码输入和未保存配置保持不变。
- 审批成功后，新设备出现在设备列表，QR 和验证码输入被清除，未保存配置保持不变。
- 生成第二个 QR 会清空第一个 QR 的验证码，并只允许审批新的 `pairingId`。
- 根项目 lint、typecheck、test 和 build 通过。

## Out of Scope

- 修改后端配对、验证码、审批、challenge/claim 或凭据逻辑。
- 删除 `/admin/pairings/pending` 后端接口；它可以保留供兼容或诊断使用。
- 页面刷新后恢复尚未完成的二维码和输入状态。
- 同时在一个页面审批多个活动二维码。
