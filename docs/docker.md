# SnowLuma Docker 自动部署与原版网页登录

本页是 **SnowLuma Docker**，不是 NapCat。镜像、QQ 及上游条款不在插件 MIT 授权内。请先审阅 [官方 Docker 指南](https://snowluma.github.io/zh/docs/guide/deploy/docker)、所选版本的许可与部署要求；需要书面部署授权的，应先独立取得。安装确认参数不代替授权，也不会替你接受协议。

## 1. 先看计划，再执行

宿主机需要 Linux、Docker 和 Node.js 22.13 或更新版。脚本固定使用本机 `unix:///var/run/docker.sock`，不跟随远程 Docker context；不支持把本机目录检查用于远程 daemon。全新部署通常需管理员权限以创建目录并设置专用 UID/GID；目标目录的直接父目录须已存在、由 root 或执行者所有且不可被其他用户写入，不接受符号链接或不可信可写祖先。本脚本不安装 Docker，不执行远程 shell，不捆绑镜像，不改宿主机 sysctl。

```bash
node scripts/install-snowluma-docker.mjs --help
node scripts/install-snowluma-docker.mjs --plan
```

默认计划离线、只读，不操作 Docker，也不生成目录。安装须显式确认，并提供你已核实的 `motricseven7/snowluma@sha256:…` 完整镜像摘要；不是直接相信可变 `latest`。先阅读[脚本](../scripts/install-snowluma-docker.mjs)及其实际 `--help`，不要原样执行占位命令。

新部署使用全新独立数据目录；已有容器使用显式接管检查，不重建、不覆盖登录状态和密码。默认只创建，只有显式 `--start` 才启动。脚本不会停止冲突后端；请先停止你确认不用的 QQ / 原生服务，避免同账号多实例。

```bash
# 镜像摘要由你从可信来源核实；不要使用下面的占位值。
IMAGE='motricseven7/snowluma@sha256:REPLACE_WITH_VERIFIED_64_HEX_DIGEST'

# 接管已有实例：只读核对，原端口若公网发布须明确承认这个既有风险。
node scripts/install-snowluma-docker.mjs --check --adopt-existing \
  --image "$IMAGE" --container snowluma --allow-existing-public-ports

# 核对通过后显式恢复原实例；不重建、不更新镜像、不改密码/卷/重启策略。
node scripts/install-snowluma-docker.mjs --install --confirm-install \
  --adopt-existing --image "$IMAGE" --container snowluma \
  --allow-existing-public-ports --start

# 全新部署：独立目录必须不存在，且需先独立取得所需部署授权。
# 默认为仅创建；已缓存镜像才可用。确需拉取时加 --pull。
node scripts/install-snowluma-docker.mjs --install --confirm-install \
  --confirm-authorized-deployment --allow-qq-injection-risk \
  --image "$IMAGE" --data-dir /absolute/new-snowluma-state
```

`--uid` / `--gid` 默认 59999，仅用于全新状态；容器由上游入口以 root 初始化后切至专用用户。新建的 `data/config/onebot.json` 有独立随机 HTTP / WS token，文件权限 0600；只在本机由管理员受控查看并配置客户端，勿把内容贴到聊天。`--http-port` / `--ws-port` / `--webui-port` / `--desktop-port` 可指定宿主端口，容器内仍为 3000 / 3001 / 5099 / 6081。

新部署禁用 hook 自动加载且不创建协议同意文件；原版桌面能启动不等于网关注入/OneBot 已开启。请由操作者按原版流程审阅条款和完成网关配置。脚本不声称全新镜像已经过本机完整登录验收；本机旧实例只验证接管恢复路径。

SnowLuma 注入 QQ 需要 `SYS_PTRACE` 与 `seccomp=unconfined`，隔离会减弱，脚本须显式确认此风险。不使用 `--privileged`，不挂 Docker socket，不修改宿主机 ptrace 策略。新容器默认 OneBot 3000/3001、WebUI 5099 和桌面 6081 都只发布到 loopback；普通远程网页需明确选择公开桌面 6081，并自行限制访问来源。HTTP 远程桌面可能被窃听，密码鉴权不等于加密。

## 2. 对应实例的按钮配置

在 DSH 插件配置设置：

```yaml
gatewayBackend: snowluma
snowLumaMode: docker
snowLumaContainer: snowluma
# 如需状态信息，填写真实已有 compose 的绝对路径；不是另一实例的文件。
snowLumaComposeFile: /absolute/deployment/compose.yml
```

保留原机器人 `dataDir`。机器人连接配置使用 `onebot.gateway: snowluma`，HTTP / WS 地址和 token 与当前 SnowLuma 实例一致；不要复制 NapCat 端口或创建重复机器人。

刷新当前 DSH 页面，打开 **设置 → QQ 机器人**：

1. 点 **复制远程桌面密码**。只由已认证浏览器显式读取当前所选容器的实际 VNC 密码，并核对密码文件；不猜默认密码，不把密码放到模型工具、状态、日志或链接里。
2. 点 **打开 QQ 登录页**。插件查询同一个容器的 `6081/tcp` 实际宿主映射，再跳到同主机对应端口的原版 `/vnc.html?autoconnect=1&resize=scale`，不是 SnowLuma 管理后台 5099，也不是 NapCat 6099。
3. 在原版 noVNC 的密码框粘贴 **VNC 密码，而非 QQ 密码**，再操作 QQ 扫码/确认。剪贴板权限不允许时，面板提供短时手动复制；临时显示值 30 秒后或离开面板时清除。

DSH 登录只保护密码复制和跳转入口；目标原版桌面依赖自身 VNC 密码及网络规则，不继承 DSH Cookie 或临时会话限制。`Connected (unencrypted)` 表示未加密，不表示密码错误。不要为去掉该提示关闭 VNC 鉴权，不要把任何密码发到聊天。

## 3. 数据和验证边界

- 旧部署的 `qq-gateway-data`、`qq-client-config`、`qq-client-data` 三个卷都须保留。已有容器接管不改变卷、镜像、端口或密码；若原本公网发布，接管也不会悄悄将其变成仅本机。
- 不重置持久化 VNC 密码，不伪造 `consent.json`，不自动接受新版条款。SnowLuma WebUI 的账号密码与 VNC 密码不同，不从哈希猜密码。
- 新容器不记录原始 Docker 日志，避免首启凭据落日志；不要把 `docker inspect` 的完整 Env、原始启动日志或私有配置复制到聊天。该选择会减少排障日志，需用受控、脱敏方式排查。
- 页面 200、容器 running、密码校验或离线测试均不代表 QQ 已在线。登录后再核实真实账号、HTTP / WS 与真实收发。未经人工确认，不能把验收结果写成完成。

既有 SnowLuma 无需升级镜像或重建容器才能使用这两个按钮。新脚本不会被插件安装、激活或登录按钮隐式执行。
