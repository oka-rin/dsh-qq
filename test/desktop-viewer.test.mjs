import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const viewer = await readFile(new URL('../desktop-client.js', import.meta.url), 'utf8');

test('viewer return and WebSocket URL resolutions preserve ordinary HTTP and GUI mounts', () => {
  // Pure URL checks against the actual literals used by the viewer; no DOM or
  // browser emulation, credential lookup, or connection to a user's GUI.
  const back = viewer.match(/const returnUrl = new URL\('([^']+)', location\.href\)/)?.[1];
  const ws = viewer.match(/const url = new URL\('([^']+)', location\.href\)/)?.[1];
  assert.equal(back, '../../../'); assert.equal(ws, './ws');
  for (const protocol of ['http:', 'https:']) for (const mount of ['/', '/dsh/']) {
    const origin = `${protocol}//qq-login.example.test:3080`;
    const current = `${origin}${mount}dsh-qq/login/desktop/view`;
    assert.equal(new URL(back, current).href, origin + mount);
    const websocket = new URL(ws, current);
    websocket.protocol = protocol === 'https:' ? 'wss:' : 'ws:';
    assert.equal(websocket.href, `${protocol === 'https:' ? 'wss:' : 'ws:'}//qq-login.example.test:3080${mount}dsh-qq/login/desktop/ws`);
  }
});

test('viewer has no secure-context gate and preserves readable backend and connection errors', () => {
  assert.doesNotMatch(viewer, /isSecureContext|localhost|127\.0\.0\.1/);
  assert.match(viewer, /location\.protocol === 'https:'\) warning\.hidden = true/);
  assert.match(viewer, /fetch\('\.\/close'/);
  assert.match(viewer, /location\.assign\(returnUrl\.href\)/);
  assert.match(viewer, /info\.error \|\|/);
  assert.match(viewer, /event\.detail\?\.reason/);
  assert.match(viewer, /start\(\)\.catch\(error =>/);
  assert.match(viewer, /if \(closing \|\| failed\) return/);
  assert.match(viewer, /不要刷新本页/);
});
