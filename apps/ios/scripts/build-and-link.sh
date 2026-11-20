#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
: "${RK_OTA_PROFILE:?Set the development provisioning profile path}"
: "${RK_OTA_DEVICES_FILE:?Set the private file with the two device UDIDs}"
: "${PHONE_APPS_ROOT:?Set the local phone-apps checkout path}"
: "${PHONE_APPS_ORIGIN:?Set the private phone-apps HTTPS origin}"
hours=${1:-24}
[[ $# -le 1 && "$hours" =~ ^([1-9]|[1-6][0-9]|7[0-2])$ ]] || fail 'Usage: build-and-link.sh [hours: 1–72]'
[[ "$RK_OTA_PROFILE" = /* && "$RK_OTA_DEVICES_FILE" = /* && "$PHONE_APPS_ROOT" = /* ]] || fail 'Set absolute input paths'
[[ -r "$RK_OTA_PROFILE" && -r "$RK_OTA_DEVICES_FILE" && -r "$PHONE_APPS_ROOT/host-local/publish.mjs" ]] || fail 'Missing OTA inputs or publisher'
[[ "$PHONE_APPS_ORIGIN" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || fail 'Expected an HTTPS origin with no path, credentials or query'
title=${RK_OTA_LINK_TITLE:-Rat King}
[[ "$title" =~ ^[A-Za-z0-9.\ -]{1,30}$ ]] || fail 'Invalid OTA link title'
set --
if [[ -n "${RK_OTA_PHONE_DID+x}" ]]; then
  [[ "$RK_OTA_PHONE_DID" =~ ^did:web:[A-Za-z0-9.:%_-]+$ ]] || fail 'Invalid phone DID override'
  set -- "RK_PHONE_DID=$RK_OTA_PHONE_DID"
fi

cd "$(dirname "$0")/.."
[[ -z "$(git status --porcelain)" ]] || fail 'Commit the candidate before publishing'
[[ -f Config/Local.xcconfig && "$(stat -f '%Lp' Config/Local.xcconfig)" == 600 ]] || fail 'Expected Config/Local.xcconfig with mode 600'
git check-ignore -q Config/Local.xcconfig || fail 'Private configuration must be ignored'
[[ ! -e Sources/Resources/PeerDocuments.private.json ]] || fail 'Remove the optional private peer seed from the build checkout before publishing'
git check-ignore -q build/ || fail 'OTA output must be ignored'
commit=$(git rev-parse HEAD)
mkdir -p build
work=$(mktemp -d "$PWD/build/ota.XXXXXXXX")
log=$work/build.log
printf 'OTA build log: %s\n' "$log" >&2

prepare() {
  xcodegen generate --quiet || return
  xcodebuild -project RatKing.xcodeproj -scheme RatKing -configuration Release -destination 'generic/platform=iOS' "$@" -showBuildSettings -json > "$work/settings.json" || return
  security cms -D -i "$RK_OTA_PROFILE" > "$work/profile.plist" || return
  python3 scripts/verify-ota.py prepare "$work" "$RK_OTA_DEVICES_FILE"
}
prepare "$@" >> "$log" 2>&1 || fail 'OTA preflight failed; see build log'
uuid=$(<"$work/profile-uuid")
profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
mkdir -p "$profiles"
installed="$profiles/$uuid.mobileprovision"
if [[ ! -e "$installed" ]]; then
  /bin/cp -n "$RK_OTA_PROFILE" "$installed" || fail 'Could not install the provisioning profile'
fi
cmp -s "$installed" "$RK_OTA_PROFILE" || fail 'Existing local profile differs for the same UUID'

build_number=$(date -u +%Y%m%d%H%M%S)
archive="$work/RatKing.xcarchive"
xcodebuild -project RatKing.xcodeproj -scheme RatKing -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath "$work/DerivedData" -archivePath "$archive" CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY='Apple Development' PROVISIONING_PROFILE_SPECIFIER="$uuid" \
  SWIFT_ACTIVE_COMPILATION_CONDITIONS='$(inherited) RK_OTA' \
  RK_BUILD_COMMIT="$commit" CURRENT_PROJECT_VERSION="$build_number" "$@" archive >> "$log" 2>&1 || fail 'OTA archive failed; see build log'
PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" xcodebuild -exportArchive -archivePath "$archive" \
  -exportPath "$work/export" -exportOptionsPlist "$work/export.plist" >> "$log" 2>&1 || fail 'OTA export failed; see build log'

ipas=("$work/export/"*.ipa)
[[ ${#ipas[@]} == 1 && -f "${ipas[0]}" ]] || fail 'Expected exactly one exported IPA'
ipa=${ipas[0]}
/usr/bin/ditto -x -k "$ipa" "$work/unpacked" >> "$log" 2>&1 || fail 'Could not unpack exported IPA'
python3 scripts/verify-ota.py verify "$work" "$RK_OTA_DEVICES_FILE" "$commit" "$build_number" >> "$log" 2>&1 || fail 'Exported IPA verification failed; see build log'
[[ "$(git rev-parse HEAD)" == "$commit" && -z "$(git status --porcelain)" ]] || fail 'Checkout changed during build; refusing publication'
IFS=$'\t' read -r bundle version build < "$work/metadata"
PUBLIC_ORIGIN="$PHONE_APPS_ORIGIN" node "$PHONE_APPS_ROOT/host-local/publish.mjs" "$ipa" "$bundle" "$version" "$build" "$title" "$hours"
