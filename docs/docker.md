# SnowLuma 一键部署与原版网页登录

这是 **SnowLuma Docker**，不是 NapCat。先审阅[上游 Docker 指南](https://snowluma.github.io/zh/docs/guide/deploy/docker)、所选版本许可及部署要求；需要书面部署授权的，应独立取得。镜像、QQ 和上游条款不在插件 MIT 授权内，点击确认不代替授权或协议同意。

## 1. 先用设置页按钮

打开 **DSH 设置 → QQ 机器人 → 接入与部署 → 一键部署 SnowLuma**：

1. 看宿主系统、Docker 状态、所选容器和镜像摘要。目标是**运行 DSH 的宿主机**，不是浏览器电脑；Windows 浏览器连接 Linux DSH 仍部署在 Linux。
2. 所有许可框默认不勾选。核实部署授权和注入风险；缺少 Docker 时另勾选允许安装，Windows 需要准备 WSL2 时另行勾选。公开桌面及复用已有公网映射也各有独立确认。
3. 点 **一键部署 SnowLuma** 并确认。显示实际阶段、耗时和安全摘要，不显示虚构百分比。已有配置同名容器核对后复用，停止的仅启动，不重建、不更改镜像、密码、卷、端口或登录状态；不自动停止冲突的其他 QQ / 原生服务。
4. 若提示本人操作，先完成宿主机步骤，刷新状态，再点 **已完成手动步骤，继续** 并再次确认。继续只沿用原授权，不增加许可；缺少 WSL2 授权时，勾选后重新开始，或请管理员手动准备。关闭页面只停止查看，不取消宿主任务；重启 DSH 后先刷新核查再开始，不假定旧任务可恢复。
5. 完成后按下节登录并检测 OneBot；容器运行不等于 QQ 在线。新建实例禁用 hook 自动加载、不创建协议同意文件，须本人按 SnowLuma 原版流程审阅条款、配置网关及完成登录。

部署仅通过**已认证的 DSH 浏览器**入口操作，写操作要求同源 JSON POST；没有模型部署工具。插件安装、激活、打开设置或登录按钮都不会隐式安装 Docker 或执行部署。

### 缺少 Docker / 引擎未就绪

| DSH 宿主 | 实际支持与需要你做的事 |
| --- | --- |
| Linux | Docker 安装仅支持 Debian / Ubuntu：显式允许后通过 apt 安装发行版 `docker.io`，并由 systemd 启用、启动 Docker。须 root 或可用 `sudo -n`；页面不收集管理员密码，不静默加 Docker 用户组。DSH 进程仍须有 socket 权限，权限不足请管理员处理后重试。其他发行版手动准备 Docker。 |
| Windows | 支持符合检查条件的 Windows 客户端和 **Docker Desktop Linux 容器引擎**，不是 Windows 容器或远程 daemon。需可用 winget、硬件虚拟化及 WSL2 ≥ 2.1.5；版本检查包括 Windows 10 build ≥ 19045、Windows 11 build ≥ 22631，ARM64 需 build ≥ 26100，不代表替代 Docker 当前支持政策。安装通过可见 UAC / winget / 安装器完成；请在宿主桌面亲自处理许可、订阅、首次启动和切换 Linux 引擎。 |

Windows 的 WSL 准备需**单独允许**，执行 `wsl --install --no-distribution --no-launch`，不安装 Linux 发行版、不代接受发行版许可。固件虚拟化、WSL 手工设置、UAC 拒绝、待重启、Docker Desktop 条款或引擎未启动都会保留人工处理边界；页面不替你重启、不绕过 UAC、不自动接受协议。无交互桌面或 winget 不可用时，请管理员手动安装。看到“已安装”不代表引擎就绪，更不代表 SnowLuma / QQ 已登录。

Docker 固定连接宿主本地端点：Linux `unix:///var/run/docker.sock`，Windows `npipe:////./pipe/dockerDesktopLinuxEngine`，不跟随远程 context。UI 新建部署在两种宿主都使用**三个全新独立 Docker 命名卷**，私密配置经 tar 标准输入写入，不落 Windows NTFS bind mount 或命令行参数。失败后保留新状态供管理员检查，不自动删卷重试；已有实例不会重置。

新建部署只使用 `motricseven7/snowluma@sha256:…` 固定摘要，可在页面核实 / 修改受支持的完整摘要，不使用浮动 `latest`。OneBot 3000/3001、WebUI 5099、桌面 6081 默认仅 loopback；远程网页若需直达原版桌面，须明确授权公开桌面并自行限制访问来源。SnowLuma 需要 `SYS_PTRACE` 和 `seccomp=unconfined`，会减弱隔离；不使用 `--privileged`、不挂 Docker socket、不修改宿主 sysctl。

## 2. 登录、数据与现有实例

部署选中的后端写入原 `dataDir` 下的 `gateway-deployment.json`，优先于旧插件的后端 / 模式 / 容器选择；不要换数据目录或另开机器人。选择生效后，**复制远程桌面密码**和**打开 QQ 登录页**使用同一个所选容器，不会复制 A 的密码再打开 B。新建部署保存本机 OneBot 地址及随机 token，保留模型、人设和归档；已有实例沿用原接入配置，若地址 / token 不符请手动核对后检测保存。

1. 点 **复制远程桌面密码**：已认证浏览器显式读取实际 VNC 密码，不猜默认密码、不向模型工具、状态、日志或 URL 提供密码。
2. 点 **打开 QQ 登录页**：查询该容器 `6081/tcp` 的实际宿主映射，进入同主机原版 `/vnc.html?autoconnect=1&resize=scale`，不是 SnowLuma 管理后台 5099 或 NapCat 6099。
3. 在 noVNC 密码框粘贴 **VNC 密码，不是 QQ 密码**，然后本人操作真实 QQ。剪贴板受限可短时手动复制；界面临时值 30 秒后或离开面板时清除。
4. 人工完成上游条款 / hook 配置及 QQ 登录，检测 HTTP / WS，保存接入配置并按提示重启机器人，最后核实真实账号和收发。

DSH 认证只保护密码复制及跳转入口；目标桌面依赖原版 VNC 密码与网络规则，不继承 DSH Cookie 或临时会话限制。普通 HTTP 的 **Connected (unencrypted)** 是未加密警告，不是认证失败；画面、输入和密码可能被窃听或篡改。不要为去掉提示关闭鉴权，不要把 VNC / QQ 密码、完整 Env、私有配置或启动日志贴到聊天。

仅沿用旧配置且未使用一键选择时，可在插件配置设置 `gatewayBackend: snowluma`、`snowLumaMode: docker`、`snowLumaContainer` 为实际容器名；如需 compose 状态再填写真实已有 `snowLumaComposeFile`，不是另一实例的文件。旧部署的 `qq-gateway-data`、`qq-client-config`、`qq-client-data` 三个卷必须保留；复用旧公网端口须显式确认，程序不会悄悄改变原访问规则。

## 3. 手动 CLI：先计划，再安装

需要自行审计 / 运维时使用[独立脚本](../scripts/install-snowluma-docker.mjs)，Node.js ≥ 22.13。**CLI 不安装 Docker**，前置依赖安装是上方设置页的独立授权流程。先看实际帮助，默认计划离线只读，不操作 Docker、不创建目录：

```bash
node scripts/install-snowluma-docker.mjs --help
node scripts/install-snowluma-docker.mjs --plan
```

安装必须提供核实过的完整镜像摘要及确认参数；不要原样执行占位值。

```bash
IMAGE='motricseven7/snowluma@sha256:REPLACE_WITH_VERIFIED_64_HEX_DIGEST'

# 接管检查是只读的；原本公网发布时才明确添加风险确认。
node scripts/install-snowluma-docker.mjs --check --adopt-existing \
  --image "$IMAGE" --container snowluma --allow-existing-public-ports

# 显式恢复已有实例，不重建、不更新镜像、不改密码或卷。
node scripts/install-snowluma-docker.mjs --install --confirm-install \
  --adopt-existing --image "$IMAGE" --container snowluma \
  --allow-existing-public-ports --start

# Linux CLI 默认独立 bind 目录；必须不存在，先取得所需部署授权。
# 默认仅创建，已缓存镜像才可用；确需拉取加 --pull，启动另加 --start。
node scripts/install-snowluma-docker.mjs --install --confirm-install \
  --confirm-authorized-deployment --allow-qq-injection-risk \
  --image "$IMAGE" --data-dir /absolute/new-snowluma-state
```

Linux CLI 可显式用 `--named-volumes` 代替 `--data-dir`；Windows 仅命名卷，省略 `--data-dir`。Linux bind 路径的直接父目录须已存在、属 root 或执行者且不可被他人写入，不接受符号链接或不可信可写祖先；创建目录及专用 UID/GID 通常需管理员权限。`--uid` / `--gid` 默认 59999，仅用于新状态；上游入口以 root 初始化后切到专用用户。新建 `data/config/onebot.json` 有独立随机 HTTP / WS token、权限 0600，只由本机管理员受控查看。端口可用 `--http-port` / `--ws-port` / `--webui-port` / `--desktop-port` 指定，容器内部仍为 3000 / 3001 / 5099 / 6081。

## 验证边界

- 不重置持久化 VNC 密码、不伪造 `consent.json`、不自动接受新版条款；SnowLuma WebUI 密码也不是 VNC 密码，不从哈希猜密码。
- 新容器不记录原始 Docker 日志，防止首启凭据落日志；这会减少排障信息，请使用受控脱敏方法。
- 页面 200、容器 running、配置写入及离线测试都不证明 QQ 在线；登录和真实收发须人工验收。
- 0.8.0 本机 Node.js 22 完整测试 742 项通过，发布清单 / 相对导入审计通过；隔离包 Host 导入及部署 / 登录相关 288 项测试通过。当前 Linux 旧实例 HTTP / WS 接入正常，部署路由匿名访问返回 401。没有连接中的浏览器可做界面实见验收。
- 本次不声称真实 Windows 执行、干净宿主 Docker 安装、全新 SnowLuma 启动 / 登录已验证；模拟安装测试及原有 Linux 实例的接管经验不能代替这些验收。
