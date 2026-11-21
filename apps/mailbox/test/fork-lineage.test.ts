import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as Register from "@rat-king/lexicon/identity.register";
import { Arbitrary, Effect, Layer, Option, Result, Schema } from "effect";
import { expect } from "vitest";

import { Caller } from "../src/caller.ts";
import { issuerStore, IssuerStore } from "../src/issuer-store.ts";
import {
  DocumentRegistry,
  IssuerHandlers,
  issuerHandlers,
  RetirementRegistry,
} from "../src/issuer.ts";
import { testStoreFor } from "./helpers.ts";

const document = (name: string) => ({
  authentication: [`did:web:${name}.example.invalid#atproto`],
  id: `did:web:${name}.example.invalid`,
  keyAgreement: [`did:web:${name}.example.invalid#encryption`],
  verificationMethod: [
    {
      controller: `did:web:${name}.example.invalid`,
      id: `did:web:${name}.example.invalid#atproto`,
      publicKeyJwk: { crv: "P-256", kty: "EC", x: "x", y: "y" },
    },
  ],
});

it.effect.prop(
  "old directory rows list unchanged and new registrations preserve optional display lineage",
  [Arbitrary.schema(Schema.Boolean)],
  ([linked]) =>
    Effect.gen(function* proof() {
      const db = yield* testStoreFor("did:web:issuer.example.invalid");
      const old = document("old");

      db.sql.exec(
        "CREATE TABLE names (name TEXT PRIMARY KEY, did TEXT NOT NULL UNIQUE, host TEXT NOT NULL, fingerprint TEXT NOT NULL, document TEXT NOT NULL)"
      );
      db.sql.exec(
        "INSERT INTO names (name,did,host,fingerprint,document) VALUES (?,?,?,?,?)",
        "old",
        old.id,
        "did:web:host.example.invalid",
        "old-fingerprint",
        JSON.stringify(old)
      );
      const storeLayer = issuerStore(db.sql);
      const store = yield* IssuerStore.pipe(Effect.provide(storeLayer));

      yield* store.transaction((tx) => {
        tx.enroll("did:web:host.example.invalid");
      });
      yield* Effect.gen(function* register() {
        const issuer = yield* IssuerHandlers;

        const input = {
          document: yield* Schema.decodeUnknownEffect(Defs.DidDocument)(
            document("parent.review")
          ),
          name: "parent/review",
        };

        if (linked) {
          Object.assign(input, {
            parent: { name: "parent", session: "original-session" },
          });
        }

        yield* issuer.register(
          yield* Schema.decodeUnknownEffect(Register.Input)(input)
        );
        const page = yield* issuer.listNames({});
        const oldEntry = page.names.find((entry) => entry.name === "old");

        const childEntry = page.names.find(
          (entry) => entry.name === "parent/review"
        );

        const encodedOld = yield* Schema.encodeEffect(Defs.DidDocument)(
          yield* Schema.decodeUnknownEffect(Defs.DidDocument)(old)
        );

        expect(oldEntry).toEqual({
          did: old.id,
          document: encodedOld,
          name: "old",
        });
        expect(childEntry?.parent).toEqual(
          linked ? { name: "parent", session: "original-session" } : undefined
        );

        const invalid = yield* Schema.decodeUnknownEffect(Register.Input)({
          document: document("other"),
          name: "other",
          parent: { name: "parent", session: " " },
        });

        const refused = yield* issuer.register(invalid).pipe(Effect.result);

        expect(Result.isFailure(refused)).toBe(true);
        expect(
          Schema.decodeUnknownOption(Register.Input)({
            document: document("bad"),
            name: "bad",
            parent: { name: "parent//bad", session: "s" },
          })
        ).toEqual(Option.none());
      }).pipe(
        Effect.provide(
          issuerHandlers({
            config: Option.some({
              didTemplate: "did:web:{agent}.example.invalid",
              reserved: [],
            }),
            operators: [],
            staticDids: new Set(),
          }).pipe(
            Layer.provide(storeLayer),
            Layer.provide(
              Layer.succeed(Caller, { did: "did:web:host.example.invalid" })
            ),
            Layer.provide(
              Layer.mock(DocumentRegistry, { put: () => Effect.void })
            ),
            Layer.provide(Layer.mock(RetirementRegistry, {}))
          )
        )
      );
    }).pipe(Effect.scoped)
);
