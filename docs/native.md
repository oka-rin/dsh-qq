# 原生安装与 Docker 迁移

本指南用于 **Debian/Ubuntu、systemd、x86_64/arm64** 的全新原生部署。脚本准备官方原版 SnowLuma **v2.4.0 完整包**、用户提供的原版 QQ、专用账号和 systemd unit；不使用第三方网关、不修改上游代码、不下载猜测地址的 QQ。

**安装准备 ≠ 登录成功 ≠ 迁移完成。** 未完成人工扫码及端到端验收前，不应宣称已迁移或机器人在线。脚本不会接受条款、扫码、启动或启用服务，也不会停止 Docker、复制登录态或删除卷。已有后端可继续使用，无须为更新插件强制迁移。

## 1. 审核来源和计划

从可信来源取得本仓库，在仓库根目录运行。先阅读[安装脚本](../scripts/install-native.sh)、[SnowLuma v2.4.0 发布页](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.4.0)、[EULA](https://github.com/SnowLuma/SnowLuma/blob/v2.4.0/EULA.md)、[隐私政策](https://github.com/SnowLuma/SnowLuma/blob/v2.4.0/PRIVACY.md)和 QQ 条款，核对来源、版本兼容性及你的使用/部署权限；不确定时先向上游确认。插件 MIT 不替代上游授权，`--confirm-install` 也不代表同意条款。

```bash
bash scripts/install-native.sh --help
bash scripts/install-native.sh --plan
```

不传模式也默认 `--plan`：只读、离线，不创建临时文件，不安装依赖、不改配置、不操作服务。计划不是完整兼容性或登录验收。带本地来源参数时，路径必须已存在。

准备以下 QQ 来源之一：

- **`--qq-dir`**：原版 QQ 目录，内含可执行的普通文件 `qq`；整个代码树须 root 所有、不可由组/其他用户写入，父目录也须可信，符号链接不可逃逸目录。脚本会复制它，不改原目录；不要把可被普通用户修改的代码直接交给具有注入权限的服务。
- **`--qq-deb` + `--qq-deb-sha256`**：由你从可信来源取得并审核的原版 `linuxqq` 包，架构须匹配。必须提供**从独立可信来源取得的完整 64 位 SHA-256**，不是下载后随手计算一个值便能证明来源。脚本只解出应用目录，不执行包脚本、不运行 `dpkg -i`、不全局安装 QQ。

所有输入路径须为简单绝对路径，无空白、符号链接路径或 `.` / `..` 段。不要把示例占位路径当成实际来源，也不要把登录数据或秘密打进安装包。

## 2. 显式准备安装

以下使用你已经审核、满足权限要求的 QQ 目录；先替换路径并预览：

```bash
bash scripts/install-native.sh --plan --version v2.4.0 \
  --qq-dir /absolute/original/QQ --with-vnc

sudo bash scripts/install-native.sh --install --confirm-install \
  --version v2.4.0 --qq-dir /absolute/original/QQ \
  --install-deps --with-vnc --no-start
```

使用 `.deb` 时改用这一组互斥参数（先替换路径和哈希；以下命令不会自动生成可信哈希）：

```bash
sudo bash scripts/install-native.sh --install --confirm-install \
  --version v2.4.0 --qq-deb /absolute/linuxqq.deb \
  --qq-deb-sha256 "$TRUSTED_QQ_SHA256" \
  --install-deps --with-vnc --no-start
```

- `--install --confirm-install`：授权本次机器改动，须 root；不代接受任何协议。
- `--version v2.4.0`：必须显式指定；只支持这个审核版本，不取 `latest`。
- `--install-deps`：允许从系统已配置的 apt 源更新索引并安装缺失依赖，包含桌面运行库、媒体工具 `ffmpeg` / `ffprobe`、窗口检测工具 `xwininfo` / `xprop` 及内嵌登录桌面所需的 **x11vnc**；后者不以 `--with-vnc` 为条件。省略时缺依赖会报错；脚本不添加第三方 apt 源。
- `--with-vnc`：额外准备独立的 **x11vnc 服务**，供原生 VNC 客户端远程看桌面。安装器不部署独立 noVNC 站点或浏览器桌面 `6081`；这不影响插件自带的[内嵌登录窗口](#在插件内人工登录-qq)。需要独立桌面访问作为后备时可选择此项。
- `--qq-no-sandbox`：仅在用户命名空间不可用、已审核风险时显式选择，关闭 QQ 的 Chromium sandbox，**会降低隔离安全性**。默认不加，启动失败也不会悄悄回退；优先解决主机兼容性或选择隔离部署，不为此修改全局 sysctl。
- `--no-start`：明确写出默认行为；没有 `--start` 模式。结束只执行 `systemctl daemon-reload`，不启动、不启用开机自启。
- 可选 `--archive /absolute/SnowLuma-v2.4.0-linux-x64.tar.gz`（arm64 使用相应包）：使用预先取得的官方完整归档，仍需联网读取精确版本的官方 GitHub API 元数据并核对 SHA-256，**不是离线安装或跳过校验**。默认从同一官方发行页下载完整包；不接受 lite 包、缺失摘要或哈希不匹配。

安装器校验完成后建立：

| 位置/对象 | 用途 |
| --- | --- |
| `/opt/snowluma` | root 所有的原版完整运行时、自带 Node、QQ 副本，服务用户不可修改代码 |
| `/var/lib/snowluma` | 专用账号的 HOME、配置及运行数据；按敏感登录数据保护 |
| `snowluma` | 非 root、不可交互登录的系统账号 |
| `snowluma.target` | 统一管理下列服务的 system target |
| `snowluma-xvfb.service` / `snowluma-fluxbox.service` | 私有显示 `:99` 与窗口管理器 |
| `snowluma-client.service` / `snowluma-gateway.service` | 原版 QQ 与 SnowLuma |
| `snowluma-vnc.service` | 仅 `--with-vnc` 时创建，监听 loopback `5901` |

只有 gateway unit 获得 systemd 范围内的 `CAP_SYS_PTRACE`，用于注入；这仍是敏感权限，只运行可信原版代码。脚本不对系统 Node 运行全局 `setcap`，不调整 sysctl/hosts，也不授予整个 DSH root 权限。

目标目录、账号、组、同名 unit 或显示 `:99` 已存在时拒绝继续；这不是升级器或覆盖式迁移器。中断后须人工检查已创建对象，**不要为重跑脚本直接删除数据**。

## 3. 人工启动、同意条款、登录

### 先限制网络，再启动

管理页不应暴露公网。脚本配置 OneBot HTTP `127.0.0.1:3000`、WS `127.0.0.1:3001/event`，为它们生成随机 token；WebUI 期望使用 `127.0.0.1:5099`。**实际上游版本是否遵守 WebUI host 设置，必须在启动后检查**，不能只信配置。启动前保持主机防火墙/云安全组拒绝外部访问这些端口及 VNC `5901`；不要关闭现有防火墙。

审核安装后的 EULA、隐私政策、QQ 版本和生成的 unit，准备好自行完成协议提示及登录后：

```bash
sudo systemctl cat snowluma.target snowluma-gateway.service snowluma-client.service
sudo systemctl start snowluma.target
sudo systemctl status snowluma.target snowluma-gateway.service snowluma-client.service
sudo ss -ltnp
```

若管理页或 OneBot 出现非 loopback 监听，先 `sudo systemctl stop snowluma.target`，排查并修正后再访问。`systemctl status` 成功也不等于 QQ 已登录。诊断使用 `sudo journalctl -u snowluma-gateway.service -n 80 --no-pager`；日志可能含 QR、管理认证信息，不要原样公开。

### 通过 SSH 保护管理页和桌面

在**你的个人电脑**建立隧道，替换 SSH 用户和主机；显式绑定个人电脑的 loopback：

```bash
ssh -N -L 127.0.0.1:5099:127.0.0.1:5099 \
  -L 127.0.0.1:5901:127.0.0.1:5901 USER@HOST
```

- 本机浏览器打开 `http://127.0.0.1:5099`，按原版上游流程由你亲自审核和确认协议/隐私提示；脚本没有写入自动同意环境变量。管理认证信息留在受保护的主机/SSH 会话内。
- 安装时选了 `--with-vnc` 才能使用 VNC 客户端连接 `127.0.0.1:5901`。VNC 随机密码保存在服务主机的 `/var/lib/snowluma/vnc-password.txt`（0600），由授权管理员私下读取；不要复制到聊天、截图或命令历史。只使用 SSH 隧道，密码不能替代传输加密。
- 在 QQ 桌面人工扫码或用账号/密码登录；在上游 WebUI 审核并执行注入。初始 `hookAutoLoad=false`，不会自动注入。完成协议提示后若上游要求重启，再人工重启相应服务。
- 没选独立 VNC 服务时，可使用下述插件内嵌登录窗口，或你自行审核的受保护显示方案；不要误用 Docker 示例里的 noVNC 地址，也不要把 X11 开放到网络。

检查账号、HTTP 动作和事件流可用后，再决定是否 `sudo systemctl enable snowluma.target`；安装器本身不会启用。首次排错期间不建议先启用自启。

### 在插件内人工登录 QQ

在 **DSH 设置 → QQ 机器人 → 原生接入** 查看登录面板。SnowLuma 当前没有可用的 QQ 二维码/QQ 密码 HTTP 登录 API；上游 WebUI 的 `/api/login` 是管理页认证，**不是 QQ 账号登录**。插件不提供独立的 QQ 密码表单或凭据 API。

- **二维码窗口**：只解码真实 QQ 登录窗口内的二维码，再显示可供手机扫描的图像；仅接受精确的 `https://txz.qq.com/p` 地址及 `k`、`f` 参数。此地址族依据公开 NTQQ 资料，不能代替当前实例实测。未解码出有效二维码会明确提示，不根据日志、Token 或猜测 URL 生成二维码；扫码、续码和确认仍由你在真实 QQ 中完成。
- **打开 QQ 登录窗口**：在已认证的同源 DSH 会话中嵌入本机 noVNC，亲自操作真实 QQ 的账号/密码、扫码刷新和验证码。只允许 HTTPS 或 loopback 页面进入；查看窗口不会启动服务、安装后端、接受条款、自动输入密码或宣称登录成功。

反向代理挂在 `/dsh/` 等目录时，插件沿页面 document.baseURI 发送请求，避免旧 `Path=/dsh/` 凭证在网站根接口丢失。若仍提示 DSH 凭证失效，请在同一站点私下重开你保存的 DSH 启动登录链接再刷新，勿将 Token/Cookie 发进聊天。公网明文 HTTP 不允许交互密码窗口；可在个人电脑执行 `ssh -N -L 127.0.0.1:3080:127.0.0.1:3080 USER@HOST`，在本地浏览器打开 `http://127.0.0.1:3080` 并用该地址的 DSH 启动登录链接认证，或部署可信 HTTPS。二维码读取不等于允许在公网 HTTP 输入密码。

**先准备运行中的 QQ 和显示环境。** 二维码捕获需要 `ffmpeg`、`xwininfo`、`xprop`；交互桌面还需要 `x11vnc`。新安装器会将 `x11vnc` 纳入基础依赖，已有部署须由管理员检查补齐。DSH 运行账号需要访问指定显示和 Xauthority 文件的最小权限，不要为此授予整个进程 root 或开放 X11 网络访问。

| 部署 | 显示配置 |
| --- | --- |
| 原生 | `snowLumaDisplay` 默认 `:99`；`snowLumaXauthority` 默认 `/var/lib/snowluma/.Xauthority`，按实际部署修改 |
| 已有 Docker | 使用容器已有显示 `:1`，不是原生的 `:99`；继续使用原容器，不会自动迁移或启动 |

内嵌桌面通过 `x11vnc -inetd` 管道转发，不新增外部 TCP 监听端口，无须暴露 `5901` / `6081`。仅绑定经验证的 QQ 窗口 ID（`-id`），不是任意桌面入口；但 **共享 X11 上的输入并不隔离**，强烈建议专用 Xvfb 显示。验证码如果另开顶层窗口，可能不在捕获范围内，需退回经 SSH 保护的完整桌面处理，不能因此扩大为无保护的任意桌面。

**凭据边界**：不要把 QQ 密码发进聊天、模型提示或工具参数。插件不保存或记录账号/密码，也不将其交给模型/工具；交互输入经浏览器和本机 VNC 传输进入真实 QQ，后端必须处理该输入，**不是端到端加密到 QQ、对主机不可见**。仅在你信任的主机、管理员和浏览器会话中使用；保护桌面截图、二维码、会话及日志。

打开面板、看到二维码或成功连接桌面都不等于 QQ 已登录。以实际账号状态、OneBot HTTP/WS 和真实消息收发共同验收；本次开发机器原生服务未运行、Docker 仍待登录，尚无当前实例二维码成功解码或迁移成功结论。

## 4. 在 DSH 中接入

在「设置 → QQ 机器人 → 原生接入」填写：

| 字段 | 默认准备值 |
| --- | --- |
| HTTP | `http://127.0.0.1:3000` |
| WebSocket | `ws://127.0.0.1:3001/event` |
| OneBot Token | 私下读取 `/var/lib/snowluma/gateway/config/onebot.json` 中的 `accessToken`，不要共享文件 |
| 模型 | 你自己的接口、模型名、API key |

DSH 与后端不在同一主机时，先建立受保护的本机转发；首次配置向导仅接受 loopback OneBot 地址。更完整的字段、安全限制见[首次配置向导](./advanced.md#首次配置向导)。

检测、保存后重启机器人，使用 `snowLumaMode: native`、`snowLumaService: snowluma.target`、`snowLumaServiceScope: system`。DSH 运行账号需要相应 unit 的最小管理权限；不要为了按钮可用授予整个进程无限制 sudo。也可选择 `external`，由管理员手工管理后端。

新安装聊天默认关闭。先限制允许的群，再按需开启聊天/私聊和媒体能力，测试真实消息；连接检查只证明部分 HTTP/WS 行为，不证明模型、全部动作或事件已验收。

## 从 Docker 切换到原生

这是**人工切换流程**，安装脚本不会自动执行。可继续保留 Docker；不要并行运行同账号 QQ 客户端或两个机器人发送实例。

1. **记录与备份**：记录原容器、部署文件、端口、token、插件模式和机器人 `dataDir`。备份配置、`.env`、聊天归档、学习/人物数据库及 Docker 登录卷；对活跃数据库/卷使用一致性备份方式和维护窗口，不公开备份或日志。备份未验证前不要停旧服务或清理卷。
2. **只准备，不启动**：按本指南运行原生安装器。不要把 Docker 运行时/账号数据复制进官方发行包；脚本不导入旧 QQ 登录态，原生端预期重新扫码。若已有同名原生账号/目录/unit，先人工审核，不能强制覆盖。
3. **维护窗口切换**：暂停机器人聊天/发送或停止机器人；检查并暂停会自动拉起旧容器的 supervisor/重启策略。由你确认目标后手动停止原容器，例如 `docker stop snowluma`（只适用于原容器确实叫这个名字）。先确认旧实例停止、默认端口已释放，再人工启动原生 target；脚本从不自动停 Docker。
4. **人工登录与验收**：经受保护的 SSH/WebUI/VNC 完成协议提示、扫码、注入和 OneBot 认证。确认是正确账号、端口只在 loopback、HTTP/WS 同属新实例。**停在二维码就是待登录，不是迁移成功。**
5. **切换插件**：保持原机器人 `dataDir` 不变，将后端模式改为 `native`（或 `external`），HTTP/WS/token 指向新实例；保存并重启机器人。新安装产生的 token 通常与 Docker 不同，不要盲目沿用。测试事件流、允许群/私聊、收发消息和所需媒体，并核对历史/学习数据仍可读。
6. **保留回滚**：验收后再按需启用原生自启。保留旧容器、部署文件、登录卷和备份，确认没有两个自动启动入口。不要运行 `docker compose down -v` 或删除卷。

**回滚**：先停机器人发送和 `sudo systemctl stop snowluma.target`；若启用过自启再禁用该 target。确认原生 QQ/网关已停止、端口释放后，以原管理器启动旧容器，恢复插件 `snowLumaMode: docker`、原端点/token 和原数据目录，重启机器人并验证。重新登录或上游登录态变化可能仍需人工扫码；保留容器不保证旧登录永久有效。无需删除原生目录才能回滚。

## 常见问题

- **提示已有目录/账号/unit**：安装器主动拒绝覆盖。调查是旧安装还是本次中断残留，人工审核恢复方案，不要自动删除。
- **GitHub API 无摘要/请求失败**：安装会失败关闭；即使 `--archive` 也不跳过官方摘要。检查网络、限额及固定发行包，不改成来源不明的镜像。真实完整包下载、布局识别和运行仍须以目标机实际结果验收，脚本静态检查不代表这些步骤已成功。
- **等待条款、QR 或未注入**：这是人工步骤，不应添加自动同意标记、伪造登录结果或把 `hookAutoLoad` 当登录替代品。
- **独立 VNC 连接不上**：检查安装时是否选 `--with-vnc`、对应 unit 是否启动、`5901` 是否只监听 loopback 及 SSH 隧道是否建立；安装器不提供独立 noVNC 站点。插件内嵌 noVNC 另走已认证同源通道，检查 HTTPS/loopback、运行中的 QQ、显示/Xauthority 配置及上述依赖。
- **二维码未显示 / 验证码看不到**：未解码出合规的真实 QQ 登录二维码时不会伪造替代图；请打开 QQ 登录窗口刷新。独立顶层验证码窗口可能需要受保护的完整桌面，专用 Xvfb 也不能替代人工验证。
- **systemd 成功但机器人不回复**：依次确认 QQ 登录、注入、OneBot token、WS 事件、模型接口、聊天开关和群范围；参见[高级配置](./advanced.md)。
