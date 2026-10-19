# Changelog

## 0.1.1

- 修复：WebSocket 反向代理转发 101 响应时补写 RFC 6455 要求的 `Connection: Upgrade` 头，
  修复手机端 GUI「一直重新连接中」、会话/工作区列表加载不出来的问题
- 新增：向 Web GUI 注入 `color-scheme` 声明与底色兜底，消除移动端浏览器整页重绘时的闪白
- 新增：「设置」页新增「手机访问」区块（二维码、地址、配对码、设备列表、刷新配对码）
- 加固：配对码常数时间比较；设备数量上限 10
- 说明：受 Harness 模块加载器一致性校验限制，放弃"移动端按插件剔除"方案

## 0.1.0

首个公开发布版本。

- 局域网监听器 + 一次性配对码（6 位、30 分钟 TTL、可刷新、常数时间比较）
- 设备 cookie 门禁（HMAC-SHA256 签名，HttpOnly，30 天）
- HTTP + WebSocket 反向代理到 loopback Web GUI；Host/Origin/Referer 改写；
  桌面会话 Cookie 仅存于插件内存并注入转发请求，永不下发手机
- 响应体 loopback 绝对地址改写（HTML/JSON/JS/CSS/文本，4MB 上限，超限自动透传）
- 桌面 GUI 注入「📱 手机访问」悬浮按钮与配对浮层；`/__mobile/` 配对页
  （离线二维码，vendored Kazuhiko Arase qrcode-generator，MIT）
- 局域网侧屏蔽 `/__mobile/*`；设备清单上限 10 台，仅存内存，重启即失效
- 端到端验证脚本 `tests/verify.mjs`（15 项）
