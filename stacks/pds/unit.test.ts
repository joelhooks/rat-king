import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import { expect } from "vitest";

import { OriginPort, pdsArtifacts, UnitPath } from "./unit.ts";

const examples = {
  backups: "/srv/example/backups/pds",
  cloudflared: "/usr/bin/cloudflared",
  commit: "a".repeat(40),
  data: "/srv/example/pds",
  hostname: "pds.example.org",
  node: "/usr/bin/node",
  port: 2583,
  release: "/opt/example/pds/releases/current",
  rotationPublicKey: `02${"a".repeat(64)}`,
  tunnel: "00000000-0000-4000-8000-000000000001",
};

it.prop(
  "the connector and origin agree on a loopback port without relaxing service isolation",
  {
    data: Arbitrary.schema(
      Schema.Literals(["/srv/example/data", "/var/lib/example"])
    ),
    port: Arbitrary.schema(OriginPort),
  },
  ({ data, port }) => {
    const { ingress, origin, snapshot, timer, tunnel } = pdsArtifacts({
      ...examples,
      data,
      port,
    });

    expect(
      ingress?.text
        .match(/^\s+service: http:\/\/[^\n]+$/gmu)
        ?.map((line) => line.trim())
    ).toEqual([`service: http://127.0.0.1:${port}`]);
    expect(origin.text).toContain(
      ` ${examples.hostname} ${port} ${data} ${examples.commit} `
    );
    expect(origin.text).toContain("\nUser=pds\n");
    expect(origin.text).toContain(`\nReadWritePaths=${data}\n`);
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
    expect(snapshot.text).toContain(` snapshot ${data} ${examples.backups}\n`);
    expect(snapshot.text).toContain("\nUser=root\n");
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
