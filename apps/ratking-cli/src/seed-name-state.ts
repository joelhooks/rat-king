import { Transport } from "@rat-king/lexicon/transport";
import { transportLayer } from "@rat-king/mailbox-client";
import { Console, Effect, FileSystem, Layer, Schema } from "effect";
import { Command, Flag } from "effect/cli";
import * as Digest from "effect/crypto/Digest";
import { FetchHttpClient } from "effect/http";

import { secretStoreLayer } from "../../mailbox/cli/secrets.ts";
import {
  SeedRow,
  seedNameStateNsid,
} from "../../mailbox/src/name-state-seed.ts";
import { operatorConfig } from "./operator-config.ts";
import { SnapshotError } from "./snapshot.ts";

const failure = (reason: string) =>
  new SnapshotError({ code: "SeedRefused", reason });

export const seedNameState = Effect.fn("NameState.seed")(
  function* seedNameState(file: string, sha256: string) {
    const fs = yield* FileSystem.FileSystem;

    const bytes = yield* fs
      .readFile(file)
      .pipe(
        Effect.mapError(() => failure("Cannot read the offline seed artifact"))
      );

    const digest = yield* (yield* Digest.Digest).digestHex(
      Digest.sha256,
      bytes
    );

    if (digest !== sha256) {
      return yield* failure(
        "Artifact digest differs from the verified export receipt"
      );
    }

    const rows = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.NonEmptyArray(SeedRow)),
      { onExcessProperty: "error" }
    )(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(() => failure("Invalid standing seed artifact"))
    );

    if (
      new Set(rows.map(({ state }) => state.did)).size !== rows.length ||
      rows.some(
        ({ document, state }) =>
          document !== undefined && document.id !== state.did
      )
    ) {
      return yield* failure(
        "The seed does not have one consistent record per DID"
      );
    }

    const transport = yield* Transport;

    for (let start = 0; start < rows.length; start += 100) {
      const response = yield* transport
        .request({
          input: { rows: rows.slice(start, start + 100) },
          method: "POST",
          nsid: seedNameStateNsid,
          params: undefined,
        })
        .pipe(
          Effect.mapError(() =>
            failure(
              `Seed batch at ${start} received no answer; rerun the same verified artifact`
            )
          )
        );

      if (response.status !== 200) {
        return yield* failure(
          `Seed batch at ${start} returned HTTP ${response.status}`
        );
      }
    }

    return { rows: rows.length, sha256 };
  }
);

export const seedNameStateCommand = Command.make(
  "seed-name-state",
  { file: Flag.String("file"), sha256: Flag.String("sha256") },
  (args) =>
    Effect.gen(function* seed() {
      const { endpoint, identity, serviceDid } = yield* operatorConfig;

      const receipt = yield* seedNameState(args.file, args.sha256).pipe(
        Effect.provide(
          transportLayer(endpoint, `${serviceDid}#mailbox`, identity).pipe(
            Layer.provide(FetchHttpClient.layer)
          )
        )
      );

      yield* Console.log(JSON.stringify(receipt));
    }).pipe(Effect.provide(secretStoreLayer()))
).pipe(
  Command.withDescription(
    "Operator: import verified cold Mailbox standing into the Issuer without waking any Mailbox cells."
  )
);
