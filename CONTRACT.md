# dsh-mobile-access — 内部契约（Lead 与 UI/验证并行工作的唯一事实源）

目标：桌面进程不动、不重启，仅在 Host 侧挂一个插件，让同一 Wi-Fi 下的手机浏览器打开
**同一个 Web GUI**（同一批会话、实时同步、可发指令/审批/操作）。手机与桌面共用同一个
Host 进程，因此"同步"是天然的，不需要复制/同步会话数据。

## 架构（一句话）

手机 → 插件自建的局域网监听器（配对 cookie 门禁） → 反向代理（HTTP + WebSocket）
→ 现有 loopback Web GUI（`http://127.0.0.1:<port>`），代理侧注入 Host 的已签名
浏览器 Cookie（由 `ctx.connection.authenticatedUrl()` 换取），并改写 Host/Origin。

## 端口与地址

- loopback GUI origin 运行时取 `ctx.webServer.getOrigin()`（本机当前为 `http://127.0.0.1:58216`，不要硬编码）。
- 局域网监听：默认自动选第一个非内部 IPv4（本机 `172.16.100.20`），端口默认 `58218`。
- 所有 loopback 路由挂前缀 `/__mobile`（不与现有路由冲突，已确认 404 现状）。

## Loopback 侧路由（桌面浏览器同源访问，已带 Host Cookie）

所有响应除 HTML 页面外均为 `application/json; charset=utf-8`。

### `GET /__mobile/state`

```json
{
  "schema": 1,
  "enabled": true,
  "error": null,
  "lanUrl": "http://172.16.100.20:58218",
  "pairUrl": "http://172.16.100.20:58218/?pair=7K2Q9F",
  "pairCode": "7K2Q9F",
  "pairExpiresAt": 1792390000000,
  "bind": { "host": "172.16.100.20", "port": 58218 },
  "devices": [
    { "id": "d-1a2b", "pairedAt": 1792380000000, "lastSeenAt": 1792389000000, "userAgent": "iPhone ..." }
  ],
  "loopbackOrigin": "http://127.0.0.1:58216",
  "hostCookieReady": true
}
```

- `enabled=false` 且 `error` 有文案时（例如端口占用、取不到 Host cookie），页面必须优雅降级：
  展示 `error`，隐藏二维码/配对码。
- `pairExpiresAt` 是毫秒时间戳；`pairCode` 是大写字母数字 6 位。
- `devices[].lastSeenAt` 可能为 `0` 表示从未连上。

### `POST /__mobile/pair/rotate`

旋转配对码，返回与 `GET /state` 相同结构。桌面页面按钮调用它。

### `GET /__mobile/assets/<file>`

静态资源，只允许 `public/` 下已存在的文件；UI 侧必须把页面依赖放在：
`index.html`、`app.js`、`panel.js`、`style.css`、`qr.js`。
所有引用一律用绝对路径 `/__mobile/assets/...`（页面与注入面板都会用到）。

### 注入面板（Host 侧通过 `webServer.tapIndex` 注入）

桌面 Web GUI 的 index.html 会被追加：

```html
<link rel="stylesheet" href="/__mobile/assets/style.css">
<script type="module" src="/__mobile/assets/panel.js"></script>
```

`panel.js` 必须自我约束：`location.protocol !== 'http:' && !== 'https:'` 或
`location.hostname` 不是 loopback（`127.0.0.1` / `::1` / `localhost`）时直接 return，
不在手机上渲染任何桌面专属 UI。

## 局域网侧（手机浏览器）

- `GET /?pair=<CODE>`：校验配对码 → `Set-Cookie: dshm_<port>=<token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=...`
  → `302` 到去掉 `pair` 参数的同一路径。
- 携带有效 `dshm_*` cookie 的任何请求：反向代理到 loopback GUI。
- 无/无效 cookie：`401 text/html`，只显示"请在桌面端打开 手机访问 面板完成配对"，不得泄露任何信息。
- `/__mobile/*` 在局域网侧一律 `404`（配对信息只给桌面）。
- 配对页与桌面面板都不需要处理局域网 URL 的拼装（Host 侧给现成字符串）。

## UI 交付清单（配对 UI 负责人）

`public/index.html` + `public/app.js` + `public/style.css` + `public/panel.js` + `public/qr.js`

1. 页面 `index.html`（桌面端 `http://127.0.0.1:58216/__mobile/` 打开）：
   - 标题「手机访问 DeepSeek Harness」，说明「手机与本机需在同一 Wi-Fi」；
   - 二维码：内容为 `state.pairUrl`（扫码即配对，手机自动登录）；
   - 明文地址 + 6 位配对码（等宽字体，可一键复制）+ 过期倒计时；
   - 「刷新配对码」按钮 → `POST /__mobile/pair/rotate`；
   - 已配对设备列表（时间格式化、最近活跃）；
   - `enabled=false` 时显示 `error`。
2. `panel.js`：桌面 GUI 右下角悬浮按钮（📱 手机访问），点开 iframe 或 fetch 渲染同内容；
   更简单可行的做法：点开后在浮层里 `fetch('/__mobile/state')` 渲染精简版信息（二维码 + 地址 + 码 + 刷新）。
   样式沿用 `style.css`（同一份，注意加命名空间前缀 `.dshm-` 避免污染宿主样式）。
3. **QR 必须离线可用**：可以 vendored 一个 MIT 许可的 QR 编码实现到 `public/qr.js`
   （保留版权头 + 在 `README`/文件头注明来源），也可以用自己实现的 Numeric/Byte 模式编码器；
   **不要**调用第三方在线 API（配对码不能外泄）。二维码用 SVG 或 canvas 输出，尺寸 ≥ 200px，
   加 4 个模块的静区。
4. 移动端可读性：`<meta name="viewport" content="width=device-width, initial-scale=1">`；
   面板与页面在 375px 宽下不溢出。
5. 所有文本中文（产品面向中文用户）；不引入框架、不打包、原生 JS，文件直接可跑。

## 验证口径（verifier 负责人）

用 `curl` 从本机以 LAN IP 访问即可模拟手机（本机可达 172.16.100.20）：

1. `GET http://<LAN>:58218/` 无 cookie → 401。
2. `GET http://<LAN>:58218/?pair=<state.pairCode>` → 302 + `Set-Cookie: dshm_...`。
3. 带 cookie `GET /` → 200，`content-type: text/html`，body 含 GUI 根节点（不是 401 文案）。
4. 带 cookie `GET /__mobile/state` → 404（局域网侧屏蔽）。
5. WebSocket upgrade：`/api/remote.mux`（实际 socket 路径以页面 boot payload 为准）→ 期望 `101`。
6. 转发请求不得把 `Host`/`Origin` 原样透传给 loopback；响应里不得出现指向 `127.0.0.1` 的绝对 URL（或已被改写为 LAN origin）。
7. 断开/篡改 cookie → 401。

验证脚本放 `tests/`，不依赖外部 npm 包，Node 24 原生 `fetch` + `http`/`net`。
