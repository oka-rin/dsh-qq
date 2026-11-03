import crypto from 'node:crypto';
import http from 'node:http';
import { createLogger, sleep } from './util.mjs';

const log = createLogger('mock', process.env.QQ_LOG_LEVEL || 'warn');

/* ------------------------------------------------------------- WebSocket */

function encodeFrame(payload, opcode = 0x1) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = buf.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, buf]);
}

/** 解析客户端发来的帧（客户端帧一定带掩码） */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let len = buffer[1] & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buffer.length < 4) return null;
    len = buffer.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buffer.length < 10) return null;
    len = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + len) return null;
  const data = Buffer.from(buffer.subarray(offset, offset + len));
  if (mask) for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
  return { opcode, data, total: offset + len };
}

/* ------------------------------------------------------------ Mock OneBot */

/**
 * 假的 SnowLuma / OneBot v11 服务端：
 *   POST /<action>  记录动作并返回成功信封（send_* 会分配自增 message_id）
 *   WS  /event      可注入事件，用来模拟群消息
 *   get_login_info / get_group_list / get_group_member_list 有内置假数据
 */
export async function startMockOneBot({ token = '', port = 0, wsPort = 0, selfId = 10001, nickname = '小雪花' } = {}) {
  const actions = [];
  const sockets = new Set();
  let nextMessageId = 5000;
  let forwardNodes = [];

  const groups = [
    { group_id: 123456, group_name: '测试摸鱼群', member_count: 42 },
    { group_id: 654321, group_name: '另一个群', member_count: 7 },
  ];
  const members = [
    { user_id: 10001, nickname, card: '', role: 'member' },
    { user_id: 20002, nickname: '阿强', card: '强哥', role: 'admin' },
    { user_id: 30003, nickname: '小明', card: '', role: 'member' },
  ];

  let autoTimer = null;

  const authOk = (req) => {
    if (!token) return true;
    const header = req.headers.authorization || '';
    if (header === `Bearer ${token}`) return true;
    const url = new URL(req.url, 'http://localhost');
    return url.searchParams.get('access_token') === token;
  };

  const injectEvent = (event) => {
    const payload = JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: Number(selfId), raw_message: '', font: 0, ...event });
    for (const socket of sockets) socket.write(encodeFrame(payload, 0x1));
    return sockets.size;
  };

  const buildGroupEvent = ({ groupId = 123456, userId = 20002, name = '阿强', message, messageId } = {}) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId ?? nextMessageId++,
    group_id: groupId,
    user_id: userId,
    message: typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message,
    sender: { user_id: userId, nickname: name, card: name, role: 'member' },
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const action = url.pathname.replace(/^\//, '');
    if (req.method !== 'POST' || !action) {
      res.writeHead(404).end();
      return;
    }
    if (!authOk(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ status: 'failed', retcode: 1403 }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let params = {};
    try {
      params = raw ? JSON.parse(raw) : {};
    } catch {
      /* ignore */
    }
    // 调试用：POST /__inject 直接注入一条事件；POST /__auto 起一个定期说话的小循环
    if (action === '__inject') {
      const count = injectEvent(params?.event || params);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, clients: count }));
      return;
    }
    if (action === '__auto') {
      clearInterval(autoTimer);
      const every = Math.max(500, Number(params?.intervalMs || 15000));
      const texts = params?.texts || ['@小雪花 你在吗', '今天好热啊', '有人打游戏吗'];
      let i = 0;
      autoTimer = setInterval(() => {
        const t = texts[i % texts.length];
        i += 1;
        injectEvent(buildGroupEvent({ message: t, userId: 20002, name: '阿强' }));
      }, every);
      autoTimer.unref?.();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, intervalMs: every, texts }));
      return;
    }

    actions.push({ action, params, at: Date.now() });

    let data = null;
    switch (action) {
      case 'get_login_info':
        data = { user_id: Number(selfId), nickname };
        break;
      case 'get_group_list':
        data = groups;
        break;
      case 'get_group_member_list':
        data = members;
        break;
      case 'send_group_msg':
      case 'send_private_msg':
      case 'send_msg':
        data = { message_id: nextMessageId++ };
        break;
      case 'get_msg':
        data = { message_id: params.message_id, message: [{ type: 'text', data: { text: '历史消息' } }] };
        break;
      case 'delete_msg':
        data = null;
        break;
      case 'get_forward_msg':
        data = { messages: forwardNodes };
        break;
      default:
        data = { ok: true };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data, message: '', wording: '' }));
  });

  const wsServer = http.createServer();
  wsServer.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    if (token && !(url.searchParams.get('access_token') === token || (req.headers.authorization || '') === `Bearer ${token}`)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    sockets.add(socket);
    socket.on('data', (buf) => {
      const frame = decodeFrame(buf);
      if (!frame) return;
      if (frame.opcode === 0x8) {
        sockets.delete(socket);
        socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      } else if (frame.opcode === 0x9) {
        socket.write(encodeFrame(frame.data, 0xa));
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    log.debug('mock ws 客户端接入');
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  await new Promise((resolve) => wsServer.listen(wsPort, '127.0.0.1', resolve));

  return {
    httpPort: server.address().port,
    wsPort: wsServer.address().port,
    actions,
    groups,
    members,
    get sockets() {
      return sockets.size;
    },
    /** 注入一条群消息事件，模拟群友说话 */
    inject(event) {
      const payload = JSON.stringify(event);
      for (const socket of sockets) socket.write(encodeFrame(payload, 0x1));
      return sockets.size;
    },
    groupMessage(opts = {}) {
      const event = buildGroupEvent(opts);
      this.inject(event);
      return event;
    },
    privateMessage({ userId = 20002, name = '阿强', message, messageId } = {}) {
      const id = messageId ?? nextMessageId++;
      const event = {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(selfId),
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        message_id: id,
        user_id: userId,
        message: typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message,
        raw_message: '',
        font: 0,
        sender: { user_id: userId, nickname: name },
      };
      this.inject(event);
      return event;
    },
    /** 设置 get_forward_msg 的返回（合并转发测试用） */
    setForwardNodes(nodes) {
      forwardNodes = Array.isArray(nodes) ? nodes : [];
    },
    sentActions(name) {
      return actions.filter((a) => a.action === name);
    },
    sentTexts() {
      return actions
        .filter((a) => a.action === 'send_group_msg' || a.action === 'send_private_msg')
        .map((a) => {
          const segs = Array.isArray(a.params.message) ? a.params.message : [];
          return segs.filter((s) => s.type === 'text').map((s) => s.data.text).join('');
        });
    },
    async waitFor(predicate, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = actions.find(predicate);
        if (hit) return hit;
        await sleep(50);
      }
      return null;
    },
    async close() {
      clearInterval(autoTimer);
      for (const s of sockets) {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      }
      sockets.clear();
      await new Promise((r) => server.close(r));
      await new Promise((r) => wsServer.close(r));
    },
  };
}

/* --------------------------------------------------------------- Mock LLM */

/**
 * 假的 OpenAI 兼容模型服务，按顺序吐预设回复；用完后用 fallback。
 * 请求记录在 requests 里，方便断言提示词内容。
 */
export async function startMockLlm({ port = 0, replies = [], fallback = '收到收到' } = {}) {
  const requests = [];
  const queue = [...replies];
  const injectEvent = (event) => {
    const payload = JSON.stringify({ time: Math.floor(Date.now() / 1000), self_id: Number(selfId), raw_message: '', font: 0, ...event });
    for (const socket of sockets) socket.write(encodeFrame(payload, 0x1));
    return sockets.size;
  };

  const buildGroupEvent = ({ groupId = 123456, userId = 20002, name = '阿强', message, messageId } = {}) => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId ?? nextMessageId++,
    group_id: groupId,
    user_id: userId,
    message: typeof message === 'string' ? [{ type: 'text', data: { text: message } }] : message,
    sender: { user_id: userId, nickname: name, card: name, role: 'member' },
  });

  const server = http.createServer(async (req, res) => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* ignore */
    }
    requests.push(body);
    const content = queue.length ? queue.shift() : fallback;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    pushReply: (t) => queue.push(t),
    close: () => new Promise((r) => server.close(r)),
  };
}
