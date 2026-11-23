import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { Digest } from "effect/crypto";
import { expect } from "vitest";

import { healthScript } from "../../../../stacks/nest/health-script.ts";
import { ShipSettings } from "../../../../stacks/nest/ship-config.ts";
import { StageConfig } from "../../../../stacks/nest/stage-config.ts";
import { fixtureChild } from "./fixture-child.ts";

const alias = "fixture-ct";

const login = "/fixture-login";

const data = "/fixture-data";

const backup = "/fixture-backup";

const marker = "/fixture-state/deploy.json";

const invocation = "0123456789abcdef0123456789abcdef";

const service = "rat-king-mailbox-backup.service";

const times = [
  "--property=Result",
  "--property=ExecMainStartTimestamp",
  "--property=ExecMainExitTimestamp",
];

const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

const wrapped = (body: string) =>
  `sh -c ${quote(`printf '\\036hostshell-started\\n' >&2; ${body}`)}`;

const exec = (...argv: readonly string[]) =>
  wrapped(`exec ${["timeout", "-k", "2", "20", ...argv].map(quote).join(" ")}`);

const read = (path: string) =>
  wrapped(
    `if [ -L '${path}' ]; then exit 1; elif [ ! -e '${path}' ]; then exit 44; else test -f '${path}' && base64 -- '${path}'; fi`
  );

const show = (unit: string, ...properties: readonly string[]) =>
  exec("systemctl", "--user", "show", "--timestamp=unix", unit, ...properties);

const commands = [
  wrapped("uname -s; id -u"),
  read(marker),
  read("/fixture-state/window-receipts.jsonl"),
  ...["rat-king-celld.service", "rat-king-seaweedfs.service"].map((unit) =>
    show(
      unit,
      "--property=ActiveState",
      "--property=NRestarts",
      "--property=ActiveEnterTimestamp",
      "--property=MainPID",
      "--property=MemoryMax"
    )
  ),
  ...[
    "rat-king-seaweedfs.service",
    "rat-king-celld.service",
    "rat-king-claude-sidecar.service",
  ].map((unit) =>
    exec(
      "systemctl",
      "--user",
      "show",
      unit,
      "--property=ControlGroup",
      "--value"
    )
  ),
  exec("ss", "-H", "-ltnp", "--cgroup"),
  exec("du", "-sb", `${data}/celld`, `${data}/seaweedfs`),
  exec(
    "/usr/bin/python3",
    `${login}/.local/share/rat-king/bin/storage-maintenance.py`,
    "diagnose"
  ),
  exec("/usr/bin/python3", "-c", healthScript, "volumes", "rat-king-cells"),
  exec("/usr/bin/python3", "-c", healthScript, "share", backup),
  exec("/usr/bin/python3", "-c", healthScript, "memory"),
  show(service, ...times, "--property=MemoryPeak", "--property=InvocationID"),
  exec(
    "journalctl",
    "--user",
    `--unit=${service}`,
    `_SYSTEMD_INVOCATION_ID=${invocation}`,
    "--output=cat",
    "--no-pager"
  ),
  show("rat-king-mailbox-backup.timer", "--property=NextElapseUSecRealtime"),
  show("rat-king-storage-retention.service", ...times),
];

const fakeSsh = `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const [alias, command] = process.argv.slice(-2);
appendFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify([alias, command]) + '\\n');
if (command.endsWith('uname -s; id -u' + "'")) process.stdout.write('Linux\\n1000\\n');
else if (command.includes('--property=InvocationID')) process.stdout.write('InvocationID=${invocation}\\n');
else if (command.includes('then exit 44;')) process.exitCode = 44;
`;

it.effect.prop(
  "early alarm's CT SSH command set matches the forced-command contract",
  [StageConfig, ShipSettings],
  ([base, ship]) =>
    Effect.gen(function* check() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const capture = `${home}/commands.jsonl`;
      const inventory = `${home}/inventory.json`;
      const stage = `${home}/stage.json`;
      const preload = `${home}/no-network.mjs`;
      const { RAT_KING_BUCKET: _bucket, ...runtime } = base.runtime;

      const paths = {
        errorLog: `${home}/error`,
        node: process.execPath,
        outputLog: `${home}/output`,
        path: home,
        source: home,
      };

      const config = {
        alarm: {
          broadcast: "fixture-alerts",
          enabled: true,
          maintenanceInbox: { operatorUid: 1000, path: `${home}/requests` },
          musterDesk: "fixture-desk",
          notify: {
            directory: `${home}/directory.json`,
            secret: "fixture-identity",
          },
          owners: {},
          systemd: {
            ...paths,
            group: "fixture-alarm",
            scope: "system" as const,
            unit: "fixture-alarm.service",
            user: "fixture-alarm",
          },
        },
        comms: {
          local: {
            quarantine: `${home}/quarantine`,
            receipts: `${home}/receipts`,
          },
        },
        doctor: { primary: { node: `${home}/doctor` } },
        runtime: {
          ...runtime,
          HOME: home,
          RATS_NEST_INSTANCE: inventory,
          RAT_KING_BACKUP_ROOT: backup,
          RAT_KING_CLAUDE_SIDECAR: false,
          RAT_KING_LIVE_NODE: alias,
          RAT_KING_OFFLINE_PLAN: false,
          RAT_KING_SECRET_SOURCE: "agent-secrets" as const,
          RAT_KING_STAGE: "fleet" as const,
          RAT_KING_STATE_DIR: home,
        },
        ship: {
          ...ship,
          receipts: `${home}/ship.jsonl`,
          restart: { ...ship.restart, marker },
        },
      };

      yield* fs.writeFileString(
        inventory,
        JSON.stringify({
          domains: ["example.invalid"],
          hosts: [alias],
          ips: ["192.0.2.41"],
          nodes: {
            [alias]: {
              dataRoot: data,
              home: login,
              ssh: alias,
              tailnetIPv4: "192.0.2.41",
            },
          },
          secretNames: ["fixture-identity"],
          sites: ["fixture"],
        }),
        { mode: 0o600 }
      );
      yield* fs.writeFileString(
        stage,
        yield* Schema.encodeEffect(Schema.fromJsonString(StageConfig))(config)
      );
      yield* fs.writeFileString(`${home}/ssh`, fakeSsh, { mode: 0o700 });
      yield* fs.writeFileString(`${home}/python3`, "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      yield* fs.writeFileString(
        `${home}/doctor`,
        '#!/bin/sh\nprintf \'%s\\n\' \'{"status":"ok","reasons":[]}\'\n',
        { mode: 0o700 }
      );
      yield* fs.writeFileString(
        preload,
        "globalThis.fetch = () => Promise.resolve(new Response(null));\n"
      );

      const result = yield* fixtureChild(
        ["--import", preload, "stacks/nest/cli.ts", "alarm-check"],
        home,
        { FIXTURE_CAPTURE: capture, RAT_KING_STAGE_CONFIG: stage }
      );

      expect(result.code, result.stdout + result.stderr).toBe(0);

      const lines = (yield* fs.readFileString(capture)).trim().split("\n");

      const digest = yield* Digest.Digest;

      const hex = yield* digest.digestHex(
        Digest.sha256,
        new TextEncoder().encode(healthScript)
      );

      expect(new Set(lines)).toEqual(
        new Set(commands.map((command) => JSON.stringify([alias, command])))
      );

      expect(hex).toBe(
        "238385836a7776aa68e5c45f14a83fc1199daf9351f5309645225182b630d718"
      );
    }).pipe(
      Effect.scoped,
      Effect.provide([Digest.layerWebCrypto, NodeServices.layer])
    ),
  { arbitrary: { runs: 1 } }
);
