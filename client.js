/**
 * dsh-mobile-access — Web GUI 客户端模块。
 *
 * 在「设置」页注册一个「手机访问」区块（settings.section slot），
 * 展示局域网地址、二维码、配对码、设备列表，并可刷新配对码。
 * 数据全部来自同源 /__mobile/state 与 /__mobile/pair/rotate。
 */
window.__ModuleLoader__.load({
  id: 'dsh-mobile-access',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef } = React
    const h = React.createElement

    function localeLabel(ctx) {
      try {
        const active = ctx.get('locale')?.getSnapshot?.().active
        return active === 'en' ? 'Phone Access' : '手机访问'
      } catch {
        return '手机访问'
      }
    }

    function useMobileState() {
      const [state, setState] = useState(null)
      const [error, setError] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const response = await fetch('/__mobile/state', { cache: 'no-store' })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const next = await response.json()
            if (alive) {
              setState(next)
              setError(null)
            }
          } catch (err) {
            if (alive) setError(String(err?.message ?? err))
          }
        }
        load()
        const timer = setInterval(load, 15000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])
      return { state, error, reload: () => setState((s) => ({ ...s, _bump: (s?._bump ?? 0) + 1 })) }
    }

    function QrBox({ text }) {
      const ref = useRef(null)
      useEffect(() => {
        if (!ref.current || !text) return
        let cancelled = false
        const render = () => {
          if (cancelled || !ref.current) return
          try {
            if (window.dshmQR) window.dshmQR.render(ref.current, text, { size: 200 })
          } catch {
            /* 渲染失败时保留空白，文本地址仍可复制 */
          }
        }
        if (window.dshmQR) {
          render()
        } else {
          const script = document.createElement('script')
          script.src = '/__mobile/assets/qr.js'
          script.onload = render
          document.head.appendChild(script)
        }
        return () => {
          cancelled = true
        }
      }, [text])
      return h('div', { ref, className: 'dshm-qr', style: { maxWidth: 220, margin: '12px auto' } })
    }

    function copyText(text) {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {})
      }
    }

    function Section() {
      const { state, error } = useMobileState()
      const [flash, setFlash] = useState('')
      if (error) {
        return h('p', { className: 'dshm-sub' }, `无法读取手机访问状态：${error}`)
      }
      if (!state) {
        return h('p', { className: 'dshm-sub' }, '正在读取手机访问状态…')
      }
      if (!state.enabled) {
        return h('p', { className: 'dshm-sub' }, state.error || '手机访问未启用。')
      }
      const rotate = async () => {
        try {
          const response = await fetch('/__mobile/pair/rotate', { method: 'POST', cache: 'no-store' })
          if (response.ok) window.dispatchEvent(new CustomEvent('dshm-state-refresh'))
        } catch {
          /* 下次轮询会更新 */
        }
      }
      const rows = [
        ['访问地址', state.lanUrl],
        ['配对码', state.pairCode],
        ['配对链接', state.pairUrl],
      ]
      const expires = state.pairExpiresAt
        ? `约 ${Math.max(0, Math.round((state.pairExpiresAt - Date.now()) / 60000))} 分钟后过期`
        : ''
      return h(
        'div',
        { className: 'dshm-page', style: { minHeight: 0, padding: 0, display: 'block', background: 'transparent' } },
        h('p', { className: 'dshm-sub' }, '手机与本机在同一 Wi-Fi 时，扫码即可打开桌面端的同一个 Web GUI：会话实时同步，可直接发送指令、审批与操作。'),
        h('div', { style: { display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' } },
          h('div', { style: { flex: '0 0 220px' } }, h(QrBox, { text: state.pairUrl })),
          h(
            'div',
            { style: { flex: 1, minWidth: 260 } },
            rows.map(([label, value]) =>
              h(
                'div',
                { key: label, style: { marginBottom: 12 } },
                h('div', { style: { fontSize: 12, opacity: 0.7, marginBottom: 4 } }, label),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h(
                    'code',
                    {
                      onClick: () => {
                        copyText(value)
                        setFlash(`${label}已复制`)
                        setTimeout(() => setFlash(''), 1500)
                      },
                      style: {
                        display: 'block', flex: 1, overflowWrap: 'anywhere', cursor: 'pointer',
                        background: 'rgba(127,127,127,0.12)', borderRadius: 8, padding: '8px 10px',
                        fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 13,
                      },
                      title: '点击复制',
                    },
                    value,
                  ),
                ),
              ),
            ),
            h('div', { style: { fontSize: 12, opacity: 0.7, margin: '4px 0 12px' } }, expires),
            h(
              'button',
              {
                onClick: rotate,
                style: {
                  border: '1px solid currentColor', background: 'transparent', color: 'inherit',
                  borderRadius: 8, padding: '8px 14px', cursor: 'pointer',
                },
              },
              '刷新配对码',
            ),
            flash ? h('span', { style: { marginLeft: 10, fontSize: 12, opacity: 0.8 } }, flash) : null,
            h(
              'p',
              { style: { fontSize: 12, opacity: 0.7, marginTop: 16, lineHeight: 1.6 } },
              `已配对设备：${state.devices.length} 台。配对信息只保存在本进程内存，Harness 重启后需重新扫码。桌面端登录凭据不会下发到手机。`,
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots ?? ctx.get('slots')
        if (!slots?.inject) return
        const label = localeLabel(ctx)
        slots.inject('settings.section', () =>
          slots.register({
            name: 'settings.section',
            id: 'mobile-access',
            order: 40,
            label,
          }, Section),
        )
      },
    }
  },
})
