import type { Node } from "./inventory-schema.ts";
import { nodeListener, storeListener } from "./listener-contract.ts";
import type { UnitProps } from "./systemd.ts";

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$")}"`;

export const sliceUnit = (
  home: string,
  memoryMax = "4G",
  cpuQuota = "300%"
): UnitProps => ({
  home,
  name: "rat-king.slice",
  scope: "user",
  sections: [
    {
      lines: [
        ["MemoryMax", memoryMax],
        ["MemorySwapMax", "0"],
        ["CPUQuota", cpuQuota],
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
  readonly restartGate?:
    | { readonly path: string; readonly address: string }
    | undefined;
  readonly restartOn: readonly string[];
}): UnitProps => ({
  home: input.home,
  name: storeListener.unit,
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
            `-ip=${storeListener.address}`,
            `-ip.bind=${storeListener.address}`,
            ...Object.entries(storeListener.ports).map(
              ([flag, port]) => `-${flag}=${port}`
            ),
            "-filer",
            "-s3",
            "-s3.port.iceberg=0",
            "-s3.port.lance=0",
            `-dir=${quote(input.data)}`,
            `-s3.config=${quote(input.config)}`,
            "-master.telemetry=false",
            "-metricsPort=0",
            "-debug=false",
            "-volume.pprof=false",
            "-master.volumeSizeLimitMB=64",
            "-volume.max=64",
          ].join(" "),
        ],
        ...(input.restartGate === undefined
          ? []
          : [
              [
                "ExecStartPost",
                `/usr/local/bin/node ${quote(input.restartGate.path)} ${quote(input.restartGate.address)} store`,
              ] satisfies readonly [string, string],
            ]),
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
  readonly workerIPv4?: string;
  readonly binary: string;
  readonly data: string;
  readonly environment: string;
  readonly restartGate?:
    | { readonly path: string; readonly address: string }
    | undefined;
  readonly restartOn: readonly string[];
}): UnitProps => ({
  home: input.host.home,
  name: nodeListener.unit,
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
          `${quote(input.binary)} --listen ${input.workerIPv4 ?? input.host.tailnetIPv4}:${nodeListener.port} --internal-listen ${nodeListener.internalAddress}:${nodeListener.internalPort}`,
        ],
        ...(input.restartGate === undefined
          ? []
          : [
              [
                "ExecStartPost",
                `/usr/local/bin/node ${quote(input.restartGate.path)} ${quote(input.restartGate.address)} node`,
              ] satisfies readonly [string, string],
            ]),
        ["EnvironmentFile", input.environment.replaceAll("%", "%%")],
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
