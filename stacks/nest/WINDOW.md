# Celld maintenance windows

`celld-window.sh` runs work that needs celld stopped, with a backup first and celld restored by systemd.

```
stacks/nest/celld-window.sh --reason "old-epoch sweep" --approval joel-go-2026-10-19 \
  [--dry-run] [--expect-env CELLD_KEY] [--marker FILE] [--receipts FILE] -- COMMAND [ARG...]
```

Run `--dry-run` first: it prints the plan and makes no systemctl calls.

- A window causes **two** celld restarts: the backup's own, then the window's. The approval reference must cover both.
- The receipt goes to `window-receipts.jsonl` beside the deploy marker (override with `--receipts`). The alarm reads it on the live node, so `celld.restarted` stays quiet inside `[start, end]`.
- A TERM or INT during work kills the work and starts celld through the trap.
- A SIGKILL skips the trap. The work process is left orphaned, and celld stays down until the 30-minute `rat-king-celld-window-deadline` timer starts it. That is the last resort; no receipt is written.
- `celld.down` is suppressed for only 180 s after the marker's `started`. For longer work, declare a mailbox window first with `nest maintenance start --instance mailbox …` (see `ALARMS.md`), or expect an alarm.
