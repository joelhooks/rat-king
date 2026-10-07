import type { UnitProps } from "./systemd.ts";

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const storageRetentionUnit = (
  home: string,
  script: string,
  ready: readonly string[]
): UnitProps => ({
  enabled: false,
  home,
  name: "rat-king-storage-retention.service",
  restartOn: ready,
  scope: "user",
  sections: [
    {
      lines: [
        [
          "Description",
          "Rat King filer metadata log retention and storage alarm",
        ],
        ["Requires", "rat-king-seaweedfs.service"],
        ["After", "rat-king-seaweedfs.service"],
        ["StartLimitIntervalSec", "3600"],
        ["StartLimitBurst", "3"],
      ],
      name: "Unit",
    },
    {
      lines: [
        ["Type", "oneshot"],
        ["ExecStart", `/usr/bin/python3 ${quote(script)} retain`],
        ["Slice", "rat-king.slice"],
        ["MemoryMax", "128M"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "10%"],
        ["TasksMax", "32"],
        ["Nice", "10"],
        ["UMask", "0077"],
        ["TimeoutStartSec", "10min"],
        ["Restart", "on-failure"],
        ["RestartSec", "60"],
      ],
      name: "Service",
    },
  ],
  started: false,
});

export const storageRetentionTimer = (
  home: string,
  ready: readonly string[]
): UnitProps => ({
  home,
  name: "rat-king-storage-retention.timer",
  restartOn: ready,
  scope: "user",
  sections: [
    {
      lines: [["Description", "Rat King hourly filer log retention"]],
      name: "Unit",
    },
    {
      lines: [
        ["OnCalendar", "*-*-* *:15:00 UTC"],
        ["Persistent", "true"],
        ["Unit", "rat-king-storage-retention.service"],
      ],
      name: "Timer",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});
