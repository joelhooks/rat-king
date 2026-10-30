/* oxlint-disable eslint/max-classes-per-file, promise/prefer-await-to-callbacks -- Effect service ports share their owning issuer module; Effect boundary transformations are not Promise callbacks. */
import * as Defs from "@rat-king/lexicon/defs";
import * as DeleteRole from "@rat-king/lexicon/identity.deleteRole";
import * as Enroll from "@rat-king/lexicon/identity.enrollHost";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import * as ListRoles from "@rat-king/lexicon/identity.listRoles";
import * as Register from "@rat-king/lexicon/identity.register";
import * as ResolveRecipient from "@rat-king/lexicon/identity.resolveRecipient";
import * as Retire from "@rat-king/lexicon/identity.retireName";
import * as SetRole from "@rat-king/lexicon/identity.setRole";
import * as SetSuccessor from "@rat-king/lexicon/identity.setSuccessor";
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
import { MAX_HOPS, resolveRoute } from "./roles.ts";
import type { RouteView } from "./roles.ts";
import type { RetirementValue } from "./store.ts";

export const issuerMethods = [
  Register.Method,
  Enroll.Method,
  ListNames.Method,
  Retire.Method,
  Unretire.Method,
  ListRetired.Method,
  SetRole.Method,
  DeleteRole.Method,
  ListRoles.Method,
  ResolveRecipient.Method,
  SetSuccessor.Method,
];

export class RetirementRegistry extends Context.Service<
  RetirementRegistry,
  {
    readonly retire: (
      did: string,
      retirement: RetirementValue,
      holderMayRetire: boolean
    ) => Effect.Effect<void, XrpcFailure>;
    readonly repoint: (
      did: string,
      successor: string,
      updatedAt: number
    ) => Effect.Effect<RetirementValue, XrpcFailure>;
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
    readonly setRole: (
      input: SetRole.InputValue
    ) => Effect.Effect<SetRole.OutputValue, XrpcFailure>;
    readonly deleteRole: (
      input: DeleteRole.InputValue
    ) => Effect.Effect<DeleteRole.OutputValue, XrpcFailure>;
    readonly listRoles: (
      params: ListRoles.ParamsValue
    ) => Effect.Effect<ListRoles.OutputValue, XrpcFailure>;
    readonly resolveRecipient: (
      params: ResolveRecipient.ParamsValue
    ) => Effect.Effect<ResolveRecipient.OutputValue, XrpcFailure>;
    readonly setSuccessor: (
      input: SetSuccessor.InputValue
    ) => Effect.Effect<SetSuccessor.OutputValue, XrpcFailure>;
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

const reservedIn = (policy: IssuerPolicy, name: string) =>
  Option.exists(policy.config, (config) => config.reserved.includes(name));

const templateDidIn = (policy: IssuerPolicy, name: string) =>
  policy.config.pipe(Option.map((config) => nameDid(config.didTemplate, name)));

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

  if (retired.updatedAt !== undefined) {
    Object.assign(encoded, { updatedAt: isoTime(retired.updatedAt) });
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

      const requireOperator = Effect.fn("Issuer.requireOperator")(
        function* requireOperator() {
          if (!policy.operators.includes(caller.did)) {
            return yield* failure("Forbidden", 403);
          }

          return yield* Effect.void;
        }
      );

      const registered = Effect.fn("Issuer.registered")(function* registered(
        name: string
      ) {
        if (
          (yield* store.transaction((tx) => tx.binding(name))) !== undefined
        ) {
          return true;
        }

        const did = templateDidIn(policy, name);

        return Option.isSome(did)
          ? (yield* retirements.presence(did.value)).exists
          : false;
      });

      const didOf = Effect.fn("Issuer.didOf")(function* didOf(name: string) {
        const bound = yield* store.transaction((tx) => tx.binding(name)?.did);

        if (bound !== undefined || reservedIn(policy, name)) {
          return bound;
        }

        return Option.getOrUndefined(templateDidIn(policy, name));
      });

      const routeView: RouteView<XrpcFailure, never> = {
        retired: Effect.fn("Issuer.routeRetired")(function* routeRetired(
          name: string
        ) {
          const entry = yield* store.transaction((tx) => tx.retiredEntry(name));

          if (entry === undefined) {
            return Option.none<RetirementValue>();
          }

          const current = yield* retirements.current(entry.did);

          if (current?.retiredAt === entry.retiredAt) {
            return Option.some(current);
          }

          yield* store.transaction((tx) => {
            tx.unretire(entry.name, entry.retiredAt);
          });

          return Option.none<RetirementValue>();
        }),
        role: (name) => store.transaction((tx) => tx.role(name)?.target),
      };

      const isRole = (name: string) =>
        store.transaction((tx) => tx.role(name) !== undefined);

      const checkSuccessor = Effect.fn("Issuer.checkSuccessor")(
        function* checkSuccessor(name: string, successor: string) {
          const route = yield* resolveRoute(successor, routeView).pipe(
            Effect.mapError((error) =>
              error.error === "Retired"
                ? failure(
                    "RoleUnresolved",
                    409,
                    `Successor ${successor} ends at a retired name with no successor (${error.message}); ${name} was not changed.`
                  )
                : error
            )
          );

          const chain = [name, ...route.chain].join(" → ");

          if (route.chain.includes(name)) {
            return yield* failure(
              "RoleUnresolved",
              409,
              `Successor ${successor} leads back to ${name}: ${chain}; ${name} was not changed.`
            );
          }

          if (route.chain.length > MAX_HOPS) {
            return yield* failure(
              "RoleUnresolved",
              409,
              `${chain} needs more than ${MAX_HOPS} hops; ${name} was not changed.`
            );
          }

          if (
            reservedIn(policy, route.name) ||
            !(yield* registered(route.name))
          ) {
            return yield* failure(
              "UnknownName",
              404,
              `Successor ${successor} is neither a registered row nor a role; ${name} was not changed.`
            );
          }

          return route;
        }
      );

      return IssuerHandlers.of({
        deleteRole: Effect.fn("Issuer.deleteRole")(function* deleteRole(input) {
          yield* requireOperator();

          if (!isName(input.name)) {
            return yield* failure("InvalidName");
          }

          const deleted = yield* store.transaction((tx) =>
            tx.deleteRole(input.name)
          );

          return yield* output(DeleteRole.Output, {
            deleted,
            name: input.name,
          });
        }),
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
            const retired: ReturnType<typeof retiredOutput>[] = [];

            for (const row of page) {
              const current = yield* retirements.current(row.did);

              if (current?.retiredAt === row.retiredAt) {
                retired.push(retiredOutput({ ...current, did: row.did }));
              } else {
                yield* store.transaction((tx) => {
                  tx.unretire(row.name, row.retiredAt);
                });
              }
            }

            const last = page.at(-1);

            return yield* output(
              ListRetired.Output,
              rows.length > limit && last !== undefined
                ? { cursor: last.name, retired }
                : { retired }
            );
          }
        ),
        listRoles: Effect.fn("Issuer.listRoles")(function* listRoles(params) {
          const limit = params.limit ?? ListRoles.Method.defaults.limit;

          const rows = yield* store.transaction((tx) =>
            tx.roles(params.cursor ?? "", limit + 1)
          );

          const roles = rows
            .slice(0, limit)
            .map(({ name, role, target }) => ({ name, role, target }));

          const last = roles.at(-1);

          return yield* output(
            ListRoles.Output,
            rows.length > limit && last !== undefined
              ? { cursor: last.name, roles }
              : { roles }
          );
        }),
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

          const decide = (tx: IssuerTransaction) => {
            const role = tx.role(input.name);

            if (role !== undefined && role.target !== input.name) {
              throw failure(
                "NameCollision",
                409,
                `${input.name} is a role for ${role.target}; choose another name.`
              );
            }

            return decideRegistration(
              config,
              {
                document,
                enrolled: tx.enrolled(caller.did),
                host: caller.did,
                name: input.name,
              },
              tx.binding(input.name)
            );
          };

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
        resolveRecipient: Effect.fn("Issuer.resolveRecipient")(
          function* resolveRecipient(params) {
            if (!isName(params.name)) {
              return yield* failure("InvalidName");
            }

            const route = yield* resolveRoute(params.name, routeView);
            const did = yield* didOf(route.name);

            return yield* output(
              ResolveRecipient.Output,
              did === undefined
                ? { chain: route.chain, name: route.name }
                : { chain: route.chain, did, name: route.name }
            );
          }
        ),
        retireName: Effect.fn("Issuer.retireName")(function* retireName(input) {
          const did = yield* subject(input.name);

          if (yield* isRole(input.name)) {
            return yield* failure(
              "NameReserved",
              403,
              `${input.name} is a role and is never retired; delete the role first.`
            );
          }

          if (
            input.successor !== undefined &&
            (!isName(input.successor) || input.successor === input.name)
          ) {
            return yield* Effect.fail(
              failure("InvalidName", 400, "Invalid successor")
            );
          }

          const toRole =
            input.successor !== undefined && (yield* isRole(input.successor));

          if (toRole && input.successor !== undefined) {
            yield* checkSuccessor(input.name, input.successor);
          }

          const successorAt =
            input.successor === undefined || toRole
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

          const holderMayRetire = caller.did === did;

          yield* retirements.retire(did, retirement, holderMayRetire);

          if (input.successor !== undefined && successorAt !== undefined) {
            const rechecked = yield* requireLive(
              input.name,
              input.successor,
              successorAt
            ).pipe(Effect.result);

            if (Result.isFailure(rechecked)) {
              yield* previous === undefined
                ? Effect.asVoid(retirements.clear(did))
                : retirements.retire(did, previous, holderMayRetire);

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
        setRole: Effect.fn("Issuer.setRole")(function* setRole(input) {
          yield* requireOperator();

          if (!isName(input.name) || !isName(input.target)) {
            return yield* failure("InvalidName");
          }

          if (input.role.trim().length === 0) {
            return yield* failure("InvalidRequest", 400, "Empty role line");
          }

          if (input.name === input.target) {
            if (
              !reservedIn(policy, input.name) &&
              !(yield* registered(input.name))
            ) {
              return yield* failure(
                "UnknownName",
                404,
                `${input.name} is not a registered row, so it cannot be its own role.`
              );
            }
          } else {
            if (reservedIn(policy, input.name)) {
              return yield* failure(
                "NameCollision",
                409,
                `${input.name} is a reserved name; only a self-role may label it.`
              );
            }

            if (Option.isSome(yield* routeView.retired(input.name))) {
              return yield* failure(
                "NameCollision",
                409,
                `${input.name} is a retired name; point it at the role with identity.setSuccessor instead.`
              );
            }

            if (yield* registered(input.name)) {
              return yield* failure(
                "NameCollision",
                409,
                `${input.name} is a registered row; only a self-role may label it.`
              );
            }

            if (
              reservedIn(policy, input.target) ||
              !(yield* registered(input.target))
            ) {
              return yield* failure(
                "UnknownName",
                404,
                `Target ${input.target} is not a registered row.`
              );
            }
          }

          const role = {
            name: input.name,
            role: input.role,
            target: input.target,
          };

          yield* store.transaction((tx) => {
            tx.setRole(role);
          });

          return yield* output(SetRole.Output, role);
        }),
        setSuccessor: Effect.fn("Issuer.setSuccessor")(
          function* setSuccessor(input) {
            yield* requireOperator();

            const did = yield* subject(input.name);

            if (yield* isRole(input.name)) {
              return yield* failure(
                "NameReserved",
                403,
                `${input.name} is a role and is never retired.`
              );
            }

            if (!isName(input.successor) || input.successor === input.name) {
              return yield* failure("InvalidName", 400, "Invalid successor");
            }

            yield* checkSuccessor(input.name, input.successor);

            const retirement = yield* retirements
              .repoint(did, input.successor, yield* Clock.currentTimeMillis)
              .pipe(
                Effect.mapError((error) =>
                  error.error === "NotRetired"
                    ? failure(
                        "NotRetired",
                        409,
                        `${input.name} is not retired; retire it with identity.retireName instead.`
                      )
                    : error
                )
              );

            yield* store.transaction((tx) => {
              tx.retire({ ...retirement, did });
            });

            return yield* output(
              SetSuccessor.Output,
              retiredOutput({ ...retirement, did })
            );
          }
        ),
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

    case SetRole.Method.nsid: {
      return yield* respond(
        SetRole.Output,
        Schema.decodeUnknownEffect(SetRole.Input)(request.input).pipe(
          Effect.flatMap(handlers.setRole)
        )
      );
    }

    case DeleteRole.Method.nsid: {
      return yield* respond(
        DeleteRole.Output,
        Schema.decodeUnknownEffect(DeleteRole.Input)(request.input).pipe(
          Effect.flatMap(handlers.deleteRole)
        )
      );
    }

    case ListRoles.Method.nsid: {
      return yield* respond(
        ListRoles.Output,
        Schema.decodeUnknownEffect(ListRoles.Params)(request.params ?? {}).pipe(
          Effect.flatMap(handlers.listRoles)
        )
      );
    }

    case ResolveRecipient.Method.nsid: {
      return yield* respond(
        ResolveRecipient.Output,
        Schema.decodeUnknownEffect(ResolveRecipient.Params)(
          request.params ?? {}
        ).pipe(Effect.flatMap(handlers.resolveRecipient))
      );
    }

    case SetSuccessor.Method.nsid: {
      return yield* respond(
        SetSuccessor.Output,
        Schema.decodeUnknownEffect(SetSuccessor.Input)(request.input).pipe(
          Effect.flatMap(handlers.setSuccessor)
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
