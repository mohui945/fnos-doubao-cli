# 逗包 CLI · 飞牛 fnOS 应用（fpk）

> 应用市场里显示的名字是「逗包 CLI」（开发者 豆包、发布者 老米），内部包名仍是 `doubao`，
> 因此安装目录、命令名、数据目录都保持 `doubao`，升级时不会丢登录态与设置。

把豆包官方 CLI（`@bytedance/doubao-cli` 的原生运行时）打包成飞牛应用中心的原生 fpk：
不需要 Docker，也不需要单独安装 Node.js / Python。

## 提供三种入口

| 入口 | 说明 |
| --- | --- |
| 桌面图标「逗包 CLI」→ 终端 | 通过 fnOS 网关打开 Web 终端，未登录时先显示可扫描的二维码，登录后进入豆包 TUI |
| 桌面图标「逗包 CLI」→ 管理 | ROOT / 普通用户身份切换、切换工作目录、后台服务任务常驻与一键启停、检查并一键升级上游 CLI、一键重启终端、查看运行日志 |
| `doubao` 命令 | 安装到 `/usr/local/bin/doubao`，SSH 登录后可用 `doubao -p "..."`、`doubao --list`、`doubao model list` 等 |
| `doubao-login` 命令 | 在 SSH 终端里把登录二维码渲染成黑白块，手机直接扫屏幕即可 |

Web 终端与管理页只监听应用目录下的 unix socket（`doubao.sock`），由应用中心网关代理，
**不额外开放 TCP 端口**；桌面入口仅管理员可见（`is_admin`）。

## 服务架构

```
cmd/main ──┬─ 有可用 Node.js ─→ node server/server.js  ──┬─ 监听 doubao.sock（网关访问）
           │                                            ├─ 提供「终端 + 管理」页面与 /api/*
           │                                            └─ 子进程管理 ttyd → 反代 /term
           └─ 无可用 Node.js ─→ ttyd 直连 doubao.sock（仅终端，降级模式）
```

- `server/server.js` 只用 Node 内置模块（无 npm 依赖），Node ≥ 16 即可；
  启动时按 `/usr/bin/node`、`nodejs_v24/v22/v20/v18` 的顺序探测。
- 管理页是单文件 `ui/index.html`，前缀由服务端注入（`__BASE__`），无外链资源。
- ttyd 由 server.js 托管：改配置、升级运行时后由它重启，无需重启整个应用。

## 终端运行身份

`term` 每次会话启动时读取 `run-mode`：

- `user`（默认）：降权到安装用户；豆包在 NAS 卷上生成的文件属主正确，登录态与该用户 SSH 会话共用。
- `root`：直接以 root 运行，可读写任何系统文件。

降权用 `runuser` 而非 `su -`：ttyd 以 root 创建 PTY，`term` 先把当前 `/dev/pts/N`
`chown` 给运行用户，再降权启动——否则豆包 TUI 打开终端设备会报
`internal_error: 无法连接标准输入 ... Permission denied`。

## 目录结构

```
manifest                应用元数据（appname=doubao, display_name=逗包 CLI, version=2.37.14）
ICON.PNG / ICON_256.PNG 应用图标（豆包官方图标）
cmd/                    生命周期脚本（install / upgrade / uninstall / config / main）
config/privilege        run-as: root（需要读写 NAS 卷并启动 ttyd）
config/resource         资源声明（无端口）
wizard/install          安装向导提示
app/runtime/            豆包 CLI 官方 linux-x64 运行时（自包含，318 MB）
app/server/ttyd         静态编译的 ttyd 1.7.7，负责 Web 终端与 PTY
app/server/server.js    管理服务：管理页 + API + ttyd 子进程 + 终端反代 + 上游升级
app/ui/index.html       桌面页面：终端 / 管理 两个分页
app/ui/config           iframe 入口声明（gatewaySocket / gatewayPrefix）
app/bin/term            Web 终端会话入口：按运行身份降权 → 扫码登录 → 启动豆包 TUI
app/bin/login           扫码登录：调用 `doubao login --qr=png` 并渲染二维码
app/bin/qr2ansi.py      把二维码 PNG 转成终端 ANSI 黑白块（依赖系统 Python + Pillow）
app/bin/runtime-path.sh 解析当前运行时（优先升级版 runtime/current）与运行身份
app/bin/resolve-user.sh 校验/挑选可登录的终端运行用户
app/bin/doubao-cli      SSH 侧命令封装，安装时复制为 /usr/local/bin/doubao
app/bin/doubao-login    SSH 侧登录封装，安装时复制为 /usr/local/bin/doubao-login
scripts/build.sh        fnpack build
scripts/fetch-deps.sh   下载并校验运行时 / ttyd / Pillow / fnos-cli 二进制（不入库）
scripts/patch-runtime.py 给官方运行时注入「权限档位强制」补丁（幂等）
scripts/make-icons.py   生成图标
```

## 管理接口（server.js）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 运行身份、工作目录、ttyd 状态、当前/内置版本、升级进度、后台服务任务状态 |
| POST | `/api/settings` | `{mode:"root"\|"user", workdir:"/vol2"}`，工作目录会 realpath 校验；改动后按新身份重建服务任务 |
| POST | `/api/service` | `{action:"start"\|"stop"\|"refresh"\|"keepalive", enabled:true}` 控制 `doubao --service-start` |
| GET | `/api/list?path=` | 目录浏览（供工作目录选择器使用，跳过 `@`/隐藏目录） |
| GET | `/api/upstream` | 查 npm registry 取最新版本与 linux-x64 运行时地址、SHA-256 |
| POST | `/api/upgrade` | 后台升级：下载 → SHA-256 校验 → 解包 → 原子切 `runtime/current` → 重启 ttyd 与服务任务 |
| POST | `/api/restart` | 重启 ttyd（断开所有终端会话） |
| GET | `/api/log?lines=` | 服务日志尾部 |
| GET | `/term/*` | 反向代理到 ttyd（含 WebSocket upgrade） |

## 后台服务任务（`--service-start`）常驻

豆包 CLI 自带 `--service-start`，会 fork 出 `doubao --type=service-daemon` 的后台服务任务。
本应用把它接成**应用托管的常驻服务**，而不是让用户自己每次开终端手动起：

- 启动时（`server.js` 起来后）自动 `--service-start`，身份和终端会话一致（普通用户 / ROOT），因此共用登录态；
- 用 `detached` spawn 启动，daemon 落在独立会话、fd 指向 `service.log`：关浏览器、退出终端、甚至 node 进程重启都不影响；
- 守护线程每 30 秒 `--service-status` 巡检一次，进程意外退出且「保持后台运行」开着就自动拉起；失败按 30s→900s 指数退避，避免刷日志；
- 切换运行身份或工作目录时，先按**旧身份** `--service-stop`，再按新身份重建（否则会留下旧用户名的孤儿进程）；
- 应用停用 / 卸载时调 `--service-stop`，不留孤儿进程；
- 上游升级后会重启服务任务，确保跑在新二进制上；
- 新身份未登录时启动会失败，页面直接显示「需要先登录」，登录后自动恢复。

状态文件：`${TRIM_PKGVAR}/service-keepalive`（`1` 常驻 / `0` 仅手动），日志：`${TRIM_PKGVAR}/service.log`。


## 构建

仓库只放源码，第三方发布物不入库（运行时 320 MB、Pillow 22 MB、ttyd 与 fnos-cli 二进制），
用脚本按版本下载并校验：

```bash
cd doubao-fpk
./scripts/fetch-deps.sh   # 拉齐 app/runtime、app/server/ttyd、app/pylib、技能二进制，并给运行时打补丁
./scripts/build.sh        # 等价于 fnpack build
```

- `fetch-deps.sh` 会下载：豆包官方运行时（`lf-flow-web-cdn.doubao.com`，约 240 MB）、
  ttyd 1.7.7（GitHub release）、Pillow 13.0.0（pip，装到 `app/pylib`）、
  fnos-cli 0.6.2 linux-x64（GitHub release，带 SHA-256 校验）。
  已存在的组件会跳过，`--force` 可强制重下。
- 打包还需要飞牛的 `fnpack` 命令行（从 fnOS 开发者工具取得，放到 `PATH` 里）。
- 产物：`doubao.fpk`，在飞牛「应用中心 → 手动安装」中上传即可。

## 权限档位只由管理面板决定

手机端、网页端、桌面客户端里选的权限一律不生效，CLI 每次启动由面板注入
`DOUBAO_PERMISSION_MODE`（`ask_always` / `ask_risky` / `always_allow`）强制覆盖：

1. `/usr/local/bin/doubao` 入口先读 `${TRIM_PKGVAR}/permission-mode`，注入该参数并剔除调用方传的同名参数；
2. `server.js` 在 spawn 终端、后台服务任务时把该变量写进环境；
3. `scripts/patch-runtime.py` 给官方运行时的 `entry-cli-router` 与 `entry-cli-chat` 注入 `__DBF`
   （读 `DOUBAO_PERMISSION_MODE`），在会话创建、权限设置、单次对话执行处覆盖原有取值。

第 3 步是重打包时自动执行的，官方运行时升级后若结构变化，脚本会因锚点数量不符而报错退出，
此时需要重新核对补丁位置。

## 运行时来源与升级

- npm 包：`@bytedance/doubao-cli`（仅包含安装脚本与 `artifacts.json`）
- 实际运行时：`https://lf-flow-web-cdn.doubao.com/obj/flow-doubao/doubao_cli/<ver>/doubao-cli-<ver>-linux-x64-signed.tar.gz`
- 安装包内置 2.37.2，避免安装时联网下载，也不依赖 npm 的 postinstall。

**方式一（推荐）**：桌面「管理 → 上游升级」点「检查更新 → 一键升级」。
运行时下载校验后装到 `/vol1/@appdata/doubao/runtime/<version>`，`current` 软链原子切换，
随后自动重启终端；旧版本自动清理，登录态与设置不受影响。

**方式二（重打包）**：替换 `app/runtime/` 内容、同步 `manifest` 的 `version`/`changelog`，
再 `./scripts/build.sh`。`cmd/upgrade_init` 会先停旧进程，`cmd/upgrade_callback` 会刷新命令入口。

## 说明与限制

- 仅支持 x86_64（豆包官方目前只提供 linux-x64 / macOS arm64 / Windows x64）。
- 应用服务以 root 启动 ttyd；若切到 ROOT 运行身份，终端会话同样拥有最高权限，请自行评估风险。
- 登录态保存在运行用户的 HOME（`~/.local/share/doubao_cli` 等），卸载不删除，重装后可继续使用。
- 卸载会清理升级下载的运行时（数百 MB），内置运行时随应用目录一起删除。
- 豆包 CLI 自带权限模式（`--permission-mode ask_always|ask_risky|always_allow`），默认会询问高风险操作。
- 扫码登录需要能访问豆包服务的网络环境；二维码约 2 分钟失效，失效后重新打开桌面入口即可刷新。
