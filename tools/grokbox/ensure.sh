#!/usr/bin/env bash
set -euo pipefail
umask 077

step=configuration
fail() { printf 'ensure: %s failed: %s\n' "$step" "$1" >&2; exit 1; }
trap 'printf "ensure: %s failed\n" "$step" >&2' ERR

: "${TS_VERSION:?set TS_VERSION to the approved exact static binary version}"
: "${TS_HOSTNAME:?set TS_HOSTNAME to the operator-approved hostname}"
: "${RATKING_SHA:?set RATKING_SHA to the approved full commit SHA}"
[[ "$TS_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'invalid TS_VERSION'
[[ "$RATKING_SHA" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid RATKING_SHA'

repo=${RATKING_REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}
bin="$HOME/.local/tailscale/bin"
run="${XDG_RUNTIME_DIR:-/tmp}/tailscale-$(id -u)"
state="$HOME/.local/share/tailscale"
private="$HOME/.local/share/rat-king"
sock="$run/tailscaled.sock"
[[ ! -L "$run" ]] || fail 'runtime directory must not be a symlink'
mkdir -p "$bin" "$run" "$state" "$private" "$HOME/.local/bin"
[[ "$(stat -c '%u' "$run")" == "$(id -u)" ]] || fail 'runtime directory must be owned by this uid'
chmod 700 "$run" "$state" "$private"

step=binaries
if [[ ! -x "$bin/tailscale" || ! -x "$bin/tailscaled" ]] || [[ "$("$bin/tailscale" version | head -n 1)" != "$TS_VERSION" ]]; then
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail 'unsupported architecture' ;;
  esac
  temp=$(mktemp -d "$private/install.XXXXXXXX")
  cleanup() { rm -f -- "$temp/archive.tgz" "$temp/checksum" "$temp/tailscale" "$temp/tailscaled"; rmdir -- "$temp"; }
  trap cleanup EXIT
  archive="tailscale_${TS_VERSION}_${arch}"
  url="https://pkgs.tailscale.com/stable/$archive.tgz"
  curl --fail --silent --show-error --location "$url" --output "$temp/archive.tgz"
  curl --fail --silent --show-error --location "$url.sha256" --output "$temp/checksum"
  expected=$(awk 'NR == 1 { print $1 }' "$temp/checksum")
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'invalid published sha256'
  actual=$(sha256sum "$temp/archive.tgz")
  [[ "${actual%% *}" == "$expected" ]] || fail 'static binary checksum mismatch'
  tar -xzf "$temp/archive.tgz" -C "$temp" --strip-components=1 "$archive/tailscale" "$archive/tailscaled"
  install -m 755 "$temp/tailscale" "$temp/tailscaled" "$bin/"
  cleanup
  trap - EXIT
fi

step=daemon
pid=''
live=false
if [[ -f "$run/tailscaled.pid" ]]; then read -r pid < "$run/tailscaled.pid"; fi
if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [[ -r "/proc/$pid/cmdline" ]]; then
  command_line=$(tr '\0' ' ' < "/proc/$pid/cmdline")
  if [[ "$command_line" == *tailscaled* && "$command_line" == *"--socket=$sock"* ]]; then live=true; fi
fi
if pgrep -u "$(id -u)" -f "tailscaled.*--socket=$sock" >/dev/null; then live=true; fi

status=''
if [[ -S "$sock" ]] && status=$("$bin/tailscale" --socket="$sock" status --json 2>/dev/null); then
  :
elif [[ "$live" == true ]]; then
  fail 'live daemon is unresponsive; refusing a second daemon'
else
  [[ ! -e "$sock" || -S "$sock" ]] || fail 'socket path is occupied by a non-socket file'
  rm -f -- "$sock" "$run/tailscaled.pid"
  "$bin/tailscaled" --tun=userspace-networking --state="$state/tailscaled.state" --socket="$sock" --outbound-http-proxy-listen=127.0.0.1:1055 >>"$run/tailscaled.log" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$run/tailscaled.pid"
  ready=false
  for ((attempt=0; attempt<30; attempt++)); do
    if status=$("$bin/tailscale" --socket="$sock" status --json 2>/dev/null); then ready=true; break; fi
    kill -0 "$pid" 2>/dev/null || fail 'new daemon exited before readiness'
    sleep 1
  done
  [[ "$ready" == true ]] || fail 'new daemon did not become ready within 30 seconds'
fi

step=join
backend=$(printf '%s' "$status" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{process.stdout.write(JSON.parse(s).BackendState??"")})')
if [[ "$backend" != Running ]]; then
  key="$private/tailnet.key"
  [[ -f "$key" && ! -L "$key" ]] || fail 'missing regular tailnet.key'
  [[ "$(stat -c '%a' "$key")" == 600 && "$(stat -c '%u' "$key")" == "$(id -u)" ]] || fail 'tailnet.key must be owned by this uid with mode 0600'
  "$bin/tailscale" --socket="$sock" up --auth-key="file:$key" --advertise-tags=tag:grokbot --hostname="$TS_HOSTNAME" --shields-up --accept-dns=false --timeout=60s
fi

step=environment
printf '%s\n' 'export HTTP_PROXY=http://127.0.0.1:1055' 'export HTTPS_PROXY=http://127.0.0.1:1055' 'export NODE_USE_ENV_PROXY=1' > "$private/env"
# shellcheck disable=SC1091 -- This exact file was just written above with constant assignments.
source "$private/env"

step=checkout
[[ -d "$repo/.git" || -f "$repo/.git" ]] || fail 'checkout missing; clone the approved repository first'
[[ "$(git -C "$repo" rev-parse HEAD)" == "$RATKING_SHA" ]] || fail 'checkout is not at RATKING_SHA; refusing to move an existing checkout'
if [[ ! -d "$repo/node_modules" || ! -f "$private/deps-$RATKING_SHA" ]]; then
  (cd "$repo" && corepack pnpm install --frozen-lockfile)
  : > "$private/deps-$RATKING_SHA"
fi
wrapper="$HOME/.local/bin/secrets"
if [[ ! -e "$wrapper" ]]; then
  printf '#!/usr/bin/env bash\nexec node %q "$@"\n' "$repo/tools/grokbox/secrets.mjs" > "$wrapper"
  chmod 700 "$wrapper"
fi
[[ -x "$wrapper" && ! -L "$wrapper" ]] || fail 'secrets wrapper must be an executable regular file'

step=health
config=${RATKING_CONFIG:-$HOME/.config/rat-king/pi.json}
endpoint=$(node -e 'const c=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));const u=new URL(c.endpoint);if(!["https:","http:"].includes(u.protocol))process.exit(1);process.stdout.write(u.href.replace(/\/$/,""))' "$config")
code=$(curl --silent --show-error --max-time 30 --proxy "$HTTP_PROXY" --output /dev/null --write-out '%{http_code}' "$endpoint/.well-known/rat-king/version")
[[ "$code" == 200 ]] || fail 'mailbox version endpoint did not return 200'
printf 'ensure: healthy\n'
