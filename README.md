# bestfunc_wechat_plugin

微信聊天记录平台的 **Claude Code 插件**（marketplace 形态，参考 [Argus_Plugins](https://github.com/bestfunc/Argus_Plugins) 规范）：基于**用户 OAuth 授权**，只读访问当前用户「有权限的微信群」的聊天/人员/附件/群信息。

> **本仓库 = 纯插件包**（marketplace 清单 + MCP connector 声明 + skill）。
> MCP Server 服务端实现与它依赖的数据 API/OAuth 授权服务器，都在同级后端项目
> **`wxdevops-task-admin`**（`mcp-server/` + `backend/`）。本仓库不含服务端代码。

## 能力（只读）
- 读可访问群的聊天消息、人员信息、附件（图片/视频/文件）。
- 读群额外维护信息：备注、项目编号/名称、内外部、权限等级(密级)。
- 权限等同用户：MCP 可见群范围 = 该用户在系统里的群权限（OAuth 邮箱身份）。
- **不发送**任何微信内容。

## 快速开始（Claude Code）
```bash
# 1. 添加 marketplace（在 Claude Code 会话里输入）
/plugin marketplace add bestfunc/bestfunc_wechat_plugin

# 2. 安装 wechat 插件（含 MCP connector + skill）
/plugin install wechat@bestfunc-wechat-plugins

# 3. 查看连接状态
/mcp
#   wechat → 首次显示「需要认证」

# 4. 触发 OAuth：直接让 AI 调一个工具，或在 /mcp 里点 Authenticate
#    浏览器弹出 wxdevops 授权页 → 用 wxdevops 邮箱验证码登录并同意 → 自动回连
```
授权细节见 skill `mcp-authorization`。

### ⚠️ 网络要求（安装前必看）
本插件走标准 OAuth 2.1，涉及**两个对外地址，客户端与浏览器都要能直连**：

| 地址 | 角色 | 谁访问 |
|---|---|---|
| `http://114.55.116.77:8090/mcp` | MCP Server（资源服务器） | Claude Code |
| `http://114.55.116.77:5000` | OAuth 授权服务器(AS) | Claude Code + 你的浏览器 |

点「授权」后客户端会从 MCP 元数据里发现 AS 在 `:5000` 并跳转授权。
**若网络只放通了 8090、挡了 5000，会卡在「未授权」点授权走不通**——这是最常见的坑，
请确认两个端口都可达（生产建议反代到同一 HTTPS 域名，见后端项目 `mcp-server/README.md`）。

## 双 MCP 架构（对照 Argus 的 argus / argus-files）
| MCP | 形态 | 职责 |
|---|---|---|
| `wechat` | 远程 HTTP（`:8090/mcp`） | 读聊天/人员/附件元数据/群信息进上下文 |
| `wechat-file` | 本地 stdio（`node local-mcp/wechat-file-mcp/index.js`，零依赖） | 把附件**下载到本机**、图片回传分析、**>=100MB 跳过**；鉴权复用 felag 连接器 keychain 令牌，免重新授权 |

## MCP 工具（均只读）
- 远程 `mcp__wechat__*`：`list_groups` · `get_group` · `get_messages` · `search_messages` · `get_members` · `get_group_attachments` · `get_attachment`
- 本地 `mcp__wechat-file__*`：`download_group_attachments` · `list_downloads`

## 附件展示规则（skill 内置）
- 图片：下载到本地并**内联 `![]()`**，同时回传给模型看图分析。
- 普通文件：展示**文件名+后缀，可点击本地下载** `[📎 名.ext](file://…)`；需要时读本地路径分析内容。
- **>=100MB**：不下载，给**网络下载链接**。

## 仓库结构
```
.claude-plugin/marketplace.json        插件市场清单
plugins/wechat/
  .claude-plugin/plugin.json           插件清单（mcpServers 声明 wechat 远程 + wechat-file 本地）
  skills/
    wechat-chat-reader/SKILL.md        查询用法
    wechat-file/SKILL.md               附件本地下载与分析用法
    mcp-authorization/SKILL.md         OAuth 授权说明
  local-mcp/wechat-file-mcp/           本地 stdio MCP（零依赖 Node，附件下载器）
docs/architecture.md                   架构与决策（服务端在 wxdevops-task-admin）
```

## 服务端在哪
| 组件 | 位置 |
|---|---|
| MCP Server（协议层，:8090） | `wxdevops-task-admin/mcp-server/` |
| OAuth AS + 只读数据 API（:5000） | `wxdevops-task-admin/backend/`（`/api/oauth/*`、`/api/mcp-data/*`） |

部署与运维见后端项目 `mcp-server/README.md`。本仓库只在服务端地址变化时，
回填 `plugins/wechat/.claude-plugin/plugin.json` 的 `mcpServers.wechat.url`。

## 问题反馈
- 商务合作：Great@bestfunc.com

## License
Apache-2.0
