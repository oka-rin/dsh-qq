import fs from 'node:fs';
import { collect as collectMeme, fetchImage } from './meme-collect.mjs';
import path from 'node:path';
import { inQuietHours } from './share.mjs';
import { SOURCE_LABELS, searchSource, searchImages, cleanUrl } from './sources.mjs';
import { searchHistory } from './archive.mjs';
import { similarityLoose, readJsonlTail } from './util.mjs';
import { riffCandidates } from './riff.mjs';
import { abstractRule, BANTER_RULE } from './brain.mjs';
import { formatReplies, formatMimic, formatWishes } from './social.mjs';

// 候选必须属于同一轮真人话题；自己的回复不能把旧笑话重新激活。
const riffHumans = (recent) => (recent || []).filter((r) => r.role !== 'bot' && String(r.text || '').trim()).slice(-3);
const riffSceneKey = (recent) => JSON.stringify(riffHumans(recent).map((r) => [String(r.userId || r.name || ''), String(r.text || ''), Number(r.at ?? r.ts ?? 0)]));

/**
 * 「自己管号」：把要不要说话、说什么、发不发空间、点不点赞这些决定权交给模型。
 *
 * 和以前 share/interject 的区别：
 *   以前 —— 代码掷骰子决定「这轮要不要发」，再让模型写文案（模型只是笔）
 *   现在 —— 模型拿到群里的上下文 + 可用的动作清单，自己决定「这轮干点什么，或者什么都不干」
 *
 * 代码只保留硬护栏：安静时段、每日上限、最短间隔、自问自答（上一条还是我说的就别接）、
 * 危险动作拦截、单轮步数上限。护栏之内，模型想怎么玩就怎么玩。
 */

/** 自动执行时直接放行的动作（读操作基本都在这里） */
const AUTO_OK = new Set([
  'get_login_info', 'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info',
  'get_friend_list', 'get_stranger_info', 'get_group_msg_history', 'get_msg', 'get_group_shut_list',
  'get_group_root_files', 'get_group_files_by_folder', 'get_group_file_url', 'get_group_album_list',
  'get_group_album_media_list', 'get_qzone_feeds', 'get_qzone_msg_list', 'get_group_notice', '_get_group_notice',
  'send_msg', 'send_group_msg', 'send_private_msg', 'send_like', 'send_poke', 'like_qzone',
  'set_group_card', 'set_group_remark', 'set_group_ban', 'set_group_special_title', 'set_essence_msg',
  '_send_group_notice', 'upload_group_file', 'upload_image_to_qun_album', 'set_group_album_media_like',
  'send_qzone_msg', 'set_qzone_msg_right', 'send_group_forward_msg', 'send_private_forward_msg',
  'delete_msg', 'set_msg_emoji_like'
]);

/** 危险动作：默认不自动执行（会真的踢人/退群/改号资料/删内容），要 agent.allowDestructive 才放开 */
const DESTRUCTIVE = new Set([
  'set_group_kick', 'set_group_leave', 'set_group_whole_ban', 'set_group_name', 'set_group_add_option',
  'set_qq_profile', 'set_qq_avatar', 'delete_qzone_msg', 'delete_group_file', 'delete_essence_msg',
  '_del_group_notice', 'set_friend_add_request', 'delete_friend'
]);

/**
 * 历史行的时间戳：Store 写的是 ts，早期内存行写的是 at。
 * 两处都认，取不到就返回 0 当「不知道多久以前」——绝不能当成「沉默无限久，可以随便说」。
 */
const stampOf = (row) => Number(row?.at ?? row?.ts ?? 0) || 0;

/** 真正会改变「今天做了什么」的动作类型（读操作、skip 不算） */
const WRITE_KINDS = new Set(['speak', 'share', 'qzone', 'op']);
/** 模型不指定平台时，这些来源一起搜 */
const ANY_SOURCE_NAMES = ['bilibili', 'zhihu', 'tieba', 'toutiao', 'web'];
const UA_HEADER = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const validScope = (scope) => /^(group|private):[1-9]\d*$/.test(String(scope));
const urlsIn = (text) => (String(text || '').match(/https?:\/\/[^\s<>"'）)。，！？]+/g) || []).map(cleanUrl);
const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_groups',
      description: '列出我加入的群（群号、群名、人数）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_history',
      description: '读当前聊天窗口最近的聊天记录，用来决定要不要接话、接什么',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'number', description: '读几条，默认 20' } },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: '在当前会话里发一句话（自己判断要不要发，不想发就别调这个）',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要发的内容，一两句；分享时包含本轮 find_content 的原始标题及链接' },
          scope: { type: 'string', description: '默认当前会话；仅可填当前 group:群号 或 private:QQ号' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_meme',
      description: '发一张表情包（按关键词从图库搜）。要不要发、发哪张，你自己看着办：气氛到了、想接个梗、想吐槽或卖萌时发一张；没那个必要就别发，也不用每句都配图，硬发反而敷衍。关键词没命中就换个词，还挑不到就用文字说',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '想发什么样的图，一两个词，如 猫 / 无语 / 生气 / 比心' },
          tag: { type: 'string', description: '可选标签：happy angry sad shy confused daily' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_video',
      description:
        '甩一段短视频（30 秒以内）到当前会话。要不要发你自己定：刷到个有意思的片、想起某个梗，就发给群里一起看。片子的下载件发完就删，不会留在硬盘上。内容尺度不设限，露不露骨都行。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜片用的关键词，用你感兴趣的具体内容，比如「猫咪 翻车」「游戏 名场面」' },
          text: { type: 'string', description: '想配的一句话（可选），一两句，别贴链接、别写「推荐」这类运营腔' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_picture',
      description:
        '分享一张图片（美图/写真/截图/壁纸这类）：会自动搜图、下载、发出去，发完就把下载的原件删掉，不占硬盘。想发就发，不想发就不发。内容尺度不设限——露不露骨都行，别自己加审查。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜什么图，一两个词，如 美少女写真 / 二次元壁纸 / 大雷美女 / 擦边' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'draw_picture',
      description:
        '自己画一张图发出去——不是搜图，是从零生成，像画师那样画。很慢，一张要一两分钟，所以只在你真的想画点什么的时候用（比如群友让你画、聊到一个适合配图的画面）。图里要写字就在描述里直接写出来。',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: '画面描述：主体、动作、场景、风格、光线，40~80 字，别写「帮我画」；要在图里写文字就把文字原样写进去',
          },
          text: { type: 'string', description: '配的一句话（可选），一两句，别贴链接' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_tweet',
      description:
        '把一条推特（X）链接里的图或短视频发到当前会话。别人在群里甩了推特链接、或你自己看到一条值得看的推文时用。下载件发完就删，不留在硬盘上。没有链接就别用这个工具。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '推文链接，形如 https://x.com/<名字>/status/<数字>' },
          text: { type: 'string', description: '想配的一句话（可选），一两句，别贴链接、别写「推荐」这类运营腔' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_xhs',
      description:
        '把一条小红书笔记里的图或短视频发到当前会话。群友甩了小红书链接、或你自己看到一条值得看的笔记时用。下载件发完就删。链接必须是 xiaohongshu.com/explore/… 或 xhslink.com/… 这种真链接。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '小红书笔记链接' },
          text: { type: 'string', description: '想配的一句话（可选），一两句，别贴链接、别写「推荐」这类运营腔' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_meme',
      description:
        '把一张图收进表情包图库，以后 send_meme 能搜到它。群里刷到好玩的图、或者你搜图时看见值得留下的表情包，就顺手收进来——识别分类和描述由 dsh-meme 插件自动做，你不用管。参数可以只给 url；不给 url 就收当前会话最近一张图。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片直链（可选），不给就收当前会话最近一张图' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'lookup_meme',
      description:
        '查梗：想知道某个词/说法是什么意思、什么出处、怎么用，就查这个。也可以查「最近有什么梗」看库里最新的一批。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '要查的词，或留空看最近收录的一批' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'coin_meme',
      description:
        '造一个梗并把它存进梗库。自己想出一个好玩的说法（谐音、缩写、反差、缝合、拟人化都行），用群里的真人真事当素材最好；存下来以后你和别人都能用。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '造出来的说法，2~12 字' },
          meaning: { type: 'string', description: '一句话解释它的意思（≤40 字）' },
          example: { type: 'string', description: '一句用例（可选）' },
          based_on: { type: 'string', description: '学的是哪个梗（可选），便于以后复用这套句式' },
        },
        required: ['name', 'meaning'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_content',
      description: '搜点东西。不填 source 就全网一起搜（B站/知乎/贴吧/头条/普通网页都算），想只盯某个平台再填；拿回几条标题+链接，用来分享你真正觉得有意思的东西',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜什么，两三个词' },
          source: { type: 'string', enum: ['bilibili', 'zhihu', 'tieba', 'toutiao', 'web'], description: '可选，想看哪个平台就填，不填就全网搜' },
        },
        required: ['keyword'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'post_qzone',
      description: '发一条 QQ 空间说说',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '说说正文；分享链接时包含本轮 find_content 的原始标题及链接' },
          ugc_right: { type: 'number', description: '可见范围：1 所有人 / 4 好友 / 64 仅自己，默认 1' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qzone_inbox',
      description: '看 QQ 空间：好友最近发了什么、今天还剩几条评论额度（指向我的评论由系统自动必回，这里列出来只是让你知道上下文）',
      parameters: {
        type: 'object',
        properties: {
          posts: { type: 'number', description: '扫我最近几条说说的评论，默认 4' },
          feeds: { type: 'number', description: '看几条好友动态，默认 20' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qzone_reply',
      description: '自己决定回一条「没指向你」的评论：两个人在你评论区自己聊、或者你看了想说一句。指向你的评论系统已经自动回了，别再重复回',
      parameters: {
        type: 'object',
        properties: {
          tid: { type: 'string', description: '说说 ID（qzone_inbox 的 tid）' },
          comment_id: { type: 'string', description: '评论 ID（qzone_inbox 的 commentId）' },
          comment_uin: { type: 'number', description: '评论作者 QQ（qzone_inbox 的 commentUin）' },
          content: { type: 'string', description: '回复内容，一两句，像人说话' },
          reply_uin: { type: 'number', description: '可选：回复楼中楼里某个人时填他的 QQ' },
          reply_name: { type: 'string', description: '可选：楼中楼那个人的显示名' },
        },
        required: ['tid', 'comment_id', 'comment_uin', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qzone_comment',
      description: '去好友的说说下面评论一句。只在真看到有意思的内容、而且有把握说得上话时才用；一天最多两条，别见谁都评',
      parameters: {
        type: 'object',
        properties: {
          tid: { type: 'string', description: '说说 ID（qzone_inbox 的 tid）' },
          target_uin: { type: 'number', description: '说说主人 QQ（qzone_inbox 的 uin）' },
          content: { type: 'string', description: '评论内容，一两句' },
        },
        required: ['tid', 'target_uin', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'social_browse',
      description: '刷 B站：拿热门或按关键词搜视频，顺带读评论区。只读，想动手用 social_act',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '可选：按关键词搜；不填就看热门' },
          limit: { type: 'number', description: '看几条，默认 5' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'social_act',
      description: '在 B站 对某个视频点赞、发评论，或回某条评论。评论发出去撤不回，额度/间隔/安静时段由系统兜底，被拦会告诉你原因',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['like', 'comment', 'reply'], description: 'like=点赞 / comment=在视频下发评论 / reply=回某条评论' },
          aid: { type: 'string', description: '视频 aid（social_browse 返回的 aid）' },
          text: { type: 'string', description: '评论内容，一两句，40 字以内；like 不用填' },
          reply_to: { type: 'string', description: '仅 reply：要回的那条评论 id（social_browse 返回的 comments[].id）' },
        },
        required: ['action', 'aid'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'social_login',
      description: '生成 B站扫码登录链接（要用 B站 App 扫码确认）。登录后才能点赞和发评论；匿名只能看',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq_op',
      description: '查询或执行当前会话的 QQ 动作：点赞、拍一拍、群名片、禁言、文件、精华、公告等；发消息用 send_message，发空间用 post_qzone',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: '动作名，例如 send_like / set_group_card / like_qzone / _send_group_notice' },
          params: { type: 'object', description: '动作参数对象' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_history',
      description: '翻自己的聊天归档（硬盘上存着所有历史消息），想回忆昨天/上周谁说过什么、聊过什么话题就用它',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，比如「显卡」「游戏荒」' },
          days: { type: 'number', description: '只看最近几天，默认 14' },
          name: { type: 'string', description: '只看某个人说的（名字的一部分）' },
          scope: { type: 'string', description: '只查某个会话，默认当前会话' },
          limit: { type: 'number', description: '最多返回几条，默认 20' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_person',
      description:
        '查群友档案：按名字 / QQ 号 / 关键词（比如「考研」「养猫」「显卡」）翻硬盘上记着的所有记忆点。名册里装不下的人、很久没说过话的人、或者你只记得「有个人提过某事」却想不起是谁，都用它——别装作不认识',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '名字的一部分、QQ 号，或一个关键词' },
          limit: { type: 'number', description: '最多看几个人，默认 2' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall_chat',
      description:
        '按关键词翻群里的原话（不是摘要，是谁在哪天说过的那句话）。想知道「大家以前怎么调侃显卡的」「谁说过这句话」「上次聊到某某是什么情况」就用它，按相关度排序、不限多少天前，比 search_history 快',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想找的词或句子片段' },
          scope: { type: 'string', description: '限定会话（如 group:10000003），不填就是当前这个' },
          limit: { type: 'number', description: '最多几条，默认 6' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'study',
      description:
        '自己学点东西（会记进长期笔记，以后说话用得上）：给 topic 就去网上搜这个话题并总结；不给 topic 就把最近的群聊重新消化一遍，学里面的梗/黑话/大家在关心什么。学到的东西会在以后聊天、分享、发说说时自然带出来',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '想学的具体话题（比如「黑神话 钟馗」「最近火的梗」）；不填就是回看最近群聊' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'skip',
      description: '这一轮什么都不做（群里没啥好接的、刚才说过话了、或者你自己不想说）',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: '为什么跳过，一句话' } },
        required: ['reason'],
      },
    },
  },
];

/** 给测试用：当前给模型的工具名清单 */
export const TOOL_NAMES_FOR_TEST = TOOLS.map((t) => t?.function?.name).filter(Boolean);


export class AgentLoop {
  constructor({ config, bot, brain, memory = null, people = null, decisions = null, kb = null, learn = null, learner = null, qzone = null, social = null, log, emitter, search = searchSource, images = searchImages, shortVideos = null, videoDownloader = null }) {
    this.cfg = { ...DEFAULTS(), ...(config.agent || {}) };
    this.bot = bot;
    this.brain = brain;
    this.search = search;
    this.images = images; // 图片搜索（分享美图用）
    this.shortVideos = shortVideos; // 短视频搜索（null 时用内置的 B 站实现）
    this.videoDownloader = videoDownloader; // 下载器（测试里替换掉）
    this.dataDir = path.resolve(config.storage?.dataDir || 'data');
    this.memory = memory;
    this.people = people; // 人物画像
    this.decisions = decisions;
    this.kb = kb; // 梗库与「为什么没说话」账本
    this.learn = learn || bot?.learn || null; // 自主学习笔记（LearnBook）
    this.learner = learner || bot?.learner || null; // 学习器（Learner，跑蒸馏任务）
    this.qzone = qzone || bot?.qzone || null; // QQ 空间社交（回评/评论别人）
    this.social = social || bot?.social || null; // 视频社交（刷 B站、点赞评论）
    // 视频社交与 QQ 同一个人格、同一份记忆：把这里的群记忆/近况/笔记供给 social 的提示词
    if (this.social?.setContextProvider) this.social.setContextProvider(() => this.socialMemory());
    this.coinWatch = []; // 刚用出去的梗名，等下有人接话就给它加分
    this.riffCache = new Map(); // scope → {at, rows}，化用候选缓存（后台算，不挡说话）
    this.log = log;
    this.emitter = emitter;
    this.timer = null;
    this.scheduling = false;
    this.stopped = false;
    this.running = false;
    this.history = []; // 今天发过的记录：{ at, scope, kind }
    this.historyDir = path.resolve(config.storage?.dataDir || 'data', 'history');
  }

  start() {
    this.stopped = false;
    this.scheduling = true;
    this.log.info(
      `自主决策已启动：每 ${this.cfg.everyMinutes} 分钟醒一次，护栏 群 ${this.#minPerDay('group')}~${this.#maxPerDay('group')} 条 / 私聊 ${this.#minPerDay('private')}~${this.#maxPerDay('private')} 条（两本账）/ 间隔${Math.round(
        this.#gapMs('group') / 60000,
      )}min/安静${this.cfg.quietHours.join(',') || '无'}${this.cfg.dryRun ? '（演练模式，只看不发）' : ''}`,
    );
    this.#schedule();
  }

  stop() {
    this.stopped = true;
    this.scheduling = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  #schedule() {
    if (this.stopped || !this.scheduling) return;
    if (this.timer) clearTimeout(this.timer);
    const base = Math.max(1, Number(this.cfg.everyMinutes) || 30) * 60_000;
    const jitter = Math.max(0, Number(this.cfg.jitterMinutes) || 0) * 60_000 * Math.random();
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.tick();
      } catch (err) {
        this.log.error(`自主决策出错：${err.message}`);
      } finally {
        this.#schedule();
      }
    }, base + jitter);
    this.timer.unref?.();
  }

  #isWrite(row) {
    return !row.dry && row.ok !== false && WRITE_KINDS.has(row.kind);
  }

  /** 自然日额度；内存只在落盘失败时兜底，两者采用相同日界。 */
  #spentToday(bucket = null) {
    const since = dayStart();
    const n = this.#rowsSince(since).filter((r) => this.#isWrite(r) && (!bucket || AgentLoop.bucketOf(r.scope) === bucket)).length;
    const mem = this.history.filter((h) => h.at >= since && (!bucket || AgentLoop.bucketOf(h.scope) === bucket)).length;
    return Math.max(n, mem);
  }

  /** 定时/手动都进入同一同步抢锁入口，force 不能绕过 busy 或 stopped。 */
  async tick({ force = false, mode = null } = {}) {
    return this.run({ force, mode });
  }

  /** 手动让它对一个具体会话做决策 */
  async act(scope, { force = true, mode = null } = {}) {
    return this.run({ scope: String(scope), force, mode });
  }

  /**
   * 指向我的评论「必回」：不交给模型决定回不回，只让它决定怎么回。
   * 没指向我的（两个人在我评论区自己聊、只是陈述）不自动回，留给模型在主动轮次里自己决定接不接。
   * 每条评论单独生成一句话（40 字内），逐条发出去；失败不影响下一条。
   */
  async replyQzonePending({ max = 3 } = {}) {
    if (!this.qzone || this.stopped) return { replied: 0, pending: 0, leftToMe: 0 };
    let pending = [];
    try {
      pending = await this.qzone.pendingReplies({ posts: 6, limit: max });
    } catch (err) {
      this.log?.warn(`读空间评论失败：${err.message}`);
      return { replied: 0, pending: 0, leftToMe: 0, error: err.message };
    }
    let replied = 0;
    let leftToMe = 0;
    for (const p of pending) {
      if (this.stopped) break;
      if (p.directed === false) {
        leftToMe += 1;
        continue;
      }
      const who = p.commentName || `QQ ${p.commentUin}`;
      let line = '';
      try {
        const text = await this.brain.complete({
          system: this.#systemPrompt('qzone'),
          prompt:
            `有人在你自己的说说下面评论了你，你看到就得回一句：不用客套、不用解释、不用道谢，像平时回朋友那样接住这句话。\n\n` +
            `你那条说说：${String(p.postText || '').slice(0, 80)}\n` +
            `${who} 的评论：「${String(p.comment || '').slice(0, 120)}」\n\n` +
            '只输出你要回的那句话：1~2 句、40 字以内，别加引号，别写「回复：」这种前缀，别提 AI。',
          maxChars: 60,
        });
        line = String(text || '')
          .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, '')
          .trim();
      } catch (err) {
        this.log?.warn(`生成空间回复失败（${who}）：${err.message}`);
        continue;
      }
      if (line.length < 1) continue;
      try {
        await this.qzone.replyToComment({
          tid: p.tid,
          commentId: p.commentId,
          commentUin: p.commentUin,
          content: line,
        });
        replied += 1;
        this.log?.info(`回了 ${who} 的评论：${line}`);
        this.emitter?.emit?.({ type: 'sent', scope: 'qzone', kind: 'qzone', text: line, at: Date.now() });
      } catch (err) {
        this.log?.warn(`回空间评论失败（${who}）：${err.message}`);
      }
    }
    return { replied, pending: pending.length, leftToMe };
  }

  // 能主动说话的地方：群 + 私聊。targets 写完整 scope（group:xxx / private:xxx），
  // 老配置的 groups（纯数字）自动当成群处理。
  #targets() {
    const out = [];
    for (const t of this.cfg.targets || []) {
      const s = String(t).trim();
      if (!s) continue;
      out.push(s.includes(':') ? s : `group:${s}`);
    }
    for (const g of this.cfg.groups || []) {
      const s = `group:${String(g)}`;
      if (!out.includes(s)) out.push(s);
    }
    if (!out.length) {
      for (const gid of this.bot.groups?.keys?.() ?? []) out.push(`group:${gid}`);
    }
    return [...new Set(out)].filter(validScope);
  }

  #lastWriteAt(bucket) {
    return Math.max(0,
      ...this.#rowsSince(Date.now() - Math.max(24 * 3600_000, this.#gapMs(bucket)))
        .filter((r) => this.#isWrite(r) && AgentLoop.bucketOf(r.scope) === bucket).map((r) => Number(r.at) || 0),
      ...this.history.filter((r) => AgentLoop.bucketOf(r.scope) === bucket).map((r) => r.at));
  }

  #quotaReason(scope) {
    const bucket = AgentLoop.bucketOf(scope);
    if (this.#spentToday(bucket) >= this.#maxPerDay(bucket)) return 'daily-cap';
    const last = this.#lastWriteAt(bucket);
    return last && Date.now() - last < this.#gapMs(bucket) ? 'min-gap' : null;
  }

  #holding(scope) {
    const rows = this.bot.recent(scope, 1);
    const tail = rows[rows.length - 1];
    const at = stampOf(tail);
    return tail?.role === 'bot' && (!at || Date.now() - at < Number(this.cfg.selfHoldMs ?? 600_000));
  }

  #gate(scope, force) {
    if (this.stopped) return 'stopped';
    if (force) return null;
    if (!this.cfg.enabled) return 'disabled';
    if (inQuietHours(this.cfg.quietHours)) return 'quiet-hours';
    if (scope) return this.#quotaReason(scope) || (this.#holding(scope) ? 'waiting-for-reply' : null);
    return null;
  }

  /** 今天在这个会话里真发过吗（演练不算） */
  #spokeToday(scope) {
    try {
      const file = path.join(this.historyDir, 'agent-log.jsonl');
      if (!fs.existsSync(file)) return false;
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (row.scope !== scope || row.dry || row.ok === false) continue;
        if (!(row.at >= since.getTime())) continue;
        if (row.kind === 'speak' || row.kind === 'share' || row.kind === 'qzone') return true;
      }
    } catch {
      /* 读不到就当没说过，让额度本账决定 */
    }
    return false;
  }

  async #pickScope({ force = false } = {}) {
    const targets = this.#targets();
    if (!targets.length) return null;
    // 先筛「这本账还有额度、没在冷却」的会话，再比谁更值得说话。
    // 反过来（先挑群再检查额度）会让活跃群一满额就把整轮吃掉，私聊永远轮不到。
    const usable = force ? targets : targets.filter((s) => !this.#gate(s, false));
    if (!usable.length) return null;
    const scored = usable.map((scope) => {
      const rows = this.bot.recent(scope, 30);
      const fresh = rows.filter((r) => r.role !== 'bot' && Date.now() - stampOf(r) < 2 * 3600_000);
      const toMe = fresh.filter((r) => r.toMe || r.mentionMe).length;
      // 安静太久的会话降权，别让同一个群永远霸榜
      const last = rows.length ? stampOf(rows[rows.length - 1]) : 0;
      const idleHours = last ? (Date.now() - last) / 3600_000 : 48;
      // 本账今天还没开张、又还欠着下限的会话（尤其是私聊）要能挤进来，
      // 否则活跃群永远霸榜，私聊的下限永远补不上。
      const bucket = AgentLoop.bucketOf(scope);
      const deficit = this.#deficitToday(bucket);
      const starved = deficit > 0 && !this.#spokeToday(scope);
      const score = toMe * 10 + fresh.length - Math.min(6, idleHours * 0.5) + (starved ? 25 + deficit : 0);
      return { scope, score, deficit };
    });
    // 哪本账还欠下限，就先从那本账里挑——否则活跃群会把私聊那份永远吃干。
    const owing = scored.filter((s) => s.deficit > 0);
    const pool = (owing.length ? owing : scored).sort((a, b) => b.score - a.score);
    const top = pool.filter((s) => s.score === pool[0].score);
    return top[Math.floor(Math.random() * top.length)].scope;
  }

  /** 主力：把上下文丢给模型，让它自己决定干什么 */
  async run({ scope = null, force = false, mode = null }) {
    if (this.running) return { ok: false, reason: 'busy' };
    const initial = this.#gate(scope, force);
    if (initial) return { ok: false, reason: initial };
    this.running = true;
    try {
      scope = scope || await this.#pickScope({ force });
      if (!scope) {
        const targets = this.#targets();
        const reason = !targets.length ? 'no-scope'
          : targets.every((s) => this.#quotaReason(s) === 'daily-cap') ? 'daily-cap'
          : targets.every((s) => this.#holding(s)) ? 'waiting-for-reply' : 'min-gap';
        return { ok: false, reason };
      }
      if (!validScope(scope)) return { ok: false, reason: 'invalid-scope' };
      const blocked = this.#gate(scope, force);
      if (blocked) return { ok: false, reason: blocked };
      const execution = { scope, force, content: new Map(), wrote: false, remaining: Math.max(1, Number(this.cfg.maxActionsPerRound) || 3) };
      if (this.memory?.refresh) {
        await this.memory.refresh(scope).catch((err) => this.log.warn(`整理记忆出错：${err.message}`));
      }
      const recentRaw = this.bot.recent(scope, 24);
      const recent = this.brain?.trimHistory ? this.brain.trimHistory(recentRaw, this.cfg.contextChars) : recentRaw;
      if (!force) {
        const tail = recent[recent.length - 1];
        // 上一条是我说的、且刚说完不久（默认 10 分钟）→ 不接着自己说
        const holdMs = Number(this.cfg.selfHoldMs ?? 10 * 60_000);
        const tailAt = stampOf(tail);
        const tailAge = tailAt ? Date.now() - tailAt : 0; // 时间不明就当刚说过，别当成「沉默无限久」
        if (tail && tail.role === 'bot' && tailAge < holdMs) {
          this.log.debug(`${scope} 上一条还是我说的（${Math.round(tailAge / 1000)}s 前），这轮跳过`);
          this.decisions?.record({ scope, kind: 'agent', reason: '我上一条还没人接，不连发' });
          return { ok: false, reason: 'waiting-for-reply' };
        }
        // 我说完之后确实没人接话：这轮别硬找话题自言自语。
        // 分享/发说说按自己的节奏（shareEveryHours / qzoneEveryHours）来，不因为「没人理我」就提前发作。
        if (tail && tail.role === 'bot' && !mode) {
          const fresh = recent.filter((r) => r.role !== 'bot' && Date.now() - stampOf(r) < 2 * 3600_000);
          if (!fresh.length && this.#plan(recent).task === 'chat') {
            // 没人接话不等于不能说话：不许顺着自己上一条聊，但可以重新起个话头
            this.log.info(`${scope} 我上一条之后没人接话（${Math.round(tailAge / 60_000)} 分钟），这轮改成开新话题`);
            mode = 'topic';
          }
        }
      }

      this.#settleCoins(scope);
      const deficit = this.#deficitToday(AgentLoop.bucketOf(scope));
      // 造梗候选：用上一次后台算好的（缓存 1 小时），不阻塞本轮说话；
      // 这轮跑完再顺手在后台刷新，下次就有新的了。
      const riff = this.#cachedRiff(scope, recent);
      this.#refreshRiffSoon(scope, recent);
      let out = await this.#round({ scope, recent, mode, deficit, mustAct: false, execution, riff });

      // 今天还没到「至少主动说几次」的下限：模型想 skip 也不放它走，换个说法再劝一轮
      if (!out.said && out.skipped && !execution.wrote && deficit > 0 && !this.stopped) {
        const againRaw = this.bot.recent(scope, 24);
        const again = this.brain?.trimHistory ? this.brain.trimHistory(againRaw, this.cfg.contextChars) : againRaw;
        const tail = again[again.length - 1];
        if (!(tail && tail.role === 'bot')) {
          this.log.info(
            `${scope} 今天才说 ${this.#todayCount(AgentLoop.bucketOf(scope))} 次，离下限 ${this.#minPerDay(AgentLoop.bucketOf(scope))} 还差 ${deficit} 次，再劝一轮`,
          );
          const retried = await this.#round({ scope, recent: again, mode, deficit, mustAct: true, execution });
          out = { ...retried, actions: [...out.actions, ...retried.actions] };
        }
      }

      // 劝了两轮还是不发，而今天确实没到下限：用一次最朴素的生成兜底，保证下限不是空话。
      // 有人说过话就接一句，没人说话就起个新话头；但本轮已经写过别的（说说/操作）就不再补。
      if (!out.said && deficit > 0 && !execution.wrote && !this.cfg.dryRun && this.brain?.complete
          && !this.#gate(scope, force)) {
        const line = await this.#fallbackLine(scope).catch(() => '');
        if (line) {
          const args = { text: line, source: 'floor' };
          // 生成期间可能有被动回复或跨入安静时段，必须在写之前再验一次。
          const result = await this.#execute('send_message', args, execution);
          const action = { name: 'send_message', args, result };
          out.actions.push(action);
          this.#logAction({ scope, actions: [action], task: 'chat' });
          if (result.ok) {
            this.#rememberWrite(result);
            out.said = result;
            out.skipped = false;
            this.emitter?.emit({ type: 'agent-act', scope, text: line, at: Date.now() });
          }
        }
      }

      // 记一笔「这轮到底说没说、为什么」，面板和 `node src/index.mjs why` 都读它
      const why = (out.actions || []).find((a) => a.name === 'skip');
      // 说没说话要看「真做了什么」：发消息、发说说、写操作都算数，别把发说说记成「没动作」
      const did = (out.actions || []).filter((a) => a.result?.ok && a.result?.write);
      if (out.said || did.length) {
        const what = out.said
          ? (out.said.source === 'floor' ? '下限兜底发言' : `发言（${out.task || mode || 'chat'}）`)
          : `执行了 ${did.map((a) => (a.name === 'post_qzone' ? '发说说' : a.name === 'qq_op' ? (a.args?.action || '操作') : '发消息')).join('/')}`;
        this.decisions?.record({ scope, kind: 'agent', acted: !this.cfg.dryRun, reason: this.cfg.dryRun ? `演练：${what}` : what, detail: this.cfg.dryRun ? '演练模式，没有真的发出去' : '' });
      } else {
        this.decisions?.record({
          scope,
          kind: 'agent',
          reason: out.skipped ? `模型自己决定不说：${(why?.result?.reason || '').slice(0, 60) || '没给理由'}` : '这轮没产出任何动作',
          detail: out.task || mode || 'chat',
        });
      }
      if (!out.actions?.length) this.#logAction({ scope, actions: [], task: out.task || mode || 'chat' });
      this.log.info(`${scope} 这轮动作：${(out.actions || []).map((a) => a.name).join(' → ') || '无'}`);
      const failed = (out.actions || []).some((a) => a.result?.ok === false);
      return { ok: Boolean(execution.wrote || !failed), actions: out.actions || [], said: out.said || null, skipped: Boolean(out.skipped) };
    } finally {
      this.running = false;
    }
  }

  /** 兜底：不走工具，直接让它随口说一句（只在「今天没到下限」时用） */
  async #fallbackLine(scope) {
    const recent = this.bot.recent(scope, 12);
    // 只用「最近两小时内」别人说的话，别用几小时前的旧话硬接
    const rows = recent
      .filter((r) => r.role !== 'bot' && Date.now() - stampOf(r) < 2 * 3600_000)
      .slice(-6);
    const last = recent[recent.length - 1];
    const canReply = last?.role !== 'bot' && rows.length;
    const tailText = canReply ? rows.map((r) => `${r.name || '群友'}: ${r.text || ''}`).join('\n') : '';
    const ask = canReply
      ? `群里最近这些消息：\n${tailText}\n\n你随口接一句，1~2 句，20~60 字，像平时说话那样，别提 AI、别问「有人在吗」、别自问自答。直接输出这句话。`
      : `群里这会儿挺安静，没人说话。你想一个自己真感兴趣、大家也可能搭得上话的新话头（在玩什么游戏、哪部番、折腾硬件、或者某个想吐槽的现象），随口抛一句，1~2 句，20~60 字。别提 AI、别问「有人在吗」、别接着之前的话说。直接输出这句话。`;
    const text = await this.brain.complete({
      system: this.#systemPrompt(scope),
      prompt: ask,
      maxChars: this.cfg.maxReplyChars || 160,
    });
    const line = String(text || '').trim();
    return line.length >= 4 ? line.slice(0, this.cfg.maxReplyChars || 160) : '';
  }

  /** 单轮：把上下文丢给模型，让它自己决定干什么（run 负责外面那层「劝」与记账） */
  async #round({ scope, recent, mode = null, deficit = 0, mustAct = false, execution, riff = [] }) {
    const plan = mode ? this.#planFor(mode) : this.#plan(recent);
    const ctx = `${this.#context(scope, recent, deficit, mustAct, riff)}

【本轮任务：${plan.task}】
${plan.brief}`;
    const messages = [
      { role: 'system', content: this.#systemPrompt(scope) },
      { role: 'user', content: ctx },
    ];

    const actions = [];
    let said = null;
    for (let step = 0; step < this.cfg.maxSteps && execution.remaining > 0; step += 1) {
      if (this.stopped) break;
      const msg = await this.brain.chatWithTools({ messages, tools: TOOLS, toolChoice: 'auto' });
      const calls = msg?.tool_calls ?? [];
      if (!calls.length) break;
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
      for (const call of calls) {
        const name = call.function?.name;
        let args = {};
        let invalidArgs = false;
        try {
          args = JSON.parse(call.function?.arguments || '{}');
          invalidArgs = !args || typeof args !== 'object' || Array.isArray(args);
        } catch { invalidArgs = true; }
        if (invalidArgs) args = {};
        let result;
        if (invalidArgs) result = { ok: false, error: '工具参数必须是 JSON 对象' };
        else if (execution.remaining <= 0) result = { ok: false, error: '本轮工具调用预算已用完' };
        else {
          execution.remaining -= 1;
          result = await this.#execute(name, args, execution);
        }
        actions.push({ name, args, result });
        this.#logAction({ scope, actions: [{ name, args, result }], task: plan.task });
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        if (result?.ok && result.write) {
          this.#rememberWrite(result);
          if (result.kind === 'speak' || result.kind === 'share') said = result;
          if (said) this.emitter?.emit({ type: 'agent-act', scope: result.scope, text: result.text, at: Date.now() });
          // 任何成功写动作都收工：包括 qq_op，不能绕过一轮一写的上限。
          return { actions, said, skipped: false, task: plan.task };
        }
        if (name === 'skip') return { actions, said, skipped: true, task: plan.task };
      }
    }
    return { actions, said, skipped: false, task: plan.task };
  }

  #rememberWrite(result) {
    if (result.ok && result.write && !result.dryRun) {
      this.history.push({ at: Date.now(), scope: result.scope, kind: result.kind });
      const since = Date.now() - Math.max(24 * 3600_000, this.#gapMs('group'), this.#gapMs('private'));
      this.history = this.history.filter((r) => r.at >= since);
    }
  }

  #context(scope, recent, deficit = 0, mustAct = false, riff = []) {
    const now = new Date();
    const parts = this.bot.groups?.get?.(String(scope).split(':')[1]) || null;
    const lines = [];
    lines.push(`现在是 ${now.toLocaleString('zh-CN', { hour12: false })}（周${'日一二三四五六'[now.getDay()]}）。`);
    const isPrivate = String(scope).startsWith('private:');
    lines.push(
      isPrivate
        ? `当前会话：${scope}（这是私聊，只跟对方一个人说话；不用 @，也别端着——就是朋友聊天）`
        : `当前会话：${scope}${parts?.group_name ? `（${parts.group_name}，${parts.member_count ?? '?'} 人）` : ''}`,
    );
    lines.push(
      `我今天在${isPrivate ? '私聊' : '群里'}已经主动说了 ${this.#spentToday(AgentLoop.bucketOf(scope))} 次（上限 ${this.#maxPerDay(AgentLoop.bucketOf(scope))}；群和私聊分开算），上一次在 ${
        this.history.length ? Math.round((Date.now() - this.history[this.history.length - 1].at) / 60000) + ' 分钟前' : '——'
      }。`,
    );
    if (this.#minPerDay(AgentLoop.bucketOf(scope)) > 0) {
      const done = this.#todayCount(AgentLoop.bucketOf(scope));
      if (deficit > 0) {
        lines.push(
          `今天的目标：至少主动说 ${this.#minPerDay(AgentLoop.bucketOf(scope))} 次（${isPrivate ? '私聊' : '群'}这一本账），已经 ${done} 次，还差 ${deficit} 次——离零点越近越难补，这轮原则上别 skip。`,
        );
      } else {
        lines.push(`今天的目标：至少主动说 ${this.#minPerDay(AgentLoop.bucketOf(scope))} 次（${isPrivate ? '私聊' : '群'}这一本账），已经 ${done} 次，达标了，接下来不用勉强。`);
      }
    }
    if (mustAct) {
      lines.push('注意：你上一轮想跳过，但今天还没到「至少说几次」的下限。这一轮必须真发一条（send_message 或 post_qzone），不能再 skip。');
    }
    lines.push('');
    const past = this.#recentSaid(6);
    if (past.length) {
      lines.push('【你最近主动说过的话】这些已经说过了，别换个说法再来一遍：');
      for (const row of past) {
        const t = new Date(row.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
        lines.push(`- ${t}${row.kind === 'qzone' ? '（说说）' : ''}：${row.text.slice(0, 50)}`);
      }
      lines.push('换角度：要么换个话题方向，要么就着群里此刻具体的这句话说，别反复念同一个结论。');
      lines.push('同一个话题（比如游戏荒、换皮肉鸽、显卡涨价）一天最多提一次；已经说过的方向这轮就换掉。');
      lines.push('');
    }
    const memText = this.memory?.render?.(scope) || '';
    if (memText) {
      const facts = this.memory?.load?.(scope)?.facts?.length || 0;
      this.log.info(`${scope} 记忆注入：${facts} 条事实`);
      lines.push(memText);
      lines.push('（以上是长期印象，只当背景；别把记忆里的旧结论当成这轮要聊的话题。）');
      lines.push('');
    }
    // B站 评论区收到的回复：让 QQ 这边的它也知道（只当背景，不主动汇报）
    {
      const biliLines = this.socialRepliesText({ limit: 3 });
      if (biliLines) {
        lines.push(biliLines);
        lines.push('（这是你在 B站 评论区的近况，是背景记忆；聊到了再自然接，不用主动汇报，也别把这些人当成群里的人。）');
        lines.push('');
      }
      const mimic = this.socialMimicText({ limit: 3 });
      if (mimic) {
        lines.push(mimic);
        lines.push('');
      }
      const wishes = this.socialWishesText({ limit: 2 });
      if (wishes) {
        lines.push(wishes);
        lines.push('');
      }
    }
    // 在场这几个人是谁：让它在主动说话时也知道在跟谁讲话
    try {
      const uins = [];
      for (const r of [...recent].reverse()) {
        if (r.role === 'bot') continue;
        if (r.userId) uins.push(String(r.userId));
        if (uins.length >= 3) break;
      }
      const pt = this.people?.renderMany?.(uins, { maxFacts: 3 }) || '';
      if (pt) {
        lines.push(`这个群里你认识的几个人：\n${pt}`);
        lines.push('');
      }
    } catch {
      /* 画像坏了不影响说话 */
    }
    // 群里刚有人甩推特链接：让它知道可以顺手把内容发出来
    try {
      const links = this.bot.recentTweetLinks?.(scope, 2) || [];
      if (links.length) {
        lines.push('群里刚有人甩了推特链接，你要是好奇可以看一眼再说（想看内容就用 share_tweet 把它发出来，边发边评论）：');
        for (const it of links) {
          const mins = Math.max(1, Math.round((Date.now() - Number(it.at || 0)) / 60000));
          lines.push(`- ${it.from || '群友'} 在 ${mins} 分钟前发了：${it.url}`);
        }
        lines.push('');
      }
      const xhsList = this.bot.recentXhsLinks?.(scope, 2) || [];
      if (xhsList.length) {
        lines.push('群里刚有人甩了小红书笔记，你要是想看内容就用 share_xhs 把它发出来（边发边评一句）：');
        for (const it of xhsList) lines.push(`- ${it.from} 在 ${Math.round((Date.now() - it.at) / 60000)} 分钟前发了：${it.url}`);
      }
      const humanContext = riffHumans(recent).map((r) => String(r.text || '')).join('\n');
      const memes = this.kb?.relevant?.(humanContext, { limit: 4, budget: 600 }) || [];
      if (memes.length) {
        lines.push('梗库里与眼下真人话题相关的参考（先接当前意思；不是指定台词，不贴就不用，要详情用 lookup_meme）：');
        for (const m of memes) lines.push(`- ${m.name}：${m.meaning || ''}${m.usage ? `；用法：${m.usage}` : ''}${m.example ? `；例句：${m.example}` : ''}`);
        lines.push('真有贴合当前场景的新变体再用 coin_meme 存下，注明 based_on；别为存梗而硬造。');
      }
      if (riff.length) {
        lines.push('眼下的场景可以这样化用（用不用随你，别硬套，也别解释你在造梗）：');
        for (const r of riff) {
          lines.push(`- ${r.said}${r.basedOn ? `（学自「${r.basedOn}」）` : ''}`);
        }
      }
    } catch {
      /* 链接记不下来不影响说话 */
    }
    lines.push('最近的聊天记录：');
    const fu = this.bot.followUps?.get?.(String(scope)) || null;
    const toMe = (r) =>
      Boolean(fu) &&
      r.role !== 'bot' &&
      String(r.name || '') === String(fu.name || '') &&
      (Number(r.at ?? r.ts ?? 0) || 0) >= Number(fu.since || 0);
    lines.push(
      recent.length
        ? recent
            .map((r) => {
              if (r.role === 'bot') return `我：${r.text}`;
              const line = `${r.name || '群友'}：${r.text}`;
              return toMe(r) ? `${line}   ←（没带 @，但这是在跟我说）` : line;
            })
            .join('\n')
        : '（这里还没有人说话）',
    );
    lines.push('');
    lines.push('——');
    lines.push(
      '现在是你自己的时间，没人叫你。你想在这个群里做点什么就做（说话、分享你刷到的好东西、给谁点个赞、发条空间……），' +
        '不想动就用 skip。别为了刷存在感硬说。',
    );
    lines.push('如果想知道之前聊过什么（比如谁最近在玩什么、上次谁问过你什么），用 search_history 去翻归档，硬盘上全都存着。');
    return lines.join('\n');
  }

  /** 最近 24h 做过哪几类事，用来给「本轮倾向」做参考（读 agent-log.jsonl） */
  /** 每天至少主动说几次（下限；0 = 不设） */
  // 「群」和「私聊」各算各的次数：两本账，互不占用
  static bucketOf(scope) {
    return String(scope || '').startsWith('private:') ? 'private' : 'group';
  }

  #limit(key, bucket) {
    const per = this.cfg[bucket] || {};
    const v = per[key] ?? this.cfg[key];
    return Number(v);
  }

  #minPerDay(bucket = 'group') {
    const n = this.#limit('minPerDay', bucket);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  #maxPerDay(bucket = 'group') {
    const n = this.#limit('maxPerDay', bucket);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  #gapMs(bucket = 'group') {
    const n = this.#limit('minGapMs', bucket);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  #rowsSince(since = dayStart()) {
    const out = [];
    try {
      const file = path.join(this.historyDir, 'agent-log.jsonl');
      if (!fs.existsSync(file)) return out;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (row.at >= since) out.push(row);
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 读不到就当空 */
    }
    return out;
  }

  /** 今天（本地零点起）真做了几次：说话 / 分享 / 说说 */
  #todayCount(bucket = null) {
    let n = 0;
    for (const row of this.#rowsSince()) {
      if (row.dry) continue;
      if (row.ok === false) continue;
      if (bucket && AgentLoop.bucketOf(row.scope) !== bucket) continue;
      if (row.kind === 'speak' || row.kind === 'share' || row.kind === 'qzone') n += 1;
    }
    return n;
  }


  /** 离每日下限还差几次 */
  #deficitToday(bucket = 'group') {
    const floor = this.#minPerDay(bucket);
    if (!floor) return 0;
    return Math.max(0, floor - this.#todayCount(bucket));
  }

  /** 最近 7 天分享过的链接，拿来去重 */
  /** 最近自己主动说过的话（去掉链接，只比意思） */
  #recentSaid(limit = 6, windowMs = 24 * 3600_000) {
    try {
      const file = path.join(this.historyDir, 'agent-log.jsonl');
      if (!fs.existsSync(file)) return [];
      const since = Date.now() - windowMs;
      const rows = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      return rows
        .filter(
          (r) =>
            Number(r.at) >= since &&
            !r.dry &&
            r.ok !== false &&
            (r.kind === 'speak' || r.kind === 'share' || r.kind === 'qzone') &&
            r.detail,
        )
        .slice(-limit)
        .map((r) => ({ kind: r.kind, at: Number(r.at), text: String(r.detail).replace(/https?:\/\/\S+/g, '').trim() }));
    } catch {
      return [];
    }
  }

  /** 字面不像但意思一样：交给模型判一次 */
  async #sameMeaningAsPast(target, past) {
    if (this.cfg.repeatJudge === false) return '';
    if (typeof this.brain?.complete !== 'function') return '';
    if (!past.length) return '';
    try {
      const list = past.map((r, i) => `${i + 1}. ${r.text.slice(0, 60)}`).join('\n');
      const text = await this.brain.complete({
        system: '你在帮一个群聊机器人查重。只回答一个词：重复 或 不重复。',
        prompt:
          `它以前说过：\n${list}\n\n它现在准备说：「${target.slice(0, 80)}」\n\n` +
          '这两者的核心意思或想聊的话题是不是同一个？（换了措辞、换了主语、语气不同但还是在说同一件事，也算重复；只是同一个大类但具体内容不同，算不重复）\n' +
          '只输出「重复」或「不重复」。',
        maxChars: 20,
      });
      const t = String(text || '').trim();
      if (/不重复|不是|否/.test(t)) return '';
      if (/重复|是/.test(t)) {
        const idx = Number((/第\s*(\d+)/.exec(t) || [])[1] || 0);
        return (past[idx - 1] || past[past.length - 1] || { text: '' }).text;
      }
      return '';
    } catch (err) {
      this.log.debug?.(`查重失败（不影响发送）：${err.message}`);
      return '';
    }
  }

  /** 别换个说法再来一遍：跟最近说过的比相似度 */
  async #repeatCheck(execution, text) {
    const target = String(text || '').replace(/https?:\/\/\S+/g, '').trim();
    if (target.length < 10) return null; // 太短的句子（“早”“哈哈哈”）本来就会重复，不判重
    const past = this.#recentSaid(6);
    let worst = 0;
    let hit = null;
    for (const row of past) {
      const sim = similarityLoose(target, row.text);
      if (sim > worst) {
        worst = sim;
        hit = row;
      }
    }
    const line = Number(this.cfg.repeatThreshold ?? 0.5);
    const lexical = hit && worst >= line;
    if (!lexical) {
      // 换个说法说同一件事，字面相似度抓不到——让模型自己判断一次（一天最多十几次，成本可接受）
      const judged = await this.#sameMeaningAsPast(target, past);
      if (judged) {
        if (execution.repeatWarned && similarityLoose(target, execution.repeatPrev || '') >= 0.9) {
          return '还是同一个意思，换个具体话题再说；实在没别的可说就这轮先别说';
        }
        if (!execution.repeatWarned) {
          execution.repeatWarned = true;
          execution.repeatPrev = target;
        }
        return `这跟你之前说过的是同一个意思：「${judged.slice(0, 40)}…」。换个话题或换个角度，别换个说法再来一遍`;
      }
      return null;
    }
    if (execution.repeatWarned) {
      // 第二遍还是同一句（只是标点/语气变了）：继续拦，别让它糊弄过去
      if (similarityLoose(target, execution.repeatPrev || '') >= 0.9) {
        return '还是同一句，换个具体的话题方向再说；实在没别的可说就这轮先别说';
      }
      this.log.warn(`${execution.scope} 又说了一遍相似的话（${worst.toFixed(2)}），这次放行`);
      return null;
    }
    execution.repeatWarned = true;
    execution.repeatPrev = target;
    return `这跟你之前说过的话几乎一样（相似 ${worst.toFixed(2)}）：「${hit.text.slice(0, 40)}…」。换个角度或换个话题，别把同一个结论换个词再说一遍`;
  }

  #sharedUrls() {
    const out = new Set();
    try {
      const file = path.join(this.historyDir, 'agent-log.jsonl');
      if (!fs.existsSync(file)) return out;
      const since = Date.now() - 7 * 24 * 3600_000;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!(row.at > since) || row.dry || row.ok === false) continue;
        if (!['share', 'speak', 'qzone'].includes(row.kind)) continue;
        for (const u of [...(row.urls || []), ...urlsIn(row.detail)]) out.add(cleanUrl(u));
      }
    } catch {
      /* 读不到就当没分享过 */
    }
    return out;
  }

  #recentKinds() {
    const out = { share: 0, qzone: 0, speak: 0, lastShareAt: 0, lastQzoneAt: 0 };
    try {
      const file = path.join(this.historyDir, 'agent-log.jsonl');
      if (!fs.existsSync(file)) return out;
      const since = Date.now() - 24 * 3600_000;
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        let row;
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        if (!(row.at > since)) continue;
        if (row.dry || row.ok === false) continue;
        if (row.kind === 'share') {
          out.share += 1;
          out.lastShareAt = Math.max(out.lastShareAt, row.at);
        } else if (row.kind === 'qzone') {
          out.qzone += 1;
          out.lastQzoneAt = Math.max(out.lastQzoneAt, row.at);
        } else if (row.kind === 'speak') out.speak += 1;
      }
    } catch {
      // 读不到就当作什么都没做
    }
    return out;
  }

  /**
   * 每轮先定一个「任务」：聊天 / 分享 / 发说说。
   * 按上次做过的间隔轮换，保证三件事都真的会发生，而不是被「不好意思打扰」挤掉。
   */
  /** 手动按钮指定的任务：直接给那一轮的业务，不走轮换 */
  #planFor(mode) {
    if (mode === 'share') return this.#sharePlan();
    if (mode === 'topic') {
      return {
        task: 'topic',
        brief:
          `这轮的任务是【开一个新话题】。群里最近没人接你的话，别回应上一条、别补一句解释、别假装刚才在跟谁聊。\n` +
          `你想一个你自己真感兴趣、群里也可能搭得上话的新话头（在玩什么游戏、哪部番、硬件折腾、某个想吐槽的现象），` +
          `用 send_message 发一句，1~2 句、20~60 字，像随口抛出来的，别写成提问式开场、别问「有人在吗」、别自问自答。\n` +
          `实在想不出有意思的就 skip，别为了说话而说。`,
      };
    }
    if (mode === 'qzone') {
      return {
        task: 'qzone',
        brief:
          `这轮的任务是【发一条 QQ 空间】。先看今天聊过什么：能接上今天的话题就接（写你当时的看法），接不上再从自己兴趣里挑一件。1~3 句，别写成营销号，别提 AI。`,
      };
    }
    return {
      task: 'chat',
      brief: '看看群里现在在聊什么，想说就顺着接一句；不想说就 skip。',
    };
  }

  /** 分享也分几种说法：有时只说话、有时甩张图、有时才丢链接——真人不会每次都「一句吐槽+一个视频标题」 */
  #sharePlan() {
    const pick = this.#pickInterest();
    const hint = pick.topic ? `${pick.group ? `${pick.group} · ` : ''}${pick.topic}` : '你自己感兴趣的东西';
    const shapes = this.#recentShareShapes(3);
    const linkStreak = shapes.slice(-2).filter((r) => r.hasUrl).length;
    let style = this.#rollShareStyle();
    // 连着两条都挂了链接就换个花样，别让群里觉得这人只会甩链接
    if (linkStreak >= 2 && style === 'link') style = 'talk';
    // 这一类爱好本来就是看图/看视频：按权重在 发图 / 发短视频 / 嘴上聊聊 之间挑
    if (pick.media === 'image') style = this.#rollMediaStyle();
    const common = '这轮的任务是【主动分享】，不是你问我要不要，而是你自己想跟这群人说点东西。\n';
    if (style === 'talk') {
      return {
        task: 'share',
        style,
        brief:
          common +
          `${hint} 这个方向，但**这轮不用发链接**（想搜来当谈资也行，不搜也行）。\n` +
          '就看群里现在的气氛，像真人一样丢一句自己的话：刚在干什么、一句牢骚、或者顺口问别人一句（「你们最近都在玩啥」这种）。\n' +
          '一两句就够，别写成段子，别用安利腔，别问「有人在吗」这种空话。直接 send_message 发出去。',
      };
    }
    if (style === 'meme') {
      return {
        task: 'share',
        style,
        brief:
          common +
          `${hint} 这个方向，不用搜东西：用 send_meme 甩一张贴题的表情包（关键词你自己想，` +
          '往这会儿的心情上靠），气氛到了就配一句话（别带安利腔），不配也行。别连着发两张。',
      };
    }
    if (style === 'picture') {
      return {
        task: 'share',
        style,
        brief:
          common +
          `${hint} 这个方向，用 share_picture 搜一张你看着顺眼的发出去（关键词自己定，可以多换两个词试试）。\n` +
          '它自己会下载、发出去、再把下载的原件删掉，你只管挑图。\n' +
          '最多配一句你自己的反应（可以不配），别写成介绍或安利，别连着发两张。',
      };
    }
    if (style === 'video') {
      return {
        task: 'share',
        style,
        brief:
          common +
          `${hint} 这个方向，用 share_video 找一段 30 秒以内的短片发出去（关键词自己定，比如「猫咪 翻车」「游戏 名场面」，多换两个词也行）。\n` +
          '它自己会挑片、下载、发出去，再把下载的原件删掉——你只管挑一段你真觉得有意思的。\n' +
          '配一句话就够（可以不配），说你自己看完的反应，别提「视频」「链接」「推荐」这种词，别介绍内容。',
      };
    }
    return {
      task: 'share',
      style,
      brief:
        common +
        `${hint} 这个方向，先用 find_content 搜一下——**搜哪儿你自己定，不用非得是 B站或知乎**，不填 source 就是全网一起搜；` +
        `关键词也可以按你的想法换几次，直到找到你自己真觉得有意思的。\n` +
        '发的时候**只写你自己那句反应**（一句，最多两句）：别复述视频标题——标题照抄一眼就像机器人，平台自己会出卡片；' +
        '别带安利腔——「推荐」「自取」「值得一看」「必看」这类词一个都别用，别用「链接：」开头，别堆感叹号。\n' +
        '行文随意点，可以顺口问别人一句（「有人玩过吗」）。链接单独放一行。\n' +
        '链接必须来自 find_content 的返回，不能编。除非搜出来全都烂到你不想发，否则这轮不要 skip。',
    };
  }

  /** 三种分享形态按权重掷骰：只说话 / 带链接 / 发表情包 */
  /** 图片类爱好的演绎方式：发图 / 发短视频 / 嘴上聊 */
  #rollMediaStyle() {
    const w = this.cfg.mediaStyleWeights || {};
    const entries = [
      ['picture', Number(w.picture ?? 55)],
      ['video', Number(w.video ?? 30)],
      ['talk', Number(w.talk ?? 15)],
    ].filter(([, v]) => v > 0);
    if (!entries.length) return 'picture';
    const total = entries.reduce((sum, [, v]) => sum + v, 0);
    let roll = Math.random() * total;
    for (const [name, weight] of entries) {
      roll -= weight;
      if (roll <= 0) return name;
    }
    return entries[entries.length - 1][0];
  }

  #rollShareStyle() {
    const w = this.cfg.shareStyleWeights || {};
    const talk = Number(w.talk ?? 40);
    const link = Number(w.link ?? 40);
    const meme = Number(w.meme ?? 20);
    const total = talk + link + meme || 1;
    let roll = Math.random() * total;
    if ((roll -= talk) <= 0) return 'talk';
    if ((roll -= link) <= 0) return 'link';
    return 'meme';
  }

  /** 最近几条主动记录里有没有带链接，用来避免连续甩链接 */
  /** 不指定平台时：各来源一起搜，按链接去重后混着给 */
  async #searchEverywhere(keyword, { limit = 8 } = {}) {
    const names = ANY_SOURCE_NAMES;
    const settled = await Promise.allSettled(names.map((name) => this.search(name, keyword, { limit: 4 })));
    const out = [];
    const seen = new Set();
    settled.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      for (const it of r.value || []) {
        const url = cleanUrl(it.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        out.push({ title: it.title, url, from: SOURCE_LABELS[names[i]] || names[i] });
      }
    });
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out.slice(0, limit);
  }

  #recentShareShapes(n = 3) {
    try {
      const rows = readJsonlTail(path.join(this.historyDir, 'agent-log.jsonl'), 200).filter(
        (r) => r && (r.kind === 'share' || r.kind === 'speak' || r.kind === 'qzone') && !r.dry && r.ok !== false,
      );
      return rows.slice(-n).map((r) => ({ hasUrl: Array.isArray(r.urls) && r.urls.length > 0 }));
    } catch {
      return [];
    }
  }

  /** 按人设里的喜好权重掷骰子：电脑游戏 40% / 动漫 30% / 科技数码 30% */
  #pickInterest() {
    const groups = (this.cfg.interestGroups || [])
      .map((g) => ({ name: String(g?.name || ''), weight: Number(g?.weight) || 0, media: String(g?.media || ''), topics: (g?.topics || []).map(String).filter(Boolean) }))
      .filter((g) => g.topics.length && g.weight > 0)
      .map((g) => ({ ...g, media: String(g.media || (g.raw || {}).media || '') }));
    const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
    if (!groups.length) {
      const flat = (this.cfg.interests || []).map(String).filter(Boolean);
      return flat.length ? { group: '', topic: pickOne(flat) } : { group: '', topic: '' };
    }
    const total = groups.reduce((sum, g) => sum + g.weight, 0);
    let roll = Math.random() * total;
    for (const g of groups) {
      roll -= g.weight;
      if (roll <= 0) return { group: g.name, topic: pickOne(g.topics), media: g.media };
    }
    const last = groups[groups.length - 1];
    return { group: last.name, topic: pickOne(last.topics), media: last.media };
  }

  /** 仅测试用：暴露选会话的结果 */
  pickScopeForTest(opts = {}) {
    return this.#pickScope(opts);
  }

  /** 仅测试用：暴露这一轮的分享计划 */
  sharePlanForTest() {
    return this.#sharePlan();
  }

  /** 仅测试用：暴露掷骰子的结果 */
  pickInterestForTest() {
    return this.#pickInterest();
  }

  #plan(recent = []) {
    const k = this.#recentKinds();
    const hours = (t) => (t ? (Date.now() - t) / 3600_000 : 999);
    const shareEveryHours = Number(this.cfg.shareEveryHours) || 4;
    const qzoneEveryHours = Number(this.cfg.qzoneEveryHours) || 20;

    if (hours(k.lastShareAt) >= shareEveryHours) {
      return this.#sharePlan();
    }
    if (hours(k.lastQzoneAt) >= qzoneEveryHours) {
      return {
        task: 'qzone',
        brief:
          `这轮的任务是【发一条 QQ 空间】。顺序别搞反：\n` +
          `① 先看今天群里/私聊都聊了什么（上面有聊天记录），挑一个你们今天真聊过、你也有话说的点，用 post_qzone 发 1~3 句你的看法；\n` +
          `② 只有今天确实没什么可接的（群里冷清、聊的都是没什么好展开的），才从你自己的兴趣里挑一件发。\n` +
          `别写成营销号，别提 AI；1~3 句，像随手记一笔。`,
      };
    }
    const lastHuman = [...recent].reverse().find((r) => r.role !== 'bot');
    const lastHumanAt = stampOf(lastHuman);
    const idleHours = lastHumanAt ? (Date.now() - lastHumanAt) / 3600_000 : 999;
    if (idleHours > 2) {
      return {
        task: 'chat',
        brief: '群里安静了两个小时以上。想说就起一个与之前无关的新话题，不要补答旧消息；没有新话题就 skip。',
      };
    }
    return { task: 'chat', brief: '看看群里现在在聊什么，想说就接一句，不想说就 skip。' };
  }

  /**
   * 视频社交（B站）用的「同一份记忆」：群/私聊的长期印象、最近说过的话、学到的笔记。
   * 人格文本由 social.mjs 从 brain.persona 取，和 QQ 完全同源。
   */
  /** QQ 侧和 B站 侧共用的「B站收到的回复」文本 */
  socialRepliesText({ limit = 3 } = {}) {
    try {
      const rows = this.social?.recentReplies?.({ limit }) || [];
      return formatReplies(rows, { limit });
    } catch {
      return '';
    }
  }

  /** 最近学到的行为/口头禅（QQ 和 B站 共用） */
  socialMimicText({ limit = 3 } = {}) {
    try {
      const notes = [
        ...(this.learn?.byKind?.('behavior', 2) || []),
        ...(this.learn?.byKind?.('phrase', 1) || []),
      ];
      return formatMimic(notes, { limit });
    } catch {
      return '';
    }
  }

  /** 刷视频时看上的东西：给 QQ 侧当撒娇的由头 */
  socialWishesText({ limit = 2 } = {}) {
    try {
      return formatWishes(this.social?.recentWishes?.({ limit }) || [], { limit });
    } catch {
      return '';
    }
  }

  socialMemory() {
    const lines = [];
    try {
      const mems = (this.memory?.list?.() || [])
        .filter((m) => m && m.scope && (m.summary || m.facts?.length))
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, 2);
      if (mems.length) {
        lines.push('【你在 QQ 里记得的事】');
        for (const m of mems) {
          const where = String(m.scope).startsWith('private:') ? '私聊' : '群';
          if (m.summary) lines.push(`- ${where}：${m.summary}`);
          for (const f of (m.facts || []).slice(-6)) lines.push(`- ${f}`);
        }
      }
    } catch {
      /* 记忆读不出来就当没有，不影响刷视频 */
    }
    const biliReplies = this.socialRepliesText({ limit: 5 });
    if (biliReplies) {
      lines.push('', biliReplies, '（这些人是在 B站 评论区回你的，不是 QQ 群友，别张冠李戴；要在那边接话就用 social_act。）');
    }
    const mimic = this.socialMimicText({ limit: 3 });
    if (mimic) lines.push('', mimic);
    const wishes = this.socialWishesText({ limit: 2 });
    if (wishes) lines.push('', wishes);
    const past = this.#recentSaid(4);
    if (past.length) {
      lines.push('', '【你最近在 QQ 里说过的话】这些意思已经说过了，别换个地方再说一遍：');
      for (const r of past) lines.push(`- ${String(r.text || '').slice(0, 60)}`);
    }
    try {
      const notes = this.learn?.top?.(4) || [];
      if (notes.length) {
        lines.push('', '【你自己学到的东西】（接得上时自然带一句，别背）：');
        for (const n of notes) lines.push(`- ${String(n.text || '').slice(0, 80)}`);
      }
    } catch {
      /* 笔记坏了不影响刷视频 */
    }
    return lines.join('\n').slice(0, 1800);
  }

  #systemPrompt(scope) {
    const learnNotes = this.learn?.renderFor?.({ scope, budget: 460, limit: 8 }) || '';
    const p = this.bot.brain?.persona ?? this.brain.persona ?? {};
    const base =
      typeof p.systemPrompt === 'string' && p.systemPrompt.trim()
        ? p.systemPrompt.trim()
        : `你叫「${p.name || '哈基米'}」，正在 QQ 里作为本人生活。${p.identity || ''} 说话风格：${p.style || '自然、简短、口语化'}`;
    return [
      base,
      ...abstractRule({ persona: p }),
      ...BANTER_RULE,
      '',
      '你现在不只是在被动回话，而是在自己运营这个账号。你有工具，能做的有三类事：',
      '① 在群里说话：顺着群里正在聊的接一句，或者自己起个头（send_message）',
      '② 分享你刷到的东西：用 find_content 真搜一条你感兴趣的（B站/知乎/贴吧/头条），觉得有意思就把真实链接甩出来 + 一句吐槽（send_message）',
      '③ 发 QQ 空间：心里有点想说的就发一条说说（post_qzone），一天最多一两条，别天天刷',
      '④ 自己画图：想画的时候用 draw_picture 真画一张发出去（一张要一两分钟，别频繁画）',
      '⑤ 翻群友档案：想起某个人提过什么、或者要提一个不在场的老熟人，用 recall_person 查名字/关键词（名册装不下的人都在硬盘上）',
      '⑥ 学点东西：想搞懂一个话题、或者想从最近的聊天里再咂摸点东西，用 study（学到的会记进长期笔记，以后说话用得上）',
      '⑦ 翻聊天原话：想找「谁以前怎么说的」，用 recall_chat（按关键词检索全部历史原话，不限多久前）',
      '⑧ 空间社交：好友发了什么用 qzone_inbox 看，想搭话就 qzone_comment（评论发出去了撤不回，一天只有几条额度，别见谁都评）。指向你的评论系统会替你必回，你不用管；没指向你的（比如两个人在你评论区自己聊）由你自己判断要不要接一句，qzone_reply 就是干这个的',
      '⑨ 刷视频：用 social_browse 看 B站热门/搜索、读评论区；真觉得有意思再用 social_act 点赞或评一句（评论撤不回，一天几条额度，说不出人话就别硬评）。要发评论得先 social_login 扫码登录 B站',
      '除此之外也能点赞、改群名片、传文件、查资料——但没理由就别动。',
      '不想做任何事就调 skip，没人会怪你。',
      '',
      ...(learnNotes ? ['你最近自己学到的东西（说话、分享、发说说时能自然用上就用；别背、别一次念好几条）：', learnNotes, ''] : []),
      '规矩（必须遵守）：',
      `- 一次只说 1~2 句，总长度 ${this.cfg.maxReplyChars} 字以内，像真人随手打字，不用 Markdown，不列点`,
      '- 不要自问自答：别接着回答自己上一条问过的问题，别在一句话后面自我补充',
      '- 别自言自语：刚说过话没人接，就别顺着再补一句；真想说就换一个全新的、跟刚才无关的话题',
      '- 分享链接时必须用 find_content 返回的真实链接，绝不能自己编标题或链接',
      '- 别人没问你的私事别主动说；别提「AI」「模型」「助手」',
      '- 危险操作（踢人、退群、改号资料、删东西）默认被拦，别硬试',
      '',
      '先想一句：这轮到底要不要做点什么？不做就 skip。',
    ].join('\n');
  }

  /** 每次醒来的决策都记一行，方便「它今天到底干了什么」 */
  #logAction({ scope, actions, said, task = 'chat' }) {
    try {
      fs.mkdirSync(this.historyDir, { recursive: true });
      const rows = actions.map((a) => {
        let kind = 'read';
        const src = String(a.args?.source || '');
        // 任何真写动作都听执行器返回的 kind：表情包/图/视频/推特/小红书以前都掉到 read，
        // 结果面板把它当成「读了一下」，额度与分享节奏也看不到这类动作。
        if (a.result?.ok && a.result?.write && a.result?.kind) kind = a.result.kind;
        else if (a.name === 'send_message') {
          // 兜底发言就是说话，别因为它挂在 share 那一轮就记成分享（会污染分享节奏）
          if (a.result?.kind) kind = a.result.kind;
          else if (src === 'floor') kind = 'speak';
          else if (src === 'share' || task === 'share') kind = 'share';
          else kind = 'speak';
        } else if (a.name === 'share_picture') kind = a.result?.kind || 'share';
        else if (a.name === 'post_qzone') kind = 'qzone';
        else if (a.name === 'skip') kind = 'skip';
        else if (a.name === 'qq_op' && !/^(?:_?get_)/.test(String(a.args?.action || ''))) kind = 'op';
        // 发到别的会话就记在那个会话头上，别串账
        const target = a.result?.scope || scope;
        return {
          at: Date.now(),
          scope: target,
          kind,
          tool: a.name,
          detail: String(a.result?.meme || a.args?.text || a.args?.content || a.result?.text || a.args?.action || a.result?.reason || '').slice(0, 200),
          ok: a.result?.ok === true,
          urls: a.result?.ok ? (a.result?.urls || []) : [],
          // 演练模式打的记录不是"真说了"，面板和额度都必须据此排除
          dry: Boolean(a.result?.dryRun) || Boolean(this.cfg.dryRun),
        };
      });
      if (!rows.length) rows.push({ at: Date.now(), scope, kind: 'none', tool: '', detail: '', ok: true, dry: Boolean(this.cfg.dryRun) });
      fs.appendFileSync(path.join(this.historyDir, 'agent-log.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    } catch (err) {
      this.log.warn(`记录决策失败：${err.message}`);
    }
  }

  /** 把图片下到临时目录（发完调用方会删） */
  async #downloadImage(url, scope) {
    const dir = path.resolve(this.cfg.storage?.dataDir || this.bot.cfg?.storage?.dataDir || 'data', 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    const ext = (() => {
      const m = /\.(jpe?g|png|webp|gif)(?:$|\?)/i.exec(String(url));
      return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
    })();
    const file = path.join(dir, `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': UA_HEADER } });
    if (!res.ok) throw new Error(`下载图片失败 HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '');
    if (type && !/^image\//i.test(type)) throw new Error(`这个地址不是图片（${type}）`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 8 * 1024) throw new Error('图片太小了，八成是占位图');
    if (buf.length > 12 * 1024 * 1024) throw new Error('图片太大（>12MB）');
    fs.writeFileSync(file, buf);
    this.log.debug?.(`下载图片 ${buf.length} 字节 → ${path.basename(file)}（${scope}）`);
    return file;
  }

  /** 安利腔/客服腔一票退回：这类词一出现，群里一眼看出是运营号 */
  /** 取缓存里的化用候选（1 小时内有效） */
  #cachedRiff(scope, recent) {
    const hit = this.riffCache.get(String(scope));
    if (!hit) return [];
    if (Date.now() - hit.at > 3600_000 || hit.sceneKey !== riffSceneKey(recent)) {
      this.riffCache.delete(String(scope));
      return [];
    }
    return hit.rows || [];
  }

  /** 后台算候选：不 await、失败静默，绝不挡说话 */
  #refreshRiffSoon(scope, recent) {
    const key = String(scope);
    const sceneKey = riffSceneKey(recent);
    const hit = this.riffCache.get(key);
    if (hit?.sceneKey === sceneKey && Date.now() - hit.at < 20 * 60_000) return;
    if (this.riffBusy?.has?.(key)) return;
    this.riffBusy = this.riffBusy || new Set();
    if (!this.kb?.relevant || !this.brain?.complete) return;
    const humans = riffHumans(recent);
    const scene = humans.map((r) => `${r.name || '群友'}: ${String(r.text || '').slice(0, 80)}`);
    const memes = this.kb.relevant(humans.map((r) => r.text).join('\n'), { limit: 4, budget: 600 });
    if (!scene.length || !memes.length) return;
    this.riffBusy.add(key);
    riffCandidates({ brain: this.brain, scene, memes })
      .then((rows) => {
        if (rows?.length) {
          this.riffCache.set(key, { at: Date.now(), rows, sceneKey });
          this.log.info?.(`化用候选（下次说话时参考）：${rows.map((r) => r.said).join(' / ').slice(0, 80)}`);
        }
      })
      .catch(() => {})
      .finally(() => this.riffBusy.delete(key));
  }

  /** 这段话里用到了库里哪些梗，记下来等着看有没有人接 */
  #watchCoins(scope, text) {
    try {
      const names = (this.kb?.all?.() || []).map((m) => m.name);
      const used = names.filter((n) => n && String(text).includes(n));
      for (const name of used) this.coinWatch.push({ name, scope, at: Date.now() });
      if (this.coinWatch.length > 40) this.coinWatch.splice(0, this.coinWatch.length - 40);
    } catch {
      /* 记不下来不影响说话 */
    }
  }

  /** 半小时内有人接着说话 = 这个梗没白用，给它加热度；自己说的不算 */
  #settleCoins(scope) {
    if (!this.coinWatch.length || !this.kb?.bump) return;
    const now = Date.now();
    const keep = [];
    for (const item of this.coinWatch) {
      const age = now - item.at;
      if (item.scope !== scope || age < 20_000) {
        if (age < 2 * 3600_000) keep.push(item);
        continue;
      }
      if (age > 30 * 60_000) continue; // 太久没人接，就不算命中
      try {
        this.kb.bump(item.name, 5);
      } catch {
        keep.push(item);
      }
    }
    this.coinWatch = keep;
  }

  #adCheck(text) {
    const bad = /(推荐|自取|值得一看|强烈安利|安利一下|必看|不容错过|干货|链接\s*[:：])/;
    const hit = bad.exec(String(text || ''));
    return hit ? `「${hit[1]}」这类词太像运营号了，换成你随口说话的样子` : null;
  }

  #linkError(text, execution) {
    const seen = this.#sharedUrls();
    for (const url of urlsIn(text)) {
      if (!execution.content.has(url)) return '链接必须来自本轮 find_content，请先搜索真实素材';
      if (seen.has(url)) return '这条链接已分享过，请换一条';
    }
    return null;
  }

  async #write(execution, kind, detail, perform) {
    const { scope, force } = execution;
    const reason = this.#gate(scope, force);
    if (reason) return { ok: false, error: reason };
    if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
    const result = this.cfg.dryRun ? { ok: true, dryRun: true } : await perform();
    if (result.ok) execution.wrote = true;
    return { ...detail, ...result, scope, kind, write: true };
  }

  async #execute(name, args, execution) {
    const { scope, force } = execution;
    try {
      if (this.stopped) return { ok: false, error: 'stopped' };
      switch (name) {
        case 'skip':
          return { ok: true, reason: args.reason || '' };

        case 'list_groups': {
          const groups = [...(this.bot.groups?.values?.() ?? [])].map((g) => ({
            id: String(g.group_id),
            name: g.group_name,
            members: g.member_count,
          }));
          return { ok: true, groups };
        }

        case 'read_history': {
          const rows = this.bot.recent(scope, Number(args.limit) || 20);
          return {
            ok: true,
            rows: rows.map((r) => ({ who: r.role === 'bot' ? '我' : r.name || '群友', text: r.text })),
          };
        }

        case 'send_message': {
          const target = args.scope ? String(args.scope) : scope;
          if (target !== scope) return { ok: false, error: '本轮只能在当前会话发消息，不能跨会话发送' };
          const text = String(args.text || '').trim();
          if (!text) return { ok: false, error: '内容为空' };
          const urls = urlsIn(text);
          const linkError = this.#linkError(text, execution);
          if (linkError) return { ok: false, error: linkError };
          const ad = this.#adCheck(text);
          if (ad) return { ok: false, error: ad };
          const repeat = await this.#repeatCheck(execution, text);
          if (repeat) return { ok: false, error: repeat };
          this.#watchCoins(scope, text);
          return await this.#write(execution, urls.length ? 'share' : 'speak', { text, urls }, async () => {
            const id = await this.bot.send(target, text);
            return { ok: id != null, messageId: id };
          });
        }

        case 'save_meme': {
          const url = String(args.url || '').trim() || String(this.bot.lastMediaUrl(scope) || '');
          if (!url) return { ok: false, error: '没图可收：既没给 url，最近一条也没有图' };
          let img;
          try {
            img = await fetchImage(url);
          } catch (err) {
            return { ok: false, error: `图拿不到：${err.message}` };
          }
          const saved = await collectMeme({ buffer: img.buffer, fileName: img.fileName, log: this.log });
          if (!saved.ok) return { ok: false, error: `入库失败：${saved.error}` };
          return { ok: true, meme: { tag: saved.tag, caption: saved.caption }, note: '已收进图库，以后可以直接搜它' };
        }

        case 'send_meme': {
          const keyword = String(args.keyword || '').trim();
          if (!keyword) return { ok: false, error: '没给关键词' };
          if (!this.bot.memes) return { ok: false, error: '图库没有接上（bot.memes 不存在）' };
          const picked = this.bot.memes.pick(keyword, { tag: String(args.tag || '') });
          if (!picked) return { ok: false, error: `图库里没有和「${keyword}」对得上的，换个词或者干脆别发` };
          const target = args.scope ? String(args.scope) : scope;
          if (target !== scope) return { ok: false, error: '本轮只能在当前会话发，不能跨会话发图' };
          return await this.#write(execution, 'speak', { meme: picked.caption, tag: picked.tag }, async () => {
            const id = await this.bot.sendImage(target, picked.file, { caption: picked.caption });
            return { ok: id != null, messageId: id };
          });
        }

        case 'draw_picture': {
          const prompt = String(args.prompt || '').trim();
          if (!prompt) return { ok: false, error: '没给画面描述' };
          const reason = this.#gate(scope, force);
          if (reason) return { ok: false, error: reason };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          if (this.cfg.image?.enabled === false) return { ok: false, error: '生图没开' };
          if (this.cfg.dryRun) {
            execution.wrote = true;
            return { ok: true, dryRun: true, write: true, kind: 'draw', prompt: prompt.slice(0, 80) };
          }
          const { generateImage } = await import('./imagegen.mjs');
          const { refinePrompt } = await import('./promptbrain.mjs');
          let file = null;
          try {
            const refined = await refinePrompt(this.brain, prompt, { cfg: this.cfg, log: this.log });
            const img = await generateImage(refined.prompt || prompt, { cfg: this.cfg, dataDir: this.dataDir, log: this.log });
            file = img.file;
            const caption = String(args.text || '').trim();
            const id = await this.bot.sendImage(scope, file, { caption });
            if (id == null) return { ok: false, error: '图画好了但没发出去' };
            execution.wrote = true;
            return { ok: true, write: true, kind: 'draw', messageId: id, prompt: img.prompt, seconds: Math.round(img.ms / 1000) };
          } catch (err) {
            return { ok: false, error: `画图失败：${err.message}` };
          } finally {
            if (file) fs.rmSync(file, { force: true });
          }
        }

        case 'share_picture': {
          const keyword = String(args.keyword || '').trim();
          if (!keyword) return { ok: false, error: '没给关键词' };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          const cands = (await this.images(keyword, { limit: 8 })).filter(
            (it) => it?.url && !this.#sharedUrls().has(cleanUrl(it.url)),
          );
          if (!cands.length) return { ok: false, error: `没搜到能发的图（${keyword}），换个词或者别发` };
          const pool = cands.slice(0, 5);
          const pick = pool[Math.floor(Math.random() * pool.length)];
          const reason = this.#gate(scope, force);
          if (reason) return { ok: false, error: reason };
          if (this.cfg.dryRun) {
            execution.wrote = true;
            return { ok: true, dryRun: true, write: true, kind: 'share', url: cleanUrl(pick.url) };
          }
          let file = null;
          try {
            file = await this.#downloadImage(pick.url, scope);
            const id = await this.bot.sendImage(scope, file);
            if (id == null) return { ok: false, error: '发图失败' };
            execution.wrote = true;
            return { ok: true, write: true, kind: 'share', messageId: id, url: cleanUrl(pick.url) };
          } catch (err) {
            return { ok: false, error: `发图失败：${err.message}` };
          } finally {
            // 发完就把下载的原件删掉，别在硬盘上堆图片
            if (file) for (const f of [file, `${file}.part`]) fs.rmSync(f, { force: true });
          }
        }

        case 'share_video': {
          const keyword = String(args.keyword || '').trim();
          if (!keyword) return { ok: false, error: '没给关键词' };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          const maxSeconds = Number(this.cfg.maxVideoSeconds || 30);
          const maxMB = Number(this.cfg.maxVideoMB || 40);
          const finder = this.shortVideos || (await import('./video.mjs')).searchShortVideos;
          const downloader = this.videoDownloader || (await import('./video.mjs')).downloadVideo;
          const cands = (await finder(keyword, { maxSeconds, limit: 6 })).filter((it) => it?.bvid && it?.cid);
          if (!cands.length) return { ok: false, error: `没找到 ${maxSeconds} 秒以内的短片（${keyword}），换个词或者别发` };
          const seenUrls = this.#sharedUrls();
          const fresh = cands.filter((it) => !seenUrls.has(cleanUrl(it.url)));
          const pool = (fresh.length ? fresh : cands).slice(0, 4);
          const pick = pool[Math.floor(Math.random() * pool.length)];
          const reason = this.#gate(scope, force);
          if (reason) return { ok: false, error: reason };
          const caption = String(args.text || '').trim();
          if (caption) {
            const bad = this.#adCheck(caption);
            if (bad) return { ok: false, error: bad };
          }
          if (this.cfg.dryRun) {
            execution.wrote = true;
            return { ok: true, dryRun: true, write: true, kind: 'share', url: cleanUrl(pick.url), title: pick.title, note: '演练：没下载也没发' };
          }
          let file = null;
          try {
            const got = await downloader({ bvid: pick.bvid, cid: pick.cid, dir: path.join(this.dataDir, 'tmp'), maxBytes: maxMB * 1024 * 1024 });
            file = got?.file;
            if (!file) return { ok: false, error: '视频没下下来' };
            const id = await this.bot.sendVideo(scope, file, { caption });
            if (id == null) return { ok: false, error: '发视频失败' };
            execution.wrote = true;
            return { ok: true, write: true, kind: 'share', messageId: id, url: cleanUrl(pick.url), title: pick.title, seconds: pick.duration, note: '发完已经删掉下载的原件' };
          } catch (err) {
            return { ok: false, error: `发视频失败：${err.message}` };
          } finally {
            if (file) fs.rmSync(file, { force: true });
          }
        }

        case 'share_tweet': {
          const tweetUrl2 = String(args.url || '').trim();
          if (!tweetUrl2) return { ok: false, error: '没给推文链接' };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          const twCaption = String(args.text || '').trim();
          if (twCaption) {
            const badTw = this.#adCheck(twCaption);
            if (badTw) return { ok: false, error: badTw };
          }
          const twGate = this.#gate(scope, force);
          if (twGate) return { ok: false, error: twGate };
          if (this.cfg.dryRun) {
            execution.wrote = true;
            return { ok: true, dryRun: true, write: true, kind: 'share', note: '演练：没下载也没发' };
          }
          const twMaxMB = Number(this.cfg.maxTweetMB || 30);
          const twMaxSec = Number(this.cfg.maxVideoSeconds || 30);
          let twFile = null;
          try {
            const { fetchTweetMedia } = await import('./twitter.mjs');
            const got = await fetchTweetMedia(tweetUrl2, {
              dir: path.join(this.dataDir, 'tmp'),
              maxBytes: twMaxMB * 1024 * 1024,
              maxSeconds: twMaxSec,
            });
            twFile = got.file;
            const twId = got.kind === 'video'
              ? await this.bot.sendVideo(scope, twFile, { caption: twCaption })
              : await this.bot.sendImage(scope, twFile, { caption: twCaption });
            if (twId == null) return { ok: false, error: '发推特的图/视频失败' };
            execution.wrote = true;
            return {
              ok: true,
              write: true,
              kind: 'share',
              messageId: twId,
              url: tweetUrl2,
              author: got.author,
              seconds: got.durationSec,
              note: '发完已经删掉下载的原件',
            };
          } catch (err) {
            return { ok: false, error: `取推特媒体失败：${err.message}` };
          } finally {
            if (twFile) fs.rmSync(twFile, { force: true });
          }
        }

        case 'share_xhs': {
          const xhsUrl = String(args.url || '').trim();
          if (!xhsUrl) return { ok: false, error: '没给小红书链接' };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          const xhsCaption = String(args.text || '').trim();
          if (xhsCaption) {
            const badX = this.#adCheck(xhsCaption);
            if (badX) return { ok: false, error: badX };
          }
          const xhsGate = this.#gate(scope, force);
          if (xhsGate) return { ok: false, error: xhsGate };
          if (this.cfg.dryRun) {
            execution.wrote = true;
            return { ok: true, dryRun: true, write: true, kind: 'share', note: '演练：没下载也没发' };
          }
          const xMaxMB = Number(this.cfg.maxTweetMB || 30);
          let xFile = null;
          try {
            const { fetchNoteMedia } = await import('./xhs.mjs');
            const got = await fetchNoteMedia(xhsUrl, {
              dir: path.join(this.dataDir, 'tmp'),
              maxBytes: xMaxMB * 1024 * 1024,
            });
            xFile = got.file;
            const xId = got.kind === 'video'
              ? await this.bot.sendVideo(scope, xFile, { caption: xhsCaption })
              : await this.bot.sendImage(scope, xFile, { caption: xhsCaption });
            if (xId == null) return { ok: false, error: '发小红书的图/视频失败' };
            execution.wrote = true;
            return {
              ok: true,
              write: true,
              kind: 'share',
              messageId: xId,
              url: xhsUrl,
              author: got.author,
              title: got.title,
              note: '发完已经删掉下载的原件',
            };
          } catch (err) {
            return { ok: false, error: `取小红书媒体失败：${err.message}` };
          } finally {
            if (xFile) fs.rmSync(xFile, { force: true });
          }
        }

        case 'lookup_meme': {
          if (!this.kb) return { ok: false, error: '梗库没接上' };
          const kw = String(args.keyword || '').trim();
          if (!kw) {
            const list = this.kb.all().slice(0, 12).map((m) => ({ name: m.name, meaning: m.meaning, heat: m.heat }));
            return { ok: true, count: list.length, items: list, note: '这是库里最新/最热的一批' };
          }
          const hits = this.kb.search(kw, { limit: 6 });
          if (!hits.length) return { ok: true, count: 0, note: `库里没有「${kw}」，要么没收录，要么换个说法再查` };
          return {
            ok: true,
            count: hits.length,
            items: hits.map((m) => ({ name: m.name, meaning: m.meaning, origin: m.origin, usage: m.usage, example: m.example, heat: m.heat })),
          };
        }

        case 'coin_meme': {
          if (!this.kb) return { ok: false, error: '梗库没接上' };
          const cname = String(args.name || '').trim();
          const cmean = String(args.meaning || '').trim();
          if (!cname || !cmean) return { ok: false, error: '造梗需要 name 和 meaning' };
          const before = new Set(this.kb.all().map((m) => m.name));
          const res = this.kb.addMany([
            {
              name: cname,
              meaning: cmean,
              example: String(args.example || ''),
              origin: String(args.based_on || '') ? `模仿「${String(args.based_on).slice(0, 20)}」` : '',
              heat: 55,
              source: 'bot',
              tags: ['自造'],
            },
          ]);
          if (!res.added && !res.updated) return { ok: false, error: '梗条目无效：名字须为 2–14 字，不能是纯数字、符号或整句；没有写入梗库', total: res.total };
          const fresh = !before.has(cname);
          return { ok: true, saved: fresh ? 'new' : 'updated', name: cname, total: res.total, note: fresh ? '存进去了，以后可以当自己的口头禅用' : '库里本来就有，已经补充说明' };
        }

        case 'find_content': {
          const anySource = String(args.source || '').trim();
          const source = ANY_SOURCE_NAMES.includes(anySource) ? anySource : '';
          const keyword = String(args.keyword || '').trim();
          if (!keyword) return { ok: false, error: '没给搜索词' };
          const items = source
            ? await this.search(source, keyword, { limit: 8 })
            : await this.#searchEverywhere(keyword);
          try {
            // 记下「这次搜了什么方向」，下次选题避开，别天天同一个类别
            fs.mkdirSync(this.historyDir, { recursive: true });
            fs.appendFileSync(
              path.join(this.historyDir, 'share-topics.jsonl'),
              `${JSON.stringify({ at: Date.now(), topic: keyword, source, scope })}\n`,
            );
          } catch {
            /* 账本坏了不影响分享 */
          }
          // 一条链接只分享一次：别隔两小时又甩同一个视频，群友会看出来这是复读机
          const seen = this.#sharedUrls();
          const fresh = items.filter((it) => !seen.has(cleanUrl(it.url)));
          const list = fresh.slice(0, 6);
          for (const it of list) execution.content.set(cleanUrl(it.url), it.title);
          return {
            ok: true,
            source: source ? SOURCE_LABELS[source] || source : '全网',
            items: list.map((it) => ({ title: it.title, url: cleanUrl(it.url), from: it.from || (source ? SOURCE_LABELS[source] : '') })),
            note: list.length
              ? fresh.length < items.length
                ? '已经分享过的链接我帮你滤掉了'
                : ''
              : items.length ? '这些链接都分享过了，换关键词或来源' : '这个来源没搜到，换个词或换来源',
          };
        }

        case 'search_history': {
          const dataDir = this.cfg.storage?.dataDir || this.bot.cfg?.storage?.dataDir || 'data';
          const out = await searchHistory(dataDir, {
            scope: args.scope ? String(args.scope) : scope,
            query: args.query ? String(args.query) : '',
            days: Number(args.days) || 14,
            name: args.name ? String(args.name) : '',
            limit: Number(args.limit) || 20,
          });
          return {
            ok: true,
            total: out.total,
            rows: out.hits.map((h) => ({
              at: new Date(h.ts).toLocaleString('zh-CN', { hour12: false }),
              who: h.who,
              text: h.text,
            })),
            note: out.total ? '' : '这段时间的归档里没有相关内容',
          };
        }

        case 'recall_chat': {
          const q = String(args.query || '').trim();
          if (!q) return { ok: false, error: '要给个关键词' };
          const book = this.learn || this.bot?.learn;
          if (!book?.searchMessages) return { ok: false, error: '原话库没接上' };
          const opt = {
            scope: args.scope ? String(args.scope) : scope,
            k: Math.max(1, Math.min(15, Number(args.limit) || 6)),
          };
          // 字面找不到时用语义兜一层（「显卡贵」也能翻出「买不起 5090」）
          const hits = book.searchMessagesSmart ? await book.searchMessagesSmart(q, opt) : book.searchMessages(q, opt);
          return {
            ok: true,
            total: hits.length,
            rows: hits.map((h) => ({
              at: new Date(h.ts).toLocaleString('zh-CN', { hour12: false }),
              who: h.speaker || h.uin || '群友',
              text: String(h.text).slice(0, 160),
            })),
            note: hits.length ? '' : `库里没有跟「${q}」对得上的原话`,
          };
        }

        case 'recall_person': {
          const q = String(args.query || '').trim();
          if (!q) return { ok: false, error: '要给个名字或关键词' };
          const book = this.people || this.bot.people;
          if (!book?.lookup) return { ok: false, error: '人物档案没接上' };
          const limit = Math.max(1, Math.min(5, Number(args.limit) || 2));
          const hits = book.lookup(q, { limit });
          if (!hits.length) return { ok: true, found: 0, note: `档案里没有跟「${q}」对得上的人` };
          return {
            ok: true,
            found: hits.length,
            people: hits.map((h) => ({
              name: h.name,
              uin: h.uin,
              summary: h.summary,
              style: h.style,
              facts: h.facts.slice(0, 12),
              factsTotal: h.facts.length,
              msgs: h.msgs,
              learnings: h.learnings,
            })),
            note: hits.some((h) => h.facts.length > 12) ? '每个人只列了 12 条，要更多细节再说' : '',
          };
        }

        case 'study': {
          const learner = this.learner || this.bot?.learner;
          if (!learner) return { ok: false, error: '学习功能没接上' };
          const topic = String(args.topic || '').trim();
          if (topic) {
            const res = await learner.learnTopic(topic);
            if (!res.ok) return { ok: false, error: `没学成：${res.reason}` };
            if (!res.learned) return { ok: true, learned: 0, note: `搜到了 ${res.found} 条，但没提炼出值得记的` };
            const shown = (this.learn?.top?.(res.learned) || []).slice(0, res.learned).map((n) => n.text);
            return { ok: true, learned: res.learned, added: res.added, topic: res.topic, notes: shown, note: '记住了，以后说话能带出来' };
          }
          // 不给话题：把本会话最近的聊天重新学一遍
          const out = await learner.learnChats({ force: true });
          return { ok: true, learned: out.added, note: out.added ? `从最近的聊天里学到 ${out.added} 条` : '最近这些聊天没什么新东西可学' };
        }

        case 'post_qzone': {
          const content = String(args.content || '').trim();
          if (!content) return { ok: false, error: '内容为空' };
          const linkError = this.#linkError(content, execution);
          if (linkError) return { ok: false, error: linkError };
          const adQ = this.#adCheck(content);
          if (adQ) return { ok: false, error: adQ };
          const repeatQ = await this.#repeatCheck(execution, content);
          if (repeatQ) return { ok: false, error: repeatQ };
          const right = Number(args.ugc_right ?? 1);
          if (![1, 4, 64].includes(right)) return { ok: false, error: '可见范围仅支持 1/4/64' };
          return await this.#write(execution, 'qzone', { text: content, urls: urlsIn(content) }, async () => {
            const data = await this.bot.onebot.call('send_qzone_msg', { content, ugc_right: right });
            return { ok: true, tid: data?.tid };
          });
        }

        case 'social_browse': {
          if (!this.social) return { ok: false, error: '视频社交没接上' };
          const limit = Math.min(8, Math.max(1, Number(args.limit) || 5));
          const quota = this.social.quota();
          const keyword = String(args.keyword || '').trim();
          const list = keyword ? await this.social.bili.search(keyword, { ps: limit }) : await this.social.bili.popular({ ps: limit });
          const items = [];
          for (const v of list.slice(0, limit)) {
            const comments = await this.social.bili.comments(v.aid, { ps: 5, sort: 2 }).catch(() => []);
            items.push({
              aid: v.aid,
              bvid: v.bvid,
              title: v.title,
              author: v.author,
              desc: String(v.desc || '').slice(0, 100),
              url: v.url,
              stats: v.stats,
              comments: comments.map((c) => ({ id: c.id, user: c.user, content: String(c.content || '').slice(0, 100), like: c.like })),
            });
          }
          return {
            ok: true,
            platform: 'bilibili',
            quota,
            items,
            note: quota.biliLoggedIn ? '' : 'B站还没登录：只能看不能赞/评；想动手先 social_login 扫码',
          };
        }

        case 'social_act': {
          if (!this.social) return { ok: false, error: '视频社交没接上' };
          const reason = this.#gate(scope, force);
          if (reason) return { ok: false, error: reason };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          const action = String(args.action || 'like');
          return await this.#write(execution, 'op', { social: action }, async () => {
            const r = await this.social.act({
              action,
              aid: String(args.aid || ''),
              text: String(args.text || ''),
              replyTo: args.reply_to ? String(args.reply_to) : '',
            });
            this.log.info(`视频社交 ${action}：${String(args.text || args.aid || '').slice(0, 30)}`);
            return r;
          });
        }

        case 'social_login': {
          if (!this.social) return { ok: false, error: '视频社交没接上' };
          const qr = await this.social.loginStart();
          return {
            ok: true,
            url: qr.url,
            expiresAt: qr.expiresAt,
            note: '把这条链接发出去让用户用 B站 App 扫码，或在手机浏览器打开；扫完确认后登录态会自动存下来',
          };
        }

        case 'qq_op': {
          const action = String(args.action || '');
          const params = args.params && typeof args.params === 'object' ? args.params : {};
          if (DESTRUCTIVE.has(action) && !this.cfg.allowDestructive) {
            return { ok: false, error: `${action} 属于危险动作，自动模式下被拦下了` };
          }
          if (!AUTO_OK.has(action) && !DESTRUCTIVE.has(action)) return { ok: false, error: `不认识的动作 ${action}` };
          // 发消息/发说说只能走统一执行器，否则会绕过上下文、去重与记账。
          if (['send_msg', 'send_group_msg', 'send_private_msg', 'send_group_forward_msg', 'send_private_forward_msg', 'send_qzone_msg'].includes(action)) {
            return { ok: false, error: '发消息请用 send_message；发空间请用 post_qzone。转发暂不在自动模式开放' };
          }
          if (/^(?:_?get_)/.test(action)) return { ok: true, data: await this.bot.onebot.call(action, params) };
          if (params.group_id != null && `group:${params.group_id}` !== scope) {
            return { ok: false, error: '本轮不能操作其他群' };
          }
          if (scope.startsWith('private:') && params.user_id != null && `private:${params.user_id}` !== scope) {
            return { ok: false, error: '本轮不能操作其他私聊对象' };
          }
          return await this.#write(execution, 'op', {}, async () => ({ ok: true, data: await this.bot.onebot.call(action, params) }));
        }

        case 'qzone_inbox': {
          if (!this.qzone) return { ok: false, error: '空间社交没接上' };
          const quota = this.qzone.quota();
          const replies = await this.qzone.pendingReplies({ posts: Math.min(8, Math.max(1, Number(args.posts) || 4)) });
          const feeds = await this.qzone.friendFeeds({ count: Math.min(30, Math.max(5, Number(args.feeds) || 20)) });
          return {
            ok: true,
            quota,
            replies: replies.map((r) => ({
              tid: r.tid,
              postText: String(r.postText || '').slice(0, 60),
              commentId: r.commentId,
              commentUin: Number(r.commentUin),
              commentName: r.commentName,
              comment: r.comment,
              at: r.at,
              directed: r.directed !== false,
            })),
            feeds: feeds.map((f) => ({ tid: f.tid, uin: Number(f.uin), nickname: f.nickname, content: f.content.slice(0, 90), images: f.images, at: f.time })),
            note: replies.length
              ? 'directed=true 的是指向你的（系统会自动回，你别重复回）；directed=false 的你自己决定要不要接'
              : feeds.length
                ? ''
                : '空间这边暂时没什么可接的',
          };
        }

        case 'qzone_reply': {
          if (!this.qzone) return { ok: false, error: '空间社交没接上' };
          const reason = this.#gate(scope, force);
          if (reason) return { ok: false, error: reason };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          return await this.#write(execution, 'op', { qzone: 'reply' }, async () => {
            const r = await this.qzone.replyToComment({
              tid: String(args.tid || ''),
              commentId: String(args.comment_id || ''),
              commentUin: Number(args.comment_uin) || 0,
              replyUin: args.reply_uin ? Number(args.reply_uin) : null,
              replyName: args.reply_name ? String(args.reply_name) : null,
              content: String(args.content || ''),
            });
            this.log.info(`回了条空间评论：${String(args.content || '').slice(0, 30)}`);
            return r;
          });
        }

        case 'qzone_comment': {
          if (!this.qzone) return { ok: false, error: '空间社交没接上' };
          const reason = this.#gate(scope, force);
          if (reason) return { ok: false, error: reason };
          if (execution.wrote) return { ok: false, error: '本轮已经执行过一个写动作' };
          return await this.#write(execution, 'op', { qzone: 'comment' }, async () => {
            const r = await this.qzone.commentPost({
              tid: String(args.tid || ''),
              targetUin: Number(args.target_uin) || 0,
              content: String(args.content || ''),
            });
            this.log.info(`评了条好友说说：${String(args.content || '').slice(0, 30)}`);
            return r;
          });
        }

        default:
          return { ok: false, error: `没有这个工具：${name}` };
      }
    } catch (err) {
      this.log.warn(`工具 ${name} 出错：${err.message}`);
      return { ok: false, error: err.message };
    }
  }
}

function DEFAULTS() {
  return {
    enabled: true,
    everyMinutes: 30,
    jitterMinutes: 10,
    groups: [],
    maxSteps: 6,
    maxActionsPerRound: 3,
    maxPerDay: 16,
    minPerDay: 4,
    minGapMs: 5 * 60_000,
    quietHours: ['23:00-08:00'],
    maxReplyChars: 160,
    contextChars: 6000,
    dryRun: false,
    shareStyleWeights: { talk: 40, link: 40, meme: 20 },
    mediaStyleWeights: { picture: 55, video: 30, talk: 15 },
    maxVideoSeconds: 30,
    maxVideoMB: 40,
    maxTweetMB: 30,
    allowDestructive: false,
    repeatThreshold: 0.5,
    repeatJudge: true,
    interests: ['新番', '独立游戏', '显卡', '装机', '数码新品', 'AI 工具', '手游', '机械键盘', 'Steam 新游戏', '动漫'],
    interestGroups: [
      { name: '电脑游戏', weight: 40, topics: ['独立游戏', 'Steam 新游戏', '装机', '游戏本', '外设'] },
      { name: '动漫', weight: 30, topics: ['新番', '动画剧场版', '漫画/轻小说'] },
      { name: '科技数码', weight: 30, topics: ['显卡', '数码新品', '机械键盘', 'AI 工具', '智能家居'] },
    ],
  };
}
