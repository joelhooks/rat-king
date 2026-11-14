import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import * as RecordRetired from "@rat-king/lexicon/identity.recordRetired";
import * as ResolveRecipient from "@rat-king/lexicon/identity.resolveRecipient";
import * as Unretire from "@rat-king/lexicon/identity.unretireName";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { Arbitrary, Clock, Effect, Layer, Option, Schema } from "effect";
import { expect } from "vitest";

import { Caller } from "../src/caller.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
  RetirementRegistry,
} from "../src/issuer.ts";
import { isoTime } from "../src/retirement.ts";
import { MailboxStore } from "../src/store.ts";
import { storeRetirements, testStoreFor } from "./helpers.ts";
import { runModel } from "./record-retired-model.ts";

const operator = "did:web:operator.example.invalid";

const names = ["alpha", "beta", "gamma"];

const didFor = (name: string) => `did:web:${name}.example.invalid`;

const post = (nsid: string, input: XrpcRequest["input"]): XrpcRequest => ({
  input,
  method: "POST",
  nsid,
  params: undefined,
});

const setup = (allowCurrent = false) =>
  Effect.gen(function* makeFixture() {
    const database = yield* testStoreFor("did:web:issuer.example.invalid");

    const store = yield* IssuerStore.pipe(
      Effect.provide(issuerStore(database.sql))
    );

    const mailboxDatabase = yield* testStoreFor(didFor("alpha"));

    const mailbox = yield* MailboxStore.pipe(
      Effect.provide(mailboxDatabase.layer)
    );

    yield* mailbox.transaction((tx) => {
      tx.setRetirement({ by: operator, name: "alpha", retiredAt: 1 });
    });
    yield* store.transaction((tx) => {
      for (const name of names) {
        const did = didFor(name);
        tx.bind(
          name,
          { did, fingerprint: name, host: operator },
          {
            authentication: [],
            id: did,
            keyAgreement: [],
            verificationMethod: [],
          }
        );
      }
    });

    const registry = yield* RetirementRegistry.pipe(
      Effect.provide(storeRetirements(() => Effect.succeed(mailbox)))
    );

    let clears = 0;
    let reads = 0;

    const route = (request: XrpcRequest, caller = operator) =>
      issuerRoute(request).pipe(
        Effect.provide(
          issuerHandlers({ config: Option.none(), operators: [operator] }).pipe(
            Layer.provide(Layer.succeed(IssuerStore, store)),
            Layer.provide(Layer.succeed(Caller, { did: caller })),
            Layer.provide(
              Layer.succeed(DocumentRegistry, {
                put: () => Effect.die("Mailbox document call"),
              })
            ),
            Layer.provide(
              Layer.succeed(RetirementRegistry, {
                clear: (did) => {
                  clears += 1;

                  return registry.clear(did);
                },
                current: (did) => {
                  reads += 1;

                  return allowCurrent
                    ? registry.current(did)
                    : Effect.die("Mailbox current call");
                },
                presence: () => Effect.die("Mailbox presence call"),
                repoint: () => Effect.die("Mailbox repoint call"),
                retire: () => Effect.die("Mailbox retire call"),
              })
            )
          )
        )
      );

    return {
      clearCount: () => clears,
      mailbox,
      readCount: () => reads,
      route,
      store,
    };
  });

type Real = Effect.Success<ReturnType<typeof setup>>;

interface Model {
  readonly retired: Set<string>;
}

class Change {
  readonly name: string;
  readonly record: boolean;

  constructor(name: string, record: boolean) {
    this.name = name;
    this.record = record;
  }

  check() {
    return this.name.length > 0;
  }

  run(model: Model, real: Real) {
    return Effect.gen({ self: this }, function* run() {
      if (this.record) {
        const clears = real.clearCount();
        const calledAt = yield* Clock.currentTimeMillis;

        const previous = yield* real.store.transaction((tx) =>
          tx.retiredEntry(this.name)
        );

        const response = yield* real.route(
          post(RecordRetired.Method.nsid, { names: [this.name, this.name] })
        );

        expect(response.status).toBe(200);
        expect(real.clearCount()).toBe(clears);

        const result = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(RecordRetired.Output)
        )(response.body);

        const known = names.includes(this.name);
        expect(result.results.map((row) => row.outcome)).toEqual(
          known
            ? [model.retired.has(this.name) ? "already" : "recorded", "already"]
            : ["unknown", "unknown"]
        );

        if (known) {
          model.retired.add(this.name);

          const row = yield* real.store.transaction((tx) =>
            tx.retiredEntry(this.name)
          );

          if (previous === undefined) {
            expect(row).toMatchObject({
              by: operator,
              did: didFor(this.name),
              name: this.name,
            });
            expect(row?.successor).toBeUndefined();
            expect(row?.retiredAt).toBeGreaterThanOrEqual(calledAt);
            expect(row?.retiredAt).toBeLessThanOrEqual(
              yield* Clock.currentTimeMillis
            );
          } else {
            expect(row).toEqual(previous);
          }
        }
      } else if (names.includes(this.name)) {
        const response = yield* real.route(
          post(Unretire.Method.nsid, { name: this.name })
        );

        expect(response.status).toBe(200);
        model.retired.delete(this.name);
        expect(
          yield* real.mailbox.transaction((tx) => tx.retirement())
        ).toBeUndefined();
      }

      const response = yield* real.route({
        input: undefined,
        method: "GET",
        nsid: ListNames.Method.nsid,
        params: { status: "retired" },
      });

      expect(response.status).toBe(200);

      const page = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ListNames.Output)
      )(response.body);

      expect(page.names.map((row) => row.name)).toEqual(
        [...model.retired].toSorted()
      );
      expect(page.names.every((row) => row.status === "retired")).toBe(true);
    });
  }
  toString() {
    return `${this.record ? "record" : "unretire"}(${this.name})`;
  }
}

it.effect.prop(
  "mailbox validation preserves backfill timestamps, displays mailbox values and removes only cleared retirements",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
  ],
  ([retiredAt]) =>
    Effect.gen(function* proof() {
      const real = yield* setup(true);
      yield* real.mailbox.transaction((tx) => {
        tx.setRetirement({
          by: operator,
          name: "alpha",
          retiredAt,
          successor: "beta",
        });
      });
      yield* real.route(post(RecordRetired.Method.nsid, { names: ["alpha"] }));

      const indexed = yield* real.store.transaction((tx) =>
        tx.retiredEntry("alpha")
      );

      const list = {
        input: undefined,
        method: "GET",
        nsid: ListRetired.Method.nsid,
        params: {},
      } as const;

      const listed = yield* real.route(list);
      expect(listed.status).toBe(200);

      const decoded = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ListRetired.Output)
      )(listed.body);

      expect(decoded.retired[0]?.successor).toBe("beta");
      const encoded = yield* Schema.encodeEffect(ListRetired.Output)(decoded);
      expect(encoded.retired[0]?.retiredAt).toBe(isoTime(retiredAt));
      expect(real.readCount()).toBe(1);
      expect(
        yield* real.store.transaction((tx) => tx.retiredEntry("alpha"))
      ).toEqual(indexed);

      const resolved = yield* real.route({
        input: undefined,
        method: "GET",
        nsid: ResolveRecipient.Method.nsid,
        params: { name: "alpha" },
      });

      expect(resolved.status).toBe(200);

      const route = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(ResolveRecipient.Output)
      )(resolved.body);

      expect(route.name).toBe("beta");
      expect(route.chain).toEqual(["alpha", "beta"]);
      expect(real.readCount()).toBe(2);
      expect(
        yield* real.store.transaction((tx) => tx.retiredEntry("alpha"))
      ).toEqual(indexed);
      yield* real.mailbox.transaction((tx) => {
        tx.setRetirement(undefined);
      });
      yield* real.route(list);
      expect(real.readCount()).toBe(3);
      expect(
        yield* real.store.transaction((tx) => tx.retiredEntry("alpha"))
      ).toBeUndefined();
    }).pipe(Effect.scoped)
);

const ChangeSchema = Schema.Struct({
  name: Schema.Literals([...names, "unknown"]),
  record: Schema.Boolean,
});

it.effect.prop(
  "issuer-only retirement is idempotent, makes no mailbox reads or writes, and unretire clears both stores",
  [Arbitrary.schema(Schema.Array(ChangeSchema).check(Schema.isMaxLength(25)))],
  ([commands]) =>
    Effect.gen(function* proof() {
      const real = yield* setup();
      yield* real.store.transaction((tx) => {
        tx.retire({
          by: didFor("beta"),
          did: didFor("gamma"),
          name: "gamma",
          retiredAt: 1,
          successor: "beta",
        });
      });
      yield* runModel(
        () => ({ model: { retired: new Set<string>(["gamma"]) }, real }),
        [
          new Change("gamma", true),
          new Change("alpha", true),
          new Change("alpha", false),
          ...commands.map(({ name, record }) => new Change(name, record)),
        ]
      );
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "only operators may record and invalid batch sizes are refused before writing",
  [Arbitrary.schema(Schema.Boolean)],
  ([oversized]) =>
    Effect.gen(function* proof() {
      const real = yield* setup();

      const forbidden = yield* real.route(
        post(RecordRetired.Method.nsid, { names: ["alpha"] }),
        didFor("alpha")
      );

      expect(forbidden.status).toBe(403);

      const invalid = yield* real.route(
        post(RecordRetired.Method.nsid, {
          names: oversized ? Array.from({ length: 101 }, () => "alpha") : [],
        })
      );

      expect(invalid.status).toBe(400);
      expect(
        yield* real.store.transaction((tx) => tx.retired("", 100))
      ).toEqual([]);
    }).pipe(Effect.scoped)
);
