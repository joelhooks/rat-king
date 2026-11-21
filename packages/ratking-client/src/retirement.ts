import * as Retire from "@rat-king/lexicon/identity.retireName";
import * as Resolve from "@rat-king/lexicon/runtime.resolveLease";
import { Transport } from "@rat-king/lexicon/transport";
import { Identity, transportLayer } from "@rat-king/mailbox-client";
import { Effect, Option, Redacted, Schema } from "effect";

import { Settings } from "./config.ts";
import { AgentName, canonicalName, didFor } from "./name.ts";
import { locateIdentitySecret, SecretStore } from "./secrets.ts";

export class SelfRetireError extends Schema.TaggedError<
  SelfRetireError,
  { readonly brand: unique symbol }
>()("SelfRetireError", {
  code: Schema.Literals([
    "NoIdentity",
    "LeaseLive",
    "Rejected",
    "Partial",
    "Uncertain",
  ]),
  reason: Schema.String,
}) {}

const fail = (code: SelfRetireError["code"], reason: string) =>
  new SelfRetireError({ code, reason });

const ErrorBody = Schema.Struct({
  error: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

const refusal = (status: number, error: typeof ErrorBody.Type | undefined) => {
  if (error === undefined) {
    return `Name authority answered HTTP ${status}`;
  }

  return error.message === undefined || error.message === error.error
    ? error.error
    : `${error.error}: ${error.message}`;
};

const readIdentity = Effect.fn("Retirement.readIdentity")(
  function* readIdentity(name: string) {
    const settings = yield* Settings;
    const store = yield* SecretStore;

    const { held, secret } = yield* locateIdentitySecret(name).pipe(
      Effect.mapError((error) => fail("NoIdentity", error.reason))
    );

    if (!held) {
      return yield* fail("NoIdentity", `This machine holds no key for ${name}`);
    }

    const value = yield* store
      .lease(secret)
      .pipe(Effect.mapError((error) => fail("NoIdentity", error.reason)));

    const identity = yield* Schema.decodeEffect(
      Schema.fromJsonString(Identity)
    )(Redacted.value(value)).pipe(
      Effect.mapError(() => fail("NoIdentity", "Identity secret is malformed"))
    );

    if (
      identity.did !== didFor(settings.didTemplate, settings.reserved, name)
    ) {
      return yield* fail(
        "NoIdentity",
        `Local identity does not belong to ${name}; key not used`
      );
    }

    return identity;
  }
);

const requireNoLiveLease = Effect.fn("Retirement.requireNoLiveLease")(
  function* requireNoLiveLease(name: string, did: string) {
    const transport = yield* Transport;

    const response = yield* transport
      .request({
        input: undefined,
        method: "GET",
        nsid: Resolve.Method.nsid,
        params: { did },
      })
      .pipe(
        Effect.mapError(() =>
          fail(
            "Rejected",
            "Could not check the reader lease; nothing was retired"
          )
        )
      );

    if (response.status === 200) {
      const { lease } = yield* Schema.decodeUnknownEffect(Resolve.Output)(
        response.body
      ).pipe(
        Effect.mapError(() =>
          fail("Rejected", "Invalid lease response; nothing was retired")
        )
      );

      return yield* fail(
        "LeaseLive",
        `${name} is held by a live reader until ${lease.expiresAt}; nothing was retired`
      );
    }

    const body = Option.getOrUndefined(
      Schema.decodeUnknownOption(ErrorBody)(response.body)
    );

    if (response.status === 404 && body?.error === "LeaseNotFound") {
      return yield* Effect.void;
    }

    return yield* fail(
      "Rejected",
      `Could not check the reader lease (${refusal(response.status, body)}); nothing was retired`
    );
  }
);

const requestRetirement = Effect.fn("Retirement.request")(
  function* requestRetirement(input: typeof Retire.Input.Encoded) {
    const transport = yield* Transport;

    const response = yield* transport
      .request({
        input,
        method: "POST",
        nsid: Retire.Method.nsid,
        params: undefined,
      })
      .pipe(
        Effect.mapError(() =>
          fail("Uncertain", "Name authority is unreachable")
        )
      );

    if (response.status !== 200) {
      const error = Option.getOrUndefined(
        Schema.decodeUnknownOption(ErrorBody)(response.body)
      );

      const reason = refusal(response.status, error);

      if (error?.error === "LeaseLive") {
        return yield* fail("LeaseLive", reason);
      }

      return yield* fail(
        response.status >= 500 ? "Uncertain" : "Rejected",
        reason
      );
    }

    return yield* Schema.decodeUnknownEffect(Retire.Output)(response.body).pipe(
      Effect.flatMap(Schema.encodeEffect(Retire.Output)),
      Effect.mapError(() =>
        fail(
          "Uncertain",
          "Name authority answered with an invalid retirement receipt"
        )
      )
    );
  }
);

export const retireSelf = Effect.fn("Retirement.retireSelf")(
  function* retireSelf(args: {
    readonly name: string;
    readonly successor: Option.Option<string>;
  }) {
    const settings = yield* Settings;
    const name = canonicalName(settings.reserved, args.name);

    if (!Schema.is(AgentName)(name)) {
      return yield* fail(
        "Rejected",
        `${args.name} is not a valid Rat King name`
      );
    }

    const input = yield* Schema.decodeEffect(Schema.toEncoded(Retire.Input))(
      Option.match(args.successor, {
        onNone: () => ({ name }),
        onSome: (successor) => ({ name, successor }),
      })
    ).pipe(
      Effect.mapError(() =>
        fail("Rejected", "Invalid retirement name or successor")
      )
    );

    const identity = yield* readIdentity(name);

    return yield* requireNoLiveLease(name, identity.did).pipe(
      Effect.andThen(requestRetirement(input)),
      Effect.provide(
        transportLayer(
          settings.endpoint,
          `${settings.serviceDid.replace(/#mailbox$/u, "")}#mailbox`,
          identity
        )
      )
    );
  }
);
