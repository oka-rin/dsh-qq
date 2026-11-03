import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = path.resolve(import.meta.dirname, '../scripts/install-native.sh');
const source = fs.readFileSync(installer, 'utf8');
function run(args = [], options = {}) {
  // Tests NEVER run a consented installation or use an install-root override.
  const env = { ...process.env, BASH_ENV: '', ENV: '', NODE_OPTIONS: '', NODE_PATH: '', ...options.env };
  return spawnSync('/bin/bash', ['--noprofile', '--norc', installer, ...args], { encoding: 'utf8', env, cwd: options.cwd ?? import.meta.dirname });
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-native-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function rejected(args, pattern) {
  const result = run(args);
  assert.notEqual(result.status, 0, `unexpected success: ${args}`);
  assert.match(result.stderr, pattern);
}
function pythonBlock(after) {
  const start = source.indexOf(after);
  assert.notEqual(start, -1, `missing Python block: ${after}`);
  const bodyStart = source.indexOf("<<'PY'\n", start) + "<<'PY'\n".length;
  const end = source.indexOf('\nPY\n', bodyStart);
  assert.ok(end > bodyStart);
  return source.slice(bodyStart, end);
}

test('native installer is valid Bash', () => {
  const result = spawnSync('/bin/bash', ['-n', installer], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
test('default plan is offline, read-only and describes safe manual boundaries', t => {
  const dir = fixture(t);
  const before = fs.readdirSync(dir);
  const result = run([], { cwd: dir, env: { TMPDIR: path.join(dir, 'must-not-be-created') } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(dir), before);
  for (const text of ['PLAN ONLY', 'no writes', '127.0.0.1:3000', '127.0.0.1:3001/event', '127.0.0.1:5099', 'hookAutoLoad=false', 'upstream consent remains manual', 'No service starts/enables']) assert.ok(result.stdout.includes(text), text);
  // All network/package/account/staging/service commands occur after plan exits.
  const planExit = source.indexOf('\nfi\n((confirmed))');
  assert.ok(planExit > source.indexOf('if [[ $mode == plan ]]'));
  for (const text of ['work=$(mktemp', '\n  apt-get update', '\ncurl --disable --fail', '\ngroupadd --system', '\nsystemctl daemon-reload']) assert.ok(source.indexOf(text) > planExit, text);
});
test('QQ sandbox weakening is opt-in and clearly visible in the plan', () => {
  assert.match(run().stdout, /QQ sandbox disabled: 0/);
  const result = run(['--plan', '--qq-no-sandbox']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /QQ sandbox disabled: 1/);
  assert.match(result.stdout, /WARNING: .*disables the QQ Chromium sandbox/);
  assert.match(source, /if \(\(qq_no_sandbox\)\); then qq_flags\+=' --no-sandbox'; fi/);
});
test('explicit plan validates existing inputs without modifying them', t => {
  const dir = fixture(t);
  const archive = path.join(dir, 'full.tar.gz');
  const qq = path.join(dir, 'QQ');
  fs.writeFileSync(archive, 'not downloaded or extracted in plan mode');
  fs.mkdirSync(qq);
  fs.writeFileSync(path.join(qq, 'qq'), 'fixture, must never execute');
  const result = run(['--plan', '--version', 'v2.4.0', '--archive', archive, '--qq-dir', qq, '--with-vnc', '--install-deps', '--no-start']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(archive, 'utf8'), 'not downloaded or extracted in plan mode');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['QQ', 'full.tar.gz']);
  assert.deepEqual(fs.readdirSync(qq), ['qq']);
});
test('machine authorization, explicit version and original QQ are separate fail-closed gates', () => {
  rejected(['--install'], /requires --confirm-install/);
  rejected(['--install', '--version', 'v2.4.0'], /requires --confirm-install/);
  rejected(['--install', '--confirm-install'], /requires explicit --version/);
  rejected(['--install', '--confirm-install', '--version', 'v2.4.0'], /requires --qq-dir or --qq-deb/);
  // These rejected invocations never reach OS checks or any modifying command.
});
test('unsafe, unknown, ambiguous and unpinned arguments are rejected', () => {
  for (const arg of ['relative.tar.gz', '/', '/tmp/../etc/passwd', '/tmp/./qq', '/tmp//qq', '/tmp/qq/', '/tmp/qq file', '/tmp/qq;touch', '/tmp/qq\nx']) rejected(['--archive', arg], /absolute path|dot path/);
  for (const args of [['--archive'], ['--qq-dir'], ['--qq-deb'], ['--version']]) rejected(args, /requires a value/);
  rejected(['--version', 'latest'], /reviewed explicit/);
  rejected(['--version', 'v2.4.0', '--version', 'v2.4.0'], /duplicate/);
  rejected(['--plan', '--install'], /choose only one/);
  rejected(['--start'], /unknown option/);
  rejected(['--accept-eula'], /unknown option/);
  rejected(['--prefix', '/tmp/native'], /unknown option/);
  rejected(['--qq-deb-sha256', 'bad'], /64 hexadecimal/);
  rejected(['--qq-deb-sha256', 'a'.repeat(64)], /requires --qq-deb/);
  rejected(['--qq-deb', '/tmp/no-such-native-qq.deb'], /requires --qq-deb-sha256/);
});
test('symlink files and symlink ancestors cannot redirect privileged input handling', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'real.tar.gz'), 'fixture');
  fs.symlinkSync(path.join(dir, 'real.tar.gz'), path.join(dir, 'link.tar.gz'));
  fs.mkdirSync(path.join(dir, 'real'));
  fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
  rejected(['--archive', path.join(dir, 'link.tar.gz')], /rejects symlink/);
  rejected(['--qq-dir', path.join(dir, 'alias')], /rejects symlink/);
  rejected(['--archive', path.join(dir, 'alias', 'missing.tar.gz')], /rejects symlink/);
});
test('archive verifier pins official full asset and requires API SHA256', t => {
  const dir = fixture(t);
  const release = path.join(dir, 'release.json');
  const code = pythonBlock('python3 - "$work/release.json"');
  const asset = 'SnowLuma-v2.4.0-linux-x64.tar.gz';
  const value = { tag_name: 'v2.4.0', draft: false, prerelease: false, assets: [{ name: asset, digest: `sha256:${'a'.repeat(64)}`, browser_download_url: `https://github.com/SnowLuma/SnowLuma/releases/download/v2.4.0/${asset}` }] };
  function verify(body) {
    fs.writeFileSync(release, JSON.stringify(body));
    return spawnSync('python3', ['-c', code, release, 'v2.4.0', asset], { encoding: 'utf8' });
  }
  assert.equal(verify(value).status, 0);
  assert.notEqual(verify({ ...value, tag_name: 'v2.3.4' }).status, 0);
  assert.notEqual(verify({ ...value, draft: true }).status, 0);
  assert.notEqual(verify({ ...value, assets: [{ ...value.assets[0], digest: null }] }).status, 0);
  assert.notEqual(verify({ ...value, assets: [{ ...value.assets[0], browser_download_url: 'https://evil.test/full.tar.gz' }] }).status, 0);
  assert.notEqual(verify({ ...value, assets: [...value.assets, ...value.assets] }).status, 0);
});
test('tar precheck rejects traversal, absolute, hardlink, devices, escaping links and link parents', t => {
  const dir = fixture(t);
  const code = pythonBlock('extract_tar()');
  const creator = `import io,json,sys,tarfile\nwith tarfile.open(sys.argv[1], 'w') as t:\n for e in json.loads(sys.argv[2]):\n  m=tarfile.TarInfo(e['name']); kind=e.get('kind','file')\n  if kind=='symlink': m.type=tarfile.SYMTYPE; m.linkname=e['target']; t.addfile(m)\n  elif kind=='hardlink': m.type=tarfile.LNKTYPE; m.linkname=e['target']; t.addfile(m)\n  elif kind=='device': m.type=tarfile.CHRTYPE; t.addfile(m)\n  else: m.size=2; m.mode=0o6755; t.addfile(m,io.BytesIO(b'ok'))\n`;
  let index = 0;
  function extract(entries, prefix = '') {
    const tar = path.join(dir, `case-${index}.tar`);
    const output = path.join(dir, `output-${index++}`);
    const made = spawnSync('python3', ['-c', creator, tar, JSON.stringify(entries)], { encoding: 'utf8' });
    assert.equal(made.status, 0, made.stderr);
    return { ...spawnSync('python3', ['-c', code, tar, output, prefix], { encoding: 'utf8' }), output };
  }
  for (const entries of [
    [{ name: '../escaped' }], [{ name: '/absolute' }], [{ name: 'bad\\path' }],
    [{ name: 'file', kind: 'hardlink', target: 'other' }], [{ name: 'dev', kind: 'device' }],
    [{ name: 'link', kind: 'symlink', target: '../outside' }],
    [{ name: 'link', kind: 'symlink', target: '/etc' }],
    [{ name: 'link', kind: 'symlink', target: 'safe' }, { name: 'link/file' }],
    [{ name: 'duplicate' }, { name: 'duplicate' }],
  ]) assert.notEqual(extract(entries).status, 0, JSON.stringify(entries));
  const good = extract([{ name: 'sub/file' }, { name: 'local-link', kind: 'symlink', target: 'sub/file' }]);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(fs.readFileSync(path.join(good.output, 'local-link'), 'utf8'), 'ok');
  assert.equal(fs.statSync(path.join(good.output, 'sub/file')).mode & 0o7777, 0o755);
  assert.equal(fs.existsSync(path.join(dir, 'escaped')), false);
  const deb = extract([{ name: './opt/QQ/qq' }, { name: './usr/bin/qq', kind: 'symlink', target: '/opt/QQ/qq' }], 'opt/QQ');
  assert.equal(deb.status, 0, deb.stderr);
  assert.equal(fs.readFileSync(path.join(deb.output, 'opt/QQ/qq'), 'utf8'), 'ok');
  assert.equal(fs.existsSync(path.join(deb.output, 'usr')), false);
});
test('published code is traversable after cp preserves private source directory modes', t => {
  const dir = fixture(t);
  const bundle = path.join(dir, 'bundle'), qq = path.join(dir, 'QQ'), runtime = path.join(dir, 'runtime');
  fs.mkdirSync(bundle, { mode: 0o700 });
  fs.mkdirSync(path.join(bundle, 'native'), { mode: 0o700 });
  fs.mkdirSync(qq, { mode: 0o700 });
  fs.mkdirSync(runtime, { mode: 0o755 });
  fs.writeFileSync(path.join(bundle, 'node'), '#!/bin/sh\nprintf "fixture node\\n"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bundle, 'check-node-version.cjs'), 'fixture checker', { mode: 0o644 });
  fs.writeFileSync(path.join(bundle, 'native/hook.so'), 'fixture addon', { mode: 0o644 });
  fs.chmodSync(path.join(bundle, 'native/hook.so'), 0o666);
  fs.writeFileSync(path.join(qq, 'qq'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(path.join(qq, 'qq'), 0o6755);
  for (const [from, to] of [[bundle, runtime], [qq, path.join(runtime, 'qq')]]) {
    fs.mkdirSync(to, { recursive: true, mode: 0o755 });
    const copied = spawnSync('cp', ['-a', '--no-preserve=ownership,xattr', '--', `${from}/.`, `${to}/`], { encoding: 'utf8' });
    assert.equal(copied.status, 0, copied.stderr);
    assert.equal(fs.statSync(to).mode & 0o7777, 0o700, 'cp must reproduce the private-root regression');
  }
  // Exercise the actual publication hardening; ownership is deliberately mocked
  // so this fixture requires neither root nor any persistent installation change.
  const code = `import os\nos.chown = lambda p, uid, gid, **kw: None\n${pythonBlock('python3 - "$runtime"')}`;
  const hardened = spawnSync('python3', ['-c', code, runtime], { encoding: 'utf8' });
  assert.equal(hardened.status, 0, hardened.stderr);
  for (const name of ['', 'native', 'qq']) assert.equal(fs.statSync(path.join(runtime, name)).mode & 0o7777, 0o755, name);
  for (const name of ['check-node-version.cjs', 'native/hook.so']) assert.equal(fs.statSync(path.join(runtime, name)).mode & 0o7777, 0o644, name);
  for (const name of ['node', 'qq/qq']) assert.equal(fs.statSync(path.join(runtime, name)).mode & 0o7777, 0o755, name);
  const executed = spawnSync(path.join(runtime, 'node'), [], { encoding: 'utf8' });
  assert.equal(executed.status, 0, executed.stderr);
  assert.equal(executed.stdout, 'fixture node\n');
});
test('generated initial config uses private fresh token, loopback and disabled auto-injection', t => {
  const dir = fixture(t);
  const code = pythonBlock('python3 - "$home/gateway/config"').split('subprocess.run(')[0];
  const tokens = [];
  for (let index = 0; index < 2; index++) {
    const root = path.join(dir, `config-${index}`); fs.mkdirSync(root);
    const result = spawnSync('python3', ['-c', code, root, path.join(dir, '.Xauthority')], { encoding: 'utf8', env: { ...process.env } });
    assert.equal(result.status, 0, result.stderr);
    const onebot = JSON.parse(fs.readFileSync(path.join(root, 'onebot.json')));
    const runtime = JSON.parse(fs.readFileSync(path.join(root, 'runtime.json')));
    assert.deepEqual(runtime, { webuiPort: 5099, hookAutoLoad: false });
    const http = onebot.networks.httpServers[0], ws = onebot.networks.wsServers[0];
    assert.equal(http.host, '127.0.0.1'); assert.equal(ws.host, '127.0.0.1');
    assert.equal(http.port, 3000); assert.equal(ws.port, 3001); assert.equal(ws.path, '/event');
    assert.match(http.accessToken, /^[a-f0-9]{64}$/); assert.equal(http.accessToken, ws.accessToken);
    tokens.push(http.accessToken);
    assert.deepEqual(onebot.networks.httpClients, []); assert.deepEqual(onebot.networks.wsClients, []);
  }
  assert.notEqual(tokens[0], tokens[1]);
  assert.match(source, /chmod 0600 "\$home\/gateway\/config\/onebot\.json"/);
});
test('service safety boundaries remain explicit and upstream consent is not manufactured', () => {
  assert.match(source, /AmbientCapabilities=CAP_SYS_PTRACE/);
  assert.equal(source.match(/AmbientCapabilities=CAP_SYS_PTRACE/g)?.length, 1);
  assert.match(source, /User=snowluma/); assert.match(source, /Group=snowluma/);
  assert.match(source, /WorkingDirectory=\/var\/lib\/snowluma\/gateway/);
  assert.match(source, /ExecStart=\/opt\/snowluma\/node \/opt\/snowluma\/index\.mjs/);
  assert.match(source, /Environment=SNOWLUMA_WEBUI_HOST=127\.0\.0\.1/);
  assert.match(source, /UnsetEnvironment=SNOWLUMA_ACCEPT_EULA SNOWLUMA_ACCEPT_PRIVACY/);
  assert.match(source, /-localhost -rfbport 5901 -rfbauth/);
  assert.match(source, /Xvfb :99 .* -nolisten tcp -auth/);
  assert.doesNotMatch(source, /SNOWLUMA_ACCEPT_(?:EULA|PRIVACY)=1/);
  assert.doesNotMatch(source, /^\s*(?:dpkg -i|setcap\s|sysctl\s|docker\s+(?:stop|rm|compose|volume))/m);
  assert.doesNotMatch(source, /^\s*systemctl (?:start|restart|enable|stop|disable)\b/m);
  assert.doesNotMatch(source, /IPAddressDeny=any/);
  assert.doesNotMatch(source, /snowluma-qq\.service/);
  assert.match(source, /refusing existing destination/);
  assert.match(source, /refusing existing unit/);
});
