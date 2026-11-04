# NapCat 接入与安全迁移

本插件支持 NapCat OneBot v11。**NapCat 官方 WebUI 直接扫码，不需要远程桌面或 VNC 密码。** 后端、QQ 客户端与账号不在插件包中，仍须遵守各自条款。NapCat v4.18.42 已发布空间接口的 SnowLuma 格式兼容；这不代表账号权限或每个扩展动作都保证成功。

## 1. 部署并登录官方后端

从 [NapCat 官方文档](https://napneko.github.io/guide/napcat)或 [v4.18.42 发布页](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.42)选择适用部署。原生 Shell 与容器均由操作者独立管理。审核脚本后再执行，不要直接运行未知来源命令。

- 建议使用专用非 root 用户、独立程序与数据目录。迁移时不要覆盖旧 QQ 登录目录。
- 官方 WebUI 通常为 `http://服务器:6099/webui/`，用其配置中的强随机 `token` 登录，再扫描 QQ 二维码并在手机确认。
- OneBot HTTP 与正向 WS 仅监听 loopback，并设置 access token；例如 HTTP `127.0.0.1:3102`、WS `127.0.0.1:3103`。示例端口不是强制要求，正向 WS 可用根路径。
- 普通 HTTP 仍可能泄露令牌、扫码信息和控制操作；建议可信 HTTPS。公开 WebUI 必须保留自身令牌鉴权，DSH Cookie 只保护插件入口及显式复制操作，不保护已跳转的 NapCat 页面。

## 2. 插件管理与网页登录

在 DSH 插件配置中设置：

| 配置 | 含义 |
| --- | --- |
| `gatewayBackend: napcat` | 管理和登录入口切到 NapCat，不再访问 SnowLuma / VNC |
| `napcatService: napcat.service` | 操作者预先建立的系统 scope systemd 服务；工具不会创建 unit |
| `napcatWebuiPort: 6099` | 探测 loopback `/webui/`；浏览器跳转相同主机的这一端口 |
| `napcatWebuiConfigPath` | 真实 NapCat `config/webui.json` 的绝对路径，内含 `token` |

点「复制 NapCat 登录令牌」再打开官方 WebUI。复制操作只由已认证浏览器显式执行；不把令牌放 URL、日志、模型工具或状态结果中。浏览器拒绝剪贴板时可短时手动复制，离开或超时清除面板临时值。**它不是 QQ 密码，也不是 OneBot access token。**

此插件不自动部署 NapCat WebUI，也不替你点击 QQ 登录确认。后端页面 200 / systemd active 不代表 QQ 在线。

## 3. 机器人连接

机器人配置「连接」中设置 `onebot.gateway: napcat`、实际 HTTP / WS 地址及相应令牌；插件首次向导继续使用标准 OneBot 登录检测。已保存配置需重启机器人，才会使用新的连接与兼容层。保留原 `dataDir`，不要另起重复机器人。

```json
{
  "onebot": {
    "gateway": "napcat",
    "httpUrl": "http://127.0.0.1:3102",
    "wsUrl": "ws://127.0.0.1:3103",
    "accessToken": "在本机私有配置填写，不发到聊天",
    "wsAccessToken": "与实际WS配置匹配"
  }
}
```

`gatewayBackend` 控制插件的网关管理/登录，`onebot.gateway` 控制机器人发出动作的参数兼容，两者用途不同，切换时须一起设置。

## 4. 已核实的 API 差异

- 资料修改：将签名转为 `personal_note`、性别转为数字；仅修改签名/性别时使用已读取的登录昵称补全 NapCat 所需 nickname，不擅自改名。
- 群相册列表：转换为 `get_qun_album_list`。
- 群相册上传：调用 `qq_album` 时显式指定 `media_type: video` 才走视频接口，不按文件名猜；图片使用 `image` 或省略。NapCat 相册上传不支持该工具的 `text` 配文，非空会明确报错而不是假装发布。
- 空间、普通视频、合并转发不做臆测式重写。扩展功能仍依赖当前后端版本、账号权限与平台限制；错误如实返回。
- 动图/视频视觉继续依赖 `ffmpeg` / `ffprobe` 与视觉模型，并非后端切换即可省略。

## 5. 迁移验收与旧数据

1. 停掉旧端自动登录脚本，避免它在新端运行时自动点击或重新启动旧端。
2. 备份旧配置、全部聊天/学习/人物档案及登录数据；保留原容器卷。新 NapCat 使用独立 QQ 数据目录，不声称跨后端登录态必然可用。
3. 在新端启动前停止旧 QQ 网关，避免同账号多实例互踢；保留可审阅的恢复步骤，但不要留下会在新端验收后自动恢复旧 QQ 的计时器。
4. 依次验证 HTTP `get_login_info` 的真实账号、WS 接通及真实消息到达、给机器人发消息并收到回复；再试图片、GIF、视频和转发。只通过连接检查不能声称完整功能验收。
5. 完成新端验收后启用新服务自启，停用旧端重启策略与自动化，继续保留所有旧卷和历史备份。不要因切换成功删除档案。

旧 SnowLuma 安装器仍见 [历史原生指南](./native.md)，该脚本不安装 NapCat。GitHub 或 npm 的源码发布不包含任何账号、令牌或个人聊天资料。
