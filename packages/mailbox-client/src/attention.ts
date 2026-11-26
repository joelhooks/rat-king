import { canonical } from "@rat-king/envelope/canonical";
import { sign } from "@rat-king/envelope/es256";
import * as GetPreferences from "@rat-king/lexicon/attention.getPreferences";
import * as GetStatus from "@rat-king/lexicon/attention.getStatus";
import * as Prefs from "@rat-king/lexicon/attention.prefs";
import * as PutPreferences from "@rat-king/lexicon/attention.putPreferences";
import * as PutStatus from "@rat-king/lexicon/attention.putStatus";
import * as Status from "@rat-king/lexicon/attention.status";
import type { MailboxInterface } from "@rat-king/lexicon/mailbox-client";
import { Effect, Schema } from "effect";

import { clientError } from "./error.ts";
import type { MailboxClientError } from "./error.ts";
import { signingFor } from "./identity.ts";
import type { RuntimeIdentity } from "./identity.ts";

export const attentionBytes = (
  did: string,
  nsid: string,
  value: Prefs.MainValue | Status.MainValue
): Uint8Array => canonical({ did, nsid, value });

export interface AttentionClient {
  readonly getPreferences: () => Effect.Effect<
    Prefs.MainValue,
    MailboxClientError
  >;
  readonly getStatus: (
    did?: string
  ) => Effect.Effect<Status.MainValue, MailboxClientError>;
  readonly putPreferences: (
    prefs: Prefs.MainValue
  ) => Effect.Effect<Prefs.MainValue, MailboxClientError>;
  readonly putStatus: (
    status: Status.MainValue
  ) => Effect.Effect<Status.MainValue, MailboxClientError>;
}

export const attentionClient = (
  client: MailboxInterface,
  identity: RuntimeIdentity
): AttentionClient => ({
  getPreferences: Effect.fn("AttentionClient.getPreferences")(() =>
    Schema.decodeUnknownEffect(GetPreferences.Params)({
      did: identity.did,
    }).pipe(
      Effect.flatMap(client.getPreferences),
      Effect.map((output) => output.prefs),
      Effect.mapError(clientError)
    )
  ),
  getStatus: Effect.fn("AttentionClient.getStatus")((did = identity.did) =>
    Schema.decodeUnknownEffect(GetStatus.Params)({ did }).pipe(
      Effect.flatMap(client.getStatus),
      Effect.map((output) => output.status),
      Effect.mapError(clientError)
    )
  ),
  putPreferences: Effect.fn("AttentionClient.putPreferences")(
    function* putPreferences(prefs) {
      const validated = yield* Schema.decodeUnknownEffect(Prefs.Main)(prefs);
      const key = yield* signingFor(identity);

      const signature = yield* sign(
        key,
        attentionBytes(identity.did, PutPreferences.Method.nsid, validated)
      );

      const input = yield* Schema.decodeUnknownEffect(
        Schema.toType(PutPreferences.Input)
      )({
        did: identity.did,
        keyId: `${identity.did}#atproto`,
        prefs: validated,
        signature,
      });

      return (yield* client.putPreferences(input)).prefs;
    },
    Effect.mapError(clientError)
  ),
  putStatus: Effect.fn("AttentionClient.putStatus")(function* putStatus(
    status
  ) {
    const validated = yield* Schema.decodeUnknownEffect(Status.Main)(status);
    const key = yield* signingFor(identity);

    const signature = yield* sign(
      key,
      attentionBytes(identity.did, PutStatus.Method.nsid, validated)
    );

    const input = yield* Schema.decodeUnknownEffect(
      Schema.toType(PutStatus.Input)
    )({
      did: identity.did,
      keyId: `${identity.did}#atproto`,
      signature,
      status: validated,
    });

    return (yield* client.putStatus(input)).status;
  }, Effect.mapError(clientError)),
});

export const defaultPreferences = (): Prefs.MainValue =>
  Schema.decodeUnknownSync(Prefs.Main)({
    allow: [],
    forward: [],
    log: false,
    model: { body: "summary", kind: "none", timeoutMs: 2000 },
    mute: [],
    refuse: [],
    version: "0.1",
  });

export const defaultStatus = (): Status.MainValue =>
  Schema.decodeUnknownSync(Status.Main)({
    $type: "sh.mschf.ratking.attention.status",
    state: "available",
    version: "0.1",
  });

export const toBasisPoints = (decimal: number): number =>
  Math.round(decimal * 10_000);

export const fromBasisPoints = (points: number): number => points / 10_000;
