#!/usr/bin/env node
/**
 * dsh-mobile-access 端到端验证脚本（Node 24 原生，零 npm 依赖）
 *
 * 事实源：mobile-access/CONTRACT.md「验证口径」7 条 + UI 交付清单。
 *
 * 流程：
 *   0. 从 loopback 读 GET /__mobile/state（404 / 连接失败 / enabled=false → 退出码 2，提示"插件未安装或未激活"）。
 *   1~7. 用 state 推导出的 LAN origin 实际验证配对门禁、反向代理、WebSocket upgrade、origin 改写。
 *   A/J. public/ 静态资源存在性 + node --check。
 *
 * 用法：
 *   node tests/verify.mjs              # 正常跑
 *   node tests/verify.mjs --json       # 额外输出机器可读 JSON
 *   node tests/verify.mjs --help
 *
 * 环境变量（全部可选）：
 *   DSH_MOBILE_LOOPBACK_PORT   loopback GUI 端口，默认 58216
 *   DSH_MOBILE_LOOPBACK        loopback origin 覆盖，如 http://127.0.0.1:58216（优先于端口）
 *   DSH_MOBILE_LAN_URL         LAN origin 覆盖，如 http://172.16.100.20:58218（默认取 state.lanUrl）
 *   DSH_MOBILE_PROJECT_ROOT    项目根目录覆盖（默认本脚本上一级），用于自测
 *   DSH_MOBILE_WS_PATH         WebSocket 探测路径覆盖（默认先 /api/remote.mux，再 /api）
 *   DSH_MOBILE_TIMEOUT_MS      单次 HTTP 请求超时，默认 5000
 *   DSH_MOBILE_WS_TIMEOUT_MS   WebSocket upgrade 探测超时，默认 4000
 *   DSH_MOBILE_ROOT_ID         GUI 根节点 id，默认 root
 *   DSH_MOBILE_JSON=1          等价于 --json
 *
 * 退出码：0 全通过；1 有失败；2 插件未安装或未激活（无法读取 state）。
 */

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(await fs.readFile(fileURLToPath(import.meta.url), 'utf8')
    .then((s) => (s.match(/\/\*\*([\s\S]*?)\*\//) || [, ''])[1]
      .split('\n').map((l) => l.replace(/^\s* \* ?/, '')).join('\n')));
  process.exit(0);
}

const JSON_OUT = argv.includes('--json') || process.env.DSH_MOBILE_JSON === '1';
const LOOPBACK_PORT = Number(process.env.DSH_MOBILE_LOOPBACK_PORT || 58216);
const HTTP_TIMEOUT_MS = positiveInt(process.env.DSH_MOBILE_TIMEOUT_MS, 5000);
const WS_TIMEOUT_MS = positiveInt(process.env.DSH_MOBILE_WS_TIMEOUT_MS, 4000);
const ROOT_ID = process.env.DSH_MOBILE_ROOT_ID || 'root';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(process.env.DSH_MOBILE_PROJECT_ROOT || path.join(HERE, '..'));

const LOOPBACK_ORIGIN = normalizeOrigin(
  process.env.DSH_MOBILE_LOOPBACK
  || process.env.DSH_MOBILE_LOOPBACK_ORIGIN
  || `http://127.0.0.1:${LOOPBACK_PORT}`,
);

const results = [];
let state = null;        // 解析后的 GET /__mobile/state
let lanOrigin = null;    // 实际验证使用的局域网 origin
let lanUrl = null;       // new URL(lanOrigin)
let lanCookie = null;    // "dshm_<port>=<token>"
let guiBody = null;      // 带 cookie GET / 的响应体（供 C6a 复用）
let guiFetch = null;     // 带 cookie GET / 的 fetch 结果

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function normalizeOrigin(value) {
  let v = String(value || '').trim().replace(/\/+$/, '');
  if (!v) return v;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `http://${v}`;
  return v.replace(/\/+$/, '');
}

function describeError(err) {
  const cause = err && err.cause;
  if (cause && cause.code) return `${cause.code}${cause.message ? ` ${cause.message}` : ''}`;
  if (err && err.name === 'TimeoutError') return 'timeout';
  if (err && err.name === 'AbortError') return 'aborted/timeout';
  return (err && (err.code || err.message)) || String(err);
}

function clip(value, max = 160) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function quoted(value, max = 160) {
  return `"${clip(value, max)}"`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function displayWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    width += (cp >= 0x1100 && cp <= 0x115f)
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe4f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
      || (cp >= 0x20000 && cp <= 0x3fffd)
      ? 2 : 1;
  }
  return width;
}

function padDisplay(text, width) {
  const diff = width - displayWidth(text);
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

function headerValue(headers, name) {
  try {
    return headers.get(name);
  } catch {
    return null;
  }
}

function getSetCookies(res) {
  try {
    if (typeof res.headers.getSetCookie === 'function') {
      const list = res.headers.getSetCookie();
      if (Array.isArray(list) && list.length) return list;
    }
  } catch { /* ignore */ }
  const raw = headerValue(res.headers, 'set-cookie');
  return raw ? [raw] : [];
}

/** 只展示 cookie 名和 token 前 6 位，避免日志泄露完整凭据。 */
function maskCookie(cookie) {
  if (!cookie) return '<none>';
  const eq = cookie.indexOf('=');
  if (eq < 0) return clip(cookie, 40);
  const name = cookie.slice(0, eq);
  const value = cookie.slice(eq + 1);
  return `${name}=${value.slice(0, 6)}…(${value.length} chars)`;
}

function cookieAttributes(setCookieRaw) {
  const attrs = String(setCookieRaw).split(';').slice(1).map((s) => s.trim()).filter(Boolean);
  return attrs.length ? attrs.join('; ') : '<none>';
}

/** 从 Set-Cookie 列表中挑出 dshm_* 的 name=value。 */
function extractPairCookie(setCookies) {
  for (const raw of setCookies) {
    const m = /(?:^|[,;]\s*)(dshm_[A-Za-z0-9_]*)=([^;,\s]+)/.exec(String(raw));
    if (m) return { name: m[1], value: m[2], raw, cookie: `${m[1]}=${m[2]}` };
  }
  return null;
}

function tamperCookie(cookie) {
  const eq = cookie.indexOf('=');
  const name = cookie.slice(0, eq);
  const value = cookie.slice(eq + 1);
  if (!value) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // 从尾部找第一个字母数字字符，替换成另一个字母数字字符（保持长度不变）。
  for (let i = value.length - 1; i >= 0; i--) {
    const ch = value[i];
    if (alphabet.includes(ch)) {
      const replacement = ch === 'A' ? 'B' : 'A';
      return `${name}=${value.slice(0, i)}${replacement}${value.slice(i + 1)}`;
    }
  }
  return `${name}=${value}tampered`;
}

async function httpRequest(url, options = {}) {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      redirect: options.redirect || 'manual',
      signal: AbortSignal.timeout(options.timeoutMs || HTTP_TIMEOUT_MS),
    });
    const body = await res.text();
    return {
      ok: true,
      status: res.status,
      headers: res.headers,
      setCookies: getSetCookies(res),
      body,
      ms: Date.now() - startedAt,
    };
  } catch (err) {
    return { ok: false, error: describeError(err), ms: Date.now() - startedAt };
  }
}

function responseEvidence(res, extra = []) {
  if (!res.ok) return [`请求失败: ${res.error}${res.ms ? ` (${res.ms}ms)` : ''}`];
  const lines = [`status=${res.status} (${res.ms}ms)`];
  const contentType = headerValue(res.headers, 'content-type');
  if (contentType) lines.push(`content-type: ${contentType}`);
  const location = headerValue(res.headers, 'location');
  if (location) lines.push(`location: ${location}`);
  const setCookies = res.setCookies || [];
  if (setCookies.length) {
    lines.push(`set-cookie: ${setCookies.map((c) => {
      const eq = String(c).indexOf('=');
      const name = eq > 0 ? String(c).slice(0, eq) : String(c);
      const masked = eq > 0 && /^dshm_/i.test(name)
        ? `${name}=<masked>`
        : `${name}=<masked>`;
      return `${masked}; ${cookieAttributes(String(c).slice(String(c).indexOf(';') + 1))}`;
    }).join(' || ')}`);
  }
  for (const name of extra) {
    const value = headerValue(res.headers, name);
    if (value) lines.push(`${name}: ${clip(value, 200)}`);
  }
  const interesting = ['upgrade', 'connection', 'sec-websocket-accept', 'www-authenticate',
    'cache-control', 'vary', 'x-frame-options', 'access-control-allow-origin'];
  for (const name of interesting) {
    if (extra.includes(name)) continue;
    const value = headerValue(res.headers, name);
    if (value) lines.push(`${name}: ${clip(value, 120)}`);
  }
  return lines;
}

function record(id, title, pass, details, group) {
  const result = { id, title, pass: !!pass, details, group };
  results.push(result);
  const tag = result.pass ? 'PASS' : 'FAIL';
  console.log(`  [${id}] ${tag}  ${title}`);
  for (const line of details) console.log(`        ${line}`);
  console.log('');
  return result;
}

async function check(id, title, fn, group = 'runtime') {
  try {
    const outcome = await fn();
    const details = Array.isArray(outcome) ? outcome : (outcome.details || []);
    const pass = Array.isArray(outcome) ? false : !!outcome.pass;
    return record(id, title, pass, details, group);
  } catch (err) {
    return record(id, title, false, [`脚本异常: ${err && err.stack ? err.stack : err}`], group);
  }
}

// ---------------------------------------------------------------------------
// 步骤 0：从 loopback 读取状态
// ---------------------------------------------------------------------------

const STATE_URL = `${LOOPBACK_ORIGIN}/__mobile/state`;

function exitNotInstalled(reason, extra = []) {
  console.log('');
  console.log('  [STOP] 插件未安装或未激活，无法执行端到端验证（退出码 2）');
  console.log(`         原因: ${reason}`);
  for (const line of extra) console.log(`         ${line}`);
  console.log(`         期望: GET ${STATE_URL} 返回 200 JSON（CONTRACT.md「GET /__mobile/state」）`);
  console.log('         处理: 先安装并激活 @local/dsh-mobile-access；若 loopback 端口不是 58216，');
  console.log('               用 DSH_MOBILE_LOOPBACK_PORT=xxxx 覆盖后重跑。');
  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: false, exitCode: 2, reason, stateUrl: STATE_URL }, null, 2));
  }
  process.exit(2);
}

async function loadState() {
  const res = await httpRequest(STATE_URL, {
    headers: { accept: 'application/json' },
    redirect: 'manual',
  });

  if (!res.ok) {
    exitNotInstalled(`无法连接 loopback（${res.error}）`, [`请求: GET ${STATE_URL}`]);
  }
  if (res.status === 404) {
    exitNotInstalled(`GET /__mobile/state 返回 404（路由不存在）`, [
      `响应: status=404 body=${quoted(res.body, 120)}`,
    ]);
  }
  if (res.status === 401 || res.status === 403) {
    exitNotInstalled(`GET /__mobile/state 返回 ${res.status}（loopback 鉴权拒绝）`, [
      `响应: status=${res.status} body=${quoted(res.body, 120)}`,
      '可能原因：插件未激活，或本脚本缺少桌面浏览器的 Host Cookie。',
    ]);
  }
  if (res.status !== 200) {
    exitNotInstalled(`GET /__mobile/state 返回 ${res.status}（非 200）`, [
      `响应: body=${quoted(res.body, 160)}`,
    ]);
  }

  let parsed;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    exitNotInstalled('GET /__mobile/state 返回 200 但不是合法 JSON', [
      `响应片段: ${quoted(res.body, 160)}`,
    ]);
  }

  if (!parsed || typeof parsed !== 'object') {
    exitNotInstalled('state 不是 JSON 对象', [`响应片段: ${quoted(res.body, 160)}`]);
  }
  if (parsed.enabled !== true) {
    exitNotInstalled(`state.enabled=${JSON.stringify(parsed.enabled)}`, [
      `state.error: ${JSON.stringify(parsed.error)}`,
      parsed.error ? '插件已安装但当前处于降级/未激活状态。' : '插件已安装但当前未启用。',
    ]);
  }
  for (const key of ['lanUrl', 'pairCode', 'loopbackOrigin']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) {
      exitNotInstalled(`state 缺少必需字段 ${key}（插件状态异常）`, [
        `实际 state: ${quoted(res.body, 240)}`,
      ]);
    }
  }
  return parsed;
}

function printStateSummary() {
  const bind = state.bind ? `${state.bind.host}:${state.bind.port}` : '<none>';
  console.log('  [state] 读取成功');
  console.log(`          loopbackOrigin = ${state.loopbackOrigin}`);
  console.log(`          lanUrl         = ${lanOrigin}${lanOrigin !== state.lanUrl ? ` (state.lanUrl=${state.lanUrl})` : ''}`);
  console.log(`          pairCode       = ${maskPairCode(state.pairCode)}  pairExpiresAt = ${state.pairExpiresAt ?? '<none>'}`);
  console.log(`          bind           = ${bind}  hostCookieReady = ${state.hostCookieReady}`);
  console.log(`          enabled        = ${state.enabled}  schema = ${state.schema}`);
  console.log('');
  if (state.hostCookieReady !== true) {
    console.log(`  ! 警告: state.hostCookieReady=${JSON.stringify(state.hostCookieReady)}，代理可能没有可注入的 Host Cookie`);
    console.log('');
  }
  if (state.schema !== undefined && state.schema !== 1) {
    console.log(`  ! 警告: state.schema=${JSON.stringify(state.schema)}，预期 1`);
    console.log('');
  }
  if (Array.isArray(state.devices)) {
    console.log(`  [state] devices=${state.devices.length}${state.devices.length ? `，最近 lastSeenAt=${Math.max(...state.devices.map((d) => Number(d.lastSeenAt) || 0))}` : ''}`);
    console.log('');
  }
}

function maskPairCode(code) {
  const s = String(code || '');
  return s.length <= 3 ? `${s.slice(0, 1)}***` : `${s.slice(0, 3)}***`;
}

// ---------------------------------------------------------------------------
// WebSocket upgrade 探测（net/tls 手写 HTTP/1.1）
// ---------------------------------------------------------------------------

function probeWebSocketUpgrade({ host, port, secure, requestPath, cookie, origin, timeoutMs }) {
  return new Promise((resolve) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expectedAccept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');

    const lines = [
      `GET ${requestPath} HTTP/1.1`,
      `Host: ${host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ];
    if (cookie) lines.push(`Cookie: ${cookie}`);
    if (origin) lines.push(`Origin: ${origin}`);
    const request = `${lines.join('\r\n')}\r\n\r\n`;

    let settled = false;
    let buffer = Buffer.alloc(0);
    let socket;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { socket && socket.destroy(); } catch { /* ignore */ }
      resolve({ path: requestPath, cookieSent: !!cookie, originSent: origin || null, expectedAccept, ...result });
    };

    try {
      socket = secure
        ? tls.connect({ host, port, servername: host, rejectUnauthorized: false })
        : net.connect({ host, port });
    } catch (err) {
      finish({ statusCode: null, error: describeError(err) });
      return;
    }

    timer = setTimeout(() => finish({
      statusCode: null,
      error: `timeout ${timeoutMs}ms`,
      rawHead: buffer.toString('latin1'),
    }), timeoutMs);

    socket.on(secure ? 'secureConnect' : 'connect', () => socket.write(request));

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const text = buffer.toString('latin1');
      const end = text.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > 65536) {
          finish({ statusCode: null, error: '响应头超过 64KB', rawHead: text.slice(0, 2000) });
        }
        return;
      }
      const head = text.slice(0, end);
      const statusLine = head.split('\r\n')[0] || '';
      const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(statusLine);
      const headers = {};
      for (const line of head.split('\r\n').slice(1)) {
        const idx = line.indexOf(':');
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      finish({
        statusCode: match ? Number(match[1]) : null,
        statusLine,
        headers,
        acceptValid: headers['sec-websocket-accept'] === expectedAccept,
        rawHead: head,
      });
    });

    socket.on('error', (err) => finish({
      statusCode: null,
      error: describeError(err),
      rawHead: buffer.toString('latin1'),
    }));

    socket.on('close', () => {
      if (!settled) {
        finish({ statusCode: null, error: '连接在响应头之前关闭', rawHead: buffer.toString('latin1') });
      }
    });
  });
}

function wsCandidatePaths() {
  const candidates = [];
  const push = (p) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  push(process.env.DSH_MOBILE_WS_PATH);
  push('/api/remote.mux');
  push('/api');
  return candidates;
}

// ---------------------------------------------------------------------------
// 静态检查
// ---------------------------------------------------------------------------

const ASSET_FILES = [
  'public/index.html',
  'public/app.js',
  'public/panel.js',
  'public/style.css',
  'public/qr.js',
];
const JS_ASSETS = ['public/app.js', 'public/panel.js', 'public/qr.js'];

function absProjectPath(relative) {
  return path.join(PROJECT_ROOT, relative);
}

async function statAsset(relative) {
  const abs = absProjectPath(relative);
  try {
    const st = await fs.stat(abs);
    return { abs, exists: true, isFile: st.isFile(), size: st.size };
  } catch {
    return { abs, exists: false, isFile: false, size: 0 };
  }
}

async function nodeCheck(relative) {
  const abs = absProjectPath(relative);
  try {
    const { stderr } = await execFileAsync(process.execPath, ['--check', abs], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    return { pass: true, stderr: stderr || '' };
  } catch (err) {
    const stderr = (err && (err.stderr || err.message)) || String(err);
    return { pass: false, stderr };
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('');
  console.log('══ dsh-mobile-access · 端到端验证 ══');
  console.log(`   Node ${process.version}   ${new Date().toISOString()}`);
  console.log(`   loopback: ${LOOPBACK_ORIGIN}`);
  console.log(`   项目根目录: ${PROJECT_ROOT}`);
  console.log('');

  // 步骤 0：state
  console.log('── 步骤 0：读取 loopback 状态 ──');
  state = await loadState();
  state.lanUrl = normalizeOrigin(state.lanUrl);
  state.loopbackOrigin = normalizeOrigin(state.loopbackOrigin);

  lanOrigin = normalizeOrigin(process.env.DSH_MOBILE_LAN_URL || state.lanUrl);
  if (!lanOrigin || !/^https?:\/\//i.test(lanOrigin)) {
    console.log(`  [STOP] state.lanUrl / DSH_MOBILE_LAN_URL 不是合法 http(s) origin: ${JSON.stringify(lanOrigin)}`);
    process.exit(2);
  }
  lanUrl = new URL(lanOrigin);
  if (!['http:', 'https:'].includes(lanUrl.protocol)) {
    console.log(`  [STOP] LAN origin 协议不支持: ${lanUrl.protocol}`);
    process.exit(2);
  }
  printStateSummary();

  // ── C1：无 cookie → 401 ────────────────────────────────────────────────
  console.log('── 1. 运行时验证（CONTRACT.md「验证口径」7 项）──');
  const noCookie = await check('C1', 'LAN 无 cookie GET / → 401（且不泄露配对信息）', async () => {
    const res = await httpRequest(`${lanOrigin}/`);
    if (!res.ok) return { pass: false, details: [`请求失败: ${res.error}`] };

    const leaked = [];
    if (/dshm_/.test(res.body)) leaked.push('body 含 cookie 名 dshm_');
    if (res.body.includes(state.pairCode)) leaked.push('body 含 pairCode');
    if (res.body.includes(state.loopbackOrigin)) leaked.push('body 含 loopbackOrigin');
    if (res.body.includes(lanOrigin)) leaked.push('body 含 LAN origin');

    const isHtml = /text\/html/i.test(headerValue(res.headers, 'content-type') || '');
    const details = [
      ...responseEvidence(res),
      `body[:160]=${quoted(res.body)}`,
      isHtml ? 'content-type 为 text/html（符合契约）' : '! content-type 不是 text/html（契约要求 401 text/html）',
      `泄露检查: ${leaked.length ? `! ${leaked.join('；')}` : '无 pairCode / dshm_ / loopback origin 泄露（符合契约）'}`,
    ];
    return { pass: res.status === 401 && leaked.length === 0, details };
  });

  // ── C2：?pair= → 302 + Set-Cookie ──────────────────────────────────────
  const pair = await check('C2', 'LAN GET /?pair=<pairCode> → 302 + Set-Cookie: dshm_*', async () => {
    let code = state.pairCode;
    let res = await httpRequest(`${lanOrigin}/?pair=${encodeURIComponent(code)}`);
    let rotated = false;

    // 配对码可能已过期：失败时通过 loopback 的 rotate 路由换一个新码重试一次。
    const firstStatus = res.ok ? res.status : null;
    if (!res.ok || (firstStatus !== 302) || !extractPairCookie(res.setCookies || [])) {
      const rotate = await httpRequest(`${state.loopbackOrigin}/__mobile/pair/rotate`, {
        method: 'POST',
        headers: { accept: 'application/json' },
      });
      if (rotate.ok && rotate.status === 200) {
        try {
          const rotatedState = JSON.parse(rotate.body);
          if (rotatedState && typeof rotatedState.pairCode === 'string' && rotatedState.pairCode) {
            code = rotatedState.pairCode;
            res = await httpRequest(`${lanOrigin}/?pair=${encodeURIComponent(code)}`);
            rotated = true;
          }
        } catch { /* rotate 响应不可解析，保留原结果 */ }
      }
    }

    const details = [
      rotated ? `配对码已过期，已通过 POST ${state.loopbackOrigin}/__mobile/pair/rotate 旋转后重试（新码 ${maskPairCode(code)}）` : `pairCode=${maskPairCode(code)}`,
      ...responseEvidence(res),
    ];
    if (!res.ok) return { pass: false, details };

    const setCookies = res.setCookies || [];
    const pairCookie = extractPairCookie(setCookies);
    const location = headerValue(res.headers, 'location') || '';
    const attrs = pairCookie ? cookieAttributes(pairCookie.raw) : '';
    const attrChecks = [
      [`HttpOnly=${/;\s*HttpOnly\b/i.test(pairCookie?.raw || '') ? 'yes' : 'no'}`],
      [`SameSite=${(/(?:;\s*SameSite=)([^;]+)/i.exec(pairCookie?.raw || '') || [, '<none>'])[1]}`],
      [`Path=${(/(?:;\s*Path=)([^;]+)/i.exec(pairCookie?.raw || '') || [, '<none>'])[1]}`],
      [`Max-Age=${(/(?:;\s*Max-Age=)([^;]+)/i.exec(pairCookie?.raw || '') || [, '<none>'])[1]}`],
    ].flat();

    if (pairCookie) {
      lanCookie = pairCookie.cookie;
      details.push(`cookie: ${maskCookie(pairCookie.cookie)}`);
      details.push(`cookie 属性: ${attrs}`);
      details.push(`契约属性检查: ${attrChecks.join(' ')}${/HttpOnly/i.test(attrs) ? '' : '  ! 缺 HttpOnly'}`);
      details.push(`location: ${location || '<none>'}${location.includes('pair=') ? '  ! location 仍含 pair 参数（契约要求去掉）' : ''}`);
    } else {
      details.push(`set-cookie 未包含 dshm_*: ${setCookies.length ? setCookies.map((c) => maskCookie(String(c).split(';')[0])).join(', ') : '<none>'}`);
    }

    const pass = res.status === 302 && !!pairCookie && !!location && !location.includes('pair=');
    return { pass, details };
  });

  const pairCookieOk = !!(pair && pair.pass);

  // ── C3：带 cookie GET / → 200 HTML + GUI 根节点 ─────────────────────────
  await check('C3', '带 cookie GET / → 200 text/html，含 GUI 根节点且不含 Unauthorized', async () => {
    if (!lanCookie) {
      return { pass: false, details: ['前置失败: C2 未拿到 dshm_* cookie，无法验证代理页面'] };
    }
    const res = await httpRequest(`${lanOrigin}/`, { headers: { cookie: lanCookie } });
    guiFetch = res;
    if (!res.ok) return { pass: false, details: [`请求失败: ${res.error}`] };
    guiBody = res.body;

    const contentType = headerValue(res.headers, 'content-type') || '';
    const rootPattern = new RegExp(`id\\s*=\\s*["']${escapeRegExp(ROOT_ID)}["']`);
    const hasRoot = rootPattern.test(res.body);
    const hasBoot = res.body.includes('__DSH_BOOT__');
    const hasUnauthorized = /unauthorized/i.test(res.body) || /authentication required/i.test(res.body);

    const details = [
      ...responseEvidence(res),
      `body 长度: ${res.body.length} 字节`,
      `GUI 根节点 id="${ROOT_ID}": ${hasRoot ? '命中' : '未命中'}${hasBoot ? '；命中 __DSH_BOOT__ 启动标记' : ''}`,
      `body[:200]=${quoted(res.body, 200)}`,
      hasUnauthorized ? '! body 含 Unauthorized / authentication required 文案' : 'body 不含 Unauthorized（符合契约）',
    ];
    const isHtml = /text\/html/i.test(contentType);
    return { pass: res.status === 200 && isHtml && (hasRoot || hasBoot) && !hasUnauthorized, details };
  });

  // ── C4：带 cookie GET /__mobile/state → 404 ────────────────────────────
  await check('C4', '带 cookie GET /__mobile/state（LAN 侧）→ 404', async () => {
    if (!lanCookie) {
      return { pass: false, details: ['前置失败: C2 未拿到 dshm_* cookie，无法验证 LAN 侧屏蔽'] };
    }
    const res = await httpRequest(`${lanOrigin}/__mobile/state`, { headers: { cookie: lanCookie } });
    if (!res.ok) return { pass: false, details: [`请求失败: ${res.error}`] };

    const jsonLooking = /application\/json/i.test(headerValue(res.headers, 'content-type') || '');
    const leakedPair = res.body.includes(state.pairCode);
    const details = [
      ...responseEvidence(res),
      `body[:160]=${quoted(res.body)}`,
      jsonLooking ? '! 响应是 JSON，可能泄露了桌面侧状态' : '响应不是 JSON',
      leakedPair ? '! body 含 pairCode' : 'body 不含 pairCode',
    ];
    return { pass: res.status === 404 && !jsonLooking && !leakedPair, details };
  });

  // ── C5：WebSocket upgrade → 101 ────────────────────────────────────────
  await check('C5', 'WebSocket upgrade（/api/remote.mux → /api）→ 101', async () => {
    if (!lanCookie) {
      return { pass: false, details: ['前置失败: C2 未拿到 dshm_* cookie，无法带凭据探测 upgrade'] };
    }
    const port = Number(lanUrl.port || (lanUrl.protocol === 'https:' ? 443 : 80));
    const secure = lanUrl.protocol === 'https:';
    const attempts = [];

    for (const requestPath of wsCandidatePaths()) {
      const probe = await probeWebSocketUpgrade({
        host: lanUrl.hostname,
        port,
        secure,
        requestPath,
        cookie: lanCookie,
        origin: lanOrigin,
        timeoutMs: WS_TIMEOUT_MS,
      });
      attempts.push(probe);
      if (probe.statusCode === 101) break;
    }

    const won = attempts.find((a) => a.statusCode === 101);
    const details = [`目标: ${secure ? 'wss' : 'ws'}://${lanUrl.host}${secure ? '' : ''}  Host: ${lanUrl.host}  Origin: ${lanOrigin}  cookie=${maskCookie(lanCookie)}`];
    for (const attempt of attempts) {
      if (attempt.statusCode) {
        details.push(`${attempt.path} → ${attempt.statusLine}${attempt.statusCode === 101 ? `  sec-websocket-accept=${attempt.acceptValid ? 'valid' : 'INVALID'}` : ''}`);
      } else {
        details.push(`${attempt.path} → 无响应（${attempt.error}）${attempt.rawHead ? ` raw=${quoted(String(attempt.rawHead).split('\r\n')[0], 120)}` : ''}`);
      }
    }
    if (won) {
      const headers = won.headers || {};
      if (headers['sec-websocket-protocol']) details.push(`sec-websocket-protocol: ${clip(headers['sec-websocket-protocol'], 120)}`);
      details.push('PASS 条件：任一候选路径状态行返回 101');
    } else {
      details.push('PASS 条件：任一候选路径状态行返回 101；以上为实际响应证据');
      if (attempts.some((a) => a.statusCode === 401 || a.statusCode === 403)) {
        details.push('! 服务端拒绝 upgrade（401/403）：请检查 cookie 是否被 upgrade 请求正确携带');
      }
    }
    return { pass: !!won, details };
  });

  // ── C6：origin 改写 + Origin 请求不被 403 ───────────────────────────────
  await check('C6', '响应体无未改写 loopback 绝对地址；带 Origin 的 POST 不被 403', async () => {
    const details = [];
    let bodyPass = false;
    let originPass = false;

    // 6a：复用 C3 的 body；若 C3 没拿到就重新请求一次。
    let body = guiBody;
    if (!body) {
      const res = await httpRequest(`${lanOrigin}/`, { headers: lanCookie ? { cookie: lanCookie } : {} });
      if (res.ok) body = res.body;
    }
    if (!body) {
      details.push('[6a] FAIL: 无 body 可检查（带 cookie GET / 未成功）');
    } else {
      const loopback = new URL(state.loopbackOrigin);
      const loopbackHost = loopback.hostname;
      const loopbackPort = loopback.port || (loopback.protocol === 'https:' ? '443' : '80');
      const absolutePattern = new RegExp(
        `(?:https?|wss?):\\/\\/(?:${escapeRegExp(loopbackHost)}|localhost|\\[::1\\]):${escapeRegExp(loopbackPort)}`,
        'gi',
      );
      const matches = [...body.matchAll(absolutePattern)];
      const literal = body.includes(state.loopbackOrigin);
      bodyPass = matches.length === 0 && !literal;
      details.push(`[6a] 检查 needle: ${absolutePattern.source}${literal ? ` 以及字面量 ${state.loopbackOrigin}` : ''}`);
      details.push(`[6a] 命中次数: ${matches.length}${literal ? '（含字面量 loopbackOrigin）' : ''}`);
      if (matches.length) {
        for (const m of matches.slice(0, 5)) {
          const start = Math.max(0, (m.index || 0) - 40);
          const end = Math.min(body.length, (m.index || 0) + m[0].length + 40);
          details.push(`[6a] 未改写地址: ${clip(body.slice(start, end), 140)}`);
        }
      }
      details.push(bodyPass
        ? '[6a] 未发现指向 loopback 的绝对 http(s)/ws(s) URL（origin 已改写或使用相对路径）'
        : '[6a] FAIL: 响应体残留 loopback 绝对地址，代理未做 origin 改写');
    }

    // 6b：携带 Origin: <LAN origin> 的 POST 不应被 403。
    if (!lanCookie) {
      details.push('[6b] FAIL: 无 cookie，无法验证 Origin 转发');
    } else {
      const res = await httpRequest(`${lanOrigin}/`, {
        method: 'POST',
        headers: {
          cookie: lanCookie,
          origin: lanOrigin,
          'content-type': 'text/plain; charset=utf-8',
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
        body: 'dsh-mobile-access-verify',
      });
      if (!res.ok) {
        details.push(`[6b] 请求失败: ${res.error}`);
      } else {
        originPass = res.status !== 403;
        details.push(`[6b] POST Origin=${lanOrigin} → status=${res.status} content-type=${headerValue(res.headers, 'content-type') || '<none>'} (${res.ms}ms)`);
        details.push(`[6b] body[:160]=${quoted(res.body)}`);
        details.push(originPass ? '[6b] 未被 403（符合预期）' : '[6b] FAIL: 被 403 拒绝，代理可能原样透传/校验了 Origin');
      }
    }

    return { pass: bodyPass && originPass, details };
  });

  // ── C7：篡改 cookie → 401 ───────────────────────────────────────────────
  await check('C7', '篡改 dshm_* cookie 后 GET / → 401', async () => {
    if (!lanCookie) {
      return { pass: false, details: ['前置失败: C2 未拿到 dshm_* cookie，无法验证篡改拒绝'] };
    }
    const tampered = tamperCookie(lanCookie);
    if (!tampered) return { pass: false, details: ['无法构造篡改后的 cookie'] };
    const res = await httpRequest(`${lanOrigin}/`, { headers: { cookie: tampered } });
    if (!res.ok) return { pass: false, details: [`请求失败: ${res.error}`] };
    const details = [
      `原始: ${maskCookie(lanCookie)}`,
      `篡改: ${maskCookie(tampered)}`,
      ...responseEvidence(res),
      `body[:160]=${quoted(res.body)}`,
    ];
    return { pass: res.status === 401, details };
  });

  // ── 静态检查 ───────────────────────────────────────────────────────────
  console.log('── 2. 静态检查（public/ 交付物 + node --check）──');
  for (const [index, relative] of ASSET_FILES.entries()) {
    await check(`A${index + 1}`, `${relative} 存在且非空`, async () => {
      const st = await statAsset(relative);
      if (!st.exists) {
        return { pass: false, details: [`文件不存在: ${st.abs}`] };
      }
      if (!st.isFile) {
        return { pass: false, details: [`不是普通文件: ${st.abs}`] };
      }
      return {
        pass: st.size > 0,
        details: [`path=${st.abs}`, `size=${st.size} 字节${st.size === 0 ? '  ! 空文件' : ''}`],
      };
    }, 'static');
  }

  for (const [index, relative] of JS_ASSETS.entries()) {
    await check(`J${index + 1}`, `node --check ${relative}`, async () => {
      const st = await statAsset(relative);
      if (!st.exists || st.size === 0) {
        return { pass: false, details: [`前置失败: ${relative} 不存在或为空`] };
      }
      const outcome = await nodeCheck(relative);
      const details = [`command: ${process.execPath} --check ${absProjectPath(relative)}`];
      if (!outcome.pass) details.push(`stderr: ${clip(outcome.stderr, 300)}`);
      else details.push('语法检查通过');
      return { pass: outcome.pass, details };
    }, 'static');
  }

  // ── 汇总 ───────────────────────────────────────────────────────────────
  console.log('══ 汇总 ══');
  const runtimeChecks = results.filter((r) => r.group === 'runtime');
  const staticChecks = results.filter((r) => r.group === 'static');
  printTable(runtimeChecks);
  printTable(staticChecks);

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const failed = total - passed;
  const exitCode = failed === 0 ? 0 : 1;
  console.log('');
  console.log(`  PASS ${passed} / FAIL ${failed} / 共 ${total} 项`);
  console.log(`  退出码 ${exitCode}（0=全通过，1=有失败，2=插件未安装/未激活）`);
  console.log('');

  if (JSON_OUT) {
    const payload = {
      ok: failed === 0,
      exitCode,
      generatedAt: new Date().toISOString(),
      node: process.version,
      state: {
        loopbackOrigin: state.loopbackOrigin,
        lanUrl: state.lanUrl,
        resolvedLanOrigin: lanOrigin,
        pairCode: state.pairCode,
        hostCookieReady: state.hostCookieReady,
        enabled: state.enabled,
        schema: state.schema,
        devices: Array.isArray(state.devices) ? state.devices.length : null,
      },
      checks: results.map((r) => ({
        id: r.id,
        title: r.title,
        pass: r.pass,
        details: r.details,
      })),
    };
    console.log(JSON.stringify(payload, null, 2));
  }

  process.exit(exitCode);
}

function printTable(rows) {
  if (!rows.length) return;
  const headers = ['编号', '结果', '检查项'];
  const widths = [4, 4, 0];
  const data = rows.map((r) => ({
    id: r.id,
    result: r.pass ? 'PASS' : 'FAIL',
    title: r.title,
    evidence: r.details.filter((d) => !d.startsWith('!')).slice(-1)[0] || '',
  }));
  widths[0] = Math.max(displayWidth(headers[0]), ...data.map((d) => displayWidth(d.id)));
  widths[1] = Math.max(displayWidth(headers[1]), ...data.map((d) => displayWidth(d.result)));
  widths[2] = Math.max(displayWidth(headers[2]), ...data.map((d) => displayWidth(d.title)));

  console.log(`  ${padDisplay(headers[0], widths[0])}  ${padDisplay(headers[1], widths[1])}  ${headers[2]}`);
  console.log(`  ${'-'.repeat(widths[0])}  ${'-'.repeat(widths[1])}  ${'-'.repeat(widths[2])}`);
  for (const d of data) {
    console.log(`  ${padDisplay(d.id, widths[0])}  ${padDisplay(d.result, widths[1])}  ${d.title}`);
  }
}

main().catch((err) => {
  console.error('');
  console.error('  [FATAL] 验证脚本异常退出:', err && err.stack ? err.stack : err);
  console.error('  退出码 1（脚本自身失败，非"未安装"状态）');
  process.exit(1);
});
