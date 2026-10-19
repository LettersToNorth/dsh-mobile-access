/**
 * dsh-mobile-access — Web GUI 注入浮层（Host 侧通过 tapIndex 注入本模块）。
 *
 * 仅在桌面本机（loopback）的 http(s) 页面上渲染悬浮按钮；手机端或其他来源静默退出，
 * 不向宿主页面泄漏任何全局命名空间。
 */
(function () {
  'use strict'

  var host = (typeof location !== 'undefined' && location.hostname) || ''
  var protocol = (typeof location !== 'undefined' && location.protocol) || ''
  var isHttp = protocol === 'http:' || protocol === 'https:'
  var isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
  if (!isHttp || !isLoopback) return

  var fab = null
  var overlay = null
  var overlayTimer = null
  var state = null

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text != null) node.textContent = text
    return node
  }

  function field(labelText, valueText, copyValue, big) {
    var field = el('div', 'dshm-field')
    var label = el('span', 'dshm-field__label', labelText)
    var code = el('code', 'dshm-mono ' + (big ? 'dshm-code' : 'dshm-field__value'), valueText)
    var button = el('button', 'dshm-btn dshm-btn--small', '复制')
    button.type = 'button'
    button.addEventListener('click', function () {
      copyText(copyValue, labelText)
    })
    field.appendChild(label)
    field.appendChild(code)
    field.appendChild(button)
    return { root: field, code: code }
  }

  function copyText(text, label) {
    var done = function () { flash('已复制' + (label || '')) }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { flash('复制失败') })
    } else {
      flash('复制失败')
    }
  }

  function flash(text) {
    var tip = el('div', 'dshm-toast dshm-toast--show', text)
    tip.style.position = 'fixed'
    tip.style.left = '50%'
    tip.style.bottom = '130px'
    tip.style.transform = 'translateX(-50%)'
    tip.style.zIndex = '2147483400'
    document.body.appendChild(tip)
    setTimeout(function () { tip.remove() }, 1500)
  }

  function tickExpiry() {
    if (!state || !overlay || !state.pairExpiresAt) return
    var left = state.pairExpiresAt - Date.now()
    var node = overlay.querySelector('[data-dshm-expiry]')
    if (!node) return
    if (left <= 0) {
      node.textContent = '已过期，请刷新'
      return
    }
    var minutes = Math.floor(left / 60000)
    var seconds = Math.floor((left % 60000) / 1000)
    node.textContent = minutes + ':' + (seconds < 10 ? '0' : '') + seconds + ' 后过期'
  }

  function render(stateNext) {
    state = stateNext
    if (!overlay) return
    var body = overlay.querySelector('[data-dshm-body]')
    body.textContent = ''

    if (!state || !state.enabled) {
      body.appendChild(el('p', 'dshm-overlay__sub', state && state.error ? state.error : '手机访问未启用。'))
      return
    }

    var qr = el('div', 'dshm-overlay__qr')
    qr.setAttribute('aria-label', '配对二维码')
    if (window.dshmQR) {
      try {
        window.dshmQR.render(qr, state.pairUrl, { size: 160 })
      } catch (error) {
        qr.textContent = ''
      }
    }
    body.appendChild(qr)

    body.appendChild(el('p', 'dshm-overlay__sub', '手机与本机在同一 Wi-Fi 时，扫码即可打开同一个 Web GUI。'))

    var address = field('访问地址', state.lanUrl, state.lanUrl)
    body.appendChild(address.root)
    var code = field('配对码', state.pairCode, state.pairCode, true)
    body.appendChild(code.root)

    var expiry = el('span', 'dshm-overlay__expiry', '')
    expiry.setAttribute('data-dshm-expiry', '1')
    expiry.style.cssText = 'display:block;color:#5b6b85;font-size:0.76rem;margin-bottom:8px'
    body.appendChild(expiry)

    var rotate = el('button', 'dshm-btn dshm-btn--primary', '刷新配对码')
    rotate.type = 'button'
    rotate.addEventListener('click', async function () {
      rotate.disabled = true
      try {
        var response = await fetch('/__mobile/pair/rotate', { method: 'POST', cache: 'no-store' })
        if (response.ok) render(await response.json())
      } catch (error) {
        /* 忽略，下次打开重试 */
      } finally {
        rotate.disabled = false
      }
    })
    body.appendChild(rotate)

    var devices = state.devices || []
    body.appendChild(el('p', 'dshm-overlay__devices',
      devices.length ? '已配对设备：' + devices.length + ' 台' : '还没有设备完成配对。'))
    tickExpiry()
  }

  async function refresh() {
    try {
      var response = await fetch('/__mobile/state', { cache: 'no-store' })
      if (!response.ok) return null
      var next = await response.json()
      if (overlay && !overlay.hidden) render(next)
      return next
    } catch (error) {
      return null
    }
  }

  function close() {
    if (overlay) {
      overlay.remove()
      overlay = null
    }
    clearInterval(overlayTimer)
    document.removeEventListener('keydown', onKey)
  }

  function onKey(event) {
    if (event.key === 'Escape') close()
  }

  function open() {
    if (overlay) {
      close()
      return
    }
    overlay = el('div', 'dshm-overlay')
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-label', '手机访问')

    var head = el('h3', null, '📱 手机访问')
    var closeBtn = el('button', 'dshm-overlay__close', '✕')
    closeBtn.type = 'button'
    closeBtn.setAttribute('aria-label', '关闭')
    closeBtn.addEventListener('click', close)
    head.appendChild(closeBtn)
    overlay.appendChild(head)

    var body = el('div')
    body.setAttribute('data-dshm-body', '1')
    body.appendChild(el('p', 'dshm-overlay__sub', '正在读取配对信息…'))
    overlay.appendChild(body)

    document.body.appendChild(overlay)
    document.addEventListener('keydown', onKey)
    refresh()
    overlayTimer = setInterval(function () {
      if (overlay) refresh()
    }, 15000)
  }

  function mount() {
    fab = el('button', 'dshm-fab', '📱')
    fab.type = 'button'
    fab.title = '手机访问'
    fab.setAttribute('aria-label', '手机访问')
    fab.addEventListener('click', open)
    document.body.appendChild(fab)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
})()
