#!/usr/bin/env node
/**
 * 把 `plugin-src/client/` 打成宿主的客户端模块。
 *
 * ## 产物形态
 *
 * DSH 的 Web 端用 `window.__ModuleLoader__.load({ id, factory })` 加载客户端
 * 插件。`factory` 收到的 `require` 是宿主提供的**受限** require —— 只有
 * `react` / `react-dom` / `@deepseek-ai/dsh-client-ui-primitives` 能解析，
 * 其余一律抛错。因此 esbuild 必须把它们标成 `external`（产物里保留
 * `require("react")`），其余全部打包进来。
 *
 * ## ⚠️ `id` 必须等于 package.json 的 name
 *
 * 宿主按 `id` 登记插件，不一致时的表现是启动日志里一句
 * `N entry did not activate` 然后插件被静默禁用，没有任何指向 id 的提示。
 *
 * 包装方式与 `window.__ModuleLoader__` 契约来自 dsh-doc 的 decoration 模板；
 * 蓝本 Betsy20/dsh-magpie（MIT）也是同一手法。
 * @module scripts/build-client
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as esbuild from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const ENTRY = join(root, 'plugin-src', 'client', 'index.js')
const OUT_FILE = join(root, 'lib', 'client.js')

/** 宿主能提供给客户端插件的模块；不要往里加（改了要宿主同步）。 */
const EXTERNALS = ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']

const PRODUCTION = process.env.NODE_ENV === 'production'

async function main() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const moduleId = pkg.name
  if (typeof moduleId !== 'string' || moduleId.length === 0) {
    throw new Error('package.json 缺少 name，无法确定客户端模块 id。')
  }

  const result = await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome100'],
    charset: 'utf8',
    external: EXTERNALS,
    minify: PRODUCTION,
    legalComments: 'none',
    sourcemap: false,
    logLevel: 'warning',
  })

  if (result.outputFiles.length === 0) {
    throw new Error('esbuild 没有产出任何文件。')
  }

  const body = result.outputFiles[0].text
  const indented = body
    .split('\n')
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join('\n')

  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(moduleId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${indented}
    return module.exports;
  }
});
`

  mkdirSync(dirname(OUT_FILE), { recursive: true })
  writeFileSync(OUT_FILE, wrapped, 'utf8')

  const kb = (Buffer.byteLength(wrapped, 'utf8') / 1024).toFixed(1)
  console.log(`[build-client] ${moduleId} → lib/client.js (${kb} KB${PRODUCTION ? ', minified' : ''})`)
}

main().catch((error) => {
  console.error('[build-client] 失败：', error)
  process.exitCode = 1
})
