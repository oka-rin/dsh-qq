import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptOneBotRequest } from '../src/onebot-compat.mjs';
import { TOOLS, makeCallTool } from '../src/tools.mjs';

const napcat = (action, params, options = {}) => adaptOneBotRequest(action, params, { gateway: 'napcat', ...options });

test('legacy gateway leaves action and params untouched, even unsupported NapCat fields', () => {
  const params = Object.freeze({ signature: 'note', sex: 'female', text: 'caption', media_type: 'video' });
  for (const gateway of [undefined, 'snowluma', 'other']) {
    const result = adaptOneBotRequest('set_qq_profile', params, { gateway });
    assert.equal(result.action, 'set_qq_profile');
    assert.equal(result.params, params);
  }
});

test('NapCat profile converts signature and sex without mutating input', () => {
  const params = Object.freeze({ nickname: 'bot', signature: '', sex: 'female' });
  assert.deepEqual(napcat('set_qq_profile', params), {
    action: 'set_qq_profile', params: { nickname: 'bot', personal_note: '', sex: 2 },
  });
  assert.equal(params.signature, '');
  assert.equal(params.sex, 'female');
  for (const [input, expected] of [['unknown', 0], ['male', 1], ['female', 2], [0, 0], ['1', 1], [2, 2]]) {
    assert.equal(napcat('set_qq_profile', { nickname: 'bot', sex: input }).params.sex, expected);
  }
});

test('signature-only profile requires known logged-in nickname, never fabricates it', () => {
  assert.throws(() => napcat('set_qq_profile', { signature: 'note' }), /nickname/);
  assert.deepEqual(napcat('set_qq_profile', { signature: 'note' }, { selfNickname: 'logged-in' }).params,
    { nickname: 'logged-in', personal_note: 'note' });
  assert.throws(() => napcat('set_qq_profile', { nickname: 'bot', sex: 'invalid' }), /sex/);
  assert.throws(() => napcat('set_qq_profile', { nickname: 'bot', signature: 'a', personal_note: 'b' }), /冲突/);
  assert.equal(napcat('set_qq_profile', { nickname: 'requested' }, { selfNickname: 'old' }).params.nickname, 'requested');
});

test('album list uses official action name and preserves pagination params', () => {
  const params = Object.freeze({ group_id: 123, attach_info: 'cursor' });
  assert.deepEqual(napcat('get_group_album_list', params), { action: 'get_qun_album_list', params });
  assert.equal(napcat('get_qun_album_list', params).action, 'get_qun_album_list');
});

test('album upload uses explicit media type only and strips adapter-only fields', () => {
  const params = Object.freeze({ group_id: 123, album_id: 'a', file: 'https://example.invalid/a.mp4', media_type: 'video', text: '' });
  assert.deepEqual(napcat('upload_image_to_qun_album', params), {
    action: 'upload_video_to_qun_album',
    params: { group_id: 123, album_id: 'a', file: params.file, album_name: '' },
  });
  assert.equal(napcat('upload_image_to_qun_album', { file: 'a.mp4' }).action, 'upload_image_to_qun_album');
  assert.equal(napcat('upload_image_to_qun_album', { file: 'a' }, { mediaType: 'video' }).action, 'upload_video_to_qun_album');
  assert.equal(params.media_type, 'video');
  assert.throws(() => napcat('upload_image_to_qun_album', { media_type: 'audio' }), /media_type/);
  assert.throws(() => napcat('upload_image_to_qun_album', { media_type: 'image' }, { mediaType: 'video' }), /冲突/);
  assert.throws(() => napcat('upload_video_to_qun_album', { media_type: 'image' }), /不能/);
});

test('NapCat album captions fail honestly rather than silently succeeding', () => {
  assert.throws(() => napcat('upload_image_to_qun_album', { text: 'caption' }), /不支持 text/);
  assert.throws(() => napcat('upload_video_to_qun_album', { text: 'caption' }), /不支持 text/);
});

test('Qzone, forward, group-file, and standard video messages are not rewritten', () => {
  for (const action of ['send_qzone_msg', 'get_qzone_feeds', 'get_qzone_msg_list', 'set_qzone_msg_right', 'send_group_forward_msg', 'get_forward_msg', 'upload_group_file', 'send_group_msg']) {
    const params = Object.freeze({ images: ['base64://AA=='], message: [{ type: 'video', data: { file: 'base64://AA==' } }] });
    assert.deepEqual(napcat(action, params), { action, params });
  }
});

test('qq_album exposes explicit video type and passes it to the compatibility boundary', async () => {
  const schema = TOOLS.find(t => t.name === 'qq_album').inputSchema;
  assert.deepEqual(schema.properties.media_type.enum, ['image', 'video']);
  const calls = [];
  const callTool = makeCallTool({
    api() { throw new Error('network forbidden'); },
    raw: async (action, params) => { calls.push(napcat(action, params)); return { ok: true }; },
    dataDir() { throw new Error('data access forbidden'); },
  });
  await callTool('qq_album', { op: 'upload', group_id: 123, album_id: 'a', file: 'opaque-url', media_type: 'video' });
  assert.equal(calls[0].action, 'upload_video_to_qun_album');
  assert.equal(calls[0].params.media_type, undefined);
  assert.equal(calls[0].params.text, undefined);
});
