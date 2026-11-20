#!/usr/bin/env node
/**
 * 生成 DSH 插件市场索引（format 1）到 market/index.json。
 *
 * DSH 的 Discover 页不读中央仓库，而是读用户在 `plugin-market.indexes` 里
 * 配置的索引 URL。发布本插件 = 发布 npm 包 + 托管这份索引。
 *
 * 校验：若运行环境是 DSH（$DSH_INSTALL_DIR 指向 @deepseek-ai/dsh），
 * 用官方 `@deepseek-ai/dsh-plugin-market-index` 的 parseMarketIndex 校验；
 * 否则只生成并提示手动校验。
 * @module scripts/make-market-index
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const readme = readFileSync(join(root, 'README.md'), 'utf8')

const name = pkg.name
const version = pkg.version
if (typeof name !== 'string' || name.length === 0) throw new Error('package.json 缺少 name')
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
  throw new Error(`package.json 的 version 不是 SemVer：${String(version)}`)
}

const indexUrl = process.env.MARKET_INDEX_URL
if (typeof indexUrl !== 'string' || indexUrl.length === 0) {
  throw new Error('需要 MARKET_INDEX_URL，例如 https://example.com/dsh-magpie/market/index.json')
}

const description = readme.split('\n').find((line) => line.startsWith('把 ')) ?? ''

const document = {
  format: 1,
  title: { en: 'Magpie bridge market', zh: 'Magpie 桥插件市场' },
  description: { en: 'dsh-magpie-bridge index', zh: 'dsh-magpie-bridge 索引' },
  metadata: {
    categories: {
      integration: { title: { en: 'Integration', zh: '集成' } },
    },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name,
      title: { en: 'Magpie bridge', zh: 'Magpie 桥' },
      description: { en: description, zh: description },
      icon: new URL('icon.svg', indexUrl).href,
      author: pkg.author,
      homepage: pkg.homepage,
      repository: pkg.repository?.url
        ? { url: pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '') }
        : undefined,
      metadata: {
        category: 'integration',
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords : [],
        labels: [],
        sortKeys: {},
      },
      versions: [
        {
          version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'npm' },
          engines: {},
        },
      ],
    },
  ],
}

async function validate() {
  const installDir = process.env.DSH_INSTALL_DIR
  if (typeof installDir !== 'string' || installDir.length === 0) return false
  try {
    const mod = await import(
      join(installDir, '..', 'dsh-plugin-market-index', 'lib', 'index.js')
    )
    mod.parseMarketIndex(document, indexUrl)
    return true
  } catch (error) {
    console.error('[market] 官方校验不可用：', error instanceof Error ? error.message : String(error))
    return false
  }
}

// 图标与索引同目录托管，便于静态站点直接引用。
const marketDir = join(root, 'docs', 'market')
mkdirSync(marketDir, { recursive: true })
copyFileSync(join(root, 'icon.svg'), join(marketDir, 'icon.svg'))

const validated = await validate()
const out = join(root, 'docs', 'market', 'index.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
console.log(`[market] 已生成 ${out}（${name}@${version}，官方校验：${validated ? '通过' : '跳过'}）`)
