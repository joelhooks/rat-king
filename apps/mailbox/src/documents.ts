/* oxlint-disable promise/prefer-await-to-callbacks, typescript/promise-function-async -- Lazy DO RPC adapters. */
import { Effect, Schema } from "effect";

import { Document, Documents, documentResolver } from "./auth.ts";
import type { Bindings } from "./bindings.ts";
import { failure } from "./failure.ts";

export const configuredDocuments = (env: Bindings) =>
  Schema.decodeUnknownSync(Documents)(JSON.parse(env.DID_DOCUMENTS));

export const documentsLayer = (env: Bindings) => {
  const documents = configuredDocuments(env);

  return documentResolver(
    Effect.fn("DidResolver.lookup")(function* lookup(did) {
      if (!did.startsWith("did:web:")) {
        return yield* Effect.fail(failure("Forbidden", 403));
      }

      const configured = documents.find((candidate) => candidate.id === did);

      if (configured !== undefined) {
        return configured;
      }

      const registered = yield* Effect.tryPromise({
        catch: () => failure("MailboxUnavailable", 503),
        try: () => env.MAILBOX.getByName(did).registeredDocument(),
      });

      return registered === undefined
        ? undefined
        : yield* Schema.decodeEffect(Schema.fromJsonString(Document))(
            registered
          ).pipe(Effect.mapError(() => failure("AuthRequired", 401)));
    })
  );
};

export const didAllowlist = (value: string | undefined) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)))(
    value ?? "[]"
  );
