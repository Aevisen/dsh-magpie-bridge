# dsh-magpie-bridge 设计文档

日期：2026-11-18 ・ 状态：待用户批准 ・ 蓝本：[Betsy20/dsh-magpie](https://github.com/Betsy20/dsh-magpie)（MIT）

## 1. 意图与为什么

用户要把 [yetone/magpie](https://github.com/yetone/magpie) 的全部能力带进 DSH，并跟随上游更新。
magpie 是完整的 Go 应用（网关 + 桌面/TUI/Web/CLI），不可能也不应该逐功能复刻成 JS 插件——复刻即冻结分叉，与"跟随更新"冲突。

选定路线（用户在三个候选中明确选 2）：**以 Betsy20/dsh-magpie 为蓝本自己实现一个插件**，而不是直接安装该仓库，并补上它没有的两块：agent 工具层、完整的中文/英文插件元数据与图标。

核心机制：**不重写 magpie 的任何功能**。UI 用 iframe 嵌 magpie 官方 Web UI（上游更新自动跟随）；agent 能力用 CLI 直通（上游新增子命令自动可用）。

## 2. 目标

1. magpie 原版 Web UI 出现在 DSH：中央主面板（`main`，key=`magpie`）、侧边栏入口（`sidebar.panellist`）、设置页（`settings.section`）、输入框下方小窗按钮（`conversation.composer.dock`，打开 `?mode=panel` 紧凑界面）。
2. 进程与二进制托管：四级回退找二进制；缺失时自动下载（sha256 校验、`.part`+rename）；后台 `magpie serve --web`；崩溃/自我更新后指数退避自动拉起；插件卸载时清理自己启动的进程树。
3. 反向代理：固定端口、常驻、只监听回环；服务端注入登录 Cookie；magpie 重启期间回 503 自动重载页，恢复后无感接上。
4. Agent 工具层（蓝本没有）：
   - `magpie` —— CLI 直通：`execFile(binary, args)`，**不经 shell**，参数为字符串数组；覆盖 CLI 全部功能（换模型、路由组、供应商、配额、库、备份等）；输出有上限并标注截断。
   - `magpie_quota` —— 便捷封装 `magpie quota --json`，返回有界摘要。
5. **不注册 LLM provider**：magpie 自己的 `internal/agent/dsh.go` 已负责往 `~/.dsh/profiles/<name>/cordis.patch.yml` 写 `llm-pi-ai` 条目（带 `# magpie` 标记 + drift 修复），插件重复注册只会让模型选择器出现两份。
6. 完整插件元数据：`locale/en.json` + `locale/zh.json`（`meta.title/description/detail`）、原创 `icon.svg`、`docs/DETAIL.md`，遵守 dsh-doc 的 host-plugin 展示清单。
7. 工程：TypeScript 宿主侧 + esbuild 客户端打包 + vitest 单测 + 构建/下载脚本。

## 3. 非目标

- 不复刻 magpie 的任何页面、网关、协议转换逻辑。
- 不注册 provider、不改 DSH 的 agent preset、不动 magpie 自身配置。
- 不做 magpie 二进制的版本锁定或自行更新 magpie（自我更新是 magpie 自己的职责，插件只需在进程替换后自愈）。

## 4. 反目标（即使技术上成立也算失败）

- 阻塞 DSH 启动（`apply()` 必须同步返回，所有 I/O 后台化）。
- 杀掉**别的** DSH 窗口 / 用户自己启动的 magpie 进程（只清理自己 spawn 的子进程树；绝不按可执行路径匹配清理）。
- 让登录凭据离开回环（代理只 bind `127.0.0.1`；`MAGPIE_WEB_KEY` 不落进仓库）。
- 破坏宿主 UI（客户端所有注册包错误边界；样式用宿主 `--dsw-alias-*` 主题 token）。

## 5. 约束与已核实事实

- cordis 宿主插件：具名导出 `name` / `inject` / `Config` / `apply`，**不能有 `default` 导出**；`Config` 必须是 schemastery schema；静态 `inject` 为空，可选服务用 `ctx.inject([...])` 运行时取。
- 客户端：`package.json` 的 `dsh.client` + `exports["./client"]`；浏览器产物是 esbuild 打的懒工厂，id = 包名；React 来自宿主模块表。
- 面板 RPC 走 `connection.fetch.register`（POST `/api/magpie-bridge`），响应必须包 `{ type:'server-response', rpcId, result:{ ok, value?|error? } }` 信封；错误带 `details: {}`。
- 本机已核实（2026-11-18）：magpie 0.1.4477 在 `/Applications/magpie.app/Contents/MacOS/magpie`；网关已在 `127.0.0.1:3425` 运行；`main` / `sidebar.panellist` / `settings.section` / `conversation.composer.dock` 四个槽位在当前 DSH 实时槽位树中都存在，注册参数形状与蓝本一致。
- 工具 API 已核实：`ctx.tools.register(defineTool({ name, description, parameters, output:{schema,render}, timeoutMs, isConcurrencySafe, presentCall, execute(args, exec) }))`，`defineTool` 来自 `@deepseek-ai/dsh-tools`；破坏性命令的审批走 `tools/pre-execute` 返回 `{ kind:'ask', reason, displayReason }`（本 profile 里 dsh-skills-manager 有现成先例）。
- 安装走 `plugin_manager install_bundle`；本地 `link:` 安装不跑 `prepare`，交付时必须已构建出 `lib/`。

## 6. 考虑过的方案

| 方案 | 取舍 | 结论 |
| --- | --- | --- |
| 1. 直接安装 Betsy20/dsh-magpie | 最快；但工具层缺失、后续改动受制于他人仓库 | 否（用户明确不选） |
| 2. **以蓝本自建** | 一次实现成本；拥有全部改动权，可加工具层、修平台残留、补齐元数据 | **选定** |
| 3. 纯 CLI 桥（无 UI） | 最薄；但丢掉"原版界面自动跟随上游"这一最大收益 | 否 |

## 7. 组成

### 7.1 包结构

```
dsh-magpie-bridge/
  package.json            name=dsh-magpie-bridge, dsh.bundle.patch, dsh.client, exports(./client ./locale/*.json ./icon)
  cordis.patch.yml        insert { id: magpie-bridge, name: dsh-magpie-bridge }
  tsconfig.json  vitest.config.ts
  src/
    index.ts              宿主入口：Config 重导出、工具注册、面板 RPC、惰性桥、卸载清理
    config.ts             schemastery schema（唯一真相源）
    binary.ts             四级回退：配置 → ~/.dsh/magpie/bin → 系统安装位置（含 /Applications/magpie.app）→ PATH
    download.ts           GitHub Releases 下载：Node fetch、.part+rename、sha256、可中断；校验值取 release 的 checksums 资产（无则降级为仅防损坏并 warn）；平台映射 darwin/linux/windows × amd64/arm64，其余平台拒绝下载并提示手动安装
    gateway.ts            网关存活探测
    web-bridge.ts         serve 子进程管理 + 常驻认证代理 + 503 自恢复页 + HTML 脚本注入
    cli.ts                execFile 执行 magpie CLI：参数数组、超时、输出上限、UTF-8
    tools.ts              magpie / magpie_quota 两个工具 + 危险子命令审批
  plugin-src/client/
    index.js              四处槽位注册（共享同一 MagpiePanel / rpcCall）
    panel.js  rpc.js  styles.js  error-boundary.js
  scripts/  build.mjs  build-client.mjs  fetch-magpie.mjs
  tests/    单测（端口退避、二进制回退、CLI 参数与截断、信封形状、下载校验）
  locale/   en.json  zh.json
  docs/     DETAIL.md
  icon.svg  README.md  LICENSE  NOTICE（蓝本 MIT 归属）
```

### 7.2 配置项（默认）

`baseURL=http://127.0.0.1:3425`、`webEnabled=true`、`webHost=127.0.0.1`、`webPort=3480`、`proxyPort=3591`（避开蓝本的 3590，两个插件可共存）、`webKey=<生成后持久化，16+ 位 [A-Za-z0-9._~-]>`、`autoStartGateway=true`、`autoDownloadMagpie=true`、`magpieBinary=magpie`、`toolOutputLimit=20000`、`toolTimeoutMs=120000`。

### 7.3 代理要点（沿用蓝本验证过的结论）

**多实例所有权（实现者裁决）**：不做跨进程引用计数。每个 DSH profile 的插件只管理自己 spawn 的子进程；`webPort` 被占时向后找空闲端口（magpie 自身行为），`proxyPort` 被占时同样向后找并记录实际端口——第二个窗口因此得到自己的代理与 Web 进程，互不干扰。网关本身由 magpie 处理共享（`serve --web` 发现网关已被服务时只提供 Web UI）。绝不按可执行路径杀别人的进程。

**外部网关的生命周期边界（实现者裁决）**：`autoStartGateway=true` 时无条件后台起 `serve --web`（它自己判断网关是否已被服务，不需要插件分支）；`baseURL` 只用于日志探测诊断，不作为启动开关。用户自管网关的场景 = `autoStartGateway=false` + `baseURL` 指向对方，此时插件不起任何子进程，面板仍可用（Web UI 由 `webEnabled` 控制，关掉则面板显示禁用提示）。网关后来退出：magpie serve 模式下由其自愈；纯外部模式下插件只报告不可达，不接管。

- 为什么代理：DSH 启动 cookie 占满 `127.0.0.1` 配额会驱逐 magpie 登录 cookie ⇒ 服务端注入 Cookie、剥离上游 `Set-Cookie`。
- 剥离 `Content-Security-Policy` / `X-Frame-Options`（否则 `frame-ancestors 'self'` 拒绝跨源 iframe）；**保留** `content-encoding`/`content-length`。
- 用 `node:http` 流式 pipe，不用 fetch 缓冲；HTML 缓冲后解压→注入脚本→以未压缩回写。
- WebSocket upgrade 手工 101 + 双向 pipe。
- 代理常驻、端口固定；上游可切换，空上游时回带退避自 reload 的 503 页（计数存 sessionStorage）。
- 注入脚本把 magpie 桌面粉有的 `/api/window/*` fetch 转成 postMessage 给宿主（打开主面板 / 设置 / 关小窗），并接收宿主"切到某页"指令。
- `serve --web=<host:port>`（非 `web --addr`）：一个进程同时管网关与 Web UI，网关已被占用时自动只提供 Web UI。

### 7.4 工具层细则

- `magpie`：入参 `{ args: string[], timeoutMs?: number }`；`execFile` 直调；`env` 继承并强制 UTF-8；stdout/stderr 合并返回，超上限截断并标注；非零退出码连同输出一起返回（不当作插件异常）。描述里给出常用例子（`dsh <model>`、`quota`、`providers`、`group add …`）并声明：破坏性/账号类子命令需用户确认。
- 危险命令审批（实现者裁决）：**默认放行 + 已知危险清单走审批**。理由：CLI 直通的价值就是上游新增子命令自动可用，默认拒绝会破坏这一点；magpie CLI 自身的破坏性命令（如 `quota reset`）本来就有交互确认。清单按**完整命令路径前缀**匹配（如 `provider rm`、`group rm`、`accounts export`），命中即经 `tools/pre-execute` 返回 `{ kind:'ask', reason, displayReason }` 走 DSH 审批；未识别命令直接执行。清单是保守的已知集合，不声称穷尽——工具描述里明示"破坏性操作请先向用户确认"。
- `magpie_quota`：无参或可选 provider 过滤；内部 `quota --json`，输出压缩成每账号一行摘要；失败时回退原文。

### 7.5 跟随更新的含义

- magpie 功能与 UI：由 magpie 自我更新 + 插件进程自愈覆盖，零维护。
- 插件自身：语义化版本；升级 = 替换包后重启 DSH（本地 link 安装需重新 build）。不做插件的自动更新器。

## 8. 验证

1. `node scripts/build.mjs` + vitest 全绿。
2. `plugin_manager install_bundle` 装入 desktop profile，读回 application 状态。
3. `cordis_inspect_query` 确认四个槽位出现 magpie 注册、`magpie`/`magpie_quota` 进入工具表。
4. 实际打开面板看到 magpie 原版页面；在无浏览器控制时如实报告验证边界。
5. 用 agent 实际调一次 `magpie_quota` 与只读的 `magpie ls`（实现者裁决：验证一律只用只读命令，不切换模型、不改任何 magpie 状态；`magpie dsh <model>` 这类写操作只在用户明确要求时执行）。
6. 卸载语义（实现者裁决）：插件卸载只清理自己启动的进程树与代理监听；`~/.dsh/magpie/bin` 下载的二进制、持久化 webKey、运行状态**全部保留**（跨 profile 共享、重装即用；webKey 不含用户凭据，只是本地 Web UI 的固定口令）。彻底清除由用户手动删目录完成，README 写明。
7. 报告哪些已验证、哪些没有（尤其 Windows/Linux 路径只能代码审查，不能本机运行）。

## 9. 留给实现者

槽位 order 的具体数值、图标造型、测试用例粒度、文案措辞、工具描述的精简程度。
