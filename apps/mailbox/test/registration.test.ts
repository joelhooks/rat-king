import { it } from "@effect/vitest";
import * as Put from "@rat-king/lexicon/admin.putDidDocument";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import { Arbitrary, Effect, Layer, Result, Schema } from "effect";
import { expect } from "vitest";

import { sealed, senderDid } from "../../../packages/envelope/test/helpers.ts";
import { staticResolver } from "../src/auth.ts";
import { Caller, mailboxHandlers } from "../src/mailbox.ts";
import { MailboxStore } from "../src/store.ts";
import { documents, testStoreFor, unleasedSender } from "./helpers.ts";

const DocumentSeed = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(1_000_000)
);

it.effect.prop(
  "registration is create-only, static documents win, and non-operators are forbidden",
  [Arbitrary.schema(DocumentSeed)],
  ([seed]) =>
    Effect.gen(function* registration() {
      const sample = yield* sealed();

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const did = `did:web:registered-${seed}.example.invalid`;

      const document = yield* Schema.decodeUnknownEffect(Defs.DidDocument)({
        ...docs[0],
        authentication: [`${did}#atproto`],
        id: did,
        keyAgreement: [],
        verificationMethod: [
          {
            ...docs[0]?.verificationMethod[0],
            controller: did,
            id: `${did}#atproto`,
          },
        ],
      });

      const different = { ...document, authentication: [] };
      const input = yield* Schema.decodeUnknownEffect(Put.Input)({ document });
      const storage = yield* testStoreFor(did);

      const make = (
        issuer: string,
        staticDocuments: readonly Defs.DidDocumentValue[]
      ) =>
        MailboxHandlers.pipe(
          Effect.provide(
            mailboxHandlers({
              operators: [senderDid],
              resolvers: [],
              staticDocuments,
            }).pipe(
              Layer.provide(storage.layer),
              Layer.provide(unleasedSender),
              Layer.provide(staticResolver(docs)),
              Layer.provide(Layer.succeed(Caller, { did: issuer }))
            )
          )
        );

      const operator = yield* make(senderDid, []);
      const outsider = yield* make(did, []);
      const denied = yield* outsider.putDidDocument(input).pipe(Effect.result);
      expect(Result.isFailure(denied) && denied.failure.error).toBe(
        "Forbidden"
      );

      const privateKey = yield* operator
        .putDidDocument({
          document: {
            ...document,
            verificationMethod: document.verificationMethod.map((method) => ({
              ...method,
              publicKeyJwk: {
                ...method.publicKeyJwk,
                d: "private-material-is-refused",
              },
            })),
          },
        })
        .pipe(Effect.result);

      expect(Result.isFailure(privateKey) && privateKey.failure.error).toBe(
        "InvalidRequest"
      );
      expect(yield* operator.putDidDocument(input)).toEqual({ did });
      expect(yield* operator.putDidDocument(input)).toEqual({ did });

      const conflict = yield* operator
        .putDidDocument({ document: different })
        .pipe(Effect.result);

      expect(Result.isFailure(conflict) && conflict.failure.error).toBe(
        "DocumentConflict"
      );
      const staticOperator = yield* make(senderDid, [different]);

      const shadow = yield* staticOperator
        .putDidDocument(input)
        .pipe(Effect.result);

      expect(Result.isFailure(shadow) && shadow.failure.error).toBe(
        "DocumentConflict"
      );
      expect(
        yield* staticOperator.putDidDocument({ document: different })
      ).toEqual({ did });
      const store = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      expect(yield* store.transaction((tx) => tx.document())).toEqual(document);
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 30 }, timeout: 30_000 }
);
