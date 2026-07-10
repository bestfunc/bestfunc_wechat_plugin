#!/usr/bin/env node
// wechat-file-mcp —— 本地 stdio MCP:复用 felag-client 已授权的 wechat 连接器令牌
// (从 OS keychain 读,不改 felag-client、不重新授权),把微信群附件下载到本地磁盘,
// 并可把图片以 MCP 图片内容直接回给模型,供本地汇总分析。零 npm 依赖(便于分发)。
//
// 令牌来源:felag-client 连接器把 OAuth 令牌存在 OS keychain:
//   macOS  : generic password, service="felag-client-connector", account="wechat"
//            值形如 "go-keyring-base64:<base64(JSON)>"
//   Windows: 通用凭据(wincred), target="felag-client-connector:wechat", blob=原始 JSON(UTF-8)
//   JSON: { access_token, refresh_token, token_endpoint, client_id, expires_at, ... }
//
// 配置(env,可在 plugin.json mcpServers 里给):
//   WXDEVOPS_API_BASE          默认 http://114.55.116.77:5000
//   FELAG_CONNECTOR_SERVICE    默认 felag-client-connector
//   FELAG_CONNECTOR_ACCOUNT    默认 wechat
//   WECHAT_DOWNLOAD_DIR        默认 <cwd>/wechat-attachments
//   WECHAT_IMAGE_INLINE_MAX    单次回给模型的图片数上限(默认 20;0=不回图片内容)

'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const API_BASE = (process.env.WXDEVOPS_API_BASE || 'http://114.55.116.77:5000').replace(/\/+$/, '');
const KC_SERVICE = process.env.FELAG_CONNECTOR_SERVICE || 'felag-client-connector';
const KC_ACCOUNT = process.env.FELAG_CONNECTOR_ACCOUNT || 'wechat';
const DL_DIR = process.env.WECHAT_DOWNLOAD_DIR || path.join(process.cwd(), 'wechat-attachments');
const IMG_INLINE_MAX = parseInt(process.env.WECHAT_IMAGE_INLINE_MAX || '20', 10);

// ---------- 日志(走 stderr,不污染 stdio 协议) ----------
const log = (...a) => { try { process.stderr.write('[wechat-file-mcp] ' + a.join(' ') + '\n'); } catch (_) {} };

// ---------- 读 OS keychain 里的连接器令牌 ----------
function readKeychainRaw() {
  if (process.platform === 'darwin') {
    const out = execFileSync('security',
      ['find-generic-password', '-s', KC_SERVICE, '-a', KC_ACCOUNT, '-w'],
      { encoding: 'utf8' }).trim();
    if (out.startsWith('go-keyring-base64:')) {
      return Buffer.from(out.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
    }
    return out;
  }
  if (process.platform === 'win32') {
    // 用 PowerShell + P/Invoke CredRead 按精确 target 读通用凭据(与 go-keyring 的 service:username 一致)
    const target = `${KC_SERVICE}:${KC_ACCOUNT}`;
    const ps = `
$ErrorActionPreference='Stop'
$sig=@"
using System;using System.Runtime.InteropServices;
public class Cred{
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CredRead(string t,int y,int f,out IntPtr c);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr c);
 [StructLayout(LayoutKind.Sequential)] public struct CREDENTIAL{public int Flags;public int Type;public IntPtr TargetName;public IntPtr Comment;public long LastWritten;public int CredentialBlobSize;public IntPtr CredentialBlob;public int Persist;public int AttributeCount;public IntPtr Attributes;public IntPtr TargetAlias;public IntPtr UserName;}
 public static string Get(string t){IntPtr p;if(!CredRead(t,1,0,out p))return null;try{var c=(CREDENTIAL)Marshal.PtrToStructure(p,typeof(CREDENTIAL));byte[] b=new byte[c.CredentialBlobSize];Marshal.Copy(c.CredentialBlob,b,0,c.CredentialBlobSize);return System.Text.Encoding.UTF8.GetString(b);}finally{CredFree(p);}}
}
"@
Add-Type $sig
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$v=[Cred]::Get('${target.replace(/'/g, "''")}')
if($v -eq $null){exit 3} else {[Console]::Out.Write($v)}
`.trim();
    return execFileSync('powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { encoding: 'utf8' });
  }
  throw new Error(`unsupported platform: ${process.platform}`);
}

// ---------- 令牌管理:读 + 过期则刷新(内存态,不回写 keychain) ----------
let _tok = null;
function jwtExp(t) {
  try {
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString('utf8'));
    return typeof p.exp === 'number' ? p.exp : 0;
  } catch (_) { return 0; }
}
async function refresh(rec) {
  if (!rec.refresh_token || !rec.token_endpoint) throw new Error('无 refresh_token/token_endpoint,无法刷新');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rec.refresh_token });
  if (rec.client_id) body.set('client_id', rec.client_id);
  const r = await fetch(rec.token_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error(`刷新令牌失败 ${r.status}`);
  const j = await r.json();
  rec.access_token = j.access_token || rec.access_token;
  if (j.refresh_token) rec.refresh_token = j.refresh_token;
  return rec;
}
async function accessToken() {
  if (!_tok) {
    const raw = readKeychainRaw();
    if (!raw || !raw.trim()) throw new Error('keychain 未找到 wechat 连接器令牌;请先在 felag-client 连接器页完成 wechat 授权');
    _tok = JSON.parse(raw.trim());
  }
  const at = _tok.access_token;
  const exp = jwtExp(at);
  if (!at || (exp && exp - 30 < Math.floor(Date.now() / 1000))) {
    log('access_token 过期/缺失,尝试刷新');
    await refresh(_tok);
  }
  return _tok.access_token;
}

// ---------- 调 MCP 数据 API(Bearer) ----------
async function apiGet(pathname, { binary = false } = {}) {
  const tok = await accessToken();
  const r = await fetch(API_BASE + pathname, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 401) {
    // 令牌可能刚过期:强制刷新一次再试
    await refresh(_tok);
    const r2 = await fetch(API_BASE + pathname, { headers: { Authorization: `Bearer ${_tok.access_token}` } });
    if (!r2.ok) throw new Error(`${pathname} 返回 ${r2.status}`);
    return binary ? Buffer.from(await r2.arrayBuffer()) : r2.json();
  }
  if (!r.ok) throw new Error(`${pathname} 返回 ${r.status}`);
  return binary ? Buffer.from(await r.arrayBuffer()) : r.json();
}

function sanitize(name) {
  return String(name || 'file').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 180);
}
const IMG_EXT = { image: 'image/png', emotion: 'image/gif' };

// ---------- 工具实现:下载一个群的附件到本地 ----------
async function downloadGroupAttachments({ room_id, limit = 50, dir, inline_images = true }) {
  if (!room_id) throw new Error('room_id 必填');
  const outDir = path.resolve(dir || DL_DIR, sanitize(room_id));
  fs.mkdirSync(outDir, { recursive: true });

  const listResp = await apiGet(`/api/mcp-data/groups/${encodeURIComponent(room_id)}/attachments?page=1&pageSize=${limit}`);
  const items = (listResp && listResp.data && (listResp.data.items || listResp.data.list || listResp.data)) || [];
  const arr = Array.isArray(items) ? items : (items.items || []);

  const results = [];
  const imageContents = [];
  for (const a of arr) {
    const id = a.id || a.attachment_id;
    if (!id) continue;
    const fname = sanitize(a.file_name || `${a.file_type || 'file'}_${id}`);
    const dest = path.join(outDir, `${id}__${fname}`);
    try {
      const buf = await apiGet(`/api/mcp-data/attachments/${encodeURIComponent(id)}/download`, { binary: true });
      fs.writeFileSync(dest, buf);
      const rec = { id, file_name: a.file_name, file_type: a.file_type, file_size: buf.length, local_path: dest };
      results.push(rec);
      if (inline_images && IMG_EXT[a.file_type] && imageContents.length < IMG_INLINE_MAX && buf.length <= 4 * 1024 * 1024) {
        imageContents.push({ type: 'image', data: buf.toString('base64'), mimeType: IMG_EXT[a.file_type] });
      }
    } catch (e) {
      results.push({ id, file_name: a.file_name, file_type: a.file_type, error: String(e.message || e) });
    }
  }

  const okCount = results.filter(r => r.local_path).length;
  const summary =
    `已下载 ${okCount}/${results.length} 个附件到本地目录:\n${outDir}\n\n` +
    results.map(r => r.local_path
      ? `· ${r.file_name || r.id} (${r.file_type}, ${r.file_size}B) -> ${r.local_path}`
      : `· ${r.file_name || r.id} 下载失败: ${r.error}`).join('\n');

  const content = [{ type: 'text', text: summary }, ...imageContents];
  return { content };
}

// ---------- 工具清单 ----------
const TOOLS = [
  {
    name: 'download_group_attachments',
    description: '把某个微信群的附件(图片/视频/文件)下载到本地磁盘,返回本地路径;图片会同时以图片内容回传供直接查看/分析。用已授权的 wechat 连接器令牌访问,无需重新授权。',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: '群 ID(room_id/group_id),先用 wechat 的 list_groups 拿到' },
        limit: { type: 'integer', description: '最多下载多少个附件(默认 50)', default: 50 },
        dir: { type: 'string', description: '本地保存根目录(可选,默认 WECHAT_DOWNLOAD_DIR 或 ./wechat-attachments)' },
        inline_images: { type: 'boolean', description: '是否把图片以图片内容回传(默认 true)', default: true },
      },
      required: ['room_id'],
    },
  },
];

async function callTool(name, args) {
  if (name === 'download_group_attachments') return downloadGroupAttachments(args || {});
  throw new Error(`未知工具: ${name}`);
}

// ---------- MCP stdio JSON-RPC(换行分隔) ----------
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

let PROTO = '2025-06-18';
async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    if (params && params.protocolVersion) PROTO = params.protocolVersion;
    return reply(id, {
      protocolVersion: PROTO,
      capabilities: { tools: {} },
      serverInfo: { name: 'wechat-file-mcp', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const nm = params && params.name;
    try {
      const out = await callTool(nm, params && params.arguments);
      return reply(id, out);
    } catch (e) {
      log('tool error:', String(e && e.stack || e));
      return reply(id, { content: [{ type: 'text', text: `错误: ${String(e && e.message || e)}` }], isError: true });
    }
  }
  if (id !== undefined) return replyErr(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    Promise.resolve(handle(msg)).catch((e) => log('handle error:', String(e)));
  }
});
process.stdin.on('end', () => process.exit(0));
log(`started; api=${API_BASE} keychain=${KC_SERVICE}/${KC_ACCOUNT} dl=${DL_DIR}`);
