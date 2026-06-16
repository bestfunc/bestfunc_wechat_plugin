# 微信聊天记录 MCP Server（只读，远程 Streamable HTTP + OAuth 资源服务器）
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -i https://mirrors.aliyun.com/pypi/simple/ -r requirements.txt

COPY src /app/src
ENV PYTHONPATH=/app/src \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8090

EXPOSE 8090
CMD ["python", "-m", "bestfunc_wechat_mcp"]