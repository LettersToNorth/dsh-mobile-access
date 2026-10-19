# dsh-mobile-access（手机访问）

一个 DeepSeek Harness 插件：让**同一 Wi-Fi 下的手机浏览器**打开桌面端正在使用的**同一个 Web GUI**。
会话不是"同步"出来的——手机与桌面共用同一个 Host 进程、同一批会话、同一条 WebSocket，
手机发消息、审批、操作，桌面立刻可见，反之亦然。

## 使用

English | [README.en.md](README.en.md)

### 安装

```sh
# 从 GitHub 安装（发布后）
dsh plugin --profile <你的profile> add github:<你的用户名>/dsh-mobile-access
# 或本地目录
dsh plugin --profile <你的profile> add /path/to/dsh-mobile-access
```

配置项（见 `cordis.patch.yml`）：`enabled`（默认 true）、`host`（留空自动选局域网 IPv4）、`port`（默认 58218）。

1. 桌面浏览器打开 Web GUI，右下角会出现 **📱 手机访问** 悬浮按钮（或直接访问 `http://127.0.0.1:<端口>/__mobile/`）。
2. 面板显示局域网地址 + 二维码 + 6 位一次性配对码（30 分钟过期，可刷新）。
3. 手机相机扫码 → 自动配对并打开完整 Web GUI；或手动打开面板上的配对链接。
4. 已配对设备 30 天内免扫码；在面板可查看设备列表。

## 架构

```
手机浏览器 ──HTTP/WS──▶ 插件局域网监听器（:58218，dshm_* 设备 cookie 门禁）
                              │ 反向代理：Host/Origin 改写为 loopback、注入桌面会话 Cookie、
                              │ 响应体中的 loopback 绝对地址改写为局域网地址
                              ▼
                     现有 loopback Web GUI（ctx.webServer.getOrigin()）
```

- 桌面会话凭据由 `ctx.connection.authenticatedUrl()` 换取，**只存在于插件内存**，
  代理剥除上游所有 `Set-Cookie`，永不下发到手机。
- 配对码一次性；设备签名密钥只在进程内存（HMAC-SHA256）。
- 局域网侧屏蔽 `/__mobile/*`（配对信息只给桌面）；未配对请求只返回固定 401 页。

## 文件

- `index.js` — Host 插件：局域网监听、配对、凭据引导、HTTP/WS 反向代理、index 注入
- `public/index.html` `/app.js` `/style.css` — 桌面配对页
- `public/panel.js` — 注入 Web GUI 的悬浮按钮与浮层（loopback 之外自动不渲染）
- `public/qr.js` — 离线二维码（vendored：Kazuhiko Arase qrcode-generator，MIT）
- `tests/verify.mjs` — 端到端验证（`node tests/verify.mjs`，退出码 0=全过）
- `CONTRACT.md` — 接口与安全设计事实源

## 已知限制

- 仅限同一局域网；跨网需自建隧道（如 Tailscale）后把 `host` 配置指向隧道地址。
- 明文 HTTP（与桌面 GUI 本身的 loopback 一致），不要在不可信网络使用。
- Harness 进程重启后设备清单清空，需要重新扫码配对。
- 手机上的桌面 GUI 布局未做移动端优化（功能完整，排版以桌面为准）。
- macOS 首次入站连接可能弹防火墙授权，请允许。
