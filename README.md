# dsh-magpie-bridge

把 [magpie](https://github.com/yetone/magpie) 的原版 Web UI 嵌进 DeepSeek Harness，并给 agent 提供 magpie 的 CLI 工具。

**不复刻任何功能**——界面是 magpie 自己的 Web UI（iframe），工具是 magpie 自己的 CLI。magpie 更新后两边自动跟上。

## 装上之后

- **侧边栏「Magpie」**：magpie 的完整界面（Agents、Providers、路由组、用量、隐私脱敏……全部原版）。
- **设置 → Magpie**：同一界面。
- **输入框旁的小圆点**：magpie 托盘同款的紧凑小窗（440×520）。
- **agent 工具**：`magpie`（CLI 直通，参数是字符串数组，不经 shell）与 `magpie_quota`（每账户一行的配额摘要）。

模型接入**不由本插件负责**：`magpie dsh <model>` 会自己把 `llm-pi-ai` 条目写进 `~/.dsh/profiles/<name>/cordis.patch.yml`（带 `# magpie` 标记），插件重复注册只会让模型选择器出现两份。

## 二进制从哪来

四级回退，命中即停：

1. 配置里的 `magpieBinary`（绝对路径）
2. `~/.dsh/magpie/bin/magpie`（插件自己下载的，跨 profile 共享）
3. 系统安装位置（macOS `/Applications/magpie.app/Contents/MacOS/magpie`、Windows `%LOCALAPPDATA%\Programs\magpie\`、Linux `~/.local/bin` 等）
4. `PATH`

都没有且 `autoDownloadMagpie: true`（默认），从 GitHub Releases 下载（~69 MB，优先用 release 的 checksums 校验，没有则只防损坏并警告）。

## 配置

插件配置走 DSH 设置里的 `magpie-bridge` 条目（schemastery schema，见 `src/config.ts`）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseURL` | `http://127.0.0.1:3425` | 网关根地址，仅用于日志诊断 |
| `webEnabled` | `true` | 是否嵌入原版 Web UI |
| `webHost` | `127.0.0.1` | Web UI 监听地址 |
| `webPort` | `3480` | Web UI 首选端口（占用时向后找） |
| `proxyPort` | `3591` | 认证代理端口（iframe 直接加载；占用时向后找） |
| `webKey` | 空则自动生成并记住 | `MAGPIE_WEB_KEY`，16+ 位。留空时写入 `~/.dsh/magpie/web-key`，重启沿用，避免面板停在「密钥已变」的登录页 |
| `autoStartGateway` | `true` | 插件加载时后台起 `magpie serve --web` |
| `autoDownloadMagpie` | `true` | 找不到二进制时自动下载 |
| `magpieBinary` | `magpie` | 可执行文件路径（绝对路径优先） |
| `toolOutputLimit` | `20000` | CLI 工具输出上限（字符） |
| `toolTimeoutMs` | `120000` | CLI 工具超时（毫秒） |

网关跑在另一台机器上：

```yaml
- id: magpie-bridge
  config:
    autoStartGateway: false
    baseURL: http://192.168.1.10:3425
```

## 危险命令审批

`magpie` 工具**默认直接执行**（上游新增子命令自动可用），但命中已知危险前缀时会先走 DSH 的确认审批：

`uninstall`、`restore`、`rm`、`provider rm`、`provider key`、`group rm`、`group set`、`accounts export/import/switch/access-only`、`quota reset`、`data move`、`plugin rm/add`、`github on`、`s3 on`、`webdav on`。

未识别的命令直接执行——这是有意的：magpie 自己的破坏性命令本来就有交互确认，而默认拦截会破坏「跟随更新」。

## 卸载

关闭或卸载插件**只停掉它自己启动的 magpie 进程与代理**；`~/.dsh/magpie/bin` 的二进制、webKey 与运行状态全部保留（重装即用，跨 profile 共享）。彻底清除：

```sh
rm -rf ~/.dsh/magpie
```

## 开发

```sh
npm install          # 需要网络；npm 缓存权限有问题时加 --cache /tmp/dsh-npm-cache
npm test             # vitest
npm run typecheck    # tsc --noEmit
npm run build        # tsc + 客户端 esbuild → lib/
```

本地目录安装不跑 `prepare`，安装前必须先 `npm run build`。

## 致谢

反向代理与进程桥的设计蓝本是 [Betsy20/dsh-magpie](https://github.com/Betsy20/dsh-magpie)（MIT），见 `NOTICE`。

## License

MIT
