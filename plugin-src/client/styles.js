/**
 * 面板样式：只引用宿主 `--dsw-alias-*` 主题 token，类名统一 `dshm-` 前缀。
 * 以 React `<style>` 元素渲染，随组件卸载移除。
 * @module dsh-magpie-bridge/client/styles
 */
import * as React from 'react'

const MAGPIE_CSS = `
.dshm-magpie { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-surface, transparent); }
.dshm-magpie__frame { flex: 1 1 auto; width: 100%; height: 100%; border: 0; background: var(--dsw-alias-surface, #fff); }
.dshm-magpie--message { align-items: center; justify-content: center; gap: 0.5rem; color: var(--dsw-alias-text-secondary, inherit); }
.dshm-magpie__title { margin: 0; font-weight: 600; color: var(--dsw-alias-text-primary, inherit); }
.dshm-magpie__detail { margin: 0; opacity: 0.8; word-break: break-word; padding: 0 1rem; text-align: center; }
.dshm-magpie__button { padding: 0.3rem 0.9rem; border-radius: 6px; border: 1px solid var(--dsw-alias-border, currentColor); background: transparent; color: inherit; cursor: pointer; }
.dshm-dock { position: relative; display: inline-flex; }
.dshm-dock__button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--dsw-alias-border, transparent); background: transparent; color: var(--dsw-alias-text-secondary, inherit); cursor: pointer; }
.dshm-dock__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--dsw-alias-accent, currentColor); }
.dshm-dock__window { position: fixed; right: 16px; bottom: 88px; width: 440px; height: 520px; display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border, rgba(0,0,0,0.15)); border-radius: 10px; overflow: hidden; box-shadow: var(--dsw-alias-shadow, 0 8px 30px rgba(0,0,0,0.25)); background: var(--dsw-alias-surface, #fff); z-index: 50; }
.dshm-dock__bar { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; border-bottom: 1px solid var(--dsw-alias-border, rgba(0,0,0,0.08)); }
.dshm-dock__title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-text-secondary, inherit); }
.dshm-dock__close { border: 0; background: transparent; color: inherit; cursor: pointer; font-size: 16px; line-height: 1; }
.dshm-dock__frame { flex: 1 1 auto; width: 100%; border: 0; }
.dshm-dock__loading { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-text-secondary, inherit); }
`

/** 渲染一次样式（幂等由调用方控制：每个面板实例渲染一次）。 */
export function MagpieStyles() {
  return React.createElement('style', null, MAGPIE_CSS)
}
