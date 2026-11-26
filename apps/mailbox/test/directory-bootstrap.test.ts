/* oxlint-disable typescript/promise-function-async -- The fake DO adapters return the Effect runtime Promise directly. */
import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import { Effect, Layer, Result, Schema } from "effect";
import { expect } from "vitest";

import { importSigning } from "../../../packages/mailbox-client/src/identity.ts";
import { ReplayAuthority } from "../../../packages/mailbox-client/src/replay.ts";
import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { authenticate, serviceToken } from "../src/auth.ts";
import { directoryDocuments, documentsLayer } from "../src/documents.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import { directoryMode } from "../src/list-names.ts";
import { testStoreFor } from "./helpers.ts";

it.effect.prop(
  "signed directory calls match legacy auth in bootstrap and cannot use a Mailbox signer after cutover, even with omitted views and a reopened Issuer",
  {
    enabled: Schema.Literals(["names", "retired", "snapshot"]),
    method: Schema.Literals([ListNames.Method.nsid, ListRetired.Method.nsid]),
  },
  ({ enabled, method }) =>
    Effect.gen(function* signerCoverage() {
      const db = yield* testStoreFor("did:web:issuer.example.invalid");
      const signer = yield* identity("did:web:legacy.example.invalid");
      const pub = yield* document(signer);
      const key = yield* importSigning(signer);
      let store = issuerStore(db.sql);
      let cellReads = 0;
      let issuerReads = 0;
      let cached = false;
      const context = yield* Effect.context();
      // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- The real directory layer uses Promise DO RPC.
      const run = Effect.runPromiseWith(context);

      const configured = {
        DID_DOCUMENTS: "[]",
        ISSUER: {
          getByName: () => ({
            directoryBootstrap: (flags?: string) =>
              run(
                IssuerStore.use((index) =>
                  index.transaction((tx) =>
                    tx.directoryBootstrap(directoryMode(flags))
                  )
                ).pipe(Effect.provide(store))
              ),
            directoryDocument: () => {
              issuerReads += 1;

              return Promise.resolve(cached ? JSON.stringify(pub) : undefined);
            },
          }),
        },
        MAILBOX: {
          getByName: (did: string) => {
            expect(did).toBe(signer.did);
            cellReads += 1;

            return {
              registeredDocument: () => Promise.resolve(JSON.stringify(pub)),
            };
          },
        },
      };

      const aud = "did:web:mailbox.example.invalid#mailbox";

      const claims = {
        aud,
        exp: 1060,
        iat: 1000,
        iss: signer.did,
        jti: "bootstrap-directory-signer",
        lxm: method,
      };

      const authorization = `Bearer ${yield* serviceToken(claims, key)}`;

      const replay = Layer.succeed(ReplayAuthority, {
        consume: () => Effect.void,
      });

      const signed = (documents: ReturnType<typeof documentsLayer>) =>
        authenticate({
          audience: aud,
          authorization,
          now: 1_000_000,
          nsid: method,
        }).pipe(Effect.provide(Layer.merge(documents, replay)));

      const check = (flags?: string) =>
        directoryDocuments(
          flags === undefined
            ? configured
            : { ...configured, NAME_STATE_VIEWS: flags }
        ).pipe(Effect.flatMap(signed), Effect.result);

      expect(yield* check()).toEqual(
        Result.succeed(yield* signed(documentsLayer(configured)))
      );
      expect(cellReads).toBe(2);
      expect(issuerReads).toBe(0);

      expect(yield* check("degraded").pipe(Effect.map(Result.isFailure))).toBe(
        true
      );
      expect(yield* check(enabled).pipe(Effect.map(Result.isFailure))).toBe(
        true
      );
      store = issuerStore(db.sql);
      expect(yield* check().pipe(Effect.map(Result.isFailure))).toBe(true);
      expect(cellReads).toBe(2);
      expect(issuerReads).toBe(3);
      cached = true;
      expect(yield* check()).toEqual(Result.succeed(signer.did));
      expect(cellReads).toBe(2);
      expect(issuerReads).toBe(4);
    }).pipe(Effect.scoped)
);
