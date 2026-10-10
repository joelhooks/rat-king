import {
  DateTime,
  Effect,
  FileSystem,
  Match,
  Option,
  Schema,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { shellQuote } from "../../packages/alchemy-nest/src/ssh.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const Content = Schema.Union([
  Schema.Struct({
    arguments: Schema.Struct({ action: Schema.optionalKey(Schema.String) }),
    id: Schema.String,
    name: Schema.String,
    type: Schema.Literal("toolCall"),
  }),
  Schema.Struct({ text: Schema.String, type: Schema.Literal("text") }),
  Schema.Struct({ type: Schema.String }),
]);

const Session = Schema.Struct({
  message: Schema.optionalKey(
    Schema.Struct({
      content: Schema.optionalKey(Schema.Array(Content)),
      role: Schema.String,
      toolCallId: Schema.optionalKey(Schema.String),
      toolName: Schema.optionalKey(Schema.String),
    })
  ),
  timestamp: Schema.String,
});

const Receipt = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  fallback: Schema.optionalKey(Schema.Struct({ status: Schema.String })),
  path: Schema.optionalKey(Schema.String),
});

const Frame = Schema.Union([
  Schema.Struct({
    file: Schema.String,
    kind: Schema.Literal("session"),
    line: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("receipt"), line: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("quarantine") }),
]);

export const Counts = Schema.Struct({
  fallbacks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lost: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  quarantined: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ratking: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  raw: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sent: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  unanswered: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type CountsValue = typeof Counts.Type;

export const classify = (text: string | undefined) => {
  if (text === undefined) {
    return "unanswered";
  }

  return text.includes("Rat King") ? "ratking" : "raw";
};

export const doneBar = (local: CountsValue, remote: CountsValue) =>
  local.raw === 0 && remote.raw === 0 && local.lost === 0 && remote.lost === 0;

export const countFrames = <E, R>(
  frames: Stream.Stream<typeof Frame.Type, E, R>,
  cut: number
) =>
  Effect.gen(function* accumulateFrames() {
    const calls = new Map<string, Set<string>>();
    const results = new Map<string, Map<string, string>>();
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
        Match.when({ kind: "session" }, (session) =>
          Effect.gen(function* sessionFrame() {
            const parsed = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(Session)
            )(session.line).pipe(Effect.option);

            if (Option.isNone(parsed)) {
              return;
            }

            const row = parsed.value;

            if (
              Date.parse(row.timestamp) < cut ||
              !Number.isFinite(Date.parse(row.timestamp))
            ) {
              return;
            }

            const { message } = row;

            if (message === undefined) {
              return;
            }

            if (
              message.role === "toolResult" &&
              message.toolName === "intercom" &&
              message.toolCallId !== undefined
            ) {
              const text = (message.content ?? [])
                .flatMap((content) => ("text" in content ? [content.text] : []))
                .join(" ");

              const fileResults =
                results.get(session.file) ?? new Map<string, string>();

              fileResults.set(message.toolCallId, text);
              results.set(session.file, fileResults);
            }

            for (const content of message.content ?? []) {
              if (
                "name" in content &&
                content.name === "intercom" &&
                ["send", "ask", "reply", "handover"].includes(
                  content.arguments.action ?? ""
                )
              ) {
                const fileCalls = calls.get(session.file) ?? new Set<string>();
                fileCalls.add(content.id);
                calls.set(session.file, fileCalls);
              }
            }
          })
        ),
        Match.exhaustive
      )
    );
    const classified = { ratking: 0, raw: 0, unanswered: 0 };

    for (const [file, ids] of calls) {
      for (const id of ids) {
        classified[classify(results.get(file)?.get(id))] += 1;
      }
    }

    return {
      ...classified,
      fallbacks,
      lost,
      quarantined,
      sent,
    } satisfies CountsValue;
  });

export const collectComms = Effect.fn("Nest.collectComms")(
  function* collectComms(
    paths:
      | StageConfigValue["comms"]["local"]
      | StageConfigValue["comms"]["remote"],
    cut: number,
    onlyQuarantine?: boolean
  ) {
    const fs = yield* FileSystem.FileSystem;

    const script = yield* fs.readFileString(
      new URL("comms-collector.py", import.meta.url).pathname
    );

    const source = `import json\nconfig = ${JSON.stringify(JSON.stringify({ ...paths, cut: cut / 1000, onlyQuarantine: onlyQuarantine === true }))}\nimport io, sys\nsys.stdin = io.StringIO(config)\n${script}`;
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
