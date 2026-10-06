#!/usr/bin/env bash
set -euo pipefail
set +x
cd "$(dirname "$0")/.."
mode="${1:---archive-only}"
case "$mode" in
  --archive-only|--upload) ;;
  *) echo "Usage: $0 [--archive-only|--upload]" >&2; exit 2 ;;
esac
[[ "${RK_PROVISIONING_AUTHORIZED:-0}" == 1 ]] || { echo "Desk must confirm profile refresh authorization" >&2; exit 1; }
if [[ "$mode" == --upload && "${RK_UPLOAD_AUTHORIZED:-0}" != 1 ]]; then echo "Desk must authorize this exact upload" >&2; exit 1; fi
[[ -f Config/Local.xcconfig ]] || { echo "Missing Config/Local.xcconfig" >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=normal)" ]] || { echo "Checkout is dirty; refusing publication" >&2; exit 1; }
commit="$(git rev-parse HEAD)"
xcodegen generate
mkdir -p build
umask 077
# Xcode owns its signed-in account. Never extract account tokens or mint keys.
xcodebuild -project RatKing.xcodeproj -scheme RatKing -showBuildSettings -json > build/settings.json
team="$(python3 -c 'import json; print(next(x["buildSettings"]["DEVELOPMENT_TEAM"] for x in json.load(open("build/settings.json")) if x["target"] == "RatKing"))')"
unlock_signing_keychain() {
  # Private paths come from ignored configuration, not public source. The
  # password travels only through stdin, never argv, an environment value or logs.
  python3 - <<'PY' | security -i >/dev/null 2>&1
import json,pathlib
settings=next(x['buildSettings'] for x in json.load(open('build/settings.json')) if x['target'] == 'RatKing')
keychain=settings.get('RK_SIGNING_KEYCHAIN_PATH','')
password_file=settings.get('RK_SIGNING_KEYCHAIN_PASSWORD_FILE','')
if not keychain or not password_file or not pathlib.Path(keychain).is_file() or not pathlib.Path(password_file).is_file():
    raise SystemExit('Missing private signing keychain configuration')
password=pathlib.Path(password_file).read_text().rstrip('\r\n')
if not password or any(c in password+keychain for c in '\r\n\0'):
    raise SystemExit('Invalid signing keychain input')
def quoted(value): return '"'+value.replace('\\','\\\\').replace('"','\\"')+'"'
print('unlock-keychain -p '+quoted(password)+' '+quoted(keychain))
PY
}
unlock_signing_keychain
security find-identity -v -p codesigning > build/signing-identities.txt
certificate="$(python3 - "$team" <<'PY'
import re,sys
text=open('build/signing-identities.txt').read()
identities=re.findall(r'\) ([A-F0-9]{40}) "Apple Distribution: [^"\n]+ \(([^)]+)\)"',text)
match=next((sha for sha,team in identities if team == sys.argv[1]),None)
if not match: raise SystemExit('No existing distribution identity for the configured team; refusing certificate creation')
print(match)
PY
)"
verify_archive() {
  python3 - "$commit" <<'PY'
import json,plistlib,sys,urllib.parse
settings=next(x['buildSettings'] for x in json.load(open('build/settings.json')) if x['target'] == 'RatKing')
with open('build/RatKing.xcarchive/Products/Applications/RatKing.app/Info.plist','rb') as f: info=plistlib.load(f)
for key,setting in [('RKMailboxURL','RK_MAILBOX_URL'),('RKMailboxAudience','RK_MAILBOX_AUDIENCE'),('RKPhoneDID','RK_PHONE_DID')]:
    value=info.get(key)
    if not value or '$(' in value or value != settings.get(setting):
        raise SystemExit('Archive runtime configuration is missing or mismatched; refusing upload')
if info.get('RKBuildCommit') != sys.argv[1]:
    raise SystemExit('Archive source commit is missing or mismatched')
url=urllib.parse.urlparse(info['RKMailboxURL'])
if url.scheme != 'https' or not url.hostname or url.username or url.password:
    raise SystemExit('Archive mailbox endpoint is invalid')
print('Archive runtime configuration and source commit verified; private values suppressed')
PY
  codesign --verify --deep --strict build/RatKing.xcarchive/Products/Applications/RatKing.app
}
if [[ "$mode" == --archive-only ]]; then
  security find-certificate -c 'Apple Development' -p | openssl x509 -noout -subject > build/development-subject.txt
  python3 - "$team" <<'PY'
import re,sys
subject=open('build/development-subject.txt').read()
unit=re.search(r'(?:^|[,/])\s*OU\s*=\s*([^,/]+)',subject)
if not unit or unit.group(1).strip() != sys.argv[1]:
    raise SystemExit('No existing development certificate for this team; refusing certificate creation')
PY
  marketing="${RK_MARKETING_VERSION:-0.2.0}"
  [[ "$marketing" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Malformed marketing version" >&2; exit 1; }
  build_number="$(date -u +%Y%m%d%H%M)"
  echo "Archive candidate: version $marketing, build $build_number, commit $commit"
  xcodebuild -project RatKing.xcodeproj -scheme RatKing \
    -archivePath build/RatKing.xcarchive -destination 'generic/platform=iOS' \
    -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' \
    RK_BUILD_COMMIT="$commit" MARKETING_VERSION="$marketing" CURRENT_PROJECT_VERSION="$build_number" archive
  verify_archive
  echo "Archive ready. Not uploaded."
  exit 0
fi
[[ -d build/RatKing.xcarchive ]] || { echo "Archive first" >&2; exit 1; }
verify_archive
plist=build/RatKing.xcarchive/Products/Applications/RatKing.app/Info.plist
archive_commit="$(/usr/libexec/PlistBuddy -c 'Print :RKBuildCommit' "$plist")"
[[ "$archive_commit" == "$commit" ]] || { echo "Archive does not match committed candidate" >&2; exit 1; }
# Pin the existing certificate. Profile creation/refresh is authorized; new
# certificates, revocation and deletion are not.
python3 - "$team" "$certificate" <<'PY'
import plistlib,sys
with open('ExportOptions.plist','rb') as f: options=plistlib.load(f)
options.update(teamID=sys.argv[1],signingCertificate=sys.argv[2])
with open('build/ExportOptions.private.plist','wb') as f: plistlib.dump(options,f)
PY
unlock_signing_keychain
xcodebuild -exportArchive -archivePath build/RatKing.xcarchive \
  -exportPath build/export -exportOptionsPlist build/ExportOptions.private.plist \
  -allowProvisioningUpdates
echo "Upload command succeeded. Verify Apple's upload receipt; installation and live mail remain separate."
