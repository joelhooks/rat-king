/* oxlint-disable eslint/max-classes-per-file -- Effect service and Schema contracts share their owning port. */
import type { PeerDocument } from "@rat-king/mailbox-client";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { ChildProcessSpawner } from "effect/process";

import { Settings } from "./config.ts";
import { Directory } from "./directory.ts";
import { runCommand } from "./process.ts";

export class IssuerError extends Schema.TaggedError<IssuerError>()(
  "IssuerError",
  { reason: Schema.String }
) {}

export class Issuer extends Context.Service<
  Issuer,
  {
    readonly ensure: (
      name: string,
      document: PeerDocument
    ) => Effect.Effect<string, IssuerError>;
  }
>()("pi-ratking/Issuer") {}

export const commandIssuerLayer = Layer.effect(
  Issuer,
  Effect.gen(function* makeCommandIssuer() {
    const settings = yield* Settings;
    const directory = yield* Directory;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const register = Effect.fn("Issuer.register")(function* register(
      command: readonly [string, ...string[]],
      document: PeerDocument
    ) {
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "pi-ratking-" });
      const file = path.join(temp, "document.json");

      yield* fs.writeFileString(file, JSON.stringify(document), {
        flag: "wx",
        mode: 0o600,
      });

      return yield* runCommand([
        ...command,
        "register",
        "--did",
        document.id,
        "--document",
        file,
      ]);
    }, Effect.scoped);

    return Issuer.of({
      ensure: Effect.fn("Issuer.ensure")(
        function* ensure(name, document) {
          if (Option.isNone(settings.issuer)) {
            return yield* new IssuerError({
              reason: "No Rat King issuer is configured on this host",
            });
          }

          const [command, ...args] = settings.issuer.value;

          if (command === undefined) {
            return yield* new IssuerError({ reason: "Empty issuer command" });
          }

          const result = yield* register([command, ...args], document).pipe(
            Effect.mapError(
              () => new IssuerError({ reason: "Issuer command could not run" })
            )
          );

          if (result.code !== 0) {
            return yield* new IssuerError({
              reason: `Issuer refused ${document.id} (exit ${result.code})`,
            });
          }

          yield* directory
            .record(name, document)
            .pipe(
              Effect.mapError(
                (error) => new IssuerError({ reason: error.reason })
              )
            );

          return document.id;
        },
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      ),
    });
  })
);
