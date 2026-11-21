import json
import os
import sys

config = json.load(sys.stdin)
cut = config["cut"]


def emit(value):
    print(json.dumps(value), flush=True)


if not config.get("onlyQuarantine", False):
    with open(config["receipts"]) as source:
        for line in source:
            emit({"kind": "receipt", "line": line})

if not os.path.isdir(config["quarantine"]):
    raise RuntimeError("Missing quarantine directory")

for root, _, files in os.walk(config["quarantine"]):
    for name in files:
        if os.stat(os.path.join(root, name)).st_mtime > cut:
            emit({"kind": "quarantine"})
