import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const botManifest = JSON.parse(fs.readFileSync(path.join(root, 'bot/package.json'), 'utf8'));
assert.equal(manifest.version, '0.5.0', 'Unexpected release version');
assert.equal(botManifest.version, manifest.version, 'Bot and plugin versions must match');
// npm excludes package-lock.json from published tarballs; audit it only in source checkouts.
if (fs.existsSync(path.join(root, 'package-lock.json'))) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.version, manifest.version, 'Lockfile and plugin versions must match');
  assert.equal(lock.packages[''].version, manifest.version, 'Lockfile root and plugin versions must match');
}
assert.ok(manifest.files.includes('setup.js'), 'Setup module must be explicitly allowlisted');
assert.ok(manifest.files.includes('docs/advanced.md'), 'Advanced documentation must be explicitly allowlisted');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 8 * 1024 * 1024,
});
assert.equal(result.status, 0, 'npm pack --dry-run failed; inspect npm diagnostics locally');
const [pack] = JSON.parse(result.stdout);
const files = pack.files.map((entry) => entry.path);
const allowed = /^(?:package\.json|README\.md|docs\/(?:advanced|native)\.md|LICENSE|icon\.svg|index\.js|client\.js|runtime\.js|setup\.js|login\.js|login-worker\.js|login-http\.js|desktop-client\.js|desktop\.js|assets\/(?:desktop-viewer\.js|THIRD-PARTY\.txt|licenses\/[^/]+)|deploy\/snowluma\.compose\.yml|cordis\.patch\.yml|locale\/(?:en|zh)\.json|bot\/(?:package\.json|config\.example\.json|snowluma-api-catalog\.json|src\/[^/]+\.mjs|test\/[^/]+\.test\.mjs)|scripts\/(?:[^/]+\.mjs|install-native\.sh)|test\/[^/]+\.test\.mjs)$/;
assert.deepEqual(files.filter((file) => !allowed.test(file)), [], 'Unexpected files in npm distribution');
for (const required of [
  'index.js', 'client.js', 'runtime.js', 'setup.js', 'login.js', 'login-worker.js', 'login-http.js', 'desktop-client.js', 'desktop.js', 'assets/desktop-viewer.js', 'assets/THIRD-PARTY.txt', 'assets/licenses/LICENSE.txt', 'docs/advanced.md', 'docs/native.md', 'scripts/install-native.sh', 'deploy/snowluma.compose.yml', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/zh.json',
  'bot/config.example.json', 'bot/package.json', 'bot/snowluma-api-catalog.json',
  'bot/src/index.mjs', 'bot/src/tools.mjs', 'bot/test/schema.test.mjs',
  'scripts/test.mjs', 'scripts/check-release.mjs', 'test/release.test.mjs',
]) assert.ok(files.includes(required), `Missing distribution file: ${required}`);

// Verify every static relative JS import is packed, including tests and scripts.
for (const file of files.filter((file) => /\.(?:mjs|js)$/.test(file))) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.ok(!/(?:\/root\/dsh-work\/|YOUR[_]NAME)/.test(source), `Local path or owner placeholder in ${file}`);
  for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2]));
    assert.ok(files.includes(target), `Unpacked import in ${file}: ${target}`);
  }
}
console.error(`Release distribution verified: ${files.length} files, ${pack.size} packed bytes; no private config/data paths.`);
