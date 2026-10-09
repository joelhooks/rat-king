import type { UnitProps } from "../../packages/alchemy-nest/src/systemd.ts";
import { backupRecoveryScript } from "./backup-recovery.ts";

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const backupUnit = (input: {
  readonly home: string;
  readonly dataRoot: string;
  readonly backupRoot: string;
  readonly version: string;
  readonly commit: string;
  readonly ready: string;
}): UnitProps => ({
  enabled: false,
  home: input.home,
  name: "rat-king-mailbox-backup.service",
  restartOn: [input.ready],
  scope: "user",
  sections: [
    {
      lines: [["Description", "Rat King mailbox consistent data backup"]],
      name: "Unit",
    },
    {
      lines: [
        ["Type", "oneshot"],
        [
          "ExecStart",
          `/usr/bin/flock --nonblock ${quote(`${input.home}/.config/rat-king/mailbox-backup.lock`)} /usr/local/bin/node ${quote(`${input.home}/.local/share/rat-king/bin/mailbox-backup.mjs`)} ${[input.dataRoot, input.backupRoot, input.version, input.commit, input.home].map(quote).join(" ")}`,
        ],
        [
          "ExecStopPost",
          `/usr/bin/python3 -c ${quote(`exec(${JSON.stringify(backupRecoveryScript)})`)} ${quote(input.dataRoot)}`,
        ],
        ["OOMPolicy", "stop"],
        ["Slice", "rat-king.slice"],
        ["MemoryHigh", "128M"],
        ["MemoryMax", "256M"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "25%"],
        ["TasksMax", "64"],
        ["Nice", "10"],
        ["UMask", "0077"],
        ["TimeoutStartSec", "30min"],
        ["TimeoutStopSec", "90s"],
      ],
      name: "Service",
    },
  ],
  started: false,
});

export const backupTimer = (home: string, ready: string): UnitProps => ({
  home,
  name: "rat-king-mailbox-backup.timer",
  restartOn: [ready],
  scope: "user",
  sections: [
    {
      lines: [["Description", "Rat King nightly mailbox data backup"]],
      name: "Unit",
    },
    {
      lines: [
        ["OnCalendar", "*-*-* 10:00:00 UTC"],
        ["Persistent", "true"],
        ["Unit", "rat-king-mailbox-backup.service"],
      ],
      name: "Timer",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});
