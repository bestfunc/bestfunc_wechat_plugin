# bestfunc_wechat_plugin

微信聊天记录平台的 **MCP Server + 配套 SKILL**，让 AI 客户端（Claude 等）基于**用户 OAuth 认证**、按该用户**可访问的微信群范围**只读地获取聊天数据。

> 数据与权限来源平台：`wxdevops-task-admin`（同级项目）。本项目是独立的对外读取层。

## 需求（本期）
- 开放 MCP，基于**用户 OAuth 认证**。
- **权限等同用户**：系统里"用户可访问哪些微信群"的权限，决定 MCP 能访问哪些群（OAuth 认证关系）。
- 通过 MCP 读取可访问群内：**所有聊天消息、人员信息、附件（图片/视频等）**。
- 通过 MCP 读取**群相关信息**，包括备注等额外维护的信息（群备注/项目编号/项目名称/内外部/密级）。
- 配套 **SKILL**，用于该 Plugin 的使用。
- **只读**：本期不通过 MCP 发送任何微信内容。

## 角色边界
- **认证(authN)**：用户是谁 —— OAuth（待定：复用 wxdevops 邮箱登录 / 巅峰表现 token）。
- **授权(authZ)**：能看哪些群 —— 来自 wxdevops-task-admin 的群权限模型：
  - 全局 `groups_manage` → 全部群；
  - 群管理员（邮箱）→ 其负责的群。
- 群密级 `access_level` 作为 AI 可见范围的附加约束（可设上限）。

## 架构（待确认，见 docs/architecture.md）
关键岔路：
1. **数据来源**：MCP 直连 wxdevops MySQL，还是调用 wxdevops HTTP API（推荐 API，边界清晰）。
2. **身份/OAuth**：用户 token 怎么来、怎么映射到 wxdevops 的邮箱权限（油猴已同步 `~/.config/bestfunc-mcp/credentials.json`，但那是巅峰表现 token）。
3. **传输形态**：本地 stdio（Claude Desktop，读同步 token）/ 远程 HTTP（标准 OAuth2.1）。

## 目录
```
src/bestfunc_wechat_mcp/   MCP server 实现
skill/                     配套 SKILL（Plugin 使用说明/封装）
docs/                      需求与架构文档
```

## 状态
🚧 初始化。架构决策确认后开始实现（见 docs/）。
