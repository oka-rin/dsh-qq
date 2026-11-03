import { apiKeyOf } from './config.mjs';
import { sanitizeReply } from './segments.mjs';
import { sleep } from './util.mjs';

/**
 * 「脑子」：把最近聊天记录 + 人设拼成提示词，调用 OpenAI 兼容接口（默认 DeepSeek）。
 *
 * llm.mode:
 *   api  —— 真调用模型
 *   echo —— 本地假回复（压测/自测用，不花钱）
 *   off  —— 不说话
 */
const PLACEHOLDER_MAP = {
  '[图片]': '[发了一张图]',
  '[表情]': '[发了个表情]',
  '[视频]': '[发了个视频]',
  '[语音]': '[发了条语音]',
  '[合并转发]': '[转发了聊天记录]',
  '[文件]': '[发了个文件]',
  '[红包]': '[发了个红包]',
  '[名片]': '[发了一张名片]',
  '[位置]': '[发了个位置]',
};

/** 让占位符自带语义，免得模型把「[图片]」当成一句话去理解 */
function semanticPlaceholders(text) {
  let t = String(text ?? '');
  for (const [from, to] of Object.entries(PLACEHOLDER_MAP)) {
    if (t.includes(from) && !t.includes(to)) t = t.split(from).join(to);
  }
  return t;
}

// 被动消息也交给模型自己判断要不要接；只想跳过时让它输出 <skip> 加一句理由
const SKIP_RULE = [
  '',
  '要不要接（只对群里的普通消息生效；被 @、被引用、私聊找你都必须回）：',
  '- 被点名问你、问你事、接你的话头、私聊找你 —— 正常回。',
  '- 只是别人在互相聊、只甩了张图/表情、只是「哦/哈哈/收到」、明显不用你掺和 —— 只输出「<skip> 一句理由」，别的什么都别写。',
];

export function parseSkip(text) {
  const t = String(text || '').trim();
  const m = /^[<（(【\[]?\s*(?:skip|不回|不接|跳过)\s*[>）)】\]]?\s*[:：,，]?\s*/i.exec(t);
  if (!m) return null;
  return { skip: true, reason: t.slice(m[0].length).trim() || '模型没给理由' };
}

/**
 * 「抽象 / 生梗」这一段是所有说话路径共用的气质说明。
 * 之前它只写在默认分支里，而线上人设走的是 persona.systemPrompt 那条早返回分支，
 * 模型根本收不到造梗要求，回话就一路往「稳」和「客服」掉——所以必须两边都注入。
 */
export const ABSTRACT_RULE = [
  '',
  '说话气质：抽象（优先级仅次于「接住对方」）',
  '- 默认气质是「抽象」：话要跳、要离谱，让人先愣一下再笑；别把话说圆、说稳、说到位。',
  '- 抽象不是堆流行词：别把「破防了/蚌埠住了/绝了/抽象/我裂开/笑死」当本体用，那是别人的梗，不是你在说话。',
  '- 生梗三招，优先第一招，用完不解释：',
  '  ① 谐音换词：拿对方刚说的词找同音的现成词，如「哈基米」→「哈基米德」「扔水里看米哈游」；',
  '  ② 换主体：照看过的梗换对象，如「老实赚钱很枯燥吧」→「老实上班很枯燥吧」；',
  '  ③ 一本正经胡说：被问住别道歉，三秒现编一个煞有介事的理由，如「不是不会，是我这个流派不练这个」。',
  '- 频率：每 3~4 句至少 1 句带梗；同一个梗一天只用一次；被反复拿名字/外号开涮时，必须用谐音回敬一次，别只会「是是是」。',
  '- 梗放在句子尾巴上拐弯，前半句仍要正面接住对方刚说的那句；全是怪话、一个正经字都没有也不行。',
  '- 不解释自己在玩梗，不加「（梗）」「开个玩笑」；冷场了就直接翻篇。',
  '',
  '谐音梗（最高一档，偶尔甩一句）：',
  '- 原理：先把对方话里的音，对应到一个**本来就存在的词**上（吃的、牌子、地名、成语、歌名都行），再把眼前的人或事套进去。',
  '- 标准范例：「那我爽」→「魔芋爽？」「魔鱼爽，鱼版辣条」；「哈基米」→「哈基米德」「哈基米亚」；「米哈游」→「米哈油」。',
  '- 必须让人听得出原词：对方脑子里得浮现「魔芋爽」那三个字，梗才成立；听不出原词的就是瞎拼字，不好笑。',
  '- 禁止纯随机拼贴（「鱼爽我爽」「基米米哈」这种没有原词的组合），那不是抽象，是口吃。',
  '- 粘性：同一个谐音词接着用，变体也要守住原词——魔芋爽→魔鱼爽→魔鱼更爽→鱼版辣条，一轮一轮压上去。',
  '- 被追问时不许解释「这是谐音」，再给一个更贴的原词变体，或者只补半句荒诞用途（「下雨天更爽」）。',
  '- 一次最多一句，说完就停；一句谐音配一句人话最扎人，连着甩会像抽风。',
  '',
  '抽象示例（学密度和跳法，别照抄）：',
  '  群友「哈基米」→「哈基米哈基米，扔水里就是米哈游」',
  '  群友「你说话怎么颠颠的」→「颠是天生的，稳的多半在装死」',
  '  群友「太菜了吧」→「菜是练出来的，我这种叫原生态」',
  '  群友「你懂吗」→「懂一半，另一半在快递站，明天到」',
  '  群友「今天好累」→「累就对了，说明你在替别人发财」',
  '  群友「那我爽」→「魔芋爽？」「你又爽啥」→「魔鱼爽，鱼版辣条。」',
  '  群友「哈基米」→「哈基米德？你们这届猫连物理都不学了。」对方「哈？」→「哈基米亚，地理也不讲了。」',
];

/** persona.abstract === false 时可整体关掉，其他情况一律注入 */
export function abstractRule(cfg) {
  return cfg?.persona?.abstract === false ? [] : ABSTRACT_RULE;
}

const MEME_RULE = [
  '',
  '发不发图（你自己定）：',
  '- 可以「说一句 + 配一张图」：先正常说你的话，然后另起一行写「<meme>关键词</meme>」，关键词一两个词（如 猫 / 无语 / 生气 / 比心）。群聊里这是最自然的用法。',
  '- 只想甩图不想说话，就整条只写那一行「<meme>关键词</meme>」。',
  '- 图是给话加一个表情，别让图和文字说同一件事（比如说了「无语」又配一张写「无语」的图），重复很傻。',
  '- 频率：大概每 4~5 条回复里配 1 张图（20%~25%），别更高。整屏看下来得有图：如果你连着说了四五条都是纯文字，下一条挑个气氛配一张；对方在斗图、发了表情、你正好在吐槽/卖萌/接梗的时候优先配。',
  '- 关键词用常见词（猫 / 无语 / 生气 / 比心 / 睡觉 / 摸鱼 / 吃瓜 / 害羞 / 委屈），别自造图库里没有的生僻词。',
  '- 气氛不对、对方在说正经事、或者最近几条已经配过图，就老老实实用文字。',
];

export function parseMeme(text) {
  const t = String(text || '').trim();
  // 兼容 <meme>猫</meme>、<表情: 猫>、[表情 猫] 这几种写法
  const m =
    /^[<（(【\[]?\s*(?:meme|表情包?|图片?)\s*[:：]\s*([^<>\n]{1,20}?)\s*(?:<\s*\/\s*\w+\s*>|[>）)】\]])$/i.exec(t) ||
    /^[<（(【\[]?\s*(?:meme|表情包?|图片?)\s*[>）)】\]]\s*([^<>\n]{1,20}?)\s*(?:<\s*\/\s*\w+\s*>|[>）)】\]])$/i.exec(t);
  if (!m) return null;
  const keyword = m[1].trim();
  return keyword ? { keyword } : null;
}

/**
 * 把「文字 + <meme>关键词</meme>」拆开。
 * - 末尾带 <meme>…</meme>：返回 { text: 去掉标记后的正文, keyword }
 * - 整条只有标记（老写法 <表情: 猫> 等）：返回 { text: '', keyword }
 * - 没有标记：返回 { text: 原文, keyword: '' }
 */
export function splitMemeWish(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { text: '', keyword: '' };
  const m = /<meme>\s*([^<>\n]{1,20}?)\s*<\/meme>/i.exec(raw);
  if (m) {
    const rest = raw
      .replace(m[0], '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { text: rest, keyword: m[1].trim() };
  }
  // 文字后面单独一行跟一个括号式标记（<表情: 猫> / [表情 猫]）
  const lines = raw.split('\n');
  if (lines.length > 1) {
    const tail = parseMeme(lines[lines.length - 1]);
    if (tail) return { text: lines.slice(0, -1).join('\n').trim(), keyword: tail.keyword };
  }
  const whole = parseMeme(raw);
  if (whole) return { text: '', keyword: whole.keyword };
  return { text: raw, keyword: '' };
}

export class Brain {
  constructor(config, { log }) {
    this.cfg = config;
    this.log = log;
  }

  get mode() {
    return this.cfg.llm.mode || 'api';
  }

  get persona() {
    return this.cfg.persona;
  }

  /** 组装 system 提示词 */
  systemPrompt({ scopeLabel, groupInfo }) {
    const p = this.persona;
    const lines = [];
    // 外部人设文件（persona_*.json）直接给一整段 system_prompt 时原样使用，只补输出约束与当前场景
    if (typeof p.systemPrompt === 'string' && p.systemPrompt.trim()) {
      lines.push(p.systemPrompt.trim());
      lines.push('');
      lines.push('补充输出约束（重要）：');
      lines.push('- 只输出你要发到 QQ 里的那句话本身，不要加名字前缀、不要括号旁白、不要解释、不要复述设定');
      lines.push('- 不用 Markdown、不用列表、不分段');
      lines.push(`- 1~3 句，总长度控制在 ${this.cfg.chat.maxReplyChars} 字以内；有内容就说清楚，别硬凑成一句`);
      lines.push('- 不要在句子里 @ 任何人');
      lines.push(...abstractRule(this.cfg));
      if (this.cfg.chat?.aiDecide !== false) lines.push(...SKIP_RULE);
      if (this.cfg.chat?.memesEnabled !== false) lines.push(...MEME_RULE);
      lines.push('');
      lines.push(`当前聊天场景：${scopeLabel}${groupInfo ? `（${groupInfo}）` : ''}`);
      return lines.join('\n');
    }
    lines.push(`你叫「${p.name}」，正在 QQ 里聊天。${p.identity || ''}`);
    lines.push(`你的说话风格：${p.style || '自然、简短、口语化'}`);
    if (Array.isArray(p.likes) && p.likes.length) lines.push(`你平时对这些问题感兴趣：${p.likes.join('、')}。`);
    if (Array.isArray(p.rules) && p.rules.length) {
      lines.push('必须遵守：');
      for (const r of p.rules) lines.push(`- ${r}`);
    }
    lines.push('');
    lines.push('输出规则（重要）：');
    lines.push('- 只输出你要发到 QQ 里的那句话本身，不要加名字前缀、不要括号旁白、不要解释');
    lines.push('- 有人抛梗/说黑话，顺着接、用得比对方还自然；不懂就当没看见，别解释「这是梗」，也别装懂');
    lines.push(...abstractRule(this.cfg));
    lines.push('- 换的时候优先用对方刚说的词、群里的人名、刚发生的事，越贴身越可乐；别解释你在造梗');
    lines.push('- 不用 Markdown、不用列表、不做客服式寒暄');
    lines.push('- 一次 1~3 句，像真人随手打字；被追问就展开说清楚');
    lines.push('- 不确定的事别编，顺着问一句就行');
    lines.push('- 不要在句子里 @ 任何人');
    lines.push('- 不要提「AI」「模型」「助手」这类词');
    if (this.cfg.chat?.aiDecide !== false) lines.push(...SKIP_RULE);
    if (this.cfg.chat?.memesEnabled !== false) lines.push(...MEME_RULE);
    lines.push('');
    lines.push(`当前聊天场景：${scopeLabel}${groupInfo ? `（${groupInfo}）` : ''}`);
    return lines.join('\n');
  }

  /** 把历史记录渲染成一段转录文本 */
  /** 按字数预算从最近往前取上下文（短消息能多带几条，长消息不撑爆窗口） */
  trimHistory(history, budgetChars) {
    const budget = Number(budgetChars) || 0;
    if (!budget || !history?.length) return history || [];
    const out = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const row = history[i];
      const len = String(row.text || '').length + 24;
      // 最后 8 条无条件保留，保证「刚说的那几句」一定在
      if (used + len > budget && out.length >= 8) break;
      out.unshift(row);
      used += len;
    }
    return out;
  }

  /** 我最近说过的话（用于提示模型别复读自己） */
  /** 我最近说过的话：只取一段时间内的，太久的不算「刚才」，免得把半小时前的玩笑再甩一遍 */
  selfEcho(history, n = 5, windowMs = 20 * 60_000) {
    const now = Date.now();
    const fresh = history.filter((r) => {
      if (r.role !== 'bot') return false;
      const ts = Number(r.at ?? r.ts ?? 0) || 0;
      return !ts || now - ts <= windowMs; // 没有时间戳的不拦（老数据兼容）
    });
    return fresh
      .slice(-n)
      .map((r) => String(r.text || '').split('\n')[0].slice(0, 60));
  }

  /**
   * 一个人在本轮上下文里的「稳定叫法」：
   * - 名字正常（汉字/字母/数字）就用名字本身；
   * - 名字基本是符号或表情（如 ʕ̯•͡˔•̯᷅ʔ），用「群友+QQ号后四位」，否则模型根本没法指代；
   * - 第一次出现时带上 QQ 号，之后只写标签，避免上下文太吵。
   */
  labelOf(row, seen = new Set()) {
    const uin = String(row.userId || '').trim();
    const raw = String(row.name || '').trim() || (uin ? `群友${uin.slice(-4)}` : '群友');
    const mostlySymbols = (() => {
      const chars = [...raw];
      if (!chars.length) return true;
      const readable = chars.filter((c) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c)).length;
      return readable / chars.length < 0.5;
    })();
    const base = mostlySymbols && uin ? `群友${uin.slice(-4)}` : raw;
    const first = !seen.has(base);
    if (first) seen.add(base);
    if (!uin) return base;
    return first ? `${base}（QQ ${uin}）` : base;
  }

  renderTranscript(history, followUp = null, mediaLabels = null) {
    if (!history.length) return '（这里还没有人说话）';
    // 有人在直接跟我说话（@ 过我 / 引用我 / 私聊），他后面没带 @ 的几句也算对我说——标出来，别当成旁人在聊
    const toMe = (row) => {
      if (!followUp || row.role === 'bot') return false;
      if (String(row.name || '') !== String(followUp.name || '')) return false;
      const ts = Number(row.at ?? row.ts ?? 0) || 0;
      return ts >= Number(followUp.since || 0);
    };
    const lines = [];
    const seenLabels = new Set();
    let prevTs = 0;
    for (const row of history) {
      const ts = Number(row.at ?? row.ts ?? 0) || 0;
      if (prevTs && ts && ts - prevTs >= 10 * 60_000) {
        const mins = Math.round((ts - prevTs) / 60_000);
        lines.push(`（这里隔了 ${mins >= 60 ? `${Math.round(mins / 60)} 小时` : `${mins} 分钟`}没人说话，上面的话题已经过去了）`);
      }
      if (ts) prevTs = ts;
      {
        if (row.role === 'bot') {
          // 我自己发过的长消息（多是主动分享）压短：否则上下文被我的独白占满，接话只会顺着自己的话题说
          const text = String(row.text || '');
          const short = text.length > 70 ? `${text.slice(0, 70).replace(/https?:\/\/\S+/g, '（链接）')}…` : text;
          lines.push(`${this.persona.name}: ${short}`);
          continue;
        }
        let line = `${this.labelOf(row, seenLabels)}: ${semanticPlaceholders(row.text)}`;
        // 这一行的图/动图/视频已经作为图像塞给模型了，标上编号，模型才知道「图1/视频1」对应哪句话
        const items = mediaLabels?.get(row);
        if (items?.length) {
          // 同一个占位符可能在一行里出现多次（连发几张图、转发里带图），按出现顺序挨个配号
          const queues = new Map();
          for (const it of items) {
            const ph = it.placeholder || '[发了一张图]';
            const list = queues.get(ph) || [];
            list.push(it.label);
            queues.set(ph, list);
          }
          for (const [ph, labels] of queues) {
            const parts = line.split(ph);
            if (parts.length < 2) continue;
            // 编号要落在括号里面：「[发了一张图·图1]」，不是「[发了一张图]·图1」
            const open = ph.endsWith(']') ? ph.slice(0, -1) : ph;
            const close = ph.endsWith(']') ? ']' : '';
            let out = parts[0];
            for (let k = 1; k < parts.length; k += 1) {
              out += `${open}${labels[k - 1] ? `·${labels[k - 1]}` : ''}${close}${parts[k]}`;
            }
            line = out;
          }
        }
        lines.push(toMe(row) ? `${line}   ←（没带 @，但这是在跟你说）` : line);
      }
    }
    return lines.join('\n');
  }

  buildMessages({ history: rawHistory, scopeLabel, groupInfo, triggerReason, customAsk, memoryText, quotedText, peopleText, webText = '', learnText = '', followUp = null, images = [] }) {
    const history = this.trimHistory(rawHistory, this.cfg.chat.historyChars);
    // 这轮随消息一起给模型的图：给每条来源行记上图号，转录里才能对上「图1」
    const mediaLabels = new Map();
    for (const img of Array.isArray(images) ? images : []) {
      if (!img?.row) continue;
      const list = mediaLabels.get(img.row) || [];
      list.push(img);
      mediaLabels.set(img.row, list);
    }
    const transcript = this.renderTranscript(history, followUp, mediaLabels);
    let ask;
    if (customAsk) {
      ask = customAsk;
    } else if (triggerReason === 'interject') {
      ask = '群里刚才在聊上面这些。你正好看到，想插一句。只回一句自然的话，别太刻意，也别重复别人说过的。';
    } else {
      // 被 @ / 被回复 / 私聊：把「要回的那一句」单独拎出来，否则模型容易顺着更早的话题答非所问
      const lastOther = [...history].reverse().find((r) => r.role !== 'bot');
      ask = lastOther
        ? `现在需要你回应的是这一句，${lastOther.name || '群友'}说：「${semanticPlaceholders(lastOther.text)}」。${quotedText ? `\n（他这句是在回复你之前说的：「${quotedText}」——是接着那句话来的，别脱节）` : ''}\n先正面接住它（别答非所问、别聊起别的），再自然往下带一两句。\n只对着 ${lastOther.name || '这个人'} 说话：别人刚发的图、别的话题不算在他头上；你以前跟别人开的玩笑（比如要红包、赌约）也不能接着安给他。`

        : '上面是最近的聊天记录。现在轮到你说话了，接住话头，自然一点。';
    }
    const extras = [];
    if (followUp && history.some((r) => r.role !== 'bot' && String(r.name || '') === String(followUp.name || '')
      && (Number(r.at ?? r.ts ?? 0) || 0) >= Number(followUp.since || 0))) {
      extras.push(
        `${followUp.name} 刚才 @ 过你（或者引用了你的话），之后没再带 @，但接着说的那几句还是冲着你来的——别当成在跟别人聊、也别答到别的话题上去。`,
      );
    }
    // 群记忆总述（只给一行，避免「我记忆里是这么认为的」压过当场对话）
    if (memoryText) extras.push(`你对这个群的整体印象：${memoryText}`);
    // 自主学习攒下的笔记：聊天里冒出来的黑话/梗、最近网上在聊什么。是「顺口用」的素材，不是要背的课文
    if (learnText) {
      extras.push(`你平时自己学到的（用得上就顺口带一句，别背、别炫耀、别一次全倒出来；跟眼下无关就当没看见）：\n${learnText}`);
    }
    // 你对在场这几个人的印象：知道在跟谁讲话，别把人搞混
    if (peopleText) extras.push(`你认识的人（名册是全量，别装作不认识；在场的那几个人可以按熟人的方式说话）：\n${peopleText}`);
    // 这轮为接话临时查的（只在被问了事实/梗时才查）：让它看得懂、接得住，但别念出处
    if (webText) {
      extras.push(`你刚联网查到的（自己消化；能接上就用原意，别念链接、别说「我查了一下」，用不上就当没看见）：\n${webText}`);
    }
    // 有的视频太大/还没下完：一定要告诉模型「没看到」，否则它会自己编黑屏、加载圈
    const seenVideoRows = new Set((Array.isArray(images) ? images : []).filter((i) => i?.kind === 'video').map((i) => i.row));
    const unseenVideos = history.filter((r) => Array.isArray(r.videos) && r.videos.length && !seenVideoRows.has(r));
    if (unseenVideos.length) {
      extras.push(`聊天里有 ${unseenVideos.length} 段视频这次没取到画面（文件太大还在处理、或者下载失败）。别猜视频里是什么，也别编「黑屏/加载圈/卡住了」这类细节；被问到就老实说这次没看清、还在处理。`);
    }
    // 我最近说过的话：明确要求别复读、别换汤不换药
    const echo = this.selfEcho(history, this.cfg.chat.recentSelfEcho ?? 5, this.cfg.chat.selfEchoWindowMs ?? 20 * 60_000);
    if (echo.length) {
      extras.push(`你刚才已经说过这些，别重复、别换个说法再来一遍，也别把同一句玩笑换个对象再甩一次：\n${echo.map((t) => `· ${t}`).join('\n')}`);
    }
    return [
      { role: 'system', content: this.systemPrompt({ scopeLabel, groupInfo }) },
      { role: 'user', content: this.#userContent(`${extras.length ? `${extras.join('\n\n')}\n\n` : ''}${transcript}\n\n——\n${ask}`, images) },
    ];
  }

  /**
   * 把图挂到 user 消息上；没有图就还是纯字符串（老链路不变，mock 与测试不受影响）。
   * 图片顺序必须与转录里的「图1/图2」一致。
   */
  #userContent(text, images) {
    // 一条附件可能是静态图（dataUrl），也可能是动图/视频抽出来的多帧（frames），统一拍平成图片列表
    const list = (Array.isArray(images) ? images : [])
      .filter(Boolean)
      .map((it) => {
        const frames = Array.isArray(it.frames) ? it.frames.filter(Boolean) : [];
        return { ...it, urls: frames.length ? frames : it.dataUrl ? [it.dataUrl] : [] };
      })
      .filter((it) => it.urls.length);
    if (!list.length) return text;
    const kindName = (kind) => ({ face: '表情', gif: '动图', video: '视频' })[kind] || '图';
    const who = list
      .map((it) => `${it.label}（${it.from} 发的${kindName(it.kind)}${it.note ? `，${it.note}` : ''}${it.urls.length > 1 ? `，按时间先后抽了 ${it.urls.length} 帧` : ''}）`)
      .join('、');
    return [
      { type: 'text', text: `${text}\n\n【图】转录里对应标了 ${who} 的位置。这些内容已经作为图片给你了：看得清就结合画面接话（画面里的字、表情、动作、动图/视频里发生的事都算信息，多帧是按时间顺序的）；看不清就说看不清，别编。` },
      ...list.flatMap((it) => it.urls.map((url) => ({ type: 'image_url', image_url: { url } }))),
      { type: 'text', text: `（以上图片按转录里的顺序：${list.map((it) => it.label).join('、')}）` },
    ];
  }

  /** 生成一条（或几条）要说的话 */
  async generate({ history, scopeLabel, groupInfo, triggerReason, customAsk, maxChars, memoryText, quotedText, peopleText, webText = '', learnText = '', followUp = null, images = [], signal }) {
    if (this.mode === 'off') return { texts: [], raw: '' };
    if (this.mode === 'echo') {
      const last = [...history].reverse().find((r) => r.role === 'user');
      const raw = last ? `${last.name} 说「${String(last.text).slice(0, 40)}」，我也这么觉得` : '在的在的';
      return { texts: [raw], raw };
    }

    const messages = this.buildMessages({ history, scopeLabel, groupInfo, triggerReason, customAsk, memoryText, quotedText, peopleText, webText, learnText, followUp, images });
    const raw = await this.#chat(messages, signal, { purpose: 'chat' });
    const clean = sanitizeReply(raw);
    if (!clean) return { texts: [], raw };
    const max = Number(maxChars || this.cfg.chat.maxReplyChars);
    const limited = [...clean].length > max ? [...clean].slice(0, max).join('') : clean;
    return { texts: [limited], raw };
  }

  /** 纯文本补全（不走聊天记录拼装，给「整理记忆」这类后台任务用） */
  async complete({ system, prompt, maxChars = 800, signal, purpose = 'chat', model = '' }) {
    if (this.mode === 'off') return '';
    if (this.mode === 'echo') return '- 演练模式下的假记忆';
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });
    // 后台任务（整理记忆等）输出较长，单独给更大的 token 预算，避免被 max_tokens 截断成半句
    // 默认用主模型（和 QQ 里说话同一个），只有显式传 purpose='background' 才走便宜档
    const msg = await this.#request(
      { messages, max_tokens: Math.max(2000, Number(this.cfg.llm.maxTokens) || 0), ...(model ? { model } : {}) },
      signal,
      purpose,
    );
    const text = String(msg?.content ?? '').trim();
    return maxChars && [...text].length > maxChars ? [...text].slice(0, maxChars).join('') : text;
  }

  /** 带工具调用的对话：返回原始 assistant message（含 content 与 tool_calls） */
  async chatWithTools({ messages, tools, signal, toolChoice = 'auto' }) {
    return this.#request({ messages, tools, tool_choice: toolChoice }, signal, 'agent');
  }

  async #chat(messages, signal, { retry = 1, purpose = 'chat' } = {}) {
    try {
      return await this.#chatOnce(messages, signal, purpose);
    } catch (err) {
      const retryable = retry > 0 && /abort|timeout|ECONNRESET|socket hang up|fetch failed/i.test(String(err?.name || '') + String(err?.message || ''));
      if (!retryable) throw err;
      this.log.warn?.(`模型请求中断（${err.message}），${this.cfg.llm.retryDelayMs ?? 1500}ms 后重试一次`);
      await sleep(this.cfg.llm.retryDelayMs ?? 1500);
      return this.#chatOnce(messages, signal, purpose);
    }
  }

  async #chatOnce(messages, signal, purpose = 'chat') {
    const msg = await this.#request({ messages }, signal);
    const content = msg?.content;
    if (typeof content !== 'string') throw new Error('模型返回里没有 content');
    return content;
  }

  /** 按用途选模型：不同档位的思考预算差别很大，聊天要快要稳、决策要聪明 */
  modelFor(purpose = 'chat') {
    const llm = this.cfg.llm;
    const map = llm.models || {};
    return map[purpose] || map.default || llm.model;
  }

  /**
   * 蒸馏（学习总结、相处总结）只认 llm.background.model 一个模型：
   * 接口地址/密钥留空就跟主接口共用（同一个中转、同一把 key）。失败由 #request 退回主模型。
   */
  #backgroundEndpoint() {
    const llm = this.cfg.llm || {};
    const bg = llm.background || {};
    if (!bg.model && !bg.baseUrl) return null;
    const base = String(bg.baseUrl || llm.baseUrl || '').replace(/\/+$/, '');
    if (!base) return null;
    const key = bg.apiKey || (bg.keyEnv ? process.env[bg.keyEnv] : '') || apiKeyOf(this.cfg);
    if (!key) return null;
    return { baseUrl: base, model: bg.model || this.modelFor('background'), key, fallback: false };
  }

  async #request(extra, signal, purpose = 'chat') {
    // 后台档优先用便宜端点；它挂了就退回主端点重来一次
    if (purpose === 'background') {
      const bg = this.#backgroundEndpoint();
      if (bg) {
        try {
          return await this.#requestOnce(extra, signal, purpose, bg);
        } catch (err) {
          this.log?.warn?.(`后台模型（${bg.model}）失败，退回主模型：${err.message}`);
        }
      }
    }
    return this.#requestOnce(extra, signal, purpose, null);
  }

  async #requestOnce(extra, signal, purpose, bg) {
    const { baseUrl, temperature, maxTokens, timeoutMs } = this.cfg.llm;
    // 按用途分开给温度：聊天要疯（抽象/胡话），决策要稳（工具调用不能飘），后台够用就行
    const temp = this.cfg.llm.temperatures?.[purpose] ?? temperature;
    // extra.model：个别任务（生图副脑）可以点名要某个模型，不影响聊天主模型
    const wanted = extra?.model;
    const { model: _wanted, ...body } = extra || {};
    const model = wanted || (bg ? bg.model : this.modelFor(purpose));
    const key = bg ? bg.key : apiKeyOf(this.cfg);
    const base = bg ? bg.baseUrl : baseUrl;
    if (!key) {
      throw new Error(
        `没有可用的模型 API Key：请设置环境变量 ${this.cfg.llm.apiKeyEnv || 'DEEPSEEK_API_KEY'}，` +
          '或在 config.json 的 llm.apiKey 里填写，或把 llm.mode 改成 echo 先跑通链路',
      );
    }
    const url = `${String(base).replace(/\/+$/, '')}/chat/completions`;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({
            model,
            temperature: temp,
            max_tokens: maxTokens,
            stream: false,
            ...body,
          }),
          signal: ac.signal,
        });
        const bodyText = await res.text();
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`模型接口 ${res.status}：${bodyText.slice(0, 200)}`);
          await sleep(600 * attempt);
          continue;
        }
        if (!res.ok) throw new Error(`模型接口 ${res.status}：${bodyText.slice(0, 300)}`);
        const json = JSON.parse(bodyText);
        const message = json?.choices?.[0]?.message;
        if (!message) throw new Error(`模型返回里没有 message：${bodyText.slice(0, 200)}`);
        return message;
      } catch (err) {
        lastErr = err;
        if (ac.signal.aborted) break;
        await sleep(400 * attempt);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr ?? new Error('模型调用失败');
  }
}
