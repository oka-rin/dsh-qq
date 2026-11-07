import { createLogger, sleep } from './util.mjs';
import { adaptOneBotRequest } from './onebot-compat.mjs';

export class OneBotError extends Error {
  constructor(action, info) {
    super(`OneBot 动作 ${action} 失败：${info.message || info.wording || `retcode=${info.retcode}`}`);
    this.name = 'OneBotError';
    this.action = action;
    this.retcode = info.retcode;
    this.wording = info.wording;
    this.response = info.response;
  }
}

/**
 * SnowLuma（OneBot v11）传输层。
 * - 动作走 HTTP：POST /{action}，Authorization: Bearer <token>
 * - 事件走 WebSocket：ws://127.0.0.1:3001/event（自动重连、指数退避）
 *
 * 只依赖 Node 22 内置的 fetch 与全局 WebSocket，不需要任何 npm 依赖。
 */
export class OneBot {
  constructor(options = {}, { log = createLogger('onebot'), onStatus } = {}) {
    this.gateway = options.gateway || 'snowluma';
    this.httpUrl = String(options.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.wsUrl = String(options.wsUrl || 'ws://127.0.0.1:3001/event');
    this.accessToken = options.accessToken || '';
    // SnowLuma 允许 HTTP 与 WS 使用不同的 access token
    this.wsAccessToken = options.wsAccessToken ?? this.accessToken;
    this.selfId = options.selfId ? String(options.selfId) : '';
    this.log = log;
    this.onStatus = onStatus || (() => {});

    this.state = {
      http: 'unknown',
      ws: 'idle',
      reconnects: 0,
      lastEventAt: 0,
      lastError: '',
      selfId: this.selfId,
      nickname: '',
    };

    this.socket = null;
    this.stopped = false;
    this.handlers = new Set();
    this._inflight = 0;
    this.gen = 0; // 每次连接自增，避免旧 socket 的回调干扰新连接
    this.reconnectTimer = null;
  }

  /* ---------------------------------------------------------------- HTTP */

  #headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.accessToken) h.Authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  #url(action) {
    const base = `${this.httpUrl}/${action}`;
    return this.accessToken ? `${base}?access_token=${encodeURIComponent(this.accessToken)}` : base;
  }

  /** 调用一个动作，成功返回 envelope.data，失败抛 OneBotError */
  async call(action, params = {}, { timeoutMs = 30000, mediaType } = {}) {
    const request = adaptOneBotRequest(action, params, { gateway: this.gateway, selfNickname: this.state.nickname, mediaType });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    this._inflight += 1;
    const startedAt = Date.now();
    try {
      const res = await fetch(this.#url(request.action), {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(request.params ?? {}),
        signal: ac.signal,
      });
      const body = await res.text();
      let envelope;
      try {
        envelope = JSON.parse(body);
      } catch {
        this.state.http = 'error';
        this.state.lastError = `HTTP ${res.status} 返回的不是 JSON`;
        throw new OneBotError(action, {
          message: `HTTP ${res.status} 返回的不是 JSON：${body.slice(0, 200)}`,
          response: body,
        });
      }
      if (!res.ok) {
        this.state.http = 'error';
        this.state.lastError = `HTTP ${res.status}`;
        throw new OneBotError(action, {
          message: `HTTP ${res.status}`,
          retcode: envelope?.retcode,
          wording: envelope?.wording,
          response: envelope,
        });
      }
      this.state.http = 'ok';
      const retcode = envelope?.retcode ?? 0;
      const status = envelope?.status;
      if (status === 'failed' || (retcode !== 0 && retcode !== undefined)) {
        throw new OneBotError(action, {
          message: envelope?.message,
          retcode,
          wording: envelope?.wording,
          response: envelope,
        });
      }
      this.log.debug(`${action} ok ${Date.now() - startedAt}ms`);
      return envelope?.data ?? envelope;
    } catch (err) {
      if (err instanceof OneBotError) throw err;
      this.state.http = 'error';
      this.state.lastError = err?.message || String(err);
      const reason = ac.signal.aborted ? `超时 ${timeoutMs}ms` : err?.message || String(err);
      throw new OneBotError(action, { message: `请求 ${this.httpUrl}/${action} 失败：${reason}` });
    } finally {
      clearTimeout(timer);
      this._inflight -= 1;
    }
  }

  async loginInfo(options = {}) {
    const data = await this.call('get_login_info', {}, options);
    const selfId = String(data?.user_id ?? data?.uin ?? '');
    if (!/^\d+$/.test(selfId) || !data || typeof data.nickname !== 'string') {
      throw new OneBotError('get_login_info', { message: '登录信息缺少有效账号或昵称' });
    }
    // Some gateways cache get_login_info for the entire QQ session. Query the
    // actual self profile without cache rather than re-labelling that as live.
    this.state.selfId = selfId;
    this.selfId = selfId;
    try {
      const profile = await this.call('get_stranger_info', { user_id: Number(selfId), no_cache: true }, options);
      if (typeof profile?.nickname !== 'string' || !profile.nickname.trim() || String(profile?.user_id ?? selfId) !== selfId) {
        throw new OneBotError('get_stranger_info', { message: '自身资料缺少有效昵称或账号不匹配' });
      }
      this.state.nickname = profile.nickname;
      return { ...data, nickname: profile.nickname, nicknameSource: 'profile' };
    } catch (err) {
      // Nickname freshness must not block message handling or lose a valid QQ id.
      this.state.nickname = this.state.nickname || data.nickname;
      return { ...data, nickname: this.state.nickname, nicknameSource: 'cache', nicknameError: err?.message || String(err) };
    }
  }

  /* ----------------------------------------------------------------- WS */

  onEvent(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  #emitEvent(event) {
    this.state.lastEventAt = Date.now();
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        this.log.error('事件处理抛出异常：', err?.stack || err);
      }
    }
  }

  connectEvents() {
    this.stopped = false;
    this.#openSocket();
    return () => {
      this.stopped = true;
      this.#closeSocket();
    };
  }

  #wsUrlWithToken() {
    if (!this.wsAccessToken) return this.wsUrl;
    const url = new URL(this.wsUrl);
    url.searchParams.set('access_token', this.wsAccessToken);
    return url.toString();
  }

  #openSocket() {
    if (this.stopped) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const gen = (this.gen += 1);
    this.state.ws = 'connecting';
    this.onStatus(this.state);
    let socket;
    try {
      socket = new WebSocket(this.#wsUrlWithToken(), {
        headers: this.wsAccessToken ? { Authorization: `Bearer ${this.wsAccessToken}` } : {},
      });
    } catch (err) {
      this.state.ws = 'error';
      this.state.lastError = err?.message || String(err);
      this.#scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      if (gen !== this.gen) return;
      this.state.ws = 'open';
      this.state.reconnects = 0;
      this.log.info(`事件流已连接：${this.wsUrl}`);
      this.onStatus(this.state);
    };

    socket.onmessage = (msg) => {
      if (gen !== this.gen) return;
      const raw = typeof msg.data === 'string' ? msg.data : '';
      if (!raw) return;
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        this.log.debug('忽略非 JSON 事件：', raw.slice(0, 120));
        return;
      }
      // SnowLuma/OneBot 心跳事件
      if (event.post_type === 'meta_event') {
        this.state.ws = 'open';
        return;
      }
      this.#emitEvent(event);
    };

    socket.onerror = (ev) => {
      if (gen !== this.gen) return;
      this.state.ws = 'error';
      this.state.lastError = ev?.message || 'WebSocket 错误';
      this.log.warn(`事件流错误：${this.state.lastError}`);
      this.onStatus(this.state);
      // 握手失败时某些实现不会回调 onclose，这里兜底排一次重连
      this.#scheduleReconnect();
    };

    socket.onclose = (ev) => {
      if (gen !== this.gen) return;
      this.socket = null;
      if (this.stopped) {
        this.state.ws = 'closed';
        this.onStatus(this.state);
        return;
      }
      this.state.ws = 'closed';
      this.state.lastError = `连接关闭（code=${ev?.code}）`;
      this.log.warn(`事件流断开（code=${ev?.code}），准备重连`);
      this.onStatus(this.state);
      this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const attempt = Math.min(this.state.reconnects + 1, 8);
    this.state.reconnects = attempt;
    const delay = Math.min(30000, 800 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
    this.log.info(`${Math.round(delay / 1000)}s 后第 ${attempt} 次重连事件流`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#openSocket();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #closeSocket() {
    const s = this.socket;
    this.socket = null;
    this.gen += 1; // 让旧 socket 的回调失效
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      s?.close();
    } catch {
      /* ignore */
    }
  }

  async waitForOpen(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.state.ws === 'open') return true;
      await sleep(100);
    }
    return false;
  }
}
