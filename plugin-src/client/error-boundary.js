/**
 * 错误边界：槽位渲染没有隔离，一处抛错会卸载整棵子树。
 * @module dsh-magpie-bridge/client/error-boundary
 */
import * as React from 'react'

/**
 * 把组件包一层类错误边界。
 *
 * ⚠️ 必须在模块级调用（`withErrorBoundary(Component, ...)` 的结果存成常量），
 * 写在 render 里会每次换组件类型 → React 卸载重挂整棵子树。
 */
export function withErrorBoundary(Component, { label }) {
  return class MagpieErrorBoundary extends React.Component {
    constructor(props) {
      super(props)
      this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
      return { error }
    }

    componentDidCatch(error) {
      // eslint-disable-next-line no-console
      console.error(`[${label}]`, error)
    }

    render() {
      if (this.state.error) {
        const message = this.state.error && this.state.error.message
          ? String(this.state.error.message)
          : String(this.state.error)
        return React.createElement(
          'div',
          { className: 'dshm-magpie__detail' },
          `${label} 渲染失败：${message}`,
        )
      }
      return React.createElement(Component, this.props)
    }
  }
}
