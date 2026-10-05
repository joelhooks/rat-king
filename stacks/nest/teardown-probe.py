"""Read-only teardown probe. Arguments come from validated private inventory."""
import glob
import json
import os
import re
import subprocess
import sys

home, data = sys.argv[1:3]
before = json.loads(sys.argv[3])
failed = False


def check(label, clean):
    global failed
    print(("PASS " if clean else "FAIL ") + label)
    failed |= not clean


def command(*args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


try:
    loaded = command("systemctl", "--user", "list-units", "--all", "--no-legend", "--plain")
    files = command("systemctl", "--user", "list-unit-files", "--no-legend")
    pattern = r"\brat-king(?:-[\w.-]+|\.slice)\b"
    check("user units unloaded", re.search(pattern, loaded) is None)
    check("user unit files absent", re.search(pattern, files) is None and
          not glob.glob(home + "/.config/systemd/user/rat-king*"))

    # Ignore only the probe and its SSH command ancestors, never arbitrary workers.
    ancestors = set()
    pid = os.getpid()
    while pid > 1:
        ancestors.add(pid)
        with open("/proc/" + str(pid) + "/stat") as stream:
            pid = int(stream.read().rsplit(")", 1)[1].split()[1])
    processes = command("ps", "-eo", "pid=,args=").splitlines()
    check("rat-king processes absent", not any(
        int(row.strip().split(None, 1)[0]) not in ancestors and
        "rat-king" in row.strip().split(None, 1)[1]
        for row in processes if len(row.strip().split(None, 1)) == 2))

    listeners = command("ss", "-H", "-ltnup")
    ports = {int(match.group(1)) for row in listeners.splitlines()
             if (match := re.search(r":(\d+)$", row.split()[4]))}
    for port in (19333, 18081, 18888, 18333, 29333, 28081, 28888, 28333, 18788, 18787, 18789):
        check("port " + str(port) + " closed", port not in ports)
    for label, path in (
        ("binary and CLI root absent", home + "/.local/share/rat-king"),
        ("configuration and keys absent", home + "/.config/rat-king"),
        ("data root absent", data),
    ):
        check(label, not os.path.lexists(path))
    check("dedicated Claude install absent", not os.path.lexists(home + "/.local/share/rat-king/claude-code"))
    paths = sorted(set(glob.glob(home + "/.claude*") + [home + "/.local/bin/claude"]))
    after = {path: os.lstat(path).st_mtime_ns if os.path.lexists(path) else None for path in paths}
    check("user Claude mtimes unchanged", before == after)
    check("proof temporary files absent", not glob.glob("/tmp/rat-king-proof-*"))
except (OSError, ValueError, IndexError, subprocess.CalledProcessError):
    check("probe commands completed", False)

sys.exit(1 if failed else 0)
