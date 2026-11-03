import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { CONFIG_SCHEMA, getByPath } from '../bot/src/schema.mjs';

const root = path.resolve(import.meta.dirname, '..');
const json = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

test('public example is complete, generic and opt-in', () => {
  const config = json('bot/config.example.json');
  for (const field of CONFIG_SCHEMA.flatMap((group) => group.fields)) {
    const value = getByPath(config, field.path);
    assert.notEqual(value, undefined, `Missing public example field ${field.path}`);
    if (field.type === 'secret') assert.equal(value, '', `Example secret ${field.path} must be empty`);
  }
  for (const key of ['chat.enabled', 'chat.replyPrivate', 'chat.proactiveInterject.enabled',
    'chat.qzone.enabled', 'chat.learn.enabled', 'chat.learn.embedding.enabled', 'chat.draw.enabled',
    'chat.memeCollect.enabled', 'image.enabled', 'agent.enabled', 'share.enabled', 'dailyNews.enabled',
    'agent.allowDestructive']) assert.equal(getByPath(config, key), false, `${key} must be opt-in`);
  assert.deepEqual(config.agent.targets, []);
  assert.deepEqual(config.agent.groups, []);
  assert.deepEqual(config.share.groups, []);
  assert.equal(config.control.host, '127.0.0.1');
  for (const key of ['llm', 'image']) assert.equal(new URL(config[key].baseUrl).hostname, 'api.example.com');
  assert.equal(new URL(config.chat.learn.embedding.baseUrl).hostname, 'api.example.com');
  assert.equal(config.storage.dataDir, './data');
});

test('external backend template uses loopback ports and preserves named volumes', () => {
  const compose = fs.readFileSync(path.join(root, 'deploy/snowluma.compose.yml'), 'utf8');
  assert.match(compose, /SNOWLUMA_IMAGE:\?/);
  const portLines = compose.split('\n').filter((line) => /\d+\}:\d+"/.test(line));
  assert.equal(portLines.length, 4);
  for (const line of portLines) assert.match(line, /127\.0\.0\.1:/);
  for (const volume of ['qq-gateway-data', 'qq-client-config', 'qq-client-data']) {
    assert.ok(compose.includes(`name: ${volume}`));
  }
  assert.ok(!compose.includes('privileged: true'));
});

test('manifest exports display resources with real localized metadata', () => {
  const manifest = json('package.json');
  assert.equal(manifest.exports['./icon'], './icon.svg');
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
  assert.equal(manifest.license, 'MIT');
  assert.equal(json('bot/package.json').license, 'MIT');
  const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert.match(license, /^MIT License\n/);
  assert.match(license, /Permission is hereby granted, free of charge/);
  for (const name of ['repository', 'homepage', 'bugs']) assert.equal(manifest[name], undefined);
  for (const locale of ['en', 'zh']) {
    const metadata = json(`locale/${locale}.json`).meta;
    assert.ok(metadata.title);
    assert.ok(metadata.description);
  }
  const icon = fs.readFileSync(path.join(root, 'icon.svg'), 'utf8');
  assert.match(icon, /<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(Buffer.byteLength(icon) <= 256 * 1024);
  assert.ok(!/<(?:script|foreignObject|image)\b|(?:href|onload)=/.test(icon));
});
