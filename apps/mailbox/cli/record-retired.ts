import * as RecordRetired from "@rat-king/lexicon/identity.recordRetired";
import { Array, Effect, Schema } from "effect";

import { CliError } from "./identity.ts";
import { operatorCall } from "./retire.ts";
import type { Authority } from "./retire.ts";

export const recordRetired = Effect.fn("MailboxCli.recordRetired")(
  function* recordRetired(authority: Authority, names: readonly string[]) {
    const input = yield* Schema.decodeUnknownEffect(RecordRetired.Input)({
      names,
    }).pipe(
      Effect.flatMap(Schema.encodeEffect(RecordRetired.Input)),
      Effect.mapError(
        () => new CliError({ reason: "Invalid retired-name batch" })
      )
    );

    return yield* operatorCall(
      authority,
      {
        input,
        method: "POST",
        nsid: RecordRetired.Method.nsid,
        params: undefined,
      },
      RecordRetired.Output
    );
  }
);

export const recordRetiredFile = Effect.fn("MailboxCli.recordRetiredFile")(
  function* recordRetiredFile<E, R>(
    text: string,
    batchSize: number,
    pauseMs: number,
    call: (names: readonly string[]) => Effect.Effect<void, E, R>
  ) {
    if (
      !Number.isInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 100 ||
      !Number.isInteger(pauseMs) ||
      pauseMs < 1
    ) {
      return yield* new CliError({
        reason: "Batch size must be 1–100 and pause-ms must be positive",
      });
    }

    const names = text
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    const batches = Array.chunksOf(names, batchSize);

    for (const batch of batches) {
      yield* Schema.decodeUnknownEffect(RecordRetired.Input)({
        names: batch,
      }).pipe(
        Effect.mapError(
          () => new CliError({ reason: "Invalid name in retired-name file" })
        )
      );
    }

    for (const [index, batch] of batches.entries()) {
      if (index > 0) {
        yield* Effect.sleep(pauseMs);
      }

      yield* call(batch);
    }

    return yield* Effect.void;
  }
);
