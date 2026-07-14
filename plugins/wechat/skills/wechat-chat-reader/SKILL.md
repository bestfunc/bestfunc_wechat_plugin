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
- **总结/分析某群**：`list_groups`(找 room_id) → `get_messages`(读文本) → `wechat-file.download_group_attachments(room_id)`(把 **<100MB 附件下到本机**) → **读取下载的本地文件**(图片看图、文档/表格/HTML 读内容) → 把聊天文本 **+ 附件内容结合起来**汇总。附件按下方「附件展示规则」渲染。
- **查某人发言**：`search_messages(keyword=人名, room_id=可选)`；或 `get_members` 确认后按发言人筛 `get_messages`。
- **找关键词**：`search_messages(keyword=...)`（不传 room_id 跨所有可见群）。
- **看图 / 读文件内容 / 本地下载**：`wechat-file.download_group_attachments(room_id)` —— <100MB 下到本机（图片回传可直接看图、文件给**本地路径**可读），**呈现时只显示文件路径、不内联图片**；**>=100MB 跳过只给网络链接**。
- **读项目/备注/密级**：`get_group(room_id)` → `project_code / project_name / group_alias / biz_category_label / access_level_label`。

## 消息字段（get_messages / search_messages 每条）
- `message.sender_name`（=顶层 `sender_name`）：**已解析好的发送人显示名**，直接用它，不要再拿 `from`(内部 id)去猜名字；外部联系人无对应资料时为「外部联系人」。
- `attachment`（图片/语音/视频/文件消息才有）：`{ url, file_name, format, file_type, file_size, oversize? }`。
  - `url` = `http://…:3001/api/attachments/…?exp=&sig=` 网络签名直链（http，约 7 天有效）。**仅 >=100MB** 时用它做网络下载链接；**<100MB 走本地连接**（见下方规则）。
  - 文本消息无此字段。附件行未就绪时 `url` 可能为 null 且带 `pending:true`。

## 展示格式（呈现聊天记录时遵循）
逐条成行、便于阅读，**不要挤成一段**。每条建议：

```
[HH:MM] 发送人：内容
```
- 发送人一律用 `sender_name`。同一发送人连续多条可省略重复署名。
- **每条必须带发送时间（含日期）**：**直接用每条的 `time_local` 字段**（已是中国时区 UTC+8 的「YYYY-MM-DD HH:MM」，含日期）——**不要**自己拿 `message.msgtime` 转时区（易转成 UTC 差 8 小时），也不要用 `create_time`（那是入库时间，非发送时间）。若用表格，**第一列固定是「时间」**（放 `time_local`），不要用序号 `#`；逐行格式则以 `[time_local]` 开头。
- 切勿输出「[图片]」「[表情 GIF]」「[发送了一张图片, N bytes]」这类**无路径/无链接占位**。

### 附件展示规则：图片和附件都**只显示文件路径**（不内联图片、不做网络预览）
> 客户端是内嵌 webview，**无法加载本地路径 / `file://` 的内联图片**（`![]()` 会破图），网络直链是 http 也会被混合内容拦。所以图片和附件**一律只给「文件路径」**，让用户点开 / 在 Finder 打开即可，别试图在气泡里内联预览。
>
> ⚠️ **只要结果里有附件消息（哪怕只是「列出最近 N 条」、没让你分析），也必须先调用一次 `wechat-file.download_group_attachments(room_id)` 把附件下到本机**，再用它返回的 `render_markdown`（本地路径链接）展示该条——不要直接把 `attachment.file_name` 写成「发送了图片(xxx.jpg)」这种没有路径的占位。
- **<100MB（图片/文件）→ 下到本机，显示本地文件路径**：先用 `wechat-file.download_group_attachments(room_id)` 下到本机拿本地路径：
  - **图片和文件一视同仁**，都用可点击的本地路径链接：`[📎 file_name](file://本地绝对路径)`，可再另起一行附上纯文本绝对路径便于复制。
  - **不要写内联图片 `![file_name](...)`**（本地路径 webview 加载不了、网络直链 http 被混合内容拦，都显示不出来，只会破图）。
  - **分析 / 总结时读取这些本地文件**：图片用 `Read` 看图、文档/表格/HTML 读内容，与聊天文本**结合分析**（别只给路径不看内容）。
- **>=100MB（oversize）→ 不下载**：给网络下载链接 `[📎 file_name（点击下载·网络）](attachment.url)`。
- **url 为 null / pending / 后端取不到（500）**：标注「⚠️ 该附件暂不可用」，不要编路径或链接。
- **严禁**只输出 `[图片]`/`[表情 GIF]`/`[发送了一张图片]` 占位——至少给出**本地文件路径**（或 >=100MB 的网络链接）。

⚠️ **注意**：
1. 图片**一律不内联**（`![]()` 在客户端渲染不出来），只给本地路径链接。
2. 优先真的用 `wechat-file.download_group_attachments` 把 <100MB 附件下下来拿**本地路径**；拿不到本地路径时才退而用网络链接。

- 需要时在开头给一句话主题概述，再列消息；参与人可标注（己方/客户方）但名字仍以 `sender_name` 为准。

## 注意
- **权限**：只能看到被授权的群（全局管理员=全部；群管理员=其负责的群）。
- **密级**：群带 `access_level`（公开/内部/机密/绝密）；处理高密级内容遵从保密要求。
- **分页**：看 `total`，按 `page` 翻页；消息默认时间倒序。`since/until` 为毫秒时间戳。
- **只读**：本插件不提供发送/修改能力。
- 调用报 401/未授权 → 见 `mcp-authorization` 完成 OAuth 登录。
