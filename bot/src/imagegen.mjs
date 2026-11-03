/**
 * 生图：让机器人自己画一张图（不是搜图）。
 *
 * 走 OpenAI 兼容的 `POST {baseUrl}/images/generations`，中转上是 gpt-image-2.5-flare。
 * 一张要一两分钟，返回 b64_json，所以调用方（被动回复 / agent）都要有耐心，
 * 并且发完就把临时文件删掉。
 */
import fs from 'node:fs';
import path from 'node:path';
import { imageKeyOf } from './config.mjs';

const DEFAULT_SIZE = '1024x1024';

/** 画一张，写到 data/tmp/draw-*.png，返回文件路径等信息；失败抛错（调用方决定怎么兜） */
export async function generateImage(prompt, { cfg = {}, dataDir = './data', size = '', quality = '', log = null, signal = null } = {}) {
  const c = cfg.image || cfg;
  if (c.enabled === false) throw new Error('生图没开（image.enabled=false）');
  const text = String(prompt || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  if (!text) throw new Error('没给要画什么');
  const key = imageKeyOf(cfg);
  const base = String(c.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('没配 image.baseUrl');
  const body = { model: c.model || 'gpt-image-2.5-flare', prompt: text, n: 1, size: size || c.size || DEFAULT_SIZE };
  const q = quality || c.quality;
  if (q) body.quality = q;
  const timeoutMs = Math.max(30_000, Number(c.timeoutMs) || 240_000);

  const started = Date.now();
  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`生图接口 HTTP ${res.status}：${t.slice(0, 300)}`);
  }
  const json = await res.json();
  const item = json?.data?.[0];
  let buf = null;
  if (item?.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item?.url) {
    const r2 = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
    if (!r2.ok) throw new Error(`下载生成的图失败 HTTP ${r2.status}`);
    buf = Buffer.from(await r2.arrayBuffer());
  }
  if (!buf || buf.length < 4096) throw new Error('生图接口没返回图片内容');

  const dir = path.resolve(dataDir, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `draw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  fs.writeFileSync(file, buf);
  const out = { file, prompt: text, size: body.size, model: item?.model || body.model, bytes: buf.length, ms: Date.now() - started };
  log?.info?.(`画好一张图（${Math.round(buf.length / 1024)}KB，${Math.round(out.ms / 1000)}s）：${text.slice(0, 40)}`);
  return out;
}

/** 群聊里「画个 XX」的意图识别 + 从原句里抠出要画的东西 */
const DRAW_VERB = /(画|绘制|生成|做|出|整|来)/;
const DRAW_NOUN = /(图|图片|画|插画|壁纸|头像|表情包|海报|logo)/;
const DRAW_EXCLUDE = /(画风|漫画|动画|画像以外)/;
const LEAD_NOISE = /^(帮我|给我|能不能|可不可以|可以|麻烦你|你|快|请|去|再|先|马上|立刻|直接|来|帮我画|给我画)+/;

const RESEND_HINT = /(过期|看不到|没收到|没看到|收不到|裂了|白屏|打不开|加载不出|失效|重发|再发|发一遍|重传|再给一?张|再来一张)/;
const REDRAW_HINT = /(重画|重新画|再画|改一下|改改|改下|重来|重新生成|再生成|生成一遍|画一遍|不对|不像|不是这样|换一张|换个)/;
const WAIT_HINT = /(还没得|还没好|好了吗|好了没|画好了吗|要多久|这么久|这么慢|在画吗|画到哪|卡了吗|怎么还没)/;

/** 图过期/没收到，想让它把上一张再发一遍 */
export function wantsResend(text) {
  return RESEND_HINT.test(String(text || ''));
}

/** 对上一张不满意，要求改/重画 */
export function wantsRedraw(text) {
  return REDRAW_HINT.test(String(text || ''));
}

/** 在催进度（别让它编「显卡在算」） */
export function wantsWait(text) {
  return WAIT_HINT.test(String(text || ''));
}

/** 这句是不是让它画图 */
export function wantsDraw(text) {
  const t = String(text || '').trim();
  if (!t || [...t].length > 200) return false;
  if (DRAW_EXCLUDE.test(t)) return false;
  return DRAW_VERB.test(t) && DRAW_NOUN.test(t);
}

/** 从「帮我画一张赛博朋克风的猫」里抠出「赛博朋克风的猫」；抠不干净返回原句 */
export function drawPromptOf(text) {
  let t = String(text || '').trim();
  t = t.replace(/^[\s\S]{0,20}?(画一张|画一个|画个|画幅|画张|画一|生成一张|生成一个|生成个|生成|来一张|整一张|做一张)/, '');
  t = t.replace(LEAD_NOISE, '');
  t = t.replace(/^(一张|一个|幅|张)/, '');
  t = t.replace(/(的?图片|的?图|壁纸|插画|海报|头像|表情包)$/, '');
  t = t.replace(/[，。！？,!.?~～]+$/g, '').trim();
  return t || String(text || '').trim();
}

const REWRITE_SYSTEM = `你把群友的一句「画图需求」改写成给图像模型的画面描述（中英皆可）。
要求：只写画面本身——主体、动作、场景、风格、光线、构图；不要出现「帮我画」「生成一张」这类词；
不要写字要求（除非对方明确要图里写文字，那就把要写的字原样放进引号）；一句话，40~80 字。
只输出改写后的那句描述，不要解释、不要引号。`;

/** 用聊天模型把口语需求扩写成画面描述；模型不可用就退回原句，绝不因为这个失败 */
export async function expandPrompt(brain, prompt, { context = '', timeoutMs = 12000, log = null } = {}) {
  const raw = String(prompt || '').trim();
  if (!raw) return '';
  if (!brain || typeof brain.complete !== 'function') return raw;
  try {
    const out = await brain.complete({
      system: REWRITE_SYSTEM,
      prompt: `${context ? `刚才群里在聊：\n${context}\n\n` : ''}群友的原话：「${raw.slice(0, 200)}」`,
      maxChars: 200,
      signal: AbortSignal.timeout(Math.max(2000, Number(timeoutMs) || 12000)),
      purpose: 'background',
    });
    const text = String(out || '').replace(/^["'「『\s]+|["'」』\s]+$/g, '').replace(/\s+/g, ' ').trim();
    if (text.length >= 6) return text.slice(0, 400);
  } catch (err) {
    log?.debug?.(`扩写画图描述失败，用原句：${err.message}`);
  }
  return raw;
}
