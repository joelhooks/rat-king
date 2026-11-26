/* oxlint-disable promise/prefer-await-to-callbacks -- Effect error mapping is not a Promise callback. */
import * as Names from "@rat-king/lexicon/identity.listNames";
import * as Retired from "@rat-king/lexicon/identity.listRetired";
import { Transport } from "@rat-king/lexicon/transport";
import { transportLayer } from "@rat-king/mailbox-client";
import { Console, Effect, Layer, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { secretStoreLayer } from "../../mailbox/cli/secrets.ts";
import { operatorConfig } from "./operator-config.ts";
import { SnapshotError, writeSnapshot } from "./snapshot.ts";

interface PageParams {
  all?: boolean;
  cursor?: string;
  limit: number;
  snapshot: boolean;
}

const page = Effect.fn("Snapshot.page")(function* page<S extends Schema.Top>(
  nsid: string,
  output: S,
  cursor?: string
) {
  const params: PageParams = {
    limit: 100,
    snapshot: true,
  };

  if (nsid === Names.Method.nsid) {
    Object.assign(params, { all: true });
  }

  if (cursor !== undefined) {
    Object.assign(params, { cursor });
  }

  const response = yield* (yield* Transport)
    .request({
      input: undefined,
      method: "GET",
      nsid,
      params: { ...params },
    })
    .pipe(
      Effect.mapError(
        () =>
          new SnapshotError({
            code: "PageFailed",
            reason: `${nsid} request failed; verify issuer reachability and signing credentials`,
          })
      )
    );

  if (response.status !== 200) {
    return yield* new SnapshotError({
      code: "PageRefused",
      reason: `${nsid} returned HTTP ${response.status}; verify operator admission at the issuer`,
    });
  }

  return yield* Schema.decodeUnknownEffect(output)(response.body).pipe(
    Effect.flatMap(Schema.encodeEffect(output)),
    Effect.mapError(
      () =>
        new SnapshotError({
          code: "InvalidPage",
          reason: `${nsid} returned an invalid page; verify issuer and CLI contract versions`,
        })
    )
  );
});

export const snapshotWithTransport = Effect.fn("Snapshot.withTransport")(
  function* snapshotWithTransport(label: string, out: string) {
    const transport = yield* Transport;

    return yield* writeSnapshot(
      [
        {
          label,
          names: (cursor) =>
            page(Names.Method.nsid, Names.Output, cursor).pipe(
              Effect.provideService(Transport, transport)
            ),
          retired: (cursor) =>
            page(Retired.Method.nsid, Retired.Output, cursor).pipe(
              Effect.provideService(Transport, transport)
            ),
        },
      ],
      out
    );
  }
);

const configuredSnapshot = Effect.fn("Snapshot.configured")(
  function* configuredSnapshot(out: string) {
    const { label, endpoint, serviceDid, identity } = yield* operatorConfig;

    return yield* snapshotWithTransport(label, out).pipe(
      Effect.provide(
        transportLayer(endpoint, `${serviceDid}#mailbox`, identity).pipe(
          Layer.provide(FetchHttpClient.layer)
        )
      )
    );
  },
  Effect.mapError((error) =>
    Schema.is(SnapshotError)(error)
      ? error
      : new SnapshotError({
          code: "SnapshotConfiguration",
          reason:
            "Snapshot configuration is missing or invalid; set RAT_KING_ISSUER_LABEL, RAT_KING_ENDPOINT, RAT_KING_SERVICE_DID and RAT_KING_OPERATOR_IDENTITY",
        })
  )
);

export const snapshotCommand = Command.make(
  "snapshot",
  { out: Flag.String("out") },
  (args) =>
    configuredSnapshot(args.out).pipe(
      Effect.provide(secretStoreLayer()),
      Effect.tap((receipt) => Console.log(JSON.stringify(receipt))),
      Effect.tapError((error) =>
        Console.error(
          JSON.stringify({
            error: error.code,
            failed: "snapshot",
            next: `ratking snapshot --out ${JSON.stringify(args.out)}`,
            why: error.reason,
          })
        )
      )
    )
).pipe(
  Command.withDescription(
    "Operator: atomically export complete names, indexed retirements and issuer placements to a new directory. Reads only the issuer index, not mailbox cells."
  )
);
