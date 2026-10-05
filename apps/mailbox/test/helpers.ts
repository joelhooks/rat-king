/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Effect adapters require lazy Promise thunks, not callback-style control flow. */
// @effect-diagnostics nodeBuiltinImport:off -- Node SQLite is the test adapter for the Durable Object SQL port.
import { DatabaseSync } from "node:sqlite";

import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { Effect, Schema } from "effect";

import {
  recipientDid,
  senderDid,
} from "../../../packages/envelope/test/helpers.ts";
import { Documents } from "../src/auth.ts";
import { sqliteStore } from "../src/sqlite.ts";
import type { Sql } from "../src/sqlite.ts";

export const documents = Effect.fn("Test.documents")(function* documents(
  sender: CryptoKey,
  recipient: CryptoKey
) {
  const signingJwk = yield* cryptoOperation(() =>
    crypto.subtle.exportKey("jwk", sender)
  );

  const recipientJwk = yield* cryptoOperation(() =>
    crypto.subtle.exportKey("jwk", recipient)
  );

  return yield* Schema.decodeUnknownEffect(Documents)([
    {
      authentication: [`${senderDid}#atproto`],
      id: senderDid,
      keyAgreement: [],
      verificationMethod: [
        {
          controller: senderDid,
          id: `${senderDid}#atproto`,
          publicKeyJwk: signingJwk,
        },
      ],
    },
    {
      authentication: [`${recipientDid}#atproto`],
      id: recipientDid,
      keyAgreement: [`${recipientDid}#encryption`],
      verificationMethod: [
        {
          controller: recipientDid,
          id: `${recipientDid}#atproto`,
          publicKeyJwk: signingJwk,
        },
        {
          controller: recipientDid,
          id: `${recipientDid}#encryption`,
          publicKeyJwk: recipientJwk,
        },
      ],
    },
  ]);
});

export const testStore = Effect.acquireRelease(
  Effect.sync(() => new DatabaseSync(":memory:")),
  (database) =>
    Effect.sync(() => {
      database.close();
    })
).pipe(
  Effect.map((database) => {
    const sql: Sql = {
      exec: (query, ...values) => database.prepare(query).all(...values),
      transaction: (operation) => {
        database.exec("BEGIN");

        try {
          const result = operation();
          database.exec("COMMIT");

          return result;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    };

    return { layer: sqliteStore(sql, recipientDid), sql };
  })
);
