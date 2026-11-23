import { DateTime, Effect, FileSystem, Match, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { shellQuote } from "../../packages/alchemy-nest/src/ssh.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const Receipt = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  fallback: Schema.optionalKey(Schema.Struct({ status: Schema.String })),
  path: Schema.optionalKey(Schema.String),
});

const Frame = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("receipt"), line: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("quarantine") }),
]);

export const Counts = Schema.Struct({
  fallbacks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lost: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  quarantined: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type CountsValue = typeof Counts.Type;

export const doneBar = (local: CountsValue, remote: CountsValue | null) =>
  local.lost === 0 && (remote === null || remote.lost === 0);

export const commsSources = ({ local, remote }: StageConfigValue["comms"]) =>
  remote === undefined ? [local] : [local, remote];

export const countFrames = <E, R>(
  frames: Stream.Stream<typeof Frame.Type, E, R>,
  cut: number
) =>
  Effect.gen(function* accumulateFrames() {
    let sent = 0;
    let fallbacks = 0;
    let lost = 0;
    let quarantined = 0;
    yield* Stream.runForEach(frames, (frame) =>
      Match.value(frame).pipe(
        Match.when({ kind: "quarantine" }, () =>
          Effect.sync(() => {
            quarantined += 1;
          })
        ),
        Match.when({ kind: "receipt" }, (receipt) =>
          Effect.gen(function* receiptFrame() {
            const row = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Receipt)
            )(receipt.line);

            if (DateTime.toEpochMillis(row.at) <= cut) {
              return;
            }

            sent += 1;

            if (row.path === "intercom-fallback") {
              fallbacks += 1;

              if (row.fallback?.status === "failed") {
                lost += 1;
              }
            }
          })
        ),
        Match.exhaustive
      )
    );

    return { fallbacks, lost, quarantined, sent } satisfies CountsValue;
  });

export const collectComms = Effect.fn("Nest.collectComms")(
  function* collectComms(
    paths:
      | StageConfigValue["comms"]["local"]
      | NonNullable<StageConfigValue["comms"]["remote"]>,
    cut: number,
    mode?: "quarantine" | "receipts"
  ) {
    const fs = yield* FileSystem.FileSystem;

    const script = yield* fs.readFileString(
      new URL("comms-collector.py", import.meta.url).pathname
    );

    const input = {
      ...paths,
      cut: cut / 1000,
      onlyQuarantine: mode === "quarantine",
    };

    const config =
      mode === "receipts" ? { ...input, skipQuarantine: true } : input;

    const source = `import json\nconfig = ${JSON.stringify(JSON.stringify(config))}\nimport io, sys\nsys.stdin = io.StringIO(config)\n${script}`;
    const remote = "ssh" in paths;
    const command = remote ? "ssh" : "python3";

    const args = remote
      ? [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=5",
          "--",
          paths.ssh,
          `python3 -I -c ${shellQuote(source)}`,
        ]
      : ["-I", "-c", source];

    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, { stdin: "ignore" })
    );

    const frames = handle.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.length > 0),
      Stream.mapEffect((line) =>
        Schema.decodeEffect(Schema.fromJsonString(Frame))(line)
      )
    );

    const [counts, code] = yield* Effect.all(
      [
        countFrames(frames, cut),
        handle.exitCode,
        Stream.runDrain(handle.stderr),
      ],
      { concurrency: "unbounded" }
    );

    if (code !== 0) {
      return yield* new FleetError({
        reason: "Comms collector failed; no zero-count fallback",
      });
    }

    return counts;
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () =>
          Effect.fail(new FleetError({ reason: "Comms collector timed out" })),
      }),
      Effect.mapError(
        () => new FleetError({ reason: "Comms counts unavailable" })
      )
    )
);
