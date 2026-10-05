import * as Defs from "@rat-king/lexicon/defs";
import { Identity, RatKingMailbox, layer } from "@rat-king/mailbox-client";
import type { ClientConfig } from "@rat-king/mailbox-client";
import { Effect, Schema } from "effect";

import { CliError } from "./identity.ts";
import { generateKey, publicDocument } from "./provision.ts";
import { SecretStore } from "./secrets.ts";

export const provisionAgent = Effect.fn("MailboxCli.provisionAgent")(
  function* provisionAgent(input: {
    readonly agent: string;
    readonly did: string;
    readonly secret?: string;
    readonly operatorSecret: string;
    readonly endpoint: string;
    readonly serviceDid: string;
    readonly documents: ClientConfig["documents"];
  }) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/u.test(input.agent)) {
      return yield* new CliError({ reason: "Invalid agent name" });
    }

    const secret = input.secret ?? `rat_king_agent_${input.agent}_identity`;

    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u.test(secret)) {
      return yield* new CliError({ reason: "Invalid secret name" });
    }

    const store = yield* SecretStore;

    const operator = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Identity)
    )(yield* store.lease(input.operatorSecret)).pipe(
      Effect.mapError(
        () => new CliError({ reason: "Invalid operator identity secret" })
      )
    );

    const exists = yield* store.exists(secret);

    const identity = exists
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))(
          yield* store.lease(secret)
        ).pipe(
          Effect.mapError(
            () => new CliError({ reason: "Invalid agent identity secret" })
          )
        )
      : yield* Schema.decodeUnknownEffect(Identity)({
          agreement: yield* generateKey("ECDH"),
          did: input.did,
          signing: yield* generateKey("ECDSA"),
        }).pipe(
          Effect.mapError(
            () =>
              new CliError({
                reason: "Invalid agent DID or generated identity",
              })
          )
        );

    if (identity.did !== input.did) {
      return yield* new CliError({
        reason: "Existing secret has a different DID; never replacing keys",
      });
    }

    if (!exists) {
      yield* store.add(secret, JSON.stringify(identity));
    }

    const document = publicDocument(identity);

    const registration = Effect.gen(function* register() {
      const client = yield* RatKingMailbox;

      return yield* client.putDidDocument(
        yield* Schema.decodeUnknownEffect(Schema.toType(Defs.DidDocument))(
          document
        )
      );
    });

    yield* registration.pipe(
      Effect.provide(
        layer({
          documents: input.documents,
          endpoint: input.endpoint,
          identity: operator,
          serviceDid: input.serviceDid,
        })
      )
    );

    return { did: identity.did, document, secret };
  }
);
