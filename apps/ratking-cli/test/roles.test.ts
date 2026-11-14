import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { Arbitrary, Console, Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import { runRatking } from "../src/main.ts";
import { Wiring } from "../src/session.ts";
import { captured, fakeMailbox, PEER, people, seeded } from "./fixture.ts";
import type { FakeIssuer } from "./fixture.ts";

const Case = Schema.Literals([
  "forward",
  "direct",
  "retired",
  "unresolved",
  "unavailable",
]);

type CaseValue = typeof Case.Type;

const issuerFor = (kind: CaseValue): FakeIssuer => {
  const routes = {
    direct: {
      body: { chain: ["peer"], did: PEER, name: "peer" },
      status: 200,
    },
    forward: {
      body: { chain: ["proj", "peer"], did: PEER, name: "peer" },
      status: 200,
    },
    retired: {
      body: {
        error: "Retired",
        message: "peer was retired; no successor; chain proj → peer",
      },
      status: 410,
    },
    unavailable: undefined,
    unresolved: {
      body: {
        error: "RoleUnresolved",
        message: "proj cycles: proj → peer → proj",
      },
      status: 409,
    },
  }[kind];

  return routes === undefined
    ? {}
    : { routes: new Map([[kind === "direct" ? "peer" : "proj", routes]]) };
};

const Sent = Schema.Struct({
  envelope: Schema.Struct({
    aad: Schema.Struct({ recipientDid: Schema.String }),
  }),
  resolvedFrom: Schema.optionalKey(Schema.String),
});

const Printed = Schema.fromJsonString(
  Schema.Struct({
    delivered: Schema.optionalKey(
      Schema.Struct({
        resolvedTo: Schema.optionalKey(Schema.String),
        to: Schema.String,
      })
    ),
    ok: Schema.Boolean,
  })
);

it.live.prop(
  "a send seals to the row the issuer names and carries resolvedFrom; Retired and RoleUnresolved stop it before sealing; an issuer that cannot answer leaves the direct path",
  [Arbitrary.schema(Case)],
  ([kind]) =>
    Effect.gen(function* forwarding() {
      const fs = yield* FileSystem.FileSystem;
      const who = yield* people;
      const mailbox = fakeMailbox([], undefined, undefined, issuerFor(kind));
      const out = captured();
      const to = kind === "direct" || kind === "unavailable" ? "peer" : "proj";

      const wiring = harness(
        yield* fs.makeTempDirectoryScoped(),
        mailbox.http,
        [],
        { secrets: seeded(who) }
      );

      yield* Directory.use((directory) =>
        directory.record("peer", who.peerDocument)
      ).pipe(Effect.provide(wiring));

      yield* runRatking([
        "send",
        "--json",
        "--as",
        "tester",
        "--to",
        to,
        "--summary",
        "hello",
        "--body",
        "hello",
      ]).pipe(
        Effect.provideService(Console.Console, out.console),
        Effect.provideService(Wiring, wiring)
      );

      const sent = yield* Effect.forEach(
        mailbox.calls.filter((call) => call.nsid.endsWith(".send")),
        (call) => Schema.decodeUnknownEffect(Sent)(call.body)
      );

      const printed = yield* Schema.decodeUnknownEffect(Printed)(
        out.stdout[0] ?? "{}"
      );

      if (kind === "retired" || kind === "unresolved") {
        expect(sent).toEqual([]);
        expect(printed.ok).toBe(false);
        expect(out.stderr.join("\n")).toContain(
          kind === "retired" ? "Retired" : "RoleUnresolved"
        );

        return;
      }

      expect(sent.map((entry) => entry.envelope.aad.recipientDid)).toEqual([
        PEER,
      ]);
      expect(sent[0]?.resolvedFrom).toBe(
        kind === "forward" ? "proj" : undefined
      );
      expect(printed).toEqual({
        delivered:
          kind === "forward"
            ? { resolvedTo: "peer", to: "proj" }
            : { to: "peer" },
        ok: true,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 60_000 }
);

const Roles = Schema.Array(
  Schema.Struct({
    name: Schema.Literals(["desk", "owners", "proj", "rat-king", "triage"]),
    role: Schema.String.check(Schema.isPattern(/^[A-Za-z][a-z ]{0,20}$/u)),
    target: Schema.Literals(["peer", "other"]),
  })
);

it.live.prop(
  "role list --json prints every role across issuer pages",
  [Arbitrary.schema(Roles)],
  ([generated]) =>
    Effect.gen(function* roleList() {
      const fs = yield* FileSystem.FileSystem;
      const who = yield* people;

      const roles = [
        ...new Map(generated.map((role) => [role.name, role])).values(),
      ];

      const mailbox = fakeMailbox([], undefined, undefined, { roles });
      const out = captured();

      yield* runRatking(["role", "list", "--json", "--as", "tester"]).pipe(
        Effect.provideService(Console.Console, out.console),
        Effect.provideService(
          Wiring,
          harness(yield* fs.makeTempDirectoryScoped(), mailbox.http, [], {
            secrets: seeded(who),
          })
        )
      );

      expect(out.stderr).toEqual([]);
      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
          out.stdout[0] ?? "{}"
        )
      ).toEqual({ command: "role list", ok: true, roles });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 60_000 }
);
