/**
 * 化用（造梗）辅助：先让模型按「换主体 / 拆字换音」列几条候选，
 * 再把这些候选丢回主流程当参考——比让它临场想起来稳。
 */
const SYSTEM = `你是中文「化用」高手：把听来的梗换个主体或拆个字，搬到眼前这件事上。不是往句子里塞流行语。

只有两种合格手法：
1. 换主体：保留原梗的句式，把对象换成对话里的人或事。
   例：原梗「老实赚钱很枯燥吧」→ 场景里的小明在加班 → 「老实上班很枯燥吧」。
2. 拆字换音：拿对话里的词拆开重组。
   例：对话里正在聊「哈基米」时才可以联想到「扔水里看米哈游」；不凭空引入别的游戏或作品。

不合格（不要写）：
- 直接把「破防了 / 下次一定 / 抽象 / 绝了 / 蚌埠住了」当词插进去；
- 只是复述对方说的话再加个语气词；
- 解释自己在用梗。

输出最多 3 行，每行：化用句 ||| 换的是哪个梗（原梗原句）
必须贴正在聊的同一件事；不硬跨作品、不逐项点评表情图、不把普通求助当玩笑。没有自然候选就输出空白，宁缺毋滥；不规定谐音数量、不为凑三行硬造。`;

/** 从一段话里挑出可能有梗味的词（2~4 字，中日韩字符，去掉标点） */
export function pickKeywords(texts, { limit = 6 } = {}) {
  const out = [];
  const seen = new Set();
  for (const t of [].concat(texts || [])) {
    const s = String(t || '');
    // 抓 2~4 字的连续汉字块
    for (const m of s.matchAll(/[\u4e00-\u9fa5]{2,4}/g)) {
      const w = m[0];
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** 解析「化用句 ||| 学的是哪个梗」 */
export function parseCandidates(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    const t = line.replace(/^[\s\-*\d.、]+/, '').trim();
    if (!t) continue;
    const parts = t.split(/\s*\|\|\|\s*|\s*\|\s*/);
    const said = (parts[0] || '').trim();
    const basedOn = (parts[1] || '').trim();
    if (!said || said.length < 4 || said.length > 80) continue;
    rows.push({ said, basedOn });
    if (rows.length >= 4) break;
  }
  return rows;
}

/** 让模型列候选；失败返回空数组，绝不阻塞主流程 */
export async function riffCandidates({ brain, scene, memes = [], limit = 3 } = {}) {
  if (!brain?.complete) return [];
  const sceneText = [].concat(scene || []).join('\n').slice(0, 800);
  if (!sceneText.trim()) return [];
  const memeText = memes.slice(0, 8).map((m) => `- ${m.name}：${(m.meaning || '').slice(0, 30)}${m.example ? `（例：${m.example.slice(0, 30)}）` : ''}`).join('\n');
  try {
    const text = await brain.complete({
      system: SYSTEM,
      purpose: 'background',
      prompt: `群聊：\n${sceneText}\n\n参考梗（学句式，不是抄词）：\n${memeText || '（暂无）'}`,
      maxChars: 400,
      signal: AbortSignal.timeout(25000),
    });
    return parseCandidates(text).slice(0, limit);
  } catch {
    return [];
  }
}
