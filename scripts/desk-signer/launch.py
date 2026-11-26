#!/usr/bin/python3 -I
"""Root-only fixed-profile launcher for one Linux desk grant."""

import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import select
import socket
import stat
import struct
import subprocess
import sys
import time

PROFILES = Path('/etc/ratking-desk-signer')
RUNTIME = Path('/run/ratking-desk-signer')
KEYS = Path('/var/lib/ratking-desk-signer')
WORKER = '/opt/ratking-signer/packages/ratking-client/src/desk-signer-worker.ts'
LIMIT = 1024 * 1024
CREDS = struct.Struct('3i')


def deadline_wait(fd, peers, deadline=None):
    remaining = None if deadline is None else max(0, deadline - time.monotonic())
    ready, _, _ = select.select([fd, *peers], [], [], remaining)
    if not ready or any(peer in ready for peer in peers):
        raise EOFError


def frame(read, fd, peers, deadline=None):
    data = bytearray()
    while len(data) < LIMIT:
        deadline_wait(fd, peers, deadline)
        part = read(min(65536, LIMIT - len(data)))
        if not part:
            raise EOFError
        data.extend(part)
        nl = part.find(b'\n')
        if nl >= 0:
            if nl != len(part) - 1:
                raise ValueError('unexpected pipelined signer frame')
            return data
        if deadline is None:
            deadline = time.monotonic() + 3
    raise ValueError('signer frame too large')


def receive(grant, size, pid, uid):
    data, ancillary, flags, _ = grant.recvmsg(size, socket.CMSG_SPACE(CREDS.size), socket.MSG_CMSG_CLOEXEC)
    for level, kind, raw in ancillary:
        if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
            for (received_fd,) in struct.iter_unpack('i', raw):
                os.close(received_fd)
    if not data:
        raise EOFError
    if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or len(ancillary) != 1:
        raise PermissionError('missing or truncated grant credentials')
    level, kind, raw = ancillary[0]
    if level != socket.SOL_SOCKET or kind != socket.SCM_CREDENTIALS or len(raw) != CREDS.size:
        raise PermissionError('invalid grant credentials')
    observed_pid, observed_uid, _ = CREDS.unpack(raw)
    if (observed_pid, observed_uid) != (pid, uid):
        raise PermissionError('grant used by a different process')
    return data


def write_all(fd, data):
    end = time.monotonic() + 3
    view = memoryview(data)
    while view:
        if not select.select([], [fd], [], max(0, end - time.monotonic()))[1]:
            raise EOFError
        view = view[os.write(fd, view):]


def relay(grant, client, uid, signer):
    assert signer.stdin is not None and signer.stdout is not None
    with os.fdopen(os.pidfd_open(client.pid), 'rb') as child, os.fdopen(os.pidfd_open(signer.pid), 'rb') as worker:
        peers = [child.fileno(), worker.fileno()]
        stdin, stdout = signer.stdin.fileno(), signer.stdout.fileno()
        os.set_blocking(stdin, False)
        grant.settimeout(3)
        while True:
            request = frame(lambda size: receive(grant, size, client.pid, uid), grant.fileno(), peers)
            write_all(stdin, request)
            response = frame(lambda size: os.read(stdout, size), stdout, peers, time.monotonic() + 3)
            grant.sendall(response)


def settings(profile):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', profile):
        raise ValueError('invalid launch profile')
    fd = os.open(PROFILES / (profile + '.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if info.st_uid != 0 or info.st_mode & 0o077 or not stat.S_ISREG(info.st_mode) or info.st_size > 8192:
            raise PermissionError('launch profile must be a private root file')
        row = json.load(stream)
    name, account, argv = row['name'], pwd.getpwnam(row['user']), row['argv']
    if not re.fullmatch(r'[a-z][a-z0-9-]*(?:/[a-z][a-z0-9-]*)?', name):
        raise ValueError('invalid desk name')
    if not account.pw_uid or account.pw_name == 'ratking-signer':
        raise PermissionError('client must not share root or signer privileges')
    if not isinstance(argv, list) or not argv or not all(isinstance(arg, str) for arg in argv) or not os.path.isabs(argv[0]):
        raise ValueError('profile requires an absolute client executable')
    return name, account, argv, row.get('cwd', account.pw_dir)


def launch(profile):
    if os.geteuid() != 0:
        raise PermissionError('only a privileged operator can launch a grant')
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    name, target, argv, cwd = settings(profile)
    signer_uid = pwd.getpwnam('ratking-signer')
    if target.pw_uid == signer_uid.pw_uid:
        raise PermissionError('client must run under a different UID than the signer')
    digest = hashlib.sha256(name.encode()).hexdigest()
    RUNTIME.mkdir(mode=0o700, exist_ok=True)
    info = RUNTIME.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077:
        raise PermissionError('grant lock directory must be private to root')
    with open(RUNTIME / digest, 'ab') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        server, inherited = socket.socketpair()
        with server, inherited:
            server.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            signer = subprocess.Popen(
                ['/usr/bin/node', WORKER, name, str(KEYS / (digest + '.json'))],
                cwd='/opt/ratking-signer', env={'PATH': '/usr/bin', 'HOME': '/nonexistent'},
                user=signer_uid.pw_uid, group=signer_uid.pw_gid, extra_groups=[],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
            try:
                env = {
                    'PATH': '/usr/local/bin:/usr/bin', 'HOME': target.pw_dir,
                    'USER': target.pw_name, 'LOGNAME': target.pw_name,
                    'TERM': os.environ.get('TERM', 'dumb'), 'RATKING_NAME': name,
                    'RATKING_PRINT_NAME': name, 'RATKING_SIGNER_FD': str(inherited.fileno()),
                }
                client = subprocess.Popen(
                    argv, cwd=cwd, env=env,
                    user=target.pw_uid, group=target.pw_gid, extra_groups=[],
                    pass_fds=(inherited.fileno(),),
                )
                print(f'ratking signer: issued {name} to PID {client.pid}', file=sys.stderr, flush=True)
                inherited.close()
                try:
                    relay(server, client, target.pw_uid, signer)
                except (EOFError, OSError, ValueError):
                    pass
                finally:
                    server.close()
                    print(f'ratking signer: closed {name} for PID {client.pid}', file=sys.stderr, flush=True)
            finally:
                if signer.poll() is None:
                    signer.kill()
                signer.wait()
            return client.wait()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('expected a root-owned profile name')
        sys.exit(launch(sys.argv[1]))
    except (KeyError, OSError, ValueError) as error:
        print(f'ratking signer: launch refused ({type(error).__name__})', file=sys.stderr)
        sys.exit(1)
