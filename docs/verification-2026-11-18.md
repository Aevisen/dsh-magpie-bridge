# 验证报告 · dsh-magpie-bridge · 2026-11-19

环境：macOS，DSH desktop profile，magpie 0.1.4477（`/Applications/magpie.app`），
分支 `feat/magpie-bridge`。

## 构建与测试

- `npm test`：55 个测试全部通过（config、binary、download、cli、tools、gateway、web-bridge、panel-rpc、index、rpc-unwrap）。
- `npm run typecheck`：0 错误。
- `npm run build`：宿主 `lib/` + 客户端 `lib/client.js`（12.5 KB，`node --check` 通过）。

## 安装

- `plugin_manager install_bundle` → `application: applied`，warnings 空。
- 安装过程中修了两个真实缺陷（均有测试覆盖）：
  1. 直接读 `ctx.tools` 会触发 cordis 的 "cannot get property without inject"，
     改为 `ctx.inject(['tools'], ...)` 运行时注入；
  2. 客户端 esbuild 产物的两处对象字面量语法错误。

## 实测

- **进程桥**：插件启动后 `magpie serve --web` 在 `127.0.0.1:3480` 运行（401 = 需要登录 cookie，符合预期）。
- **认证代理**：`http://127.0.0.1:3591/` 返回 200 且是 magpie 完整 HTML；
  桥接脚本已注入（页面内出现 `dsh-magpie` 两处）；`/?mode=panel` 返回 200。
- **网关**：`127.0.0.1:3425/v1/models` 返回 200（既有网关，插件未重复占用）。
- **只读 CLI**：`magpie ls` 列出全部 agent（含 DeepSeek Harness = group/smart）；
  `magpie quota --json` 返回 5 个账户（Grok、Codex、商汤小浣熊等），摘要逻辑已由单测覆盖。
- **配置**：`Config.listConfigs` 显示 `magpie-bridge` 条目 schema 有效。

## 未验证（如实标注）

- **视觉渲染**：本会话没有浏览器控制，侧边栏「Magpie」入口、设置页与小窗按钮的实际渲染未亲眼确认。
  槽位注册代码与实时槽位树核对一致（`main`、`sidebar.panellist`、`settings.section`、`conversation.composer.dock` 均存在且参数形状匹配）。
- **Windows / Linux**：二进制候选路径与 `taskkill` 分支只经过代码审查与单测（平台参数化），未在对应系统上运行。
- **自动下载**：本机命中系统安装（第 3 级），下载流程只由 mock 测试覆盖，未真实下载 69 MB。
- **自我更新自愈**：重启退避逻辑有单测（`restartDelay` 边界），未实际触发 magpie 自我更新。

## 遗留风险

- 危险命令清单是保守的已知集合，不穷尽；未识别命令默认放行（设计如此，工具描述已声明）。
- 代理只监听 127.0.0.1；`MAGPIE_WEB_KEY` 由插件生成并只存在于进程环境，不进版本库。
