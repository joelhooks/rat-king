import { Effect, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ListNames from "../../packages/lexicon/src/identity.listNames.ts";
import { Transport } from "../../packages/lexicon/src/transport.ts";
import {
  Document,
  transportLayer,
} from "../../packages/mailbox-client/src/index.ts";
import type { IdentityValue } from "../../packages/mailbox-client/src/index.ts";
import type { Resolved } from "../../packages/ratking-client/src/directory.ts";
import { FleetError } from "./stage-config.ts";

const pageSize = 20;

const pageBudget = 4;

const unavailable = () =>
  new FleetError({ reason: "Maintenance recipient lookup unavailable" });

export const findMaintenanceRecipient = Effect.fn("Maintenance.lookup")(
  function* findMaintenanceRecipient(
    name: string
  ): Effect.fn.Return<Resolved | null, FleetError, Transport> {
    const transport = yield* Transport;
    let cursor: string | undefined;

    for (let page = 0; page < pageBudget; page += 1) {
      const query = { all: true, limit: pageSize, match: name };

      const response = yield* transport
        .request({
          input: undefined,
          method: "GET",
          nsid: ListNames.Method.nsid,
          params: cursor === undefined ? query : { ...query, cursor },
        })
        .pipe(Effect.mapError(unavailable));

      if (response.status !== 200 || response.kind !== "json") {
        return yield* unavailable();
      }

      const body = yield* Schema.decodeUnknownEffect(ListNames.Output)(
        response.body
      ).pipe(Effect.mapError(unavailable));

      const matches = body.names.filter((row) => row.name === name);
      const [match] = matches;

      if (
        body.names.length > pageSize ||
        matches.length > 1 ||
        (body.cursor !== undefined && body.cursor <= (cursor ?? ""))
      ) {
        return yield* unavailable();
      }

      if (match !== undefined) {
        const document = yield* Schema.decodeUnknownEffect(Document)(
          match.document
        ).pipe(Effect.mapError(unavailable));

        if (document.id !== match.did) {
          return yield* unavailable();
        }

        return match.status === "retired"
          ? null
          : { did: match.did, document, name };
      }

      if (body.cursor === undefined) {
        return null;
      }

      ({ cursor } = body);
    }

    return yield* unavailable();
  },
  (effect) =>
    effect.pipe(Effect.timeout("4 seconds"), Effect.mapError(unavailable))
);

const boundedResponse = Effect.fn("Maintenance.directoryResponse")(
  function* boundedResponse(response: HttpClientResponse.HttpClientResponse) {
    const failure = () =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.DecodeError({
          description: "Maintenance directory response refused",
          request: response.request,
          response,
        }),
      });

    if (response.status !== 200) {
      return yield* failure();
    }

    let size = 0;
    let text = "";
    const decoder = new TextDecoder();

    yield* Stream.runForEach(response.stream, (chunk) =>
      Effect.suspend(() => {
        size += chunk.byteLength;

        if (size > 256 * 1024) {
          return Effect.fail(failure());
        }

        text += decoder.decode(chunk, { stream: true });

        return Effect.void;
      })
    );

    return HttpClientResponse.fromWeb(
      response.request,
      new Response(text + decoder.decode())
    );
  }
);

export const maintenanceRecipient = (
  endpoint: string,
  serviceDid: string,
  identity: IdentityValue,
  name: string
) =>
  findMaintenanceRecipient(name).pipe(
    Effect.provide(
      transportLayer(
        endpoint,
        `${serviceDid.replace(/#mailbox$/u, "")}#mailbox`,
        identity
      )
    ),
    Effect.provideServiceEffect(
      HttpClient.HttpClient,
      HttpClient.HttpClient.use((http) =>
        Effect.succeed(
          HttpClient.transformResponse(http, Effect.flatMap(boundedResponse))
        )
      )
    )
  );
