/**
 * Magpie 面板客户端插件入口。
 *
 * 注册四处槽位（同一个 MagpiePanel、同一个 rpcCall，不存在两套实现）：
 * 1. `main`（keyed，key = `magpie`）—— 中央主面板渲染体
 * 2. `sidebar.panellist` —— 侧栏「Magpie」一行
 * 3. `settings.section` —— 设置弹层里的 Magpie 整页
 * 4. `conversation.composer.dock` —— 输入框旁的小窗按钮
 *
 * `inject` 列的是硬依赖：`slots`（注册槽位）与 `connection`（面板 RPC）。
 *
 * @module dsh-magpie-bridge/client
 */
import { withErrorBoundary } from './error-boundary.js'
import { MagpieDockButton, MagpiePanel, MagpieSidebarIcon } from './panel.js'
import { callMagpieRpc } from './rpc.js'

export const name = 'magpie-bridge-client'

export const inject = ['slots', 'connection']

/** 四处槽位共用的 key / id。 */
const PANEL_KEY = 'magpie'
const SIDEBAR_ORDER = 60
const SETTINGS_ORDER = 60
/** 排到统计条最尾部（内置 activity=0、usage=1、ContextMeter 更靠右）。 */
const DOCK_ORDER = 1000

// 模块级常量：写进 render 会每次换组件类型，导致整棵子树重挂。
const MagpiePanelForMain = withErrorBoundary(MagpiePanel, { label: 'Magpie 面板' })
const MagpiePanelForSettings = withErrorBoundary(MagpiePanel, { label: 'Magpie 设置页' })
const MagpieDockButtonForDock = withErrorBoundary(MagpieDockButton, { label: 'Magpie 底部按钮' })

/**
 * @param ctx - 客户端插件上下文（需要 `slots` 与 `connection`）。
 */
export function apply(ctx) {
  // 引用稳定：只建一次；内部每次调用重新取 `ctx.connection`（连接可能重连）。
  const rpcCall = (method, payload, signal) => callMagpieRpc(ctx.connection, method, payload, signal)

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      { name: 'main', key: PANEL_KEY, inject: () => ({ rpcCall }) },
      MagpiePanelForMain,
    ),
  )

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_KEY,
        order: SIDEBAR_ORDER,
        label: () => 'Magpie',
      },
      MagpieSidebarIcon,
    ),
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: PANEL_KEY,
        order: SETTINGS_ORDER,
        label: () => 'Magpie',
        inject: () => ({ rpcCall }),
      },
      MagpiePanelForSettings,
    ),
  )

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.composer.dock',
        id: PANEL_KEY,
        order: DOCK_ORDER,
        inject: () => ({ rpcCall }),
      },
      MagpieDockButtonForDock,
    ),
  )
}
