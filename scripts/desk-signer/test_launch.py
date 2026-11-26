import os
from pathlib import Path
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

from launch import receive, relay

NODE = shutil.which('node')
ROOT = Path(__file__).resolve().parents[2]
WORKER = ROOT / 'packages/ratking-client/src/desk-signer-worker.ts'
MAKE_KEY = '''
const pair = (name, uses) => crypto.subtle.generateKey({name, namedCurve: 'P-256'}, true, uses);
const key = async (name, uses) => crypto.subtle.exportKey('jwk', (await pair(name, uses)).privateKey);
console.log(JSON.stringify({
  did: 'did:web:alpha.example.test',
  agreement: await key('ECDH', ['deriveBits']),
  signing: await key('ECDSA', ['sign', 'verify']),
}));
'''
CLIENT = '''
import { Effect, Result } from './node_modules/effect/dist/index.js';
import { bindDeskSigner } from './packages/ratking-client/src/desk-signer-client.ts';
const fd = Number(process.argv[1]);
const did = 'did:web:alpha.example.test';
const denied = await Effect.runPromise(Effect.result(bindDeskSigner(fd, 'other', did)));
if (!Result.isFailure(denied)) process.exit(2);
const identity = await Effect.runPromise(bindDeskSigner(fd, 'alpha', did));
if ('d' in identity.signing || 'd' in identity.agreement) process.exit(3);
const bytes = new TextEncoder().encode('verify on the client');
const signature = await Effect.runPromise(identity.sign(bytes));
const key = await crypto.subtle.importKey('jwk', identity.signing, {name: 'ECDSA', namedCurve: 'P-256'}, false, ['verify']);
if (!await crypto.subtle.verify({name: 'ECDSA', hash: 'SHA-256'}, key, signature, bytes)) process.exit(4);
process.stdout.write('signed\\n');
await new Promise((done) => process.stdin.once('data', done));
const stopped = await Effect.runPromise(Effect.result(identity.sign(bytes)));
if (!Result.isFailure(stopped)) process.exit(5);
process.stdout.write('closed\\n');
'''


@unittest.skipUnless(sys.platform == 'linux' and hasattr(os, 'pidfd_open'), 'Linux grant transport')
class GrantTests(unittest.TestCase):
    def grant(self):
        reader, writer = socket.socketpair()
        self.addCleanup(reader.close)
        self.addCleanup(writer.close)
        reader.settimeout(4)
        reader.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
        return reader, writer

    def test_copied_fd_is_not_authority_from_another_pid(self):
        reader, writer = self.grant()
        child = subprocess.Popen([sys.executable, '-c', 'import os,sys; os.write(int(sys.argv[1]), b"approved\\n"); sys.stdin.read()', str(writer.fileno())], stdin=subprocess.PIPE, pass_fds=(writer.fileno(),))
        try:
            self.assertEqual(receive(reader, 32, child.pid, os.getuid()), b'approved\n')
            writer.sendall(b'wrong-process\n')
            with self.assertRaises(PermissionError):
                receive(reader, 32, child.pid, os.getuid())
        finally:
            child.communicate(timeout=5)

    @unittest.skipUnless(NODE and os.getuid() != 0, 'Node 24 and non-root fixture worker')
    def test_signer_exit_closes_grant_and_a_new_grant_works(self):
        with tempfile.TemporaryDirectory(prefix='rks-') as directory:
            keyfile = Path(directory) / 'fixture.json'
            keyfile.touch(mode=0o600)
            with keyfile.open('wb') as key_output:
                subprocess.run([NODE, '--input-type=module', '-e', MAKE_KEY], check=True, stdout=key_output, timeout=5)
            for _ in range(2):
                self.exercise_grant(keyfile)

    def exercise_grant(self, keyfile):
        reader, writer = self.grant()
        with subprocess.Popen([NODE, str(WORKER), 'alpha', str(keyfile)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, cwd=ROOT) as worker:
            with subprocess.Popen([NODE, '--input-type=module', '-e', CLIENT, str(writer.fileno())], stdin=subprocess.PIPE, stdout=subprocess.PIPE, pass_fds=(writer.fileno(),), cwd=ROOT) as client:
                writer.close()
                problems = []

                def run_relay():
                    try:
                        relay(reader, client, os.getuid(), worker)
                    except EOFError:
                        pass
                    except Exception as error:
                        problems.append(error)
                    finally:
                        reader.close()

                proxy = threading.Thread(target=run_relay, daemon=True)
                proxy.start()
                try:
                    self.assertTrue(select.select([client.stdout], [], [], 5)[0], 'signer/client handshake did not finish')
                    self.assertEqual(client.stdout.readline(), b'signed\n')
                    worker.kill()
                    proxy.join(5)
                    self.assertFalse(proxy.is_alive())
                    self.assertEqual(problems, [])
                    self.assertEqual(client.communicate(b'continue', timeout=5)[0], b'closed\n')
                    self.assertEqual(client.returncode, 0)
                finally:
                    if client.poll() is None:
                        client.kill()
                    if worker.poll() is None:
                        worker.kill()
                    proxy.join(5)


if __name__ == '__main__':
    unittest.main()
