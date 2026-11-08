import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { Inbox } from "@rat-king/ratking-client/ratking";
import { Console, Effect, FileSystem, Result, Schema } from "effect";
import { expect } from "vitest";

import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import { runRatking } from "../src/main.ts";
import { Wiring } from "../src/session.ts";
import { captured, fakeMailbox, people, TESTER } from "./fixture.ts";

const Label = Schema.String.check(Schema.isPattern(/^[a-z]{1,12}$/u));

const Whoami = Schema.fromJsonString(
  Schema.Struct({
    key: Schema.Struct({ held: Schema.Boolean, source: Schema.String }),
    name: Schema.String,
    ok: Schema.Boolean,
  })
);

const Doctor = Schema.fromJsonString(
  Schema.Struct({
    checks: Schema.Array(
      Schema.Struct({
        check: Schema.String,
        detail: Schema.String,
        ok: Schema.Boolean,
      })
    ),
  })
);

for (const mode of ["script", "both"] as const) {
  it.effect.prop(
    `${mode}: send, whoami and doctor use the selected key for canonical names and aliases`,
    [Label, Schema.Boolean, Schema.Boolean],
    ([label, namespaced, viaAlias]) =>
      Effect.gen(function* selectedIdentity() {
        const fs = yield* FileSystem.FileSystem;
        const who = yield* people;
        const name = namespaced ? `acme/${label}` : label;
        const alias = `alias/${label}`;
        const fleet = `rat_king_fleet_agent_${name.replace("/", ".")}_identity`;
        const script = `rat_king_script_${name.replace("/", "-")}_identity`;
        const selected = mode === "both" ? fleet : script;

        const secrets = new Map([
          [
            script,
            mode === "both"
              ? "malformed unused key"
              : JSON.stringify(who.tester),
          ],
        ]);

        if (mode === "both") {
          secrets.set(fleet, JSON.stringify(who.tester));
        }

        const before = [...secrets];
        const mailbox = fakeMailbox([]);

        const wiring = harness(
          yield* fs.makeTempDirectoryScoped(),
          mailbox.http,
          [],
          {
            reserved: { [name]: { aliases: [alias], did: TESTER } },
            secrets,
          }
        );

        yield* Effect.gen(function* peer() {
          yield* (yield* Directory).record("peer", who.peerDocument);
        }).pipe(Effect.provide(wiring));

        const run = (args: readonly string[]) => {
          const output = captured();

          return runRatking([
            ...args,
            "--as",
            viaAlias ? alias : name,
            "--json",
          ]).pipe(
            Effect.provideService(Console.Console, output.console),
            Effect.provideService(Wiring, wiring),
            Effect.as(output)
          );
        };

        const sent = yield* run(["send", "--to", "peer", "--body", label]);
        expect(sent.stderr).toEqual([]);
        expect(mailbox.sends).toHaveLength(1);
        expect(mailbox.sends[0]?.aad.senderDid).toBe(TESTER);

        const me = yield* run(["whoami"]);
        expect(me.stderr).toEqual([]);
        expect(
          yield* Schema.decodeEffect(Whoami)(me.stdout.join("\n"))
        ).toMatchObject({
          key: { held: true, source: `secret:${selected}` },
          name,
          ok: true,
        });

        const doctor = yield* run(["doctor"]);
        expect(doctor.stderr).toEqual([]);

        const report = yield* Schema.decodeEffect(Doctor)(
          doctor.stdout.join("\n")
        );

        expect(report.checks.find((check) => check.check === "key")).toEqual({
          check: "key",
          detail: `secret:${selected} present`,
          ok: true,
        });
        expect([...secrets]).toEqual(before);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { arbitrary: { runs: 8 }, timeout: 30_000 }
  );
}

it.effect.prop(
  "neither candidate: attach refuses NoIdentity without minting or using an arbitrary secret",
  [Label],
  ([name]) =>
    Effect.gen(function* missingIdentity() {
      const fs = yield* FileSystem.FileSystem;
      const who = yield* people;

      const secrets = new Map([
        [`arbitrary_${name}_identity`, JSON.stringify(who.tester)],
      ]);

      const wiring = harness(
        yield* fs.makeTempDirectoryScoped(),
        fakeMailbox([]).http,
        [],
        { secrets }
      );

      yield* Effect.gen(function* refusedAttach() {
        const inbox = yield* Inbox;
        const located = yield* inbox.locate(name);
        expect(located.held).toBe(false);
        const result = yield* inbox.attach(name).pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure.code).toBe(
          "NoIdentity"
        );
        expect(secrets.size).toBe(1);
      }).pipe(Effect.provide(wiring));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 } }
);

it.effect.prop(
  "colliding script labels cannot attach an identity belonging to another name",
  [Label],
  ([label]) =>
    Effect.gen(function* collision() {
      const fs = yield* FileSystem.FileSystem;
      const who = yield* people;
      const owner = `acme/${label}-job`;
      const other = `acme-${label}/job`;
      const secret = `rat_king_script_acme-${label}-job_identity`;
      const secrets = new Map([[secret, JSON.stringify(who.tester)]]);
      const before = [...secrets];

      const wiring = harness(
        yield* fs.makeTempDirectoryScoped(),
        fakeMailbox([]).http,
        [],
        {
          reserved: { [owner]: { did: TESTER } },
          secrets,
        }
      );

      yield* Effect.gen(function* refusedCollision() {
        const inbox = yield* Inbox;
        expect((yield* inbox.locate(owner)).secret).toBe(secret);
        expect((yield* inbox.locate(other)).secret).toBe(secret);
        const result = yield* inbox.attach(other).pipe(Effect.result);
        expect(Result.isFailure(result) && result.failure.code).toBe(
          "NoIdentity"
        );
        expect(Result.isFailure(result) && result.failure.reason).toContain(
          "does not belong"
        );
        expect([...secrets]).toEqual(before);
      }).pipe(Effect.provide(wiring));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 8 } }
);
