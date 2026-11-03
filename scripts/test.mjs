import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const files = [
  ...fs.readdirSync(path.join(root, 'test')).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(root, 'test', name)),
  ...fs.readdirSync(path.join(root, 'bot/test')).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join(root, 'bot/test', name)),
].sort();
// Never discover or load a developer's config.json or .env to run tests.
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, QQ_CONFIG: '', QQ_LOG_LEVEL: 'warn' },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
