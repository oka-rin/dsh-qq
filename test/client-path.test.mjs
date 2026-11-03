import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the shipped pure path helper, not a mock React view.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const helper = source.match(/    function resolveBasePath\([\s\S]*?\n    }/)[0];
const resolve = vm.runInNewContext(`(${helper.trim()})`, { URL });

test('GUI document base preserves stripping proxy mount without boot.basePath', () => {
  for (const [base, page, expected] of [
    ['http://host/dsh/', 'http://host/dsh/', '/dsh'],
    ['https://host/team/gui/', 'https://host/team/gui/?x=1', '/team/gui'],
    ['http://localhost:3080/', 'http://localhost:3080/', ''],
    ['https://host/dsh/', 'https://host/dsh/index.html', '/dsh'],
  ]) {
    const prefix = resolve(undefined, base, page);
    assert.equal(prefix, expected);
    assert.equal(prefix + '/dsh-qq/login/status', expected + '/dsh-qq/login/status');
    const viewer = new URL(prefix + '/dsh-qq/login/desktop/view', page);
    assert.equal(new URL('./info', viewer).pathname, expected + '/dsh-qq/login/desktop/info');
    assert.equal(new URL('./ws', viewer).pathname, expected + '/dsh-qq/login/desktop/ws');
  }
});

test('Path=/dsh/ browser cookie reaches mounted login, not old absolute-root route', () => {
  const prefix = resolve(undefined, 'http://host/dsh/', 'http://host/dsh/');
  const sendsCookie = path => path === '/dsh' || path.startsWith('/dsh/');
  assert.equal(sendsCookie('/dsh-qq/login/status'), false);
  assert.equal(sendsCookie(prefix + '/dsh-qq/login/status'), true);
  assert.equal(sendsCookie(prefix + '/dsh-qq/login/desktop/view'), true);
});

test('explicit valid mount is respected once; off-origin base cannot redirect credentials', () => {
  assert.equal(resolve('/gui///', 'https://host/dsh/', 'https://host/dsh/'), '/gui');
  assert.equal(resolve('', 'https://evil.test/dsh/', 'https://host/dsh/'), '');
  assert.equal(resolve('//evil.test', 'https://host/dsh/', 'https://host/dsh/'), '/dsh');
  assert.equal(resolve('/path?x=1', 'https://host/dsh/', 'https://host/dsh/'), '/dsh');
});
