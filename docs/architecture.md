# 架构设计（待确认）

## 背景系统
- **wxdevops-task-admin**：微信会话存档平台。持有数据（chat_messages / wechat_users / wechat_groups / chat_attachments），并已实现群权限模型（`groups_manage` 全局 + 群管理员=邮箱）。已有内置 MCP（`/api/mcp`，单一 API-Key，工具：get_chat_groups/get_chat_messages/search_messages/get_group_info/get_message_stats）。
- **task.bestfunc.com（巅峰表现）**：任务/看板平台，自带 OAuth（OAuthConsentPage）。油猴脚本「Bestfunc Token Sync (Claude MCP)」把其 access token 同步到 `~/.config/bestfunc-mcp/credentials.json`（JWT: sub=user_id, type=access，无 email）。

## 核心矛盾
数据+群权限在 **wxdevops**（按 email 授权）；已同步的 token 是 **巅峰表现** 的（按 user_id）。需要确定**认证源**与**身份→可见群**的映射。

## 三个待定决策
### D1 数据来源
- **A. 调 wxdevops HTTP API**（推荐）：wxdevops 新增/复用「带用户身份的只读接口」，本 MCP 转发。边界清晰、复用其权限逻辑（`get_admin_group_ids` 等）。
- B. 直连 wxdevops MySQL：实现快，但耦合 schema、绕过权限层、跨主机暴露 DB。

### D2 认证 / 身份映射
- **A. wxdevops 自建 OAuth/会话**（推荐）：用户用 wxdevops 邮箱登录换 token；MCP 持该 token 调 wxdevops，wxdevops 按 email 算可见群。身份链路自洽。
- B. 复用巅峰表现 token：需要 wxdevops 信任巅峰表现签发的 token，并把 user_id 映射到 wxdevops 邮箱账户（要加映射表/SSO 打通）。
- C. 沿用油猴本地同步：MCP 读 `~/.config/bestfunc-mcp/credentials.json` 的 token 调用（最省事，但身份=巅峰表现，仍需 B 的映射）。

### D3 传输形态
- **A. 本地 stdio MCP**（推荐起步）：跑在用户机器，Claude Desktop/Code 直接挂载；token 走本地同步文件。落地快。
- B. 远程 HTTP MCP + 标准 OAuth2.1（authorize/token/PKCE/元数据）：可多人共享、规范，但实现重。

## 推荐组合（起步）
**D1-A + D2-A + D3-A**：本地 stdio MCP（Python，复用 wxdevops 模型/或调其 API）→ wxdevops 提供「按用户 token 的只读接口」（列群/读消息/读成员/读附件/读群信息）→ MCP 按用户可见群范围返回。
之后再演进到 D3-B（远程 HTTP + 完整 OAuth）供多人共享。

## 待实现接口（无论 A/B，wxdevops 侧需提供"按用户"读取）
- 列出当前用户可见群（含群备注/项目/内外部/密级）
- 读群消息（分页/时间过滤）
- 读群成员（人员信息）
- 读消息附件（图片/视频元信息 + 下载/直链）
- 读单群详情（额外维护信息）

## MCP 工具（只读）规划
`list_groups` / `get_group` / `get_messages` / `search_messages` / `get_members` / `get_attachment`（按当前用户权限过滤；密级上限可选）。

## SKILL
封装该 MCP 的使用：如何配置 token、如何按群/时间查询、典型用法（"总结某群本周聊天""找某人在某群的发言""导出某群附件清单"）。
