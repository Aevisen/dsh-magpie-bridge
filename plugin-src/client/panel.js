/**
 * magpie 面板组件：iframe 嵌入原版 Web UI，外加输入框旁的小窗按钮。
 * @module dsh-magpie-bridge/client/panel
 */
import * as React from 'react'

import { MagpieStyles } from './styles.js'

const h = React.createElement

/**
 * 中央面板 / 设置页共用：loading → 就绪 iframe；失败显示消息 + 重试。
 *
 * `rpcCall` 必须引用稳定（由调用方在 apply 里只建一次），否则 effect 会
 * 无限重跑。
 */
export function MagpiePanel({ rpcCall }) {
  const [state, setState] = React.useState({ kind: 'loading' })
  const [reloadToken, setReloadToken] = React.useState(0)

  React.useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    rpcCall('web.url')
      .then((value) => {
        if (!cancelled) setState({ kind: 'ready', url: value.url })
      })
      .catch((error) => {
        if (!cancelled) {
          setState({ kind: 'error', message: String((error && error.message) || error) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [rpcCall, reloadToken])

  if (state.kind === 'error') {
    return h('div', { className: 'dshm-magpie dshm-magpie--message' }, [
      h(MagpieStyles, { key: 'style' }),
      h('p', { className: 'dshm-magpie__title', key: 'title' }, 'magpie 面板连不上'),
      h('p', { className: 'dshm-magpie__detail', key: 'detail' }, state.message),
      h(
        'button',
        {
          className: 'dshm-magpie__button',
          key: 'retry',
          onClick: () => setReloadToken((token) => token + 1),
        },
        '重试',
      ),
    ])
  }

  if (state.kind === 'ready') {
    return h('div', { className: 'dshm-magpie' }, [
      h(MagpieStyles, { key: 'style' }),
      // 不设 sandbox：原版页面要用 localStorage 记住界面状态。
      h('iframe', {
        key: 'frame',
        className: 'dshm-magpie__frame',
        src: state.url,
        title: 'magpie',
      }),
    ])
  }

  return h('div', { className: 'dshm-magpie dshm-magpie--message' }, [
    h(MagpieStyles, { key: 'style' }),
    h('p', { className: 'dshm-magpie__title', key: 'title' }, '正在连接 magpie…'),
  ])
}

/** 侧栏入口的小图标。 */
export function MagpieSidebarIcon() {
  return h(
    'span',
    { className: 'dshm-magpie__icon', 'aria-hidden': 'true' },
    h(
      'svg',
      { viewBox: '0 0 24 24', width: 18, height: 18 },
      h('path', {
        d: 'M4 18c6-1 9-4 11-9l3-4-4 1c-2-2-6-2-8 0S5 12 4 18z',
        fill: 'currentColor',
      }),
    ),
  )
}

/**
 * 输入框旁的小窗按钮：点开 440×520 浮层，加载 `?mode=panel` 紧凑界面。
 *
 * 接收 iframe 里注入脚本转发的桌面按钮消息：
 * - `quit` → 关浮层
 * - `main` → 切完整页面
 * - `settings` → 切完整页面并打开设置（通过 postMessage 让注入脚本点 #prefs）
 */
export function MagpieDockButton({ rpcCall }) {
  const [open, setOpen] = React.useState(false)
  const [urls, setUrls] = React.useState(null)
  const [full, setFull] = React.useState(false)
  const frameRef = React.useRef(null)
  const pendingShow = React.useRef(null)

  React.useEffect(() => {
    if (!open) return undefined
    const onMessage = (event) => {
      const data = event.data
      if (!data || data.source !== 'dsh-magpie') return
      if (data.kind === 'quit') {
        setOpen(false)
        return
      }
      if (data.kind === 'main') {
        setFull(true)
        return
      }
      if (data.kind === 'settings') {
        pendingShow.current = 'settings'
        setFull(true)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [open])

  React.useEffect(() => {
    if (!open || urls !== null) return undefined
    let cancelled = false
    Promise.all([rpcCall('web.dockUrl'), rpcCall('web.url')])
      .then(([panel, main]) => {
        if (!cancelled) setUrls({ panel: panel.url, main: main.url })
      })
      .catch((error) => {
        if (!cancelled) setUrls({ error: String((error && error.message) || error) })
      })
    return () => {
      cancelled = true
    }
  }, [open, urls, rpcCall])

  const onFrameLoad = () => {
    const show = pendingShow.current
    const frame = frameRef.current
    if (show === null || show === undefined || frame === null) return
    pendingShow.current = null
    if (frame.contentWindow) {
      frame.contentWindow.postMessage({ source: 'dsh-magpie-host', kind: 'show', view: show }, '*')
    }
  }

  const src = urls === null || urls.error ? null : full ? urls.main : urls.panel

  return h('div', { className: 'dshm-dock' }, [
    h(MagpieStyles, { key: 'style' }),
    h(
      'button',
      {
        className: 'dshm-dock__button',
        title: 'Magpie',
        'aria-label': 'Magpie',
        key: 'button',
        onClick: () => setOpen((value) => !value),
      },
      h('span', { className: 'dshm-dock__dot' }),
    ),
    open
      ? h('div', { className: 'dshm-dock__window', key: 'window' }, [
          h('div', { className: 'dshm-dock__bar' }, [
            h('span', { className: 'dshm-dock__title' }, 'Magpie'),
            h(
              'button',
              {
                className: 'dshm-dock__close',
                'aria-label': '关闭',
                onClick: () => setOpen(false),
              },
              '×',
            ),
          ]),
          urls && urls.error
            ? h('div', { className: 'dshm-dock__loading' }, [
                h('p', { key: 'msg' }, urls.error),
                h(
                  'button',
                  {
                    className: 'dshm-magpie__button',
                    key: 'retry',
                    onClick: () => setUrls(null),
                  },
                  '重试',
                ),
              ])
            : src
              ? h('iframe', {
                  ref: frameRef,
                  className: 'dshm-dock__frame',
                  src,
                  title: 'magpie',
                  onLoad: onFrameLoad,
                })
              : h('div', { className: 'dshm-dock__loading' }, '正在连接 magpie…'),
        ])
      : null,
  ])
}
