#!/usr/bin/env node
/**
 * wechat-file-mcp —— 微信附件「本地文件」MCP（本地 stdio，零依赖）。
 *
 * 定位（对照 Argus 的 argus-files）：远程 wechat（HTTP MCP）把聊天/元数据读进上下文；
 * 本地 wechat-file 把附件**直流下载到本机磁盘**并把图片回传给模型做本地读取/分析，绕开
 * MCP base64 内联导致的上下文膨胀。**>=100MB 不下载**，只回网络下载链接。
 *
 * 鉴权：不自己走 OAuth，从 OS keychain 读 felag-client 连接器已存的 wechat 令牌
 * （macOS security / Windows wincred / Linux secret-tool；或 env WECHAT_ACCESS_TOKEN 兜底），
 * 过期用 refresh_token 自动刷新（仅内存态，不回写 keychain），再以 Bearer 调后端
 * /api/mcp-data/attachments/<id>/download 下载。
 *
 * 协议：MCP stdio = 换行分隔 JSON-RPC 2.0。纯 Node 内置模块，无需 npm 安装。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { URL } = require('url');

const VERSION = '0.2.0';

// ---- 配置 ----
const API_BASE = (process.env.WXDEVOPS_API_BASE || 'http://114.55.116.77:5000').replace(/\/+$/, '');
const KC_SERVICE = process.env.FELAG_CONNECTOR_SERVICE || 'felag-client-connector';
const KC_ACCOUNT = process.env.FELAG_CONNECTOR_ACCOUNT || 'wechat';
const DOWNLOAD_DIR = process.env.WECHAT_DOWNLOAD_DIR || path.join(process.cwd(), 'wechat-attachments');
const IMAGE_INLINE_MAX = parseInt(process.env.WECHAT_IMAGE_INLINE_MAX || '20', 10);
const DEFAULT_MAX_MB = parseInt(process.env.WECHAT_MAX_MB || '100', 10); // 全局：>=此值不下载

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'svg', 'tiff']);
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif' };

function log(...a) { process.stderr.write('[wechat-file] ' + a.join(' ') + '\n'); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function sanitize(name) { return String(name || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 180); }
function humanMB(b) { return (b || b === 0) ? Math.round((b / 1048576) * 10) / 10 : null; }
function extOf(fileName, fileExt) {
  let e = (fileExt || '').toString();
  if (!e && fileName && fileName.includes('.')) e = fileName.split('.').pop();
  return e.toLowerCase().replace(/[^a-z0-9]/g, '');
}
function isImage(ext, fileType) {
  return (fileType && String(fileType).toLowerCase() === 'image') || IMAGE_EXTS.has(ext);
}

// ===================== 令牌（keychain 复用 + 刷新） =====================
let _tok = null; // {access_token, refresh_token, token_endpoint, client_id, expires_at}

function readKeychainRaw() {
  if (process.env.WECHAT_ACCESS_TOKEN) {
    return JSON.stringify({ access_token: process.env.WECHAT_ACCESS_TOKEN });
  }
  try {
    if (process.platform === 'darwin') {
      return execFileSync('security', ['find-generic-password', '-s', KC_SERVICE, '-a', KC_ACCOUNT, '-w'], { encoding: 'utf8' }).trim();
    }
    if (process.platform === 'linux') {
      return execFileSync('secret-tool', ['lookup', 'service', KC_SERVICE, 'account', KC_ACCOUNT], { encoding: 'utf8' }).trim();
    }
    if (process.platform === 'win32') {
      // wincred：go-keyring 存为 target=<service>:<account>；用 PowerShell + CredMan P/Invoke 读取 blob
      const ps = [
        '$ErrorActionPreference="Stop";',
        '$sig=@"',
        'using System;using System.Runtime.InteropServices;',
        'public class Cred{',
        '[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]public struct CREDENTIAL{public uint Flags;public uint Type;public string TargetName;public string Comment;public long LastWritten;public uint CredentialBlobSize;public IntPtr CredentialBlob;public uint Persist;public uint AttributeCount;public IntPtr Attributes;public string TargetAlias;public string UserName;}',
        '[DllImport("advapi32",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool CredRead(string t,uint y,uint f,out IntPtr c);',
        '[DllImport("advapi32")]public static extern void CredFree(IntPtr c);',
        '}',
        '"@;',
        'Add-Type -TypeDefinition $sig;',
        '$p=[IntPtr]::Zero;',
        `if([Cred]::CredRead('${KC_SERVICE}:${KC_ACCOUNT}',1,0,[ref]$p)){`,
        "$c=[Runtime.InteropServices.Marshal]::PtrToStructure($p,[Type]'Cred+CREDENTIAL');",
        '$b=New-Object byte[] $c.CredentialBlobSize;',
        '[Runtime.InteropServices.Marshal]::Copy($c.CredentialBlob,$b,0,$c.CredentialBlobSize);',
        '[Cred]::CredFree($p);',
        '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b));}',
      ].join('');
      return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
    }
  } catch (e) {
    log('读 keychain 失败:', e.message);
  }
  return '';
}

function loadToken() {
  if (_tok) return _tok;
  let raw = readKeychainRaw();
  if (!raw) throw new Error('未找到 wechat 令牌：请确认 felag-client 已登录授权，或设 env WECHAT_ACCESS_TOKEN');
  if (raw.startsWith('go-keyring-base64:')) {
    raw = Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8');
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (_) { obj = { access_token: raw }; }
  if (!obj.access_token) throw new Error('令牌格式异常：缺少 access_token');
  _tok = obj;
  return _tok;
}

function expiresSoon(tok) {
  const ea = tok.expires_at;
  if (!ea) return false;
  const sec = typeof ea === 'number' ? ea : Math.floor(new Date(ea).getTime() / 1000);
  if (!Number.isFinite(sec)) return false;
  return sec - Math.floor(Date.now() / 1000) < 60;
}

async function refreshToken() {
  const t = _tok || loadToken();
  if (!t.refresh_token || !t.token_endpoint) throw new Error('无法刷新：缺少 refresh_token/token_endpoint');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: t.client_id || '' }).toString();
  const res = await httpRequest(t.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
  if (res.status !== 200) throw new Error('刷新令牌失败 HTTP ' + res.status);
  const j = JSON.parse(res.body.toString('utf8'));
  t.access_token = j.access_token;
  if (j.refresh_token) t.refresh_token = j.refresh_token;
  if (j.expires_in) t.expires_at = Math.floor(Date.now() / 1000) + Number(j.expires_in);
  _tok = t;
  log('已刷新 access_token');
  return t.access_token;
}

async function bearer() {
  const t = loadToken();
  if (expiresSoon(t)) { try { await refreshToken(); } catch (e) { log(e.message); } }
  return t.access_token;
}

// ===================== 通用 HTTP =====================
function httpRequest(url, opts = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let u; try { u = new URL(url); } catch (_) { return reject(new Error('invalid url: ' + url)); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: opts.method || 'GET', headers: opts.headers || {}, timeout: opts.timeout || 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpRequest(new URL(res.headers.location, u).toString(), opts, redirects + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function apiGetJson(pathname) {
  let tok = await bearer();
  let res = await httpRequest(`${API_BASE}${pathname}`, { headers: { authorization: `Bearer ${tok}` } });
  if (res.status === 401) { tok = await refreshToken(); res = await httpRequest(`${API_BASE}${pathname}`, { headers: { authorization: `Bearer ${tok}` } }); }
  if (res.status !== 200) throw new Error(`GET ${pathname} → HTTP ${res.status}`);
  return JSON.parse(res.body.toString('utf8'));
}

// 流式下载到 destPath，超过 maxBytes 立即中止并删除半成品；带 Bearer + 401 刷新重试
function streamDownload(url, destPath, maxBytes, token, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    let u; try { u = new URL(url); } catch (_) { return reject(new Error('invalid url')); }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const req = lib.get(u, { timeout: 180000, headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(streamDownload(new URL(res.headers.location, u).toString(), destPath, maxBytes, token, redirects + 1));
      }
      if (res.statusCode === 401) { res.resume(); return resolve({ unauthorized: true }); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const declared = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : null;
      if (Number.isFinite(declared) && declared > maxBytes) { res.destroy(); return resolve({ oversize: true, size: declared }); }
      let written = 0;
      const out = fs.createWriteStream(destPath);
      res.on('data', (chunk) => {
        written += chunk.length;
        if (written > maxBytes) { res.destroy(); out.destroy(); fs.unlink(destPath, () => {}); resolve({ oversize: true, size: written }); }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ oversize: false, size: written })));
      out.on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('download timeout')); });
  });
}

async function downloadById(id, destPath, maxBytes) {
  let tok = await bearer();
  const url = `${API_BASE}/api/mcp-data/attachments/${id}/download`;
  let r = await streamDownload(url, destPath, maxBytes, tok);
  if (r.unauthorized) { tok = await refreshToken(); r = await streamDownload(url, destPath, maxBytes, tok); }
  return r;
}

// ===================== 工具实现 =====================
function renderMarkdown(item) {
  const fn = item.file_name || item.id;
  if (item.status === 'skipped_oversize') {
    const sz = item.size_mb != null ? ` ${item.size_mb}MB` : '';
    return `[📎 ${fn}${sz}（点击从网络下载）](${item.network_url})`;
  }
  if (item.status === 'downloaded') {
    return item.is_image ? `![${fn}](${item.local_path})` : `[📎 ${fn}（本地下载）](file://${item.local_path})`;
  }
  return `~~${fn}（${item.status}）~~`;
}

async function downloadGroupAttachments(args) {
  const roomId = args && args.room_id;
  if (!roomId) return { error: '缺少 room_id（先用 wechat.list_groups 拿 room_id）' };
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 20));
  const dir = args.dir || DOWNLOAD_DIR;
  const inlineImages = args.inline_images !== false;
  const maxBytes = Math.round((Number(args.max_mb) || DEFAULT_MAX_MB) * 1048576);
  ensureDir(dir);

  const resp = await apiGetJson(`/api/mcp-data/groups/${encodeURIComponent(roomId)}/attachments?pageSize=${limit}`);
  const data = resp.data || resp;
  const list = Array.isArray(data) ? data : (data.items || data.list || []);

  const results = [];
  let inlined = 0;
  const imageBlocks = [];

  for (const a of list.slice(0, limit)) {
    const id = a.id;
    const ext = extOf(a.file_name, a.file_ext);
    const img = isImage(ext, a.file_type);
    const size = Number(a.file_size) || null;
    const fn = sanitize(a.file_name || (id + (ext ? '.' + ext : '')));
    const base = { id, file_name: a.file_name || fn, ext, is_image: img, size_bytes: size, size_mb: humanMB(size), uploader_name: a.uploader_name || null, msg_time: a.msg_time || null };

    // >=100MB：不下载，给网络下载链接（优先记录里的 download_url，回退 mcp-data 下载端点）
    if (Number.isFinite(size) && size >= maxBytes) {
      const item = { ...base, status: 'skipped_oversize', network_url: a.download_url || `${API_BASE}/api/mcp-data/attachments/${id}/download`, reason: `>=${args.max_mb || DEFAULT_MAX_MB}MB 不下载` };
      item.render_markdown = renderMarkdown(item);
      results.push(item);
      continue;
    }

    const destPath = path.join(dir, `${String(id).slice(0, 8)}_${fn}`);
    try {
      let r;
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        r = { oversize: false, size: fs.statSync(destPath).size, cached: true };
      } else {
        r = await downloadById(id, destPath, maxBytes);
      }
      if (r.oversize) {
        const item = { ...base, status: 'skipped_oversize', size_bytes: r.size, size_mb: humanMB(r.size), network_url: a.download_url || `${API_BASE}/api/mcp-data/attachments/${id}/download`, reason: `下载中超过阈值已中止` };
        item.render_markdown = renderMarkdown(item);
        results.push(item);
        continue;
      }
      const item = { ...base, status: 'downloaded', local_path: destPath, cached: !!r.cached, size_bytes: r.size, size_mb: humanMB(r.size) };
      item.render_markdown = renderMarkdown(item);
      results.push(item);
      // 图片回传给模型做分析（受 inline 上限）
      if (img && inlineImages && inlined < IMAGE_INLINE_MAX) {
        try {
          const b64 = fs.readFileSync(destPath).toString('base64');
          imageBlocks.push({ type: 'image', data: b64, mimeType: MIME[ext] || 'image/jpeg' });
          inlined++;
        } catch (_) {}
      }
    } catch (e) {
      const item = { ...base, status: 'error', error: String(e && e.message || e) };
      item.render_markdown = renderMarkdown(item);
      results.push(item);
    }
  }

  const summary = {
    room_id: roomId, dir, total: results.length,
    downloaded: results.filter((r) => r.status === 'downloaded').length,
    skipped_oversize: results.filter((r) => r.status === 'skipped_oversize').length,
    errors: results.filter((r) => r.status === 'error').length,
    inlined_images: inlined,
    items: results,
    note: '图片用 render_markdown 内联展示；普通文件用 render_markdown 给本地下载链接；>=100MB 用 network_url 给网络下载链接。已内联的图片可直接读图分析。',
  };
  return { summary, imageBlocks };
}

function listDownloads(args) {
  const dir = (args && args.dir) || DOWNLOAD_DIR;
  if (!fs.existsSync(dir)) return { dir, count: 0, files: [] };
  const files = fs.readdirSync(dir).map((f) => { const p = path.join(dir, f); const st = fs.statSync(p); return { file: f, local_path: p, size_bytes: st.size, size_mb: humanMB(st.size) }; });
  return { dir, count: files.length, files };
}

// ===================== 工具清单 =====================
const TOOLS = [
  {
    name: 'download_group_attachments',
    description: '把某个微信群的附件（图片/视频/文件）直流下载到本机目录并返回本地路径；图片同时以图片内容回传供直接查看/分析。**>=100MB 不下载**，只回网络下载链接。每项含 render_markdown：图片→内联 ![]()、普通文件→本地下载链接、超限→网络下载链接。先用 wechat.list_groups 拿 room_id。',
    inputSchema: {
      type: 'object',
      properties: {
        room_id: { type: 'string', description: '群 id（=group_id，来自 wechat.list_groups）' },
        limit: { type: 'number', description: '最多处理的附件数（默认 20，按时间倒序）' },
        dir: { type: 'string', description: '下载目录（默认 env WECHAT_DOWNLOAD_DIR 或 <cwd>/wechat-attachments）' },
        inline_images: { type: 'boolean', description: '是否把图片回传给模型分析（默认 true，上限 env WECHAT_IMAGE_INLINE_MAX）' },
        max_mb: { type: 'number', description: '不下载阈值(MB)，默认 100' },
      },
      required: ['room_id'],
    },
  },
  {
    name: 'list_downloads',
    description: '列出下载目录里已落盘的附件。',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } } },
  },
];

async function dispatch(name, args) {
  if (name === 'download_group_attachments') return downloadGroupAttachments(args || {});
  if (name === 'list_downloads') return listDownloads(args || {});
  throw new Error('unknown tool: ' + name);
}

// ===================== JSON-RPC over stdio =====================
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    if (method === 'initialize') {
      return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'wechat-file', version: VERSION } } });
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const out = await dispatch(params && params.name, params && params.arguments);
      // download_group_attachments 返回 {summary, imageBlocks}；其它工具直接返回对象
      let content;
      if (out && out.summary !== undefined) {
        content = [{ type: 'text', text: JSON.stringify(out.summary) }, ...(out.imageBlocks || [])];
      } else {
        content = [{ type: 'text', text: JSON.stringify(out) }];
      }
      return send({ jsonrpc: '2.0', id, result: { content, isError: !!(out && out.error) } });
    }
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    if (!isNotification) send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(e && e.message || e) } });
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
