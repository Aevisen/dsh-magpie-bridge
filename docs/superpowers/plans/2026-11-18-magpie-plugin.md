# dsh-magpie-bridge 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 magpie 的原版 Web UI（iframe + 认证代理）与 CLI 工具层做成 DSH 插件 `dsh-magpie-bridge`，跟随 magpie 上游更新。

**Architecture:** 宿主侧 TypeScript 插件管理 `magpie serve --web` 子进程与常驻反向代理（服务端注入登录 Cookie），客户端 esbuild 产物注册四个槽位渲染 iframe 面板；工具层用 `execFile` 直通 magpie CLI。不注册 LLM provider。

**Tech Stack:** TypeScript 5.9（宿主，ESM，tsc 出 lib/）、esbuild（客户端打包）、vitest（测试）、schemastery（Config）、`@deepseek-ai/cordis` 插件 API、`@deepseek-ai/dsh-tools` defineTool。

**Spec:** `docs/superpowers/specs/2026-11-18-magpie-plugin-design.md`（同仓库，随计划一起读）

## Global Constraints

- 包名 `dsh-magpie-bridge`；`cordis.patch.yml` 插入行 `id: magpie-bridge, name: dsh-magpie-bridge`；面板 key `magpie`。
- 宿主入口**只允许**具名导出 `name` / `inject` / `Config` / `apply`，禁止 `default` 导出；`Config` 必须是 schemastery schema；`apply()` 同步返回，所有 I/O 后台化。
- 不注册 LLM provider；不改 magpie 配置；不杀非本插件 spawn 的进程。
- 代理只监听 `127.0.0.1`；`MAGPIE_WEB_KEY` 形如 16+ 位 `[A-Za-z0-9._~-]`，不进版本库。
- 默认配置：`baseURL=http://127.0.0.1:3425`、`webEnabled=true`、`webHost=127.0.0.1`、`webPort=3480`、`proxyPort=3591`、`autoStartGateway=true`、`autoDownloadMagpie=true`、`magpieBinary=magpie`、`toolOutputLimit=20000`、`toolTimeoutMs=120000`。
- 工具执行一律 `execFile`（参数数组、不经 shell）；输出超上限截断并标注。
- 验证只用只读命令（`magpie ls`、`magpie quota --json`），绝不切换模型或改 magpie 状态。
- Node engines `^22.19.0 || >=24.0.0`；ESM only（`"type": "module"`）。
- 依赖：peer `@deepseek-ai/cordis`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`；dev `typescript`、`esbuild`、`vitest`、`@types/node`。
- 测试命令 `npm test`（= `vitest run`）；构建 `npm run build`（= `node scripts/build.mjs`，含 tsc + 客户端 esbuild）。

## Review Focus

1. **magpie 自我更新换进程后面板必须自愈**（白屏不恢复是最大体验故障）→ Task 5 测试启动失败也重排重启链、退避封顶 15s、5 次后停止。
2. **卸载/下载竞态不留孤儿**（卸载发生在下载或启动中途）→ Task 6 测试 `assertAlive` 在每次 await 后生效、清理函数先 abort 再关桥。
3. **Cookie 配额与 CSP 头处理错误会导致登录不上或 iframe 被拒** → Task 5 测试响应头剥离集合（`set-cookie`、`content-security-policy`、`x-frame-options`）与请求头注入。
4. **CLI 输出无界会撑爆模型上下文** → Task 4 测试截断标注、stdout/stderr 合并上限。
5. **破坏性 CLI 命令静默执行** → Task 4 测试完整命令路径前缀匹配（`provider rm` 等）触发 ask。

---

### Task 1: 项目脚手架 + config

**Files:**
- Create: `package.json`、`cordis.patch.yml`、`tsconfig.json`、`vitest.config.ts`、`scripts/build.mjs`、`scripts/build-client.mjs`（本任务只需能跑通空构建）、`src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Produces: `src/config.ts` 导出
  - `interface MagpieOptions { baseURL: string; webEnabled: boolean; webHost: string; webPort: number; proxyPort: number; webKey: string; autoStartGateway: boolean; autoDownloadMagpie: boolean; magpieBinary: string; toolOutputLimit: number; toolTimeoutMs: number }`
  - `const Config: unknown`（schemastery `Schema.object`，字段与默认值同上；`webKey` 默认 `''`，resolve 时若为空则生成）
  - `resolveOptions(config: unknown): MagpieOptions`
  - `isValidWebKey(key: string): boolean`（`/^[A-Za-z0-9._~-]{16,}$/`）
  - `generateWebKey(): string`（crypto.randomBytes 18 字节 → base64url 去 `=` 后取 24 字符）
- 后续所有任务消费 `MagpieOptions`。

- [ ] **Step 1: 写失败测试** `tests/config.test.ts`：
  - `resolveOptions(undefined)` 返回全部默认值（逐字段断言 Global Constraints 的默认值）。
  - `isValidWebKey`：16 位合法串 true；15 位 false；含 `!` false。
  - `resolveOptions({ webPort: 4000 })` 只覆盖该字段；`webKey: ''` 时生成 24 位且 `isValidWebKey` 为 true。
- [ ] **Step 2: 跑测试确认失败** `npm test -- tests/config.test.ts` → FAIL（模块不存在）。
- [ ] **Step 3: 实现脚手架与 `src/config.ts`**。`package.json` 按 Global Constraints + 这些字段：`exports` 含 `.`→`./lib/index.js`（types 同址 `.d.ts`）、`./client`→`./lib/client.js`、`./cordis.patch.yml`、`./package.json`、`./locale/*.json`→`./locale/*.json`、`./icon`→`./icon.svg`；`dsh.bundle.patch: ./cordis.patch.yml`；`dsh.client: { platform: "web", inject: ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-client-ui-settings"] }`；`files: ["lib","cordis.patch.yml","locale","docs","icon.svg"]`；scripts: `build`、`build:host`(tsc)、`build:client`、`test`、`typecheck`。`cordis.patch.yml` 内容照设计文档 §7.1（一个 insert 块）。`tsconfig.json`：ES2022、NodeNext、outDir lib、declaration、strict。`vitest.config.ts` 环境 node、include `tests/**/*.test.ts`。`scripts/build.mjs`：依次跑 tsc 与 build-client.mjs，任一失败非零退出。`scripts/build-client.mjs` 先做占位（读 `plugin-src/client/index.js` 打到 `lib/client.js`，esbuild，format esm，`react`/`react-dom` 保持 external 裸导入）——客户端源文件 Task 7 才有，本任务允许打包时报"入口不存在"的明确错误。`git init` 并提交全部（`.gitignore` 含 `lib/`、`node_modules/`、`.env*`）。
- [ ] **Step 4: 跑测试确认通过** `npm test -- tests/config.test.ts` → PASS；`npm run typecheck` → 0 错误。
- [ ] **Step 5: Commit** `feat: scaffold plugin package and config module`。

### Task 2: binary.ts 四级回退

**Files:**
- Create: `src/binary.ts`
- Test: `tests/binary.test.ts`

**Interfaces:**
- Produces:
  - `type BinarySource = 'config' | 'managed' | 'system' | 'path'`
  - `interface ResolvedBinary { path: string; source: BinarySource }`
  - `binaryFileName(platform = process.platform): string`（win32→`magpie.exe` 否则 `magpie`）
  - `managedBinaryPath(platform?): string`（`~/.dsh/magpie/bin/<name>`）
  - `releaseAssetName(platform?, arch = process.arch): string | undefined`（`win32→windows`、`x64→amd64`、`arm64→arm64`；资产名 `magpie-cli-<os>-<cpu>[.exe]`；不支持平台返回 undefined）
  - `isExecutableFile(path: string, platform?): Promise<boolean>`（存在+普通文件+非零大小；非 win32 加 X_OK 检查）
  - `systemBinaryCandidates(platform?): readonly string[]`（darwin：`/Applications/magpie.app/Contents/MacOS/magpie`、`~/Applications/...`、`/opt/homebrew/bin/magpie`、`/usr/local/bin/magpie`；win32：`%LOCALAPPDATA%\Programs\magpie\`、`%PROGRAMFILES%\magpie\`、`%PROGRAMFILES(X86)%\magpie\`；linux：`~/.local/bin`、`/usr/local/bin`、`/usr/bin`、`/opt/magpie/magpie`）
  - `resolveMagpieBinary(configured: string | undefined, platform?): Promise<ResolvedBinary | undefined>`（顺序：configured 非空且 ≠'magpie' → managed → system → PATH；PATH 按平台分隔符切）
  - `describeSource(source: BinarySource): string`（中文：配置指定/插件自带/系统安装/PATH）
- Task 3、4、5、6 消费 `resolveMagpieBinary` 与 `ResolvedBinary`。

- [ ] **Step 1: 写失败测试** `tests/binary.test.ts`：
  - `releaseAssetName('win32','x64') === 'magpie-cli-windows-amd64.exe'`；`('darwin','arm64') === 'magpie-cli-darwin-arm64'`；`('freebsd','x64') === undefined`。
  - `binaryFileName('win32') === 'magpie.exe'`、`('linux') === 'magpie'`。
  - `systemBinaryCandidates('darwin')[0]` 以 `/Applications/magpie.app/Contents/MacOS/magpie` 结尾。
  - 临时目录造可执行假文件 + 伪造 PATH 环境变量，`resolveMagpieBinary` 按 config→managed→system→path 顺序命中（至少 3 个用例）。
- [ ] **Step 2: 跑测试确认失败** `npm test -- tests/binary.test.ts` → FAIL。
- [ ] **Step 3: 实现 `src/binary.ts`**（签名见 Interfaces；解析互不重叠，每级命中即返回对应 source）。
- [ ] **Step 4: 跑测试确认通过** → PASS。
- [ ] **Step 5: Commit** `feat: resolve magpie binary with four-level fallback`。

### Task 3: download.ts 自动下载

**Files:**
- Create: `src/download.ts`
- Test: `tests/download.test.ts`

**Interfaces:**
- Produces:
  - `interface EnsureOptions { logger: { debug(msg: string): void; warn(msg: string): void }; signal?: AbortSignal; force?: boolean }`
  - `ensureMagpieBinary(options: EnsureOptions): Promise<string>`（返回写入的二进制绝对路径；已存在且非 force 直接返回）
  - `verifyChecksum(bytes: Buffer, expected: string | undefined): 'ok' | 'missing' | 'mismatch'`
  - `parseChecksumFile(text: string, assetName: string): string | undefined`（解析 `checksums.txt` 的 `<sha256>  <filename>` 行或 `<asset>.sha256` 单值文件）
- Task 6 消费 `ensureMagpieBinary`。

- [ ] **Step 1: 写失败测试** `tests/download.test.ts`：
  - `parseChecksumFile('abc123  magpie-cli-darwin-arm64\n', 'magpie-cli-darwin-arm64') === 'abc123'`；找不到目标行返回 undefined。
  - `verifyChecksum`：match→'ok'；undefined expected→'missing'；错值→'mismatch'。
  - 不支持平台（mock `releaseAssetName` 返回 undefined）时 `ensureMagpieBinary` reject 且错误信息含"不支持"。（用依赖注入或 vi.mock。）
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/download.ts`**：从 `https://github.com/yetone/magpie-releases/releases/latest` 的 release 元数据取资产；先尝试 `checksums.txt`，再 `<asset>.sha256`；用 Node `fetch` 流式下到 `<path>.part`，完成后校验（missing 则 `logger.warn` 只防损坏），`rename` 落位；`signal` 中断即删 `.part` 并抛 AbortError；失败不残留半成品。下载目标 = `managedBinaryPath()`。
- [ ] **Step 4: 跑测试确认通过** → PASS。
- [ ] **Step 5: Commit** `feat: download magpie release with checksum verification`。

### Task 4: cli.ts + tools.ts 工具层

**Files:**
- Create: `src/cli.ts`、`src/tools.ts`
- Test: `tests/cli.test.ts`、`tests/tools.test.ts`

**Interfaces:**
- Consumes: `MagpieOptions`（Task 1）、`ResolvedBinary`（Task 2）。
- Produces:
  - `src/cli.ts`：
    - `interface CliResult { code: number | null; stdout: string; stderr: string; truncated: boolean }`
    - `interface CliOptions { timeoutMs?: number; outputLimit?: number; signal?: AbortSignal }`
    - `runMagpie(binary: string, args: readonly string[], options?: CliOptions): Promise<CliResult>`（`execFile`，参数原样传递；超时 kill 并在 stderr 注明；输出按 `outputLimit` 合并截断，`truncated: true`）
    - `const DANGEROUS_PREFIXES: readonly (readonly string[])[]`：`['uninstall']`、`['restore']`、`['rm']`、`['provider','rm']`、`['provider','key']`、`['group','rm']`、`['group','set']`、`['accounts','export']`、`['accounts','import']`、`['accounts','switch']`、`['accounts','access-only']`、`['quota','reset']`、`['data','move']`、`['plugin','rm']`、`['plugin','add']`、`['github','on']`、`['s3','on']`、`['webdav','on']`
    - `isDangerousCommand(args: readonly string[]): boolean`（按**完整命令路径前缀**匹配，忽略前导 flag；空 args false）
  - `src/tools.ts`：
    - `registerMagpieTools(ctx: unknown, deps: { options: MagpieOptions; resolveBinary(): Promise<string | undefined> }): void`
    - 注册两个工具：`magpie`（参数 `{ args: string[]; timeoutMs?: number }`）与 `magpie_quota`（参数 `{ providers?: string[] }`，内部 `quota --json`，输出压缩为每条 `name/window/use/resets` 一行摘要，解析失败回退原文）。
    - 工具 output schema 均为 `{ type:'object', additionalProperties:true }`，`render` 输出文本（超限标注 `…[truncated]`）。
    - `tools/pre-execute` 监听：`exec.name === 'magpie'` 且 `isDangerousCommand(exec.args)` 时返回 `{ kind:'ask', reason, displayReason: { en, zh } }`（reason 含命令原文）；否则 `next()`。
- Task 6 消费 `registerMagpieTools`。

- [ ] **Step 1: 写失败测试**
  - `tests/cli.test.ts`：用 `process.execPath -e "..."` 当假 magpie：参数含空格/引号原样到达（JSON.stringify argv 回读）；输出 50k 字符被截到 `outputLimit` 且 `truncated===true`；非零退出码在 `code` 而不抛异常；超时被 kill。
  - `tests/tools.test.ts`：`isDangerousCommand(['provider','rm','x'])===true`、`(['providers'])===false`、`(['quota'])===false`、`(['quota','reset'])===true`、`(['--help'])===false`。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/cli.ts` 与 `src/tools.ts`**（签名见 Interfaces；`runMagpie` 用 `node:child_process.execFile` + `AbortSignal`；工具描述给常用例子并含"破坏性操作前先向用户确认"）。
- [ ] **Step 4: 跑测试确认通过** → PASS。
- [ ] **Step 5: Commit** `feat: magpie CLI passthrough tools with dangerous-command approval`。

### Task 5: web-bridge.ts 进程桥 + 认证代理

**Files:**
- Create: `src/gateway.ts`、`src/web-bridge.ts`
- Test: `tests/web-bridge.test.ts`、`tests/gateway.test.ts`

**Interfaces:**
- Consumes: `MagpieOptions`（Task 1）。
- Produces:
  - `src/gateway.ts`：`probeGateway(baseURL: string, timeoutMs = 3000): Promise<{ reachable: boolean; version?: string }>`（GET `<baseURL>/api/hello` 或 `/v1/models`，只用于日志诊断）。
  - `src/web-bridge.ts`：
    - `interface MagpieWebBridgeOptions { binary: string | undefined; key: string; host: string; preferredPort: number; proxyPort?: number; gatewayURL?: string; startupTimeoutMs?: number; logger: { debug(msg: string): void; warn(msg: string): void } }`
    - `interface MagpieWebHandle { url: string; port: number; upstreamPort: number; pid: number | undefined }`
    - `class MagpieWebBridge { constructor(options); ensure(): Promise<MagpieWebHandle>; dispose(): void }`
    - `restartDelay(attempt: number): number`（`min(1000 * 2^(max(1,attempt)-1), 15000)`）
    - `mainWindowUrl(host: string, port: number): string`、`dockWindowUrl(host: string, port: number): string`（后者带 `?mode=panel`）
- Task 6 消费 `MagpieWebBridge`、`MagpieWebHandle`、`dockWindowUrl`。

行为规格（实现者写 body，这些决定不可更改）：

- **spawn**：`execFile` 式 `spawn(binary, ['serve', '--web=<host>:<port>'])`，`env` 含 `MAGPIE_WEB_KEY=<key>`；就绪行正则 `/magpie web on (https?:\/\/\S+)/u` 匹配 stdout（缓冲只留尾部 8KB）；就绪超时默认 30s。
- **登录**：`GET <base>/?k=<key>`，`redirect:'manual'`，取 `Set-Cookie` 首个 `name=value` 段作为注入 Cookie。
- **代理**（常驻、端口固定、只 bind 127.0.0.1，整个桥生命周期只 listen 一次）：`node:http` + `httpRequest` 流式 pipe（不用 fetch）；每个请求注入 `Cookie`、改写 `Host`；丢弃请求头 `{host,connection,keep-alive,proxy-authenticate,proxy-authorization,te,trailer,transfer-encoding,upgrade,content-length}`，丢弃响应头 `{set-cookie,connection,content-security-policy,content-security-policy-report-only,keep-alive,proxy-authenticate,proxy-authorization,te,trailer,transfer-encoding,upgrade,x-frame-options}`；**保留** `content-encoding`/`content-length`；HTML 响应缓冲后按 gzip/br/deflate 解压、在 `</body>` 前注入桥接脚本（找不到则追加）、以未压缩回写并删除 `content-encoding`；WebSocket `upgrade` 事件手工写 `HTTP/1.1 101` 响应行后双向 `pipe`。
- **注入脚本**（页面内）：hook `window.fetch`，凡 URL 含 `/api/window/` 的请求改发 `postMessage({ source:'dsh-magpie', kind, view, tab })` 给父窗口并返回 204 空响应；非 panel 模式下监听 `message`（`source:'dsh-magpie-host'`、`kind:'show'`），校验 `/^[a-z0-9-]+$/` 后点击 `#nav button[data-view=...]`（settings 时点 `#prefs`）。
- **上游可切换**：`getUpstream()` 为 undefined 时回 503 + 自恢复 HTML 页（sessionStorage 计数、300ms×2^n 封顶 5s、30 次停、5 分钟窗口），代理与端口永不动。
- **自愈**：常驻 `exit` 监听（generation 防串台）→ `discardHandle()` + `scheduleRestart()`；重启退避 `restartDelay`；连续 `MAX_AUTO_RESTARTS=5` 次失败停止；启动稳定 `STABLE_AFTER_MS=60000` 后清零计数；**启动即失败也重排**（不只 exit 路径）；`isProcessAlive`（`process.kill(pid,0)`，EPERM 算活）决定缓存句柄是否可信。
- **清理**：`dispose()` 同步：清定时器 → 关代理（`closeAllConnections?.()` + `close()` 各自 try）→ `stopProcessTree`（win32：`%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F` + 超时 5s SIGKILL 兜底；其他：SIGTERM + 2s SIGKILL）。
- **端口**：`findFreePort`（bind 探测后立即关闭，EADDRINUSE 递增；`preferred<1` 抛错）；proxy 端口 listen 撞 EADDRINUSE 时递增最多 5 次。

- [ ] **Step 1: 写失败测试**
  - `tests/web-bridge.test.ts`：`restartDelay` 边界（1→1000、5→15000、99→15000、0→1000）；`mainWindowUrl('0.0.0.0', 1)` 形如 `http://127.0.0.1:1/`（通配转回环）；`dockWindowUrl` 含 `?mode=panel`；`findFreePort` 对 `<1` 抛错、对占用端口递增（起两个 server 占住 3480+3481 后请求 3480 得 3482）；请求头/响应头剥离集合包含 `set-cookie`、`content-security-policy`、`x-frame-options`（导出集合常量断言）。
  - `tests/gateway.test.ts`：起本地 http server 返回版本 JSON → `probeGateway` 得 `reachable:true`；指向未监听端口 → `reachable:false`。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/gateway.ts` + `src/web-bridge.ts`**（行为规格如上）。
- [ ] **Step 4: 跑测试确认通过** → PASS。
- [ ] **Step 5: Commit** `feat: magpie serve bridge with persistent cookie-injecting proxy`。

### Task 6: index.ts 宿主入口 + 面板 RPC

**Files:**
- Create: `src/index.ts`
- Test: `tests/panel-rpc.test.ts`、`tests/index.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `Config`/`resolveOptions`，Task 2 的 `resolveMagpieBinary`，Task 3 的 `ensureMagpieBinary`，Task 4 的 `registerMagpieTools`，Task 5 的 `MagpieWebBridge`/`dockWindowUrl`。
- Produces:
  - 具名导出 `name = 'magpie-bridge'`、`inject = []`（静态空）、`Config`（重导出）、`apply(ctx: unknown, config?: unknown): void`。
  - `createPanelHandler(options, getBridge): (method: string) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }>`（供测试直接调用；方法：`web.url`→`{url, port}`、`web.dockUrl`→`{url}`、未知→`magpie/unknown-method`、`webEnabled:false`→`magpie/web-disabled`、失败→`magpie/web-unavailable`）。
  - 面板 HTTP 端点：POST `/api/magpie-bridge`，通道名 `magpie-bridge`；响应信封 `{ type:'server-response', rpcId, result }`，失败 result 补 `error.details:{}`。

- [ ] **Step 1: 写失败测试**
  - `tests/panel-rpc.test.ts`：`createPanelHandler` 各分支返回 ok/error 信封形状（含 unknown-method、web-disabled）；mock getBridge 返回固定 handle 时 `web.url` 返回 `{url, port}`。
  - `tests/index.test.ts`：`import * as entry` 断言恰有 `name/inject/Config/apply` 四个导出（无 `default`）；`name==='magpie-bridge'`；`inject` 深度为空数组。
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现 `src/index.ts`**：`apply()` 内同步建 `resolveOptions`、logger 薄壳（缺方法静默）、`lifecycle: AbortController`、`assertAlive()`、惰性 `getBridge()`（缓存 Promise，失败清缓存可重试；每次 await 后 assertAlive；`autoDownloadMagpie` 且未找到二进制时后台 `ensureMagpieBinary` 再解析）；`ctx.effect(() => () => { lifecycle.abort(); bridgeInstance?.dispose() })`；`autoStartGateway` 时后台 `getBridge().then(b => b.ensure())`，失败仅 warn；`ctx.tools?.register` 存在时 `registerMagpieTools`；`ctx.inject(['connection'], ...)` 内 `connection.fetch.register` 注册 `/api/magpie-bridge`（校验 content-type 与信封形状，错误统一走 reply()）。
- [ ] **Step 4: 跑测试确认通过** → PASS；`npm run build` 成功产出 `lib/`。
- [ ] **Step 5: Commit** `feat: host entry with panel RPC and lazy bridge lifecycle`。

### Task 7: 客户端面板（四槽位 + iframe）

**Files:**
- Create: `plugin-src/client/index.js`、`panel.js`、`rpc.js`、`styles.js`、`error-boundary.js`
- Modify: `scripts/build-client.mjs`（去掉占位，正式打包）

**Interfaces:**
- Consumes: Task 6 的 RPC 端点与信封。
- Produces: 浏览器模块具名导出 `name='magpie-bridge-client'`、`inject=['slots','connection']`、`apply(ctx)`。注册：
  1. `main`（keyed，key=`magpie`）→ `MagpiePanel`（包错误边界，label 'Magpie 面板'）
  2. `sidebar.panellist`（id=`magpie`，order 60，label 'Magpie'）→ `MagpieSidebarIcon`
  3. `settings.section`（id=`magpie`，order 60）→ 同一 `MagpiePanel`（label 'Magpie 设置页'）
  4. `conversation.composer.dock`（id=`magpie`，order 1000）→ `MagpieDockButton`（弹 440×520 浮层，内容 iframe 指向 `web.dockUrl`；消息处理：`dsh-magpie` 的 `main`→切完整页、`settings`→完整页+设置、`quit`→关浮层）
  - `rpc.js` 导出 `callMagpieRpc(connection, method, payload?, signal?)`：POST `/api/magpie-bridge`，`{type:'client-request', rpcId: <随机>, method:'magpie-bridge', payload:{method, ...payload}}`；解包 `{ok,value|error}`，`ok:false` 抛 Error(message)。
  - `panel.js` 的 `MagpiePanel`：loading 态（spinner 文案）、错误态（message + 重试按钮）、就绪态（iframe，`src` 用 `web.url` 返回值，**不设 sandbox**，`allow="..."` 留默认）；`rpcCall` 引用稳定（模块级只建一次，内部每次重取 `ctx.connection`）。
  - `styles.js`：`installMagpieStyles()` 幂等注入，只用 `--dsw-alias-*` token，类名前缀 `dshm-`。
  - `error-boundary.js`：`withErrorBoundary(Component, { label })` 返回模块级稳定的类组件边界（渲染 fallback 文案含 label）。
  - 所有注册经 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`；工厂无副作用；React 从浏览器模块表来（bare `react` 导入，esbuild external）。

- [ ] **Step 1: 写失败测试** `tests/rpc-unwrap.test.ts`：把 `rpc.js` 的解包逻辑抽出纯函数 `unwrapRpcResult(envelope)`：`{ok:true,value}`→value；`{ok:false,error:{message}}`→throw Error 含 message；畸形→throw 'invalid server-response result'。（Node 环境可直接 import 该纯模块。）
- [ ] **Step 2: 跑测试确认失败** → FAIL。
- [ ] **Step 3: 实现客户端五个文件 + 正式 build-client.mjs**（esbuild：entry `plugin-src/client/index.js`，outfile `lib/client.js`，bundle，format esm，external `react`/`react-dom`，banner 注入 `window.__ModuleLoader__` 注册行——具体注册 API 以 `dsh-doc` 技能 `templates/decoration/client.js` 为准，先读模板再写）。
- [ ] **Step 4: 验证** `npm test -- tests/rpc-unwrap.test.ts` PASS；`npm run build` 产出 `lib/client.js` 且 `node --check` 语法通过。
- [ ] **Step 5: Commit** `feat: client panel with four slot entries and iframe bridge`。

### Task 8: 元数据、图标与文档

**Files:**
- Create: `locale/en.json`、`locale/zh.json`、`icon.svg`、`docs/DETAIL.md`、`README.md`、`LICENSE`、`NOTICE`
- Modify: `package.json`（补 `description`、`keywords`、`license`、`repository`）

**Interfaces:**
- Produces: Plugin Manager 展示元数据（`meta.title`、`meta.description`、`meta.detail: docs/DETAIL.md`，en+zh 两份）；`icon.svg`（原创、≤256KB、SVG 合法）；`NOTICE` 含 Betsy20/dsh-magpie（MIT）归属声明；`LICENSE` = MIT。

- [ ] **Step 1:** 先读 `dsh-doc` 技能的 `references/artwork.md` 与 `references/plugin-details.md`，按其规则画图标与详情页（此步无自动化测试，产物人工核对）。
- [ ] **Step 2: 写内容**：英文 title "Magpie bridge"（sentence case），zh "Magpie 桥"；description 各两句话：嵌入 magpie 原版 Web UI + 自动下载/启动 + CLI 工具；DETAIL.md 写清功能、配置表、危险命令审批语义、卸载保留数据的语义、验证边界；README = DETAIL 精简版 + 构建/安装命令。
- [ ] **Step 3: 校验**：JSON 可解析；`icon.svg` 是合法 SVG（`xmllint --noout` 或等价）；`meta.detail` 指向的文件存在且 < 1MiB。
- [ ] **Step 4:** `npm run build` 仍成功；`npm pack --dry --json` 的 files 列表包含 lib、cordis.patch.yml、locale、docs、icon.svg（本地目录安装时直接核对这些文件存在）。
- [ ] **Step 5: Commit** `docs: locales, icon, detail page and license notices`。

### Task 9: 安装、实测与验证报告

**Files:**
- Modify: 无新文件（必要缺陷修复回到对应任务的文件）
- Create: `docs/verification-2026-11-18.md`（验证报告）

- [ ] **Step 1: 全量构建与测试** `npm run build && npm test && npm run typecheck` 全绿。
- [ ] **Step 2: 安装** `plugin_manager` `install_bundle`（target = 本包绝对路径），读回结果的 `application`/`warnings`；按需 `set_plugin` 启用。
- [ ] **Step 3: 实测**（全部只读）：`cordis_inspect_query` 确认四槽位注册与 `magpie`/`magpie_quota` 工具在表；新开会话调用 `magpie ls` 与 `magpie_quota` 各一次；打开侧边栏面板确认 magpie 原版页面渲染（无浏览器控制时如实标注未验证视觉）。
- [ ] **Step 4: 缺陷修复**：发现的问题在本插件内修复，重复 Step 1–3 直到所列能力可用。
- [ ] **Step 5: 验证报告 + Commit** `docs/verification-2026-11-18.md` 记录：已验证/未验证清单（Windows/Linux 路径仅代码审查）、安装回执、遗留风险；Commit `chore: verification report`。
