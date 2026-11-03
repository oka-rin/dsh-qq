import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ControlServer } from '../src/control.mjs';

// A loopback server with an inert daily scheduler: GET never ticks or sends.
test('daily status endpoint is read only and requires the existing control token', async (t) => {
  let reads = 0;
  const server = new ControlServer({
    config: { control: { host: '127.0.0.1', port: 0, token: 'test-daily-token' } },
    bot: { status: () => ({ selfId: '9' }) },
    dailyNews: { status() { reads++; return { enabled: true, groups: ['group:11'], time: '10:00', sources: ['epic'] }; },
      tick() { throw new Error('status must never trigger delivery'); } },
    log: { info() {}, error() {} },
  });
  await server.listen();
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.server.address().port}`;
  assert.equal((await fetch(`${base}/api/daily-news`)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(`${base}/api/daily-news`, { headers: { authorization: 'Bearer test-daily-token' } });
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.deepEqual((await response.json()).dailyNews.groups, ['group:11']);
  const post = await fetch(`${base}/api/daily-news`, { method: 'POST', headers: { authorization: 'Bearer test-daily-token' } });
  assert.equal(post.status, 404);
  assert.equal(reads, 1);
});
