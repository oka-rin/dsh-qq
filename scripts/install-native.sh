#!/usr/bin/env bash
# Reviewed bootstrap for the ORIGINAL upstream distribution, not a repackaged gateway.
# This file contains no SnowLuma/QQ bytes and never accepts their licenses for you.
set -euo pipefail
# Do not inherit package-manager hooks, shell startup files or upstream consent flags.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
unset PYTHONPATH PYTHONHOME PYTHONOPTIMIZE PYTHONSTARTUP CURL_CA_BUNDLE SSL_CERT_FILE SSL_CERT_DIR
umask 077

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: bash scripts/install-native.sh [--plan] [options]
       sudo bash scripts/install-native.sh --install --confirm-install --version v2.4.0 \
         --qq-dir /absolute/original/QQ [--archive /absolute/full.tar.gz]

Default: --plan (read-only, offline, no temporary files or package/system changes).
  --install             Prepare a NEW native deployment; never starts/enables it.
  --confirm-install     Required authorization for machine changes, NOT EULA consent.
  --version v2.4.0       Explicit reviewed upstream release; no implicit latest.
  --archive /absolute   Optional official FULL Linux tar.gz; always verify its SHA256
                        against HTTPS GitHub API metadata for the exact release.
  --qq-dir /absolute    Existing original QQ directory containing executable 'qq'.
  --qq-deb /absolute    Original QQ .deb obtained/reviewed by you; extracted WITHOUT
                        package scripts, not installed globally (never runs dpkg -i).
  --qq-deb-sha256 HEX    Required with --qq-deb: checksum from your trusted source.
  --install-deps        Permit apt-get update/install of OS dependencies if needed.
  --with-vnc            Add optional password-protected, loopback-only x11vnc unit.
  --qq-no-sandbox       Explicitly weaken QQ Chromium sandbox if user namespaces
                        are unavailable. Not default; review this security tradeoff.
  --no-start            Explicit spelling of the default; no --start mode exists.
  --help                Show this explanation.

Requires Python >=3.9 (Debian 11+/Ubuntu 22.04+), systemd, x64 or arm64.
Targets: /opt/snowluma (root-owned bundled Node + original runtime + QQ copy),
/var/lib/snowluma (HOME/config/data), snowluma non-login account, systemd units
snowluma.target, snowluma-{xvfb,fluxbox,client,gateway}.service (+ vnc if requested).
Existing destinations/account/units cause refusal: this is NOT an upgrader/migrator.
No Docker/volume changes, hosts/sysctl changes, global Node capabilities or autoaccept.
Upstream EULA/privacy, original QQ license/provenance and QQ version compatibility
must be reviewed separately. --confirm-install does not assert those agreements.
Review https://github.com/SnowLuma/SnowLuma/releases/tag/v2.4.0 before installation.
HELP
}
mode=plan; seen_mode=; confirmed=0; version=; archive=; qq_dir=; qq_deb=; qq_hash=; deps=0; vnc=0; qq_no_sandbox=0
need_value() { [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail "$1 requires a value"; }
# Conservative path alphabet also keeps generated systemd ExecStart fields literal.
absolute_path() {
  [[ $2 == /* && $2 != / && $2 =~ ^/[A-Za-z0-9_./+-]+$ && $2 != */ && $2 != *//* ]] || fail "$1 requires a simple absolute path (no whitespace/control characters)"
  [[ /${2#/}/ != */../* && /${2#/}/ != */./* ]] || fail "$1 rejects dot path components"
  local p=$2
  while [[ $p != / ]]; do [[ ! -L $p ]] || fail "$1 rejects symlink paths: $p"; p=${p%/*}; [[ -n $p ]] || p=/; done
}
while (($#)); do
  case $1 in
    --help|-h) usage; exit 0 ;;
    --plan|--install)
      [[ -z $seen_mode || $seen_mode == "$1" ]] || fail 'choose only one of --plan and --install'
      seen_mode=$1; mode=${1#--}; shift ;;
    --confirm-install) confirmed=1; shift ;;
    --version) need_value "$@"; [[ -z $version ]] || fail 'duplicate --version'; version=$2; shift 2 ;;
    --archive) need_value "$@"; [[ -z $archive ]] || fail 'duplicate --archive'; absolute_path "$1" "$2"; archive=$2; shift 2 ;;
    --qq-dir) need_value "$@"; [[ -z $qq_dir ]] || fail 'duplicate --qq-dir'; absolute_path "$1" "$2"; qq_dir=$2; shift 2 ;;
    --qq-deb) need_value "$@"; [[ -z $qq_deb ]] || fail 'duplicate --qq-deb'; absolute_path "$1" "$2"; qq_deb=$2; shift 2 ;;
    --qq-deb-sha256) need_value "$@"; [[ -z $qq_hash ]] || fail 'duplicate --qq-deb-sha256'; qq_hash=${2,,}; shift 2 ;;
    --install-deps) deps=1; shift ;;
    --with-vnc) vnc=1; shift ;;
    --qq-no-sandbox) qq_no_sandbox=1; shift ;;
    --no-start) shift ;;
    *) fail "unknown option: $1" ;;
  esac
done
[[ -z $version || $version == v2.4.0 ]] || fail 'only the reviewed explicit --version v2.4.0 is supported'
[[ -z $qq_dir || -z $qq_deb ]] || fail 'choose --qq-dir OR --qq-deb'
[[ -z $qq_hash || $qq_hash =~ ^[a-f0-9]{64}$ ]] || fail '--qq-deb-sha256 must contain 64 hexadecimal characters'
[[ -z $qq_hash || -n $qq_deb ]] || fail '--qq-deb-sha256 requires --qq-deb'
[[ -z $qq_deb || -n $qq_hash ]] || fail '--qq-deb requires --qq-deb-sha256 from a separately trusted source'
[[ -z $archive || -f $archive ]] || fail '--archive must name an existing regular file'
[[ -z $qq_deb || -f $qq_deb ]] || fail '--qq-deb must name an existing regular file'
[[ -z $qq_dir || -d $qq_dir ]] || fail '--qq-dir must name an existing directory'
if [[ $mode == plan ]]; then
  printf '%s\n' 'PLAN ONLY: no writes, network requests, installs or service operations.'
  printf 'Release: %s; source: %s\nQQ source: %s\n' "${version:-NOT SELECTED (required for --install)}" "${archive:-official GitHub FULL bundle}" "${qq_dir:-${qq_deb:-NOT SELECTED (required for --install)}}"
  printf 'Optional apt dependency authorization: %s; optional local VNC: %s; QQ sandbox disabled: %s\n' "$deps" "$vnc" "$qq_no_sandbox"
  ((qq_no_sandbox == 0)) || printf '%s\n' 'WARNING: --qq-no-sandbox disables the QQ Chromium sandbox; use only after security review.'
  printf '%s\n' 'Would verify official SHA256, validate archives, create root-owned /opt/snowluma,' 'create non-root snowluma HOME=/var/lib/snowluma and NEW systemd units only.' 'OneBot HTTP 127.0.0.1:3000, WS 127.0.0.1:3001/event; WebUI 127.0.0.1:5099.' 'Fresh private token, hookAutoLoad=false. No service starts/enables; upstream consent remains manual.' 'No Docker/container/volume removal, data migration, EULA autoaccept or global setcap/sysctl/hosts changes.'
  exit 0
fi
((confirmed)) || fail '--install requires --confirm-install (machine changes only, not upstream consent)'
[[ $version == v2.4.0 ]] || fail '--install requires explicit --version v2.4.0'
[[ -n $qq_dir || -n $qq_deb ]] || fail '--install requires --qq-dir or --qq-deb; QQ is never downloaded by this script'
((EUID == 0)) || fail '--install requires root'
[[ -f /etc/debian_version && -d /run/systemd/system ]] || fail 'requires Debian/Ubuntu booted with systemd'
case $(uname -m) in x86_64) arch=x64; deb_arch=amd64 ;; aarch64|arm64) arch=arm64; deb_arch=arm64 ;; *) fail 'supported architectures: x86_64 and arm64' ;; esac
runtime=/opt/snowluma; home=/var/lib/snowluma
units=(snowluma.target snowluma-xvfb.service snowluma-fluxbox.service snowluma-client.service snowluma-gateway.service snowluma-vnc.service)
for p in /opt /var/lib /etc/systemd/system /run; do absolute_path target "$p"; [[ -d $p ]] || fail "missing target parent: $p"; done
for p in "$runtime" "$home" /run/snowluma-hook; do [[ ! -e $p && ! -L $p ]] || fail "refusing existing destination: $p"; done
for unit in "${units[@]}"; do
  for base in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system /lib/systemd/system; do
    [[ ! -e $base/$unit && ! -L $base/$unit && ! -e $base/$unit.d ]] || fail "refusing existing unit: $base/$unit"
  done
done
! getent passwd snowluma >/dev/null || fail 'snowluma account already exists; manual migration/review required'
! getent group snowluma >/dev/null || fail 'snowluma group already exists; manual migration/review required'
[[ ! -e /tmp/.X99-lock && ! -S /tmp/.X11-unix/X99 ]] || fail 'X display :99 already in use; review manually'
packages=(python3 ca-certificates curl passwd ffmpeg xvfb xauth fluxbox dbus-x11 libnss3 libnspr4 libasound2 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 fonts-noto-cjk)
# Debian 13 / Ubuntu 24.04 rename several libraries for time_t64. Resolve only
# from the already configured apt repositories; no third-party repo is added.
for i in "${!packages[@]}"; do
  package=${packages[$i]}
  case $package in libasound2|libatk1.0-0|libatk-bridge2.0-0|libcups2|libgtk-3-0)
    if [[ $(dpkg-query -W -f='${Status}' "${package}t64" 2>/dev/null || true) == 'install ok installed' ]] || apt-cache show "${package}t64" 2>/dev/null | /usr/bin/grep -q '^Package:'; then packages[$i]=${package}t64; fi
  esac
done
((vnc == 0)) || packages+=(x11vnc)
missing=()
for package in "${packages[@]}"; do
  status=$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)
  [[ $status == 'install ok installed' ]] || missing+=("$package")
done
if ((${#missing[@]})); then
  ((deps)) || fail "missing OS dependencies: ${missing[*]}; review and re-run with --install-deps to permit apt"
  # No --yes for upstream software: this authorizes OS dependencies only.
  apt-get update
  apt-get install --yes --no-install-recommends "${missing[@]}"
fi
for command in python3 curl dpkg-deb useradd groupadd systemctl Xvfb xauth fluxbox dbus-run-session; do command -v "$command" >/dev/null || fail "missing command: $command"; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' || fail 'Python >=3.9 required (Debian 11+/Ubuntu 22.04+); no Python upgrade is attempted'
work=$(mktemp -d /var/tmp/dsh-snowluma-install.XXXXXXXX)
cleanup() {
  # Only remove the exact root-owned mktemp workspace, never computed install paths.
  if [[ ${work:-} == /var/tmp/dsh-snowluma-install.* && -d $work && ! -L $work && $(stat -c %u "$work") == 0 && $(realpath -- "$work") == "$work" ]]; then rm -rf -- "$work"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s\n' 'Downloading official release metadata; refusing missing/mismatched SHA256.'
asset="SnowLuma-${version}-linux-${arch}.tar.gz"
curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 120 \
  "https://api.github.com/repos/SnowLuma/SnowLuma/releases/tags/$version" -o "$work/release.json"
python3 - "$work/release.json" "$version" "$asset" >"$work/asset" <<'PY'
import json, re, sys
release = json.load(open(sys.argv[1]))
assert release['tag_name'] == sys.argv[2] and not release['draft'] and not release['prerelease'], 'unexpected release'
assets = [a for a in release['assets'] if a['name'] == sys.argv[3]]
assert len(assets) == 1, 'missing/ambiguous official full distribution'
a = assets[0]
assert re.fullmatch(r'sha256:[a-f0-9]{64}', a.get('digest', '')), 'GitHub API SHA256 unavailable'
assert a['browser_download_url'] == f'https://github.com/SnowLuma/SnowLuma/releases/download/{sys.argv[2]}/{sys.argv[3]}', 'unexpected download origin'
print(a['digest'][7:]); print(a['browser_download_url'])
PY
mapfile -t asset_info <"$work/asset"
if [[ -n $archive ]]; then cp -- "$archive" "$work/full.tar.gz"; else
  curl --disable --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --connect-timeout 20 --max-time 900 "${asset_info[1]}" -o "$work/full.tar.gz"
fi
printf '%s  %s\n' "${asset_info[0]}" "$work/full.tar.gz" | sha256sum --check --status || fail 'archive does not match official GitHub API SHA256'
# Manual extraction: no absolute paths, traversal, devices, hardlinks or writes via
# symlink parents; links must resolve entirely inside this private staging tree.
extract_tar() {
  python3 - "$1" "$2" "${3:-}" <<'PY'
import os, pathlib, shutil, sys, tarfile
root = pathlib.Path(sys.argv[2]); root.mkdir(mode=0o700)
with tarfile.open(sys.argv[1], 'r:*') as tar:
    members = tar.getmembers()
    # A .deb may include absolute /usr/bin/qq links and desktop integration.
    # They are NOT installed: copy only the original /opt/QQ application tree.
    prefix = pathlib.PurePosixPath(sys.argv[3]).parts if len(sys.argv) > 3 and sys.argv[3] else ()
    if prefix: members = [m for m in members if pathlib.PurePosixPath(m.name).parts[:len(prefix)] == prefix]
    assert members, 'empty application archive'
    names = set(); links = set()
    assert len(members) <= 100000 and sum(m.size for m in members) <= 4 * 1024**3, 'archive too large'
    for m in members:
        p = pathlib.PurePosixPath(m.name)
        assert not p.is_absolute() and '..' not in p.parts and '\\' not in m.name and not any(ord(c) < 32 for c in m.name), 'unsafe archive path'
        name = str(p)
        if name == '.':
            assert m.isdir(); continue
        assert name not in names, 'duplicate archive path'; names.add(name)
        assert m.isdir() or m.isfile() or m.issym(), 'unsupported archive entry (including hardlinks)'
        if m.issym(): links.add(name)
    for m in members:
        p = pathlib.PurePosixPath(m.name)
        assert not any(str(a) in links for a in p.parents), 'archive symlink parent'
        if m.issym():
            target = pathlib.Path(os.path.normpath(str(root / p.parent / m.linkname)))
            assert not pathlib.PurePosixPath(m.linkname).is_absolute() and target.is_relative_to(root), 'escaping symlink'
    for m in members:
        p = root / m.name
        if m.isdir(): p.mkdir(parents=True, exist_ok=True); os.chmod(p, 0o755)
        elif m.isfile():
            p.parent.mkdir(parents=True, exist_ok=True)
            with tar.extractfile(m) as src, p.open('xb') as dst: shutil.copyfileobj(src, dst)
            os.chmod(p, 0o755 if m.mode & 0o111 else 0o644)
        else:
            p.parent.mkdir(parents=True, exist_ok=True); p.symlink_to(m.linkname)
    for p in root.rglob('*'):
        assert p.resolve().is_relative_to(root.resolve()), 'escaping chained link'
PY
}
extract_tar "$work/full.tar.gz" "$work/bundle"
# Only known original layouts are accepted; no find/guessing executables.
bundle=
for candidate in "$work/bundle" "$work/bundle/SnowLuma" "$work/bundle/SnowLuma-${version}-linux-${arch}"; do
  if [[ -f $candidate/launcher.sh && -f $candidate/index.mjs && -x $candidate/node && ! -L $candidate/node ]]; then
    [[ -z $bundle ]] || fail 'ambiguous full distribution layout'; bundle=$candidate
  fi
done
[[ -n $bundle && -f $bundle/check-node-version.cjs ]] || fail 'unrecognized full bundle layout or missing dedicated Node/version checker'
[[ -f $bundle/EULA.md && -f $bundle/PRIVACY.md ]] || fail 'original upstream license documents missing'
# Never execute distribution code as root, including the bundled version checker.
# It is run by the gateway service as snowluma, not during privileged extraction.
if [[ -n $qq_deb ]]; then
  cp -- "$qq_deb" "$work/qq.deb"
  printf '%s  %s\n' "$qq_hash" "$work/qq.deb" | sha256sum --check --status || fail 'QQ .deb SHA256 mismatch'
  [[ $(dpkg-deb -f "$work/qq.deb" Architecture) == "$deb_arch" ]] || fail 'QQ .deb architecture mismatch'
  [[ $(dpkg-deb -f "$work/qq.deb" Package) == linuxqq ]] || fail 'expected original linuxqq package'
  dpkg-deb --fsys-tarfile "$work/qq.deb" >"$work/qq.tar"
  extract_tar "$work/qq.tar" "$work/qq-extracted" 'opt/QQ'
  qq_dir=$work/qq-extracted/opt/QQ
fi
[[ -f $qq_dir/qq && -x $qq_dir/qq && ! -L $qq_dir/qq ]] || fail 'original QQ directory must contain executable regular qq'
# Do not import malicious symlinks/devices or writable, non-root-controlled code
# into a ptrace-capable service. Provenance/version still requires human review.
python3 - "$qq_dir" "$bundle" <<'PY'
import os, pathlib, stat, sys
for arg in sys.argv[1:]:
    root = pathlib.Path(arg).resolve()
    for p in [root, *root.rglob('*')]:
        s = p.lstat()
        assert stat.S_ISREG(s.st_mode) or stat.S_ISDIR(s.st_mode) or stat.S_ISLNK(s.st_mode), f'unsafe special entry: {p}'
        assert p.resolve().is_relative_to(root), f'escaping symlink: {p}'
        assert s.st_uid == 0 and (stat.S_ISLNK(s.st_mode) or not s.st_mode & 0o022), f'code must be root-owned and not group/world writable: {p}'
    for p in root.parents:
        s = p.stat()
        assert s.st_uid == 0 and (not s.st_mode & 0o022 or s.st_mode & stat.S_ISVTX), f'unsafe writable source parent: {p}'
    if arg == sys.argv[2]:
        assert not (root / 'config').exists() and not (root / 'data').exists(), 'bundle contains existing state'
PY
# All source validation is finished before publishing anything persistent.
# No rollback deletes user data: an interrupted publication requires manual review.
[[ ! -e $runtime && ! -L $runtime && ! -e $home && ! -L $home ]] || fail 'destination appeared during validation'
groupadd --system snowluma
useradd --system --gid snowluma --home-dir "$home" --no-create-home --shell /usr/sbin/nologin snowluma
install -d -m 0755 "$runtime"
cp -a --no-preserve=ownership,xattr -- "$bundle/." "$runtime/"
install -d -m 0755 "$runtime/qq"
cp -a --no-preserve=ownership,xattr -- "$qq_dir/." "$runtime/qq/"
# Keep code immutable to the service account, with no setuid/setgid copy.
python3 - "$runtime" <<'PY'
import os, pathlib, sys
root = pathlib.Path(sys.argv[1])
for p in [root, *root.rglob('*')]:
    os.chown(p, 0, 0, follow_symlinks=False)
    if not p.is_symlink(): os.chmod(p, p.stat().st_mode & 0o755)
PY
install -d -o snowluma -g snowluma -m 0700 "$home" "$home/gateway" "$home/gateway/config" "$home/.config" "$home/.local" "$home/.local/share"
python3 - "$home/gateway/config" "$home/.Xauthority" <<'PY'
import json, pathlib, secrets, subprocess, sys
root = pathlib.Path(sys.argv[1]); token = secrets.token_hex(32)
base = dict(enabled=True, host='127.0.0.1', accessToken=token, messageFormat='array', reportSelfMessage=False)
config = dict(networks=dict(httpServers=[dict(base, name='http-default', port=3000, path='/')], wsServers=[dict(base, name='ws-default', port=3001, path='/event', role='Universal')], httpClients=[], wsClients=[]), musicSignUrl='')
for name, value in [('onebot.json', config), ('runtime.json', dict(webuiPort=5099, hookAutoLoad=False))]:
    with (root / name).open('x') as f: json.dump(value, f, indent=2); f.write('\n')
subprocess.run(['/usr/bin/xauth', '-f', sys.argv[2], 'add', ':99', '.', secrets.token_hex(16)], check=True)
PY
chown -R snowluma:snowluma "$home"
chmod 0600 "$home/gateway/config/onebot.json" "$home/gateway/config/runtime.json" "$home/.Xauthority"
# Shared ptrace hook socket directory; lifetime follows the display, not the gateway.
cat >"$work/snowluma-xvfb.service" <<'UNIT'
[Unit]
Description=SnowLuma private X display
PartOf=snowluma.target
[Service]
User=snowluma
Group=snowluma
Environment=HOME=/var/lib/snowluma
RuntimeDirectory=snowluma-hook
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -auth /var/lib/snowluma/.Xauthority
NoNewPrivileges=true
CapabilityBoundingSet=
Restart=on-failure
UMask=0077
UNIT
common_service() {
  cat <<'UNIT'
User=snowluma
Group=snowluma
Environment=HOME=/var/lib/snowluma
Environment=XDG_CONFIG_HOME=/var/lib/snowluma/.config
Environment=XDG_DATA_HOME=/var/lib/snowluma/.local/share
Environment=DISPLAY=:99
Environment=XAUTHORITY=/var/lib/snowluma/.Xauthority
Environment=SNOWLUMA_HOOK_RUNTIME_DIR=/run/snowluma-hook
UMask=0077
NoNewPrivileges=true
# Keep /tmp shared: QQ injection and X11 sockets must be visible across services.
# PrivateTmp would silently isolate the hook; only gateway receives ptrace capability.
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/snowluma /run/snowluma-hook /tmp
Restart=on-failure
RestartSec=5
UNIT
}
for kind in fluxbox client gateway; do
  {
    printf '[Unit]\nDescription=SnowLuma %s (original native runtime)\nRequires=snowluma-xvfb.service\nAfter=snowluma-xvfb.service\nPartOf=snowluma.target\n[Service]\n' "$kind"
    common_service
    case $kind in
      fluxbox) printf 'ExecStart=/usr/bin/fluxbox\nCapabilityBoundingSet=\n' ;;
      client)
        qq_flags='--disable-gpu --disable-software-rasterizer'
        if ((qq_no_sandbox)); then qq_flags+=' --no-sandbox'; fi
        printf 'WorkingDirectory=/opt/snowluma/qq\nExecStart=/usr/bin/dbus-run-session -- /opt/snowluma/qq/qq %s\nCapabilityBoundingSet=\n' "$qq_flags"
        ;;
      gateway)
        printf '%s\n' 'WorkingDirectory=/var/lib/snowluma/gateway' 'Environment=SNOWLUMA_WEBUI_HOST=127.0.0.1' 'Environment=SNOWLUMA_ONEBOT_HOST=127.0.0.1' 'Environment=SNOWLUMA_HOOK_AUTOLOAD=0' 'UnsetEnvironment=SNOWLUMA_ACCEPT_EULA SNOWLUMA_ACCEPT_PRIVACY NODE_OPTIONS NODE_PATH' 'ExecStartPre=/opt/snowluma/node /opt/snowluma/check-node-version.cjs' 'ExecStart=/opt/snowluma/node /opt/snowluma/index.mjs' 'AmbientCapabilities=CAP_SYS_PTRACE' 'CapabilityBoundingSet=CAP_SYS_PTRACE'
        ;;
    esac
  } >"$work/snowluma-$kind.service"
done
wants='snowluma-xvfb.service snowluma-fluxbox.service snowluma-client.service snowluma-gateway.service'
if ((vnc)); then
  command -v x11vnc >/dev/null || fail 'missing x11vnc'
  python3 - "$home" <<'PY'
import pathlib, secrets, subprocess, sys
root = pathlib.Path(sys.argv[1]); password = secrets.token_urlsafe(12)
with (root / 'vnc-password.txt').open('x') as f: f.write(password + '\n')
subprocess.run(['/usr/bin/x11vnc', '-storepasswd', password, str(root / 'vnc-password')], check=True, stdout=subprocess.DEVNULL)
PY
  chown snowluma:snowluma "$home/vnc-password" "$home/vnc-password.txt"
  chmod 0600 "$home/vnc-password" "$home/vnc-password.txt"
  {
    printf '[Unit]\nDescription=SnowLuma loopback VNC (manual SSH tunnel)\nRequires=snowluma-xvfb.service\nAfter=snowluma-xvfb.service\nPartOf=snowluma.target\n[Service]\n'
    common_service
    printf '%s\n' 'ExecStart=/usr/bin/x11vnc -display :99 -auth /var/lib/snowluma/.Xauthority -localhost -rfbport 5901 -rfbauth /var/lib/snowluma/vnc-password -forever -shared -nolookup' 'CapabilityBoundingSet='
  } >"$work/snowluma-vnc.service"
  wants+=' snowluma-vnc.service'
fi
printf '[Unit]\nDescription=Original native SnowLuma (manual activation)\nWants=%s\nAfter=network-online.target\n[Install]\nWantedBy=multi-user.target\n' "$wants" >"$work/snowluma.target"
for unit in "${units[@]}"; do
  [[ -f $work/$unit ]] || continue
  [[ ! -e /etc/systemd/system/$unit && ! -L /etc/systemd/system/$unit ]] || fail "unit appeared during preparation: $unit"
  # noclobber prevents replacing a newly created existing unit.
  (set -o noclobber; umask 022; <"$work/$unit" cat >"/etc/systemd/system/$unit")
done
systemctl daemon-reload
cat <<'DONE'
Prepared only; no service was started or enabled. This is NOT a completed login.
1. Review /opt/snowluma/EULA.md and PRIVACY.md and QQ's terms/version separately.
2. Verify SNOWLUMA_WEBUI_HOST is honored by this exact upstream release. After
   manually starting, inspect listeners with ss -ltnp BEFORE any remote access;
   stop snowluma.target if WebUI is not loopback. Do not expose ports publicly.
3. When ready: systemctl start snowluma.target (enable later only if desired).
   Open WebUI over SSH: ssh -L 5099:127.0.0.1:5099 USER@HOST
   Complete upstream agreement prompts yourself; no consent flags were written.
4. Optional VNC: ssh -L 5901:127.0.0.1:5901 USER@HOST; use a VNC viewer and the
   private /var/lib/snowluma/vnc-password.txt. noVNC is not installed by this script.
   QQ requires manual QR scanning; no CLI login or fake successful login.
   Default QQ needs working unprivileged user namespaces for its Chromium sandbox.
   --qq-no-sandbox is an explicit weakening, never silently added on failure.
5. Review injection in WebUI; hookAutoLoad remains false until you choose otherwise.
   OneBot token: /var/lib/snowluma/gateway/config/onebot.json (0600; never printed).
No existing Docker instance/data was stopped, copied or removed. Avoid concurrent
QQ logins or port conflicts: migration and backups are separate manual operations.
DONE
