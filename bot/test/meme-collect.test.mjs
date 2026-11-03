import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

const calls = [];
const uploadBodies = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    calls.push(body.op);
    res.setHeader('content-type', 'application/json');
    if (mode === 'recognize-fail' && body.op === 'recognize') {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false, error: 'model down' }));
      return;
    }
    if (body.op === 'recognize') {
      res.end(JSON.stringify({ ok: true, tag: 'meow', caption: '猫猫点头', keywords: '猫 点头' }));
      return;
    }
    if (body.op === 'upload') {
      uploadBodies.push(body);
      res.end(JSON.stringify({ ok: true, meme: { path: `memes/${body.tag}/x.gif`, tag: body.tag, caption: body.caption } }));
      return;
    }
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, error: 'bad op' }));
  });
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001080600000', 'hex');

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.MEME_API = `http://127.0.0.1:${server.address().port}/dsh-memes-api`;
});
test.after(() => server.close());

test('collect：先识别再入库，分类用识别结果', async () => {
  const { collect } = await import('../src/meme-collect.mjs');
  calls.length = 0;
  mode = 'ok';
  const r = await collect({ buffer: PNG, fileName: 'a.png' });
  assert.equal(r.ok, true);
  assert.equal(r.tag, 'meow');
  assert.equal(r.caption, '猫猫点头');
  assert.deepEqual(calls, ['recognize', 'upload']);
});

test('collect：识别挂了也照样入库，兜底 daily', async () => {
  const { collect } = await import('../src/meme-collect.mjs');
  calls.length = 0;
  mode = 'recognize-fail';
  const r = await collect({ buffer: PNG, fileName: 'b.png', log: { warn() {}, info() {} } });
  assert.equal(r.ok, true);
  assert.equal(r.tag, 'daily');
  assert.deepEqual(calls, ['recognize', 'upload']);
});

test('collect：超过 8MB 直接拒绝，不发请求', async () => {
  const { collect } = await import('../src/meme-collect.mjs');
  calls.length = 0;
  const big = Buffer.alloc(8 * 1024 * 1024 + 1);
  const r = await collect({ buffer: big, fileName: 'big.png' });
  assert.equal(r.ok, false);
  assert.match(r.error, /太大/);
  assert.deepEqual(calls, []);
});

test('fetchImage 按文件头判真实格式（CDN 把 PNG 标成 jpeg 也能救）', async () => {
  const { fetchImage, sniffExt } = await import('../src/meme-collect.mjs');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const imgServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'image/jpeg'); // 故意标错
    res.end(png);
  });
  await new Promise((r) => imgServer.listen(0, '127.0.0.1', r));
  try {
    const got = await fetchImage(`http://127.0.0.1:${imgServer.address().port}/x.jpg`);
    assert.match(got.fileName, /\.png$/, '应按 magic bytes 判成 .png');
    assert.equal(sniffExt(Buffer.from('GIF89a........', 'ascii')), '.gif');
    assert.equal(sniffExt(png), '.png');
  } finally {
    imgServer.close();
  }
});

test('collect 按 magic bytes 改扩展名（声明 .jpg、实际 GIF）', async () => {
  const { collect } = await import('../src/meme-collect.mjs');
  const gif = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(20, 0)]);
  const r = await collect({ buffer: gif, fileName: '899A36B5.jpg' });
  assert.equal(r.ok, true);
  assert.match(uploadBodies.at(-1).fileName, /\.gif$/, '应改名为 .gif 再上传');
});
