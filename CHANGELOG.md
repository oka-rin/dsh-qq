# Changelog

记录已核实的用户可见变更。本文件不推定尚未建立的 GitHub tag、Release 或 npm 发布记录。

## Unreleased

### Added

- 公共仓库 CI：Node.js 22 / 24、锁文件安装、ffmpeg / ffprobe、完整测试与发布清单审计；只读权限，不自动发布。
- 隐私优先的问题模板、贡献指南和安全报告说明。
- 忽略首次配置向导生成的敏感配置备份。

## 0.3.1

### Fixed

- 修复原生安装器处理平铺完整包时继承临时目录 `0700`、导致非 root 网关无法进入运行目录的问题；安装后运行目录显式设为 root 所有的 `0755`。
- 增加真实目录复制及权限回归；这项验证不代表已经完成官方完整包安装、QQ 扫码或本机切换。

## 0.3.0

### Added

- 独立原生安装脚本：默认只读 `--plan`；显式 `--install --confirm-install` 后准备 Debian/Ubuntu systemd 部署，不隐式启动或启用服务。
- 固定官方 SnowLuma v2.4.0 完整包及 GitHub API SHA-256 校验，使用自带 Node；QQ 由用户提供 root 所有的原版目录，或提供原版 `.deb` 及独立可信 SHA-256，不猜测下载地址。
- 专用非 root 服务账号、仅 gateway unit 范围的 `CAP_SYS_PTRACE`、loopback OneBot 配置，以及可选密码保护的 x11vnc；不修改全局 Node capability、sysctl 或 hosts。
- [原生部署与 Docker 切换指南](./docs/native.md)：上游条款人工审核/同意、SSH 转发、扫码、备份、切换和回滚；保持原机器人数据目录。

### Boundaries

- 安装确认不代表同意上游条款；不自动扫码、停止 Docker、复制登录态或删除卷。插件安装与首次配置不隐式运行系统安装器。
- 原生登录及 Docker → 原生迁移仍需人工扫码和端到端验收；脚本准备完成不代表 QQ 已登录、机器人在线或迁移成功。

## 0.2.2

### Fixed

- 显式禁用环境变量密钥后，首次配置向导状态和模型列表检测不再回退读取旧接口密钥。

### Verified

- 空数据目录、未运行 OneBot 后端时，首次配置向导仍可独立打开，且不会触发安装或部署。

当前版本以 MIT 授权分发插件原创代码和图标；外部后端、QQ 客户端、镜像、服务及素材不包含在该授权中。完整能力和使用边界见 [README](./README.md)。
