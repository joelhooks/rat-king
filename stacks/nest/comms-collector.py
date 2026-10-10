import datetime
import glob
import json
import os
import sys

config = json.load(sys.stdin)
cut = config["cut"]

def emit(value):
    print(json.dumps(value), flush=True)

for path in sorted(glob.glob(config["sessions"] + "/*/*.jsonl")):
    if os.stat(path).st_mtime < cut:
        continue
    with open(path, errors="replace") as source:
        for line in source:
            if '"intercom"' in line:
                emit({"kind": "session", "file": path, "line": line})
if not os.path.isdir(config["sessions"]):
    raise RuntimeError("Missing sessions directory")
with open(config["receipts"]) as source:
    for line in source:
        emit({"kind": "receipt", "line": line})
if not os.path.isdir(config["quarantine"]):
    raise RuntimeError("Missing quarantine directory")
for root, directories, files in os.walk(config["quarantine"]):
    for name in files:
        if os.stat(os.path.join(root, name)).st_mtime > cut:
            emit({"kind": "quarantine"})
