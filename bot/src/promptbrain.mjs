/**
 * 生图「副脑」：把群友随口一句画图需求，变成不跑偏的图像提示词。
 *
 * 为什么要单独一层：直接把口语丢给图像模型，它会自由发挥（主体换人、风格被吃掉、
 * 要求写的字没写）。副脑干两件事——
 *   1) 先用模型抽出「用户明确点名的要素」（must），这些词必须一个不少地进提示词；
 *   2) 生成完做一次机械核对：缺了就再修一遍，修不好就把缺的要素硬append上去。
 * 任何一步失败都退回原句，绝不因为副脑挂了就画不出来。
 */
const EXTRACT_SYSTEM = `你是生图提示词总监。群友随口说了一句要画什么，你要把它变成给图像模型的提示词，第一原则是「不跑偏」，宁可少写细节，也不许改需求。

只输出一行严格 JSON，不要代码块、不要解释：
{"must":["..."],"prompt":"..."}

must：用户明确点名的要素，用他自己的词，逐条列出（主体是什么、几个、颜色、服饰、动作、场景、风格、画幅用途如头像/壁纸、要在图里写的文字），最多 8 条。用户没说的绝对不要编。
prompt：给图像模型的中文提示词，60~120 字。顺序：主体 + 动作 → 服饰细节 → 场景 → 风格与光线 → 构图/画幅。
硬规则：
- must 里的每个词都要原样出现在 prompt 里，不许换成近义词；
- 只允许补画面细节（质感、光线、镜头感），不许换主体、不许换风格、不许加用户没提的新主体；
- 用户要图里写文字，就把文字用英文双引号原样写出，例如 印着 "哈基米" 的字样；
- 用户说了「不要什么」就照写上去。`;

const REVISE_SYSTEM = `你在改上一版生图提示词：群友看了上一张图，提了改动要求。
在原提示词的基础上，只改他要求改的部分，其余（主体、风格、构图）原样保留，绝不能重新编一个新场景。

只输出一行严格 JSON，不要代码块：
{"must":["..."],"prompt":"..."}
must：这次他明确点名的要素，用他自己的词，最多 8 条。
prompt：改好的中文提示词，60~140 字，must 里的词要原样出现。`;

const REPAIR_SYSTEM = `你在修一条生图提示词：有要素没被写进去。把这些要素原样补进最合适的位置，其他内容一个字都不要改。只输出修好的那一句提示词，不要解释。`;

/** 去掉空白与标点后比较，避免「赛博朋克，霓虹」对不上「赛博朋克霓虹」 */
function norm(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s，。、,.!?！？；;:"'“”‘’()（）\[\]【】\-—_/\\]/g, '');
}

/** 哪些要素在提示词里没出现（机械核对，不靠模型自评） */
export function missingMust(prompt, must) {
  const hay = norm(prompt);
  const out = [];
  for (const item of must || []) {
    const m = String(item || '').trim();
    if (!m) continue;
    if (!hay.includes(norm(m))) out.push(m);
  }
  return out;
}

function parseJsonish(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(raw.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function cleanLine(text) {
  return String(text || '')
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/```$/,'')
    .replace(/^["'「『\s]+|["'」』\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 副脑：抽要素 + 写提示词 + 缺了就补。
 * @returns {{prompt:string, must:string[], refined:boolean, repaired:boolean, appended:string[]}}
 */
export async function refinePrompt(brain, text, { context = '', previous = '', cfg = {}, log = null } = {}) {
  const raw = String(text || '').trim();
  const off = { prompt: raw, must: [], refined: false, repaired: false, appended: [] };
  if (!raw) return off;
  const conf = cfg?.image?.promptBrain || {};
  if (conf.enabled === false) return off;
  if (!brain || typeof brain.complete !== 'function') return off;

  const timeoutMs = Math.max(2000, Number(conf.timeoutMs) || 15000);
  const maxChars = Math.max(80, Number(conf.maxChars) || 500);
  const purpose = String(conf.purpose || 'chat');
  const model = String(conf.model || '').trim();

  let out = '';
  try {
    out = await brain.complete({
      system: previous ? REVISE_SYSTEM : EXTRACT_SYSTEM,
      prompt: previous
        ? `上一版提示词：${String(previous).slice(0, 500)}\n群友这次的改动要求：「${raw.slice(0, 240)}」${context ? `\n\n刚才群里在聊：\n${context}` : ''}`
        : `${context ? `刚才群里在聊：\n${context}\n\n` : ''}群友的原话：「${raw.slice(0, 240)}」`,
      maxChars: 1200,
      signal: AbortSignal.timeout(timeoutMs),
      purpose,
      ...(model ? { model } : {}),
    });
  } catch (err) {
    log?.warn?.(`副脑调用失败，这次照原句画：${err.message}`);
    return off;
  }

  const obj = parseJsonish(out);
  const must = Array.isArray(obj?.must)
    ? obj.must.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  let prompt = cleanLine(obj?.prompt || (obj ? '' : out));
  if (!prompt || [...prompt].length < 4) return off;

  let repaired = false;
  let appended = [];
  let missing = missingMust(prompt, must);
  if (missing.length && conf.repair !== false) {
    try {
      const fixed = await brain.complete({
        system: REPAIR_SYSTEM,
        prompt: `原提示词：${prompt}\n漏掉的要素：${missing.join('、')}`,
        maxChars: 1200,
        signal: AbortSignal.timeout(timeoutMs),
        purpose,
        ...(model ? { model } : {}),
      });
      const candidate = cleanLine(fixed);
      if (candidate && [...candidate].length >= 4) {
        prompt = candidate;
        repaired = true;
      }
    } catch (err) {
      log?.warn?.(`副脑补要素失败，直接硬挂要素：${err.message}`);
    }
    missing = missingMust(prompt, must);
  }
  // 模型修不动就机械补，保证要素一定在图里
  if (missing.length) {
    prompt = `${prompt.replace(/[。．.]+$/, '')}；画面必须包含：${missing.join('、')}`;
    appended = missing;
  }

  prompt = prompt.slice(0, maxChars);
  return { prompt, must, refined: true, repaired, appended };
}

/** 旧接口：只要提示词。保留给懒调用方，行为等同副脑但只返回字符串 */
export async function expandPrompt(brain, prompt, { context = '', cfg = {}, timeoutMs = 12000, log = null } = {}) {
  const raw = String(prompt || '').trim();
  if (!raw) return '';
  const conf = { ...(cfg?.image?.promptBrain || {}), timeoutMs: cfg?.image?.promptBrain?.timeoutMs ?? timeoutMs };
  const r = await refinePrompt(brain, raw, { context, cfg: { ...cfg, image: { ...(cfg?.image || {}), promptBrain: conf } }, log });
  return r.prompt || raw;
}
