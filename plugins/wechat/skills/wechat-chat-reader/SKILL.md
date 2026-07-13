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
- **看图 / 读文件内容 / 本地下载**：`wechat-file.download_group_attachments(room_id)` —— <100MB 下到本机（图片回传可直接看图、文件给本地路径可读），**>=100MB 跳过只给网络链接**。
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
- 切勿输出「[图片]」「[表情 GIF]」「[发送了一张图片, N bytes]」这类**无链接占位**。

### 附件展示规则：<100MB 本地连接（并读取分析），>=100MB 网络连接，**别概括成 [图片]**
- **<100MB（图片/文件）→ 本地连接**：先 `wechat-file.download_group_attachments(room_id)` 下到本机，用返回的**本地路径**：
  - 图片/表情/GIF：`![file_name](本地路径)` 内联；
  - 其它文件：`[📎 file_name](file://本地路径)` 可点击本地下载。
  - **分析时读取这些本地文件**：图片直接看图、文档/表格/HTML 读 `local_path` 内容，与聊天文本**结合分析**（别只贴链接不看内容）。
- **>=100MB（oversize）→ 网络连接**：`[📎 file_name（点击下载）](attachment.url)`，不下载、不内联。
- **url 为 null / pending / 后端取不到（500）**：标注「⚠️ 该附件暂不可用」，不要编链接。
- **严禁** `[图片]`/`[表情 GIF]`/`[发送了一张图片]` 占位。

⚠️ **两个渲染坑**：
1. 图片 `![]()` **单独成行、别放 GFM 表格单元格**（多数渲染器不认）；含图片的聊天改逐行格式，或图片列在表格外，别塞进「内容」列。
2. `>=100MB` 的网络链接是 http（非 https）+ 签名约 7 天到期：https 场景可能混合内容被拦、旧链接过 `exp` 变死链。

- 需要时在开头给一句话主题概述，再列消息；参与人可标注（己方/客户方）但名字仍以 `sender_name` 为准。

## 注意
- **权限**：只能看到被授权的群（全局管理员=全部；群管理员=其负责的群）。
- **密级**：群带 `access_level`（公开/内部/机密/绝密）；处理高密级内容遵从保密要求。
- **分页**：看 `total`，按 `page` 翻页；消息默认时间倒序。`since/until` 为毫秒时间戳。
- **只读**：本插件不提供发送/修改能力。
- 调用报 401/未授权 → 见 `mcp-authorization` 完成 OAuth 登录。
