---
name: wechat-chat-reader
display_name: 微信聊天记录查询
description: 通过微信聊天记录 MCP（只读）查询当前用户有权限的微信群的聊天记录、人员、附件与群信息。当用户问「某群最近聊了什么/总结某群本周」「某人在某群说了什么」「找包含关键词的聊天」「列出某群的图片/视频/附件」「这个群的项目编号/备注/密级」等涉及企业微信群聊存档的问题时使用。需先连接 wechat MCP 并完成 OAuth 授权（见 mcp-authorization）。只读，不发送任何消息。
user-invocable: true
allowed-tools: mcp__wechat__list_groups,mcp__wechat__get_group,mcp__wechat__get_messages,mcp__wechat__search_messages,mcp__wechat__get_members,mcp__wechat__get_group_attachments,mcp__wechat__get_attachment
---

# 微信聊天记录查询

按「当前登录用户可见的群范围」只读读取企业微信会话存档。数据已按用户权限隔离，无需自己判断权限；未授权的群看不到属正常。

## 工具一览（均 🟢 只读 L1，直接调用）
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `list_groups` | 列出可访问的群（含备注/项目编号/项目名称/内外部/密级/管理员） | group_name, project_code, page, page_size |
| `get_group` | 单群详情与额外维护信息 | room_id |
| `get_messages` | 读某群消息（时间倒序分页） | room_id, page, page_size, since, until(毫秒), msg_type |
| `search_messages` | 可见群内全文搜索（可限定单群） | keyword, room_id, page, page_size |
| `get_members` | 群成员/人员信息 | room_id, page, page_size |
| `get_group_attachments` | 群附件列表（图片/视频/文件，含下载直链） | room_id, page, page_size |
| `get_attachment` | 单个附件元信息与直链 | attachment_id |

> 群唯一标识是 `room_id`（=group_id）。先 `list_groups` 拿 room_id，再查内容。

## 典型用法
- **总结某群本周**：`list_groups`(按名找 room_id) → `get_messages(room_id, since=本周起始毫秒, page_size=100)`(必要时翻页) → 按发言人/决策/待办汇总。
- **查某人发言**：`search_messages(keyword=人名, room_id=可选)`；或 `get_members` 确认后按发言人筛 `get_messages`。
- **找关键词**：`search_messages(keyword=...)`（不传 room_id 跨所有可见群）。
- **拿图片/视频/附件**：`get_group_attachments(room_id)` → 取 `download_url`；单个用 `get_attachment(attachment_id)`。
- **要看图 / 读文件内容 / 下载到本地 / 总结时分析附件**：转用 `wechat-file` skill 的 `download_group_attachments(room_id)` —— 把附件下载到本机、图片回传直接看图分析，**>=100MB 自动跳过只给网络链接**。
- **读项目/备注/密级**：`get_group(room_id)` → `project_code / project_name / group_alias / biz_category_label / access_level_label`。

## 消息字段（get_messages / search_messages 每条）
- `message.sender_name`（=顶层 `sender_name`）：**已解析好的发送人显示名**，直接用它，不要再拿 `from`(内部 id)去猜名字；外部联系人无对应资料时为「外部联系人」。
- `attachment`（图片/语音/视频/文件消息才有）：`{ url, file_name, format, file_type, file_size, oversize? }`。
  - ⚠️ `url` 是 `http://…:3001/api/attachments/…?sig=…` 的**网络连接（签名直链）**——**不是本地连接**。**不要**直接拿它当 <100MB 附件的点击链接（见下方渲染规则）。
  - 文本消息无此字段。附件行未就绪时 `url` 可能为 null 且带 `pending:true`。

## 展示格式（呈现聊天记录时遵循）
逐条成行、便于阅读，**不要挤成一段**。每条建议：

```
[HH:MM] 发送人：内容
```
- 发送人一律用 `sender_name`。同一发送人连续多条可省略重复署名。
- 切勿输出「[图片]」「[表情 GIF]」「[发送了一张图片, N bytes]」这类**无链接占位**。

### 附件链接规则：**本地连接优先，网络连接只留给 >=100MB**
呈现带附件的聊天时，**先用 `wechat-file.download_group_attachments(room_id)` 把附件下到本机**，再按 `file_name` 与 get_messages 的消息对应，用 wechat-file 返回的 `render_markdown`：

| 情况 | 渲染（用什么链接） |
|---|---|
| 图片（<100MB，已下载） | **本地连接**：`![文件名](本地路径)` 内联展示 |
| 其他文件（<100MB，已下载） | **本地连接**：`[📎 文件名.ext（本地下载）](file://本地路径)` |
| `>=100MB`（未下载） | **网络连接**：`[📎 文件名 NNNmb（点击从网络下载）](网络链接)` ← 只有这种才用 `:3001` 网络直链 |
| 后端取不到（下载 500/error） | 标注「⚠️ 该附件暂不可用」，**不要**给坏链接 |

> 要点：`get_messages.attachment.url`（:3001 网络直链）**只在 >=100MB 或本地下载失败时兜底**；<100MB 一律走 wechat-file 的**本地连接**（`file://本地路径`）。
> 若客户端未装本地 `wechat-file`（如纯浏览器场景），才回退用网络 `attachment.url`。

- 需要时在开头给一句话主题概述，再列消息；参与人可标注（己方/客户方）但名字仍以 `sender_name` 为准。

## 注意
- **权限**：只能看到被授权的群（全局管理员=全部；群管理员=其负责的群）。
- **密级**：群带 `access_level`（公开/内部/机密/绝密）；处理高密级内容遵从保密要求。
- **分页**：看 `total`，按 `page` 翻页；消息默认时间倒序。`since/until` 为毫秒时间戳。
- **只读**：本插件不提供发送/修改能力。
- 调用报 401/未授权 → 见 `mcp-authorization` 完成 OAuth 登录。
