#!/bin/sh
set -eu

[ "$(id -u)" = 0 ] || { echo 'installation requires an approved sudo pane' >&2; exit 1; }
release=/opt/ratking-signer
worker=$release/packages/ratking-client/src/desk-signer-worker.ts
[ -f "$worker" ] && [ -x /usr/bin/node ] && [ -x /usr/bin/python3 ] || {
  echo 'stage and review the root-owned release and runtimes before installing' >&2; exit 1;
}
# Check both the staged files and the paths used to resolve their modules.
if [ -L "$release" ] || [ -n "$(find "$release" -xdev \( ! -uid 0 -o \( ! -type l -a -perm /022 \) \) -print -quit)" ]; then
  echo 'signer release is writable outside root' >&2; exit 1
fi
find "$release" -xdev -type l -exec /bin/sh -eu -c '
  for link do
    resolved=$(realpath -e -- "$link") || exit 1
    case "$resolved" in /opt/ratking-signer/*) ;; *) exit 1 ;; esac
  done
' sh {} +

here=$release/scripts/desk-signer
[ -f "$here/launch.py" ] && [ -f "$here/ratking-desk-signer@.service" ]
unit=/etc/systemd/system/ratking-desk-signer@.service
launcher=/usr/local/libexec/ratking-desk-signer-launch
for target in "$unit" "$launcher" /etc/ratking-desk-signer /var/lib/ratking-desk-signer; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo 'signer install target already exists; use an approved upgrade instead' >&2; exit 1
  fi
done
if getent passwd ratking-signer >/dev/null || getent group ratking-signer >/dev/null; then
  echo 'signer identity already exists; inspect ownership before proceeding' >&2; exit 1
fi

useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/bin/nologin ratking-signer
install -d -o root -g root -m 0700 /etc/ratking-desk-signer
install -d -o root -g ratking-signer -m 0750 /var/lib/ratking-desk-signer
install -D -o root -g root -m 0755 "$here/launch.py" "$launcher"
install -o root -g root -m 0644 "$here/ratking-desk-signer@.service" "$unit"
systemctl daemon-reload
echo 'Installed only. No profiles enabled, users reassigned, or keys moved. Check rootful Docker separately.'
