#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mode="${1:---archive-only}"
case "$mode" in
  --archive-only|--upload) ;;
  *) echo "Usage: $0 [--archive-only|--upload]" >&2; exit 2 ;;
esac
if [[ "$mode" == --upload && "${RK_UPLOAD_AUTHORIZED:-0}" != 1 ]]; then echo "Desk must authorize this exact upload" >&2; exit 1; fi
[[ "${RK_PROVISIONING_AUTHORIZED:-0}" == 1 ]] || { echo "Desk must confirm Joel's provisioning authorization before this runs" >&2; exit 1; }
[[ -f Config/Local.xcconfig ]] || { echo "Missing Config/Local.xcconfig" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || { echo "Checkout is dirty; refusing publication" >&2; exit 1; }
commit="$(git rev-parse HEAD)"
command -v xcodegen >/dev/null || { echo "Install XcodeGen: brew install xcodegen" >&2; exit 1; }
xcodegen generate
mkdir -p build
# Credentials are leased only after explicit provisioning/upload authorization.
umask 077
keydir="$(mktemp -d "${TMPDIR:-/tmp}/ratking-asc.XXXXXX")"
keypath=""
cleanup() {
  if [[ -n "$keypath" && -f "$keypath" ]]; then rm -- "$keypath"; fi
  if [[ -f "$keydir/versions.json" ]]; then rm -- "$keydir/versions.json"; fi
  rmdir -- "$keydir"
}
trap cleanup EXIT
keyid="$(secrets lease asc_api_key_id --ttl 15m --client-id ratking-ios-upload)"
issuer="$(secrets lease asc_api_issuer_id --ttl 15m --client-id ratking-ios-upload)"
[[ "$keyid" =~ ^[A-Z0-9]+$ ]] || { echo "Malformed ASC key ID" >&2; exit 1; }
keypath="$keydir/AuthKey_${keyid}.p8"
secrets lease asc_api_key_p8 --ttl 15m --client-id ratking-ios-upload > "$keypath"
chmod 600 "$keypath"
auth=(-allowProvisioningUpdates -authenticationKeyPath "$keypath" -authenticationKeyID "$keyid" -authenticationKeyIssuerID "$issuer")
xcodebuild -project RatKing.xcodeproj -scheme RatKing -showBuildSettings -json > build/settings.json
bundle="$(python3 -c 'import json; print(next(x["buildSettings"]["PRODUCT_BUNDLE_IDENTIFIER"] for x in json.load(open("build/settings.json")) if x["target"] == "RatKing"))')"
# Read existing TestFlight history before choosing versions. Never create an app.
swift scripts/asc-version.swift "$keypath" "$keyid" "$issuer" "$bundle" 0.2.0 > "$keydir/versions.json"
marketing="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["marketingVersion"])' "$keydir/versions.json")"
build_number="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildNumber"])' "$keydir/versions.json")"
printf 'ASC version preflight: '; python3 -m json.tool "$keydir/versions.json"
if [[ "$mode" == --archive-only ]]; then
  xcodebuild -project RatKing.xcodeproj -scheme RatKing \
    -archivePath build/RatKing.xcarchive -destination 'generic/platform=iOS' \
    CODE_SIGN_STYLE=Automatic RK_BUILD_COMMIT="$commit" \
    MARKETING_VERSION="$marketing" CURRENT_PROJECT_VERSION="$build_number" \
    "${auth[@]}" archive
  echo "Archive ready. Not uploaded; --upload needs separate desk authorization."
  exit 0
fi
[[ -d build/RatKing.xcarchive ]] || { echo "Archive first" >&2; exit 1; }
plist=build/RatKing.xcarchive/Products/Applications/RatKing.app/Info.plist
archive_commit="$(/usr/libexec/PlistBuddy -c 'Print :RKBuildCommit' "$plist")"
[[ "$archive_commit" == "$commit" ]] || { echo "Archive does not match committed candidate" >&2; exit 1; }
python3 - "$plist" "$keydir/versions.json" <<'PY'
import json,plistlib,sys
with open(sys.argv[1],'rb') as f: archive=plistlib.load(f)
with open(sys.argv[2]) as f: preflight=json.load(f)
if archive['CFBundleShortVersionString'] != preflight['marketingVersion'] or int(archive['CFBundleVersion']) <= int(preflight['maxExistingBuild']):
    raise SystemExit('ASC history changed or archive version is stale; rearchive before upload')
PY
xcodebuild -exportArchive -archivePath build/RatKing.xcarchive \
  -exportPath build/export -exportOptionsPlist ExportOptions.plist "${auth[@]}"
API_PRIVATE_KEYS_DIR="$keydir" xcrun altool --upload-app \
  -f build/export/RatKing.ipa -t ios --api-key "$keyid" --api-issuer "$issuer" \
  --output-format json
echo "Upload submitted. Not proof of TestFlight installation or live mail."
