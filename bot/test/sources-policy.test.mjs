import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanUrl, filterSourceItems, isSourceUrl, searchSource } from '../src/sources.mjs';

const valid = [
  ['bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD?p=2'],
  ['bilibili', 'http://bilibili.com/video/av123/'],
  ['zhihu', 'https://www.zhihu.com/question/123/answer/456'],
  ['zhihu', 'https://zhuanlan.zhihu.com/p/123'],
  ['tieba', 'https://tieba.baidu.com/p/123?pn=2'],
  ['tieba', 'http://www.tieba.baidu.com/p/123/'],
  ['toutiao', 'https://www.toutiao.com/trending/123/?rank=2'],
  ['toutiao', 'https://m.toutiao.com/article/123/'],
  ['toutiao', 'https://www.toutiao.com/i123/'],
];
for (const [source, url] of valid) {
  test(`${source}: accepts parsed HTTP(S) content URL ${url}`, () => {
    assert.equal(isSourceUrl(source, url), true);
  });
}

const samples = [
  ['bilibili', 'bilibili.com', '/video/BV1xx411c7mD'],
  ['zhihu', 'zhihu.com', '/question/123'],
  ['tieba', 'tieba.baidu.com', '/p/123'],
  ['toutiao', 'toutiao.com', '/article/123'],
];
for (const [source, domain, pathname] of samples) {
  test(`${source}: rejects hostile host, userinfo and ambiguous scheme/path variants`, () => {
    const rejected = [
      `https://evil.example/${domain}${pathname}`,
      `https://evil.example/?next=https://${domain}${pathname}`,
      `https://${domain}.evil.example${pathname}`,
      `https://evil${domain}${pathname}`,
      `https://${domain}@evil.example${pathname}`,
      `https://evil.example@${domain}${pathname}`,
      `https://user:password@${domain}${pathname}`,
      `ftp://${domain}${pathname}`,
      `javascript:https://${domain}${pathname}`,
      `//${domain}${pathname}`,
      `https:/${domain}${pathname}`,
      `https:${domain}${pathname}`,
      `https://${domain}:8443${pathname}`,
      `https://${domain}/redirect?target=${pathname}`,
      `https://${domain}${pathname}/evil`,
      `https://${domain}\\@evil.example${pathname}`,
      `https://${domain}\n.evil.example${pathname}`,
      ` https://${domain}${pathname}`,
      '', null,
    ];
    for (const url of rejected) assert.equal(isSourceUrl(source, url), false, String(url));
  });

  test(`${source}: filters search candidates at the parsed source boundary`, () => {
    const good = { title: '真实标题', url: `https://${domain}${pathname}` };
    const bad = { title: '恶意标题', url: `https://evil.example/${domain}${pathname}` };
    assert.deepEqual(filterSourceItems(source, [bad, good, { ...good, title: '' }, null]), [good]);
  });
}

test('rejects empty IDs, invalid source paths and unknown source', () => {
  for (const [source, url] of [
    ['zhihu', 'https://zhihu.com/question/'],
    ['zhihu', 'https://zhihu.com/question/123suffix'],
    ['tieba', 'https://tieba.baidu.com/p/not-a-number'],
    ['toutiao', 'https://toutiao.com/article/'],
    ['bilibili', 'https://bilibili.com/cheese/play/123'],
    ['bilibili', 'https://bilibili.com/video/BV123/extra'],
    ['unknown', 'https://zhihu.com/question/123'],
  ]) assert.equal(isSourceUrl(source, url), false, url);
});

test('normalizes hostname case, but retains domain label boundary', () => {
  assert.equal(isSourceUrl('zhihu', 'https://WWW.ZHIHU.COM/question/123'), true);
  assert.equal(isSourceUrl('zhihu', 'https://notzhihu.com/question/123'), false);
  assert.equal(isSourceUrl('zhihu', 'https://zhihu.com.evil/question/123'), false);
  assert.equal(isSourceUrl('tieba', 'https://baidu.com/p/123'), false);
});

test('cleans tracking prefixes case-insensitively and preserves ordinary query semantics', () => {
  const cleaned = cleanUrl('https://example.com/article?utm_source=a&utm_medium=b&UTM_Campaign=c&share_x=1&Share_token=2&spm_id_from=3&from=4&source=5&id=6&page=2#anchor');
  assert.equal(cleaned, 'https://example.com/article?id=6&page=2');
});

test('Bilibili keeps p=2 and t while dropping tracking instead of erasing every query', () => {
  const cleaned = cleanUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=30&utm_source=a&share_x=b&vd_source=c&spm_id_from=d#reply');
  assert.equal(cleaned, 'https://www.bilibili.com/video/BV1xx411c7mD?p=2&t=30');
  assert.notEqual(cleaned, cleanUrl('https://www.bilibili.com/video/BV1xx411c7mD?p=1&t=30'));
});

test('Toutiao preserves non-tracking parameters and removes tracking', () => {
  assert.equal(cleanUrl('https://www.toutiao.com/trending/123/?rank=2&utm_source=x&share_id=y&log_pb=z#top'), 'https://www.toutiao.com/trending/123/?rank=2');
});

test('cleanUrl is idempotent and keeps malformed input fallback', () => {
  const url = 'https://example.com/a?p=2&utm_source=a&share_x=b';
  assert.equal(cleanUrl(cleanUrl(url)), cleanUrl(url));
  assert.equal(cleanUrl('not a url'), 'not a url');
});

test('searchSource rejects malformed mocked provider results with no network', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url === 'https://api.bilibili.com/x/frontend/finger/spi') {
      return new Response(JSON.stringify({ data: { b_3: 'fake-cookie' } }));
    }
    assert.ok(url.startsWith('https://api.bilibili.com/x/web-interface/search/type?'), 'unexpected network request blocked');
    return new Response(JSON.stringify({ data: { result: [
      { bvid: 'BV1xx411c7mD', title: '真实视频标题' },
      { bvid: 'BV1/../../redirect', title: '非法视频路径' },
      { bvid: 'BV123/extra', title: '附加非法路径' },
      { bvid: 'BV456', arcurl: '/cheese/play/123', title: '付费课程' },
    ] } }));
  };
  try {
    const items = await searchSource('bilibili', 'offline-fixture');
    assert.deepEqual(items.map(({ title, url }) => ({ title, url })), [
      { title: '真实视频标题', url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
    ]);
    assert.ok(requests.length >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
