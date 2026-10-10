/* oxlint-disable eslint/max-classes-per-file, promise/prefer-await-to-callbacks -- Effect service ports share their owning issuer module; Effect boundary transformations are not Promise callbacks. */
import * as Defs from "@rat-king/lexicon/defs";
import * as Enroll from "@rat-king/lexicon/identity.enrollHost";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as Register from "@rat-king/lexicon/identity.register";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Context, Effect, Layer, Option, Result, Schema } from "effect";

import { Caller } from "./caller.ts";
import { failure } from "./failure.ts";
import {
  decideRegistration,
  IssuerConfig,
  publicOnly,
  refusalStatus,
} from "./issuer-policy.ts";
import type {
  Decision,
  IssuerConfigValue,
  PublicDocument,
  Refusal,
} from "./issuer-policy.ts";
import { IssuerStore } from "./issuer-store.ts";
import type { IssuerTransaction } from "./issuer-store.ts";

export const issuerMethods = [Register.Method, Enroll.Method, ListNames.Method];

export class DocumentRegistry extends Context.Service<
  DocumentRegistry,
  {
    readonly put: (
      document: PublicDocument
    ) => Effect.Effect<void, XrpcFailure>;
  }
>()("mailbox/DocumentRegistry") {}

export class IssuerHandlers extends Context.Service<
  IssuerHandlers,
  {
    readonly register: (
      input: Register.InputValue
    ) => Effect.Effect<Register.OutputValue, XrpcFailure>;
    readonly enrollHost: (
      input: Enroll.InputValue
    ) => Effect.Effect<Enroll.OutputValue, XrpcFailure>;
    readonly listNames: (
      params: ListNames.ParamsValue
    ) => Effect.Effect<ListNames.OutputValue, XrpcFailure>;
  }
>()("mailbox/IssuerHandlers") {}

export interface IssuerPolicy {
  readonly operators: readonly string[];
  readonly config: Option.Option<IssuerConfigValue>;
}

export const issuerConfig = (
  didTemplate: string | undefined,
  reserved: string | undefined
) =>
  didTemplate === undefined
    ? Option.none()
    : Schema.decodeUnknownOption(
        Schema.Struct({
          didTemplate: IssuerConfig.fields.didTemplate,
          reserved: Schema.fromJsonString(IssuerConfig.fields.reserved),
        })
      )({ didTemplate, reserved: reserved ?? "[]" });

const exactDocument = Effect.fn("Issuer.exactDocument")(function* exactDocument(
  document: Defs.DidDocumentValue
) {
  const encoded = yield* Schema.encodeEffect(Defs.DidDocument)(document).pipe(
    Effect.mapError(() => failure("InvalidRequest"))
  );

  return yield* Option.match(publicOnly(encoded), {
    onNone: () =>
      Effect.fail(failure("InvalidRequest", 400, "Public keys only")),
    onSome: Effect.succeed,
  });
});

const refused = (outcome: Result.Result<Decision, Refusal>) =>
  Result.match(outcome, {
    onFailure: (refusal) =>
      Effect.fail(failure(refusal, refusalStatus[refusal])),
    onSuccess: Effect.succeed,
  });

const output = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => failure("MailboxUnavailable", 503))
  );

export const issuerHandlers = (policy: IssuerPolicy) =>
  Layer.effect(
    IssuerHandlers,
    Effect.gen(function* makeIssuerHandlers() {
      const store = yield* IssuerStore;
      const registry = yield* DocumentRegistry;
      const caller = yield* Caller;

      return IssuerHandlers.of({
        enrollHost: Effect.fn("Issuer.enrollHost")(function* enrollHost(input) {
          if (!policy.operators.includes(caller.did)) {
            return yield* Effect.fail(failure("Forbidden", 403));
          }

          const document = yield* exactDocument(input.document);

          if (!document.id.startsWith("did:web:")) {
            return yield* Effect.fail(failure("InvalidRequest"));
          }

          yield* registry.put(document);
          yield* store.transaction((tx) => {
            tx.enroll(document.id);
          });

          return yield* output(Enroll.Output, { did: document.id });
        }),
        listNames: Effect.fn("Issuer.listNames")(function* listNames(params) {
          const limit = params.limit ?? ListNames.Method.defaults.limit;

          const rows = yield* store.transaction((tx) =>
            tx.names(params.cursor ?? "", limit + 1)
          );

          const names = rows
            .slice(0, limit)
            .map(({ did, document, name }) => ({ did, document, name }));

          const last = names.at(-1);

          return yield* output(
            ListNames.Output,
            rows.length > limit && last !== undefined
              ? { cursor: last.name, names }
              : { names }
          );
        }),
        register: Effect.fn("Issuer.register")(function* register(input) {
          const config = yield* Option.match(policy.config, {
            onNone: () =>
              Effect.fail(
                failure("MailboxUnavailable", 503, "Issuer is not configured")
              ),
            onSome: Effect.succeed,
          });

          const document = yield* exactDocument(input.document);

          const decide = (tx: IssuerTransaction) =>
            decideRegistration(
              config,
              {
                document,
                enrolled: tx.enrolled(caller.did),
                host: caller.did,
                name: input.name,
              },
              tx.binding(input.name)
            );

          const first = yield* refused(yield* store.transaction(decide));

          if (first.kind === "bind") {
            yield* registry.put(document);

            yield* refused(
              yield* store.transaction((tx) => {
                const settled = decide(tx);

                if (
                  Result.isSuccess(settled) &&
                  settled.success.kind === "bind"
                ) {
                  tx.bind(input.name, settled.success.binding, document);
                }

                return settled;
              })
            );
          }

          return yield* output(Register.Output, { did: first.did });
        }),
      });
    })
  );

const respond = <S extends Schema.Codec<unknown, Schema.Json>>(
  schema: S,
  handled: Effect.Effect<S["Type"], XrpcFailure | Schema.SchemaError>
) =>
  handled.pipe(
    Effect.flatMap(Schema.encodeEffect(schema)),
    Effect.map((body) => ({ body: JSON.stringify(body), status: 200 })),
    Effect.catchTag("SchemaError", () =>
      Effect.succeed({
        body: JSON.stringify({ error: "InvalidRequest" }),
        status: 400,
      })
    ),
    Effect.catchTag("XrpcFailure", (error) =>
      Effect.succeed({
        body: JSON.stringify({ error: error.error, message: error.message }),
        status: error.status,
      })
    )
  );

export const issuerRoute = Effect.fn("Issuer.route")(function* issuerRoute(
  request: XrpcRequest
) {
  const handlers = yield* IssuerHandlers;

  switch (request.nsid) {
    case Register.Method.nsid: {
      return yield* respond(
        Register.Output,
        Schema.decodeUnknownEffect(Register.Input)(request.input).pipe(
          Effect.flatMap(handlers.register)
        )
      );
    }

    case Enroll.Method.nsid: {
      return yield* respond(
        Enroll.Output,
        Schema.decodeUnknownEffect(Enroll.Input)(request.input).pipe(
          Effect.flatMap(handlers.enrollHost)
        )
      );
    }

    case ListNames.Method.nsid: {
      return yield* respond(
        ListNames.Output,
        Schema.decodeUnknownEffect(ListNames.Params)(request.params ?? {}).pipe(
          Effect.flatMap(handlers.listNames)
        )
      );
    }

    default: {
      return {
        body: JSON.stringify({ error: "InvalidRequest" }),
        status: 404,
      };
    }
  }
});
