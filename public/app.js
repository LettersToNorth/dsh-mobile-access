/**
 * dsh-mobile-access — 桌面配对页逻辑（/__mobile/）。
 * 只依赖 /__mobile/state 与 /__mobile/pair/rotate 两个接口；不引入任何框架。
 */
(function () {
  'use strict'

  var $ = function (id) { return document.getElementById(id) }

  var el = {
    loading: $('dshm-loading'),
    errorCard: $('dshm-error-card'),
    errorText: $('dshm-error-text'),
    retry: $('dshm-retry'),
    warning: $('dshm-warning'),
    content: $('dshm-content'),
    qr: $('dshm-qr'),
    address: $('dshm-address'),
    copyAddress: $('dshm-copy-address'),
    code: $('dshm-code'),
    copyCode: $('dshm-copy-code'),
    pairUrl: $('dshm-pairurl'),
    copyPairUrl: $('dshm-copy-pairurl'),
    expiry: $('dshm-expiry'),
    rotate: $('dshm-rotate'),
    devicesCard: $('dshm-devices-card'),
    deviceCount: $('dshm-device-count'),
    deviceList: $('dshm-device-list'),
    devicesEmpty: $('dshm-devices-empty'),
    toast: $('dshm-toast'),
  }

  var state = null
  var toastTimer = null

  function showToast(text) {
    if (!el.toast) return
    el.toast.textContent = text
    el.toast.classList.add('dshm-toast--show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      el.toast.classList.remove('dshm-toast--show')
    }, 1800)
  }

  function copyText(text, label) {
    var done = function () { showToast((label || '内容') + '已复制') }
    var fail = function () {
      // 剪贴板不可用时退化为选中文本
      showToast('复制失败，请手动选择复制')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fail)
    } else {
      try {
        var input = document.createElement('textarea')
        input.value = text
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.appendChild(input)
        input.select()
        var ok = document.execCommand('copy')
        document.body.removeChild(input)
        if (ok) done()
        else fail()
      } catch (error) {
        fail()
      }
    }
  }

  function formatTime(ms) {
    var d = new Date(ms)
    var pad = function (n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  function relativeActive(ms) {
    if (!ms) return '从未连接'
    var diff = Date.now() - ms
    if (diff < 60 * 1000) return '刚刚活跃'
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前活跃'
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + ' 小时前活跃'
    return Math.floor(diff / 86400000) + ' 天前活跃'
  }

  function shortDevice(userAgent, id) {
    var ua = String(userAgent || '')
    var match = ua.match(/(iPhone|iPad|Android[^;)]*|Macintosh|Windows[^;)]*)/)
    var label = match ? match[1] : ''
    if (/iPhone|iPad/.test(ua)) label = 'iPhone / iPad'
    else if (/Android/.test(ua)) label = 'Android 手机'
    else if (/Mobile/.test(ua)) label = '移动设备'
    else if (label) label = '电脑浏览器'
    if (!label) label = '设备 ' + id
    return label
  }

  function renderDevices(devices) {
    el.deviceCount.textContent = String(devices.length)
    el.devicesCard.hidden = false
    el.deviceList.textContent = ''
    devices.forEach(function (device) {
      var li = document.createElement('li')
      var name = document.createElement('strong')
      name.textContent = shortDevice(device.userAgent, device.id)
      var meta = document.createElement('span')
      meta.textContent = '配对于 ' + formatTime(device.pairedAt) + ' · ' + relativeActive(device.lastSeenAt)
      li.appendChild(name)
      li.appendChild(meta)
      el.deviceList.appendChild(li)
    })
    el.devicesEmpty.hidden = devices.length > 0
  }

  function renderQr(pairUrl) {
    if (!window.dshmQR) return
    try {
      window.dshmQR.render(el.qr, pairUrl, { size: 220 })
    } catch (error) {
      el.qr.textContent = ''
      var hint = document.createElement('p')
      hint.className = 'dshm-hint'
      hint.textContent = '二维码生成失败，请使用下方配对链接。'
      el.qr.appendChild(hint)
    }
  }

  function render(next) {
    state = next
    if (!state) return

    if (!state.enabled) {
      el.loading.hidden = true
      el.content.hidden = true
      el.devicesCard.hidden = true
      el.errorCard.hidden = false
      el.errorText.textContent = state.error || '手机访问未启用。'
      return
    }

    el.errorCard.hidden = true
    el.loading.hidden = true
    el.content.hidden = false

    renderQr(state.pairUrl)
    el.address.textContent = state.lanUrl
    el.code.textContent = state.pairCode
    el.pairUrl.textContent = state.pairUrl
    renderDevices(state.devices || [])

    if (state.error) {
      el.warning.hidden = false
      el.warning.textContent = '警告：' + state.error
    } else {
      el.warning.hidden = true
    }
    tickExpiry()
  }

  function tickExpiry() {
    if (!state || !state.enabled || !state.pairExpiresAt) return
    var left = state.pairExpiresAt - Date.now()
    if (left <= 0) {
      el.expiry.textContent = '已过期，请刷新'
      return
    }
    var minutes = Math.floor(left / 60000)
    var seconds = Math.floor((left % 60000) / 1000)
    el.expiry.textContent = minutes + ':' + (seconds < 10 ? '0' : '') + seconds
  }

  async function load() {
    try {
      var response = await fetch('/__mobile/state', { cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      render(await response.json())
    } catch (error) {
      el.loading.hidden = true
      el.content.hidden = true
      el.errorCard.hidden = false
      el.errorText.textContent = '无法读取配对状态：' + (error && error.message ? error.message : error)
    }
  }

  el.retry.addEventListener('click', function () {
    el.errorCard.hidden = true
    el.loading.hidden = false
    load()
  })

  el.rotate.addEventListener('click', async function () {
    el.rotate.disabled = true
    try {
      var response = await fetch('/__mobile/pair/rotate', { method: 'POST', cache: 'no-store' })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      render(await response.json())
      showToast('配对码已刷新')
    } catch (error) {
      showToast('刷新失败：' + (error && error.message ? error.message : error))
    } finally {
      el.rotate.disabled = false
    }
  })

  el.copyAddress.addEventListener('click', function () {
    if (state && state.lanUrl) copyText(state.lanUrl, '地址')
  })
  el.copyCode.addEventListener('click', function () {
    if (state && state.pairCode) copyText(state.pairCode, '配对码')
  })
  el.copyPairUrl.addEventListener('click', function () {
    if (state && state.pairUrl) copyText(state.pairUrl, '配对链接')
  })

  setInterval(tickExpiry, 1000)
  setInterval(load, 15000)
  load()
})()
