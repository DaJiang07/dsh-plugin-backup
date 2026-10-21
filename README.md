# 插件与设置备份 / Plugins & Settings Backup

一个 DSH 插件：把「你装了哪些插件」和「你把设置调成了什么样」打包成一个 JSON 文件，换电脑后装上本插件、选中那个文件，就能一键恢复。打开**打包全部**，连本地插件源码和插件数据一起走。

A DSH plugin that packs the plugins you installed and the settings you tuned into one JSON file, so a new computer reaches the same state in one click. The **pack everything** switch also carries local plugin sources and plugin-owned data.

## 它保存什么

| 内容 | 来源 |
| --- | --- |
| 全部设置 + 插件开关 | `<profile>/cordis.patch.yml`（配置层，原样保存） |
| 插件包选择与版本 | `<profile>/package.json` 的 `dsh.profile.bundles` 与 `dependencies` |
| 用户设置文档（可选） | `$DSH_HOME/settings.yaml` |
| 插件清单（诊断用） | `ctx.pluginManager.listPlugins()` / `listBundles()` |

打开「打包全部」后额外带上：

| 组 | 内容 |
| --- | --- |
| `plugin-source` | `package.json` 里 `link:` / `file:` / 绝对路径依赖的**整个目录**（本地插件的源码，跳过 `node_modules`、`.git` 等） |
| `home-data` | `$DSH_HOME` 下插件自己的状态：`settings.yaml`、`dream-skin.json`、`dsh-market`、`dshm`、`engram`、`synapse`、`storages`、`data`、`skills` |
| `profile-data` | profile 目录里的插件状态：`.dsh-market` |

**永不打包**：`.credentials.yaml`、`sessions`、`attachments`、`profiles`、`plugin-backups`、`node_modules`、`.git`。

单文件上限 8 MiB，整包上限 96 MiB；超出的文件会写进报告的 `skipped`，不会静默丢掉。

## 恢复做什么

1. 先把当前配置存成 `$DSH_HOME/plugin-backups/pre-restore-<时间>.json`（可以再恢复回来）。
2. 写回 `cordis.patch.yml`；备份里带 `settings.yaml` 时一并写回。
3. 有 `package` 时：先恢复本地插件源码——原目录还在就写回原处，不在就解到 `$DSH_HOME/plugin-sources/<包名>` 并 `link` 进 profile；再恢复插件数据，**每个数据根目录先整块移到** `plugin-backups/pre-restore-data-<时间>/` 再写入新内容。
4. 启用备份里记录、但本机还没启用的插件包。
5. 备份里有、本机没装的网络插件包不在这里装（安装很慢），而是返回给页面，由页面逐个调用 `pluginManager.installBundle()` 并显示进度。
6. **不删除**本机多出来的插件包，只在报告里列出来。

## 界面

设置（Settings）→「备份与恢复」：

- 备份（勾选「打包全部」）并下载，同时存一份到 `$DSH_HOME/plugin-backups/`。
- 从文件恢复（≤ 40 MiB 走浏览器上传）。
- 按路径恢复：Host 直接读硬盘上的文件，多大的全量备份都能恢复。
- 本机备份列表（标出「恢复前存档」和「全量」），点一下即可恢复。

## 接口

Host 端只注册一条需要登录的 Web 路由 `/dsh-plugin-backup`（复用 `ctx.connection` 的 Host/Origin 与浏览器登录校验）：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/status` | 当前 profile、文件大小、插件统计、可打包根目录、本机备份列表 |
| GET | `/export?full=1` | 生成快照（`full=1` 带 package），同时存一份到 `$DSH_HOME/plugin-backups/` |
| POST | `/restore` | 应用快照（`{ snapshot }`，body ≤ 64 MiB） |
| POST | `/restore-path` | 按路径应用备份（`{ path }`，≤ 256 MiB） |
| POST | `/restore-local` | 应用本机备份（`{ file }`） |
| POST | `/install` | 装一个缺失的网络插件包（`{ spec }`） |

快照带 `format: "dsh-plugin-backup"`、`version: 2`；`version: 1`（只有配置、没有 package）的旧备份照样能恢复。

## 已知限制

- 备份里不含凭据（API Key、登录状态）和对话记录，换机器后需要重新登录/填 Key。
- 插件**代码本身**不随备份走，除非打开「打包全部」——而且只覆盖 `link:`/`file:` 的本地插件；registry 包恢复时按版本重装。
- 页面按根路径请求 `/dsh-plugin-backup`；如果把 DSH 挂在反向代理的子路径下，需要相应调整 `client.js` 里的 `BASE`。
- 恢复只做「加」不做「减」：本机多出来、备份里没有的插件包会保留并列在报告里。
- 需要安装脚本的包不会自动批准，要在「插件」页面手动同意。
- 数据根目录是被整块替换的：恢复完成后它们的内容就等于备份里的那一刻，恢复后新产生的状态不会合并进来（旧内容在 `pre-restore-data-*` 里）。

## 安装

```powershell
# 在 DSH 里，把本目录作为本地 bundle 安装：
# plugin_manager install_bundle，target 为本目录绝对路径
```
