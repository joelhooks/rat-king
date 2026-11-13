import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { claimName } from "@rat-king/ratking-client/identity";
import {
  Arbitrary,
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Schema,
} from "effect";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { collectFacts } from "../src/extension.ts";
import { connectedFacts, interactiveSession } from "../src/name.ts";
import { fakeMailbox } from "./fake-mailbox.ts";
import { harness } from "./harness.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-z]{4,12}$/u));

it.effect.prop(
  "only a real TUI auto-names, even when RPC advertises dialog support",
  [
    Arbitrary.schema(Schema.Literals(["tui", "rpc", "json", "print"])),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([mode, hasUI]) =>
    Effect.gen(function* proof() {
      const facts = yield* collectFacts(
        "0123456789",
        undefined,
        interactiveSession({ hasUI, mode })
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))
        )
      );

      expect(Option.getOrUndefined(facts.env)).toBe(
        hasUI && mode === "tui" ? "pi-01234567" : undefined
      );
      expect(facts.nameless).toBe(!(hasUI && mode === "tui"));
    })
);

it.live.prop(
  "derived requests refuse reserved aliases, directory names and other live session claims before leasing",
  [Arbitrary.schema(Name)],
  ([name]) =>
    Effect.gen(function* proof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const box = fakeMailbox("accept");

      const facts = {
        alive: () => true,
        derived: true,
        env: Option.some(name),
        pane: Option.none<string>(),
        pid: 1,
        session: "requester",
      };

      yield* fs.writeFileString(
        `${state}/claims.json`,
        JSON.stringify({
          [name]: { pid: 2, session: "holder-session" },
        })
      );
      yield* Effect.gen(function* checks() {
        const held = yield* claimName(facts).pipe(Effect.flip);
        expect(held.reason).toContain("holder-session");
        expect(held.reason).toContain("/ratking connect");
        yield* fs.writeFileString(`${state}/claims.json`, "{}");
        const directory = yield* Directory;
        yield* directory.record(
          name,
          yield* document(yield* identity(`did:web:${name}.example.invalid`))
        );
        const known = yield* claimName(facts).pipe(Effect.flip);
        expect(known.reason).toContain("directory");

        const reserved = yield* claimName({
          ...facts,
          env: Option.some("reserved-alias"),
        }).pipe(Effect.flip);

        expect(reserved.reason).toContain("reserved");

        const requested = `connected-${name}`;

        const connected = yield* claimName(
          connectedFacts(
            {
              ...facts,
              fork: {
                label: "fork",
                parent: { name: "parent", session: "parent-session" },
              },
              successor: true,
            },
            requested
          )
        );

        expect(connected.name).toBe(requested);
        expect(box.calls).toEqual([]);
      }).pipe(
        Effect.provide(
          harness(state, box.http, [], {
            reserved: {
              "reserved-name": {
                aliases: ["reserved-alias"],
                did: "did:web:reserved.example.invalid",
              },
            },
          })
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
