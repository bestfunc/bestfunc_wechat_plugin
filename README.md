# bestfunc_wechat_plugin

微信聊天记录平台的 **Claude Code 插件**（marketplace 形态，参考 Argus_Plugins 规范）：基于**用户 OAuth 授权**，只读访问当前用户「有权限的微信群」的聊天/人员/附件/群信息。

> 数据与权限来源平台：`wxdevops-task-admin`（同级项目）。本仓库 = 插件包 + 背后的 MCP Server。

## 能力（只读）
- 读可访问群的聊天消息、人员信息、附件（图片/视频/文件）。
- 读群额外维护信息：备注、项目编号/名称、内外部、权限等级(密级)。
- 权限等同用户：MCP 可见群范围 = 该用户在系统里的群权限（OAuth 邮箱身份）。
- **不发送**任何微信内容。

## 仓库结构
```
.claude-plugin/marketplace.json        插件市场清单
plugins/wechat/
  .claude-plugin/plugin.json           插件清单（mcpServers 声明远程 http MCP）
  skills/
    wechat-chat-reader/SKILL.md        查询用法
    mcp-authorization/SKILL.md         OAuth 授权说明
src/bestfunc_wechat_mcp/               MCP Server 实现（远程 Streamable HTTP + OAuth 资源服务器）
docs/architecture.md                   架构与决策
```

## 安装（Claude Code）
```
/plugin marketplace add bestfunc/bestfunc_wechat_plugin
/plugin install wechat@bestfunc-wechat-plugins
```
首次调用工具时按 `mcp-authorization` 用 wxdevops 邮箱完成 OAuth 登录。

## MCP 工具（mcp__wechat__*，均只读）
`list_groups` · `get_group` · `get_messages` · `search_messages` · `get_members` · `get_group_attachments` · `get_attachment`

## 部署 MCP Server（src/）
插件 `plugin.json` 的 `mcpServers.wechat.url` 指向已部署的 MCP Server，需先部署：
```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
WXDEVOPS_API_BASE=https://<wxdevops-host> \
AUTH_SERVER_URL=https://<wxdevops-host> \
MCP_RESOURCE_URL=https://wechat-mcp.bestfunc.com \
MCP_PORT=8088 PYTHONPATH=src .venv/bin/python -m bestfunc_wechat_mcp
```
- `WXDEVOPS_API_BASE`：wxdevops 后端地址（提供 `/api/mcp-data/*` 数据接口与 `/oauth` 授权服务器）。
- 部署后把公网地址（如 `https://wechat-mcp.bestfunc.com/mcp`）填回 `plugin.json` 的 `mcpServers.wechat.url`。
- 鉴权：MCP Server 校验 Bearer 令牌（调 wxdevops `/api/mcp-data/me`），并暴露 `/.well-known/oauth-protected-resource` 指向 wxdevops OAuth AS。

## 依赖的 wxdevops 后端接口（已实现于 wxdevops-task-admin）
- OAuth AS：`/.well-known/oauth-authorization-server`、`/api/oauth/authorize|token|register`
- 只读数据：`/api/mcp-data/groups|search|me`、`/groups/{room_id}/messages|members|attachments`、`/attachments/{id}`

## 状态
P1 数据API · P2 OAuth · P3 MCP Server · P4 插件/SKILL 已完成并本地端到端验证通过。`mcpServers.url` 为占位的生产域名，部署后需更新。
