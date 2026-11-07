import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { ffmpegReady, sniffMime } from '../src/media.mjs';
import { collectImages, collectMedia } from '../src/vision.mjs';

const LIMIT = 64 * 1024; // Both public collectors clamp maxBytes to at least 64 KiB.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// Same three-frame, 32x32 self-contained GIF fixture used by media.test.mjs.
const GIF = Buffer.from(
  'R0lGODlhIAAgAPcfMQAAAAAAVQAAqgAA/wAkAAAkVQAkqgAk/wBIAABIVQBIqgBI/wBsAABsVQBsqgBs/wCQAACQVQCQqgCQ/wC0AAC0VQC0qgC0/wDYAADYVQDYqgDY/wD8AAD8VQD8qgD8/yQAACQAVSQAqiQA/yQkACQkVSQkqiQk/yRIACRIVSRIqiRI/yRsACRsVSRsqiRs/ySQACSQVSSQqiSQ/yS0ACS0VSS0qiS0/yTYACTYVSTYqiTY/yT8ACT8VST8qiT8/0gAAEgAVUgAqkgA/0gkAEgkVUgkqkgk/0hIAEhIVUhIqkhI/0hsAEhsVUhsqkhs/0iQAEiQVUiQqkiQ/0i0AEi0VUi0qki0/0jYAEjYVUjYqkjY/0j8AEj8VUj8qkj8/2wAAGwAVWwAqmwA/2wkAGwkVWwkqmwk/2xIAGxIVWxIqmxI/2xsAGxsVWxsqmxs/2yQAGyQVWyQqmyQ/2y0AGy0VWy0qmy0/2zYAGzYVWzYqmzY/2z8AGz8VWz8qmz8/5AAAJAAVZAAqpAA/5AkAJAkVZAkqpAk/5BIAJBIVZBIqpBI/5BsAJBsVZBsqpBs/5CQAJCQVZCQqpCQ/5C0AJC0VZC0qpC0/5DYAJDYVZDYqpDY/5D8AJD8VZD8qpD8/7QAALQAVbQAqrQA/7QkALQkVbQkqrQk/7RIALRIVbRIqrRI/7RsALRsVbRsqrRs/7SQALSQVbSQqrSQ/7S0ALS0VbS0qrS0/7TYALTYVbTYqrTY/7T8ALT8VbT8qrT8/9gAANgAVdgAqtgA/9gkANgkVdgkqtgk/9hIANhIVdhIqthI/9hsANhsVdhsqths/9iQANiQVdiQqtiQ/9i0ANi0Vdi0qti0/9jYANjYVdjYqtjY/9j8ANj8Vdj8qtj8//wAAPwAVfwAqvwA//wkAPwkVfwkqvwk//xIAPxIVfxIqvxI//xsAPxsVfxsqvxs//yQAPyQVfyQqvyQ//y0APy0Vfy0qvy0//zYAPzYVfzYqvzY//z8APz8Vfz8qvz8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEMgAfACwAAAAAIAAgAAAIiAAFDBhIcIDAggPBKVzIsCE4hBAROpy4MKLFARQpXowIbGJHhwUPIhSZceJGiCVBniyYsuFKlgs/NpQpMmTElgxfEsRZUSdGng99ymQ4tOfAmgRJAvX5kydToEF1EvUItarVq1gzFlW4FVzXrlnDih1b8itVh2DJql2L0yzas2zjyrXqdibcgAAAIfkEBTIAAAAsHwAfAAEAAQAACAQAAQQEACH5BAUyAAAALB8AHwABAAEAAAgEAAEEBAA7',
  'base64',
);

function config(overrides = {}) {
  return { chat: { vision: {
    enabled: true, maxImages: 6, maxBytes: LIMIT, timeoutMs: 1000, totalFrames: 8,
    gif: { enabled: true, maxFrames: 3 }, video: { enabled: false }, ...overrides,
  } } };
}

function history(...refs) {
  return [{ role: 'user', name: '测试群友', text: '[发了一张图]', media: refs }];
}

function captureLog() {
  const info = [];
  const all = [];
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, (...args) => {
    const text = args.join(' ');
    all.push(text);
    if (level === 'info') info.push(text);
  }]));
  return { log, info, all };
}

function assertSafeDiagnostic(logs, category, secrets = []) {
  assert.ok(logs.info.length, 'a rejected attachment must be diagnosable at info level');
  assert.match(logs.info.join('\n'), category);
  for (const secret of secrets) {
    assert.ok(!logs.all.join('\n').includes(secret), `diagnostics must not expose ${secret.slice(0, 30)}`);
  }
}

for (const collect of [collectImages, collectMedia]) {
  test(`${collect.name}: oversized Content-Length cancels without reading the body`, async (t) => {
    const url = `https://download.invalid/${collect.name}/header.jpg?token=private-header-token`;
    let reads = 0;
    let canceled = false;
    const body = new ReadableStream({
      pull(controller) { reads += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    t.mock.method(globalThis, 'fetch', async () => new Response(body, {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(LIMIT + 1) },
    }));
    const logs = captureLog();
    assert.deepEqual(await collect(history({ url }), config(), logs), []);
    assert.equal(reads, 0, 'an oversized advertised body must never be consumed');
    assert.equal(canceled, true, 'the unused body must be canceled');
    assertSafeDiagnostic(logs, /超限|过大|限制|limit|bytes/i, [url, 'private-header-token', 'download.invalid']);
    assert.match(logs.info.join('\n'), new RegExp(String(LIMIT)));
  });

  test(`${collect.name}: chunked overflow stops at the first over-budget chunk`, async (t) => {
    const url = `https://download.invalid/${collect.name}/chunked.jpg?token=private-stream-token`;
    const chunkSize = 16 * 1024;
    let reads = 0;
    let canceled = false;
    let signal;
    const body = new ReadableStream({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(chunkSize));
        if (reads === 100) controller.close();
      },
      cancel() { canceled = true; },
    }, { highWaterMark: 0 });
    t.mock.method(globalThis, 'fetch', async (_url, opts) => {
      signal = opts.signal;
      return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
    });
    const logs = captureLog();
    assert.deepEqual(await collect(history({ url }), config(), logs), []);
    assert.equal(reads, LIMIT / chunkSize + 1, 'do not download the remainder after discovering overflow');
    assert.ok(canceled || signal.aborted, 'overflow must cancel or abort the response');
    assertSafeDiagnostic(logs, /超限|过大|限制|limit|bytes/i, [url, 'private-stream-token', 'download.invalid']);
  });

  test(`${collect.name}: local files and base64 obey the same byte ceiling`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-download-test-'));
    const file = path.join(dir, 'private-local-image.png');
    // dir is the concrete mkdtemp result created by this test, not an external path.
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const oversized = Buffer.concat([PNG, Buffer.alloc(LIMIT + 1 - PNG.length)]);
    fs.writeFileSync(file, oversized);
    const base64 = `base64://${oversized.toString('base64')}`;
    for (const ref of [{ file: pathToFileURL(file).href }, { file: base64 }]) {
      const logs = captureLog();
      assert.deepEqual(await collect(history(ref), config(), logs), []);
      assertSafeDiagnostic(logs, /超限|过大|限制|limit|bytes/i, [file, ref.file, base64.slice(0, 80)]);
    }
  });

  test(`${collect.name}: HTTP failures report a status, not the signed URL`, async (t) => {
    const url = `https://download.invalid/${collect.name}/expired.jpg?token=private-http-token`;
    t.mock.method(globalThis, 'fetch', async () => new Response('expired', { status: 403 }));
    const logs = captureLog();
    assert.deepEqual(await collect(history({ url }), config(), logs), []);
    assertSafeDiagnostic(logs, /403/, [url, 'private-http-token', 'download.invalid']);
  });

  test(`${collect.name}: valid static content and exact-limit content still pass`, async (t) => {
    const exact = Buffer.concat([PNG, Buffer.alloc(LIMIT - PNG.length)]);
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (url) => {
      requests += 1;
      const bytes = url.includes('/exact') ? exact : PNG;
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 12));
          controller.enqueue(bytes.subarray(12));
          controller.close();
        },
      }), { headers: { 'content-type': 'image/jpeg', 'content-length': String(bytes.length) } });
    });
    const got = await collect(history(
      { url: `https://download.invalid/${collect.name}/static.jpg` },
      { url: `https://download.invalid/${collect.name}/exact.jpg` },
    ), config());
    assert.equal(got.length, 2);
    assert.equal(requests, 2);
    assert.deepEqual(got.map((item) => item.bytes).sort((a, b) => a - b), [PNG.length, LIMIT]);
    for (const item of got) {
      assert.equal(item.kind, 'image');
      assert.equal(item.mimeType, 'image/png', 'magic bytes override misleading JPEG type and extension');
      assert.ok(item.dataUrl.startsWith('data:image/png;base64,'));
    }
  });
}

test('collectMedia: a stalled response body times out with a safe info diagnostic', async (t) => {
  let response;
  const server = http.createServer((_req, res) => {
    response = res;
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.write(PNG.subarray(0, 12)); // Headers arrive, but the body never finishes.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    response?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/stalled.jpg?token=private-timeout-token`;
  const logs = captureLog();
  const started = Date.now();
  assert.deepEqual(await collectMedia(history({ url }), config(), logs), []);
  assert.ok(Date.now() - started < 5000, 'timeout must cover reading the body, not just fetching headers');
  assertSafeDiagnostic(logs, /超时|timeout|timed out/i, [url, 'private-timeout-token', 'stalled.jpg']);
});

test('collectMedia: misnamed JPEG GIF extracts frames, preserves dedupe and total-frame budget', async (t) => {
  if (!(await ffmpegReady())) return t.skip('ffmpeg/ffprobe 不可用');
  const gifUrl = 'https://download.invalid/frame-budget/actually-gif.jpg?token=private-gif-token';
  const staticUrl = 'https://download.invalid/frame-budget/static.png';
  let gifRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url === gifUrl) gifRequests += 1;
    return new Response(url === gifUrl ? GIF : PNG, { headers: { 'content-type': 'image/jpeg' } });
  });
  const rows = [
    ...history({ url: staticUrl }),
    ...history({ url: gifUrl }, { url: gifUrl }),
  ];
  const first = await collectMedia(rows, config({ totalFrames: 2 }));
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'gif');
  assert.equal(first[0].label, '动图1');
  assert.equal(first[0].frames.length, 2, 'GIF must not exceed the available total-frame budget');
  for (const frame of first[0].frames) {
    assert.ok(frame.startsWith('data:image/jpeg;base64,'));
    assert.equal(sniffMime(Buffer.from(frame.split(',')[1], 'base64')), 'image/jpeg');
  }
  const second = await collectMedia(rows, config({ totalFrames: 4 }));
  assert.equal(second.length, 2);
  assert.deepEqual(second.map((item) => item.kind), ['image', 'gif']);
  assert.equal(second[1].frames.length, 3, 'a smaller earlier budget must not truncate the parsed GIF cache');
  assert.equal(second.reduce((n, item) => n + (item.frames?.length || 1), 0), 4);
  assert.equal(gifRequests, 1, 'duplicates and subsequent collections reuse the same downloaded/parsed GIF');
});
