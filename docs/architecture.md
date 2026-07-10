# 架构设计（已确认）

## 已确认决策（2026-06-15）
- **D3 传输**：远程 HTTP MCP + 完整 OAuth 2.1（授权码 + PKCE + 元数据发现）。
- **D1 数据来源**：MCP 调 wxdevops-task-admin 的 HTTP API（不直连 DB）。
- **D2 认证身份**：wxdevops 邮箱登录换 token；MCP 持该 token 调 wxdevops，wxdevops 按 **email** 算可见群。

## 背景系统与代码归属（2026-07 拆分后）
- **wxdevops-task-admin**（后端项目，Flask）：
  - `backend/`：持有数据（chat_messages / wechat_users / wechat_groups / chat_attachments）+ 群权限模型（全局 `groups_manage` / 群管理员=email）+ **OAuth 授权服务器(AS)** + **只读数据 API** `/api/mcp-data/*`。
  - `mcp-server/`：**远程 MCP Server（协议层）**——原先在本插件仓库 `src/`，已迁入后端项目，与它依赖的后端同栈部署（docker-compose）。
- **bestfunc_wechat_plugin**（本仓库）：**纯 Claude Code 插件包**——marketplace 清单 + MCP connector 声明（`plugin.json` 指向已部署的 MCP URL）+ SKILL。不含服务端代码。参照 Argus_Plugins 规范。

## 角色划分
- **wxdevops = OAuth 授权服务器(AS) + 资源服务器(数据API)**
  - 认证：复用现有邮箱验证码登录
  - 颁发：JWT access/refresh token，`sub=email`，scope=只读
  - 授权：按 email → 可见群（`is_groups_global_admin` 全部 / `get_admin_group_ids` 部分）
- **bestfunc_wechat_plugin = MCP 资源服务器(协议层)**
  - 向 MCP 客户端暴露 OAuth 受保护资源元数据（指向 wxdevops AS）
  - 校验/透传 bearer token，把 MCP 工具调用翻译成 wxdevops 数据 API 调用

## wxdevops 侧需新增
### A. OAuth 2.1 端点（AS）
- `GET /.well-known/oauth-authorization-server`（元数据）
- `GET /oauth/authorize`（登录+同意，复用邮箱验证码登录；返回 code，支持 PKCE）
- `POST /oauth/token`（code+verifier→token；refresh）
- `POST /oauth/register`（动态客户端注册 RFC7591，MCP 客户端用）
- token 内含 `sub=email`、`scope`、`exp`

### B. 按用户只读数据 API（authZ=token.email，复用 group_service）
- `GET /api/mcp-data/groups` 当前用户可见群（含备注/项目编号/项目名称/内外部/密级）
- `GET /api/mcp-data/groups/{room_id}` 单群详情
- `GET /api/mcp-data/groups/{room_id}/messages?page&since&until` 群消息
- `GET /api/mcp-data/groups/{room_id}/members` 群成员（人员信息）
- `GET /api/mcp-data/search?keyword&room_id&...` 搜索消息（限可见群）
- `GET /api/mcp-data/attachments/{id}` 附件元信息 + 下载/直链（图片/视频）
- 所有接口：先校验 token→email，再用 `can_manage/get_admin_group_ids` 限定 room_id 范围；可选密级上限。

## bestfunc_wechat_plugin 侧（MCP Server，Python）
- 远程 Streamable HTTP MCP。
- `GET /.well-known/oauth-protected-resource` → 指向 wxdevops AS。
- 每次工具调用校验/透传 token，调用上面的 mcp-data API。
- 只读工具：`list_groups` / `get_group` / `get_messages` / `search_messages` / `get_members` / `get_attachment`。

## SKILL（skill/）
封装该 MCP 用法：配置（MCP server 地址 + 登录授权）、典型用法（总结某群本周聊天 / 查某人发言 / 列群附件 / 读群备注与项目信息）。

## 分期
1. **P1 wxdevops 只读数据 API**（B 部分）——基础，可用手发 token 直接测。
2. **P2 wxdevops OAuth AS**（A 部分）——authorize/token/PKCE/metadata/DCR。
3. **P3 MCP Server**（本项目）——远程 HTTP + OAuth 元数据 + 工具映射。
4. **P4 SKILL**——使用封装。

## 只读约束
本期所有能力均为读取；不提供任何发送/写入微信内容的工具或接口。
