import { searchHistory, archiveStats } from './archive.mjs';
import path from 'node:path';

// 工具表：QQ 机器人的整套操作（发消息、看群、查档案、管空间…）。
// MCP stdio 服务和 DSH 插件共用这份定义，别再各写一遍。
// 每个工具都是「调控制台 HTTP API」的薄包装，不直接碰 OneBot。

export const TOOLS = [
  {
    name: 'qq_status',
    description: '查看 QQ 机器人运行状态：登录账号、事件流连接、模型、已回复条数、最近会话。回答「机器人在不在线」先用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'qq_list_groups',
    description: '列出机器人账号加入的 QQ 群（群号、群名、人数）。refresh=true 时向 QQ 重新拉取。',
    inputSchema: {
      type: 'object',
      properties: { refresh: { type: 'boolean', description: '是否强制刷新缓存' } },
      additionalProperties: false,
    },
  },
  {
    name: 'qq_group_members',
    description: '列出某个群的成员（QQ 号、群名片、角色）。',
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'number', description: '群号' } },
      required: ['group_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_recent_messages',
    description: '读取某个会话最近的聊天记录（scope 形如 group:123456 或 private:789）。用来了解群友刚才在聊什么。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'group:群号 或 private:QQ号' },
        limit: { type: 'number', description: '条数，默认 20，最多 200' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_history_search',
    description:
      '在硬盘归档里按需检索历史消息（不限于最近几条）。可按关键词、人、天数、会话过滤，用来回忆「上次聊过什么」「谁问过我什么」。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，可不填（不填就是按时间/人筛）' },
        scope: { type: 'string', description: 'group:群号 或 private:QQ号，不填查全部会话' },
        days: { type: 'number', description: '最近几天，默认 14' },
        name: { type: 'string', description: '只看某个人说的（名字片段）' },
        onlyMe: { type: 'boolean', description: '只看我自己发的' },
        limit: { type: 'number', description: '最多返回几条，默认 30' },
        context: { type: 'number', description: '每条命中前后各带几条上下文，默认 0' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_archive_stats',
    description: '看一眼归档规模：有多少个会话、共多少条消息、各会话最后更新时间。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'qq_why_silent',
    description: '查它为什么没说话：今天说了几次、沉默几次、各自什么原因（没 @ 我 / 免打扰 / 额度用完 / 我上一条没人接 / 模型自己决定不说…），以及最近的时间线。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最近几条时间线，默认 15' },
        scope: { type: 'string', description: '只看某个会话，如 group:10000003' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'qq_lookup_meme',
    description: '查梗库：某个词/说法是什么梗、什么出处、怎么用；不传关键词就看最近收录的一批和最热的。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '要查的词，留空看最新一批' },
        limit: { type: 'number', description: '返回几条，默认 10' },
      },
      additionalProperties: false,
    },
  },

  {
    name: 'qq_people_list',
    description: '列出机器人认识的群友：谁说过多少话、你对他的印象总述、记住的几条事实。想了解群里的谁就用它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'qq_person_profile',
    description: '看某一个人的完整档案（总述、说话风格、全部事实）。qq 号从 qq_people_list 或群成员列表里拿。',
    inputSchema: {
      type: 'object',
      properties: { uin: { type: 'string', description: '对方的 QQ 号' } },
      required: ['uin'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_person_learn',
    description: '让模型现在读一遍这个人说过的话，重新总结他的档案（学到的新事实会合并进去）。',
    inputSchema: {
      type: 'object',
      properties: { uin: { type: 'string', description: '对方的 QQ 号' } },
      required: ['uin'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_send_message',
    description: '向群或私聊发送一条文本消息。可选 quote 引用某条消息（message_id）。发送前建议先确认 scope 正确。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'group:群号 或 private:QQ号' },
        text: { type: 'string', description: '消息内容' },
        quote: { type: 'string', description: '可选，要引用的 message_id' },
      },
      required: ['scope', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_send_meme',
    description: '从表情包图库里按关键词挑一张图片发到群或私聊（关键词如 猫/无语/生气/比心）。count>1 时一次看多张候选。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'group:群号 或 private:QQ号；查候选时可省略' },
        keyword: { type: 'string', description: '想要什么样的图，一两个词' },
        tag: { type: 'string', description: '可选标签：happy angry sad shy confused daily' },
        dryRun: { type: 'boolean', description: 'true=只返回候选不发出去' },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_draw',
    description:
      '让 QQ 机器人自己画一张图发到群或私聊（真生成，不是搜图）。很慢，一张要一两分钟：立刻返回「画着呢」，画完它自己把图发出去。画什么写在 prompt 里（40~80 字的画面描述，要图里写字就写进去）。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'group:群号 或 private:QQ号' },
        prompt: { type: 'string', description: '画面描述：主体、动作、场景、风格' },
        text: { type: 'string', description: '可选，配的一句话' },
      },
      required: ['scope', 'prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_learn',
    description:
      '让 QQ 机器人学点东西（长期笔记，以后回话/发说说会用上）。给 topic 就去网上搜这个话题并总结成笔记；不给 topic 就把最近群聊 + 网上资讯重新消化一遍。学完返回新增条数。',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '可选，想学的具体话题；不填 = 消化最近的群聊和资讯' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'qq_mention',
    description: '在群里 @ 某个群友再说一句话。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'group:群号' },
        qq: { type: 'string', description: '要 @ 的 QQ 号' },
        text: { type: 'string', description: '跟在这一句后面的话' },
        name: { type: 'string', description: '可选，@ 时显示的昵称' },
      },
      required: ['scope', 'qq'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_set_autochat',
    description: '开关某个群/私聊的自动聊天（模型自动接话）。enabled=false 表示让它在那个会话闭嘴。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'group:群号 或 private:QQ号' },
        enabled: { type: 'boolean', description: 'true 开启，false 关闭' },
      },
      required: ['scope', 'enabled'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_set_persona',
    description: '修改机器人人设（姓名、身份、说话风格、规则）。传进来的字段会整体替换旧人设。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        identity: { type: 'string' },
        style: { type: 'string' },
        likes: { type: 'array', items: { type: 'string' } },
        rules: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: true,
    },
  },
  {
    name: 'qq_action_list',
    description:
      '列出这套 QQ 桥接能做的全部操作（按类别）。想干某件事但不知道用哪个工具、哪个 op 时先查这里。',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: '可选，按关键词过滤（如 空间/群/文件/点赞）' } },
      additionalProperties: false,
    },
  },
  {
    name: 'qq_qzone',
    description:
      'QQ 空间（说说）全套操作。op=publish 发说说（可带图、设可见范围）；feeds 看好友动态；posts 看自己的说说列表；like 给说说点赞；delete 删说说；right 改已发说说的可见范围。',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['publish', 'feeds', 'posts', 'like', 'delete', 'right'],
          description: 'publish=发说说 / feeds=好友动态 / posts=说说列表 / like=点赞 / delete=删除 / right=改权限',
        },
        content: { type: 'string', description: 'publish：说说正文' },
        images: { type: 'array', items: { type: 'string' }, description: 'publish：图片数组，支持 http(s)/base64://file://' },
        ugc_right: { type: 'number', description: '可见范围：1 所有人 / 4 好友 / 16 指定可见 / 64 仅自己 / 128 指定不可见' },
        target_uins: { type: 'array', items: { type: 'number' }, description: 'ugc_right=16/128 时的 QQ 号名单' },
        tid: { type: 'string', description: 'like/delete/right：说说 tid' },
        target_uin: { type: 'number', description: 'posts/like：目标 QQ 号（默认自己）' },
        pos: { type: 'number', description: 'posts：起始位置，默认 0' },
        num: { type: 'number', description: 'posts/feeds：本页数量，默认 20/10' },
        cursor: { type: 'string', description: 'feeds：上一页返回的 next_cursor' },
        limit: { type: 'number', description: 'root：最多列出多少个文件，默认 40' },
        confirm: { type: 'boolean', description: 'delete 必须显式传 true' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_admin',
    description:
      '群管理：禁言/解除、踢人、改群名片、改群名、全员禁言、改头衔、发群公告、设精华、查被禁言名单、退群、改加群方式。',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: [
            'ban',
            'kick',
            'card',
            'name',
            'whole_ban',
            'title',
            'notice',
            'essence_add',
            'essence_remove',
            'shut_list',
            'leave',
            'add_option',
          ],
          description: 'ban=禁言(0秒解除) / kick=踢人 / card=群名片 / name=群名 / whole_ban=全员禁言 / title=头衔 / notice=群公告 / essence_add|remove=精华 / shut_list=禁言名单 / leave=退群 / add_option=加群设置',
        },
        group_id: { type: 'number', description: '群号' },
        user_id: { type: 'number', description: '目标 QQ 号（ban/kick/card/title）' },
        duration: { type: 'number', description: 'ban：禁言秒数，0=解除，默认 1800' },
        reject_add_request: { type: 'boolean', description: 'kick：是否拒绝其再加群' },
        card: { type: 'string', description: 'card：新群名片（空字符串清除）' },
        group_name: { type: 'string', description: 'name：新群名' },
        enable: { type: 'boolean', description: 'whole_ban：true 开启 / false 关闭' },
        special_title: { type: 'string', description: 'title：头衔文本' },
        content: { type: 'string', description: 'notice：公告正文' },
        image: { type: 'string', description: 'notice：可选公告配图' },
        message_id: { type: 'string', description: 'essence_add：消息 ID（可为负数串）' },
        type: { type: 'number', description: 'notice：1 普通公告 / 20 新成员公告' },
        pinned: { type: 'number', description: 'notice：是否置顶 1/0' },
        add_type: { type: 'number', description: 'add_option：1 允许任何人 / 2 需验证 / 3 不允许' },
        confirm: { type: 'boolean', description: '危险操作（kick/leave/whole_ban 开启）必须显式传 true' },
        group_question: { type: 'string', description: 'add_option：验证问题' },
        group_answer: { type: 'string', description: 'add_option：答案' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_social',
    description:
      '社交动作：给某人资料卡点赞（名片赞）、拍一拍、看好友列表、查陌生人资料、改自己昵称/签名、换头像、处理好友添加请求、改群备注。',
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['like', 'poke', 'friends', 'profile', 'set_profile', 'set_avatar', 'friend_request', 'remark'],
          description: 'like=名片赞 / poke=拍一拍 / friends=好友列表 / profile=查资料 / set_profile=改自己资料 / set_avatar=换头像 / friend_request=处理好友请求 / remark=群备注',
        },
        user_id: { type: 'number', description: '目标 QQ 号' },
        times: { type: 'number', description: 'like：点赞次数，默认 10' },
        group_id: { type: 'number', description: 'poke 在群里拍时传；remark 用' },
        nickname: { type: 'string', description: 'set_profile：新昵称' },
        signature: { type: 'string', description: 'set_profile：新个性签名' },
        sex: { type: 'string', description: 'set_profile：male/female/unknown' },
        file: { type: 'string', description: 'set_avatar：头像图片（http(s)/file:///base64://）' },
        remark: { type: 'string', description: 'remark：群备注内容' },
        flag: { type: 'string', description: 'friend_request：请求 flag（来自系统消息）' },
        approve: { type: 'boolean', description: 'friend_request：true 同意 / false 拒绝' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_file',
    description: '群文件：列目录、取下载直链、上传、删除。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['root', 'url', 'upload', 'delete'], description: 'root=根目录列表 / url=下载直链 / upload=上传 / delete=删除' },
        group_id: { type: 'number', description: '群号' },
        file: { type: 'string', description: 'upload：文件路径（SnowLuma 服务端可读）或 URL' },
        name: { type: 'string', description: 'upload：上传后的文件名' },
        folder_id: { type: 'string', description: 'upload：目标文件夹 ID，默认 /' },
        file_id: { type: 'string', description: 'url/delete：文件 ID' },
        busid: { type: 'number', description: 'url/delete：业务 ID，默认 102' },
        limit: { type: 'number', description: 'root：最多列出多少个文件，默认 40' },
        confirm: { type: 'boolean', description: 'delete 必须显式传 true' },
      },
      required: ['op', 'group_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_album',
    description: '群相册：列相册、看相册里的图、上传图片/视频、给相册图片点赞。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'media', 'upload', 'like'], description: 'list=相册列表 / media=相册内容 / upload=上传 / like=点赞' },
        group_id: { type: 'number', description: '群号' },
        album_id: { type: 'string', description: 'media/upload/like：相册 ID' },
        file: { type: 'string', description: 'upload：图片/视频地址' },
        media_type: { type: 'string', enum: ['image', 'video'], description: 'upload：默认为图片；上传视频必须显式设 video，不根据文件名猜测' },
        text: { type: 'string', description: 'upload：配文（NapCat 不支持，请省略并单独发送说明）' },
        album_name: { type: 'string', description: 'upload：相册名' },
        batch_id: { type: 'string', description: 'like：批次 ID（来自 media 列表）' },
      },
      required: ['op', 'group_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_forward',
    description: '发合并转发（聊天记录卡片）。逐条给 nodes：每条 { nickname, content, user_id? }。目标可为群或好友。',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'group:群号 或 private:QQ号' },
        nodes: {
          type: 'array',
          description: '转发节点数组',
          items: {
            type: 'object',
            properties: {
              nickname: { type: 'string' },
              content: { type: 'string' },
              user_id: { type: 'number' },
            },
            required: ['content'],
          },
        },
      },
      required: ['scope', 'nodes'],
      additionalProperties: false,
    },
  },
  {
    name: 'qq_raw_action',
    description:
      '直接调用任意 OneBot v11 动作（逃生舱）。例如 get_group_list、get_msg、delete_msg(撤回)、set_group_ban(禁言)、set_group_card(改名片)、send_group_forward_msg(合并转发)、get_group_info 等。参数原样传给 SnowLuma。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'OneBot 动作名' },
        params: { type: 'object', description: '动作参数' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

function textResult(payload, isError = false) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

/**
 * 把 HTTP 客户端注入进来，得到 callTool。
 * api(path, {method, body}) 与 raw(action, params) 由调用方提供（各自管超时/鉴权）。
 */
export function makeCallTool({ api, raw, dataDir }) {
async function callTool(name, args = {}) {
  switch (name) {
    case 'qq_status': {
      const s = await api('/api/status');
      return textResult({
        account: `${s.nickname || '?'} (${s.selfId || '?'})`,
        ws: s.transport?.ws,
        http: s.transport?.http,
        llm: `${s.llmMode} / ${s.model}`,
        persona: s.persona,
        groups: s.groups,
        replies: s.stats?.replies ?? 0,
        events: s.stats?.events ?? 0,
        recentScopes: (s.scopes || []).slice(0, 10).map((x) => x.scope),
      });
    }
    case 'qq_list_groups': {
      const r = await api(`/api/groups${args.refresh ? '?refresh=1' : ''}`);
      return textResult(
        (r.groups || []).map((g) => ({
          group_id: g.group_id,
          group_name: g.group_name,
          member_count: g.member_count,
        })),
      );
    }
    case 'qq_group_members': {
      const r = await api('/api/raw', {
        method: 'POST',
        body: { action: 'get_group_member_list', params: { group_id: args.group_id } },
      });
      const list = Array.isArray(r.data) ? r.data : [];
      return textResult(
        list.map((m) => ({
          user_id: m.user_id,
          nickname: m.card || m.nickname,
          role: m.role,
        })),
      );
    }
    case 'qq_recent_messages': {
      const rows = await api(
        `/api/messages?scope=${encodeURIComponent(args.scope)}&limit=${Math.min(Number(args.limit || 20), 200)}`,
      );
      return textResult(
        (Array.isArray(rows) ? rows : []).map((r) => ({
          time: new Date(r.ts || Date.now()).toLocaleString('zh-CN', { hour12: false }),
          who: r.role === 'bot' ? `我(${r.name})` : r.name,
          text: r.text,
          message_id: r.messageId || undefined,
        })),
      );
    }
    case 'qq_history_search': {
      const out = await searchHistory(dataDir(), {
        scope: args.scope || undefined,
        query: args.query || '',
        days: args.days ? Number(args.days) : 14,
        name: args.name || '',
        onlyMe: !!args.onlyMe,
        limit: Math.min(Number(args.limit || 30), 200),
        context: Number(args.context || 0),
      });
      return textResult({
        total: out.total,
        returned: out.returned,
        hits: out.hits.map((h) => ({
          at: new Date(h.ts).toLocaleString('zh-CN', { hour12: false }),
          scope: h.scope,
          who: h.who,
          text: h.text,
          ...(h.context ? { context: h.context } : {}),
        })),
      });
    }

    case 'qq_lookup_meme': {
      const q = `/api/kb?limit=${Number(args.limit) || 10}${args.q ? `&q=${encodeURIComponent(args.q)}` : ''}`;
      const r = await api(q);
      return textResult({
        stats: r.stats,
        items: (r.items || []).map((m) => ({
          name: m.name,
          meaning: m.meaning,
          origin: m.origin,
          usage: m.usage,
          example: m.example,
          heat: m.heat,
        })),
      });
    }

    case 'qq_why_silent': {
      const q = `/api/decisions?limit=${Number(args.limit) || 15}${args.scope ? `&scope=${encodeURIComponent(args.scope)}` : ''}`;
      const r = await api(q);
      const recent = (r.recent || []).map((x) => ({
        at: new Date(x.at).toLocaleString('zh-CN', { hour12: false }),
        scope: x.scope,
        kind: x.kind,
        reason: x.reason,
        n: x.n,
        detail: x.detail || '',
      }));
      return textResult({ today: r.today, recent });
    }

    case 'qq_people_list': {
      const r = await api('/api/people');
      const rows = (r.people || []).map((p) => ({
        name: p.name,
        uin: p.uin,
        msgs: p.msgs,
        learned: p.learnings,
        summary: p.summary,
        facts: (p.facts || []).slice(0, 3),
      }));
      return textResult({ total: rows.length, people: rows });
    }

    case 'qq_person_profile': {
      const r = await api('/api/people');
      const p = (r.people || []).find((x) => String(x.uin) === String(args.uin));
      if (!p) return textResult({ ok: false, error: `不认识 ${args.uin}，他可能还没说过话` });
      return textResult(p);
    }

    case 'qq_person_learn': {
      const r = await api('/api/people/learn', { method: 'POST', body: { uin: String(args.uin), force: true } });
      return textResult(r);
    }

    case 'qq_archive_stats': {
      return textResult(archiveStats(dataDir()));
    }

    case 'qq_send_message': {
      const r = await api('/api/send', { method: 'POST', body: args });
      return textResult({ sent: true, messageId: r.messageId ?? null, scope: args.scope });
    }
    case 'qq_send_meme': {
      const q = new URLSearchParams({ q: String(args.keyword || ''), limit: '10' });
      if (args.tag) q.set('tag', String(args.tag));
      const list = await api(`/api/memes?${q.toString()}`);
      if (!args.scope || args.dryRun) {
        return textResult({ candidates: (list.memes || []).map((m) => ({ caption: m.caption, tag: m.tag })) });
      }
      const r = await api('/api/memes', { method: 'POST', body: args });
      return textResult({ sent: true, messageId: r.messageId ?? null, caption: r.caption, scope: args.scope });
    }
    case 'qq_draw': {
      const r = await api('/api/draw', { method: 'POST', body: args });
      return textResult({ started: true, scope: args.scope, note: r.note || '画着呢，一两分钟后会发出去' });
    }
    case 'qq_learn': {
      const r = await api('/api/learn', { method: 'POST', body: args });
      return textResult({ ok: r.ok !== false, learned: r.added ?? r.learned ?? 0, stats: r.stats || null, topic: r.topic || null });
    }
    case 'qq_mention': {
      const r = await api('/api/mention', { method: 'POST', body: args });
      return textResult({ sent: true, messageId: r.messageId ?? null, scope: args.scope });
    }
    case 'qq_set_autochat': {
      const r = await api('/api/autochat', { method: 'POST', body: args });
      return textResult({ scope: args.scope, autochat: r.autochat });
    }
    case 'qq_set_persona': {
      const r = await api('/api/persona', { method: 'POST', body: { persona: args } });
      return textResult({ updated: true, persona: r.persona });
    }
    case 'qq_action_list': {
      const CAPS = [
        ['聊天', [
          'qq_send_message — 发文本（群/私聊，可 quote 引用）',
          'qq_mention — 在群里 @ 某人再接一句',
          'qq_recent_messages — 读最近聊天记录',
          'qq_forward — 合并转发聊天记录卡片',
          'qq_raw_action — send_group_msg / send_private_msg 发富文本、delete_msg 撤回、get_msg 查单条',
        ]],
        ['群管理', [
          'qq_admin ban — 禁言（duration=0 解除，默认 1800 秒）',
          'qq_admin kick — 踢人（可拒绝其再加群）',
          'qq_admin card / name / title — 群名片、群名、头衔',
          'qq_admin whole_ban — 全员禁言开关',
          'qq_admin notice — 发群公告（可置顶/新成员公告）',
          'qq_admin essence_add / essence_remove — 设/撤精华消息',
          'qq_admin shut_list — 查被禁言名单',
          'qq_admin add_option — 加群方式/验证问题',
          'qq_admin leave — 退群',
          'qq_group_members — 群成员列表',
        ]],
        ['QQ空间', [
          'qq_qzone publish — 发说说（content + images 图片 + ugc_right 可见范围）',
          'qq_qzone feeds — 好友动态（分页 cursor）',
          'qq_qzone posts — 自己的说说列表（拿 tid）',
          'qq_qzone like — 给说说点赞（tid）',
          'qq_qzone delete — 删说说（tid）',
          'qq_qzone right — 改已发说说的可见范围',
        ]],
        ['社交', [
          'qq_social like — 给某人资料卡点赞（名片赞）',
          'qq_social poke — 拍一拍（群里带 group_id）',
          'qq_social friends — 好友列表',
          'qq_social profile — 查某人资料',
          'qq_social set_profile — 改自己昵称/签名/性别',
          'qq_social set_avatar — 换头像',
          'qq_social friend_request — 同意/拒绝好友申请',
          'qq_social remark — 改群备注',
        ]],
        ['文件与相册', [
          'qq_file root / url / upload / delete — 群文件列表、下载直链、上传、删除',
          'qq_album list / media / upload / like — 群相册',
        ]],
        ['状态与配置', [
          'qq_status — 账号在线状态、已回复数',
          'qq_list_groups — 我加入的群',
          'qq_set_autochat — 开关某会话的自动接话',
          'qq_set_persona — 改人设',
          'qq_raw_action — 任意 OneBot 动作逃生舱（真正的兜底）',
        ]],
      ];
      const kw = (args.filter || '').trim();
      const rows = CAPS.map(([area, items]) => {
        const hit = kw ? items.filter((x) => x.includes(kw) || area.includes(kw)) : items;
        return hit.length ? { area, items: hit } : null;
      }).filter(Boolean);
      return textResult(rows.length ? rows : `没有匹配「${kw}」的能力，可以直接试 qq_raw_action。`);
    }
    case 'qq_qzone': {
      const op = args.op;
      const guard = op === 'delete' && args.confirm !== true;
      if (guard) return textResult('删除说说需要 confirm:true 明确确认。', true);
      const map = {
        publish: () => raw('send_qzone_msg', {
          content: args.content,
          images: args.images,
          ugc_right: args.ugc_right ?? 1,
          target_uins: args.target_uins,
        }),
        feeds: () => raw('get_qzone_feeds', { page_num: 1, count: args.num ?? 10, cursor: args.cursor }),
        posts: () => raw('get_qzone_msg_list', { pos: args.pos ?? 0, num: args.num ?? 20, target_uin: args.target_uin }),
        like: () => raw('like_qzone', { tid: args.tid, target_uin: args.target_uin }),
        delete: () => raw('delete_qzone_msg', { tid: args.tid }),
        right: () => raw('set_qzone_msg_right', {
          tid: args.tid,
          ugc_right: args.ugc_right,
          target_uins: args.target_uins,
        }),
      };
      if (!map[op]) return textResult(`未知 op：${op}`, true);
      if (op === 'publish' && !args.content) return textResult('publish 需要 content。', true);
      if (['like', 'delete', 'right'].includes(op) && !args.tid) return textResult(`${op} 需要 tid。`, true);
      try {
        return textResult(await map[op]());
      } catch (err) {
        // 空间没发过说说时 SnowLuma 会报「响应结构异常」（msglist 为 null），当成空列表
        if (op === 'posts' && /说说列表|响应结构异常/.test(err.message)) {
          return textResult({ total: 0, msglist: [], note: '这个号目前没有说说' });
        }
        throw err;
      }
    }
    case 'qq_admin': {
      const op = args.op;
      const needGroup = op !== 'essence_add' && op !== 'essence_remove';
      if (needGroup && !args.group_id) return textResult(`${op} 需要 group_id。`, true);
      if (['kick', 'leave'].includes(op) && args.confirm !== true) {
        return textResult(`${op} 属于危险操作，需要 confirm:true 明确确认。`, true);
      }
      if (op === 'whole_ban' && args.enable === true && args.confirm !== true) {
        return textResult('开启全员禁言需要 confirm:true 明确确认。', true);
      }
      const map = {
        ban: () => raw('set_group_ban', { group_id: args.group_id, user_id: args.user_id, duration: args.duration ?? 1800 }),
        kick: () => raw('set_group_kick', {
          group_id: args.group_id,
          user_id: args.user_id,
          reject_add_request: args.reject_add_request ?? false,
        }),
        card: () => raw('set_group_card', { group_id: args.group_id, user_id: args.user_id, card: args.card ?? '' }),
        name: () => raw('set_group_name', { group_id: args.group_id, group_name: args.group_name }),
        whole_ban: () => raw('set_group_whole_ban', { group_id: args.group_id, enable: args.enable ?? true }),
        title: () => raw('set_group_special_title', {
          group_id: args.group_id,
          user_id: args.user_id,
          special_title: args.special_title ?? '',
        }),
        notice: () => raw('_send_group_notice', {
          group_id: args.group_id,
          content: args.content,
          type: args.type ?? 1,
          pinned: args.pinned ?? 0,
          image: args.image,
        }),
        essence_add: () => raw('set_essence_msg', { message_id: Number(args.message_id) }),
        essence_remove: () => raw('delete_essence_msg', { message_id: Number(args.message_id) }),
        shut_list: () => raw('get_group_shut_list', { group_id: args.group_id }),
        leave: () => raw('set_group_leave', { group_id: args.group_id }),
        add_option: () => raw('set_group_add_option', {
          group_id: args.group_id,
          add_type: args.add_type,
          group_question: args.group_question,
          group_answer: args.group_answer,
        }),
      };
      if (!map[op]) return textResult(`未知 op：${op}`, true);
      if (['ban', 'kick', 'card', 'title'].includes(op) && !args.user_id) {
        return textResult(`${op} 需要 user_id。`, true);
      }
      return textResult((await map[op]()) ?? 'ok');
    }
    case 'qq_social': {
      const op = args.op;
      const map = {
        like: () => raw('send_like', { user_id: args.user_id, times: args.times ?? 10 }),
        poke: () => raw('send_poke', { user_id: args.user_id, group_id: args.group_id }),
        friends: () => raw('get_friend_list', {}),
        profile: () => raw('get_stranger_info', { user_id: args.user_id }),
        set_profile: () => raw('set_qq_profile', {
          nickname: args.nickname,
          signature: args.signature,
          sex: args.sex,
        }),
        set_avatar: () => raw('set_qq_avatar', { file: args.file }),
        friend_request: () => raw('set_friend_add_request', { flag: args.flag, approve: args.approve ?? true }),
        remark: () => raw('set_group_remark', { group_id: args.group_id, remark: args.remark ?? '' }),
      };
      if (!map[op]) return textResult(`未知 op：${op}`, true);
      if (['like', 'poke', 'profile'].includes(op) && !args.user_id) return textResult(`${op} 需要 user_id。`, true);
      if (op === 'set_profile' && !args.nickname && !args.signature) {
        return textResult('set_profile 至少给 nickname 或 signature。', true);
      }
      return textResult((await map[op]()) ?? 'ok');
    }
    case 'qq_file': {
      const op = args.op;
      if (op === 'delete' && args.confirm !== true) return textResult('删除群文件需要 confirm:true。', true);
      const map = {
        root: async () => {
          const d = await raw('get_group_root_files', { group_id: args.group_id });
          const files = (d?.files || []).map((f) => ({
            file_name: f.file_name,
            file_size: f.file_size,
            uploader: f.uploader_name,
            file_id: f.file_id,
          }));
          return {
            total_files: files.length,
            folders: (d?.folders || []).map((x) => ({ folder_name: x.folder_name, folder_id: x.folder_id })),
            files: files.slice(0, Number(args.limit || 40)),
            note: files.length > Number(args.limit || 40) ? `只列前 ${Number(args.limit || 40)} 个，共 ${files.length} 个` : undefined,
          };
        },
        url: () => raw('get_group_file_url', { group_id: args.group_id, file_id: args.file_id, busid: args.busid ?? 102 }),
        upload: () => raw('upload_group_file', {
          group_id: args.group_id,
          file: args.file,
          name: args.name ?? '',
          folder_id: args.folder_id ?? '/',
        }),
        delete: () => raw('delete_group_file', { group_id: args.group_id, file_id: args.file_id, busid: args.busid ?? 102 }),
      };
      if (!map[op]) return textResult(`未知 op：${op}`, true);
      return textResult((await map[op]()) ?? 'ok');
    }
    case 'qq_album': {
      const op = args.op;
      const map = {
        list: () => raw('get_group_album_list', { group_id: args.group_id }),
        media: () => raw('get_group_album_media_list', {
          group_id: args.group_id,
          album_id: args.album_id,
          attach_info: '',
        }),
        upload: () => raw('upload_image_to_qun_album', {
          group_id: args.group_id,
          album_id: args.album_id,
          album_name: args.album_name ?? '',
          file: args.file,
          text: args.text,
          ...(args.media_type !== undefined ? { media_type: args.media_type } : {}),
        }),
        like: () => raw('set_group_album_media_like', {
          group_id: args.group_id,
          album_id: args.album_id,
          batch_id: args.batch_id,
        }),
      };
      if (!map[op]) return textResult(`未知 op：${op}`, true);
      return textResult((await map[op]()) ?? 'ok');
    }
    case 'qq_forward': {
      const scope = String(args.scope || '');
      const [kind, id] = scope.split(':');
      const nodes = (args.nodes || []).map((n) => ({
        type: 'node',
        data: {
          user_id: n.user_id || 0,
          nickname: n.nickname || '群友',
          content: [{ type: 'text', data: { text: n.content } }],
        },
      }));
      if (!nodes.length) return textResult('nodes 不能为空。', true);
      const data =
        kind === 'group'
          ? await raw('send_group_forward_msg', { group_id: Number(id), messages: nodes })
          : await raw('send_private_forward_msg', { user_id: Number(id), messages: nodes });
      return textResult({ sent: true, result: data });
    }
    case 'qq_raw_action': {
      const r = await api('/api/raw', { method: 'POST', body: { action: args.action, params: args.params || {} } });
      return textResult(r.data);
    }
    default:
      return textResult(`未知工具：${name}`, true);
  }
}
  return callTool;
}
