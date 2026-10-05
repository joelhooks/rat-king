import { Effect } from "effect";

import { must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";

export const wantsLinkScript = String.raw`
import os, pathlib, sys
home, name, operation = sys.argv[1:4]
root = pathlib.Path(home)/'.config/systemd/user'
link = root/'default.target.wants'/name
for parent in [root, link.parent]:
    if parent.is_symlink():
        raise ValueError('Unit parent symlink refused')
if os.path.lexists(link):
    if not link.is_symlink() or os.path.realpath(link) != str(root/name):
        raise ValueError('Different wants link refused')
    if operation == 'remove':
        link.unlink()
print('ready')
`;

export const storeSocketScript = String.raw`
import os, pathlib, stat, subprocess
paths = [pathlib.Path('/tmp/seaweedfs-s3-18333.sock'),
         pathlib.Path('/tmp/seaweedfs-s3-grpc-28333.sock')]
listeners = subprocess.run(['ss', '-H', '-lxnp'], check=True,
                           capture_output=True, text=True).stdout
for path in paths:
    if str(path) in listeners:
        raise ValueError('Listening socket refused')
    if os.path.lexists(path):
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError('Unowned or non-socket path refused')
for path in paths:
    if os.path.lexists(path):
        path.unlink()
print('ready')
`;

export const wantsLink = Effect.fn("SystemdUnit.wantsLink")(function* link(
  shell: Interface,
  home: string,
  name: string,
  operation: "check" | "remove"
) {
  yield* must(shell, ["python3", "-c", wantsLinkScript, home, name, operation]);
});

export const removeStoreSockets = Effect.fn("SystemdUnit.storeSockets")(
  function* sockets(shell: Interface) {
    yield* must(shell, ["python3", "-c", storeSocketScript]);
  }
);
