"""
bestfunc 微信聊天记录 MCP Server（远程 Streamable HTTP，只读）。

- OAuth 资源服务器：校验 Bearer 令牌（调 wxdevops /api/mcp-data/me），
  暴露 /.well-known/oauth-protected-resource 指向 wxdevops 授权服务器。
- 工具：把 MCP 调用透传成 wxdevops /api/mcp-data/* 调用（携带调用方令牌），
  数据按该用户「可见群」范围返回。
"""
import os
import contextvars

import httpx
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.routing import Route

from mcp.server.fastmcp import FastMCP

# ---- 配置 ----
WXDEVOPS_API_BASE = os.environ.get("WXDEVOPS_API_BASE", "http://127.0.0.1:5000").rstrip("/")
AUTH_SERVER_URL = os.environ.get("AUTH_SERVER_URL", WXDEVOPS_API_BASE).rstrip("/")  # OAuth AS = wxdevops
RESOURCE_URL = os.environ.get("MCP_RESOURCE_URL", "http://127.0.0.1:8088").rstrip("/")
HOST = os.environ.get("MCP_HOST", "0.0.0.0")
PORT = int(os.environ.get("MCP_PORT", "8088"))

_token: contextvars.ContextVar[str] = contextvars.ContextVar("bearer_token", default="")

mcp = FastMCP("bestfunc-wechat", host=HOST, port=PORT)


# ---- 调 wxdevops 数据 API（携带调用方令牌）----
async def _get(path: str, params: dict | None = None) -> dict:
    token = _token.get()
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{WXDEVOPS_API_BASE}/api/mcp-data{path}",
                             params={k: v for k, v in (params or {}).items() if v not in (None, "")},
                             headers={"Authorization": f"Bearer {token}"})
    if r.status_code == 401:
        raise PermissionError("令牌无效或已过期")
    if r.status_code == 403:
        return {"error": "无权访问该资源"}
    r.raise_for_status()
    body = r.json()
    return body.get("data", body)


# ---- 只读工具 ----
@mcp.tool()
async def list_groups(group_name: str = "", project_code: str = "", page: int = 1, page_size: int = 20) -> dict:
    """列出当前用户可访问的微信群（含群备注、项目编号/名称、内外部、权限等级/密级）。"""
    return await _get("/groups", {"group_name": group_name, "project_code": project_code, "page": page, "pageSize": page_size})


@mcp.tool()
async def get_group(room_id: str) -> dict:
    """获取单个群的详情与额外维护信息（备注/项目/内外部/密级/管理员）。"""
    return await _get(f"/groups/{room_id}")


@mcp.tool()
async def get_messages(room_id: str, page: int = 1, page_size: int = 50, since: int = 0, until: int = 0, msg_type: str = "") -> dict:
    """读取某群的聊天消息（按时间倒序分页；since/until 为毫秒时间戳）。"""
    return await _get(f"/groups/{room_id}/messages", {"page": page, "pageSize": page_size, "since": since, "until": until, "msg_type": msg_type})


@mcp.tool()
async def search_messages(keyword: str, room_id: str = "", page: int = 1, page_size: int = 20) -> dict:
    """在当前用户可见群内全文搜索消息（可指定 room_id 限定单群）。"""
    return await _get("/search", {"keyword": keyword, "room_id": room_id, "page": page, "pageSize": page_size})


@mcp.tool()
async def get_members(room_id: str, page: int = 1, page_size: int = 50) -> dict:
    """读取某群的成员（人员信息，来自该群聊天发送者）。"""
    return await _get(f"/groups/{room_id}/members", {"page": page, "pageSize": page_size})


@mcp.tool()
async def get_group_attachments(room_id: str, page: int = 1, page_size: int = 20) -> dict:
    """列出某群的附件（图片/视频/文件等，含下载直链）。"""
    return await _get(f"/groups/{room_id}/attachments", {"page": page, "pageSize": page_size})


@mcp.tool()
async def get_attachment(attachment_id: str) -> dict:
    """获取单个附件的元信息与下载直链。"""
    return await _get(f"/attachments/{attachment_id}")


# ---- OAuth 资源服务器：令牌校验中间件 + 受保护资源元数据 ----
PROTECTED_PREFIXES = ("/mcp", "/messages", "/sse")  # 需要鉴权的 MCP 端点


class BearerAuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        if not any(path.startswith(p) for p in PROTECTED_PREFIXES):
            return await call_next(request)
        auth = request.headers.get("authorization", "")
        if not auth.startswith("Bearer "):
            return self._unauth()
        token = auth[7:]
        # 调 wxdevops 内省令牌
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                r = await client.get(f"{WXDEVOPS_API_BASE}/api/mcp-data/me",
                                     headers={"Authorization": f"Bearer {token}"})
        except Exception:
            return JSONResponse({"error": "auth_server_unreachable"}, status_code=503)
        if r.status_code != 200:
            return self._unauth()
        tok_ctx = _token.set(token)
        try:
            return await call_next(request)
        finally:
            _token.reset(tok_ctx)

    def _unauth(self):
        # 按 MCP/OAuth 规范，401 带 WWW-Authenticate 指向受保护资源元数据
        return JSONResponse(
            {"error": "invalid_token"}, status_code=401,
            headers={"WWW-Authenticate": f'Bearer resource_metadata="{RESOURCE_URL}/.well-known/oauth-protected-resource"'},
        )


async def protected_resource_metadata(request: Request):
    return JSONResponse({
        "resource": RESOURCE_URL,
        "authorization_servers": [AUTH_SERVER_URL],
        "scopes_supported": ["read"],
        "bearer_methods_supported": ["header"],
    })


def build_app():
    app = mcp.streamable_http_app()
    app.add_middleware(BearerAuthMiddleware)
    app.router.routes.append(
        Route("/.well-known/oauth-protected-resource", protected_resource_metadata, methods=["GET"])
    )
    return app


app = build_app()


def main():
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)


if __name__ == "__main__":
    main()
