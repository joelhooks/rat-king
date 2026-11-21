import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

COLLECTOR = Path(__file__).with_name("comms-collector.py")
GUARD = """
import os, runpy, sys

collector, sessions = sys.argv[1:]

def reject_session_access(event, args):
    if event in {"open", "os.scandir", "os.listdir"}:
        path = args[0]
        if isinstance(path, (str, bytes, os.PathLike)):
            path = os.path.abspath(os.fsdecode(path))
            if os.path.commonpath((path, sessions)) == sessions:
                raise RuntimeError("Accessed sessions")

sys.addaudithook(reject_session_access)
runpy.run_path(collector)
"""


def collect(root, **options):
    return subprocess.run(
        [sys.executable, "-I", "-c", GUARD, str(COLLECTOR), str(root / "sessions")],
        input=json.dumps({
            "cut": 10,
            "quarantine": str(root / "quarantine"),
            "receipts": str(root / "receipts"),
            **options,
        }),
        capture_output=True,
        text=True,
        timeout=10,
    )


class CommsCollectorTest(unittest.TestCase):
    def test_collector_reads_receipts_and_quarantine_without_opening_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "sessions").mkdir()
            (root / "receipts").write_text("{}\n", encoding="utf-8")
            quarantine = root / "quarantine" / "nested"
            quarantine.mkdir(parents=True)
            for name, modified in [("old", 9), ("at-cut", 10), ("new", 11)]:
                fixture = quarantine / name
                fixture.touch()
                os.utime(fixture, (modified, modified))

            for legacy in ({}, {"sessions": str(root / "sessions")}):
                with self.subTest(legacy=bool(legacy)):
                    result = collect(root, **legacy)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(
                        [json.loads(line) for line in result.stdout.splitlines()],
                        [{"kind": "receipt", "line": "{}\n"}, {"kind": "quarantine"}],
                    )

    def test_missing_quarantine_fails_in_both_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            (root / "receipts").touch()
            for only_quarantine in (False, True):
                with self.subTest(only_quarantine=only_quarantine):
                    result = collect(root, onlyQuarantine=only_quarantine)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Missing quarantine directory", result.stderr)


if __name__ == "__main__":
    unittest.main()
