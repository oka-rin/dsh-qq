# dsh-qq

一个 DSH 插件包，内含 QQ 机器人、首次配置向导、控制面板和 28 个 `qq_*` 工具，原生优先连接官方原版 SnowLuma / OneBot v11 后端。安装插件后不需要再为这些工具配置独立的 MCP 子进程。

**“一个插件包”不等于“内置 QQ 协议端”**：SnowLuma 后端、QQ 客户端、登录账号、容器镜像、模型服务均不包含在 npm 包内，也不会随插件自动下载安装。机器人是插件托管的独立 Node 子进程，SnowLuma 是另一个外部服务。

## 当前发布状态与许可

本项目源码及随包原创图标采用 [MIT License](./LICENSE)。源码提供方已于 2026-11-03 确认有权发布并选择 MIT。SnowLuma 后端、QQ 客户端、容器镜像、模型服务、媒体素材及其他外部服务不包含在此授权内，仍须遵守各自许可与使用条款。仓库地址、项目主页和 issue 地址尚未确定，故未填写猜测的 GitHub 链接。

## 0.2.2 接入安全补丁

- 显式禁用环境变量密钥时，向导状态和模型列表检测均不再回退读取旧接口密钥。
- 回归验证：空数据目录、未运行 OneBot 后端时，首次配置向导仍可独立打开，且不会触发安装或部署。

## 能力与边界

- 通过 OneBot HTTP 动作和正向 WebSocket 事件流接入 QQ，支持群聊、私聊、自动回复、主动行为、分享、每日资讯、QQ 空间、成员/群管理、文件、相册、合并转发、聊天归档和人物学习。
- 设置中的「QQ 机器人」面板用于查看状态、会话、决策、日志，发送消息及修改配置；机器人控制台提供约 200 个配置字段。
- 图片理解需要视觉模型；动图/视频抽帧需要 `ffmpeg` 和 `ffprobe`。缺失时相关能力降级，不会自动安装系统软件。
- 生图、嵌入检索、联网/媒体来源、表情图库服务等需要各自可用的外部端点、权限或素材；本包不含这些服务或私人图库。
- 非标准动作（尤其 QQ 空间、群相册和社交扩展）依赖后端实现和账号权限；不能保证任意 OneBot v11 后端提供全部动作。通过 `qq_action_list` 查看动作分类，必要时使用 `qq_raw_action`。

原生工具（28 个）：`qq_setup`、`qq_gateway`、`qq_status`、`qq_list_groups`、`qq_group_members`、`qq_recent_messages`、`qq_history_search`、`qq_archive_stats`、`qq_why_silent`、`qq_lookup_meme`、`qq_people_list`、`qq_person_profile`、`qq_person_learn`、`qq_send_message`、`qq_send_meme`、`qq_draw`、`qq_learn`、`qq_mention`、`qq_set_autochat`、`qq_set_persona`、`qq_action_list`、`qq_qzone`、`qq_admin`、`qq_social`、`qq_file`、`qq_album`、`qq_forward`、`qq_raw_action`。

## 先决条件

1. Node.js **>= 22.13.0**，包含全局 `fetch` / `WebSocket` 和可用的 `node:sqlite`。部分版本仍会显示 SQLite 实验性警告。
2. 支持 Cordis Host/Client bundle、原生 tools 和 Web 设置面板的 DeepSeek Harness。主插件依赖 `@deepseek-ai/dsh-tools`；包管理器负责安装依赖，机器人本体没有第三方 npm 运行依赖。
3. 你已获准运行的 SnowLuma 或兼容的 OneBot v11 后端、可登录的 QQ 账号、HTTP 和正向 WebSocket 地址及 access token。后端安装、登录、二维码确认和服务条款由你负责。
4. 用于自动聊天/学习的 OpenAI 兼容模型服务及 API key；按需准备视觉、生图和嵌入服务。
5. 原生服务管理需要 Linux/systemd 和对目标 unit 的相应权限；不安装或创建 unit。可选：Docker Engine + Compose v2（仅供既有容器兼容模式）；`ffmpeg` / `ffprobe`（动图和视频）。

**两个 Node 版本要求不要混淆**：本插件机器人使用 Node **>=22.13.0**；[SnowLuma v2.3.4 官方发行包](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.3.4)的完整原生包推荐使用其自带 Node，lite 包另需 **`^24.22.1 || >=26.12.1`**。满足插件引擎版本不代表满足上游 lite 包要求。

## 安装插件

取得可信的本地包目录或审核后的 npm 压缩包，在 DSH 插件管理器中选择「安装 bundle」，使用本地绝对目录或压缩包路径。也可以让当前 DSH agent 调用 `plugin_manager`，`action: install_bundle`，`target` 为该本地包的绝对路径。不要手动修改 DSH profile 的依赖清单或补丁。

包已声明 [Cordis bundle 补丁](./cordis.patch.yml)、Host / Client 入口、本地化与图标导出；无需额外 MCP 配置。以插件管理器返回的 `application` 和 `warnings` 为准判断是否生效；更新同一包后可能需要重启 Harness，不能以安装成功替代功能验收。

可以将审核后的干净源码提交到你有权限的 GitHub 仓库。npm 发布是独立操作，需要确认包名可用、账号权限和最终分发内容；本次本地构建不会自动执行 `npm publish` 或上传仓库。

## 首次安装：原生优先，人工安装上游

统一的是 **DSH 插件、机器人与配置入口**，不是绕过上游许可的一键全装程序。首次安装流程是「检查环境 → 人工安装官方原版并扫码 → 连接已有 OneBot → 重启机器人 → 验证」，不以 Docker 为默认前提，也不下载安装或修改 SnowLuma/QQ。

### 上游条款与支持边界

- 先阅读 [SnowLuma v2.3.4 EULA](https://github.com/SnowLuma/SnowLuma/blob/v2.3.4/EULA.md)，其中 **5.4 要求使用自动化脚本部署前取得事先书面授权**。本项目 MIT 仅覆盖本插件原创代码，不授予 SnowLuma 的下载、再分发、部署自动化或其他权利。
- 本插件**不提供自动下载器、自动安装脚本、代接受 EULA、主机全局 capability 修改或自动扫码登录**；不会把点击「连接」视为接受上游条款。以后如扩展部署自动化，须先另行落实相应书面授权。
- [上游固定 v2.3.4 源文件](https://github.com/SnowLuma/SnowLuma/tree/v2.3.4)及[官方发布页](https://github.com/SnowLuma/SnowLuma/releases/tag/v2.3.4)是审核原版来源的入口。原生步骤参考[官方 Linux 手动部署（进阶）文档](https://snowluma.github.io/zh/docs/guide/deploy/linux-manual)；该网页会更新，版本要求以所选发行包为准。**官方 Linux 推荐且仅正式支持 Docker；本文的原生宿主机接入是高级、非官方支持方案**，不能理解为上游承诺支持任意主机或无容器运行。
- 用户自行审核系统依赖、发行包来源和条款，手工安装、建立所需服务、启动 QQ 并确认二维码；插件不会代为执行这些步骤。已有后端直接连接，不必重装。

### 首次配置向导

1. 安装插件后打开「QQ 机器人」的首次配置入口，或使用 `qq_setup` 读取配置状态/执行检查。`GET /setup` 返回依赖检查与接入状态（平台、Node、QQ、桌面/扫码环境、媒体工具等）；这是检测线索，不是完整系统依赖验收。`POST /setup/check` 检查拟接入本机后端的 HTTP 登录信息和事件 WS 握手；不执行安装，也不证明全部事件、动作与模型可用。
2. 如果没有后端，按上述官方入口人工准备 SnowLuma 原版并完成 QQ 登录，在上游启用 OneBot HTTP 和正向 WebSocket；HTTP 动作和 WS 事件必须属于同一个实例。管理页、QR、桌面和任何密码留在受保护的本机环境中。
3. 在向导中填写已有后端的 HTTP / WS 地址和认证 token，按需填写模型端点/key。`POST /setup/check` 和 `POST /setup/connect` 的 **OneBot 地址只接受本地 loopback HTTP(S) / WS(S) 接入**；不是任意远程 URL 代理。地址不能带凭据/查询参数，WS 可用根路径或 `/event`；HTTP/WS 应填写同一本机主机名。OneBot 在远端时先由用户建立受保护的本机转发，或由熟悉配置的管理员在现有配置流程中管理外部服务。模型端点另按 HTTPS（本机可 HTTP）规则校验，不受 OneBot 本机地址限制。
4. 确认连接后保存配置。状态与检查结果中的 token/key 会脱敏，不能据此找回原值。已有配置会先备份，备份文件权限为 **0600**；备份仍含原始密钥，应同数据目录一起保护，不要随发布包分享。
   更换模型接口 Base URL 时必须显式提交新 `apiKey`，不会继承旧接口的内联或环境变量密钥；工具可显式提交空字符串表示无密钥，并清除环境变量回退。同一接口留空不提交则保留原密钥。
5. 保存后**需要重启机器人**才能让运行进程读取新配置；外部托管进程须使用其原管理器重启。再检查 OneBot 登录/事件流及模型可用性，最后逐项启用聊天。连接成功不自动启用发言，也不迁移后端。

`qq_gateway` 用于显式查询或管理已配置后端；默认 `native` 模式调用用户预先建立的 systemd unit（`snowluma.target`，system scope）。启动/停止/重启必须是明确操作，不会安装服务、下载软件或创建 QQ 登录态。权限不足请由管理员配置最小必要权限；不要因为向导报错授予整个 DSH 不受限制的 root/sudo 权限。`external` 模式只连接由其他管理器运行的后端；Docker 仅作为显式选择的兼容模式，见下文。

**实现/验证范围**：本版本提供原生优先的配置、检测与既有服务管理入口；不表示任何主机已完成原生安装、真实 QQ 登录或从 Docker 迁移。升级与检查不会停止、迁移或重建现有容器及登录数据。

## 机器人配置：默认不开口

[公开配置示例](./bot/config.example.json)不含账号、群号、密钥、机器绝对路径或私人服务地址。所有自动发送/主动行为、空间社交、分享、每日资讯、自动学习、收图、生图默认关闭，目标列表为空，演练开关保持开启。示例的 `api.example.com` 是占位域名，必须替换。

首次托管启动时，会在数据目录缺少实际配置时从示例生成配置，已有配置不会被覆盖。默认目录为 `$DSH_HOME/storage/dsh-qq`；未设置 `DSH_HOME` 时位于用户主目录的 `.dsh/storage/dsh-qq`。不要编辑安装包内代码来存储密钥。

先配置并验证：

| 配置项 | 操作 |
| --- | --- |
| `onebot.httpUrl` / `onebot.wsUrl` | 填后端 HTTP / 正向 WS 地址；示例仅指向本机 |
| `onebot.accessToken` / `onebot.wsAccessToken` | 使用后端实际认证令牌，按后端要求分别填写 |
| `control.host` / `control.port` / `control.token` | 保持 loopback，选择未占用端口，设置随机控制令牌 |
| `llm.baseUrl` / `llm.model` | 填你有权限使用的模型端点和模型名 |
| `llm.apiKeyEnv` | 默认 `QQ_LLM_API_KEY`，从环境读取；也可填 `llm.apiKey` |
| `chat.whitelistGroups` | 启用聊天前先限制群；空列表表示不限群，并非拒绝所有群 |
| `chat.enabled` / `chat.replyPrivate` | 检查权限与范围后分别启用 |
| `agent.targets` | 主动行为 / 每日资讯的目标，格式 `group:群号` / `private:QQ号`；资讯仅发群 |

推荐让 DSH 服务继承环境变量。也可以在**数据目录**的 `.env` 中设置变量；机器人优先读取配置所在目录，再以代码目录的 `.env` 作为兼容后备；已有进程环境不被覆盖。不要把 `.env` 放进发布包。配置文件中的 `apiKey` 优先于环境变量。

```bash
export QQ_LLM_API_KEY='填入你自己的密钥'
# 在这个环境中启动 DSH；不要把真实值写入共享命令历史或提交到 git。
```

模型、限额、视觉、图片与向量端点检查完成后，逐项启用所需能力；不要一次打开所有主动行为。已有机器人应先备份数据，再配置 `dataDir` 连接原配置，避免并行启动两个发送实例。

## 既有 Docker 后端兼容（非默认）

新用户先使用上面的原生优先接入流程；已有 Docker 实例不必迁移。若需要插件管理既有容器，必须显式覆盖 `snowLumaMode: docker`，保留原容器、部署文件与登录卷。升级插件不会自动修改这些服务，默认 `native` 也不会替你停止现有容器。

[Compose 模板](./deploy/snowluma.compose.yml)只是兼容用外部部署配置，不包含 SnowLuma 镜像或 QQ 软件，不会自动运行。请先根据供应方文档确认镜像来源、授权条款、部署/自动化权限与当前要求；上文固定版本 EULA 5.4 的事先书面授权要求同样不能由插件 MIT 或本文示例替代。

模板要求显式设置 `SNOWLUMA_IMAGE`，优先使用审核过且固定 digest 的镜像引用。不要将本文当作某一镜像的官方支持承诺。模板为了兼容 QQ 注入设置 `SYS_PTRACE` 和 `seccomp:unconfined`，会降低容器隔离，**仅对可信镜像使用**。HTTP、WebSocket、管理页和远程桌面端口均只绑定 `127.0.0.1`。

在专用部署目录保存模板并设置环境后，人工运行：

```bash
export SNOWLUMA_IMAGE='你审核并获准使用的镜像引用'
docker compose -f deploy/snowluma.compose.yml config --quiet
docker compose -f deploy/snowluma.compose.yml up -d snowluma
```

默认容器名 `snowluma`，端口 HTTP `3000`、WS `3001`、管理页 `5099`、桌面 `6081`。用你的镜像文档完成登录、初始化认证与开启 OneBot，勿复制私人日志中的口令。远程访问请使用 SSH 隧道或受保护的反向代理；不要直接开放公网端口。

持久卷名称固定为 `qq-gateway-data`、`qq-client-config`、`qq-client-data`，不加 Compose 项目前缀，便于接已有部署。启用前确认这些卷确实属于你要连接的实例，先备份；不要误连别人的登录态。停机使用 `docker compose ... stop`，**不要使用 `down -v` 或删除这些卷**。已运行的 SnowLuma 不需要迁移到模板。

插件可显示既有容器状态，并在明确确认后调用 `docker start/stop/restart`；容器名由 `snowLumaContainer` 指定。插件不执行 Compose 部署、不拉取镜像、不创建容器；`snowLumaComposeFile` 仅保留为既有部署位置的兼容记录。DSH 必须有 Docker 访问权限，这等价于高权限主机访问；仅让可信用户使用运维入口。

## 插件配置

在 DSH 插件配置中覆盖以下字段，保留 [bundle 补丁](./cordis.patch.yml)作为安装默认值：

```yaml
manageBot: true            # 管理内置机器人子进程；不是自动安装 SnowLuma
botDir: ''                 # 默认使用包内 bot/，一般不要改
dataDir: ''                # 默认 $DSH_HOME/storage/dsh-qq
controlUrl: ''             # 外部机器人控制台地址；留空按本地配置推导
autoRestart: true
restartDelayMs: 3000
logLines: 400
snowLumaMode: native       # native（默认）/ docker（既有容器兼容）/ external（仅连接）
snowLumaService: snowluma.target  # 用户预先安装的 systemd unit；插件不会创建
snowLumaServiceScope: system     # system / user；需相应 systemctl 权限
snowLumaContainer: snowluma      # 仅 docker 模式
snowLumaComposeFile: ''          # 既有 Docker 部署文件位置记录；不会执行 Compose
```

`manageBot: false` 表示机器人由 systemd 等独立管理，插件仍可能通过控制台执行操作，并不意味着只读。配置 `dataDir` 指向实际控制令牌/配置的目录，`controlUrl` 指向正确控制台；确保不会把令牌发送到不可信 URL。

## 从拆分部署迁移与回滚

1. 先备份现有配置、`.env`、归档/学习/人物数据，以及旧服务的启动配置；不要清空数据目录或 SnowLuma 登录卷。
2. 安装统一插件，令 `dataDir` 指向原配置所在目录。首次接入现有控制台只会附着，不会擅自停止独立进程；此时重启按钮会拒绝重启外部进程。
3. 需要改由插件托管时，先停止并禁用旧的机器人服务，确认不会被 supervisor 自动拉起，再重启 DSH。不要同时运行两个机器人发送实例。
4. 验证原账号、事件流、完整历史和学习库后，在插件管理器停用旧面板及旧 QQ MCP 入口，避免重复工具和重复设置页。保留旧源码、服务定义和备份便于回滚。
5. 回滚时，先在插件管理器停用统一插件，确认托管子进程已退出，再恢复旧服务及旧面板/MCP。不要直接启用旧服务与托管机器人抢占同一个控制端口。

SnowLuma 外部服务、既有容器与登录卷无须迁移或重建。本文迁移步骤只涉及 **机器人托管归属**，不代表原生 SnowLuma 已安装，也不代表完成 Docker → 原生后端迁移；此类迁移须另行规划授权、停机、登录态与回滚。既有 Docker 管理继续使用 `snowLumaMode: docker`，不要仅为符合默认值更换运行方式。前端插件变更后刷新原 DSH 页面；Host 安装状态正常不代表浏览器已经加载最新面板，也不代表完成截图/视觉验收。

## 开发、测试与打包

从包根目录运行：

```bash
npm ci --ignore-scripts    # 源码目录使用已提交的锁文件；压缩包安装由包管理器解析依赖
npm test                  # 全部 bot 与发布回归，显式列举测试文件，串行减少资源竞争
npm run test:release       # 只跑公开配置与发布元数据测试
npm run pack:check         # 审计真实 npm pack 文件清单及相对导入完整性
npm pack --dry-run         # 人工查看实际分发清单；prepack 自动执行相同审计
```

测试使用 mock 后端、临时数据及公开示例，不需要真实 `config.json`、`.env`、QQ 账号或模型 key；不要复制真实配置来“修复测试”。部分媒体测试依赖本机 `ffmpeg`，以实际测试报告中的跳过项为准。测试通过不证明真实账号、容器、远程 API 或 GUI 已端到端验证。

分发使用精确的 `files` allowlist：包含 Host / Client、运行辅助模块、首次配置模块、机器人源码、公开示例、动作目录、测试、校验脚本、Compose 兼容模板、图标与 locale；首次配置模块也由发布审计作为必需文件核对。不递归打包整个运行目录。`.gitignore` 仅是第二道防线；即使本地安装目录含私有文件，也不应出现在 npm 压缩包中。发布前仍需审核 `npm pack --dry-run` 与许可证。

独立 CLI 调试时，用独立数据目录或显式 `--config` 指定配置；不要在已安装包内保存实际数据：

```bash
node bot/src/index.mjs --help
node bot/src/index.mjs start --config /absolute/path/to/your/config.json
node bot/src/index.mjs status --config /absolute/path/to/your/config.json
node bot/src/index.mjs mcp --config /absolute/path/to/your/config.json
```

## 安全与数据

- 控制台示例令牌为空；**空令牌不校验请求**，不是安全的随机默认密码。首次配置前仅限本机测试，启用前设置随机令牌，不要直接暴露公网。
- DSH Web 本身也需要访问控制。面板能代机器人发送消息和执行管理动作；获取面板访问权即可能获得 QQ 操作权限。
- 控制台、systemd 服务操作权限、Docker socket、后端 token、模型 key、聊天归档、SQLite 数据库、配置备份和登录卷都是敏感数据。不要共享完整配置、`.env`、数据目录或原始启动日志。
- 确认群成员与聊天参与者了解机器人、记录及第三方模型处理范围；避免上传不必要的私密消息/图片。
- 权限受后端和账号限制；危险动作需要明确确认。即使自动行为保持关闭，人工工具仍可能产生真实外部副作用。

## 包结构

- [Host 入口](./index.js)、[Client 面板](./client.js)、[运行辅助模块](./runtime.js)、[首次配置模块](./setup.js)
- [机器人配置示例](./bot/config.example.json)、[机器人包信息](./bot/package.json)
- [发布审计脚本](./scripts/check-release.mjs)、[统一测试入口](./scripts/test.mjs)
- [英文 metadata](./locale/en.json)、[中文 metadata](./locale/zh.json)、[图标](./icon.svg)
- [外部 SnowLuma 部署模板](./deploy/snowluma.compose.yml)、[许可与来源说明](./LICENSE)
