import * as Defs from "@rat-king/lexicon/defs";
import { Identity, RatKingMailbox, layer } from "@rat-king/mailbox-client";
import type { ClientConfig } from "@rat-king/mailbox-client";
import { Effect, Predicate, Schema } from "effect";

import { CliError } from "./identity.ts";
import { SecretStore } from "./secrets.ts";

const containsPrivateMaterial = (value: Schema.MutableJson): boolean => {
  if (Predicate.isString(value)) {
    return /-----BEGIN .*PRIVATE KEY-----/u.test(value);
  }

  if (Array.isArray(value)) {
    return value.some(containsPrivateMaterial);
  }

  if (
    Predicate.isNull(value) ||
    Predicate.isNumber(value) ||
    Predicate.isBoolean(value)
  ) {
    return false;
  }

  return Object.entries(value).some(
    ([key, child]) =>
      /^(?:d|p|q|dp|dq|qi|oth|k|seed|secret|private.?key|private.?scalar)$/iu.test(
        key
      ) || containsPrivateMaterial(child)
  );
};

export const publicRegistrationDocument = Effect.fn(
  "MailboxCli.publicRegistrationDocument"
)(function* publicRegistrationDocument(did: string, json: string) {
  const raw = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.MutableJson)
  )(json).pipe(
    Effect.mapError(() => new CliError({ reason: "Invalid document JSON" }))
  );

  if (containsPrivateMaterial(raw)) {
    return yield* new CliError({ reason: "Refusing private key material" });
  }

  const document = yield* Schema.decodeUnknownEffect(
    Schema.toType(Defs.DidDocument)
  )(raw).pipe(
    Effect.mapError(
      () => new CliError({ reason: "Invalid public DID document" })
    )
  );

  if (!did.startsWith("did:web:") || document.id !== did) {
    return yield* new CliError({ reason: "Document DID does not match --did" });
  }

  return document;
});

export const registerDocument = Effect.fn("MailboxCli.registerDocument")(
  function* registerDocument(input: {
    readonly did: string;
    readonly json: string;
    readonly operatorSecret: string;
    readonly endpoint: string;
    readonly serviceDid: string;
    readonly documents: ClientConfig["documents"];
  }) {
    const document = yield* publicRegistrationDocument(input.did, input.json);
    const store = yield* SecretStore;

    const operator = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Identity)
    )(yield* store.lease(input.operatorSecret)).pipe(
      Effect.mapError(
        () => new CliError({ reason: "Invalid operator identity secret" })
      )
    );

    return yield* RatKingMailbox.use((client) =>
      client.putDidDocument(document)
    ).pipe(
      Effect.provide(
        layer({
          documents: input.documents,
          endpoint: input.endpoint,
          identity: operator,
          serviceDid: input.serviceDid,
        })
      )
    );
  }
);
