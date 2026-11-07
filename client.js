// QQ 机器人总览页 · 网页半边
//
// 在「设置」左侧栏加一项「QQ 机器人」：在线状态、今日战绩（说话/分享/说说/跳过）、
// 每次决策到底为什么、最近聊天记录，外加三个手动按钮。
// 数据全部来自宿主那几条 /dsh-qq/* 路由，这里不碰 OneBot。
window.__ModuleLoader__.load({
  id: 'dsh-qq',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    // A stripping proxy does not necessarily advertise a boot base. The GUI's
    // <base href="./"> preserves its public mount, including legacy scoped cookies.
    function resolveBasePath(bootBase, baseURI, pageURL) {
      const page = new URL(pageURL);
      const configured = String(bootBase || '').replace(/\/+$/, '');
      if (configured && /^\/(?!\/)/.test(configured) && !/[?#\\\\]/.test(configured)) return configured;
      const base = new URL('.', baseURI || page.href);
      if (base.origin !== page.origin) return '';
      return base.pathname.replace(/\/+$/, '');
    }
    const basePath = resolveBasePath(window.__DSH_BOOT__?.basePath, document.baseURI, window.location.href);
    const B = basePath + '/dsh-qq';
    const request = async (p, init = {}) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      const abort = () => controller.abort();
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener('abort', abort, { once: true });
      try {
        const r = await fetch(B + p, { ...init, cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        const data = await r.json();
        if (!r.ok) return { ...data, ok: false, httpStatus: r.status, error: r.status === 401
          ? 'DSH 浏览器登录凭证缺失或已失效。请在当前站点重新打开你保存的 DSH 登录链接，再刷新此页；这不是 QQ 账号登录失败。'
          : data?.error || data?.reason || `HTTP ${r.status}` };
        if (!data || typeof data !== 'object') return { ok: false, error: '接口未返回 JSON 对象' };
        if (data.result?.ok === false) return { ...data, ok: false, error: data.error || data.result.error || data.result.reason || '操作未完成' };
        return data;
      } catch (error) {
        return { ok: false, error: error.name === 'AbortError' ? '请求超时；写操作结果不明，请先刷新核查，不要重复提交' : String(error.message || error) };
      } finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', abort); }
    };
    const get = (p, options = {}) => request(p, options);
    const post = (p, body, options = {}) => request(p, { ...options, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    const configWrite = { busy: false };
    function useLifetime() {
      const live = React.useRef(false);
      const timers = React.useRef(new Set());
      React.useEffect(() => {
        live.current = true;
        return () => { live.current = false; for (const id of timers.current) clearTimeout(id); timers.current.clear(); };
      }, []);
      const later = (fn, ms) => {
        if (!live.current) return;
        const id = setTimeout(() => { timers.current.delete(id); if (live.current) fn(); }, ms);
        timers.current.add(id);
      };
      return { live, later };
    }
    const T = { text: 'var(--dsw-alias-label-primary)', muted: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-state-business-primary)', success: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)', warn: 'var(--dsw-alias-state-warn-primary)' };
    const copy = { zh: { title: 'QQ 机器人', overview: '总览', settings: '设置与订阅', memory: '人物与记忆', chats: '对话', ops: '运维' },
      en: { title: 'QQ bot', overview: 'Overview', settings: 'Settings & subscriptions', memory: 'People & memory', chats: 'Chats', ops: 'Operations' } };
    Object.assign(copy.zh, {
      setup: '原生接入', setupTitle: '首次接入 · 原生优先', setupIntro: '用可审查安装脚本准备宿主机原生 QQ 网关，再检测 OneBot 连接；网页不会代执行管理员命令。',
      setupDocker: '现有 Docker 保持不变：不会停止、删除或迁移容器。Docker 兼容管理仍在「运维」；检测成功也不代表已安装原生服务。',
      setupPrep: '1 · 原生安装与依赖检查', setupRefresh: '刷新依赖检查', setupLoading: '正在读取接入信息…', setupUnavailable: '接入信息不可用；请确认宿主已提供 /setup 接口后重试。其他功能仍可从页签访问。',
      setupHost: 'DSH 宿主环境', setupUnknown: '尚未检查', setupPass: '通过', setupFail: '未就绪', setupChecksEmpty: '宿主未提供依赖检查结果，不能据此认定已安装。',
      setupQQ: '原生 Linux QQ', setupXvfb: 'Xvfb（无图形界面时使用）', setupFfmpeg: 'ffmpeg（音视频能力）',
      setupManual: '先打开原生安装指南，下载审查脚本并预览计划；确认后由宿主管理员安装依赖、原版 SnowLuma 和 QQ。服务不自动启动，协议确认及扫码需本人完成。',
      setupEula: '请自行核实上游 EULA 和使用许可。脚本不代接受协议、不绕过扫码、不停止或删除 Docker；迁移须在原生登录验收后切换。',
      setupInstaller: '原生安装指南', setupScript: '查看安装脚本', setupAuto: '管理员安装脚本 · 网页不自动执行', setupRelease: '官方原版下载', setupManualLink: '官方手册', setupEulaLink: '阅读 EULA', setupQQLink: '官方 QQ', setupNoLinks: '宿主尚未提供官方链接，请勿使用不明镜像或自动安装脚本。',
      setupService: '原生服务参考（不是已安装证明）', setupUserScope: '用户级', setupSystemScope: '系统级',
      setupConnect: '2 · 检测并保存本机连接', setupLocal: 'localhost 指 DSH 宿主机，不是浏览器所在电脑。只接受本机端点；检测会调用 OneBot HTTP get_login_info，并检查 WebSocket 能否建立连接（最多 5 秒），不写配置。',
      setupHttp: 'OneBot HTTP 地址', setupWs: 'OneBot WebSocket 地址（可选）', setupTokenMode: 'OneBot Token 处理', setupReuse: '沿用当前 Token（仅同一端点）', setupReplace: '输入新 Token', setupNone: '明确不使用 Token',
      setupToken: '新 OneBot Token', setupTokenHint: '密码框不回填；沿用会省略 token 字段，无 Token 会明确发送空字符串。更换端点请重新填写 Token 或明确选择不使用。',
      setupTokenSet: '当前已配置 Token', setupTokenUnset: '当前未配置 Token', setupLlm: '同时设置模型（可选）', setupLlmHint: '不勾选则保留现有模型配置；同一接口 API Key 留空不改，更换接口必须填写新密钥。此处检测只验证 OneBot，不验证模型。',
      setupModel: '模型名称', setupBase: '模型 Base URL', setupKey: '新模型 API Key', setupKeySet: '当前已配置 API Key · 留空保留', setupKeyUnset: '留空不提交 API Key',
      setupProbe: '检测 OneBot 连接', setupProbing: '检测中…', setupSave: '检测成功，保存接入配置', setupSaving: '复检并保存中…', setupDetected: '检测成功 · QQ 账号', setupNotSaved: '仅检测，尚未保存配置。',
      setupSaved: '已保存接入配置。未安装或启动上游，现有 Docker 未变。', setupRestart: '需要重启 QQ 机器人后生效；请到「运维」核查并手动重启。', setupNoRestart: '宿主未要求重启；请核查实际连接状态。',
      setupOps: '前往运维', setupConfirm: '将复检本机 OneBot 并保存连接配置（保留其他设置）。不会启动上游或迁移 Docker。确认继续？',
      setupBusy: '另一个设置保存仍在进行，请稍后再试。', setupEndpointError: '请输入合法的本机 HTTP / WebSocket 地址，不含账号、密码、查询参数或片段。', setupTokenError: '更换端点不能沿用旧 Token；请选择输入新 Token 或明确不使用 Token。', setupNewTokenError: '请输入新 Token；如无需 Token，请明确选择不使用。', setupModelError: '同时设置模型时，请填写模型名称和 Base URL。', setupCheckFailed: '检测失败；未保存配置。', setupSaveFailed: '保存未确认成功；请先刷新核查，勿盲目重复提交。', setupError: '请求失败',
    });
    Object.assign(copy.en, {
      setup: 'Native setup', setupTitle: 'First-run setup · native first', setupIntro: 'Prepare the native QQ gateway with the reviewable host installer, then test OneBot. This page does not execute administrator commands.',
      setupDocker: 'Existing Docker stays unchanged: no containers are stopped, removed or migrated. Docker compatibility controls remain in Operations. A successful probe does not mean a native service is installed.',
      setupPrep: '1 · Native installation & dependency checks', setupRefresh: 'Refresh dependency checks', setupLoading: 'Loading setup information…', setupUnavailable: 'Setup is unavailable. Check that the Host provides /setup, then retry. Other tabs remain accessible.',
      setupHost: 'DSH host', setupUnknown: 'Not checked', setupPass: 'Ready', setupFail: 'Not ready', setupChecksEmpty: 'The Host provided no dependency results. Installation cannot be assumed.',
      setupQQ: 'Native Linux QQ', setupXvfb: 'Xvfb (for headless hosts)', setupFfmpeg: 'ffmpeg (audio/video features)',
      setupManual: 'Open the native installation guide, review the script and preview its plan. A host administrator can explicitly install dependencies and original SnowLuma/QQ. Services do not start automatically; review agreements and scan QQ yourself.',
      setupEula: 'Verify the upstream terms and your permission to use them. The script never accepts agreements, bypasses QR login, or stops/removes Docker. Switch only after native login is verified.',
      setupInstaller: 'Native install guide', setupScript: 'Review installer', setupAuto: 'Administrator installer · not executed by this page', setupRelease: 'Official original release', setupManualLink: 'Official manual', setupEulaLink: 'Read EULA', setupQQLink: 'Official QQ', setupNoLinks: 'No official links supplied by the Host. Do not use unknown mirrors or automatic installation scripts.',
      setupService: 'Native service reference (not proof of installation)', setupUserScope: 'User scope', setupSystemScope: 'System scope',
      setupConnect: '2 · Test & save a local connection', setupLocal: 'localhost means the DSH host, not the computer running your browser. Only local endpoints are accepted. Testing calls HTTP get_login_info and checks that WebSocket can open (up to 5 seconds), without writing configuration.',
      setupHttp: 'OneBot HTTP URL', setupWs: 'OneBot WebSocket URL (optional)', setupTokenMode: 'OneBot token handling', setupReuse: 'Reuse current token (same endpoint only)', setupReplace: 'Enter a new token', setupNone: 'Explicitly use no token',
      setupToken: 'New OneBot token', setupTokenHint: 'Passwords are never prefilled. Reuse omits token; no-token explicitly sends an empty string. A changed endpoint needs a new token or an explicit no-token choice.',
      setupTokenSet: 'Current token configured', setupTokenUnset: 'No current token configured', setupLlm: 'Also configure a model (optional)', setupLlmHint: 'Unchecked preserves current model settings. A blank key is retained only for the same endpoint; a changed endpoint requires a new key. The probe tests OneBot only, not the model.',
      setupModel: 'Model name', setupBase: 'Model Base URL', setupKey: 'New model API key', setupKeySet: 'API key configured · leave blank to preserve', setupKeyUnset: 'Blank omits the API key',
      setupProbe: 'Test OneBot connection', setupProbing: 'Testing…', setupSave: 'Probe passed · save connection', setupSaving: 'Rechecking & saving…', setupDetected: 'Probe passed · QQ account', setupNotSaved: 'Probe only; configuration not saved.',
      setupSaved: 'Connection configuration saved. Upstream was not installed or started; Docker is unchanged.', setupRestart: 'Restart the QQ bot to apply. Review its state and restart manually in Operations.', setupNoRestart: 'The Host did not request a restart; verify actual connectivity.',
      setupOps: 'Go to Operations', setupConfirm: 'Recheck local OneBot and save this connection, preserving other settings? This does not start upstream software or migrate Docker.',
      setupBusy: 'Another configuration save is in progress. Please retry later.', setupEndpointError: 'Enter valid local HTTP / WebSocket URLs without credentials, query strings or fragments.', setupTokenError: 'A changed endpoint cannot reuse the old token. Enter a new token or explicitly choose no token.', setupNewTokenError: 'Enter a new token, or explicitly choose no token.', setupModelError: 'Model name and Base URL are required when configuring a model.', setupCheckFailed: 'Probe failed; configuration was not saved.', setupSaveFailed: 'Save success is unconfirmed. Refresh and check before submitting again.', setupError: 'Request failed',
    });
    Object.assign(copy.zh, {
      setupIntro: '用可审查安装脚本准备宿主机原生 QQ 网关，手动启动后打开 QQ 登录页，再单独检测 OneBot 连接；网页不会代执行管理员命令。',
      setupManual: '先打开原生安装指南，审查脚本并预览计划；由宿主管理员安装依赖、原版 SnowLuma 和 QQ。到「运维」手动启动网关，再打开 QQ 登录页，亲自完成登录与协议确认。',
      setupConnect: '3 · 检测并保存本机连接',
      loginTitle: '2 · QQ 登录', loginIntro: 'Docker 模式直接打开原 SnowLuma 网页桌面，请本人在真实 QQ 中登录；不会启动网关或代接受协议。其他模式使用短时 QQ 窗口。',
      loginLoggedIn: '已配置网关在线', loginWaiting: '已配置网关未登录', loginUnavailable: '网关状态不可用', loginUnknown: '网关状态未确认',
      loginCheck: '刷新网关状态', loginChecking: '检查中…', loginFailed: '无法确认网关状态，请刷新重试。',
      loginSeparate: '这是当前已配置网关的状态，不代表登录页中所选 QQ 实例；登录后仍需完成下方独立连接检测。',
      desktopOpen: '打开 QQ 登录页', desktopOpening: '正在打开登录页…',
      desktopPrivate: '原版桌面若询问 VNC 密码，请输入原桌面访问密码（不是 QQ 密码）；QQ 密码只在 QQ 中输入，不要发到聊天。原版桌面沿用其自身访问保护。',
      desktopHttpWarning: '普通 HTTP 未加密，画面和键盘输入可能被读取或篡改；仅在可信网络使用。',
      desktopFailed: '无法打开 QQ 登录页，请检查已运行的 QQ 与远程桌面依赖后重试。',
      desktopInvalid: '宿主返回的登录页地址或到期时间无效，请重试。',
      desktopCopy: '复制远程桌面密码', desktopCopying: '正在获取并复制…', desktopCopied: '远程桌面密码已复制',
      desktopCopyRetry: '再次复制', desktopCopyReveal: '显示并选中以手动复制', desktopCopyField: '远程桌面 VNC 密码（只读）',
      desktopCopyNote: '这是远程桌面 VNC 密码，不是 QQ 密码。仅点击时获取；页面内存最多保留 30 秒，离开即清除。不会自动清空剪贴板，以免覆盖你后来复制的内容。',
      desktopCopyFallback: '浏览器未允许自动复制。请在 30 秒内点击「再次复制」，或显示选中后手动复制。',
      desktopCopyFailed: '无法获取远程桌面密码', desktopCopyInvalid: '宿主未返回有效的远程桌面密码',
      desktopCopyExpired: '页面内存中的密码已清除；需要时请重新点击「复制远程桌面密码」。',
      desktopCopyDenied: '浏览器复制命令返回失败', desktopCopyUnavailable: '此页面无法使用安全剪贴板 API', desktopCopyTimeout: '剪贴板操作超时',
    });
    Object.assign(copy.en, {
      setupIntro: 'Prepare the native QQ gateway with the reviewable host installer, start it manually, then open QQ login and test OneBot separately. This page does not execute administrator commands.',
      setupManual: 'Open the native guide, review the installer and preview its plan. A host administrator installs dependencies and original SnowLuma/QQ. Start the gateway manually in Operations, then open QQ login and personally complete login and agreements.',
      setupConnect: '3 · Test & save a local connection',
      loginTitle: '2 · QQ login', loginIntro: 'Docker mode opens the original SnowLuma web desktop. Log in personally inside QQ; no gateway startup or agreement acceptance. Other modes use the short-lived QQ window.',
      loginLoggedIn: 'Configured gateway online', loginWaiting: 'Configured gateway not logged in', loginUnavailable: 'Gateway status unavailable', loginUnknown: 'Gateway status unverified',
      loginCheck: 'Refresh gateway status', loginChecking: 'Checking…', loginFailed: 'Could not verify gateway status. Refresh to retry.',
      loginSeparate: 'This is the configured gateway’s status, not verification of the QQ instance selected on the login page. Test the connection separately below after login.',
      desktopOpen: 'Open QQ login page', desktopOpening: 'Opening login page…',
      desktopPrivate: 'The original desktop may request its VNC access password, not your QQ password. Enter QQ passwords only inside QQ, never in chat. The original desktop retains its own access protection.',
      desktopHttpWarning: 'Plain HTTP is unencrypted: screen and keyboard input may be read or altered. Use only on a trusted network.',
      desktopFailed: 'Could not open QQ login. Check the running QQ client and remote-desktop dependencies, then retry.',
      desktopInvalid: 'The Host returned an invalid login-page path or expiry. Please retry.',
      desktopCopy: 'Copy remote desktop password', desktopCopying: 'Fetching and copying…', desktopCopied: 'Remote desktop password copied',
      desktopCopyRetry: 'Copy again', desktopCopyReveal: 'Reveal and select for manual copy', desktopCopyField: 'Remote desktop VNC password (read-only)',
      desktopCopyNote: 'This is the remote desktop VNC password, not your QQ password. Fetched only on click; kept in page memory for at most 30 seconds and cleared on leaving. The clipboard is not auto-cleared, to avoid overwriting anything you copy later.',
      desktopCopyFallback: 'The browser did not allow automatic copy. Click “Copy again” within 30 seconds, or reveal/select for manual copying.',
      desktopCopyFailed: 'Could not get the remote desktop password', desktopCopyInvalid: 'The Host returned no valid remote desktop password',
      desktopCopyExpired: 'The password was cleared from page memory. Click “Copy remote desktop password” again if needed.',
      desktopCopyDenied: 'The browser copy command returned failure', desktopCopyUnavailable: 'Secure clipboard API is unavailable on this page', desktopCopyTimeout: 'Clipboard operation timed out',
    });
    Object.assign(copy.zh, {
      napcatIntro: '使用 NapCat 官方 HTTP WebUI 二维码登录，由 NapCat 自己进行 token 鉴权；不会打开远程桌面、启动网关或代接受协议。',
      napcatOpen: '打开 NapCat 官方 WebUI', napcatPrivate: 'WebUI token 不是 QQ 密码或 OneBot token。请先复制，在官方 WebUI 中粘贴；不要发送到聊天。',
      napcatCopy: '复制 NapCat WebUI token', napcatCopied: 'NapCat WebUI token 已复制', napcatCopyField: 'NapCat WebUI token（只读）',
      napcatCopyNote: '仅点击时获取 WebUI token；页面内存最多保留 30 秒，离开即清除。剪贴板不会自动清空。',
      napcatCopyFailed: '无法获取 NapCat WebUI token', napcatCopyInvalid: '宿主未返回有效的 NapCat WebUI token',
      napcatCopyExpired: '页面中的 token 已清除；需要时请重新点击复制。',
      napcatHttpWarning: 'NapCat WebUI 使用 HTTP：token 和扫码信息可能被网络中的其他人读取或篡改，仅在可信网络使用。',
      napcatSetupIntro: '连接管理员已安装的 NapCat 原生网关。先核查服务，再使用官方 WebUI 扫码，最后检测 OneBot；网页不会代执行安装或管理员命令。',
      napcatManual: 'NapCat 由宿主管理员安装并管理；此页不安装网关、不使用远程桌面。请在「运维」核查 NapCat 服务，再打开官方 WebUI 扫码。',
    });
    Object.assign(copy.en, {
      napcatIntro: 'Log in with the QR code in the official NapCat HTTP WebUI, protected by its own token authentication. No remote desktop, automatic gateway start or agreement acceptance.',
      napcatOpen: 'Open official NapCat WebUI', napcatPrivate: 'The WebUI token is not a QQ password or OneBot token. Copy it and paste into the official WebUI, never into chat.',
      napcatCopy: 'Copy NapCat WebUI token', napcatCopied: 'NapCat WebUI token copied', napcatCopyField: 'NapCat WebUI token (read-only)',
      napcatCopyNote: 'Fetched only on click; retained in page memory for at most 30 seconds and cleared on leaving. The clipboard is not auto-cleared.',
      napcatCopyFailed: 'Could not get NapCat WebUI token', napcatCopyInvalid: 'The Host returned no valid NapCat WebUI token',
      napcatCopyExpired: 'The token was cleared from page memory. Click copy again if needed.',
      napcatHttpWarning: 'NapCat WebUI uses HTTP: tokens and login data may be read or altered on the network. Use only on a trusted network.',
      napcatSetupIntro: 'Connect an administrator-installed native NapCat gateway. Review its service, scan in the official WebUI, then test OneBot; this page executes no installer or administrator commands.',
      napcatManual: 'A host administrator installs and manages NapCat. This page does not install a gateway or use a remote desktop. Review the NapCat service in Operations, then open its official WebUI to scan.',
    });
    Object.assign(copy.zh, {
      setup: '接入与部署', setupTitle: '首次接入 · 部署与登录',
      setupIntro: '可先使用下方按钮部署 SnowLuma Docker 网关（Linux / Windows 宿主），也可按原生指南手动安装；部署完成后亲自登录 QQ，再检测连接。',
      setupDocker: '已有机器人和同名容器会保留并复用，不停止、不删除、不重置登录；一键部署不会把已安装原生网关当作 Docker 容器。',
      deployTitle: '一键部署 · SnowLuma', deployIntro: '在运行 DSH 的宿主机部署，不是在浏览器所在电脑。只有点击并确认才会安装或启动；关闭此页只停止查看，宿主任务会继续。',
      deployButton: '一键部署 SnowLuma', deployRefresh: '刷新部署状态', deployLoading: '正在检查宿主 Docker…', deployFailed: '部署请求失败；请刷新状态核查，勿重复提交。', deployInvalid: '宿主返回的部署状态无效。',
      deployDocker: 'Docker', deployInstalled: '已安装', deployMissing: '未安装', deployReady: '引擎就绪', deployNotReady: '引擎未就绪', deployImage: 'SnowLuma 镜像', deployContainer: '配置的容器',
      deployExistingRunning: '发现已有容器正在运行；将复用并保留现有登录。', deployExistingStopped: '发现已有容器；将复用，保留数据和登录，不重建或重置。',
      deployInstall: '允许在此宿主安装缺失的 Docker（Linux Docker Engine / Windows Docker Desktop）；可能需要管理员权限。',
      deployWsl: '允许 Windows 宿主执行 wsl --install --no-distribution 以准备 WSL2；可能需要管理员确认和重启，不安装发行版、不代接受许可。',
      deployWslApproval: '尚未授权准备 WSL2。若希望自动准备，请先勾选上方 WSL2 许可，再点击「一键部署 SnowLuma」重新开始；「继续」不会追加新许可。也可请管理员手动准备 WSL2 后刷新重试。',
      deployWindowsInstalled: 'Docker 已安装但引擎尚未就绪：请在 DSH 宿主机打开 Docker Desktop，亲自审阅所需许可/订阅，核查 WSL2 并按提示重启，等待引擎运行。完成后刷新状态；如任务显示「需要本人操作」，点击「已完成手动步骤，继续」。',
      deployAuthorized: '仅新建部署：我有权安装和使用 SnowLuma / QQ，并已自行核实上游 EULA；不代接受协议。',
      deployRisk: '仅新建部署：我了解 SnowLuma 的注入及 SYS_PTRACE / ptrace 权限风险，并授权此部署。',
      deployPublic: '允许公开桌面端口（默认关闭）。普通 HTTP 未加密，桌面画面、键盘输入与访问密码可能被读取或篡改；仅在可信网络使用。',
      deployExistingPublic: '如已有容器公开端口，我明确同意按原映射复用；不会自动关闭或改写这些端口。',
      deployConsent: '请确认新建部署的使用授权与注入风险；缺少 Docker 时另需明确允许安装。',
      deployConfirm: '确认在 DSH 宿主机部署 SnowLuma？将按勾选许可安装缺失 Docker、拉取镜像并创建或复用配置容器；保留已有登录，不停止或重置已有机器人。QQ 登录和许可确认仍需本人完成。',
      deployResumeConfirm: '确认已亲自完成宿主提示的手动步骤，并继续原部署任务？不会替你接受 Docker Desktop 或 QQ 协议。',
      deployResume: '已完成手动步骤，继续', deployWorking: '正在提交…', deployElapsed: '已用时', deploySeconds: '秒', deployStage: '当前阶段', deploySteps: '阶段记录（安全摘要）',
      deployRunning: '正在部署', deploySucceeded: '部署完成；请到下方亲自登录并检测连接', deployTaskFailed: '部署失败', deployNeedsAction: '需要本人操作',
      deployWindows: 'Windows 可能需要本人确认 UAC、启用 WSL2、重启宿主或启动 Docker Desktop。Docker Desktop 可能要求许可或订阅；请本人阅读并接受，不会自动代同意或绕过。完成后刷新并继续。',
      deployAdmin: '如权限不足，请由宿主管理员处理；此页不收集管理员密码，也不会绕过提权。', deployRestart: 'Docker 报告需要重启宿主；请自行安排重启后再刷新并继续。',
      deployUnsupported: '当前宿主不支持一键部署（仅支持 Linux / Windows）。', deployCannotInstall: '宿主不能自动安装 Docker；请管理员完成安装后刷新。',
    });
    Object.assign(copy.en, {
      setup: 'Setup & deployment', setupTitle: 'First-run setup · deploy & log in',
      setupIntro: 'Deploy a SnowLuma Docker gateway below on a Linux / Windows host, or install manually with the native guide. Then log in to QQ personally and test the connection.',
      setupDocker: 'Existing bots and the configured named container are preserved and reused, never stopped, deleted or login-reset. Native gateways are not treated as Docker containers.',
      deployTitle: 'One-click deployment · SnowLuma', deployIntro: 'Runs on the DSH host, not your browser’s computer. Installation/startup requires your click and confirmation. Closing this page stops viewing only; the host task continues.',
      deployButton: 'Deploy SnowLuma', deployRefresh: 'Refresh deployment status', deployLoading: 'Checking host Docker…', deployFailed: 'Deployment request failed. Refresh status before retrying; do not submit twice.', deployInvalid: 'The Host returned an invalid deployment status.',
      deployDocker: 'Docker', deployInstalled: 'Installed', deployMissing: 'Not installed', deployReady: 'Engine ready', deployNotReady: 'Engine not ready', deployImage: 'SnowLuma image', deployContainer: 'Configured container',
      deployExistingRunning: 'Existing container is running; it will be reused with its login preserved.', deployExistingStopped: 'Existing container found; reuse preserves its data and login, without recreation or reset.',
      deployInstall: 'Allow installing missing Docker on this host (Linux Docker Engine / Windows Docker Desktop); administrator privileges may be required.',
      deployWsl: 'Allow wsl --install --no-distribution on the Windows host to prepare WSL2. Administrator approval and reboot may be needed; no distribution is installed and no license is accepted for you.',
      deployWslApproval: 'WSL2 preparation is not authorized. To prepare it automatically, check the WSL2 permission above and click “Deploy SnowLuma” to start again; resume cannot add new permissions. Alternatively, ask an administrator to prepare WSL2 manually, then refresh and retry.',
      deployWindowsInstalled: 'Docker is installed but its engine is not ready. On the DSH host, open Docker Desktop, personally review required licenses/subscriptions, check WSL2 and reboot if requested, then wait for the engine to run. Refresh status afterward; if the task says your action is required, click “Manual steps completed · resume”.',
      deployAuthorized: 'New deployments only: I am authorized to install/use SnowLuma and QQ and have checked upstream terms. No agreement is accepted for me.',
      deployRisk: 'New deployments only: I understand and authorize SnowLuma injection and SYS_PTRACE / ptrace permission risks.',
      deployPublic: 'Allow public desktop ports (off by default). Plain HTTP is unencrypted: screens, keyboard input and access passwords may be read or altered. Use only on a trusted network.',
      deployExistingPublic: 'If the existing container has public ports, I explicitly allow reusing those mappings; they will not be silently closed or rewritten.',
      deployConsent: 'Confirm new-deployment authorization and injection risks; missing Docker also requires explicit installation permission.',
      deployConfirm: 'Deploy SnowLuma on the DSH host? Subject to your permissions, install missing Docker, pull the image, and create or reuse the configured container. Existing login is preserved; existing bots are not stopped or reset. You must complete QQ login and license review yourself.',
      deployResumeConfirm: 'Have you personally completed the required host steps and wish to resume the existing task? Docker Desktop and QQ agreements will not be accepted for you.',
      deployResume: 'Manual steps completed · resume', deployWorking: 'Submitting…', deployElapsed: 'Elapsed', deploySeconds: 'seconds', deployStage: 'Current stage', deploySteps: 'Stage history (safe summary)',
      deployRunning: 'Deploying', deploySucceeded: 'Deployment complete · log in personally and test below', deployTaskFailed: 'Deployment failed', deployNeedsAction: 'Your action is required',
      deployWindows: 'Windows may require personal UAC approval, WSL2 enablement, a host reboot or starting Docker Desktop. Docker Desktop may require a license/subscription: read and accept it yourself. No automatic agreement acceptance or bypass. Refresh and resume when done.',
      deployAdmin: 'For permission errors, ask the host administrator. This page never collects administrator passwords or bypasses elevation.', deployRestart: 'Docker reports a host reboot is needed. Arrange it yourself, then refresh and resume.',
      deployUnsupported: 'One-click deployment supports Linux / Windows hosts only.', deployCannotInstall: 'Docker cannot be installed automatically on this host. Ask an administrator to install it, then refresh.',
    });
    let tr = (key) => copy.zh[key] || key;

    const S = {
      // 「在哪儿主动说话」的选择区
      pickBox: {
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '8px 10px',
        marginTop: 6,
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      pickHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontSize: 12,
        opacity: 0.7,
        marginBottom: 6,
        letterSpacing: '.02em',
      },
      pickCount: { fontSize: 11.5, opacity: 0.75, fontVariantNumeric: 'tabular-nums' },
      pickWrap: { display: 'flex', flexWrap: 'wrap', gap: 6 },
      chip: (on) => ({
        display: 'inline-flex',
        alignItems: 'center',
        fontSize: 12.5,
        cursor: 'pointer',
        padding: '4px 9px',
        borderRadius: 999,
        border: `1px solid ${on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
        background: on ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
        transition: 'background .15s, border-color .15s',
      }),
      chipNote: { marginLeft: 6, fontSize: 10.5, opacity: 0.55, fontVariantNumeric: 'tabular-nums' },

      wrap: { padding: '4px 0 16px', minWidth: 0, color: T.text, fontSize: 13, lineHeight: 1.65 },
      head: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
      h1: { fontSize: 15, fontWeight: 600, margin: 0 },
      dim: { opacity: 0.62, fontSize: 12 },
      pill: (tone) => ({
        fontSize: 11.5,
        padding: '2px 9px',
        borderRadius: 999,
        border: '1px solid ' + (tone === 'ok' ? 'var(--dsw-alias-state-success-primary)' : tone === 'bad' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-border-l2)'),
        color: tone === 'ok' ? 'var(--dsw-alias-state-success-primary)' : tone === 'bad' ? 'var(--dsw-alias-state-error-primary)' : 'inherit',
        opacity: tone ? 1 : 0.75,
      }),
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 10,
        padding: '12px 14px',
        marginBottom: 12,
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      h2: { fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.6, margin: '0 0 10px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(104px, 1fr))', gap: 8 },
      stat: (accent) => ({
        border: '1px solid var(--dsw-alias-border-l2)',
        borderLeft: accent ? `3px solid ${accent}` : '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 9,
        padding: '9px 11px',
        background: 'var(--dsw-alias-bg-layer-1)',
        transition: 'border-color .15s',
      }),
      rowAlt: { background: 'var(--dsw-alias-bg-module-platform)' },
      tdNum: { padding: '5px 10px 5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap', width: '1%' },
      h2row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, margin: '0 0 10px' },
      h2inner: { fontSize: 12, letterSpacing: 0.6, textTransform: 'uppercase', opacity: 0.6, margin: 0 },
      count: { fontSize: 11.5, opacity: 0.45 },
      num: (accent) => ({ fontSize: 20, fontWeight: 650, lineHeight: 1.2, color: accent || 'inherit' }),
      btn: (primary) => ({
        font: 'inherit',
        fontSize: 12.5,
        padding: '5px 12px',
        borderRadius: 7,
        cursor: 'pointer',
        border: primary ? '0' : '1px solid var(--dsw-alias-border-l2)',
        background: primary ? 'var(--dsw-alias-button-primary-fill)' : 'transparent',
        color: primary ? 'var(--dsw-alias-label-primary-foreground)' : 'inherit',
      }),
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12.5 },
      th: { textAlign: 'left', fontWeight: 600, opacity: 0.55, whiteSpace: 'nowrap', fontSize: 11.5, padding: '4px 10px 5px 0', borderBottom: '1px solid var(--dsw-alias-border-l2)' },
      td: { padding: '5px 8px 5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', verticalAlign: 'top' },
      tdTime: { padding: '5px 10px 5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap', width: '1%', opacity: 0.7 },
      tdTag: { padding: '5px 10px 5px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)', whiteSpace: 'nowrap', width: '1%' },
      tdDetail: {
        padding: '5px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
        wordBreak: 'break-word',
        overflowWrap: 'anywhere',
        lineHeight: 1.55,
        opacity: 0.88,
      },
      tagFixed: (k) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 46,
        fontSize: 11,
        lineHeight: '18px',
        whiteSpace: 'nowrap',
        padding: '0 8px',
        borderRadius: 6,
        background:
          k === 'share' ? 'var(--dsw-alias-bg-module-platform)' : k === 'qzone' ? 'var(--dsw-alias-bg-module-platform)' : k === 'speak' ? 'var(--dsw-alias-bg-module-platform)' : 'var(--dsw-alias-bg-module-platform)',
        color: k === 'share' ? 'var(--dsw-alias-state-success-primary)' : k === 'qzone' ? 'var(--dsw-alias-state-business-primary)' : k === 'speak' ? 'var(--dsw-alias-state-business-primary)' : 'inherit',
      }),
      tag: (k) => ({
        display: 'inline-block',
        fontSize: 11,
        padding: '0 7px',
        borderRadius: 999,
        background:
          k === 'share' ? 'var(--dsw-alias-bg-module-platform)' : k === 'qzone' ? 'var(--dsw-alias-bg-module-platform)' : k === 'speak' ? 'var(--dsw-alias-bg-module-platform)' : 'var(--dsw-alias-bg-module-platform)',
        color: k === 'share' ? 'var(--dsw-alias-state-success-primary)' : k === 'qzone' ? 'var(--dsw-alias-state-business-primary)' : k === 'speak' ? 'var(--dsw-alias-state-business-primary)' : 'inherit',
      }),
      msg: { padding: '4px 0', borderBottom: '1px solid var(--dsw-alias-border-l1)' },
      mon: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11.5 },
    };

    const 输入 = {
      font: 'inherit',
      fontSize: 12.5,
      padding: '3px 8px',
      borderRadius: 6,
      border: '1px solid var(--dsw-alias-border-l2)',
      background: 'transparent',
      color: 'inherit',
      width: 96,
    };
    const 行 = { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 7, flexWrap: 'wrap' };
    const 标签 = { minWidth: 132, fontSize: 12.5, opacity: 0.85 };
    const 说明 = { fontSize: 11.5, opacity: 0.55 };
    const 分组 = { marginBottom: 14 };
    const 组名 = { fontSize: 12, fontWeight: 600, opacity: 0.75, margin: '0 0 8px' };

    function 开关(值, 改法, 文案) {
      return h(
        'label',
        { style: { display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 12.5 } },
        h('input', { type: 'checkbox', checked: Boolean(值), onChange: (e) => 改法(e.target.checked) }),
        h('span', null, 文案),
      );
    }

    function 数字(值, 改法, { min, max, step, 后缀 } = {}) {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('input', {
          type: 'number',
          style: 输入,
          value: 值 ?? '',
          min,
          max,
          step: step || 1,
          onChange: (e) => 改法(e.target.value === '' ? '' : Number(e.target.value)),
        }),
        后缀 ? h('span', { style: 说明 }, 后缀) : null,
      );
    }

    function 文本(值, 改法, { width, placeholder } = {}) {
      return h('input', {
        type: 'text',
        style: { ...输入, width: width || 220 },
        value: 值 ?? '',
        placeholder: placeholder || '',
        onChange: (e) => 改法(e.target.value),
      });
    }

    // Schema selects accept legacy strings and labelled { value, label } options.
    function selectOptions(options) {
      return (options || []).map((option) => {
        const value = String((option && typeof option === 'object' ? option.value : option) ?? '');
        const label = option && typeof option === 'object' ? String(option.label ?? value) : value;
        return h('option', { key: value, value }, label);
      });
    }

    const reasoningEffortOptions = [
      { value: 'none', label: '不推理 · none' },
      { value: 'minimal', label: '极少 · minimal' },
      { value: 'low', label: '低 · low' },
      { value: 'medium', label: '中 · medium' },
      { value: 'high', label: '高 · high' },
      { value: 'xhigh', label: '极高 · xhigh' },
    ];
    function ReasoningEffortFields({ llm, onChange }) {
      const fields = [
        { path: 'llm.reasoningEffort', label: '默认思考程度', value: llm?.reasoningEffort, empty: '跟随接口默认（不传参数）' },
        { path: 'llm.reasoningEfforts.chat', label: '聊天思考程度', value: llm?.reasoningEfforts?.chat, empty: '继承默认思考程度' },
        { path: 'llm.reasoningEfforts.agent', label: '决策思考程度', value: llm?.reasoningEfforts?.agent, empty: '继承默认思考程度' },
        { path: 'llm.reasoningEfforts.background', label: '蒸馏思考程度', value: llm?.reasoningEfforts?.background, empty: '继承默认思考程度' },
      ];
      return h('div', null,
        h('div', { style: { ...说明, marginBottom: 8 } }, '思考程度 reasoning_effort：仅支持此参数的模型可用，不支持的模型或档位可能被接口拒绝；高档位通常更慢、费用更高。'),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 8 } },
          ...fields.map((field) => h('label', { key: field.path, style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: 12.5 } },
            h('span', null, field.label),
            h('select', { 'aria-label': field.label, value: String(field.value ?? ''), onChange: (event) => onChange(field.path, event.target.value), style: { ...输入框, width: '100%' } },
              ...selectOptions([{ value: '', label: field.empty }, ...reasoningEffortOptions]))))),
        h('div', { style: { ...说明, marginTop: 6 } }, '默认选「跟随接口」时不发送 reasoning_effort；分用途选「继承」时使用默认思考程度，蒸馏也一样。none 是显式档位，不等于留空。'));
    }

    const KIND_LABEL = { speak: '说话', share: '分享', qzone: '说说', op: '操作', skip: '跳过', none: '其他' };

    function timeText(ts) {
      if (!ts) return '—';
      const d = new Date(Number(ts));
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function bytesText(n) {
      if (!n) return '0';
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} K`;
      return `${(n / 1024 / 1024).toFixed(1)} M`;
    }

    // This catalog mirrors the scheduler IDs, not API credentials or endpoints.
    const NEWS_CATALOG = [
      ['60s', '60 秒认识世界', '10:00'], ['ai', 'AI 日报', '10:00'],
      ['ithome', 'IT 之家资讯', '10:00'], ['ithome-rank', 'IT 之家日榜', '10:00'],
      ['gold', '金价', '10:00'], ['epic', 'Epic 免费游戏', '18:00'],
      ['bangumi', '番剧更新', '18:00'], ['games', '新游资讯', '18:00'],
      ['bili', 'B 站热搜', '18:00'], ['weibo', '微博热搜', '18:00'],
      ['douyin', '抖音热搜', '18:00'], ['rednote', '小红书热点', '18:00'],
    ];
    const newsName = (source) => NEWS_CATALOG.find(([id]) => id === source)?.[1] || source;
    const newsTime = (cfg, id, recommended) => cfg.sourceTimes?.[id]
      ?? (['60s', 'ai', 'ithome'].includes(id) ? cfg.time || '10:00' : recommended);
    const newsRecordTime = (at) => Number.isFinite(Number(at))
      ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(Number(at)) : '—';
    const NEWS_STATUS = { sent: '已发送', unchanged: '内容未变 · 已去重', dry: '演练 · 未发送',
      'source-error': '来源失败', uncertain: '结果不明 · 不自动重发', sending: '发送中 / 待核查' };

    function DailyNewsPanel({ config, status, error, groups, draftTargets, savedTargets, change, dirty, saving, save, message }) {
      const cfg = config;
      const sources = cfg?.sources || [];
      const labelGroup = (scope) => {
        const group = groups.find((g) => `group:${g.group_id || g.id}` === scope);
        return group ? `${group.group_name || '群'} · ${scope.slice(6)}` : scope;
      };
      const rows = [];
      const seen = new Set();
      const append = (row, key) => {
        if (!row || seen.has(key)) return;
        seen.add(key); rows.push(row);
      };
      for (const event of status?.recentEvents || []) {
        append(event, `${event.at}/${event.source}/${event.scope || ''}/${event.status}`);
      }
      for (const [key, receipt] of Object.entries(status?.recent || {})) {
        const [date, scope, source] = key.split('/');
        append({ ...receipt, date, scope, source }, `${receipt.at}/${source}/${scope}/${receipt.status}`);
      }
      rows.sort((a, b) => Number(b.at) - Number(a.at));
      const currentGroups = status?.groups || [];
      const today = Object.values(status?.today || {});
      const counts = (kind) => today.filter((r) => r.status === kind).length;
      const draftChanged = JSON.stringify([...(draftTargets || [])].sort()) !== JSON.stringify([...(savedTargets || [])].sort());
      const field = (label, control, note) => h('div', { style: 行 }, h('span', { style: 标签 }, label), control,
        note ? h('span', { style: 说明 }, note) : null);
      const clock = (value, onChange, label) => h('input', { type: 'time', value, required: true, 'aria-label': label,
        style: { ...输入, width: 118 }, onChange: (e) => onChange(e.target.value) });
      return h('section', { style: S.card, 'aria-label': '每日资讯订阅' },
        h('div', { style: S.h2row }, h('h2', { style: S.h2inner }, '每日资讯订阅'),
          h('span', { style: S.pill() }, status ? `${status.enabled ? '已启用' : '已停用'}${status.running ? ' · 正在执行' : ''}` : '状态未知')),
        h('p', { style: S.dim }, '固定订阅独立于随机聊天和主动额度；只向已勾选的群推送，不发私聊、不发空间。保存后若正处于推送窗口，可能自动补发；需要测试时请先开启演练。'),
        error ? h('p', { role: 'alert', style: S.dim }, `资讯状态读取失败：${error}。不能据此认定今天未发送。`) : null,
        h('div', { style: S.pickBox },
          h('div', { style: S.pickHead }, '当前生效的接收群', h('span', null, `${currentGroups.length} 个`)),
          currentGroups.length ? h('div', { style: S.pickWrap }, ...currentGroups.map((sc) => h('span', { key: sc, style: S.chip(false) }, labelGroup(sc))))
            : h('span', { style: S.dim }, status ? '尚无可接收群：不会推送。请在下方「安全与活动范围 → 群」勾选并保存。' : '暂时无法确认接收群。'),
          h('div', { style: { ...S.dim, marginTop: 6 } }, '接收群沿用下方主动活动范围中的群，并排除黑名单、免打扰群及白名单之外的群；不会使用私聊选项。'),
          draftChanged ? h('div', { style: S.dim }, '活动范围有未保存修改：保存重启后才改变接收群，上方仍显示当前生效范围。') : null,
        ),
        status ? h('p', { style: S.dim }, `今日回执：发送 ${counts('sent')} · 去重 ${counts('unchanged')} · 待核查 ${counts('uncertain') + counts('sending')}。演练与来源失败见下方记录。`) : null,
        cfg ? h(React.Fragment, null,
          h('div', { style: 行 },
            开关(cfg.enabled, (v) => change('dailyNews.enabled', v), '启用每日资讯订阅'),
            开关(cfg.dryRun, (v) => change('dailyNews.dryRun', v), '资讯演练（不真发）'),
            开关(cfg.deduplicate !== false, (v) => change('dailyNews.deduplicate', v), '内容未变时去重')),
          h('div', { style: S.dim }, '机器人全局演练也会阻止资讯发送；资讯单独关闭演练不能覆盖全局设置。'),
          field('时区', h('span', null, 'Asia/Shanghai（北京时间）'), '下面所有时间均按此时区，不按浏览器时区'),
          field('三类早报默认时间', clock(cfg.time, (v) => change('dailyNews.time', v), '三类早报默认时间'), '仅用于 60 秒、AI 日报、IT 之家未单独设时的情况'),
          field('最早开始日期', h('input', { type: 'date', value: cfg.notBeforeDate || '', 'aria-label': '最早开始日期',
            style: { ...输入, width: 160 }, onChange: (e) => change('dailyNews.notBeforeDate', e.target.value) }), '可留空；早于此日期不推送'),
          field('错过后补发窗口', 数字(cfg.catchUpMinutes, (v) => change('dailyNews.catchUpMinutes', v), { min: 1, max: 180, 后缀: '分钟' }), '从各来源的推送时刻起计算，超过窗口不补发'),
          field('来源失败重试间隔', 数字(cfg.retryMinutes, (v) => change('dailyNews.retryMinutes', v), { min: 1, max: 60, 后缀: '分钟' })),
          field('不同来源间隔', 数字(Number(cfg.sourceGapMs) / 1000, (v) => change('dailyNews.sourceGapMs', v === '' ? '' : Math.round(v * 1000)), { min: 0, max: 10, step: 0.001, 后缀: '秒' })),
          h('div', { style: { ...行, marginTop: 12 } },
            h('strong', null, `订阅来源 · ${sources.length} / 12`),
            h('button', { type: 'button', style: S.btn(false), onClick: () => change('dailyNews.sources', NEWS_CATALOG.map(([id]) => id)) }, '全选'),
            h('button', { type: 'button', style: S.btn(false), onClick: () => change('dailyNews.sources', []) }, '全不选'),
            h('button', { type: 'button', style: S.btn(false), onClick: () => change('dailyNews.sourceTimes', Object.fromEntries(NEWS_CATALOG.map(([id, , time]) => [id, time]))) }, '恢复推荐时间（10 / 18 点）')),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))', gap: 8 } },
            ...NEWS_CATALOG.map(([id, name, recommended]) => h('div', { key: id, style: S.pickBox },
              h('div', { style: { ...行, marginBottom: 4, justifyContent: 'space-between' } },
                开关(sources.includes(id), (v) => change('dailyNews.sources', v ? [...sources.filter((s) => s !== id), id] : sources.filter((s) => s !== id)), name),
                clock(newsTime(cfg, id, recommended), (v) => change(`dailyNews.sourceTimes.${id}`, v), `${name}推送时间`)),
              h('div', { style: S.dim }, `${sources.includes(id) ? '已订阅' : '未订阅'} · 推荐 ${recommended}`)))),
          h('p', { style: S.dim }, '新游可选配 RAWG_API_KEY 扩展范围；未配置或主源失败时使用蒸汽平台中国区 PC 子集。此页不显示也不保存密钥。金价标注实际报价日，不冒充实时价格。'),
          h(JsonValueEditor, { value: cfg.sources || [], label: '订阅来源 JSON', onChange: (v) => change('dailyNews.sources', v) }),
          h(JsonValueEditor, { value: cfg.sourceTimes || {}, label: '来源时间 JSON', onChange: (v) => change('dailyNews.sourceTimes', v) }),
        ) : h('p', { style: S.dim }, '尚未取得可编辑配置，请稍后刷新。'),
        h('details', { style: { marginTop: 12 } },
          h('summary', { style: { cursor: 'pointer' } }, `最近资讯执行记录 · ${Math.min(rows.length, 50)} 条`),
          h('p', { style: S.dim }, '来源失败会在补发窗口内重试；发送结果不明或进程中断的发送意图不会自动重发，避免刷屏。'),
          !rows.length ? h('p', { style: S.dim }, '暂无回执或执行记录；这不等于已成功推送。')
            : h('div', { style: { overflowX: 'auto' } }, h('table', { style: S.table },
              h('thead', null, h('tr', null, ...['时间', '来源 / 接收群', '结果与原因'].map((title) => h('th', { key: title, style: S.th }, title)))),
              h('tbody', null, ...rows.slice(0, 50).map((row, i) => h('tr', { key: `${row.at}/${i}` },
                h('td', { style: S.tdTime }, newsRecordTime(row.at)),
                h('td', { style: { ...S.td, minWidth: 130 } }, newsName(row.source), h('div', { style: S.dim }, row.scope ? labelGroup(row.scope) : '来源抓取阶段')),
                h('td', { style: S.tdDetail }, NEWS_STATUS[row.status] || row.status,
                  row.error ? h('div', null, row.error) : null,
                  row.messageId ? h('div', { style: S.dim }, `消息 ID：${row.messageId}`) : null,
                  row.date ? h('div', { style: S.dim }, `订阅日：${row.date}`) : null)))))),
        ),
      );
    }


    // 「全部配置」：照着宿主给的 schema 渲染，字段增删只改 snowluma-qq 的 src/schema.mjs
    // Each path has one editable owner. Complex lists retain a text editor in the
    // dedicated card so advanced filtering never discards unknown/offline entries.
    function JsonValueEditor({ value, onChange, label }) {
      const [text, setText] = React.useState(() => JSON.stringify(value ?? [], null, 2));
      const [error, setError] = React.useState('');
      const dirty = React.useRef(false);
      React.useEffect(() => { if (!dirty.current) setText(JSON.stringify(value ?? [], null, 2)); }, [value]);
      return h('details', { style: { marginTop: 6 } },
        h('summary', { style: { ...S.dim, cursor: 'pointer', overflowWrap: 'anywhere' } }, `${label} · ${Array.isArray(value) ? value.length ? value.join('、') : '未设置' : `${Object.keys(value || {}).length} 项`}`),
        h('div', { style: S.dim }, '用于完整编辑自定义值；合法 JSON 会自动加入当前草稿，随后统一保存。'),
        h('textarea', { value: text, rows: 3, spellCheck: false, 'aria-label': label,
          style: { ...输入框, fontFamily: 'monospace' }, onChange: (event) => {
            const next = event.target.value; setText(next); dirty.current = true;
            try {
              const parsed = JSON.parse(next);
              if (Array.isArray(value) ? !Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')
                : !parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some((v) => typeof v !== 'string')) throw new Error('需要字符串列表或时间映射');
              setError(''); dirty.current = false; onChange(parsed);
            } catch { setError('格式无效，尚未应用；请填写合法 JSON。'); }
          } }),
        error ? h('div', { role: 'alert', style: { ...S.dim, color: T.warn } }, error) : null);
    }
    const 常用配置路径 = new Set([
      'agent.enabled', 'agent.everyMinutes', 'agent.jitterMinutes', 'agent.minGapMs',
      'agent.group.minPerDay', 'agent.group.maxPerDay', 'agent.private.minPerDay', 'agent.private.maxPerDay',
      'agent.quietHours', 'agent.shareEveryHours', 'agent.qzoneEveryHours', 'agent.dryRun', 'agent.allowDestructive', 'agent.targets',
      'chat.randomInterject.chance', 'chat.replyOnMention', 'chat.replyOnReplyToMe', 'chat.replyPrivate', 'chat.aiDecide',
      'chat.maxReplyChars', 'chat.historyChars', 'chat.recentSelfEcho',
      'llm.model', 'llm.models.chat', 'llm.models.agent', 'llm.maxTokens', 'llm.temperature',
      'llm.reasoningEffort', 'llm.reasoningEfforts.chat', 'llm.reasoningEfforts.agent', 'llm.reasoningEfforts.background',
      'share.interests', 'share.sources', 'persona.name', 'persona.likes', 'persona.systemPrompt',
      'dailyNews.enabled', 'dailyNews.time', 'dailyNews.timeZone', 'dailyNews.retryMinutes', 'dailyNews.catchUpMinutes',
      'dailyNews.sources', 'dailyNews.sourceTimes', 'dailyNews.deduplicate', 'dailyNews.sourceGapMs', 'dailyNews.dryRun', 'dailyNews.notBeforeDate',
    ]);
    const 高级配置组 = (schema) => (schema || []).map((group) => ({ ...group,
      fields: (group.fields || []).filter((field) => !常用配置路径.has(field.path)),
    })).filter((group) => group.fields.length);
    const 配置字段表 = (组) =>
      Object.fromEntries((组 || []).flatMap((g) => (g.fields || []).map((f) => [f.path, f])));

    const 初始草稿 = (组) => {
      const out = {};
      for (const g of 组 || []) {
        for (const f of g.fields || []) {
          if (f.type === 'json') out[f.path] = f.value == null ? '' : JSON.stringify(f.value, null, 2);
          else if (f.type === 'csv') out[f.path] = Array.isArray(f.value) ? f.value.join('\n') : String(f.value ?? '');
          else if (f.type === 'secret') out[f.path] = '';
          else if (f.type === 'bool') out[f.path] = Boolean(f.value);
          else if (f.type === 'number') out[f.path] = f.value == null ? '' : f.value;
          else out[f.path] = f.value == null ? '' : String(f.value);
        }
      }
      return out;
    };

    function ConfigPanel({ schema, onSaved }) {
      const { live, later } = useLifetime();
      const 组 = Array.isArray(schema) ? schema : [];
      const [选中, 设选中] = React.useState(组[0] ? 组[0].id : '');
      const [草稿, 设草稿] = React.useState(() => 初始草稿(组));
      const [脏, 设脏] = React.useState(false);
      const [忙, 设忙] = React.useState(false);
      const [话, 设话] = React.useState('');
      const 基线 = React.useRef(初始草稿(组));
      const 脏Ref = React.useRef(false);
      const 忙Ref = React.useRef(false);
      React.useEffect(() => {
        if (!组.length || 脏Ref.current || 忙Ref.current) return;
        // 空闲时同步最新值，编辑中保留草稿；保存只提交相对基线真正改过的字段。
        基线.current = 初始草稿(组);
        设草稿(基线.current);
      }, [schema]);
      if (!组.length) return null;
      const 当前 = 组.find((g) => g.id === 选中) || 组[0];
      const 字段 = 配置字段表(组);
      const 改 = (path, v) => { 脏Ref.current = true; 设草稿((old) => ({ ...old, [path]: v })); 设脏(true); 设话(''); };

      const 存 = async () => {
        if (忙Ref.current || configWrite.busy) { 设话('另一个设置保存仍在进行，请稍后再试'); return; }
        const updates = {};
        for (const [path, raw] of Object.entries(草稿)) {
          const f = 字段[path];
          if (!f || raw === 基线.current[path]) continue;
          if (f.type === 'bool') updates[path] = Boolean(raw);
          else if (f.type === 'number') {
            if (raw === '' || raw == null) continue;
            const n = Number(raw);
            if (!Number.isFinite(n)) { 设话(`${f.label} 需要数字`); return; }
            updates[path] = n;
          } else if (f.type === 'csv') updates[path] = String(raw ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
          else if (f.type === 'json') {
            const text = String(raw ?? '').trim();
            if (!text) { updates[path] = []; continue; }
            try { updates[path] = JSON.parse(text); } catch (e) { 设话(`${f.label} 不是合法 JSON：${e.message}`); return; }
          } else if (f.type === 'secret') { if (String(raw ?? '')) updates[path] = String(raw); } else updates[path] = String(raw ?? '');
        }
        if (!Object.keys(updates).length) { 脏Ref.current = false; 设脏(false); 设话('没有实际改动'); return; }
        configWrite.busy = true;
        忙Ref.current = true; 设忙(true); 设话('保存中…');
        const r = await post('/config', { updates });
        configWrite.busy = false;
        忙Ref.current = false;
        if (!live.current) return;
        设忙(false);
        if (r && r.ok) {
          const 新草稿 = { ...草稿 };
          for (const [path, f] of Object.entries(字段)) if (f.type === 'secret') 新草稿[path] = '';
          基线.current = 新草稿;
          设草稿(新草稿);
          脏Ref.current = false; 设脏(false);
          设话('已保存，进程正在重启，几秒后新配置生效');
          later(() => onSaved && onSaved(), 3500);
        } else {
          设话(`保存失败：${(r && (r.error || (r.result && r.result.error))) || '未知错误'}`);
        }
      };

      const 控件 = (f) => {
        const v = 草稿[f.path];
        if (f.type === 'bool') {
          return h('label', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: Boolean(v), onChange: (e) => 改(f.path, e.target.checked) }),
            h('span', { style: { fontSize: 12, opacity: 0.7 } }, v ? '开' : '关'));
        }
        if (f.type === 'select') {
          return h('select', { value: String(v || ''), onChange: (e) => 改(f.path, e.target.value), style: 输入框 },
            ...selectOptions(f.options));
        }
        if (f.type === 'textarea' || f.type === 'json') {
          return h('textarea', { value: String(v ?? ''), rows: f.type === 'json' ? 4 : 5, spellCheck: false,
            onChange: (e) => 改(f.path, e.target.value),
            style: { ...输入框, fontFamily: f.type === 'json' ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : 'inherit', resize: 'vertical' } });
        }
        if (f.type === 'csv') {
          return h('textarea', { value: String(v ?? ''), rows: 3, spellCheck: false,
            onChange: (e) => 改(f.path, e.target.value),
            style: { ...输入框, resize: 'vertical' }, placeholder: '一行一个' });
        }
        if (f.type === 'number') {
          return h('input', { type: 'number', value: v ?? '', min: f.min, max: f.max, step: f.step || 1,
            onChange: (e) => 改(f.path, e.target.value), style: 输入框 });
        }
        if (f.type === 'secret') {
          return h('input', { type: 'password', value: String(v ?? ''), placeholder: f.set ? '已设置（留空不改）' : '未设置',
            onChange: (e) => 改(f.path, e.target.value), style: 输入框 });
        }
        return h('input', { type: 'text', value: String(v ?? ''), onChange: (e) => 改(f.path, e.target.value), style: 输入框 });
      };

      return h('div', { style: S.card },
        h('h2', { style: S.h2 }, '高级参数'),
        h('div', { style: { ...S.dim, marginBottom: 8 } },
          '这里只列出常用设置未覆盖的参数；连接与密钥仍在这里。密钥留空不改，高级参数单独保存。'),
        h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
          ...组.map((g) =>
            h('button', {
              key: g.id,
              style: { ...S.btn(选中 === g.id), padding: '4px 10px', fontSize: 12.5 },
              onClick: () => 设选中(g.id),
            }, `${g.title} ${g.fields.length}`))),
        当前 && 当前.note ? h('div', { style: { ...S.dim, marginBottom: 8 } }, 当前.note) : null,
        h('fieldset', { disabled: 忙, style: { border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 10 } },
          ...(当前 ? 当前.fields : []).map((f) =>
            h('div', { key: f.path, style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
              h('div', { style: { fontSize: 12.5, fontWeight: 500 } }, f.label,
                f.path.includes('.') ? h('span', { style: { ...S.dim, marginLeft: 6, fontSize: 10.5 } }, f.path) : null),
              f.hint ? h('div', { style: { ...S.dim, fontSize: 11 } }, f.hint) : null,
              控件(f)))),
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' } },
          h('button', { style: S.btn(true), disabled: !脏 || 忙, onClick: 存 }, 忙 ? '保存中…' : '保存并重启'),
          h('button', { style: S.btn(false), disabled: !脏 || 忙, onClick: () => { 基线.current = 初始草稿(组); 设草稿(基线.current); 脏Ref.current = false; 设脏(false); 设话(''); } }, '撤销改动'),
          脏 ? h('span', { style: { ...S.dim, color: 'var(--dsw-alias-state-warn-primary)' } }, '有未保存的改动') : null,
          话 ? h('span', { style: S.dim }, 话) : null),
      );
    }

    const 输入框 = {
      width: '100%', boxSizing: 'border-box', padding: '5px 8px', fontSize: 12.5, lineHeight: 1.5,
      borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)',
      background: 'var(--dsw-alias-bg-layer-2)', color: 'inherit', fontFamily: 'inherit',
    };

    // Scope reply state is authoritative, never inferred from a successful click.
    function scopeReplyState(response, scope) {
      const state = response?.result;
      if (response?.ok !== true || state?.ok !== true || state.scope !== scope ||
          typeof state.autochat !== 'boolean' || typeof state.globalEnabled !== 'boolean' ||
          state.effectiveEnabled !== (state.autochat && state.globalEnabled)) {
        throw new Error(response?.error || '无法确认当前会话回复状态，请刷新重试');
      }
      return { autochat: state.autochat, globalEnabled: state.globalEnabled, effectiveEnabled: state.effectiveEnabled };
    }
    function createScopeReplies({ get, post, update }) {
      const entries = new Map();
      let disposed = false;
      const entry = (scope) => {
        if (!entries.has(scope)) entries.set(scope, { version: 0, reading: false, writing: false, value: {} });
        return entries.get(scope);
      };
      const publish = (scope, e, value) => { e.value = value; if (!disposed) update(scope, value); };
      async function run(scope, enabled) {
        if (!scope || disposed) return;
        const e = entry(scope), write = typeof enabled === 'boolean';
        if (e.writing || (!write && e.reading)) return;
        const version = ++e.version;
        if (write) e.writing = true; else e.reading = true;
        publish(scope, e, { ...e.value, loading: true, writing: write, error: '' });
        try {
          const response = write ? await post('/autochat', { scope, enabled }) : await get(`/autochat?scope=${encodeURIComponent(scope)}`);
          if (!disposed && e.version === version) publish(scope, e, { ...scopeReplyState(response, scope), loading: false, writing: false, error: '' });
        } catch (error) {
          if (!disposed && e.version === version) publish(scope, e, { loading: false, writing: false, error: error.message || '读取会话回复状态失败' });
        } finally {
          if (write) e.writing = false; else e.reading = false;
        }
      }
      return { read: (scope) => run(scope), set: (scope, enabled) => run(scope, enabled), dispose: () => { disposed = true; } };
    }

    // 对话：左边会话列表，右边消息流 + 发消息 + 当前会话回复开关
    function ChatsPanel({ scopes, groups, online }) {
      const list = (Array.isArray(scopes) ? scopes : [])
        .map((s) => (typeof s === 'string' ? { scope: s } : s))
        .filter((s) => s && /^(group|private):/.test(String(s.scope || '')))
        .sort((a, b) => Number(b.lastTs || 0) - Number(a.lastTs || 0));
      const nameOf = (scope) => {
        for (const g of Array.isArray(groups) ? groups : []) {
          const id = g.group_id ?? g.groupId ?? g.id;
          if (id && `group:${id}` === scope) return g.group_name || g.name || scope;
        }
        return scope;
      };
      const { live, later } = useLifetime();
      const [cur, 设Cur] = React.useState('');
      const [msgs, 设Msgs] = React.useState([]);
      const [drafts, setDrafts] = React.useState({});
      const [notes, 设Notes] = React.useState({});
      const [pending, setPending] = React.useState({});
      const [autoStates, setAutoStates] = React.useState({});
      const [错, 设错] = React.useState('');
      const currentScope = React.useRef(cur);
      currentScope.current = cur;
      const requestId = React.useRef(0);
      const locks = React.useRef(new Set());
      const text = drafts[cur] || '';
      const busy = Boolean(pending[`send:${cur}`]);
      const autoBusy = Boolean(autoStates[cur]?.writing);
      const replyController = React.useRef(null);
      React.useEffect(() => {
        const controller = createScopeReplies({ get, post, update: (scope, state) => {
          if (live.current) setAutoStates((old) => ({ ...old, [scope]: state }));
        } });
        replyController.current = controller;
        return () => { controller.dispose(); replyController.current = null; };
      }, []);
      const replyState = autoStates[cur];
      const 开 = replyState?.autochat ?? null;
      const 设Text = (value) => setDrafts((old) => ({ ...old, [cur]: value }));
      const choose = (scope) => { currentScope.current = scope; requestId.current += 1; 设Msgs([]); 设错(''); 设Cur(scope); };
      const scopeKeys = list.map((item) => item.scope).join('|');
      React.useEffect(() => {
        if (!list.some((item) => item.scope === cur)) choose(list[0]?.scope || '');
      }, [scopeKeys, cur]);
      const 读 = React.useCallback(async (scope) => {
        if (!scope || currentScope.current !== scope) return;
        const id = ++requestId.current;
        const r = await get(`/messages?scope=${encodeURIComponent(scope)}&limit=80`);
        if (!live.current || id !== requestId.current || currentScope.current !== scope) return;
        if (r.ok && (!r.scope || r.scope === scope)) { 设Msgs(Array.isArray(r.messages) ? r.messages : []); 设错(''); }
        else 设错(r.error || '读不到消息');
      }, []);
      React.useEffect(() => {
        let active = true;
        let timer;
        const poll = async () => {
          await Promise.all([读(cur), replyController.current?.read(cur)]);
          if (active && cur) timer = setTimeout(poll, 6000);
        };
        poll();
        return () => { active = false; clearTimeout(timer); requestId.current += 1; };
      }, [cur, 读]);
      const runScoped = async (kind, scope, body) => {
        const key = `${kind}:${scope}`;
        if (!scope || locks.current.has(key)) return null;
        locks.current.add(key); setPending((old) => ({ ...old, [key]: true }));
        const result = await post(kind === 'send' ? '/send' : '/autochat', body);
        locks.current.delete(key);
        if (!live.current) return null;
        setPending((old) => ({ ...old, [key]: false }));
        return result;
      };
      const 发 = async () => {
        const scope = cur;
        const body = text.trim();
        if (!body || !scope || locks.current.has(`send:${scope}`)) return;
        const r = await runScoped('send', scope, { scope, text: body });
        if (!r) return;
        设Notes((n) => ({ ...n, [scope]: r.ok ? '已发出' : `发送失败：${r.error || '未知错误'}` }));
        if (r.ok) setDrafts((old) => old[scope]?.trim() === body ? { ...old, [scope]: '' } : old);
        later(() => 读(scope), 800);
      };
      const 自动 = (enabled) => replyController.current?.set(cur, enabled);

      const 时间 = (at) => {
        const n = Number(at) || 0;
        if (!n) return '';
        const d = new Date(n);
        return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      };

      return h(
        'div',
        { className: 'qq-chats', style: { ...S.card, display: 'flex', flexWrap: 'wrap', gap: 14, minHeight: 420, padding: 12 } },
        // 会话列表
        h(
          'div',
          { className: 'qq-chat-list', style: { width: 210, flex: '1 1 180px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 560, overflow: 'auto' } },
          h('div', { style: { ...S.dim, padding: '2px 6px' } }, `会话 ${list.length}`),
          ...list.map((s) =>
            h(
              'button',
              {
                key: s.scope,
                onClick: () => choose(s.scope),
                style: {
                  textAlign: 'left',
                  padding: '7px 9px',
                  borderRadius: 8,
                  border: '1px solid ' + (cur === s.scope ? 'var(--dsw-alias-bg-module-platform)' : 'var(--dsw-alias-border-l2)'),
                  background: cur === s.scope ? 'var(--dsw-alias-bg-module-platform)' : 'transparent',
                  cursor: 'pointer',
                  color: 'inherit',
                  font: 'inherit',
                },
              },
              h('div', { style: { fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, nameOf(s.scope)),
              h('div', { style: { fontSize: 11, opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, String(s.lastText || '').slice(0, 24) || s.scope),
            ),
          ),
          list.length ? null : h('div', { style: S.dim }, '还没有会话。等机器人收到第一句话。'),
        ),
        // 消息流
        h(
          'div',
          { style: { flex: '3 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('div', { style: { ...S.h2, margin: 0 } }, cur ? nameOf(cur) : '选一个会话'),
            h('span', { style: S.pill(online ? 'ok' : 'bad') }, online ? '在线' : '掉线'),
            h('button', { style: S.btn(false), disabled: !cur, onClick: () => { 读(cur); replyController.current?.read(cur); } }, '刷新'),
            h('span', { style: S.dim }, `当前会话回复：${replyState?.error ? '状态未知' : 开 === null ? (cur ? '读取中…' : '未选择会话') : 开 ? '允许' : '暂停'}${replyState?.loading && 开 !== null ? '（更新中…）' : ''}`),
            h('button', { style: S.btn(开 === true), disabled: !cur || autoBusy || 开 === true, onClick: () => 自动(true) }, '允许回复'),
            h('button', { style: S.btn(开 === false), disabled: !cur || autoBusy || 开 === false, onClick: () => 自动(false) }, '暂停回复'),
          ),
          h('div', { style: S.dim }, '只控制当前会话的被动回复；暂停后即使 @ 也不回复，不影响主动搭话。允许后仍受全局开关和触发规则限制。'),
          replyState?.globalEnabled === false ? h('div', { style: S.dim }, '全局自动聊天已关闭：当前会话即使允许回复，也不会自动回复。请到设置中开启全局开关。') : null,
          replyState?.error ? h('div', { role: 'alert', style: { ...S.dim, color: 'var(--dsw-alias-state-error-primary)' } }, `${replyState.error}；状态未确认，请刷新后再操作。`) : null,
          错 ? h('div', { style: { ...S.dim, color: 'var(--dsw-alias-state-error-primary)' } }, 错) : null,
          h(
            'div',
            { style: { flex: 1, overflow: 'auto', maxHeight: 420, padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 6 } },
            ...msgs.map((m, i) => {
              const 是机器人 = m.role === 'bot';
              return h(
                'div',
                { key: i, style: { display: 'flex', justifyContent: 是机器人 ? 'flex-end' : 'flex-start' } },
                h(
                  'div',
                  {
                    style: {
                      maxWidth: '78%',
                      padding: '6px 9px',
                      borderRadius: 9,
                      background: 是机器人 ? 'var(--dsw-alias-bg-module-platform)' : 'var(--dsw-alias-border-l2)',
                      fontSize: 12.5,
                      lineHeight: 1.45,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    },
                  },
                  h('div', { style: { fontSize: 10.5, opacity: 0.55, marginBottom: 2 } }, `${m.name || (是机器人 ? '机器人' : '?')} · ${时间(m.at)}`),
                  m.text,
                ),
              );
            }),
            msgs.length ? null : h('div', { style: S.dim }, '没有消息'),
          ),
          notes[cur] ? h('div', { style: { ...S.dim, color: String(notes[cur]).includes('失败') ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, notes[cur]) : null,
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h('input', {
              value: text,
              placeholder: cur ? `以机器人身份发给 ${nameOf(cur)}（Enter 发送）` : '先选会话',
              disabled: !cur,
              onChange: (e) => 设Text(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing && !e.isComposing) {
                  e.preventDefault();
                  发();
                }
              },
              style: {
                flex: 1,
                padding: '7px 10px',
                borderRadius: 8,
                border: '1px solid var(--dsw-alias-border-l2)',
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
              },
            }),
            h('button', { style: S.btn(true), disabled: busy || !cur || !text.trim(), onClick: 发 }, busy ? '发送中…' : '发送'),
          ),
        ),
      );
    }

    function loginDetail(value, secret = '') {
      let text = String(value || '');
      if (secret) text = text.split(secret).join('[private password]');
      return text.replace(/data:image\/[^\s]+/gi, '[private image]').slice(0, 700);
    }
    function remoteDesktopPassword(result) {
      if (result?.ok !== true) throw new Error(loginDetail(result?.error || result?.reason, typeof result?.password === 'string' ? result.password : '') || tr('desktopCopyFailed'));
      if (typeof result.password !== 'string' || !result.password || result.password.length > 4096 || /[\r\n\0]/.test(result.password)) throw new Error(tr('desktopCopyInvalid'));
      return result.password;
    }
    function napcatWebuiToken(result) {
      if (result?.ok !== true || typeof result.token !== 'string' || !/^[\x21-\x7e]{16,4096}$/.test(result.token)) throw new Error(tr('napcatCopyInvalid'));
      return result.token;
    }
    // Deliberately synchronous: after fetch, execCommand can still work on HTTP.
    // A fresh trusted retry click also runs this before any promise/await.
    function legacyCopyPassword(value) {
      const previous = document.activeElement;
      const field = document.createElement('textarea');
      field.value = value;
      field.readOnly = true;
      field.tabIndex = -1;
      field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
      try {
        document.body.appendChild(field);
        field.focus({ preventScroll: true });
        field.select();
        field.setSelectionRange(0, field.value.length);
        return document.execCommand('copy') === true;
      } finally {
        field.value = '';
        field.remove();
        try { previous?.focus({ preventScroll: true }); } catch { /* Focus restoration is best-effort. */ }
      }
    }
    async function copyDesktopPassword(value, legacyCopy, secureCopy, isCurrent, timeoutMs = 2000) {
      let failure = '';
      if (!isCurrent()) return { ok: false, error: tr('desktopCopyExpired') };
      try { if (legacyCopy(value) === true) return { ok: true }; failure = tr('desktopCopyDenied'); }
      catch (error) { failure = loginDetail(error.message || error, value); }
      if (!secureCopy) return { ok: false, error: failure + '; ' + tr('desktopCopyUnavailable') };
      let timer;
      const redaction = { value };
      try {
        // Invoke writeText synchronously too, preserving activation on the retry.
        const pending = secureCopy(value);
        value = '';
        const outcome = await Promise.race([
          Promise.resolve(pending).then(() => ({ ok: true }), error => ({ ok: false, error: redaction.value ? loginDetail(error.message || error, redaction.value) : tr('desktopCopyExpired') })),
          new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: tr('desktopCopyTimeout') }), timeoutMs); }),
        ]);
        return isCurrent() ? outcome : { ok: false, error: tr('desktopCopyExpired') };
      } catch (error) { return { ok: false, error: loginDetail(error.message || error, redaction.value) || failure }; }
      finally { value = ''; redaction.value = ''; clearTimeout(timer); }
    }

    // User-only credential action. No effect fetches it, and no model tool sees it.
    function DesktopPasswordCopy() {
      const napcat = arguments[0]?.napcat === true;
      const label = key => tr(napcat ? ({ desktopCopy: 'napcatCopy', desktopCopied: 'napcatCopied', desktopCopyField: 'napcatCopyField', desktopCopyNote: 'napcatCopyNote', desktopCopyFailed: 'napcatCopyFailed', desktopCopyInvalid: 'napcatCopyInvalid', desktopCopyExpired: 'napcatCopyExpired' }[key] || key) : key);
      const [busy, setBusy] = React.useState(false);
      const [fallback, setFallback] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [copied, setCopied] = React.useState(false);
      const secret = React.useRef(null);
      const input = React.useRef(null);
      const mounted = React.useRef(false);
      const life = React.useRef(0);
      const lock = React.useRef(null);
      const expiry = React.useRef(null);
      const clearSecret = () => {
        if (secret.current) secret.current.value = '';
        secret.current = null;
        if (input.current) { input.current.value = ''; input.current.type = 'password'; }
        clearTimeout(expiry.current); expiry.current = null;
      };
      React.useEffect(() => {
        mounted.current = true; life.current += 1;
        return () => { mounted.current = false; life.current += 1; lock.current = null; clearSecret(); };
      }, []);
      const run = async (retry = false) => {
        if (!mounted.current || lock.current) return;
        const ticket = {}, epoch = life.current;
        const current = () => mounted.current && life.current === epoch && lock.current === ticket;
        lock.current = ticket; setBusy(true); setMessage(''); setCopied(false);
        try {
          if (!retry) {
            clearSecret(); setFallback(false);
            const result = napcat ? await post('/login/napcat/token', {}) : await post('/login/original/password', {});
            let value;
            try {
              if (!current()) return;
              value = napcat ? napcatWebuiToken(result) : remoteDesktopPassword(result);
            } finally {
              if (result && typeof result === 'object') { result.password = ''; if (napcat) result.token = ''; }
            }
            secret.current = { value, expiresAt: Date.now() + 30000 };
            value = '';
            expiry.current = setTimeout(() => {
              clearSecret();
              if (mounted.current && life.current === epoch) { setFallback(false); setCopied(false); setMessage(label('desktopCopyExpired')); }
            }, 30000);
          }
          const held = secret.current;
          if (!held?.value || held.expiresAt <= Date.now()) { clearSecret(); setFallback(false); setMessage(label('desktopCopyExpired')); return; }
          const secureCopy = window.isSecureContext && typeof navigator.clipboard?.writeText === 'function'
            ? value => navigator.clipboard.writeText(value) : null;
          const result = await copyDesktopPassword(held.value, legacyCopyPassword, secureCopy,
            () => current() && secret.current === held && held.expiresAt > Date.now());
          if (!current() || secret.current !== held) return;
          if (result.ok) {
            clearSecret(); setFallback(false); setCopied(true); setMessage(label('desktopCopied'));
          } else {
            setFallback(true); setMessage(label('desktopCopyFallback') + ' ' + loginDetail(result.error, held.value));
          }
        } catch (error) {
          if (current()) { const reason = loginDetail(error.message || error, secret.current?.value); clearSecret(); setFallback(false); setMessage(label('desktopCopyFailed') + ': ' + reason); }
        } finally {
          if (lock.current === ticket) lock.current = null;
          if (mounted.current && life.current === epoch) setBusy(false);
        }
      };
      const reveal = () => {
        if (!secret.current?.value || secret.current.expiresAt <= Date.now()) { clearSecret(); setFallback(false); setMessage(label('desktopCopyExpired')); return; }
        if (input.current) { input.current.type = 'text'; input.current.focus(); input.current.select(); }
      };
      return h('div', { style: { marginTop: 8 }, 'aria-busy': busy },
        h('button', { type: 'button', style: S.btn(false), disabled: busy, onClick: () => run(false) }, label(busy ? 'desktopCopying' : 'desktopCopy')),
        h('p', { style: S.dim }, label('desktopCopyNote')),
        message ? h('p', { role: copied ? 'status' : 'alert', style: { ...S.dim, color: copied ? T.success : T.warn, overflowWrap: 'anywhere' } }, message) : null,
        fallback && secret.current ? h('div', { style: { ...行, marginTop: 6 } },
          h('input', { ref: input, type: 'password', readOnly: true, value: secret.current.value, autoComplete: 'off', spellCheck: false,
            'aria-label': label('desktopCopyField'), style: { ...输入框, width: 220, maxWidth: '100%' } }),
          h('button', { type: 'button', style: S.btn(false), disabled: busy, onClick: () => run(true) }, label('desktopCopyRetry')),
          h('button', { type: 'button', style: S.btn(false), disabled: busy, onClick: reveal }, label('desktopCopyReveal'))) : null);
    }

    // Only this exact relative URL is accepted; the public mount is resolved above.
    function desktopViewPath(result, mount, now = Date.now()) {
      const expires = typeof result?.expiresAt === 'number' ? result.expiresAt : Date.parse(result?.expiresAt);
      if (!['/dsh-qq/login/desktop/view', '/dsh-qq/login/original', '/dsh-qq/login/napcat'].includes(result?.url) || !Number.isFinite(expires) || expires <= now) {
        throw new Error(tr('desktopInvalid'));
      }
      return mount + result.url;
    }
    async function navigateToQQLogin(createSession, navigate, isCurrent, mount) {
      const result = await createSession();
      if (!isCurrent()) return;
      if (!result?.ok) throw new Error(result?.error || result?.reason || tr('desktopFailed'));
      navigate(desktopViewPath(result, mount));
    }

    function LoginPanel() {
      const napcat = arguments[0]?.backend === 'napcat';
      const [status, setStatus] = React.useState(null);
      const [checking, setChecking] = React.useState(false);
      const [opening, setOpening] = React.useState(false);
      const [statusError, setStatusError] = React.useState('');
      const [openError, setOpenError] = React.useState('');
      const mounted = React.useRef(false);
      const life = React.useRef(0);
      const statusLock = React.useRef(null);
      const openLock = React.useRef(null);
      const detail = loginDetail;
      const readStatus = async (epoch = life.current) => {
        if (!mounted.current || life.current !== epoch || statusLock.current) return;
        const ticket = {};
        statusLock.current = ticket; setChecking(true);
        try {
          const result = await get('/login/status');
          if (!mounted.current || life.current !== epoch) return;
          if (!result?.ok || !['logged_in', 'waiting_scan', 'qr_captured', 'unavailable'].includes(result.state)) {
            setStatus(null); setStatusError(detail(result?.error || result?.reason) || tr('loginFailed'));
          } else {
            setStatus({ backend: result.backend, state: result.state, account: result.account, reason: detail(result.reason) });
            setStatusError('');
          }
        } catch (error) {
          if (mounted.current && life.current === epoch) { setStatus(null); setStatusError(detail(error.message) || tr('loginFailed')); }
        } finally {
          if (statusLock.current === ticket) statusLock.current = null;
          if (mounted.current && life.current === epoch) setChecking(false);
        }
      };
      React.useEffect(() => {
        mounted.current = true;
        const epoch = ++life.current;
        // A deferred status read avoids StrictMode's discarded effect. No polling.
        const timer = setTimeout(() => readStatus(epoch), 0);
        return () => {
          mounted.current = false; life.current += 1;
          statusLock.current = null; openLock.current = null; clearTimeout(timer);
          // The standalone viewer now owns the session. Never close it on unmount
          // or page navigation; abandoned sessions expire on the server (10 min).
        };
      }, []);
      const open = async () => {
        if (!mounted.current || openLock.current) return;
        const ticket = {}, epoch = life.current;
        openLock.current = ticket; setOpening(true); setOpenError('');
        try {
          await navigateToQQLogin(() => post('/login/desktop/session', {}),
            (url) => window.location.assign(url),
            () => mounted.current && life.current === epoch, basePath);
        } catch (error) {
          if (mounted.current && life.current === epoch) setOpenError(detail(error.message) || tr('desktopFailed'));
        } finally {
          // POST is bounded by request's 45s timeout. Always permit retry after
          // errors (including auth, bad response, or failed navigation).
          if (openLock.current === ticket) openLock.current = null;
          if (mounted.current && life.current === epoch) setOpening(false);
        }
      };
      const loggedIn = status?.state === 'logged_in';
      const stateLabel = loggedIn ? 'loginLoggedIn' : ['waiting_scan', 'qr_captured'].includes(status?.state) ? 'loginWaiting'
        : status?.state === 'unavailable' || statusError ? 'loginUnavailable' : 'loginUnknown';
      return h('section', { style: S.card, 'aria-label': tr('loginTitle'), 'aria-busy': opening || checking },
        h('div', { style: { ...S.h2row, flexWrap: 'wrap' } }, h('h2', { style: S.h2inner }, tr('loginTitle')),
          h('span', { role: 'status', style: S.pill(loggedIn ? 'ok' : '') }, tr(stateLabel),
            loggedIn && status.account?.user_id ? ` · ${detail(status.account.nickname)} (${detail(status.account.user_id)})` : ''),
          h('button', { type: 'button', style: S.btn(false), disabled: checking,
            onClick: () => readStatus() }, tr(checking ? 'loginChecking' : 'loginCheck'))),
        h('p', { style: S.dim }, tr(napcat ? 'napcatIntro' : 'loginIntro')),
        status?.reason ? h('p', { style: { ...S.dim, overflowWrap: 'anywhere' } }, status.reason) : null,
        statusError ? h('p', { role: 'alert', style: { color: T.error, overflowWrap: 'anywhere' } }, statusError) : null,
        h('button', { type: 'button', style: S.btn(true), disabled: opening, onClick: open }, tr(opening ? 'desktopOpening' : napcat ? 'napcatOpen' : 'desktopOpen')),
        napcat ? h(DesktopPasswordCopy, { key: 'napcat', napcat: true }) : h(DesktopPasswordCopy),
        openError ? h('p', { role: 'alert', style: { color: T.error, overflowWrap: 'anywhere' } }, openError) : null,
        h('p', { style: S.dim }, tr(napcat ? 'napcatPrivate' : 'desktopPrivate')),
        window.location.protocol === 'http:' ? h('p', { role: 'note', style: { ...S.dim, color: T.warn } }, tr(napcat ? 'napcatHttpWarning' : 'desktopHttpWarning')) : null,
        h('p', { style: S.dim }, tr('loginSeparate')));
    }

    // Native setup only probes and saves local connection settings; it never deploys upstream.
    function SetupPanel({ onOps, onSaved, active }) {
      const { live } = useLifetime();
      const [info, setInfo] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      const [loadError, setLoadError] = React.useState(false);
      const [form, setForm] = React.useState({ httpUrl: '', wsUrl: '', tokenMode: 'reuse', token: '', configureLlm: false, baseUrl: '', model: '', apiKey: '' });
      const [busy, setBusy] = React.useState('');
      const [message, setMessage] = React.useState('');
      const [probe, setProbe] = React.useState(null);
      const [saved, setSaved] = React.useState(null);
      const lock = React.useRef(false);
      const seeded = React.useRef(false);
      const readId = React.useRef(0);
      const revision = React.useRef(0);
      const read = React.useCallback(async () => {
        const id = ++readId.current;
        setLoading(true); setLoadError(false);
        const result = await get('/setup');
        if (!live.current || id !== readId.current) return;
        setLoading(false);
        if (!result.ok) { setLoadError(true); return; }
        setInfo(result);
        if (!seeded.current) {
          seeded.current = true;
          const current = result.current || {};
          // Never copy any secret value from a response into the form.
          setForm((old) => ({ ...old, httpUrl: current.httpUrl || 'http://127.0.0.1:3000', wsUrl: current.wsUrl || '',
            baseUrl: current.baseUrl || '', model: current.model || '', token: '', apiKey: '' }));
        }
      }, []);
      React.useEffect(() => { read(); return () => { readId.current += 1; }; }, [read]);
      const change = (key, value) => {
        revision.current += 1;
        setForm((old) => ({ ...old, [key]: value, ...(key === 'tokenMode' ? { token: '' } : {}) }));
        setProbe(null); setSaved(null); setMessage('');
      };
      const localUrl = (value, protocols) => {
        try {
          const url = new URL(value);
          const host = url.hostname.toLowerCase();
          if (!protocols.includes(url.protocol) || url.username || url.password || url.search || url.hash
            || !['localhost', '127.0.0.1', '[::1]'].includes(host)
            || !(url.pathname === '/' || (protocols.includes('ws:') && url.pathname === '/event'))) return null;
          return url.href.replace(/\/$/, '');
        } catch { return null; }
      };
      // Never echo submitted passwords or credential-bearing URLs in failure details.
      const safeText = (value) => {
        let text = String(value ?? '');
        for (const secret of [form.token, form.apiKey]) if (secret) text = text.split(secret).join('[redacted]');
        return text.replace(/(bearer\s+)\S+/gi, '$1[redacted]')
          .replace(/((?:token|api[_-]?key|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
          .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@').slice(0, 700);
      };
      const connectionBody = () => {
        const httpUrl = form.httpUrl.trim();
        const wsUrl = form.wsUrl.trim();
        const http = localUrl(httpUrl, ['http:', 'https:']);
        if (!http || (wsUrl && !localUrl(wsUrl, ['ws:', 'wss:']))) throw new Error(tr('setupEndpointError'));
        const current = info?.current || {};
        const sameEndpoint = http === localUrl(current.httpUrl, ['http:', 'https:'])
          && (wsUrl ? localUrl(wsUrl, ['ws:', 'wss:']) : '') === (current.wsUrl ? localUrl(current.wsUrl, ['ws:', 'wss:']) : '');
        const body = { httpUrl, ...(wsUrl ? { wsUrl } : {}) };
        if (form.tokenMode === 'replace') {
          if (!form.token) throw new Error(tr('setupNewTokenError'));
          body.token = form.token;
        } else if (form.tokenMode === 'none') body.token = '';
        else if (!sameEndpoint) throw new Error(tr('setupTokenError'));
        // The Host remains authoritative about reuse and loopback validation.
        return body;
      };
      const run = async (save) => {
        if (lock.current) return;
        if (save && !probe) return;
        if (save && configWrite.busy) { setMessage(tr('setupBusy')); return; }
        let body;
        try {
          body = connectionBody();
          if (save && form.configureLlm) {
            if (!form.baseUrl.trim() || !form.model.trim()) throw new Error(tr('setupModelError'));
            body.llm = { baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(form.apiKey ? { apiKey: form.apiKey } : {}) };
          }
        } catch (error) { setMessage(error.message); return; }
        if (save && !window.confirm(tr('setupConfirm'))) return;
        const version = revision.current;
        lock.current = true;
        if (save) configWrite.busy = true;
        setBusy(save ? 'save' : 'check'); setMessage(''); setSaved(null);
        const result = await post(save ? '/setup/connect' : '/setup/check', body);
        lock.current = false;
        if (save) configWrite.busy = false;
        if (!live.current) return;
        setBusy('');
        if (version !== revision.current) return;
        if (!result.ok) {
          setProbe(null);
          setMessage(`${tr(save ? 'setupSaveFailed' : 'setupCheckFailed')} ${safeText(result.error || tr('setupError'))}`);
          return;
        }
        if (!result.account || !result.account.user_id) {
          setProbe(null); setMessage(tr(save ? 'setupSaveFailed' : 'setupCheckFailed')); return;
        }
        if (save) {
          setSaved({ restartRequired: result.restartRequired === true, account: result.account });
          setProbe(null);
          setForm((old) => ({ ...old, token: '', apiKey: '', tokenMode: 'reuse' }));
          await read();
          if (live.current) onSaved?.();
        } else setProbe({ account: result.account });
      };
      const field = (key, label, options = {}) => h('label', { key, style: { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 } },
        h('span', null, label), h('input', { type: options.secret ? 'password' : 'text', value: form[key],
          autoComplete: options.secret ? 'new-password' : 'off', spellCheck: false, style: 输入框,
          placeholder: options.placeholder || '', onChange: (event) => change(key, event.target.value) }));
      const current = info?.current || {};
      const checks = Array.isArray(info?.checks) ? info.checks : [];
      const linkRows = [['installerGuide', 'setupInstaller'], ['installerScript', 'setupScript'], ['release', 'setupRelease'], ['manual', 'setupManualLink'], ['eula', 'setupEulaLink'], ['qq', 'setupQQLink']];
      const links = linkRows.flatMap(([key, label]) => {
        try {
          const url = new URL(key === 'installerGuide' ? info?.automaticInstall?.guide : key === 'installerScript' ? info?.automaticInstall?.script : info?.links?.[key]);
          if (url.protocol !== 'https:' || url.username || url.password) return [];
          return [h('a', { key, href: url.href, target: '_blank', rel: 'noopener noreferrer', style: { color: T.accent } }, tr(label))];
        } catch { return []; }
      });
      return h('div', { style: S.wrap },
        h('div', { style: S.head }, h('h1', { style: S.h1 }, tr('setupTitle'))),
        h('p', null, tr(info?.backend === 'napcat' ? 'napcatSetupIntro' : 'setupIntro')),
        h('p', { style: { ...S.pickBox, color: T.warn } }, tr('setupDocker')),
        h('section', { style: S.card, 'aria-label': tr('setupPrep') },
          h('div', { style: S.h2row }, h('h2', { style: S.h2inner }, tr('setupPrep')),
            h('button', { type: 'button', style: S.btn(false), disabled: loading || Boolean(busy), onClick: read }, tr('setupRefresh'))),
          loading ? h('p', { role: 'status' }, tr('setupLoading')) : null,
          loadError ? h('p', { role: 'alert', style: { color: T.error } }, tr('setupUnavailable')) : null,
          info?.host ? h('p', { style: S.dim }, `${tr('setupHost')}: ${safeText(info.host.platform)} / ${safeText(info.host.arch)} · Node ${safeText(info.host.node)}`) : null,
          checks.length ? h('ul', { style: { paddingLeft: 20 } }, ...checks.map((check, i) => h('li', { key: `${check.id || i}/${i}`, style: { marginBottom: 5, overflowWrap: 'anywhere' } },
            h('strong', null, safeText(check.label || check.id)), ' · ',
            h('span', { style: { color: check.ok === true ? T.success : check.ok === false ? T.warn : T.muted } }, tr(check.ok === true ? 'setupPass' : check.ok === false ? 'setupFail' : 'setupUnknown')),
            check.detail ? h('div', { style: S.dim }, safeText(check.detail)) : null)))
            : h('p', { style: S.dim }, tr('setupChecksEmpty')),
          info?.host?.platform === 'linux' && info?.backend !== 'napcat' ? h('div', { style: { ...S.pickBox, display: 'flex', flexWrap: 'wrap', gap: 10 } },
            // Ensure missing Linux dependency results stay visible as unknown, never green.
            ...[['qq', 'setupQQ', /(?:^|[^a-z0-9])(?:linux[-_ ]?)?qq(?:$|[^a-z0-9])/i], ['xvfb', 'setupXvfb', /xvfb/i], ['ffmpeg', 'setupFfmpeg', /ffmpeg/i]].map(([id, label, pattern]) => {
              const check = checks.find((item) => pattern.test(`${item.id || ''} ${item.label || ''}`));
              return h('span', { key: id }, `${tr(label)} · ${tr(check?.ok === true ? 'setupPass' : check?.ok === false ? 'setupFail' : 'setupUnknown')}`);
            })) : null,
          h('p', null, tr(info?.backend === 'napcat' ? 'napcatManual' : 'setupManual')),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 14 } }, ...(links.length ? links : [h('span', { key: 'none', style: S.dim }, tr('setupNoLinks'))])),
          h('p', { style: { color: T.warn } }, tr('setupEula')),
          h('div', { style: S.dim }, tr('setupAuto'), info?.automaticInstall?.reason ? ` · ${safeText(info.automaticInstall.reason)}` : ''),
          info?.native?.service ? h('p', { style: { ...S.dim, overflowWrap: 'anywhere' } }, `${tr('setupService')}: ${safeText(info.native.service)} · ${tr(info.native.scope === 'system' ? 'setupSystemScope' : 'setupUserScope')}`) : null),
        active && info?.backend !== 'napcat' ? h(DeploymentPanel, { onDeployed: () => { read(); onSaved?.(); } }) : null,
        active && info ? h(LoginPanel, { key: info.backend || 'snowluma', backend: info.backend }) : null,
        h('section', { style: S.card, 'aria-label': tr('setupConnect') },
          h('h2', { style: S.h2 }, tr('setupConnect')),
          h('p', { style: S.dim }, tr('setupLocal')),
          h('fieldset', { disabled: !info || loading || Boolean(busy), style: { border: 0, padding: 0, margin: 0, minWidth: 0 } },
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 260px), 1fr))', gap: 12 } },
              field('httpUrl', tr('setupHttp'), { placeholder: 'http://127.0.0.1:3000' }),
              field('wsUrl', tr('setupWs'), { placeholder: 'ws://127.0.0.1:3001' }),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, h('span', null, tr('setupTokenMode')),
                h('select', { value: form.tokenMode, style: 输入框, onChange: (event) => change('tokenMode', event.target.value) },
                  ...[['reuse', 'setupReuse'], ['replace', 'setupReplace'], ['none', 'setupNone']].map(([value, label]) => h('option', { key: value, value }, tr(label))))),
              form.tokenMode === 'replace' ? field('token', tr('setupToken'), { secret: true }) : null),
            h('p', { style: S.dim }, tr(current.hasToken ? 'setupTokenSet' : 'setupTokenUnset'), ' · ', tr('setupTokenHint')),
            开关(form.configureLlm, (value) => change('configureLlm', value), tr('setupLlm')),
            h('p', { style: S.dim }, tr('setupLlmHint')),
            form.configureLlm ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))', gap: 12, marginBottom: 12 } },
              field('baseUrl', tr('setupBase')), field('model', tr('setupModel')),
              field('apiKey', tr('setupKey'), { secret: true, placeholder: tr(current.hasApiKey ? 'setupKeySet' : 'setupKeyUnset') })) : null,
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
              h('button', { type: 'button', style: S.btn(false), onClick: () => run(false) }, tr(busy === 'check' ? 'setupProbing' : 'setupProbe')),
              h('button', { type: 'button', style: S.btn(true), disabled: !probe, onClick: () => run(true) }, tr(busy === 'save' ? 'setupSaving' : 'setupSave')))),
          probe ? h('p', { role: 'status', style: { color: T.success } }, `${tr('setupDetected')}: ${safeText(probe.account.nickname)} (${safeText(probe.account.user_id)}) · ${tr('setupNotSaved')}`) : null,
          saved ? h('div', { role: 'status', style: { marginTop: 12 } }, h('p', null, tr('setupSaved')),
            h('p', null, `${tr('setupDetected')}: ${safeText(saved.account.nickname)} (${safeText(saved.account.user_id)})`),
            h('p', { style: { color: T.warn } }, tr(saved.restartRequired ? 'setupRestart' : 'setupNoRestart')),
            h('button', { type: 'button', style: S.btn(false), onClick: onOps }, tr('setupOps'))) : null,
          message ? h('p', { role: 'alert', style: { color: T.error, overflowWrap: 'anywhere' } }, message) : null));
    }

    // Deployment helpers are independently testable; never retain raw task output or credentials.
    function deploymentText(value) {
      return String(value ?? '').replace(/data:[^\s]+/gi, '[private data]')
        .replace(/(bearer\s+)\S+/gi, '$1[redacted]')
        .replace(/((?:password|passwd|token|api[_-]?key|authorization|secret)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
        .replace(/([a-z]+:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, 700);
    }
    function deploymentTask(task) {
      if (!task || !['running', 'succeeded', 'failed', 'needs_action'].includes(task.state)) throw new Error(tr('deployInvalid'));
      const step = item => ({ stage: deploymentText(item?.stage), message: deploymentText(item?.message), at: deploymentText(item?.at) });
      return { id: deploymentText(task.id), state: task.state, reason: deploymentText(task.reason), ...step(task),
        elapsedMs: Number.isFinite(Number(task.elapsedMs)) ? Math.max(0, Number(task.elapsedMs)) : 0,
        startedAt: deploymentText(task.startedAt), finishedAt: deploymentText(task.finishedAt),
        steps: (Array.isArray(task.steps) ? task.steps : []).slice(-24).map(step) };
    }
    function deploymentStatus(result) {
      if (result?.ok !== true || !result.host || !result.docker || !result.defaults || !result.selected) throw new Error(deploymentText(result?.error || result?.reason) || tr('deployInvalid'));
      return { host: { platform: deploymentText(result.host.platform), arch: deploymentText(result.host.arch) },
        docker: { installed: result.docker.installed === true, ready: result.docker.ready === true,
          state: deploymentText(result.docker.state), reason: deploymentText(result.docker.reason), canInstall: result.docker.canInstall === true,
          requiresAdmin: result.docker.requiresAdmin === true, needsRestart: result.docker.needsRestart === true },
        defaults: { image: deploymentText(result.defaults.image), container: deploymentText(result.defaults.container) },
        selected: { backend: deploymentText(result.selected.backend), mode: deploymentText(result.selected.mode), container: deploymentText(result.selected.container) },
        existing: { exists: result.existing?.exists === true, running: result.existing?.running === true, container: deploymentText(result.existing?.container) },
        task: result.task == null ? null : deploymentTask(result.task),
        warnings: (Array.isArray(result.warnings) ? result.warnings : []).slice(0, 12).map(deploymentText) };
    }
    function deploymentActionHint(status) {
      const task = status?.task;
      if ([task?.reason, task?.stage, status?.docker.reason, status?.docker.state].some(value => value === 'wsl-install-approval-required')) return 'deployWslApproval';
      if (status?.host.platform === 'win32' && status.docker.installed && !status.docker.ready) return 'deployWindowsInstalled';
      return '';
    }
    function deploymentBody(status, choices) {
      if (!status || !['linux', 'win32'].includes(status.host.platform)) throw new Error(tr('deployUnsupported'));
      if (!choices.authorized || !choices.injectionRisk || (!status.docker.installed && !choices.installDocker)) throw new Error(tr('deployConsent'));
      return { confirm: true, installDocker: choices.installDocker === true, installWsl: status.host.platform === 'win32' && choices.installWsl === true,
        authorized: choices.authorized === true, injectionRisk: choices.injectionRisk === true,
        publicDesktop: choices.publicDesktop === true, allowExistingPublicPorts: choices.allowExistingPublicPorts === true,
        image: String(choices.image || status.defaults.image).trim() };
    }
    // One session per visible panel. Serial GET/POST, no operation on mount, no host cancellation.
    function createDeploymentSession({ getStatus, postTask, confirm, update, schedule = setTimeout, cancel = clearTimeout }) {
      let closed = false, locked = false, mustRefresh = false, timer = null, controller = null, status = null, operationError = '';
      const publish = value => { if (!closed) update(value); };
      const clear = () => { if (timer != null) cancel(timer); timer = null; };
      const poll = () => {
        clear();
        if (!closed && status?.task?.state === 'running') timer = schedule(() => { timer = null; refresh(); }, 2000);
      };
      const refresh = async () => {
        if (closed || locked) return false;
        clear(); locked = true; controller = new AbortController(); publish({ checking: true });
        try {
          const next = deploymentStatus(await getStatus(controller.signal));
          if (closed) return false;
          status = next; mustRefresh = false; publish({ status, error: operationError }); return true;
        } catch (error) { publish({ error: deploymentText(error.message) || tr('deployFailed') }); return false; }
        finally { locked = false; controller = null; publish({ checking: false }); poll(); }
      };
      const run = async (choices, resume = false) => {
        if (closed || locked) return false;
        if (mustRefresh) { publish({ error: operationError || tr('deployFailed') }); return false; }
        if (resume ? status?.task?.state !== 'needs_action' : status?.task?.state === 'running' || status?.task?.state === 'needs_action') return false;
        let body;
        try { body = resume ? { confirm: true } : deploymentBody(status, choices); }
        catch (error) { publish({ error: deploymentText(error.message) }); return false; }
        // Synchronous browser confirmation: tools cannot grant this authority.
        if (!confirm(tr(resume ? 'deployResumeConfirm' : 'deployConfirm'))) return false;
        clear(); locked = true; mustRefresh = true; operationError = ''; controller = new AbortController(); publish({ busy: true, error: '' });
        try {
          const result = await postTask(resume ? '/deploy/resume' : '/deploy/start', body, controller.signal);
          if (closed) return false;
          if (result?.ok !== true) throw new Error(result?.error || result?.reason || tr('deployFailed'));
          status = { ...status, task: deploymentTask(result.task) }; publish({ status, error: '' }); return true;
        } catch (error) { operationError = deploymentText(error.message) || tr('deployFailed'); publish({ error: operationError }); return false; }
        finally {
          locked = false; controller = null; publish({ busy: false });
          // Reconcile after every submitted write, including ambiguous timeout/errors.
          if (!closed) timer = schedule(() => { timer = null; refresh(); }, 0);
        }
      };
      return { refresh, run, close() { closed = true; clear(); controller?.abort(); controller = null; } };
    }
    function DeploymentPanel({ onDeployed }) {
      const [view, setView] = React.useState({ status: null, busy: false, checking: true, error: '' });
      const [choices, setChoices] = React.useState({ image: '', installDocker: false, installWsl: false, authorized: false, injectionRisk: false, publicDesktop: false, allowExistingPublicPorts: false });
      const session = React.useRef(null);
      const completed = React.useRef('');
      React.useEffect(() => {
        const current = createDeploymentSession({
          getStatus: signal => get('/deploy/status', { signal }),
          postTask: (path, body, signal) => post(path, body, { signal }),
          confirm: text => window.confirm(text),
          update: patch => setView(old => ({ ...old, ...patch })),
        });
        session.current = current;
        const first = setTimeout(() => current.refresh(), 0);
        return () => { clearTimeout(first); current.close(); if (session.current === current) session.current = null; };
      }, []);
      const status = view.status, task = status?.task;
      const actionHint = deploymentActionHint(status);
      React.useEffect(() => {
        if (task?.state === 'succeeded' && task.id !== completed.current) { completed.current = task.id; onDeployed?.(); }
      }, [task?.id, task?.state]);
      const change = (key, value) => setChoices(old => ({ ...old, [key]: value }));
      const blocked = view.busy || view.checking || task?.state === 'running' || task?.state === 'needs_action';
      const supported = ['linux', 'win32'].includes(status?.host.platform);
      const canStart = status && supported && choices.authorized && choices.injectionRisk && (status.docker.installed || (status.docker.canInstall && choices.installDocker));
      const check = (key, label) => h('label', { style: { display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 9 } },
        h('input', { type: 'checkbox', checked: choices[key], onChange: event => change(key, event.target.checked), style: { marginTop: 5, flexShrink: 0 } }), h('span', null, tr(label)));
      const taskLabel = { running: 'deployRunning', succeeded: 'deploySucceeded', failed: 'deployTaskFailed', needs_action: 'deployNeedsAction' };
      return h('section', { style: S.card, 'aria-label': tr('deployTitle'), 'aria-busy': view.busy || view.checking },
        h('div', { style: { ...S.h2row, flexWrap: 'wrap' } }, h('h2', { style: S.h2inner }, tr('deployTitle')),
          h('button', { type: 'button', style: S.btn(false), disabled: view.busy || view.checking, onClick: () => session.current?.refresh() }, tr('deployRefresh'))),
        h('p', { style: S.dim }, tr('deployIntro')),
        !status && view.checking ? h('p', { role: 'status' }, tr('deployLoading')) : null,
        status ? h('div', null,
          h('p', { style: S.dim }, `${tr('setupHost')}: ${status.host.platform} / ${status.host.arch} · ${tr('deployDocker')}: ${tr(status.docker.installed ? 'deployInstalled' : 'deployMissing')} · ${tr(status.docker.ready ? 'deployReady' : 'deployNotReady')}`),
          h('p', { style: { ...S.dim, overflowWrap: 'anywhere' } }, `${tr('deployContainer')}: ${status.existing.container || status.selected.container || status.defaults.container} · ${status.selected.backend} / ${status.selected.mode}`),
          h('p', { style: S.dim }, tr('setupDocker')),
          status.existing.exists ? h('p', { style: { color: T.success } }, tr(status.existing.running ? 'deployExistingRunning' : 'deployExistingStopped')) : null,
          status.docker.reason ? h('p', { style: { color: T.warn, overflowWrap: 'anywhere' } }, status.docker.reason) : null,
          !supported ? h('p', { style: { color: T.warn } }, tr('deployUnsupported')) : null,
          !status.docker.installed && !status.docker.canInstall ? h('p', { style: { color: T.warn } }, tr('deployCannotInstall')) : null,
          status.docker.needsRestart ? h('p', { style: { color: T.warn } }, tr('deployRestart')) : null,
          ...status.warnings.map((warning, i) => h('p', { key: i, style: { color: T.warn, overflowWrap: 'anywhere' } }, warning))) : null,
        h('fieldset', { disabled: blocked || !status, style: { border: 0, padding: 0, margin: '12px 0', minWidth: 0 } },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 } }, tr('deployImage'),
            h('input', { type: 'text', style: { ...输入框, width: '100%' }, value: choices.image || status?.defaults.image || '', autoComplete: 'off', spellCheck: false, onChange: event => change('image', event.target.value) })),
          !status?.docker.installed ? check('installDocker', 'deployInstall') : null,
          status?.host.platform === 'win32' ? check('installWsl', 'deployWsl') : null,
          check('authorized', 'deployAuthorized'), check('injectionRisk', 'deployRisk'),
          check('publicDesktop', 'deployPublic'), check('allowExistingPublicPorts', 'deployExistingPublic')),
        h('button', { type: 'button', style: S.btn(true), disabled: blocked || !canStart, onClick: () => session.current?.run(choices) }, tr(view.busy ? 'deployWorking' : 'deployButton')),
        task ? h('div', { role: 'status', 'aria-live': 'polite', style: { marginTop: 12, overflowWrap: 'anywhere' } },
          h('strong', { style: { color: task.state === 'succeeded' ? T.success : task.state === 'failed' ? T.error : T.warn } }, tr(taskLabel[task.state])),
          h('p', null, `${tr('deployStage')}: ${task.stage} · ${tr('deployElapsed')}: ${Math.floor(task.elapsedMs / 1000)} ${tr('deploySeconds')}`),
          h('p', null, task.message),
          task.steps.length ? h('details', null, h('summary', null, tr('deploySteps')), h('ol', { style: { paddingLeft: 22 } },
            ...task.steps.map((step, i) => h('li', { key: i }, `${step.stage}: ${step.message}`)))) : null,
          task.state === 'needs_action' ? h('button', { type: 'button', style: S.btn(false), disabled: view.busy || view.checking, onClick: () => session.current?.run(choices, true) }, tr('deployResume')) : null) : null,
        actionHint ? h('p', { role: 'note', style: { color: T.warn } }, tr(actionHint)) : null,
        status?.host.platform === 'win32' ? h('p', { style: { ...S.dim, color: T.warn } }, tr('deployWindows')) : null,
        h('p', { style: S.dim }, tr('deployAdmin')),
        view.error ? h('p', { role: 'alert', style: { color: T.error, overflowWrap: 'anywhere' } }, view.error) : null);
    }

    // 运维：机器人进程 + 实时动态
    function OpsPanel() {
      const { live, later } = useLifetime();
      const restartBusy = React.useRef(false);
      const readId = React.useRef(0);
      const [restarting, setRestarting] = React.useState(false);
      const [snow, setSnow] = React.useState(null);
      const [snowMessage, setSnowMessage] = React.useState('');
      const [snowBusy, setSnowBusy] = React.useState(false);
      const snowLock = React.useRef(false);
      const [info, 设Info] = React.useState(null);
      const [线, 设线] = React.useState([]);
      const [连, 设连] = React.useState(false);
      const [说, 设说] = React.useState('');

      const 拉 = React.useCallback(async () => {
        const id = ++readId.current;
        const [r, status] = await Promise.all([get('/bot'), get('/snowluma')]);
        if (!live.current || id !== readId.current) return;
        if (r.ok) 设Info(r); else 设说(`状态读取失败：${r.error}`);
        setSnow(status);
      }, []);
      React.useEffect(() => {
        拉();
        const t = setInterval(拉, 10000);
        const es = new EventSource(B + '/events', { withCredentials: true });
        es.onopen = () => { if (live.current) 设连(true); };
        es.onerror = () => { if (live.current) 设连(false); };
        es.onmessage = (e) => {
          if (!live.current) return;
          try {
            const obj = JSON.parse(e.data);
            设线((old) => [`${new Date().toLocaleTimeString()} ${JSON.stringify(obj).slice(0, 300)}`, ...old].slice(0, 80));
          } catch {
            /* 忽略非 JSON */
          }
        };
        return () => {
          clearInterval(t);
          es.close();
          readId.current += 1;
        };
      }, [拉]);

      const 重启 = async () => {
        if (restartBusy.current || !window.confirm('重启 QQ 机器人会暂时中断收发消息，确定继续？')) return;
        restartBusy.current = true; setRestarting(true);
        设说('重启中…');
        const r = await post('/bot/restart', {});
        restartBusy.current = false;
        if (!live.current) return;
        setRestarting(false);
        设说(r && r.ok ? '已请求重启' : `重启失败：${(r && r.error) || '未知错误'}`);
        later(拉, 1500);
      };

      const snowMode = snow?.status?.mode || snow?.mode;
      const gatewayName = snow?.status?.backend === 'napcat' ? 'NapCat' : 'SnowLuma';
      const snowTarget = snowMode === 'native' ? '原生 systemd 服务' : snowMode === 'external' ? '外部网关（仅连接）' : snowMode === 'docker' ? 'Docker 容器' : '网关（管理模式未知）';
      const snowManageable = snow?.ok && (snowMode === 'native' || snowMode === 'docker');
      const snowAction = async (op) => {
        if (snowLock.current || !snowManageable) return;
        if (op !== 'start' && !window.confirm(`${op === 'stop' ? '停止' : '重启'} ${gatewayName} ${snowTarget}会断开 QQ 连接，确定继续？`)) return;
        snowLock.current = true; setSnowBusy(true); setSnowMessage('执行中…');
        const r = await post('/snowluma/action', { op, confirm: true });
        snowLock.current = false;
        if (!live.current) return;
        setSnowBusy(false);
        setSnowMessage(r.ok ? `${op}：已完成，请核对下方${snowTarget}状态` : `操作失败：${r.error || '未知错误'}`);
        await 拉();
      };
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h('section', { style: S.card }, h('h2', { style: S.h2 }, `${gatewayName} · QQ 网关`),
          snow?.ok ? h('div', { style: S.dim }, `${snowTarget} · ${snow.status?.service || snow.status?.name || snow.name || gatewayName} · ${snow.status?.status || snow.status?.running && '运行中' || '未运行'}${snow.status?.scope ? ` · ${snow.status.scope === 'user' ? '用户级' : '系统级'}` : ''}${snow.status?.image ? ` · ${snow.status.image}` : ''}`)
            : h('div', { role: 'status', style: S.dim }, snow ? `状态不可用：${snow.error || '无法检查网关'}` : '读取网关状态中…'),
          snowMode === 'external' ? h('p', { style: S.dim }, '仅检测外部网关连接；此页不启动、停止或重启外部网关。') : null,
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 } },
            ...[['start', '启动'], ['stop', '停止'], ['restart', '重启']].map(([op, label]) => h('button', { type: 'button', key: op, style: S.btn(false), disabled: snowBusy || !snowManageable, onClick: () => snowAction(op) }, label)),
            h('button', { type: 'button', style: S.btn(false), onClick: 拉 }, '刷新状态')),
          snowMessage ? h('div', { role: 'status', style: { ...S.dim, marginTop: 6 } }, snowMessage) : null),
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '机器人进程'),
          info
            ? h(
                'div',
                { style: { ...S.dim, lineHeight: 1.9 } },
                h('div', null, `模式：${info.managed ? '插件托管（随 DSH 启停）' : '接外部进程（自己用 systemd/命令行管）'}`),
                h('div', null, `PID：${info.pid || '—'}　已跑：${info.startedAt ? Math.round((Date.now() - info.startedAt) / 60000) + ' 分钟' : '—'}　自动重启：${info.restarts || 0} 次`),
                h('div', null, `代码：${info.botDir || '?'}`),
                h('div', null, `数据：${info.dataDir || '?'}`),
                h('div', null, `控制台：${info.controlBase || '?'}`),
                info.lastExit ? h('div', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, `上次退出：code=${info.lastExit.code} signal=${info.lastExit.signal || '-'}`) : null,
              )
            : h('div', { style: S.dim }, '读取中…'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, marginTop: 8 } },
            h('button', { style: S.btn(true), onClick: 重启, disabled: restarting || !(info && info.managed) }, '重启机器人'),
          ),
          说 ? h('div', { style: { ...S.dim, marginTop: 6 } }, 说) : null,
        ),
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, `实时动态 ${连 ? '· 已连' : '· 未连'}`),
          h('div', { style: { ...S.dim, marginBottom: 6 } }, '控制台事件流（收到消息、回复、主动行为都会走这里）'),
          h(
            'pre',
            { style: { maxHeight: 320, overflow: 'auto', fontSize: 11.5, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
            线.length ? 线.join('\n') : '还没收到事件（在群里说句话试试）',
          ),
        ),
        info && info.logs && info.logs.length
          ? h(
              'div',
              { style: S.card },
              h('h2', { style: S.h2 }, '机器人日志'),
              h('pre', { style: { maxHeight: 300, overflow: 'auto', fontSize: 11.5, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-wrap' } }, info.logs.join('\n')),
            )
          : null,
      );
    }

    function Section() {
      // Pure header selectors: unknown data must never look like confirmed QQ online.
      function overviewHealth(view, error = '') {
        const transport = view.status?.transport;
        const http = transport?.http || 'unknown';
        const ws = transport?.ws || 'unknown';
        const result = (state, label) => ({ state, label, http, ws });
        if (error) return result('unknown', '刷新失败 · 状态未确认');
        if (view.control?.reachable === false || view.status?.ok === false) return result('offline', '控制接口离线');
        if (view.control?.reachable !== true || !transport) return result('unknown', 'QQ 状态未知');
        if (http === 'ok' && ws === 'open') return result('online', 'QQ 在线');
        const knownHttp = http !== 'unknown';
        const knownWs = ws !== 'unknown';
        if (!knownHttp || !knownWs) return result('unknown', 'QQ 状态未确认');
        if (http !== 'ok' && ws !== 'open' && !['connecting', 'reconnecting'].includes(ws)) return result('offline', 'QQ 连接离线');
        return result('degraded', 'QQ 连接异常');
      }
      function overviewReasoning(llm) {
        if (!llm) return '未知';
        const value = llm.reasoningEfforts?.chat || llm.reasoningEffort || '';
        return ({ none: '关闭 · none', minimal: '极低 · minimal', low: '低 · low', medium: '中 · medium', high: '高 · high', xhigh: '极高 · xhigh' })[value] || (value ? `未知档位 · ${value}` : '接口默认');
      }
      function overviewSource(view, name) {
        const source = view.freshness?.[name];
        const time = (at) => at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '无';
        if (!source) return { ok: false, suffix: ' · 未验证', detail: '未提供实时刷新状态' };
        return { ok: source.ok === true, suffix: source.ok ? '' : source.updatedAt ? ' · 旧值' : ' · 未知',
          detail: `上次成功 ${time(source.updatedAt)} · 最近检查 ${time(source.checkedAt)}${source.ok ? '' : ` · 刷新失败：${source.error || '未知原因'}`}` };
      }
      const { live, later } = useLifetime();
      const scopeRef = React.useRef('');
      const overviewId = React.useRef(0);
      const actionBusy = React.useRef(false);
      const editableBaseline = React.useRef(null);
      const [态, 设态] = React.useState(null);
      const [错, 设错] = React.useState('');
      const [说, 设说] = React.useState('');
      const [忙, 设忙] = React.useState(false);
      const [scope, setScope] = React.useState('');
      scopeRef.current = scope;
      const 设Scope = (value) => { scopeRef.current = value; overviewId.current += 1; setScope(value); 设态((old) => old ? { ...old, messages: [] } : old); };
      const [草稿, 设草稿] = React.useState(null);
      const [脏, 设脏] = React.useState(false);
      const 脏Ref = React.useRef(false);
      const 草稿版本Ref = React.useRef(0);
      const 保存中Ref = React.useRef(false);
      const 置脏 = (v) => { 脏Ref.current = v; 设脏(v); };
      const [存话, 设存话] = React.useState('');
      const [保存忙, 设保存忙] = React.useState(false);
      const [学说, 设学说] = React.useState('');
      const [社交说, 设社交说] = React.useState('');
      const [模型, 设模型] = React.useState([]);
      // 「学一遍」的现场状态：谁正在学（uin → 开始时间）、谁学完了（uin → 结果）
      const [学中, 设学中] = React.useState({});
      const [学果, 设学果] = React.useState({});
      const 学中Ref = React.useRef({});
      const [, 设滴答] = React.useState(0);
      const [页, 设页] = React.useState('setup');
      const [刷新中, 设刷新中] = React.useState(false);
      const 跳转目标 = React.useRef({});
      const tabId = React.useId();
      const 跳转 = (page, section) => {
        设页(page);
        later(() => {
          const target = 跳转目标.current[section];
          target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
          target?.focus?.({ preventScroll: true });
        }, 0);
      };
      const 锚点 = (name) => ({ ref: (node) => { 跳转目标.current[name] = node; }, tabIndex: -1, style: { scrollMarginTop: 12 } });

      const 拉 = React.useCallback(async (selected = scopeRef.current, force = false) => {
        // Delayed actions always refresh the currently selected scope, never their old closure.
        if (selected !== scopeRef.current) return;
        const id = ++overviewId.current;
        设刷新中(true);
        try {
          const r = await get('/overview' + (selected ? `?scope=${encodeURIComponent(selected)}&limit=40` : '?limit=40') + (force ? '&refresh=1' : ''));
          if (!live.current || id !== overviewId.current || selected !== scopeRef.current) return;
          if (r.ok) {
            设态(r); 设错('');
            if (r.editable && !脏Ref.current && !保存中Ref.current) {
              editableBaseline.current = JSON.parse(JSON.stringify(r.editable));
              设草稿(JSON.parse(JSON.stringify(r.editable)));
            }
          } else 设错(r.error || '读不到数据');
        } catch (error) {
          if (live.current && id === overviewId.current && selected === scopeRef.current) 设错(String(error?.message || error));
        } finally {
          if (live.current && id === overviewId.current && selected === scopeRef.current) 设刷新中(false);
        }
      }, []);
      React.useEffect(() => { 拉(scope); }, [拉, scope]);
      React.useEffect(() => {
        let active = true;
        get('/models').then((r) => { if (active && r.ok) 设模型(Array.isArray(r.models) ? r.models : []); });
        return () => { active = false; };
      }, []);
      React.useEffect(() => {
        let active = true; let timer;
        const poll = async () => { await 拉(); if (active) timer = setTimeout(poll, 15000); };
        timer = setTimeout(poll, 15000);
        return () => { active = false; clearTimeout(timer); overviewId.current += 1; };
      }, [拉]);
      // 有人正在学时，每秒推一次秒数，让「学习中 3s」自己往上走
      const 在学数 = Object.keys(学中).length;
      React.useEffect(() => {
        if (!在学数) return undefined;
        const t = setInterval(() => 设滴答((n) => n + 1), 1000);
        return () => clearInterval(t);
      }, [在学数]);

      const 改 = (pathName, value) => {
        草稿版本Ref.current += 1;
        设草稿((prev) => {
          const next = JSON.parse(JSON.stringify(prev || {}));
          const keys = pathName.split('.');
          let o = next;
          for (let i = 0; i < keys.length - 1; i += 1) {
            o[keys[i]] = o[keys[i]] || {};
            o = o[keys[i]];
          }
          o[keys[keys.length - 1]] = value;
          return next;
        });
        置脏(true);
      };

      const 存 = async () => {
        if (保存中Ref.current || configWrite.busy) { 设存话('另一个设置保存仍在进行，请稍后再试'); return; }
        configWrite.busy = true;
        保存中Ref.current = true;
        const version = 草稿版本Ref.current;
        设保存忙(true);
        设存话('保存中…');
        const updates = {};
        const atomic = new Set((态?.configSchema || []).flatMap((group) => (group.fields || [])
          .filter((field) => field.type === 'json').map((field) => field.path)));
        const diff = (base, next, prefix = '') => {
          for (const [key, value] of Object.entries(next || {})) {
            const path = prefix ? `${prefix}.${key}` : key;
            if (!atomic.has(path) && value && typeof value === 'object' && !Array.isArray(value)) diff(base?.[key], value, path);
            else if (JSON.stringify(value) !== JSON.stringify(base?.[key])) updates[path] = value;
          }
        };
        diff(editableBaseline.current, 草稿);
        const submitted = JSON.parse(JSON.stringify(草稿));
        const r = await post('/config', { updates });
        configWrite.busy = false;
        保存中Ref.current = false;
        if (!live.current) return;
        设保存忙(false);
        if (r && r.ok) {
          const unchanged = version === 草稿版本Ref.current;
          设存话(unchanged ? '已保存，机器人正在重启（约 3 秒后新设置生效）'
            : '已保存提交时的设置，机器人正在重启；保存期间的新修改仍保留，请再次保存。');
          editableBaseline.current = submitted;
          if (unchanged) 置脏(false);
          later(() => 拉(), 6000);
        } else {
          设存话('保存失败：' + ((r && r.error) || (r && r.result && r.result.error) || '未知错误'));
        }
      };


      const 学人原因 = (reason) => {
        const 词 = String(reason || '');
        const 表 = {
          'not-enough': '攒的话还不够（这人的待学素材不到 3 条）',
          busy: '这条正在学，等这次完了再点',
          'no-brain': '机器人这边没配上模型，学不了',
          'parse-empty': '模型没给出能用的档案，再点一次试试',
        };
        return 表[词] || (词 ? `接口返回：${词}` : '未知原因');
      };

      const 学人 = async (uin, name) => {
        const key = String(uin);
        if (学中Ref.current[key]) return;
        学中Ref.current[key] = Date.now();
        设学中((m) => ({ ...m, [key]: Date.now() }));
        设学果((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
        设学说(`正在让模型读 ${name} 说过的话…（大约 10 秒）`);
        let r = null;
        try {
          r = await post('/learn', { uin: key });
        } catch (err) {
          r = { ok: false, error: String((err && err.message) || err) };
        }
        if (!live.current) return;
        const 成 = !!(r && r.ok && !(r.result && r.result.ok === false));
        const 用时 = Math.max(1, Math.round((Date.now() - 学中Ref.current[key]) / 1000));
        const 原因 = r ? (r.error || (r.result && r.result.reason) || '') : '请求没发出去（网络断了或被拦了）';
        const 文案 = 成
          ? `✔ ${name} 已更新（用时 ${用时}s）`
          : `✘ ${name} 没学成：${r ? 学人原因(原因) : 原因}`;
        设学果((m) => ({ ...m, [key]: { ok: 成, text: 文案 } }));
        设学说(文案);
        delete 学中Ref.current[key];
        设学中((m) => {
          const next = { ...m };
          delete next[key];
          return next;
        });
        if (成) later(() => 拉(), 400);
      };

      const 点 = async (kind, label) => {
        if (actionBusy.current) return;
        actionBusy.current = true;
        设忙(true);
        设说(`${label}…`);
        const r = await post('/act', { kind });
        actionBusy.current = false;
        if (!live.current) return;
        设说(r && r.ok ? `${label}：已交给机器人` : `${label}失败：${(r && r.error) || '未知错误'}`);
        设忙(false);
        later(() => 拉(), 1200);
      };

      const 额度Ref = React.useRef({});
      const 存社交额度 = async () => {
        if (actionBusy.current) return;
        actionBusy.current = true;
        设忙(true);
        设社交说('保存额度…');
        const 评论 = Number(额度Ref.current.commentPerDay);
        const 点赞 = Number(额度Ref.current.likePerDay);
        const r = await post('/act', { kind: 'social-quota', commentPerDay: 评论, likePerDay: 点赞 });
        actionBusy.current = false;
        if (!live.current) return;
        if (!r || r.ok === false) {
          设社交说(`额度没存上：${(r && r.error) || '未知错误'}`);
          设忙(false);
          return;
        }
        const q = (r.result && r.result.quota) || {};
        设社交说(`额度已生效：评论 ${q.commentPerDay ?? 评论}/天 · 点赞 ${q.likePerDay ?? 点赞}/天`);
        设忙(false);
        later(() => 拉(), 1200);
      };

      const 回滚人格 = async (id) => {
        if (actionBusy.current) return;
        actionBusy.current = true;
        设忙(true);
        const r = await post('/act', { kind: 'persona-undo', id });
        actionBusy.current = false;
        if (!live.current) return;
        设忙(false);
        if (!r || r.ok === false) {
          设存话(`撤销失败：${(r && r.error) || '它后来又改过这段，先手动核对'}`);
          later(() => 拉(), 800);
          return;
        }
        设存话('已撤销那条人格微调');
        later(() => 拉(), 700);
      };

      const 社交做 = async (kind) => {
        if (actionBusy.current) return;
        actionBusy.current = true;
        设忙(true);
        设社交说('请求中…');
        const r = await post('/act', { kind });
        actionBusy.current = false;
        if (!live.current) return;
        if (!r || r.ok === false) {
          设社交说(`失败：${(r && r.error) || '未知错误'}`);
          设忙(false);
          return;
        }
        const out = r.result || {};
        if (kind === 'social-login' && out.url) 设社交说(`用 B站 App 扫码，或手机打开：${out.url}`);
        else if (kind === 'social-check') 设社交说(`查过 ${out.checked || 0} 条自己发过的评论，新增 ${out.added || 0} 条回复`);
        else if (out.skipped) 设社交说(`这轮跳过：${out.skipped}`);
        else if (out.action) 设社交说(`这轮：${out.action}${out.text ? `「${out.text}」` : ''}`);
        else 设社交说('已交给机器人');
        设忙(false);
        later(() => 拉(), 1600);
      };

      // Setup must remain reachable on first run even if /overview is unavailable.
      const overviewReady = Boolean(态);
      const view = 态 || {};
      const st = view.status || {};
      const agent = view.agent || {};
      // 群和私聊各有一本账：卡片上分别显示自己的区间，没设就用兜底值
      const 群下限 = agent.group?.minPerDay;
      const 群上限 = agent.group?.maxPerDay;
      const 私下限 = agent.private?.minPerDay;
      const 私上限 = agent.private?.maxPerDay;
      const c = view.counts || { today: {}, last24: {} };
      const today = c.today || {};
      const last24 = c.last24 || {};
      const groups = Array.isArray(view.groups) ? view.groups : [];
      const recent = Array.isArray(view.recent) ? view.recent : [];
      const memory = Array.isArray(view.memory) ? view.memory : [];
      const people = Array.isArray(view.people) ? view.people : [];
      const 决策 = view.decisions || { recent: [], today: null };
      const 原因 = (决策.today && 决策.today.reasons) || [];
      const archive = Array.isArray(view.archive) ? view.archive : [];
      const scopes = Array.isArray(view.scopes) ? view.scopes : [];
      const messages = Array.isArray(view.messages) ? view.messages : [];
      const health = overviewHealth(view, 错);
      const online = health.state === 'online';
      const identityLive = overviewSource(view, 'identity');
      const groupLive = overviewSource(view, 'groups');
      const statusLive = overviewSource(view, 'status');
      const configLive = overviewSource(view, 'config');
      const sourceNames = { status: '运行状态', identity: 'QQ昵称', groups: '群列表', friends: '好友列表', scopes: '会话列表', config: '设置', people: '人物档案', decisions: '决策记录', dailyNews: '资讯订阅' };
      const failedSources = Object.entries(view.freshness || {}).filter(([, value]) => value?.ok === false);
      const 标头入口 = (label, page, section, title) => h('button', {
        type: 'button', className: 'qq-header-link', style: { ...S.pill(), cursor: 'pointer', font: 'inherit', fontSize: 11.5 },
        title, 'aria-label': title, onClick: () => 跳转(page, section),
      }, label, ' ↗');

      const 主页 = !overviewReady ? h('div', { style: S.wrap },
        h('div', { role: 错 ? 'alert' : 'status', style: S.dim }, 错 || '读取中…'),
        h('button', { type: 'button', style: S.btn(false), onClick: () => 拉() }, tr('setupRefresh'))) : h(
        'div',
        { style: S.wrap },
        // 头部
        h('div', { hidden: 页 !== 'main' },
        h(
          'div',
          { style: S.head },
          h('h1', { style: S.h1 }, 'QQ 机器人'),
          h('span', { role: 'status', style: { ...S.pill(online ? 'ok' : health.state === 'offline' ? 'bad' : ''), ...(health.state === 'degraded' ? { color: T.warn } : {}) } }, health.label),
          h('span', { style: S.pill(), title: `QQ 账号昵称（不是人设）；${identityLive.detail}` }, (st.selfId ? `QQ昵称 ${st.nickname || '未知'} · ${st.selfId}` : 'QQ账号未知') + identityLive.suffix),
          h('span', { style: S.pill(), title: statusLive.detail }, `运行 ${st.uptimeMs == null ? '未知' : `${Math.round(st.uptimeMs / 60000)} 分钟`}${statusLive.suffix}`),
          标头入口(`聊天模型 ${st.model || '未知'}${statusLive.suffix}`, 'settings', 'model', `打开模型设置（不修改当前模型）；${statusLive.detail}`),
          标头入口(`聊天推理 ${overviewReasoning(view.editable?.llm)}${configLive.suffix}`, 'settings', 'model', `打开已保存的推理档位设置；${configLive.detail}`),
          标头入口(`群 ${Array.isArray(view.groups) ? groups.length : '未知'}${groupLive.suffix}`, 'main', 'groups', `查看已加入的群；${groupLive.detail}`),
          标头入口(`主动目标 ${Array.isArray(view.editable?.agent?.targets) ? `${view.editable.agent.targets.length} 处` : '未知'}${configLive.suffix}`, 'settings', 'targets', '设置主动活动范围（不是正在执行的任务数）'),
          标头入口(`人设 ${st.persona || '未知'}${statusLive.suffix}`, 'settings', 'persona', '打开人设设置（与 QQ 昵称分别配置）'),
          h(
            'span',
            { style: { marginLeft: 'auto', display: 'flex', gap: 8 } },
            h('button', { type: 'button', style: S.btn(false), disabled: 刷新中, onClick: () => 拉(scope, true) }, 刷新中 ? '刷新中…' : '刷新'),
          ),
          h('div', { style: { ...S.dim, flexBasis: '100%', display: 'flex', gap: 10, flexWrap: 'wrap' }, 'aria-live': 'polite' },
            h('span', null, `HTTP ${health.http} · WS ${health.ws}${错 ? '（上次记录，未确认）' : ''}`),
            h('span', null, `上次读取 ${view.now ? new Date(view.now).toLocaleTimeString('zh-CN', { hour12: false }) : '未知'} · 每15秒刷新${刷新中 ? ' · 正在刷新…' : ''}${错 ? ' · 读取失败，以下为上次数据' : ''}`)),
        ),
        错 ? h('div', { style: { ...S.dim, color: 'var(--dsw-alias-state-error-primary)', marginBottom: 10 } }, 错) : null,
        h('details', { style: { ...S.dim, marginBottom: 10 }, open: failedSources.length ? true : undefined },
          h('summary', null, failedSources.length ? `部分数据刷新失败（${failedSources.map(([name]) => sourceNames[name] || name).join('、')}），保留上次成功值；没有旧值则显示未知` : '数据来源与刷新时间（实时状态 / QQ 名册 / 已保存设置分别读取）'),
          ...Object.entries(sourceNames).map(([name, label]) => h('div', { key: name }, `${label}：${overviewSource(view, name).detail}`))),

        // 今日战绩
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '今天做了什么'),
          (() => {
            const 已做 = (today.speak || 0) + (today.share || 0) + (today.qzone || 0);
            const 群下 = Number(群下限 ?? agent.minPerDay ?? 0) + Number(私下限 ?? agent.minPerDay ?? 0);
            if (!群下) return null;
            const 差 = Math.max(0, 群下 - 已做);
            return h(
              'div',
              { style: { ...S.dim, marginBottom: 8, color: 差 > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)' } },
              差 > 0
                ? `今天已主动 ${已做} 次，两本账合起来的下限是 ${群下} 次，还差 ${差} 次（不够会被催着说）`
                : `今天已主动 ${已做} 次，已过两本账合起来的下限（${群下} 次）`,
            );
          })(),
          h(
            'div',
            { style: S.grid },
            h('div', { style: S.stat('var(--dsw-alias-state-business-primary)') }, h('div', { style: S.num('var(--dsw-alias-state-business-primary)') }, String(today.speak || 0)), h('div', { style: S.dim }, `说话 · 近24h ${last24.speak || 0}`)),
            h('div', { style: S.stat('var(--dsw-alias-state-success-primary)') }, h('div', { style: S.num('var(--dsw-alias-state-success-primary)') }, String(today.share || 0)), h('div', { style: S.dim }, `分享 · 近24h ${last24.share || 0}`)),
            h('div', { style: S.stat('var(--dsw-alias-state-business-primary)') }, h('div', { style: S.num('var(--dsw-alias-state-business-primary)') }, String(today.qzone || 0)), h('div', { style: S.dim }, `说说 · 近24h ${last24.qzone || 0}`)),
            h('div', { style: S.stat('var(--dsw-alias-bg-module-platform)') },
              h('div', { style: S.num('var(--dsw-alias-state-business-primary)') }, `${群下限 ?? agent.minPerDay ?? 0}~${群上限 ?? agent.maxPerDay ?? 0}`),
              h('div', { style: S.dim }, '群 · 每天')),
            h('div', { style: S.stat('var(--dsw-alias-bg-module-platform)') },
              h('div', { style: S.num('var(--dsw-alias-state-business-primary)') }, `${私下限 ?? agent.minPerDay ?? 0}~${私上限 ?? agent.maxPerDay ?? 0}`),
              h('div', { style: S.dim }, '私聊 · 每天')),
          ),
          h(
            'div',
            { style: { ...S.dim, marginTop: 10 } },
            `每 ${agent.everyMinutes ?? '?'} 分钟醒一次（抖动 ±${agent.jitterMinutes ?? 0}）· 最短间隔 ${Math.round((agent.minGapMs || 0) / 60000)} 分钟 · ` +
              `安静时段 ${(agent.quietHours || []).join('、') || '全天可动手'} · 分享每 ${agent.shareEveryHours ?? '?'} 小时一次 · 说说每 ${agent.qzoneEveryHours ?? '?'} 小时一次`,
          ),
        ),

        view.social
          ? h(
              'div',
              { style: S.card },
              h('h2', { style: S.h2 }, '视频社交'),
              (() => {
                const so = view.social;
                const bili = so.bili || {};
                const q = so.quota || {};
                const t = so.today || {};
                return h(
                  'div',
                  { style: { ...S.dim, marginBottom: 8, lineHeight: 1.7 } },
                  h('div', null, `B站：${bili.loggedIn ? `已登录${bili.name ? `（${bili.name}）` : ''}` : '未登录（只能看，不能点赞/评论）'} · 今天评论 ${t.comments || 0} 条、点赞 ${t.likes || 0} 个`),
                  h('div', null, `额度：评论剩 ${q.commentsLeft ?? '?'} · 点赞剩 ${q.likesLeft ?? '?'}${q.readyInMs > 0 ? ` · 距下次可动手 ${Math.ceil(q.readyInMs / 60000)} 分钟` : ''}${q.quiet ? ' · 安静时段' : ''}`),
                  h('div', null, `关注动态：${bili.loggedIn ? '每轮先看关注的人发的新视频' : '登录后才读'}`),
                  h('div', null, `收到回复：${so.received ? `${so.received} 条（QQ 那边也会知道）${so.replies?.[0] ? ` · 最新 ${so.replies[0].user || '某人'}：${String(so.replies[0].content || '').slice(0, 24)}` : ''}` : '还没有'}`),
                  so.wishes?.[0] ? h('div', null, `最近想要：${so.wishes.map((w) => w.what).join('、')}（QQ 聊天里会偶尔撒娇提一句）`) : null,
                  h('div', null, `蒸馏：${so.feed?.pending ? `${so.feed.pending} 条刷到的内容待学` : '刷到的知识会攒着，够一批就蒸馏成笔记'}`),
                );
              })(),
              (() => {
                const so = view.social;
                const 时 = (at) => {
                  const n = Number(at) || 0;
                  if (!n) return '';
                  const d = new Date(n);
                  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
                };
                const 说过 = (so.acted || []).filter((x) => x.text).slice(0, 6);
                const 收到 = (so.replies || []).slice(0, 6);
                const 小字 = { ...S.dim, fontSize: 12, lineHeight: 1.5 };
                const 块 = { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8, marginTop: 8 };
                const 条 = { padding: '6px 0', borderBottom: '1px dashed var(--dsw-alias-border-l2)' };
                const 链接 = (aid) => (aid ? `https://www.bilibili.com/video/av${aid}` : '');
                if (!说过.length && !收到.length) return h('div', { style: { ...S.dim, marginTop: 8 } }, '还没在 B站 说过话，也没人回它。');
                return h(
                  'div',
                  { style: { marginTop: 4 } },
                  说过.length
                    ? h(
                        'div',
                        { style: 块 },
                        h('div', { style: { ...S.dim, fontWeight: 600, marginBottom: 4 } }, `它在 B站 说过（最近 ${说过.length} 条）`),
                        ...说过.map((x) =>
                          h(
                            'div',
                            { key: x.id, style: 条 },
                            h(
                              'div',
                              { style: 小字 },
                              `${时(x.at)} · ${x.action === 'reply' ? '回评' : '评论'} · ${x.title || '视频'}`,
                              x.aid ? h('a', { href: 链接(x.aid), target: '_blank', rel: 'noreferrer', style: { marginLeft: 6, color: 'var(--dsw-alias-fg-link)' } }, '看视频') : null,
                            ),
                            h('div', { style: { marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, x.text),
                          ),
                        ),
                      )
                    : null,
                  收到.length
                    ? h(
                        'div',
                        { style: 块 },
                        h('div', { style: { ...S.dim, fontWeight: 600, marginBottom: 4 } }, `B站 回它的（最近 ${收到.length} 条，QQ 那边也会知道）`),
                        ...收到.map((r) =>
                          h(
                            'div',
                            { key: r.id, style: 条 },
                            h(
                              'div',
                              { style: 小字 },
                              `${时(r.at)} · ${r.user || '某人'} 在《${r.video || '视频'}》下回：`,
                              r.aid ? h('a', { href: 链接(r.aid), target: '_blank', rel: 'noreferrer', style: { marginLeft: 6, color: 'var(--dsw-alias-fg-link)' } }, '看视频') : null,
                            ),
                            h('div', { style: { marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, r.content || ''),
                          ),
                        ),
                      )
                    : null,
                );
              })(),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 } },
                h('span', { style: S.dim }, '每日上限：评论'),
                h('input', {
                  type: 'number', min: 0, max: 50, defaultValue: view.social.quota?.commentPerDay ?? 12,
                  'aria-label': '每天最多评论几条',
                  style: { width: 66, padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'inherit' },
                  onChange: (e) => { 额度Ref.current.commentPerDay = e.target.value; },
                }),
                h('span', { style: S.dim }, '条 · 点赞'),
                h('input', {
                  type: 'number', min: 0, max: 100, defaultValue: view.social.quota?.likePerDay ?? 32,
                  'aria-label': '每天最多点赞几个',
                  style: { width: 66, padding: '2px 6px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'inherit' },
                  onChange: (e) => { 额度Ref.current.likePerDay = e.target.value; },
                }),
                h('span', { style: S.dim }, '个'),
                h('button', { style: S.btn(false), disabled: 忙, onClick: 存社交额度 }, '保存额度'),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('button', { style: S.btn(true), disabled: 忙, onClick: () => 社交做('social-tick') }, '现在刷一轮'),
                h('button', { style: S.btn(false), disabled: 忙, onClick: () => 社交做('social-check') }, '查新回复'),
                view.social.bili?.loggedIn
                  ? h('button', { style: S.btn(false), disabled: 忙, onClick: () => 社交做('social-logout') }, '退出 B站 登录')
                  : h('button', { style: S.btn(false), disabled: 忙, onClick: () => 社交做('social-login') }, '扫码登录 B站'),
              ),
              社交说 ? h('div', { style: { ...S.dim, marginTop: 8, wordBreak: 'break-all' } }, 社交说) : null,
              h('div', { style: { ...S.dim, marginTop: 6 } }, '评论发出去了撤不回，所以额度、间隔、安静时段都在代码里兜底；演练模式只记录不发。'),
            )
          : null,

        ),
        h('div', { hidden: 页 !== 'settings' },
        h(DailyNewsPanel, { config: 草稿?.dailyNews, status: view.dailyNews, error: view.dailyNewsError,
          groups, draftTargets: 草稿?.agent?.targets, savedTargets: view.editable?.agent?.targets,
          change: 改, dirty: 脏, saving: 保存忙, save: 存, message: 存话 }),

        ),

        // 手动按钮
        h('div', { hidden: 页 !== 'main' },
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '让它现在就动一次'),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('button', { style: S.btn(true), disabled: 忙, onClick: () => 点('share', '手动分享') }, '现在分享一条'),
            h('button', { style: S.btn(false), disabled: 忙, onClick: () => 点('qzone', '发说说') }, '现在发条说说'),
            h('button', { style: S.btn(false), disabled: 忙, onClick: () => 点('speak', '去说话') }, '现在说句话'),
            h('button', { style: S.btn(false), disabled: 忙, onClick: () => 点('agent', '跑一轮') }, '让它自己决定'),
          ),
          说 ? h('div', { style: { ...S.dim, marginTop: 8 } }, 说) : null,
          h('div', { style: { ...S.dim, marginTop: 6 } }, '手动触发不受每日上限和安静时段限制，但照样会写进下面的记录里。'),
        ),

        ),

        // 设置（可改）
        h('div', { hidden: 页 !== 'settings' },
        草稿
          ? h(
              'div',
              { style: S.card },
              h('h2', { style: S.h2 }, '常用设置'),
              h('div', { style: 说明 }, '与上方每日资讯共用保存和撤销；改完统一保存，只重启机器人一次（约 3 秒）。'),

              h('div', { style: { height: 10 } }),

              h(
                'div',
                { style: 分组 },
                h('div', { style: 组名 }, '节奏与额度'),
                h(
                  'div',
                  { style: 行 },
                  开关(草稿.agent?.enabled, (v) => 改('agent.enabled', v), '开启自主行为（关掉它就只被动回消息）'),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '多久醒一次'),
                  数字(草稿.agent?.everyMinutes, (v) => 改('agent.everyMinutes', v), { min: 5, 后缀: '分钟' }),
                  h('span', { style: 说明 }, '±'),
                  数字(草稿.agent?.jitterMinutes, (v) => 改('agent.jitterMinutes', v), { min: 0, 后缀: '分钟抖动' }),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '两次之间至少'),
                  数字(
                    (草稿.agent?.minGapMs || 0) / 60000,
                    (v) => 改('agent.minGapMs', Math.round(Number(v || 0) * 60000)),
                    { min: 0, max: 1440, step: 1 / 60000, 后缀: '分钟' },
                  ),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '每天主动说（下限 ~ 上限）'),
                  h('span', { style: { ...S.dim, fontSize: 12, marginRight: 2 } }, '群'),
                  数字(草稿.agent?.group?.minPerDay ?? 草稿.agent?.minPerDay, (v) => 改('agent.group.minPerDay', v), { min: 0 }),
                  h('span', { style: { ...S.dim, fontSize: 12 } }, '~'),
                  数字(草稿.agent?.group?.maxPerDay ?? 草稿.agent?.maxPerDay, (v) => 改('agent.group.maxPerDay', v), { min: 0 }),
                  h('span', { style: { ...S.dim, fontSize: 12, margin: '0 10px 0 14px' } }, '私聊'),
                  数字(草稿.agent?.private?.minPerDay ?? 草稿.agent?.minPerDay, (v) => 改('agent.private.minPerDay', v), { min: 0 }),
                  h('span', { style: { ...S.dim, fontSize: 12 } }, '~'),
                  数字(草稿.agent?.private?.maxPerDay ?? 草稿.agent?.maxPerDay, (v) => 改('agent.private.maxPerDay', v), { min: 0 }),
                  h('span', { style: { ...S.dim, fontSize: 12, marginLeft: 6 } }, '次/天'),
                ),
                h('div', { style: { ...S.dim, fontSize: 11.5 } },
                  '群和私聊各记一本账，互不占用：群说满了不影响私聊，私聊说多了也不挤掉群的次数。'),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '安静时段（只限主动）'),
                  文本((草稿.agent?.quietHours || []).join(','), (v) => 改('agent.quietHours', v.split(',').map((x) => x.trim()).filter(Boolean)), { width: 200, placeholder: '23:00-08:00' }),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '分享间隔'),
                  数字(草稿.agent?.shareEveryHours, (v) => 改('agent.shareEveryHours', v), { min: 0, max: 240, 后缀: '小时' }),
                  h('span', { style: 说明 }, '说说间隔'),
                  数字(草稿.agent?.qzoneEveryHours, (v) => 改('agent.qzoneEveryHours', v), { min: 0, max: 240, 后缀: '小时' }),
                ),
              ),

              h(
                'div',
                { style: 分组 },
                h('div', { ...锚点('targets'), style: { ...组名, scrollMarginTop: 12 } }, '安全与活动范围'),
                h(
                  'div',
                  { style: 行 },
                  开关(草稿.agent?.dryRun, (v) => 改('agent.dryRun', v), '演练模式（只记账，不真发）'),
                  开关(草稿.agent?.allowDestructive, (v) => 改('agent.allowDestructive', v), '允许危险操作（踢人/退群/改名/删说说）'),
                ),
                (() => {
                  const 当前 = (草稿.agent?.targets || []).map(String);
                  const 有 = (sc) => 当前.includes(sc);
                  const 切 = (sc) => 改('agent.targets', 有(sc) ? 当前.filter((x) => x !== sc) : [...当前, sc]);
                  const 群 = (view.groups || []).map((g) => ({
                    sc: `group:${Number(g.group_id || g.id)}`,
                    label: g.group_name || String(g.group_id || g.id),
                    note: g.member_count ? `${g.member_count} 人` : '',
                  }));
                  const 好友 = (view.friends || []).map((f) => ({
                    sc: `private:${Number(f.user_id || f.uin)}`,
                    label: f.remark || f.nickname || String(f.user_id || f.uin),
                    note: '',
                  }));
                  const 已列 = new Set([...群.map((x) => x.sc), ...好友.map((x) => x.sc)]);
                  const 其他私聊 = (view.scopes || [])
                    .map((x) => String(x.scope || ''))
                    .filter((sc) => sc.startsWith('private:') && !已列.has(sc))
                    .map((sc) => ({ sc, label: `QQ ${sc.split(':')[1]}`, note: '最近来过' }));
                  const 块 = (标题, 项) =>
                    h(
                      'div',
                      { style: S.pickBox },
                      h(
                        'div',
                        { style: S.pickHead },
                        h('span', null, 标题),
                        h('span', { style: S.pickCount }, `${项.filter((x) => 有(x.sc)).length}/${项.length}`),
                      ),
                      h(
                        'div',
                        { style: S.pickWrap },
                        ...(项.length
                          ? 项.map(({ sc, label, note }) =>
                              h(
                                'label',
                                { key: sc, style: S.chip(有(sc)) },
                                h('input', { type: 'checkbox', checked: 有(sc), onChange: () => 切(sc), style: { marginRight: 6 } }),
                                h('span', { style: { maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
                                note ? h('span', { style: S.chipNote }, note) : null,
                              ),
                            )
                          : [h('span', { key: 'none', style: { ...S.dim, fontSize: 12 } }, '（暂无）')]),
                      ),
                    );
                  return h(
                    'div',
                    { style: { marginTop: 4 } },
                    h('div', { style: { ...S.dim, fontSize: 11.5, marginBottom: 5 } },
                      '在哪儿主动说话 · 列表每分钟自动刷新，新进的群、新加的好友、来私聊的陌生人都会自己出现'),
                    块('群', 群),
                    块('私聊', [...好友, ...其他私聊]),
                    h(JsonValueEditor, { value: 草稿.agent?.targets || [], label: '活动目标 JSON', onChange: (v) => 改('agent.targets', v) }),
                  );
                })(),
              ),

              h(
                'div',
                { style: 分组 },
                h('div', { style: 组名 }, '回消息'),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '群聊接话概率'),
                  数字(草稿.chat?.randomInterject?.chance != null ? 草稿.chat.randomInterject.chance * 100 : 0,
                    (v) => 改('chat.randomInterject.chance', Math.max(0, Math.min(100, Number(v) || 0)) / 100), { min: 0, max: 100, step: 0.01, 后缀: '%' }),
                  h('span', { style: { ...S.dim, fontSize: 11 } }, '群里别人普通聊天时，掷中才接（掷中后还会由模型判断值不值得回）'),
                ),
                h(
                  'div',
                  { style: 行 },
                  开关(草稿.chat?.replyOnMention, (v) => 改('chat.replyOnMention', v), '@ 我必回'),
                  开关(草稿.chat?.replyOnReplyToMe, (v) => 改('chat.replyOnReplyToMe', v), '被引用必回'),
                  开关(草稿.chat?.replyPrivate, (v) => 改('chat.replyPrivate', v), '私聊必回'),
                  开关(草稿.chat?.aiDecide, (v) => 改('chat.aiDecide', v), '让它自己判断要不要回'),
                ),
                h(
                  'div',
                  { style: { ...S.dim, marginTop: -2, marginBottom: 4 } },
                  '勾上 = 必回：这三种场合模型不能装死（输出跳过也照发）。但仍受冷却与每分钟上限约束，不是无限连发。',
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '回复最长'),
                  数字(草稿.chat?.maxReplyChars, (v) => 改('chat.maxReplyChars', v), { min: 20, 后缀: '字' }),
                  h('span', { style: 说明 }, '上下文'),
                  数字(草稿.chat?.historyChars, (v) => 改('chat.historyChars', v), { min: 500, step: 500, 后缀: '字' }),
                  h('span', { style: 说明 }, '防止复读看最近'),
                  数字(草稿.chat?.recentSelfEcho, (v) => 改('chat.recentSelfEcho', v), { min: 0, 后缀: '条' }),
                ),
              ),

              h(
                'div',
                { style: 分组 },
                h('div', { ...锚点('model'), style: { ...组名, scrollMarginTop: 12 } }, '模型'),
                h('datalist', { id: 'qq-models' }, ...模型.map((m) => h('option', { key: m, value: m }))),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '主模型'),
                  文本(草稿.llm?.model, (v) => 改('llm.model', v), { width: 250 }),
                  h('span', { style: 说明 }, 模型.length ? `中转站有 ${模型.length} 个模型，输入框点一下能选` : '（没拿到模型清单，手打也一样）'),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '分用途覆盖'),
                  h('span', { style: 说明 }, '不填就用主模型'),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '聊天'),
                  文本(草稿.llm?.models?.chat, (v) => 改('llm.models.chat', v), { width: 210 }),
                  h('span', { style: 说明 }, '决策'),
                  文本(草稿.llm?.models?.agent, (v) => 改('llm.models.agent', v), { width: 210 }),
                  h('span', { style: 说明 }, '蒸馏模型在「学习 · 蒸馏与检索」里单独配'),
                ),
                h(ReasoningEffortFields, { llm: 草稿.llm, onChange: 改 }),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '单次最多 token'),
                  数字(草稿.llm?.maxTokens, (v) => 改('llm.maxTokens', v), { min: 64, max: 32768, step: 1 }),
                  h('span', { style: 说明 }, '创造力 temperature'),
                  数字(草稿.llm?.temperature, (v) => 改('llm.temperature', v), { min: 0, max: 2, step: 0.05 }),
                ),
              ),

              h(
                'div',
                { style: 分组 },
                h('div', { style: 组名 }, '分享的口味'),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '它自己会挑的话题'),
                  h(JsonValueEditor, { value: 草稿.share?.interests || [], label: '分享兴趣 JSON', onChange: (v) => 改('share.interests', v) }),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '来源'),
                  ...[...new Set(['bilibili', 'zhihu', 'tieba', 'toutiao', ...(草稿.share?.sources || [])])].map((src) => {
                    const on = (草稿.share?.sources || []).includes(src);
                    const label = { bilibili: 'B站', zhihu: '知乎', tieba: '贴吧', toutiao: '头条' }[src] || src;
                    return h(
                      'label',
                      { key: src, style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 12.5, cursor: 'pointer' } },
                      h('input', {
                        type: 'checkbox',
                        checked: on,
                        onChange: (e) => {
                          const cur = 草稿.share?.sources || [];
                          const next = e.target.checked ? [...cur, src] : cur.filter((x) => x !== src);
                          改('share.sources', [...new Set(next)]);
                        },
                      }),
                      h('span', null, label),
                    );
                  }),
                ),
                h(JsonValueEditor, { value: 草稿.share?.sources || [], label: '分享来源 JSON', onChange: (v) => 改('share.sources', v) }),
              ),

              h(
                'div',
                { style: 分组 },
                h('div', { ...锚点('persona'), style: { ...组名, scrollMarginTop: 12 } }, '人设'),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '名字'),
                  文本(草稿.persona?.name, (v) => 改('persona.name', v), { width: 160 }),
                  h('span', { style: 说明 }, `来源文件 ${草稿.persona?.source || '—'}（改了不会写回那个文件，以这里为准）`),
                ),
                h(
                  'div',
                  { style: 行 },
                  h('span', { style: 标签 }, '性格关键词'),
                  h(JsonValueEditor, { value: 草稿.persona?.likes || [], label: '性格关键词 JSON', onChange: (v) => 改('persona.likes', v) }),
                ),
                h(
                  'div',
                  { style: { marginBottom: 7 } },
                  h('div', { style: { ...标签, marginBottom: 4 } }, '系统提示词（整段人设，最关键的就在这里）'),
                  h('textarea', {
                    style: {
                      width: '100%',
                      minHeight: 220,
                      font: 'inherit',
                      fontSize: 12.5,
                      lineHeight: 1.6,
                      padding: '8px 10px',
                      borderRadius: 8,
                      border: '1px solid var(--dsw-alias-border-l2)',
                      background: 'transparent',
                      color: 'inherit',
                      resize: 'vertical',
                    },
                    value: 草稿.persona?.systemPrompt || '',
                    onChange: (e) => 改('persona.systemPrompt', e.target.value),
                  }),
                  h('div', { style: { ...说明, marginTop: 4 } }, `当前 ${(草稿.persona?.systemPrompt || '').length} 字。这段会原样塞进模型，改完保存即生效。`),
                ),
                h(
                  'div',
                  { style: { marginTop: 10 } },
                  h('div', { style: { ...标签, marginBottom: 4 } }, '它自己改过的地方（蒸馏之后，最多一天一次）'),
                  (view.personaEvolve?.history || []).length
                    ? (view.personaEvolve.history || []).map((rec) => h(
                        'div',
                        { key: rec.id, style: { ...说明, display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0' } },
                        h('span', { style: { flex: 1 } },
                          `${new Date(rec.at).toLocaleString('zh-CN', { hour12: false })} · ` +
                          [rec.styleAdd ? `说话「${rec.styleAdd}」` : '', rec.rule ? `规矩「${rec.rule}」` : ''].filter(Boolean).join(' · ') +
                          (rec.reason ? `（${rec.reason}）` : '')),
                        h('button', { style: S.btn(false), disabled: 忙, onClick: () => 回滚人格(rec.id) }, '撤销'),
                      ))
                    : h('div', { style: 说明 }, '还没有自己改过。'),
                ),
              ),

              存话 ? h('div', { style: { ...说明, color: /失败/.test(存话) ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, 存话) : null,

              脏
                ? h(
                    'div',
                    {
                      style: {
                        position: 'sticky',
                        bottom: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 0 2px',
                        background: 'var(--dsw-alias-bg-layer-1)',
                      },
                    },
                    h('span', { style: { fontSize: 12.5, color: 'var(--dsw-alias-state-warn-primary)' } }, '有未保存修改（常用设置与资讯共用）'),
                    h('button', { style: S.btn(true), disabled: 保存忙, onClick: 存 }, 保存忙 ? '保存中…' : '保存并重启机器人'),
                    h('button', { style: S.btn(false), disabled: 保存忙, onClick: () => { 草稿版本Ref.current += 1; 设草稿(JSON.parse(JSON.stringify(view.editable))); editableBaseline.current = JSON.parse(JSON.stringify(view.editable)); 置脏(false); 设存话(''); } }, '撤销'),
                  )
                : null,
            )
          : null,

        ),

        h('div', { hidden: 页 !== 'settings' },
          h('details', { style: S.card },
            h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '高级设置 · 连接、能力与学习参数'),
            h(ConfigPanel, { schema: 高级配置组(view.configSchema), onSaved: () => 拉() }))),

        // 最近决策
        h('div', { hidden: 页 !== 'main' },
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h2row },
            h('h2', { style: S.h2inner }, '最近每次醒来干了什么'),
            h('span', { style: S.count }, recent.length ? `最近 ${recent.length} 条` : '')),
          recent.length === 0
            ? h('div', { style: S.dim }, '还没有记录（它下一次醒来之后才会有）。')
            : h(
                'table',
                { style: S.table },
                h('thead', null, h('tr', null, h('th', { style: S.th }, '时间'), h('th', { style: S.th }, '做了什么'), h('th', { style: S.th }, '详情'))),
                h(
                  'tbody',
                  null,
                  ...recent.map((r, i) =>
                    h(
                      'tr',
                      { key: i, style: i % 2 ? S.rowAlt : null },
                      h('td', { style: { ...S.tdTime, ...S.mon } }, timeText(r.at)),
                      h(
                        'td',
                        { style: S.tdTag },
                        h('span', { style: S.tagFixed(r.kind) }, KIND_LABEL[r.kind] || r.kind || '—'),
                        r.dry
                          ? h('span', { style: { marginLeft: 6, fontSize: 10.5, opacity: 0.6, border: '1px dashed var(--dsw-alias-border-l2)', borderRadius: 5, padding: '0 5px' } }, '演练')
                          : null,
                      ),
                      h('td', { style: S.tdDetail }, String(r.detail || r.tool || '').slice(0, 160) || '—'),
                    ),
                  ),
                ),
              ),
        ),

        // 群 + 消息
        h(
          'div',
          { style: S.card },
          h('h2', { ...锚点('groups'), style: { ...S.h2, scrollMarginTop: 12 } }, '群'),
          h('div', { style: S.dim }, `${groupLive.detail} · 自动轮询最多缓存60秒，手动刷新立即重查${!groupLive.ok ? '；下面如有列表为旧值，不代表当前名册' : groups.length ? '' : '；当前未加入群'}`),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: messages.length ? 12 : 0 } },
            ...groups.map((g) =>
              h(
                'button',
                {
                  key: String(g.group_id || g.id),
                  style: {
                    ...S.btn(false),
                    borderColor: String(scope) === `group:${g.group_id || g.id}` ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)',
                  },
                  onClick: () => 设Scope(`group:${g.group_id || g.id}`),
                },
                `${g.group_name || g.name || g.group_id}（${g.member_count || '?'}）`,
              ),
            ),
            h('button', { style: S.btn(false), onClick: () => 设Scope('') }, '不看了'),
          ),
          messages.length
            ? h(
                'div',
                null,
                h('div', { style: { ...S.dim, marginBottom: 6 } }, `${scope} 最近 ${messages.length} 条`),
                ...messages.map((m, i) =>
                  h(
                    'div',
                    { key: i, style: S.msg },
                    h('span', { style: { ...S.dim, ...S.mon, marginRight: 8 } }, timeText(m.at)),
                    h(
                      'span',
                      { style: { fontWeight: 600, marginRight: 6, color: m.role === 'bot' ? 'var(--dsw-alias-state-success-primary)' : 'inherit' } },
                      m.role === 'bot' ? '我' : m.name || '群友',
                    ),
                    h('span', null, m.text),
                  ),
                ),
              )
            : null,
        ),

        // 为什么没说话
        h(
          'div',
          { style: S.card },
          h('div', { style: S.h2row },
            h('h2', { style: S.h2inner }, '为什么没说话'),
            h('span', { style: S.count }, 决策.today ? `沉默 ${决策.today.silent} 次 / 说话 ${决策.today.acted} 次` : '')),
          h('div', { style: { ...S.dim, marginBottom: 8 } },
            决策.today
              ? `今天说话了 ${决策.today.acted} 次，沉默 ${决策.today.silent} 次。下面按原因排，次数多的在前。`
              : view.freshness?.decisions?.ok === false ? '决策记录读取失败，不能判断是否已有记录。' : '还没有记录——它每做一次决定（说 / 不说）都会记一笔。'),
          原因.length
            ? h(
                'table',
                { style: S.table },
                h('thead', null, h('tr', null,
                  h('th', { style: S.th }, '次数'),
                  h('th', { style: S.th }, '类型'),
                  h('th', { style: S.th }, '原因'))),
                h('tbody', null, ...原因.slice(0, 10).map((r, i) =>
                  h('tr', { key: i },
                    h('td', { style: { ...S.tdNum, ...S.mon } }, String(r.n)),
                    h('td', { style: { ...S.tdNum } }, h('span', { style: S.tagFixed(r.kind === 'passive' ? 'skip' : r.kind) }, ({ passive: '被动', agent: '主动', share: '分享', qzone: '说说', interject: '插嘴' })[r.kind] || r.kind)),
                    h('td', { style: S.tdDetail }, r.reason)))),
              )
            : null,
          (决策.recent || []).length
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h('div', { style: { ...S.dim, marginBottom: 4 } }, '最近的时间线'),
                ...决策.recent.slice(0, 12).map((r, i) =>
                  h('div', { key: i, style: { ...S.mon, fontSize: 11.5, padding: '2px 0' } },
                    h('span', { style: { color: r.acted ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' } }, r.acted ? '说 ' : '默 '),
                    `${timeText(r.at)} · ${r.scope} · ${r.reason}${r.n > 1 ? ` ×${r.n}` : ''}`)),
              )
            : null,
        ),

        ),

        // 人物画像
        h('div', { hidden: 页 !== 'memory' },
        h(
          'div',
          { style: S.card },
          h('h2', { style: S.h2 }, '认识的人'),
          h('div', { style: { ...S.dim, marginBottom: 8 } }, '它会给跟它说过话的人建档案：谁、在干嘛、爱聊什么。攒够 10 条新话、且距上次满 3 小时就自动学一次，也能手动学。'),
          学说 ? h('div', { style: { ...S.dim, marginBottom: 8, color: /✘/.test(学说) ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)' } }, 学说) : null,
          people.length === 0
            ? h('div', { style: S.dim }, view.freshness?.people?.ok === false ? '人物档案读取失败，不能判断是否已有档案。' : '还不认识谁——等群里有人说几句话，或者点下面的按钮让它先学一遍。')
            : h(
                'div',
                null,
                ...people.map((p, i) =>
                  h(
                    'div',
                    { key: p.uin, style: { padding: '8px 0', borderTop: i ? '1px solid var(--dsw-alias-border-l2)' : 'none' } },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      h('strong', null, p.name || p.uin),
                      h('span', { style: { ...S.dim, ...S.mon } }, `${p.uin} · 说了 ${p.msgs} 条 · 学过 ${p.learnings || 0} 次`),
                      h('button', {
                        type: 'button',
                        disabled: !!学中[p.uin],
                        style: { ...S.btn(false), padding: '2px 8px', fontSize: 11.5, ...(学中[p.uin] ? { opacity: 0.65, cursor: 'progress' } : {}) },
                        onClick: () => 学人(p.uin, p.name || p.uin),
                      }, 学中[p.uin] ? `学习中 ${Math.max(1, Math.round((Date.now() - 学中[p.uin]) / 1000))}s` : '学一遍'),
                    ),
                    p.summary ? h('div', { style: { marginTop: 3 } }, p.summary) : h('div', { style: { ...S.dim, marginTop: 3 } }, '（还没学）'),
                    学果[p.uin]
                      ? h('div', { style: { marginTop: 3, fontSize: 12, color: 学果[p.uin].ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)' } }, 学果[p.uin].text)
                      : null,
                    (p.facts || []).length
                      ? h('div', { style: { ...S.dim, marginTop: 3 } }, (p.facts || []).slice(0, 4).map((f) => `· ${f}`).join('　'))
                      : null,
                  ),
                ),
              ),
        ),

        // 记忆 & 归档
        h(
          'div',
          { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 } },
          h(
            'div',
            { style: S.card },
            h('h2', { style: S.h2 }, '它记住的东西（按会话分）'),
            memory.length === 0
              ? h('div', { style: S.dim }, '还没整理过记忆。')
              : h(
                  'div',
                  null,
                  ...memory.map((m, i) => {
                    const isPrivate = String(m.scope || '').startsWith('private:');
                    const who = isPrivate ? String(m.scope).slice('private:'.length) : String(m.scope).replace('group:', '');
                    return h(
                      'div',
                      { key: i, style: { marginBottom: 10 } },
                      h(
                        'div',
                        { style: { ...S.dim, ...S.mon, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
                        h('span', { style: S.tagFixed(isPrivate ? 'op' : 'speak') }, isPrivate ? '私聊' : '群'),
                        h('span', null, isPrivate ? `QQ ${who}` : `群 ${who}`),
                        h('span', null, `· ${m.facts} 条事实 · ${timeText(m.updatedAt)}`),
                      ),
                      h('div', null, m.summary || '（空）'),
                    );
                  }),
                ),
          ),
          h(
            'div',
            { style: S.card },
            h('h2', { style: S.h2 }, '聊过多少（硬盘上的账本）'),
            archive.length === 0
              ? h('div', { style: S.dim }, '还没有记录。')
              : h(
                  'table',
                  { style: S.table },
                  h('thead', null, h('tr', null, h('th', { style: S.th }, '会话'), h('th', { style: S.th }, '条数'), h('th', { style: S.th }, '体积'), h('th', { style: S.th }, '分片'))),
                  h(
                    'tbody',
                    null,
                    ...archive.map((a, i) =>
                      h(
                        'tr',
                        { key: i },
                        h('td', { style: { ...S.td, ...S.mon } }, a.scope),
                        h('td', { style: S.td }, String(a.lines)),
                        h('td', { style: S.td }, bytesText(a.bytes)),
                        h('td', { style: S.td }, String(a.segments)),
                      ),
                    ),
                  ),
                ),
          ),
        ),
        ),
      );

      // All legacy cards remain mounted to preserve unsaved drafts between tabs.
      // Setup is independent of overview availability; legacy features retain their tabs.
      const 页签 = [ ['setup', tr('setup')], ['main', tr('overview')], ['settings', tr('settings')], ['memory', tr('memory')], ['chats', tr('chats')], ['ops', tr('ops')] ];
      const 条 = h('div', { role: 'tablist', 'aria-label': tr('title'), className: 'qq-tabs',
        onKeyDown: (event) => {
          const index = 页签.findIndex(([key]) => key === 页);
          const next = event.key === 'ArrowRight' ? (index + 1) % 页签.length : event.key === 'ArrowLeft' ? (index + 页签.length - 1) % 页签.length : event.key === 'Home' ? 0 : event.key === 'End' ? 页签.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault(); 设页(页签[next][0]);
          event.currentTarget.querySelectorAll('[role="tab"]')[next]?.focus();
        } }, ...页签.map(([key, label]) => h('button', { type: 'button', role: 'tab', key,
          id: `${tabId}-${key}`, 'aria-controls': `${tabId}-${key}-panel`, 'aria-selected': 页 === key, tabIndex: 页 === key ? 0 : -1,
          className: 'qq-tab', onClick: () => 设页(key) }, label)));
      return h('div', { className: 'qq-panel', style: { minWidth: 0, color: T.text } },
        h('style', null, `.qq-panel *{box-sizing:border-box}.qq-panel button,.qq-panel input,.qq-panel select,.qq-panel textarea{accent-color:var(--dsw-alias-state-business-primary)}.qq-panel button:disabled{opacity:.5;cursor:not-allowed}.qq-panel button:focus-visible,.qq-panel input:focus-visible,.qq-panel textarea:focus-visible,.qq-panel select:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.qq-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);margin-bottom:16px;overflow:auto}.qq-tab{font:inherit;white-space:nowrap;padding:9px 12px;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);background:transparent;cursor:pointer}.qq-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-state-business-primary);font-weight:600}.qq-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.qq-header-link:hover{background:var(--dsw-alias-interactive-bg-hover)!important;text-decoration:underline}.qq-panel [hidden]{display:none!important}.qq-panel table{max-width:100%}.qq-panel select,.qq-panel option{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}@media(max-width:600px){.qq-chat-list{max-height:180px!important}.qq-panel td,.qq-panel th{overflow-wrap:anywhere}}`),
        条,
        failedSources.length && 页 !== 'main' ? h('div', { role: 'status', style: { ...S.dim, color: T.warn, marginBottom: 10 } }, `部分数据刷新失败：${failedSources.map(([name]) => `${sourceNames[name] || name}（${overviewSource(view, name).detail}）`).join('；')}。已保留上次成功数据，当前设置草稿不会被覆盖。`) : null,
        h('div', { role: 'tabpanel', id: `${tabId}-setup-panel`, 'aria-labelledby': `${tabId}-setup`, hidden: 页 !== 'setup', tabIndex: 0 },
          h(SetupPanel, { onOps: () => 设页('ops'), onSaved: () => 拉(), active: 页 === 'setup' })),
        ...页签.filter(([key]) => key === 'chats' || key === 'ops').map(([key]) => h('div', { key, role: 'tabpanel', id: `${tabId}-${key}-panel`, 'aria-labelledby': `${tabId}-${key}`, hidden: 页 !== key, tabIndex: 0 },
          key === 'chats' ? (页 === key ? h(ChatsPanel, { scopes, groups, online }) : null)
          : key === 'ops' ? (页 === key ? h(OpsPanel) : null) : null)),
        h('div', { hidden: ['setup', 'chats', 'ops'].includes(页), role: 'tabpanel', id: ['setup', 'chats', 'ops'].includes(页) ? undefined : `${tabId}-${页}-panel`, 'aria-labelledby': `${tabId}-${页}`, tabIndex: 0 }, 主页));
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('dsh-qq-panel', copy));
      tr = ctx.locale.bind('dsh-qq-panel');
      ctx.slots.inject('settings.section', () => {
        let dispose;
        const register = () => {
          dispose?.();
          dispose = ctx.slots.register({ name: 'settings.section', id: 'dsh-qq', order: 54, label: tr('title') }, Section);
        };
        register();
        const unsubscribe = ctx.locale.subscribe(register);
        return () => { unsubscribe(); dispose?.(); };
      });
    }
    return { inject: ['slots', 'locale'], apply };
  },
});
