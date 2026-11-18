/**
 * Magpie 面板客户端插件入口（占位版，Task 7 落地完整实现）。
 *
 * 浏览器产物是懒工厂：id 必须等于 package.json 的 name，React 从宿主模块表取。
 * @module dsh-magpie-bridge/client
 */

export const name = 'magpie-bridge-client'

export const inject = ['slots', 'connection']

export function apply() {
  // Task 7：注册 main / sidebar.panellist / settings.section / conversation.composer.dock。
}
