import { settingsLayer } from "@rat-king/ratking-client/config";
import { Directory, directoryLayer } from "@rat-king/ratking-client/directory";
import { Console, Effect, FileSystem, Layer } from "effect";
import { Command, Flag } from "effect/cli";

export const localDirectoryLayer = directoryLayer.pipe(
  Layer.provide(settingsLayer)
);

export const retiredImportCommand = Command.make(
  "retired-import",
  { file: Flag.String("file") },
  Effect.fn("RatkingCli.retiredImport")(function* retiredImport(args) {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(args.file);

    const names = text
      .split(/\r?\n/u)
      .map((name) => name.trim())
      .filter((name) => name.length > 0);

    const result = yield* Directory.use((directory) =>
      directory.importRetired(names)
    ).pipe(Effect.provide(localDirectoryLayer));

    yield* Console.log(JSON.stringify(result));
  })
).pipe(
  Command.withDescription(
    "Import a local retired-name listing overlay. No network; identity documents and name resolution are unchanged."
  )
);
