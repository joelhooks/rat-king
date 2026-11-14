/* oxlint-disable eslint/max-classes-per-file -- Role refusals share their owning module. */
import * as ListRoles from "@rat-king/lexicon/identity.listRoles";
import * as ResolveRecipient from "@rat-king/lexicon/identity.resolveRecipient";
import type * as SetRole from "@rat-king/lexicon/identity.setRole";
import type { Request, Response } from "@rat-king/lexicon/transport";
import { Effect, Option, Schema } from "effect";

export type RoleEntry = Pick<SetRole.RoleValue, "name" | "role" | "target">;

export type Route = ResolveRecipient.OutputValue;

export type IssuerCall<E, R> = (
  request: Request
) => Effect.Effect<Response, E, R>;

export class RoleRefusal extends Schema.TaggedError<RoleRefusal>()(
  "RoleRefusal",
  {
    code: Schema.Literals(["Retired", "RoleUnresolved"]),
    reason: Schema.String,
  }
) {}

export class RolesUnavailable extends Schema.TaggedError<RolesUnavailable>()(
  "RolesUnavailable",
  { reason: Schema.String }
) {}

const ErrorBody = Schema.Struct({
  error: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

const refusalCodes = new Set(["Retired", "RoleUnresolved"]);

const MAX_PAGES = 20;

export const resolveRecipient = Effect.fn("RatKing.resolveRecipient")(
  function* resolveRecipient<E, R>(call: IssuerCall<E, R>, name: string) {
    const response = yield* call({
      input: undefined,
      method: "GET",
      nsid: ResolveRecipient.Method.nsid,
      params: { name },
    }).pipe(Effect.option);

    if (Option.isNone(response)) {
      return Option.none<Route>();
    }

    const { body, status } = response.value;

    if (status === 200) {
      return Schema.decodeUnknownOption(ResolveRecipient.Output)(body);
    }

    const error = Schema.decodeUnknownOption(ErrorBody)(body);

    if (Option.isSome(error) && refusalCodes.has(error.value.error)) {
      return yield* new RoleRefusal({
        code: error.value.error === "Retired" ? "Retired" : "RoleUnresolved",
        reason: error.value.message ?? error.value.error,
      });
    }

    return Option.none<Route>();
  }
);

export const listRoles = Effect.fn("RatKing.listRoles")(function* listRoles<
  E,
  R,
>(call: IssuerCall<E, R>) {
  const roles: RoleEntry[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = yield* call({
      input: undefined,
      method: "GET",
      nsid: ListRoles.Method.nsid,
      params: cursor === undefined ? {} : { cursor },
    }).pipe(
      Effect.mapError(
        () => new RolesUnavailable({ reason: "Name authority is unreachable" })
      )
    );

    if (response.status !== 200) {
      return yield* new RolesUnavailable({
        reason: `Name authority answered HTTP ${response.status} to listRoles`,
      });
    }

    const listed = yield* Schema.decodeUnknownEffect(ListRoles.Output)(
      response.body
    ).pipe(
      Effect.mapError(
        () =>
          new RolesUnavailable({
            reason: "Name authority answered listRoles with an invalid page",
          })
      )
    );

    roles.push(
      ...listed.roles.map(({ name, role, target }) => ({ name, role, target }))
    );
    ({ cursor } = listed);

    if (cursor === undefined) {
      return roles;
    }
  }

  return yield* new RolesUnavailable({
    reason: `listRoles needed more than ${MAX_PAGES} pages`,
  });
});
