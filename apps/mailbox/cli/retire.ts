import * as DeleteRole from "@rat-king/lexicon/identity.deleteRole";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import * as ListRoles from "@rat-king/lexicon/identity.listRoles";
import * as Retire from "@rat-king/lexicon/identity.retireName";
import * as SetRole from "@rat-king/lexicon/identity.setRole";
import * as SetSuccessor from "@rat-king/lexicon/identity.setSuccessor";
import * as Unretire from "@rat-king/lexicon/identity.unretireName";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Transport } from "@rat-king/lexicon/transport";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { Identity, transportLayer } from "@rat-king/mailbox-client";
import { Effect, Option, Schema } from "effect";

import { CliError } from "./identity.ts";
import { SecretStore } from "./secrets.ts";

const ErrorBody = Schema.Struct({
  error: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

export interface Authority {
  readonly operatorSecret: string;
  readonly endpoint: string;
  readonly serviceDid: string;
}

const operatorCall = Effect.fn("MailboxCli.operatorCall")(
  function* operatorCall<S extends Schema.Top>(
    authority: Authority,
    request: XrpcRequest,
    output: S
  ) {
    const store = yield* SecretStore;

    const operator = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Identity)
    )(yield* store.lease(authority.operatorSecret)).pipe(
      Effect.mapError(
        () => new CliError({ reason: "Invalid operator identity secret" })
      )
    );

    const response = yield* Transport.use((transport) =>
      transport.request(request)
    ).pipe(
      Effect.provide(
        transportLayer(
          authority.endpoint,
          `${authority.serviceDid}#mailbox`,
          operator
        )
      ),
      Effect.mapError(() => new CliError({ reason: "Issuer is unreachable" }))
    );

    if (response.status !== 200) {
      return yield* new CliError({
        reason: `Issuer refused ${request.nsid} (${Option.match(
          Schema.decodeUnknownOption(ErrorBody)(response.body),
          {
            onNone: () => `HTTP ${response.status}`,
            onSome: (refusal) =>
              refusal.message === undefined || refusal.message === refusal.error
                ? refusal.error
                : `${refusal.error}: ${refusal.message}`,
          }
        )})`,
      });
    }

    return yield* Schema.decodeUnknownEffect(output)(response.body).pipe(
      Effect.flatMap(Schema.encodeUnknownEffect(output)),
      Effect.mapError(
        () => new CliError({ reason: "Issuer answered with an invalid body" })
      )
    );
  }
);

const procedure = (nsid: string, input: Record<string, string>) =>
  Schema.decodeUnknownEffect(Schema.toEncoded(Runtime.Data))(input).pipe(
    Effect.map((encoded): XrpcRequest => ({
      input: encoded,
      method: "POST",
      nsid,
      params: undefined,
    })),
    Effect.mapError(() => new CliError({ reason: "Invalid name" }))
  );

export const retireName = Effect.fn("MailboxCli.retireName")(
  function* retireName(
    authority: Authority,
    name: string,
    successor: Option.Option<string>
  ) {
    return yield* operatorCall(
      authority,
      yield* procedure(
        Retire.Method.nsid,
        Option.match(successor, {
          onNone: () => ({ name }),
          onSome: (value) => ({ name, successor: value }),
        })
      ),
      Retire.Output
    );
  }
);

export const unretireName = Effect.fn("MailboxCli.unretireName")(
  function* unretireName(authority: Authority, name: string) {
    return yield* operatorCall(
      authority,
      yield* procedure(Unretire.Method.nsid, { name }),
      Unretire.Output
    );
  }
);

export const listRetired = Effect.fn("MailboxCli.listRetired")(
  function* listRetired(authority: Authority, cursor: Option.Option<string>) {
    return yield* operatorCall(
      authority,
      {
        input: undefined,
        method: "GET",
        nsid: ListRetired.Method.nsid,
        params: Option.match(cursor, {
          onNone: () => ({}),
          onSome: (value) => ({ cursor: value }),
        }),
      },
      ListRetired.Output
    );
  }
);

export const setSuccessor = Effect.fn("MailboxCli.setSuccessor")(
  function* setSuccessor(
    authority: Authority,
    name: string,
    successor: string
  ) {
    return yield* operatorCall(
      authority,
      yield* procedure(SetSuccessor.Method.nsid, { name, successor }),
      SetSuccessor.Output
    );
  }
);

export const setRole = Effect.fn("MailboxCli.setRole")(function* setRole(
  authority: Authority,
  role: {
    readonly name: string;
    readonly target: string;
    readonly role: string;
  }
) {
  return yield* operatorCall(
    authority,
    yield* procedure(SetRole.Method.nsid, { ...role }),
    SetRole.Output
  );
});

export const deleteRole = Effect.fn("MailboxCli.deleteRole")(
  function* deleteRole(authority: Authority, name: string) {
    return yield* operatorCall(
      authority,
      yield* procedure(DeleteRole.Method.nsid, { name }),
      DeleteRole.Output
    );
  }
);

const ROLE_PAGES = 100;

export const listRoles = Effect.fn("MailboxCli.listRoles")(function* listRoles(
  authority: Authority
) {
  const roles: (typeof ListRoles.Output.Encoded.roles)[number][] = [];
  let cursor: string | undefined;

  for (let page = 0; page < ROLE_PAGES; page += 1) {
    const listed = yield* operatorCall(
      authority,
      {
        input: undefined,
        method: "GET",
        nsid: ListRoles.Method.nsid,
        params: cursor === undefined ? {} : { cursor },
      },
      ListRoles.Output
    );

    roles.push(...listed.roles);
    ({ cursor } = listed);

    if (cursor === undefined) {
      return { roles };
    }
  }

  return yield* new CliError({
    reason: `listRoles needed more than ${ROLE_PAGES} pages`,
  });
});
