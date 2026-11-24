import { Schema } from "effect";

import type { UnitProps } from "../../packages/alchemy-nest/src/systemd.ts";

export const UnitPath = Schema.String.check(
  Schema.isPattern(
    /^\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/u
  )
);

export const OriginHost = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u),
  Schema.isMaxLength(253)
);

export const OriginPort = Schema.Int.check(
  Schema.isBetween({ maximum: 65_535, minimum: 1024 })
);

export const ReleaseCommit = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{40}$/u)
);

export const RotationPublicKey = Schema.String.check(
  Schema.isPattern(/^0[23][a-f0-9]{64}$/u)
);

export const TunnelId = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u)
);

const originUnit = "rat-king-pds.service";

const tunnelUnit = "rat-king-pds-tunnel.service";

const snapshotUnit = "rat-king-pds-snapshot.service";

const config = "/etc/rat-king-pds/ingress.yml";

const credentialRoot = "/etc/credstore";

const hardening = [
  ["Type", "exec"],
  ["ProtectHome", "yes"],
  ["ProtectSystem", "strict"],
  ["NoNewPrivileges", "yes"],
  ["UMask", "0077"],
  ["Restart", "on-failure"],
  ["RestartSec", "5s"],
] as const;

const renderSystemUnit = (sections: UnitProps["sections"]): string =>
  `${sections.map((section) => [`[${section.name}]`, ...section.lines.map(([key, value]) => `${key}=${value}`)].join("\n")).join("\n\n")}\n`;

const publicReadAndSyncPath = String.raw`^/(\.well-known/did\.json|xrpc/(_health|com\.atproto\.(repo\.(describeRepo|getRecord|listRecords)|sync\.(getBlob|getBlocks|getLatestCommit|getRepo|getRepoStatus|listBlobs|listRepos|subscribeRepos))))$`;

export const pdsArtifacts = (input: {
  readonly backups: string;
  readonly cloudflared: string;
  readonly commit: string;
  readonly data: string;
  readonly hostname: string;
  readonly node: string;
  readonly port: number;
  readonly release: string;
  readonly rotationPublicKey: string;
  readonly tunnel: string | undefined;
}) => ({
  ingress:
    input.tunnel === undefined
      ? undefined
      : {
          name: "ingress.yml",
          text: [
            `tunnel: ${input.tunnel}`,
            `credentials-file: /run/credentials/${tunnelUnit}/tunnel.json`,
            "no-autoupdate: true",
            "ingress:",
            `  - hostname: ${input.hostname}`,
            `    path: '${publicReadAndSyncPath}'`,
            `    service: http://127.0.0.1:${input.port}`,
            "    originRequest:",
            `      httpHostHeader: ${input.hostname}`,
            `  - hostname: ${input.hostname}`,
            "    service: http_status:403",
            "  - service: http_status:404",
            "",
          ].join("\n"),
        },
  origin: {
    name: originUnit,
    text: renderSystemUnit([
      {
        lines: [
          ["Description", "Rat King AT Protocol Personal Data Server"],
          ["RequiresMountsFor", input.data],
        ],
        name: "Unit",
      },
      {
        lines: [
          ...hardening,
          ["User", "pds"],
          ["ReadWritePaths", input.data],
          ["MemoryHigh", "768M"],
          ["MemoryMax", "1G"],
          ["CPUQuota", "100%"],
          ["TasksMax", "64"],
          ["LoadCredential", `jwt:${credentialRoot}/rat-king-pds.jwt-secret`],
          [
            "LoadCredential",
            `admin:${credentialRoot}/rat-king-pds.admin-password`,
          ],
          [
            "LoadCredential",
            `plc:${credentialRoot}/rat-king-pds.plc-rotation-key`,
          ],
          ["WorkingDirectory", input.release],
          [
            "ExecStart",
            `${input.node} ${input.release}/server.ts ${input.hostname} ${input.port} ${input.data} ${input.commit} ${input.rotationPublicKey}`,
          ],
          ["TimeoutStopSec", "60s"],
        ],
        name: "Service",
      },
      { lines: [["WantedBy", "multi-user.target"]], name: "Install" },
    ]),
  },
  snapshot: {
    name: snapshotUnit,
    text: renderSystemUnit([
      {
        lines: [
          ["Description", "Rat King PDS consistent local snapshot"],
          ["RequiresMountsFor", `${input.data} ${input.backups}`],
        ],
        name: "Unit",
      },
      {
        lines: [
          ["Type", "oneshot"],
          ["User", "root"],
          ["ProtectHome", "yes"],
          ["ProtectSystem", "strict"],
          ["NoNewPrivileges", "yes"],
          ["UMask", "0077"],
          ["RuntimeDirectory", "rat-king-pds-snapshot"],
          ["RuntimeDirectoryMode", "0700"],
          ["ReadWritePaths", `${input.data} ${input.backups}`],
          ["MemoryMax", "512M"],
          ["CPUQuota", "100%"],
          ["TasksMax", "32"],
          ["TimeoutStartSec", "30min"],
          [
            "ExecStart",
            `${input.node} ${input.release}/snapshot.ts snapshot ${input.data} ${input.backups}`,
          ],
          [
            "ExecStopPost",
            `${input.node} ${input.release}/snapshot.ts recover`,
          ],
        ],
        name: "Service",
      },
    ]),
  },
  timer: {
    name: "rat-king-pds-snapshot.timer",
    text: renderSystemUnit([
      {
        lines: [["Description", "Nightly Rat King PDS snapshot"]],
        name: "Unit",
      },
      {
        lines: [
          ["OnCalendar", "*-*-* 01:00:00 America/Los_Angeles"],
          ["Unit", snapshotUnit],
        ],
        name: "Timer",
      },
      { lines: [["WantedBy", "timers.target"]], name: "Install" },
    ]),
  },
  tunnel: {
    name: tunnelUnit,
    text: renderSystemUnit([
      {
        lines: [
          ["Description", "Rat King PDS Cloudflare Tunnel connector"],
          ["After", `network-online.target ${originUnit}`],
          ["Wants", "network-online.target"],
          ["Requisite", originUnit],
        ],
        name: "Unit",
      },
      {
        lines: [
          ...hardening,
          ["DynamicUser", "yes"],
          ["MemoryMax", "256M"],
          ["CPUQuota", "50%"],
          ["TasksMax", "32"],
          [
            "LoadCredential",
            `tunnel.json:${credentialRoot}/rat-king-pds.tunnel.json`,
          ],
          ["ExecStart", `${input.cloudflared} tunnel --config ${config} run`],
        ],
        name: "Service",
      },
      { lines: [["WantedBy", "multi-user.target"]], name: "Install" },
    ]),
  },
});
