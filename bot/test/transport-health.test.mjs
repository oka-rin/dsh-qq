import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OneBot } from '../src/onebot.mjs';

test('HTTP failures and non-JSON cannot leave transport green; action rejection is not transport failure', async t => {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    req.resume();
    if (mode === 'nonjson') { res.end('bad response'); return; }
    res.setHeader('content-type', 'application/json');
    res.statusCode = mode === 'http' ? 503 : 200;
    res.end(JSON.stringify(mode === 'action' ? { status: 'failed', retcode: 1, message: 'not supported' } : { status: 'ok', data: {} }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const bot = new OneBot({ httpUrl: `http://127.0.0.1:${server.address().port}` }, { log: { debug() {} } });
  for (const next of ['ok', 'http', 'ok', 'nonjson', 'action', 'ok']) {
    mode = next;
    if (next === 'ok') await bot.call('fixture'); else await assert.rejects(bot.call('fixture'));
    assert.equal(bot.state.http, ['http', 'nonjson'].includes(next) ? 'error' : 'ok');
  }
});
