import datetime
import pathlib
import plistlib
import re
import subprocess
import sys
import urllib.parse
import json


def require(condition, reason):
    if not condition:
        raise SystemExit(reason)


def load(path):
    return plistlib.loads(path.read_bytes())


def checked_profile(profile, devices, settings):
    team, bundle = settings['DEVELOPMENT_TEAM'], settings['PRODUCT_BUNDLE_IDENTIFIER']
    require(re.fullmatch(r'[A-Z0-9]{10}', team) and re.fullmatch(r'[A-Za-z0-9.-]+', bundle), 'Invalid team or bundle setting')
    expiration = profile['ExpirationDate'].replace(tzinfo=datetime.timezone.utc)
    require(expiration > datetime.datetime.now(datetime.timezone.utc), 'Development profile expired')
    entitlements = profile['Entitlements']
    require(team in profile['TeamIdentifier'] and entitlements['application-identifier'] == f'{team}.{bundle}', 'Profile does not match the configured team and explicit bundle')
    require(entitlements.get('aps-environment') == 'development' and entitlements.get('get-task-allow') is True, 'Expected a development profile with Push')
    require(devices <= {x.upper() for x in profile.get('ProvisionedDevices', [])}, 'Profile is missing a target phone')
    uuid = profile['UUID']
    require(re.fullmatch(r'[0-9A-Fa-f-]{36}', uuid), 'Invalid profile UUID')
    return uuid


def check_runtime(settings):
    fields = ('RK_MAILBOX_URL', 'RK_MAILBOX_AUDIENCE', 'RK_PHONE_DID')
    values = [settings.get(field, '') for field in fields]
    require(all(v and '$(' not in v and not any(c.isspace() for c in v) for v in values), 'Missing runtime configuration')
    url = urllib.parse.urlsplit(values[0])
    require(url.scheme == 'https' and url.hostname and not any((url.username, url.password, url.query, url.fragment)), 'Mailbox URL must use HTTPS without credentials, query or fragment')
    require(all(v.startswith('did:web:') and len(v) > len('did:web:') for v in values[1:]), 'Expected mailbox audience and phone DID')


def prepare(work, devices, settings):
    check_runtime(settings)
    uuid = checked_profile(load(work / 'profile.plist'), devices, settings)
    options = dict(method='debugging', destination='export', signingStyle='manual',
                   teamID=settings['DEVELOPMENT_TEAM'], signingCertificate='Apple Development',
                   provisioningProfiles={settings['PRODUCT_BUNDLE_IDENTIFIER']: uuid}, thinning='<none>')
    (work / 'export.plist').write_bytes(plistlib.dumps(options))
    (work / 'profile-uuid').write_text(uuid)


def tool(*args):
    return subprocess.check_output(args)


def verify(work, devices, settings, commit, build):
    apps = list((work / 'unpacked/Payload').glob('*.app'))
    require(len(apps) == 1, 'Expected exactly one application in the IPA')
    app, = apps
    require(not (app / 'PeerDocuments.private.json').exists(), 'Private peer seed must not ship via OTA')
    tool('codesign', '--verify', '--deep', '--strict', app)
    profile = plistlib.loads(tool('security', 'cms', '-D', '-i', app / 'embedded.mobileprovision'))
    require(checked_profile(profile, devices, settings) == (work / 'profile-uuid').read_text(), 'Xcode exported using an unexpected profile')
    entitlements = plistlib.loads(tool('codesign', '-d', '--entitlements', ':-', app))
    require(entitlements.get('aps-environment') == 'development', 'Signed app does not use sandbox APNs')
    info = load(app / 'Info.plist')
    expected = dict(CFBundleIdentifier=settings['PRODUCT_BUNDLE_IDENTIFIER'], RKBuildCommit=commit, CFBundleVersion=build,
                    RKMailboxURL=settings['RK_MAILBOX_URL'], RKMailboxAudience=settings['RK_MAILBOX_AUDIENCE'], RKPhoneDID=settings['RK_PHONE_DID'])
    require(all(info.get(key) == value for key, value in expected.items()), 'Exported build metadata or runtime configuration mismatch')
    version = info.get('CFBundleShortVersionString', '')
    require(re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version), 'Invalid marketing version')
    (work / 'metadata').write_text(f'{info["CFBundleIdentifier"]}\t{version}\t{build}\n')
    print('Verified exported IPA signature, both phones, sandbox APNs, source commit and runtime configuration')


def main():
    mode, path, devices_path, *args = sys.argv[1:]
    work = pathlib.Path(path)
    devices = set(pathlib.Path(devices_path).read_text().upper().split())
    require(len(devices) == 2 and all(re.fullmatch(r'[0-9A-F-]{24,40}', x) for x in devices), 'Expected two distinct device UDIDs')
    rows = json.loads((work / 'settings.json').read_text())
    settings = next(x['buildSettings'] for x in rows if x['target'] == 'RatKing')
    if mode == 'prepare':
        prepare(work, devices, settings)
    elif mode == 'verify':
        verify(work, devices, settings, *args)
    else:
        raise SystemExit('Expected prepare or verify')


if __name__ == '__main__':
    main()
