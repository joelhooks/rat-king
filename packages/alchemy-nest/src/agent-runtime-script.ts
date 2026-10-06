import { sidecarListener } from "./listener-contract.ts";

export const runtimeScript = String.raw`
import hashlib, json, os, pathlib, re, secrets, stat, subprocess, sys, urllib.request

def main():
    action, raw = sys.argv[1:3]
    p = json.loads(raw)
    home = pathlib.Path(p['home'])
    root = home / '.config/rat-king/agent-runtime'
    code = home / '.local/share/rat-king/claude-code'
    sidecar = home / '.local/share/rat-king/claude-sidecar'
    identity = home / ('.config/rat-king/agents/' + p['agent'] + '.jwk')
    paths = [root, root/'bindings']
    if p['mode'] == 'gateway':
        paths += [root/'gateway.key', root/'endpoint']
    if p['sidecar']:
        paths += [root/'bearer']
    if p['sidecar']:
        paths += [code, code/'2.1.285', code/'2.1.285/claude', sidecar,
                  sidecar/'sidecar.mjs', sidecar/'service.env', sidecar/'tmp', code/'2.1.285/sha256']
    for path in paths + [identity]:
        for ancestor in [path, *path.parents]:
            if ancestor.is_symlink():
                raise ValueError('Symlink refused')
    for path in paths:
        if path.exists() and path.is_dir() and stat.S_IMODE(path.stat().st_mode) != 0o700:
            raise ValueError('Directory mode')
        if path.exists() and path.is_file() and path.name != 'claude' and stat.S_IMODE(path.stat().st_mode) != 0o600:
            raise ValueError('File mode')
    if action == 'observe':
        complete = all(path.exists() for path in paths)
        private = all(not path.exists() or stat.S_IMODE(path.stat().st_mode) == 0o600
                      for path in [root/'bindings', root/'gateway.key', root/'endpoint', root/'bearer']
                      if p['mode'] == 'gateway' or path.name == 'bindings')
        if complete and p['sidecar']:
            binary = code/'2.1.285/claude'
            with binary.open('rb') as stream:
                complete = hashlib.file_digest(stream, 'sha256').hexdigest() == (code/'2.1.285/sha256').read_text()
            complete = complete and stat.S_IMODE(binary.stat().st_mode) == 0o755
            complete = complete and hashlib.sha256((sidecar/'sidecar.mjs').read_bytes()).hexdigest() == p['sidecarSha256']
        print('ready' if complete and private else 'absent')
        return
    os.umask(0o077)
    root.mkdir(mode=0o700, exist_ok=True)
    def write(path, text):
        temp = path.with_name(path.name + '.pending')
        if temp.exists() or temp.is_symlink():
            raise ValueError('Pending file exists')
        with temp.open('x') as f:
            f.write(text)
        temp.chmod(0o600)
        temp.replace(path)
    if stat.S_IMODE(identity.stat().st_mode) != 0o600 or not identity.is_file():
        raise ValueError('Identity mode')
    account = json.loads(identity.read_text())
    if account['did'] != p['did']:
        raise ValueError('Identity mismatch')
    bindings = {'AGENT_IDENTITIES_CREDENTIAL': json.dumps([account], separators=(',', ':'))}
    if p['mode'] == 'gateway':
        key_path = root/'gateway.key'
        if not key_path.exists():
            leased = subprocess.run(['secrets', '--no-update-check', 'lease', p['secretName'],
                                     '--ttl', '1h', '--client-id', 'rat-king-s6'],
                                    check=True, capture_output=True, text=True).stdout.strip()
            if not leased or any(c in leased for c in '\r\n\x00'):
                raise ValueError('Lease shape')
            write(key_path, leased)
        key = key_path.read_text()
        if not key or any(c in key for c in '\r\n\x00'):
            raise ValueError('Key shape')
        write(root/'endpoint', p['gatewayUrl'])
        bindings['MODEL_GATEWAY_CREDENTIAL'] = key
    if p['sidecar']:
        for path in [code, code/'2.1.285', sidecar, sidecar/'tmp']:
            path.mkdir(mode=0o700, exist_ok=True)
        base = 'https://downloads.claude.ai/claude-code-releases/2.1.285/'
        with urllib.request.urlopen(base + 'manifest.json', timeout=30) as response:
            manifest = json.load(response)
        checksum = manifest['platforms']['linux-x64']['checksum']
        if not re.fullmatch('[a-f0-9]{64}', checksum):
            raise ValueError('Manifest checksum')
        binary = code/'2.1.285/claude'
        def digest(path):
            with path.open('rb') as stream:
                return hashlib.file_digest(stream, 'sha256').hexdigest()
        if binary.exists():
            if not binary.is_file() or digest(binary) != checksum or stat.S_IMODE(binary.stat().st_mode) != 0o755:
                raise ValueError('Existing client differs')
        else:
            pending = binary.with_name('claude.pending')
            with urllib.request.urlopen(base + 'linux-x64/claude', timeout=90) as response, pending.open('xb') as target:
                while chunk := response.read(1024 * 1024):
                    target.write(chunk)
            if digest(pending) != checksum:
                raise ValueError('Downloaded checksum differs')
            pending.chmod(0o755)
            pending.replace(binary)
        version = subprocess.run([str(binary), '--version'], check=True, capture_output=True,
                                 text=True, env={'HOME': str(sidecar), 'CLAUDE_CONFIG_DIR': str(sidecar/'tmp'),
                                 'PATH': '/usr/bin:/bin', 'DISABLE_AUTOUPDATER': '1',
                                 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}).stdout
        if not re.match(r'^2\.1\.285(?:\s|$)', version):
            raise ValueError('Client version differs')
        write(code/'2.1.285/sha256', checksum)
        bearer_path = root/'bearer'
        if not bearer_path.exists():
            write(bearer_path, secrets.token_hex(32))
        bearer = bearer_path.read_text()
        if not re.fullmatch('[a-f0-9]{64}', bearer):
            raise ValueError('Bearer shape')
        bindings['CLAUDE_SIDECAR_CREDENTIAL'] = bearer
        env = {'RAT_KING_SIDECAR_PORT': '${sidecarListener.port}', 'RAT_KING_CLAUDE_EXECUTABLE': str(binary),
               'RAT_KING_SIDECAR_TOKEN_FILE': str(bearer_path),
               'RAT_KING_MODEL_GATEWAY_KEY_FILE': str(root/'gateway.key'),
               'RAT_KING_MODEL_GATEWAY_ENDPOINT_FILE': str(root/'endpoint'),
               'RAT_KING_SIDECAR_TEMP_DIR': str(sidecar/'tmp'),
               'CLAUDE_CONFIG_DIR': str(sidecar/'tmp'),
               'DISABLE_AUTOUPDATER': '1', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1'}
        write(sidecar/'service.env', ''.join(k + '=' + json.dumps(v) + '\n' for k,v in env.items()))
    write(root/'bindings', json.dumps(bindings))
    print('ready')

try:
    main()
except Exception:
    print('Runtime custody operation refused', file=sys.stderr)
    sys.exit(1)
`;
