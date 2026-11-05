/* oxlint-disable eslint/max-classes-per-file, promise/prefer-await-to-callbacks -- Effect service ports share their owning issuer module; Effect boundary transformations are not Promise callbacks. */
import * as Defs from "@rat-king/lexicon/defs";
import * as Enroll from "@rat-king/lexicon/identity.enrollHost";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import * as Register from "@rat-king/lexicon/identity.register";
import * as Retire from "@rat-king/lexicon/identity.retireName";
import * as Unretire from "@rat-king/lexicon/identity.unretireName";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Context, Effect, Layer, Option, Result, Schema } from "effect";

import { Caller } from "./caller.ts";
import { failure } from "./failure.ts";
import {
  AgentName,
  decideRegistration,
  IssuerConfig,
  nameDid,
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
import type { IssuerTransaction, RetiredName } from "./issuer-store.ts";
import { isoTime } from "./retirement.ts";
import type { RetirementValue } from "./store.ts";

export const issuerMethods = [
  Register.Method,
  Enroll.Method,
  ListNames.Method,
  Retire.Method,
  Unretire.Method,
  ListRetired.Method,
];

export class RetirementRegistry extends Context.Service<
  RetirementRegistry,
  {
    readonly retire: (
      did: string,
      retirement: RetirementValue
    ) => Effect.Effect<void, XrpcFailure>;
    readonly clear: (did: string) => Effect.Effect<boolean, XrpcFailure>;
    readonly current: (
      did: string
    ) => Effect.Effect<RetirementValue | undefined, XrpcFailure>;
    readonly presence: (did: string) => Effect.Effect<
      {
        readonly exists: boolean;
        readonly retirement?: RetirementValue;
      },
      XrpcFailure
    >;
  }
>()("mailbox/RetirementRegistry") {}

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
    readonly retireName: (
      input: Retire.InputValue
    ) => Effect.Effect<Retire.OutputValue, XrpcFailure>;
    readonly unretireName: (
      input: Unretire.InputValue
    ) => Effect.Effect<Unretire.OutputValue, XrpcFailure>;
    readonly listRetired: (
      params: ListRetired.ParamsValue
    ) => Effect.Effect<ListRetired.OutputValue, XrpcFailure>;
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

const isName = Schema.is(AgentName);

const retiredOutput = (retired: RetiredName) => {
  const encoded = {
    by: retired.by,
    did: retired.did,
    name: retired.name,
    retiredAt: isoTime(retired.retiredAt),
  };

  if (retired.successor !== undefined) {
    Object.assign(encoded, { successor: retired.successor });
  }

  return encoded;
};

export const issuerHandlers = (policy: IssuerPolicy) =>
  Layer.effect(
    IssuerHandlers,
    Effect.gen(function* makeIssuerHandlers() {
      const store = yield* IssuerStore;
      const registry = yield* DocumentRegistry;
      const retirements = yield* RetirementRegistry;
      const caller = yield* Caller;

      const subject = Effect.fn("Issuer.subject")(function* subject(
        name: string
      ) {
        if (!isName(name)) {
          return yield* Effect.fail(failure("InvalidName"));
        }

        if (
          Option.exists(policy.config, (config) =>
            config.reserved.includes(name)
          )
        ) {
          return yield* Effect.fail(failure("NameReserved", 403));
        }

        const binding = yield* store.transaction((tx) => tx.binding(name));

        const found =
          binding === undefined
            ? policy.config.pipe(
                Option.map((config) => ({
                  did: nameDid(config.didTemplate, name),
                  host: Option.none<string>(),
                }))
              )
            : Option.some({
                did: binding.did,
                host: Option.some(binding.host),
              });

        if (Option.isNone(found)) {
          return yield* Effect.fail(
            failure("MailboxUnavailable", 503, "Issuer is not configured")
          );
        }

        const { did, host } = found.value;

        if (
          !policy.operators.includes(caller.did) &&
          caller.did !== did &&
          !Option.contains(host, caller.did)
        ) {
          return yield* Effect.fail(failure("Forbidden", 403));
        }

        return did;
      });

      const successorDid = Effect.fn("Issuer.successorDid")(
        function* successorDid(successor: string) {
          const binding = yield* store.transaction((tx) =>
            tx.binding(successor)
          );

          if (binding !== undefined) {
            return binding.did;
          }

          return yield* Option.match(policy.config, {
            onNone: () =>
              Effect.fail(
                failure("MailboxUnavailable", 503, "Issuer is not configured")
              ),
            onSome: (config) =>
              Effect.succeed(nameDid(config.didTemplate, successor)),
          });
        }
      );

      const requireLive = Effect.fn("Issuer.requireLive")(function* requireLive(
        name: string,
        successor: string,
        did: string
      ) {
        const standing = yield* retirements.presence(did);

        if (!standing.exists) {
          return yield* Effect.fail(
            failure(
              "NameNotFound",
              404,
              `Successor ${successor} is not a registered name, so senders would be sent to a name nobody holds. Retire ${name} without a successor, or name a live one.`
            )
          );
        }

        if (standing.retirement !== undefined) {
          return yield* Effect.fail(
            failure(
              "NameNotFound",
              404,
              `Successor ${successor} is itself retired, so senders would be sent to a name that refuses mail. Retire ${name} without a successor, or name a live one.`
            )
          );
        }

        return yield* Effect.void;
      });

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

          const names = yield* Effect.forEach(rows.slice(0, limit), (row) =>
            Effect.gen(function* encodeName() {
              const entry = {
                did: row.did,
                document: row.document,
                name: row.name,
              };

              if (row.parent !== undefined) {
                Object.assign(entry, {
                  parent: yield* Schema.encodeEffect(ListNames.Parent)(
                    row.parent
                  ).pipe(
                    Effect.mapError(() => failure("MailboxUnavailable", 503))
                  ),
                });
              }

              return entry;
            })
          );

          const last = names.at(-1);

          return yield* output(
            ListNames.Output,
            rows.length > limit && last !== undefined
              ? { cursor: last.name, names }
              : { names }
          );
        }),
        listRetired: Effect.fn("Issuer.listRetired")(
          function* listRetired(params) {
            const limit = params.limit ?? ListRetired.Method.defaults.limit;

            const rows = yield* store.transaction((tx) =>
              tx.retired(params.cursor ?? "", limit + 1)
            );

            const page = rows.slice(0, limit);

            const retired = yield* Effect.forEach(
              page,
              (row) =>
                Effect.gen(function* validateRetirement() {
                  const current = yield* retirements.current(row.did);

                  if (current?.retiredAt === row.retiredAt) {
                    return [retiredOutput(row)];
                  }

                  yield* store.transaction((tx) => {
                    tx.unretire(row.name, row.retiredAt);
                  });

                  return [];
                }),
              { concurrency: 8 }
            ).pipe(Effect.map((validated) => validated.flat()));

            const last = page.at(-1);

            return yield* output(
              ListRetired.Output,
              rows.length > limit && last !== undefined
                ? { cursor: last.name, retired }
                : { retired }
            );
          }
        ),
        register: Effect.fn("Issuer.register")(function* register(input) {
          if (
            input.parent !== undefined &&
            (!isName(input.parent.name) ||
              input.parent.session.trim().length === 0)
          ) {
            return yield* failure(
              "InvalidRequest",
              400,
              "Invalid parent lineage"
            );
          }

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
                  tx.bind(
                    input.name,
                    settled.success.binding,
                    document,
                    input.parent
                  );
                }

                return settled;
              })
            );
          }

          return yield* output(Register.Output, { did: first.did });
        }),
        retireName: Effect.fn("Issuer.retireName")(function* retireName(input) {
          const did = yield* subject(input.name);

          if (
            input.successor !== undefined &&
            (!isName(input.successor) || input.successor === input.name)
          ) {
            return yield* Effect.fail(
              failure("InvalidName", 400, "Invalid successor")
            );
          }

          const successorAt =
            input.successor === undefined
              ? undefined
              : yield* successorDid(input.successor);

          if (input.successor !== undefined && successorAt !== undefined) {
            yield* requireLive(input.name, input.successor, successorAt);
          }

          const previous = yield* retirements.current(did);

          const retirement: RetirementValue = {
            by: caller.did,
            name: input.name,
            retiredAt: yield* Clock.currentTimeMillis,
          };

          if (input.successor !== undefined) {
            Object.assign(retirement, { successor: input.successor });
          }

          yield* retirements.retire(did, retirement);

          if (input.successor !== undefined && successorAt !== undefined) {
            const rechecked = yield* requireLive(
              input.name,
              input.successor,
              successorAt
            ).pipe(Effect.result);

            if (Result.isFailure(rechecked)) {
              yield* previous === undefined
                ? Effect.asVoid(retirements.clear(did))
                : retirements.retire(did, previous);

              return yield* Effect.fail(
                failure(
                  "NameNotFound",
                  404,
                  `Successor ${input.successor} changed during retirement; ${input.name} was not retired. Retire it without a successor, or name a live one.`
                )
              );
            }
          }

          yield* store.transaction((tx) => {
            tx.retire({ ...retirement, did });
          });

          return yield* output(
            Retire.Output,
            retiredOutput({ ...retirement, did })
          );
        }),
        unretireName: Effect.fn("Issuer.unretireName")(
          function* unretireName(input) {
            const did = yield* subject(input.name);
            const cleared = yield* retirements.clear(did);

            yield* store.transaction((tx) => {
              tx.unretire(input.name);
            });

            return yield* output(Unretire.Output, {
              cleared,
              did,
              name: input.name,
            });
          }
        ),
      });
    })
  );

export const respond = <S extends Schema.Codec<unknown, Schema.Json>>(
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

    case Retire.Method.nsid: {
      return yield* respond(
        Retire.Output,
        Schema.decodeUnknownEffect(Retire.Input)(request.input).pipe(
          Effect.flatMap(handlers.retireName)
        )
      );
    }

    case Unretire.Method.nsid: {
      return yield* respond(
        Unretire.Output,
        Schema.decodeUnknownEffect(Unretire.Input)(request.input).pipe(
          Effect.flatMap(handlers.unretireName)
        )
      );
    }

    case ListRetired.Method.nsid: {
      return yield* respond(
        ListRetired.Output,
        Schema.decodeUnknownEffect(ListRetired.Params)(
          request.params ?? {}
        ).pipe(Effect.flatMap(handlers.listRetired))
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
