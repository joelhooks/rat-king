import * as Enroll from "@rat-king/lexicon/identity.enrollHost";
import { Transport } from "@rat-king/lexicon/transport";
import { Identity, transportLayer } from "@rat-king/mailbox-client";
import { Effect, Option, Schema } from "effect";

import { CliError } from "./identity.ts";
import { publicRegistrationDocument } from "./register-document.ts";
import { SecretStore } from "./secrets.ts";

const ErrorBody = Schema.Struct({ error: Schema.String });

export const enrollHost = Effect.fn("MailboxCli.enrollHost")(
  function* enrollHost(input: {
    readonly did: string;
    readonly json: string;
    readonly operatorSecret: string;
    readonly endpoint: string;
    readonly serviceDid: string;
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

    const body = yield* Schema.encodeEffect(Enroll.Input)({ document }).pipe(
      Effect.mapError(() => new CliError({ reason: "Invalid public document" }))
    );

    const response = yield* Transport.use((transport) =>
      transport.request({
        input: body,
        method: "POST",
        nsid: Enroll.Method.nsid,
        params: undefined,
      })
    ).pipe(
      Effect.provide(
        transportLayer(input.endpoint, `${input.serviceDid}#mailbox`, operator)
      ),
      Effect.mapError(() => new CliError({ reason: "Issuer is unreachable" }))
    );

    if (response.status !== 200) {
      return yield* new CliError({
        reason: `Issuer refused enrollment (${Option.match(
          Schema.decodeUnknownOption(ErrorBody)(response.body),
          {
            onNone: () => `HTTP ${response.status}`,
            onSome: (refusal) => refusal.error,
          }
        )})`,
      });
    }

    return yield* Schema.decodeUnknownEffect(Enroll.Output)(response.body).pipe(
      Effect.flatMap(Schema.encodeEffect(Enroll.Output)),
      Effect.mapError(
        () => new CliError({ reason: "Issuer answered with an invalid body" })
      )
    );
  }
);
