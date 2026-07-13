---
name: wechat-file
display_name: 微信附件本地下载
description: 把微信群附件（图片/视频/文件）下载到本机磁盘并读取分析。总结群聊、需要"看图/读文件内容"、导出附件时使用。图片会被回传给模型直接看图分析；普通文件落盘后可读；**大于等于 100MB 不下载**，只给网络下载链接。依赖本地 wechat-file（stdio MCP），鉴权复用 felag 连接器已存令牌，无需重新授权。
user-invocable: true
allowed-tools: mcp__wechat__list_groups,mcp__wechat__get_messages,mcp__wechat__get_group_attachments,mcp__wechat-file__download_group_attachments,mcp__wechat-file__list_downloads
---

# 微信附件本地下载与分析

远程 `wechat`（HTTP MCP）负责读聊天/元数据；本地 `wechat-file`（stdio MCP）负责把附件**下载到本机**并把图片回传给模型分析。分工同 Argus 的 `argus` / `argus-files`。

## 何时用
- **总结群聊且要看图/读文件**：先下载附件到本地，再结合聊天记录一起总结。
- 用户要「导出/下载某群的图片/文件」。
- 需要读某个文件（HTML/表格/文档）的**内容**来回答。

## 工具（本地 `wechat-file:*`）
| 工具 | 用途 | 关键参数 |
|---|---|---|
| `download_group_attachments` | 下载某群附件到本机，图片回传分析，>=100MB 跳过 | room_id, limit(默认20), dir, inline_images(默认true), max_mb(默认100) |
| `list_downloads` | 列出已下载到本地的文件 | dir |

> `room_id` 来自远程 `wechat.list_groups`。下载目录默认 `env WECHAT_DOWNLOAD_DIR` 或 `<cwd>/wechat-attachments`。

## 返回与展示规则（务必遵循）
`download_group_attachments` 返回一个汇总 JSON（`items[]`，每项带 `status` 与 **`render_markdown`**）+ 若干**图片内容块**（模型可直接看图）。展示给用户时：

- **图片**（downloaded）：用该项 `render_markdown`，形如 `![文件名](本地路径)` —— 直接内联展示。已回传的图片可直接读图做分析。
- **普通文件**（downloaded）：用 `render_markdown`，形如 `[📎 文件名.ext（本地下载）](file://本地路径)` —— 展示文件名+后缀，可点击本地下载。需要分析内容时读 `local_path`。
- **>=100MB**（skipped_oversize）：用 `render_markdown`，形如 `[📎 文件名 NNNmb（点击从网络下载）](网络链接)` —— 不下载，给网络下载链接。
- **error**：该附件后端取不到（如 HTTP 500），如实说明「该附件暂不可用」，不要伪造内容。

## 典型流程：总结某群（含附件）
1. `wechat.list_groups`（按名找 `room_id`）。
2. `wechat.get_messages(room_id, ...)` 读聊天文本。
3. `wechat-file.download_group_attachments(room_id, limit=N)` 下载附件：图片直接看图、文件读 `local_path`。
4. 汇总：聊天要点 + 图片内容 + 文件内容一起总结；每个附件按上面的规则给出可内联的图 / 可点击的下载链接。

## 鉴权与注意
- **免重新授权**：本地 MCP 从 OS keychain 读 felag 连接器已存的 wechat 令牌，过期自动用 refresh_token 刷新。macOS 首次读取可能弹一次钥匙串「允许」框，点一次即可。
- 找不到令牌（非 felag 环境）时，可设 `env WECHAT_ACCESS_TOKEN` 兜底。
- **权限一致**：可下载的附件范围 = 该用户可见群范围（后端按令牌 email 校验）。
- **100MB 阈值**：可用 `max_mb` 覆盖；下载中若超阈值会中止并转为网络链接。
- **只读**：仅下载，不发送/修改任何微信内容。
