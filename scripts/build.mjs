/**
 * 全量构建：先编译宿主侧（tsc → lib/），再打包客户端（esbuild → lib/client.js）。
 * 任一步失败即以该步退出码结束。
 */
import { spawnSync } from 'node:child_process'
import process from 'node:process'

const steps = [
  ['host', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']],
  ['client', process.execPath, ['scripts/build-client.mjs']],
]

for (const [name, command, args] of steps) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    console.error(`[build] 步骤 ${name} 失败（exit ${String(result.status)}）`)
    process.exit(result.status ?? 1)
  }
}
