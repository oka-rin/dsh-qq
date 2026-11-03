import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OneBot } from '../src/onebot.mjs';

const log = { debug() {}, info() {}, warn() {}, error() {} };
async function endpoint(t) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: new URL(req.url, 'http://localhost').pathname, params: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { accepted: true } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { httpUrl: `http://127.0.0.1:${server.address().port}`, requests };
}

test('NapCat transport applies aliases and profile fields before HTTP serialization', async t => {
  const e = await endpoint(t);
  const bot = new OneBot({ httpUrl: e.httpUrl, gateway: 'napcat' }, { log });
  bot.state.nickname = 'fixture bot';
  await bot.call('get_group_album_list', { group_id: 10000003 });
  await bot.call('set_qq_profile', { signature: 'fixture note', sex: 'female' });
  assert.deepEqual(e.requests, [
    { path: '/get_qun_album_list', params: { group_id: 10000003 } },
    { path: '/set_qq_profile', params: { nickname: 'fixture bot', personal_note: 'fixture note', sex: 2 } },
  ]);
});

test('NapCat transport handles explicit album video and rejects ignored captions before sending', async t => {
  const e = await endpoint(t);
  const bot = new OneBot({ httpUrl: e.httpUrl, gateway: 'napcat' }, { log });
  await bot.call('upload_image_to_qun_album', { group_id: 10000003, file: 'https://example.invalid/media', media_type: 'video' });
  assert.equal(e.requests[0].path, '/upload_video_to_qun_album');
  assert.equal(e.requests[0].params.media_type, undefined);
  await assert.rejects(bot.call('upload_image_to_qun_album', { text: 'not silently discarded' }), /不支持 text/);
  assert.equal(e.requests.length, 1);
  assert.equal(bot._inflight, 0);
});

test('existing SnowLuma transport preserves action and payload unchanged', async t => {
  const e = await endpoint(t);
  const bot = new OneBot({ httpUrl: e.httpUrl }, { log });
  const params = { signature: 'old backend', sex: 'male' };
  await bot.call('set_qq_profile', params);
  assert.deepEqual(e.requests, [{ path: '/set_qq_profile', params }]);
  assert.equal(bot.gateway, 'snowluma');
});
