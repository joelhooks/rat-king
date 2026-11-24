import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { OriginPort, pdsArtifacts, UnitPath } from "./unit.ts";

const examples = {
  commit: "a".repeat(40),
  hostname: "pds.example.org",
  port: 2583,
  rotationPublicKey: `02${"a".repeat(64)}`,
  tunnel: "00000000-0000-4000-8000-000000000001",
};

it.prop(
  "the connector and origin agree on a loopback port without relaxing service isolation",
  {
    port: Arbitrary.schema(OriginPort),
  },
  ({ port }) => {
    const { ingress, origin, snapshot, timer, tunnel } = pdsArtifacts({
      ...examples,
      port,
    });

    expect(
      ingress?.text
        .match(/^\s+service: http:\/\/[^\n]+$/gmu)
        ?.map((line) => line.trim())
    ).toEqual([`service: http://127.0.0.1:${port}`]);
    expect(origin.text).toContain(
      ` ${examples.hostname} ${port} /data/pds ${examples.commit} `
    );
    expect(origin.text).toContain("\nUser=pds\n");
    expect(origin.text).toContain("\nReadWritePaths=/data/pds\n");
    expect(origin.text).toContain(
      "\nIPAddressDeny=any\nIPAddressAllow=127.0.0.0/8 ::1/128\n"
    );
    expect(origin.text).toContain("\nUnsetEnvironment=PDS_EMAIL_SMTP_URL\n");
    const release = `/opt/rat-king-pds/releases/${examples.commit}`;

    expect(origin.text).toContain(
      `\nExecStart=/usr/local/bin/node ${release}/supervisor.ts `
    );
    expect(tunnel.text).toContain("\nExecStart=/usr/local/bin/cloudflared ");
    expect(origin.text).toContain("\nProtectHome=yes\n");
    expect(origin.text).not.toContain("EnvironmentFile=");
    expect(origin.text.match(/^LoadCredential=.*$/gmu)).toEqual([
      "LoadCredential=jwt:/etc/credstore/rat-king-pds.jwt-secret",
      "LoadCredential=admin:/etc/credstore/rat-king-pds.admin-password",
      "LoadCredential=plc:/etc/credstore/rat-king-pds.plc-rotation-key",
    ]);
    expect(tunnel.text.match(/^LoadCredential=.*$/gmu)).toEqual([
      "LoadCredential=tunnel.json:/etc/credstore/rat-king-pds.tunnel.json",
    ]);
    expect(tunnel.text).toContain(`\nRequisite=${origin.name}\n`);
    expect(snapshot.text).toContain(
      " snapshot /run/rat-king-pds/control.sock /data/pds /data/pds-snapshots\n"
    );
    expect(snapshot.text).toContain("\nUser=pds\n");
    expect(snapshot.text).toContain(
      "\nReadOnlyPaths=/data/pds\nReadWritePaths=/data/pds-snapshots\n"
    );
    expect(snapshot.text).toContain(
      `\nExecStopPost=/usr/local/bin/node ${release}/snapshot.ts recover /run/rat-king-pds/control.sock\n`
    );

    for (const service of [origin, snapshot, tunnel]) {
      expect(service.text).toContain("\nProtectHome=yes\n");
      expect(service.text).toContain(
        "\nCapabilityBoundingSet=\nSystemCallFilter=@system-service\n"
      );
      expect(service.text).not.toContain("MemoryDenyWriteExecute=");
    }

    expect(timer.text).toContain(`\nUnit=${snapshot.name}\n`);
    expect(timer.text).toContain(
      "OnCalendar=*-*-* 01:00:00 America/Los_Angeles"
    );
  }
);

it.prop(
  "exact paths allow federation reads but never forward admin, publisher or nested paths",
  {
    denied: Arbitrary.schema(
      Schema.Literals([
        "/xrpc/com.atproto.admin.getAccountInfo",
        "/xrpc/com.atproto.server.createInviteCode",
        "/xrpc/com.atproto.server.createInviteCodes",
        "/xrpc/com.atproto.server.createAccount",
        "/xrpc/com.atproto.server.createSession",
        "/xrpc/com.atproto.repo.putRecord",
        "/xrpc/com.atproto.repo.getRecord/extra",
        "/.well-known/did.json/extra",
        "/xrpc%2fcom.atproto.admin.getAccountInfo",
      ])
    ),
  },
  ({ denied }) => {
    const { ingress } = pdsArtifacts(examples);
    const text = ingress?.text ?? "";

    const pattern = /^\s+path: '(?<allowed>[^']+)'$/mu.exec(text)?.groups
      ?.allowed;

    expect(pattern).toBeDefined();

    const allowed = new RegExp(pattern ?? "^$", "u");

    expect(allowed.test(denied)).toBe(false);
    expect(allowed.test("/xrpc/com.atproto.repo.getRecord")).toBe(true);
    expect(allowed.test("/xrpc/com.atproto.sync.subscribeRepos")).toBe(true);
    expect(allowed.test("/.well-known/did.json")).toBe(true);
    expect(allowed.test("/.well-known/atproto-did")).toBe(true);
    expect(text).toContain(
      `  - hostname: ${examples.hostname}\n    service: http_status:403\n  - service: http_status:404`
    );
  }
);

it("does not stage an ingress route before the connector is assigned", () => {
  expect(
    pdsArtifacts({ ...examples, tunnel: undefined }).ingress
  ).toBeUndefined();
});

it.prop(
  "unit path inputs cannot inject systemd substitutions or traverse a parent",
  {
    bad: Arbitrary.schema(
      Schema.Literals(["..", "a b", "%i", "$HOME", "a\nb", ""])
    ),
  },
  ({ bad }) => {
    expect(Schema.is(UnitPath)(`/srv/${bad}/pds`)).toBe(false);
  }
);
