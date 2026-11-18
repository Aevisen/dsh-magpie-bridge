/**
 * 客户端打包（占位版，客户端源文件在 Task 7 落地）。
 *
 * React 由宿主浏览器模块表提供，保持 external 裸导入；产物是 ESM 懒工厂，
 * 具体注册行由 Task 7 按 dsh-doc 模板补全。
 */
import { access } from 'node:fs/promises'

import { build } from 'esbuild'

const entry = 'plugin-src/client/index.js'

try {
  await access(entry)
} catch {
  console.error(`[build-client] 入口不存在：${entry}（客户端源文件将在后续任务加入）`)
  process.exit(1)
}

await build({
  entryPoints: [entry],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  external: ['react', 'react-dom'],
  logLevel: 'info',
})
