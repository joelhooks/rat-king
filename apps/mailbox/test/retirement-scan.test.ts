import { it } from "@effect/vitest";
import * as Retired from "@rat-king/lexicon/identity.listRetired";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Transport } from "@rat-king/lexicon/transport";
import { Effect, Option, Schema } from "effect";
import { expect } from "vitest";

import { readRetirements } from "../../../packages/mailbox-client/src/retirements.ts";
import { routeIssuer } from "../src/issuer-runtime.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import { testStoreFor } from "./helpers.ts";

it.effect.prop(
  "paginated retirement inventory reads issuer rows without a single Mailbox lookup",
  { count: Schema.Int.check(Schema.isBetween({ maximum: 210, minimum: 201 })) },
  ({ count }) =>
    Effect.gen(function* scanProof() {
      const operator = "did:web:operator.invalid";
      const storage = yield* testStoreFor("did:web:issuer.invalid");

      storage.sql.exec(
        "CREATE TABLE retired (name TEXT PRIMARY KEY, did TEXT NOT NULL, retired_at INTEGER NOT NULL, successor TEXT NOT NULL, by TEXT NOT NULL)"
      );
      storage.sql.exec(
        "INSERT INTO retired (name,did,retired_at,successor,by) VALUES ('legacy','did:web:legacy.invalid',1,'',?)",
        operator
      );

      const storeLayer = issuerStore(storage.sql);
      const store = yield* IssuerStore.pipe(Effect.provide(storeLayer));

      const names = Array.from(
        { length: count },
        (_, index) => `reader-${String(index).padStart(3, "0")}`
      );

      yield* store.transaction((tx) => {
        for (const name of names) {
          tx.retire({
            by: operator,
            did: `did:web:${name}.invalid`,
            name,
            retiredAt: 1,
          });
        }
      });

      let mailboxLookups = 0;
      let pages = 0;

      const mailboxes = {
        getByName: () => {
          mailboxLookups += 1;
          throw new Error("Bulk inventory must not touch Mailbox");
        },
      };

      const transport = Transport.of({
        request: (request) =>
          Effect.gen(function* requestPath() {
            pages += 1;
            expect(request.nsid).toBe(Retired.Method.nsid);

            const response = yield* routeIssuer({
              caller: operator,
              mailboxes,
              policy: {
                config: Option.none(),
                operators: [operator],
                staticDids: new Set(),
              },
              request,
              store: storeLayer,
            });

            return {
              body: yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.toEncoded(Runtime.Data))
              )(response.body),
              kind: "json" as const,
              status: response.status,
            };
          }).pipe(Effect.orDie),
      });

      expect(yield* readRetirements(transport)).toEqual(["legacy", ...names]);
      expect(mailboxLookups).toBe(0);
      expect(pages).toBe(3);
    }).pipe(Effect.scoped)
);
