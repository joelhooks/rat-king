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

const node = "/usr/local/bin/node";

const cloudflared = "/usr/local/bin/cloudflared";

const data = "/data/pds";

const backups = "/data/pds-snapshots";

const control = "/run/rat-king-pds/control.sock";

const hardening = [
  ["ProtectHome", "yes"],
  ["ProtectSystem", "strict"],
  ["NoNewPrivileges", "yes"],
  ["PrivateTmp", "yes"],
  ["PrivateDevices", "yes"],
  ["ProtectKernelTunables", "yes"],
  ["ProtectKernelModules", "yes"],
  ["ProtectControlGroups", "yes"],
  ["ProtectKernelLogs", "yes"],
  ["ProtectClock", "yes"],
  ["ProtectHostname", "yes"],
  ["RestrictSUIDSGID", "yes"],
  ["RestrictRealtime", "yes"],
  ["RestrictNamespaces", "yes"],
  ["LockPersonality", "yes"],
  ["CapabilityBoundingSet", ""],
  ["SystemCallFilter", "@system-service"],
  ["RestrictAddressFamilies", "AF_UNIX AF_INET AF_INET6"],
] as const;

const longRunning = [
  ...hardening,
  ["Type", "exec"],
  ["UMask", "0077"],
  ["Restart", "on-failure"],
  ["RestartSec", "5s"],
] as const;

const renderSystemUnit = (sections: UnitProps["sections"]): string =>
  `${sections.map((section) => [`[${section.name}]`, ...section.lines.map(([key, value]) => `${key}=${value}`)].join("\n")).join("\n\n")}\n`;

const publicReadAndSyncPath = String.raw`^/(\.well-known/(did\.json|atproto-did)|xrpc/(_health|com\.atproto\.(repo\.(describeRepo|getRecord|listRecords)|sync\.(getBlob|getBlocks|getLatestCommit|getRepo|getRepoStatus|listBlobs|listRepos|subscribeRepos))))$`;

export const pdsArtifacts = (input: {
  readonly commit: typeof ReleaseCommit.Type;
  readonly hostname: string;
  readonly port: number;
  readonly rotationPublicKey: string;
  readonly tunnel: string | undefined;
}) => {
  const release = `/opt/rat-king-pds/releases/${input.commit}`;

  return {
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
            ["RequiresMountsFor", "/data"],
          ],
          name: "Unit",
        },
        {
          lines: [
            ...longRunning,
            ["User", "pds"],
            ["KillMode", "mixed"],
            ["RuntimeDirectory", "rat-king-pds"],
            ["RuntimeDirectoryMode", "0700"],
            ["IPAddressDeny", "any"],
            ["IPAddressAllow", "127.0.0.0/8 ::1/128"],
            ["UnsetEnvironment", "PDS_EMAIL_SMTP_URL"],
            ["ReadWritePaths", data],
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
            ["WorkingDirectory", release],
            [
              "ExecStart",
              `${node} ${release}/supervisor.ts ${control} ${input.hostname} ${input.port} ${data} ${input.commit} ${input.rotationPublicKey}`,
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
            ["RequiresMountsFor", "/data"],
            ["Requisite", originUnit],
            ["After", originUnit],
          ],
          name: "Unit",
        },
        {
          lines: [
            ...hardening,
            ["Type", "oneshot"],
            ["User", "pds"],
            ["UMask", "0027"],
            ["ReadOnlyPaths", data],
            ["ReadWritePaths", backups],
            ["MemoryMax", "512M"],
            ["CPUQuota", "100%"],
            ["TasksMax", "32"],
            ["TimeoutStartSec", "30min"],
            [
              "ExecStart",
              `${node} ${release}/snapshot.ts snapshot ${control} ${data} ${backups}`,
            ],
            [
              "ExecStopPost",
              `${node} ${release}/snapshot.ts recover ${control}`,
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
            ...longRunning,
            ["DynamicUser", "yes"],
            ["MemoryMax", "256M"],
            ["CPUQuota", "50%"],
            ["TasksMax", "32"],
            [
              "LoadCredential",
              `tunnel.json:${credentialRoot}/rat-king-pds.tunnel.json`,
            ],
            ["ExecStart", `${cloudflared} tunnel --config ${config} run`],
          ],
          name: "Service",
        },
        { lines: [["WantedBy", "multi-user.target"]], name: "Install" },
      ]),
    },
  };
};
