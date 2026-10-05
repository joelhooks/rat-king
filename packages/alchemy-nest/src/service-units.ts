import type { Node } from "./inventory-schema.ts";
import type { UnitProps } from "./systemd.ts";

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const sliceUnit = (home: string): UnitProps => ({
  home,
  name: "rat-king.slice",
  scope: "user",
  sections: [
    {
      lines: [
        ["MemoryMax", "4G"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "300%"],
        ["TasksMax", "2048"],
      ],
      name: "Slice",
    },
  ],
});

export const storeUnit = (input: {
  readonly home: string;
  readonly binary: string;
  readonly data: string;
  readonly config: string;
  readonly restartOn: readonly string[];
}): UnitProps => ({
  home: input.home,
  name: "rat-king-seaweedfs.service",
  restartOn: input.restartOn,
  scope: "user",
  sections: [
    {
      lines: [
        ["Description", "Rat King object storage"],
        ["StartLimitIntervalSec", "0"],
      ],
      name: "Unit",
    },
    {
      lines: [
        [
          "ExecStart",
          [
            quote(input.binary),
            "server",
            "-ip=127.0.0.1",
            "-ip.bind=127.0.0.1",
            "-master.port=19333",
            "-master.port.grpc=29333",
            "-volume.port=18081",
            "-volume.port.grpc=28081",
            "-filer",
            "-filer.port=18888",
            "-filer.port.grpc=28888",
            "-s3",
            "-s3.port=18333",
            "-s3.port.grpc=28333",
            "-s3.port.iceberg=0",
            "-s3.port.lance=0",
            `-dir=${quote(input.data)}`,
            `-s3.config=${quote(input.config)}`,
            "-master.telemetry=false",
            "-metricsPort=0",
            "-debug=false",
            "-volume.pprof=false",
            "-master.volumeSizeLimitMB=64",
            "-volume.max=8",
          ].join(" "),
        ],
        ["WorkingDirectory", input.data.replaceAll("%", "%%")],
        ["Environment", "SENTRY_DSN="],
        ["Environment", "OTEL_SDK_DISABLED=true"],
        ["Slice", "rat-king.slice"],
        ["MemoryMax", "1G"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "100%"],
        ["TasksMax", "512"],
        ["Nice", "10"],
        ["Restart", "on-failure"],
        ["RestartSec", "10"],
        ["UMask", "0077"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});

export const nodeUnit = (input: {
  readonly host: Node;
  readonly binary: string;
  readonly data: string;
  readonly environment: string;
  readonly restartOn: readonly string[];
}): UnitProps => ({
  home: input.host.home,
  name: "rat-king-celld.service",
  restartOn: input.restartOn,
  scope: "user",
  sections: [
    {
      lines: [
        ["Description", "Rat King cell node"],
        ["Requires", "rat-king-seaweedfs.service"],
        ["After", "rat-king-seaweedfs.service"],
        ["StartLimitIntervalSec", "0"],
      ],
      name: "Unit",
    },
    {
      lines: [
        [
          "ExecStart",
          `${quote(input.binary)} --listen ${input.host.tailnetIPv4}:18787 --internal-listen 127.0.0.1:18788`,
        ],
        ["EnvironmentFile", quote(input.environment)],
        ["WorkingDirectory", input.data.replaceAll("%", "%%")],
        ["Environment", "CELLD_OTEL=0"],
        ["Environment", quote(`CELLD_TEST_DATA_DIR=${input.data}`)],
        ["Slice", "rat-king.slice"],
        ["MemoryMax", "3G"],
        ["MemorySwapMax", "0"],
        ["CPUQuota", "200%"],
        ["TasksMax", "1024"],
        ["Nice", "10"],
        ["Restart", "on-failure"],
        ["RestartSec", "10"],
        ["UMask", "0077"],
      ],
      name: "Service",
    },
    { lines: [["WantedBy", "default.target"]], name: "Install" },
  ],
});
