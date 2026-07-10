# wechat-file-mcp（本地 stdio MCP）

把微信群附件**下载到本机磁盘**并把图片回传给模型做本地汇总分析。**零 npm 依赖**（纯 Node，`node >= 18`），随 wechat 插件分发，由客户端以 stdio 子进程拉起。

## 复用已授权令牌（不改客户端、不重新授权）

不自己走 OAuth。启动时从 **OS keychain 读 felag-client 连接器已存的 wechat 令牌**：

- macOS：generic password，`service=felag-client-connector`、`account=wechat`（值 `go-keyring-base64:` + base64(JSON)）
- Windows：通用凭据（wincred），`target=felag-client-connector:wechat`（blob 为原始 JSON，UTF-8）

令牌含 `access_token/refresh_token/token_endpoint/client_id`；过期时用 refresh_token 自动刷新（仅内存态，不回写 keychain）。再用 Bearer 调后端 `/api/mcp-data/attachments/<id>/download` 下载。

> 首次由子进程读取 keychain，macOS 可能弹一次「允许/始终允许」授权框，点一次即可。

## 工具

| 工具 | 说明 |
|---|---|
| `download_group_attachments(room_id, limit?, dir?, inline_images?)` | 下载某群附件到本地目录，返回本地路径；图片同时以图片内容回传供直接查看/分析 |

先用 wechat（HTTP MCP）的 `list_groups` 拿 `room_id`。

## 配置（env，见 plugin.json mcpServers.wechat-file.env）

| 变量 | 默认 |
|---|---|
| `WXDEVOPS_API_BASE` | `http://114.55.116.77:5000` |
| `FELAG_CONNECTOR_SERVICE` | `felag-client-connector` |
| `FELAG_CONNECTOR_ACCOUNT` | `wechat` |
| `WECHAT_DOWNLOAD_DIR` | `<cwd>/wechat-attachments` |
| `WECHAT_IMAGE_INLINE_MAX` | `20`（回给模型的图片数上限；0=不回图） |
