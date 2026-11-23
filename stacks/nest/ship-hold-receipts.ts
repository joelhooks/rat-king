import { Effect, FileSystem, Option, Schema } from "effect";

import { writePrivateJson } from "../../packages/ratking-client/src/directory.ts";
import { ShipReceipt } from "./ship-config.ts";
import { FleetError } from "./stage-config.ts";

const Receipt = Schema.fromJsonString(ShipReceipt);

export const recordHeldReceipts = Effect.fn("Ship.recordHeldReceipts")(
  function* recordHeldReceipts(
    path: string,
    held: ReadonlyMap<string, string>,
    now: number
  ) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(path);
    const candidates = [...held].filter(([key]) => key !== "global");

    if (!exists && candidates.length === 0) {
      return yield* Effect.void;
    }

    const raw = exists ? yield* fs.readFileString(path) : "";
    const existing = new Map<string, typeof ShipReceipt.Type>();
    const preserved: string[] = [];
    const decode = Schema.decodeOption(Receipt);

    for (const line of raw.split("\n")) {
      if (line === "") {
        continue;
      }

      const row = decode(line);

      if (Option.isSome(row) && row.value.result === "held") {
        existing.set(row.value.sha, row.value);
      } else {
        preserved.push(line);
      }
    }

    const encode = Schema.encodeEffect(Receipt);

    const records: string[] = [];

    for (const [sha, hold] of candidates) {
      const old = existing.get(sha);
      records.push(
        yield* encode(
          old?.hold === hold
            ? old
            : {
                celldRestarted: null,
                end: now,
                hold,
                restartSeconds: null,
                result: "held",
                sha,
                start: now,
              }
        )
      );
    }

    const lines = [...preserved, ...records];
    const next = lines.length === 0 ? "" : `${lines.join("\n")}\n`;

    if (raw !== next) {
      yield* writePrivateJson(path, next);
    }

    return yield* Effect.void;
  },
  Effect.mapError(
    () => new FleetError({ reason: "Prepared hold receipt write failed" })
  )
);
