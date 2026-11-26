import { NodeServices } from "@effect/platform-node";
import { Clock, Effect, FileSystem, Option, Schema, Stream } from "effect";

import { shadowReport } from "./jev-shadow-report.ts";
import { ShadowRow } from "./jev-shadow.ts";

const [file, ...extra] = process.argv.slice(2);

if (file === undefined || extra.length !== 0) {
  process.stderr.write(
    "Usage: node packages/pi-ratking/src/jev-shadow-cli.ts <reader-jsonl>\n"
  );
  process.exitCode = 1;
} else {
  await Effect.runPromise(
    Effect.gen(function* report() {
      const fs = yield* FileSystem.FileSystem;

      const decode = Schema.decodeUnknownOption(
        Schema.fromJsonString(ShadowRow)
      );

      const lines = yield* fs
        .stream(file)
        .pipe(Stream.decodeText(), Stream.splitLines, Stream.runCollect);

      const rows = lines.flatMap((line) => Option.toArray(decode(line)));
      const now = yield* Clock.currentTimeMillis;

      process.stdout.write(
        `${JSON.stringify({ ...shadowReport(rows, now), invalidRows: lines.length - rows.length }, null, 2)}\n`
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.tapError(() =>
        Effect.sync(() => {
          process.stderr.write("Could not read the Jev shadow journal\n");
          process.exitCode = 1;
        })
      ),
      Effect.ignore
    )
  );
}
