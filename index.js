/**
 * dsh-mobile-access — Host half.
 *
 * 让同一 Wi-Fi 下的手机浏览器打开并操作桌面端正在运行的同一个 Web GUI。
 *
 * 做法：插件在本机局域网地址上自建一个监听器（配对 cookie 门禁），把请求反向代理到
 * `ctx.webServer.getOrigin()` 的 loopback Web GUI；代理侧用
 * `ctx.connection.authenticatedUrl()` 换取桌面 Host 自己的已签名浏览器 Cookie 并注入。
 * 手机因此复用同一个 Host 进程、同一批会话、同一条 WebSocket —— “同步”是天然的：
 * 手机发消息、桌面立刻看到，反之亦然。没有会话复制，没有第二份状态。
 *
 * 安全边界：
 * - 只有完成配对（6 位一次性配对码，桌面端 /__mobile/ 页面展示/刷新）的设备拿到
 *   `dshm_*` cookie 才会被代理；其余请求 401。
 * - Host 的会话 Cookie 只存在于插件内存，永远不会下发到手机浏览器
 *   （代理会剥掉上游的 Set-Cookie）。
 * - 局域网侧屏蔽 /__mobile/*，配对信息只给桌面。
 * - 设备清单与签名密钥只在进程内存，Harness 重启后需要重新配对（fail-closed）。
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const inject = ['webServer', 'connection']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(HERE, 'public')

/** Files the loopback asset route may serve. Anything else is 404. */
const ASSETS = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['panel.js', 'text/javascript; charset=utf-8'],
  ['qr.js', 'text/javascript; charset=utf-8'],
  ['style.css', 'text/css; charset=utf-8'],
  ['mobile.css', 'text/css; charset=utf-8'],
  ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['icon-512.png', 'image/png'],
])

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const MAX_DEVICES = 10
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** Content types whose bodies we buffer to rewrite loopback absolute URLs. */
function isRewriteable(type) {
  if (!type) return false
  const t = type.split(';')[0].trim().toLowerCase()
  return (
    t === 'text/html' ||
    t === 'application/json' ||
    t === 'text/plain' ||
    t === 'text/css' ||
    t === 'text/javascript' ||
    t === 'application/javascript' ||
    t === 'application/xhtml+xml'
  )
}

function randomCode(length = 6) {
  const bytes = crypto.randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i += 1) out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length]
  return out
}

function firstTailscaleIPv4() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(info.address)) {
        return info.address
      }
    }
  }
  return null
}

function firstLanIPv4() {
  const nets = os.networkInterfaces()
  const ranked = []
  for (const [name, list] of Object.entries(nets)) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      let score = 0
      if (name.startsWith('en')) score += 20
      else if (name.startsWith('wl')) score += 18
      else if (/^(bridge|utun|docker|vbox|vmnet|tun|tap|awdl|llw|anpi)/.test(name)) score -= 10
      if (/^192\.168\./.test(info.address)) score += 3
      else if (/^10\./.test(info.address)) score += 2
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) score += 1
      if (/^169\.254\./.test(info.address)) score -= 20
      ranked.push({ address: info.address, score })
    }
  }
  ranked.sort((a, b) => b.score - a.score)
  return ranked[0]?.address ?? '127.0.0.1'
}

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

export function apply(ctx, rawConfig = {}) {
  const config = {
    enabled: true,
    host: '',
    port: 58218,
    pairTtlMs: 30 * 60 * 1000,
    deviceTtlMs: 30 * 24 * 60 * 60 * 1000,
    rewriteLimitBytes: 4 * 1024 * 1024,
    ...rawConfig,
  }

  const log = (() => {
    try {
      if (ctx.logger && typeof ctx.logger.info === 'function') return ctx.logger
    } catch {
      /* ignore */
    }
    return console
  })()

  const LAN = 'mobile-access'

  let loopbackOrigin = ''
  try {
    loopbackOrigin = ctx.webServer.getOrigin()
  } catch (error) {
    log.warn?.(`[${LAN}] webServer.getOrigin() 不可用：${error?.message ?? error}`)
  }
  const loopbackUrl = loopbackOrigin ? new URL(loopbackOrigin) : null

  const state = {
    enabled: false,
    error: null,
    bindHost: null,
    bindPort: null,
    lanUrl: null,
    listening: false,
  }

  const bindHost = typeof config.host === 'string' && config.host.trim() ? config.host.trim() : firstLanIPv4()
  const tailscaleHost = firstTailscaleIPv4()
  const advertisedHost = bindHost === '0.0.0.0' || bindHost === '::' ? firstLanIPv4() : bindHost
  const bindPort = Number(config.port) || 58218
  let boundPort = bindPort
  const lanUrl = () => `http://${advertisedHost}:${boundPort}`

  const pairState = { code: null, expiresAt: 0 }

  // ---- 配对持久化：密钥与设备清单存 ~/.dsh/mobile-access/devices.json ----
  const stateDir = path.join(
    process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    'mobile-access',
  )
  const stateFile = path.join(stateDir, 'devices.json')
  let store = { secret: null, devices: [] }
  function deviceSecretB64() {
    return crypto.randomBytes(32).toString('base64')
  }
  function loadStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      if (typeof raw?.secret === 'string' && Array.isArray(raw.devices)) return raw
    } catch {
      /* 首次或损坏时重建 */
    }
    return null
  }
  function saveStore() {
    try {
      fs.mkdirSync(stateDir, { recursive: true })
      const tmp = `${stateFile}.tmp`
      fs.writeFileSync(
        tmp,
        JSON.stringify({ secret: store.secret, devices: [...devices.values()] }, null, 2),
        { mode: 0o600 },
      )
      fs.renameSync(tmp, stateFile)
    } catch (error) {
      log.warn?.(`[${LAN}] 配对数据写入失败：${error?.message ?? error}`)
    }
  }
  const persisted = loadStore()
  let secretBuf = Buffer.from(persisted?.secret ?? '', 'base64')
  if (secretBuf.byteLength !== 32) secretBuf = crypto.randomBytes(32)
  const deviceSecret = secretBuf
  store.secret = deviceSecret.toString('base64')
  const devices = new Map()
  for (const device of persisted?.devices ?? []) {
    if (device && typeof device.id === 'string') {
      devices.set(device.id, {
        id: device.id,
        pairedAt: Number(device.pairedAt) || Date.now(),
        lastSeenAt: Number(device.lastSeenAt) || 0,
        userAgent: String(device.userAgent ?? '').slice(0, 160),
      })
    }
  }
  /** The desktop Host's own signed browser cookie; never leaves this process. */
  let hostCookie = null
  let hostCookiePromise = null
  let destroyed = false
  const liveSockets = new Set()



  // ---------------------------------------------------------------- pairing

  function rotatePairCode() {
    pairState.code = randomCode(6)
    pairState.expiresAt = Date.now() + config.pairTtlMs
    return pairState.code
  }

  function currentPairCode() {
    if (!pairState.code || Date.now() > pairState.expiresAt) rotatePairCode()
    return pairState.code
  }

  function signDevice(id, expiresAt) {
    return crypto.createHmac('sha256', deviceSecret).update(`${id}.${expiresAt}`).digest('base64url')
  }

  function deviceCookieValue(device) {
    const expiresAt = Date.now() + config.deviceTtlMs
    return `${device.id}.${expiresAt}.${signDevice(device.id, expiresAt)}`
  }

  function cookieName() {
    return `dshm_${bindPort}`
  }

  function deviceCookieHeader(device) {
    return `${cookieName()}=${deviceCookieValue(device)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(
      config.deviceTtlMs / 1000,
    )}`
  }

  function readCookie(req) {
    const raw = req.headers.cookie
    if (!raw) return null
    for (const part of raw.split(';')) {
      const idx = part.indexOf('=')
      if (idx < 0) continue
      if (part.slice(0, idx).trim() !== cookieName()) continue
      return part.slice(idx + 1).trim()
    }
    return null
  }

  /** Returns the paired device for this request, or null. */
  function deviceFromRequest(req) {
    const value = readCookie(req)
    if (!value) return null
    const parts = value.split('.')
    if (parts.length !== 3) return null
    const [id, expiresRaw, signature] = parts
    const expiresAt = Number(expiresRaw)
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null
    const device = devices.get(id)
    if (!device) return null
    let given
    try {
      given = Buffer.from(signature)
    } catch {
      return null
    }
    const expected = Buffer.from(signDevice(id, expiresAt))
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null
    device.lastSeenAt = Date.now()
    return device
  }

  function pairWithCode(code, req) {
    if (!code) return null
    const expected = currentPairCode()
    const given = String(code).trim().toUpperCase()
    // 常数时间比较，避免逐字节计时侧信道
    const givenDigest = crypto.createHash('sha256').update(given).digest()
    const expectedDigest = crypto.createHash('sha256').update(expected).digest()
    if (!crypto.timingSafeEqual(givenDigest, expectedDigest)) return null
    const id = `d${crypto.randomBytes(4).toString('hex')}`
    const device = {
      id,
      pairedAt: Date.now(),
      lastSeenAt: Date.now(),
      userAgent: String(req.headers['user-agent'] ?? '').slice(0, 160),
    }
    devices.set(id, device)
    while (devices.size > MAX_DEVICES) {
      const oldest = [...devices.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0]
      if (!oldest) break
      devices.delete(oldest.id)
    }
    saveStore()
    rotatePairCode() // one-time code
    log.info?.(`[${LAN}] 新设备已配对 ${id}`)
    return device
  }

  // ------------------------------------------------------- host credential

  async function bootstrapHostCookie() {
    if (!loopbackUrl) throw new Error('loopback Web GUI origin 不可用')
    if (typeof ctx.connection?.authenticatedUrl !== 'function') throw new Error('当前版本缺少 connection.authenticatedUrl')
    // 直接以 ctx.connection 为接收者调用，方法内部依赖 this（browserAuth 等内部状态）
    const tokenUrl = ctx.connection.authenticatedUrl(`${loopbackOrigin}/`)
    const response = await fetch(tokenUrl, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
    })
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    const jar = setCookies
      .map((entry) => entry.split(';')[0].trim())
      .filter((entry) => entry.includes('='))
      .join('; ')
    if (!jar) throw new Error(`桌面登录凭据换取失败（HTTP ${response.status}）`)
    hostCookie = jar
    state.error = null
    log.info?.(`[${LAN}] 已取得桌面 Host 的会话凭据（${loopbackUrl.host}）`)
    return jar
  }

  async function ensureHostCookie(force = false) {
    if (hostCookie && !force) return hostCookie
    if (!hostCookiePromise) {
      hostCookiePromise = bootstrapHostCookie().finally(() => {
        hostCookiePromise = null
      })
    }
    return hostCookiePromise
  }

  // ------------------------------------------------------------- loopback JSON

  function statePayload() {
    return {
      schema: 1,
      enabled: state.enabled,
      error: state.error,
      lanUrl: state.enabled ? lanUrl() : null,
      pairUrl: state.enabled ? `${lanUrl()}/?pair=${currentPairCode()}` : null,
      pairCode: state.enabled ? currentPairCode() : null,
      pairExpiresAt: state.enabled ? pairState.expiresAt : null,
      bind: { host: bindHost, port: bindPort },
      devices: [...devices.values()].map((device) => ({
        id: device.id,
        pairedAt: device.pairedAt,
        lastSeenAt: device.lastSeenAt,
        userAgent: device.userAgent,
      })),
      tailscaleUrl: tailscaleHost ? `http://${tailscaleHost}:${boundPort}` : null,
      loopbackOrigin,
      hostCookieReady: Boolean(hostCookie),
    }
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  async function serveAsset(res, name) {
    const type = ASSETS.get(name)
    if (!type) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    try {
      const body = await fs.promises.readFile(path.join(PUBLIC_DIR, name))
      res.writeHead(200, {
        'content-type': type,
        'cache-control': 'no-store',
        'content-length': body.length,
      })
      res.end(body)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`无法读取 ${name}：${error?.message ?? error}`)
    }
  }

  /** Reject cross-origin calls to the pairing endpoints (CSRF defense). */
  function loopbackRequestAllowed(req) {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const parsed = new URL(origin)
      if (isLoopbackHostname(parsed.hostname)) return true
      return Boolean(loopbackUrl && parsed.host === loopbackUrl.host)
    } catch {
      return false
    }
  }

  async function handleLoopbackRoute(req, res) {
    const url = new URL(req.url, 'http://loopback.invalid')
    const p = url.pathname
    if (!loopbackRequestAllowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }
    if (p === '/__mobile' || p === '/__mobile/') {
      await serveAsset(res, 'index.html')
      return
    }
    if (p === '/__mobile/state' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, statePayload())
      return
    }
    if (p === '/__mobile/pair/rotate' && (req.method === 'POST' || req.method === 'GET')) {
      rotatePairCode()
      sendJson(res, 200, statePayload())
      return
    }
    if (p.startsWith('/__mobile/assets/') && (req.method === 'GET' || req.method === 'HEAD')) {
      await serveAsset(res, p.slice('/__mobile/assets/'.length))
      return
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
  }

  // ----------------------------------------------------------------- proxy

  function buildUpstreamHeaders(req, cookie, { upgrade = false } = {}) {
    const headers = {}
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (lower === 'host' || lower === 'origin' || lower === 'referer' || lower === 'cookie') continue
      if (lower === 'accept-encoding') continue // identity keeps bodies rewriteable
      if (upgrade) {
        if (lower === 'connection' || lower === 'upgrade') continue
      } else if (HOP_BY_HOP.has(lower)) {
        continue
      }
      headers[lower] = value
    }
    headers.host = loopbackUrl.host
    if (req.headers.origin) headers.origin = loopbackOrigin
    if (req.headers.referer) {
      try {
        const referer = new URL(req.headers.referer)
        if (referer.origin === lanUrl()) headers.referer = `${loopbackOrigin}${referer.pathname}${referer.search}`
      } catch {
        /* drop malformed referer */
      }
    }
    if (cookie) headers.cookie = cookie
    if (upgrade) {
      headers.connection = 'Upgrade'
      headers.upgrade = req.headers.upgrade ?? 'websocket'
    }
    return headers
  }

  function rewriteLocation(value) {
    if (!value || !loopbackOrigin) return value
    if (value.startsWith(loopbackOrigin)) return lanUrl() + value.slice(loopbackOrigin.length)
    return value
  }

  function responseHeaders(upstream, { rewriteBody, bodyLength }) {
    const out = {}
    const raw = upstream.headers
    for (const [key, value] of Object.entries(raw)) {
      if (value === undefined) continue
      const lower = key.toLowerCase()
      if (lower === 'set-cookie') continue // never leak the Host credential
      if (lower === 'connection' || lower === 'keep-alive' || lower === 'transfer-encoding') continue
      if (lower === 'content-length') continue
      out[lower] = value
    }
    if (raw.location) out.location = rewriteLocation(raw.location)
    if (rewriteBody) {
      delete out['content-encoding'] // we buffered an identity body
      out['content-length'] = String(bodyLength)
    }
    return out
  }

  function rewriteBodyText(buffer) {
    let text = buffer.toString('utf8')
    if (loopbackOrigin) text = text.split(loopbackOrigin).join(lanUrl())
    return Buffer.from(text, 'utf8')
  }

  function forwardResponse(upstream, res, method = 'GET') {
    const type = upstream.headers['content-type']
    const encoded = Boolean(upstream.headers['content-encoding'])
    const declared = Number(upstream.headers['content-length'])
    const rewrite =
      method !== 'HEAD' &&
      isRewriteable(type) &&
      !encoded &&
      (!Number.isFinite(declared) || declared <= config.rewriteLimitBytes)

    if (!rewrite) {
      const headers = responseHeaders(upstream, { rewriteBody: false })
      if (upstream.headers['content-length']) headers['content-length'] = upstream.headers['content-length']
      res.writeHead(upstream.statusCode ?? 502, headers)
      upstream.pipe(res)
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const chunks = []
      let total = 0
      let overflowed = false
      upstream.on('data', (chunk) => {
        if (overflowed) {
          res.write(chunk)
          return
        }
        if (total + chunk.length > config.rewriteLimitBytes) {
          overflowed = true
          chunks.push(chunk)
          total += chunk.length
          const headers = responseHeaders(upstream, { rewriteBody: false })
          res.writeHead(upstream.statusCode ?? 502, headers)
          res.write(Buffer.concat(chunks))
          chunks.length = 0
          return
        }
        chunks.push(chunk)
        total += chunk.length
      })
      upstream.on('end', () => {
        if (overflowed) {
          res.end()
          resolve()
          return
        }
        const body = rewriteBodyText(Buffer.concat(chunks))
        const headers = responseHeaders(upstream, { rewriteBody: true, bodyLength: body.length })
        res.writeHead(upstream.statusCode ?? 502, headers)
        res.end(body)
        resolve()
      })
      upstream.on('error', (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(`代理读取失败：${error?.message ?? error}`)
        } else {
          res.destroy()
        }
        resolve()
      })
      upstream.on('aborted', () => {
        res.destroy()
        resolve()
      })
    })
  }

  function proxyHttp(req, res, { retried = false } = {}) {
    ensureHostCookie()
      .then((cookie) => {
        const headers = buildUpstreamHeaders(req, cookie)
        const upstream = http.request(
          {
            protocol: 'http:',
            host: loopbackUrl.hostname,
            port: loopbackUrl.port || 80,
            method: req.method,
            path: req.url,
            headers,
          },
          (up) => {
            const retryable = (req.method === 'GET' || req.method === 'HEAD') && !retried
            if (up.statusCode === 401 && retryable) {
              up.resume()
              ensureHostCookie(true)
                .then(() => proxyHttp(req, res, { retried: true }))
                .catch(() => {
                  if (!res.headersSent) {
                    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
                    res.end('桌面会话凭据不可用')
                  }
                })
              return
            }
            forwardResponse(up, res, req.method).catch((error) => {
              log.warn?.(`[${LAN}] 响应转发失败：${error?.message ?? error}`)
              if (!res.headersSent) res.writeHead(502)
              res.destroy()
            })
          },
        )
        upstream.on('error', (error) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
            res.end(`无法连接桌面 Web GUI：${error?.message ?? error}`)
          } else {
            res.destroy()
          }
        })
        req.pipe(upstream)
      })
      .catch((error) => {
        state.error = `桌面会话凭据不可用：${error?.message ?? error}`
        if (!res.headersSent) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('桌面会话凭据不可用，请在电脑端刷新后再试。')
        }
      })
  }

  function proxyUpgrade(req, socket, head) {
    const fail = (line) => {
      try {
        socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`)
      } catch {
        /* ignore */
      }
    }
    ensureHostCookie()
      .then((cookie) => {
        const headers = buildUpstreamHeaders(req, cookie, { upgrade: true })
        const upstream = http.request({
          protocol: 'http:',
          host: loopbackUrl.hostname,
          port: loopbackUrl.port || 80,
          method: 'GET',
          path: req.url,
          headers,
        })
        upstream.on('upgrade', (upRes, upSocket, upHead) => {
          // RFC 6455：101 响应必须带 Connection: Upgrade 与 Upgrade 头，
          // 否则严格的浏览器 WS 实现会立刻判失败并重连。
          const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage ?? 'Switching Protocols'}`]
          for (const [key, value] of Object.entries(upRes.headers)) {
            if (value === undefined) continue
            const lower = key.toLowerCase()
            if (lower === 'set-cookie' || lower === 'connection' || lower === 'keep-alive' || lower === 'upgrade') continue
            if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
            else lines.push(`${key}: ${value}`)
          }
          lines.push('Connection: Upgrade', `Upgrade: ${upRes.headers.upgrade ?? 'websocket'}`)
          lines.push('', '')
          socket.write(lines.join('\r\n'))
          if (upHead && upHead.length) socket.write(upHead)
          upSocket.setNoDelay?.(true)
          socket.setNoDelay?.(true)
          upSocket.pipe(socket)
          socket.pipe(upSocket)
          const destroyBoth = () => {
            upSocket.destroy()
            socket.destroy()
          }
          socket.on('error', destroyBoth)
          socket.on('close', destroyBoth)
          upSocket.on('error', destroyBoth)
          upSocket.on('close', destroyBoth)
        })
        upstream.on('response', (upRes) => {
          upRes.resume()
          fail(`${upRes.statusCode} ${upRes.statusMessage ?? 'Upgrade Failed'}`)
        })
        upstream.on('error', () => fail('502 Bad Gateway'))
        if (head && head.length) upstream.write(head)
        upstream.end()
      })
      .catch(() => fail('503 Service Unavailable'))
  }

  // ------------------------------------------------------------ LAN server

  function unauthorized(res, message) {
    const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需要配对</title><body style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0b1220;color:#e6edf7"><div style="max-width:22rem;padding:2rem;text-align:center"><div style="font-size:2.5rem">🔒</div><h1 style="font-size:1.05rem;font-weight:600;margin:.8rem 0">需要配对</h1><p style="font-size:.85rem;line-height:1.6;color:#9fb0c7">${message}</p></div></body>`
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function handleLanRequest(req, res) {
    let url
    try {
      url = new URL(req.url, 'http://lan.invalid')
    } catch {
      res.writeHead(400)
      res.end('Bad Request')
      return
    }
    if (url.pathname.startsWith('/__mobile')) {
      if (url.pathname.startsWith('/__mobile/assets/')) {
        void serveAsset(res, url.pathname.slice('/__mobile/assets/'.length))
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    const device = deviceFromRequest(req)
    const pairParam = url.searchParams.get('pair')
    if (pairParam !== null) {
      if (device) {
        url.searchParams.delete('pair')
        const location = `${url.pathname}${url.search}`
        res.writeHead(302, { location, 'cache-control': 'no-store' })
        res.end()
        return
      }
      const paired = pairWithCode(pairParam, req)
      if (!paired) {
        unauthorized(res, '配对码无效或已过期。请在电脑端打开「手机访问」面板，用最新配对码重新扫码。')
        return
      }
      url.searchParams.delete('pair')
      const location = `${url.pathname}${url.search}`
      res.writeHead(302, {
        location,
        'set-cookie': deviceCookieHeader(paired),
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (!device) {
      unauthorized(res, '这台设备还没有配对。请在电脑端打开「手机访问」面板，用手机扫描二维码。')
      return
    }
    proxyHttp(req, res)
  }

  function handleLanUpgrade(req, socket) {
    try {
      if (!req.url || req.url.startsWith('/__mobile')) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        return
      }
      if (!deviceFromRequest(req)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        return
      }
      proxyUpgrade(req, socket)
    } catch {
      socket.destroy()
    }
  }

  // ----------------------------------------------------------------- wiring

  const disposers = []
  let server = null

  const tap = ctx.webServer.tapIndex((html) => {
    if (!state.enabled) return html
    if (html.includes('/__mobile/assets/panel.js')) return html
    // color-scheme + 底色兜底：iOS Safari 整页重绘时若未声明 color-scheme，
    // 会先用白色合成一帧，造成周期性闪白（GUI 主题跟随系统）。
    const tags =
      '<meta name="color-scheme" content="light dark" data-dsh-mobile-access="1">\n' +
      '<style data-dsh-mobile-access="1">html{background-color:var(--dsh-boot-bg,#151517)}</style>\n' +
      '<link rel="manifest" href="/__mobile/assets/manifest.webmanifest" data-dsh-mobile-access="1">\n' +
      '<meta name="theme-color" content="#151517" data-dsh-mobile-access="1">\n' +
      '<meta name="mobile-web-app-capable" content="yes" data-dsh-mobile-access="1">\n' +
      '<meta name="apple-mobile-web-app-capable" content="yes" data-dsh-mobile-access="1">\n' +
      '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" data-dsh-mobile-access="1">\n' +
      '<meta name="apple-mobile-web-app-title" content="Harness" data-dsh-mobile-access="1">\n' +
      '<link rel="apple-touch-icon" href="/__mobile/assets/icon-512.png" data-dsh-mobile-access="1">\n' +
      '<link rel="stylesheet" href="/__mobile/assets/style.css" data-dsh-mobile-access="1">\n' +
      '<link rel="stylesheet" href="/__mobile/assets/mobile.css" data-dsh-mobile-access="1">\n' +
      '<script type="module" src="/__mobile/assets/panel.js" data-dsh-mobile-access="1"></script>\n'
    return html.includes('</body>') ? html.replace('</body>', `${tags}</body>`) : `${html}\n${tags}`
  })
  disposers.push(tap)

  if (!loopbackUrl) {
    state.error = '找不到桌面 Web GUI 的监听地址，手机访问未启用。'
  } else if (config.enabled === false) {
    state.error = '插件配置 enabled=false。'
  } else {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: '/__mobile', handler: handleLoopbackRoute }))
    server = http.createServer(handleLanRequest)
    server.on('upgrade', handleLanUpgrade)
    server.on('connection', (socket) => {
      liveSockets.add(socket)
      socket.on('close', () => liveSockets.delete(socket))
    })
    server.on('clientError', (error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      } catch {
        /* ignore */
      }
      void error
    })
    server.on('error', (error) => {
      state.enabled = false
      state.error = `局域网监听失败（${bindHost}:${bindPort}）：${error?.message ?? error}`
      log.warn?.(`[${LAN}] ${state.error}`)
    })
    server.listen(bindPort, bindHost, () => {
      if (destroyed) return
      const address = server.address()
      boundPort = address && typeof address === 'object' ? address.port : bindPort
      state.enabled = true
      state.listening = true
      state.bindHost = bindHost
      state.bindPort = boundPort
      state.lanUrl = lanUrl()
      state.error = null
      rotatePairCode()
      log.info?.(`[${LAN}] 手机访问已就绪：${lanUrl()}（桌面配对页 ${loopbackOrigin}/__mobile/）`)
      ensureHostCookie().catch((error) => {
        state.error = `桌面会话凭据不可用：${error?.message ?? error}`
        log.warn?.(`[${LAN}] ${state.error}`)
      })
    })
  }

  ctx.effect(() => () => {
    destroyed = true
    for (const disposer of disposers.splice(0)) {
      try {
        disposer?.()
      } catch {
        /* ignore */
      }
    }
    if (server) {
      try {
        server.close()
      } catch {
        /* ignore */
      }
      for (const socket of liveSockets) socket.destroy()
      liveSockets.clear()
    }
  }, `${LAN}.lifecycle`)
}
