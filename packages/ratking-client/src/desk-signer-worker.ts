/* oxlint-disable eslint/no-bitwise -- Linux open flags and Unix permissions use bit masks. */
// @effect-diagnostics nodeBuiltinImport:off -- Opening a custody file without following links and inspecting its fd needs Node's raw flags.
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { argv, getuid, stdin, stdout } from "node:process";
import { createInterface } from "node:readline";

import { NodeRuntime } from "@effect/platform-node";
import { Identity } from "@rat-king/mailbox-client";
import { Effect, Schema, Stream } from "effect";

import {
  frameLimit,
  grantFailure,
  signerRequests,
} from "./desk-signer-wire.ts";

const load = (file: string) =>
  Effect.try({
    catch: grantFailure,
    try: () => {
      const fd = openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );

      try {
        const stat = fstatSync(fd);

        if (
          getuid === undefined ||
          getuid() === 0 ||
          stat.uid !== getuid() ||
          !stat.isFile() ||
          (stat.mode & 0o077) !== 0 ||
          stat.size > 4096
        ) {
          throw grantFailure();
        }

        return readFileSync(fd, "utf-8");
      } finally {
        closeSync(fd);
      }
    },
  });

const run = Effect.gen(function* run() {
  const [name, file] = argv.slice(2);

  if (name === undefined || file === undefined || argv.length !== 4) {
    return yield* grantFailure();
  }

  const identity = yield* load(file).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Identity)))
  );

  const respond = yield* signerRequests(name, identity);

  return yield* Effect.acquireUseRelease(
    Effect.sync(() =>
      createInterface({ crlfDelay: Infinity, input: stdin, terminal: false })
    ),
    (reader) =>
      Stream.fromAsyncIterable(reader, grantFailure).pipe(
        Stream.runForEach((line) =>
          Effect.gen(function* reply() {
            if (Buffer.byteLength(line) >= frameLimit) {
              return yield* grantFailure();
            }

            const response = yield* respond(line);

            if (Buffer.byteLength(response) >= frameLimit) {
              return yield* grantFailure();
            }

            return yield* Effect.callback<
              boolean,
              ReturnType<typeof grantFailure>
            >((resume) => {
              stdout.write(`${response}\n`, (error) => {
                resume(
                  error ? Effect.fail(grantFailure()) : Effect.succeed(true)
                );
              });
            });
          })
        )
      ),
    (reader) =>
      Effect.sync(() => {
        reader.close();
      })
  );
});

NodeRuntime.runMain(run.pipe(Effect.mapError(grantFailure)), {
  disableErrorReporting: true,
});
