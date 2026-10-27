import {
  Console,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Schema,
  SchemaTransformation,
  Stream,
} from "effect";

import { FleetError as UsageError } from "./stage-config.ts";

export class ForbiddenField extends Schema.TaggedError<ForbiddenField>()(
  "ForbiddenField",
  {
    field: Schema.Literals(["body", "ciphertext", "summary", "message"]),
    seq: Schema.NullOr(Schema.Finite),
  }
) {}

const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u)
);

export const TrafficMetadata = Schema.Struct({
  messageId: Schema.NonEmptyString,
  recipientDid: Schema.NonEmptyString,
  recipientSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  senderDid: Schema.NonEmptyString,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  state: Schema.Literals(["accepted", "queued", "delivered", "acked"]),
  time: Timestamp,
});

export type TrafficEvent = typeof TrafficMetadata.Type;

const SequenceMetadata = Schema.Struct({ seq: Schema.Finite });

export const Unavailable = Schema.TaggedStruct("Unavailable", {
  source: Schema.String,
});

const forbidden = ["body", "ciphertext", "summary", "message"] as const;

const allowed = new Set([
  ...Object.keys(TrafficMetadata.fields),
  "ciphertextSize",
]);

const parseObject = Effect.fn("Usage.parseObject")(function* parseObject(
  line: string
) {
  const value = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.ObjectKeyword)
  )(line).pipe(
    Effect.mapError(
      () => new UsageError({ reason: "Invalid JSON object line" })
    )
  );

  if (Array.isArray(value)) {
    return yield* new UsageError({ reason: "Expected a JSON object" });
  }

  return value;
});

export const decodeTrafficLine = Effect.fn("Usage.decodeTrafficLine")(
  function* decodeTrafficLine(line: string) {
    const value = yield* parseObject(line);

    for (const field of forbidden) {
      if (Object.hasOwn(value, field)) {
        const seq = Schema.decodeUnknownOption(SequenceMetadata)(value).pipe(
          Option.map((metadata) => metadata.seq),
          Option.getOrNull
        );

        return yield* new ForbiddenField({ field, seq });
      }
    }

    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) {
        return yield* new UsageError({ reason: "Excess traffic property" });
      }
    }

    const event = yield* Schema.decodeUnknownEffect(TrafficMetadata)(value, {
      onExcessProperty: "ignore",
    }).pipe(
      Effect.mapError(
        () => new UsageError({ reason: "Invalid traffic metadata" })
      )
    );

    const timestamp = Date.parse(event.time);

    if (
      !Number.isFinite(timestamp) ||
      DateTime.formatIso(DateTime.makeUnsafe(timestamp)).slice(0, 19) !==
        event.time.slice(0, 19)
    ) {
      return yield* new UsageError({ reason: "Invalid traffic timestamp" });
    }

    return event;
  }
);

const dayBounds = Effect.fn("Usage.dayBounds")(function* dayBounds(
  day: string
) {
  const start = Date.parse(`${day}T00:00:00.000Z`);

  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(day) ||
    !Number.isFinite(start) ||
    DateTime.formatIsoDateUtc(DateTime.makeUnsafe(start)) !== day
  ) {
    return yield* new UsageError({
      reason: "Expected a valid UTC day YYYY-MM-DD",
    });
  }

  return { end: start + 86_400_000, start };
});

interface Pair {
  accepted: number | undefined;
  acceptedToday: boolean;
  delivered: number | undefined;
  deliveriesToday: number;
  ackedToday: number | undefined;
  recipient: string;
}

const percentile = (sorted: readonly number[], percent: number) =>
  sorted.length === 0
    ? null
    : (sorted[Math.ceil(sorted.length * percent) - 1] ?? null);

const senderName = (did: string) => {
  if (did.startsWith("did:web:") && did.endsWith(".ratking-fleet.invalid")) {
    return did
      .slice("did:web:".length, -".ratking-fleet.invalid".length)
      .replace(/\.pi$/u, "")
      .split(".")
      .join("/");
  }

  const match = /^did:web:(?<project>[^.]+)\.(?<row>[^.]+)\.pi\./u.exec(did);

  return match?.groups === undefined
    ? null
    : `${match.groups.project}/${match.groups.row}`;
};

export interface WindowBounds {
  readonly end: number;
  readonly start: number;
}

const foldTraffic = Effect.fn("Usage.foldTraffic")(function* foldTraffic<E, R>(
  { start, end }: WindowBounds,
  events: Stream.Stream<TrafficEvent, E, R>,
  excludeReaderless = false
) {
  const pairs = new Map<string, Pair>();
  const senders = new Map<string, number>();
  const sentTo = new Map<string, number>();
  const deliveredTo = new Set<string>();
  let sent = 0;
  let delivered = 0;
  let acked = 0;
  yield* Stream.runForEach(events, (event) =>
    Effect.sync(() => {
      const time = Date.parse(event.time);

      if (time >= end) {
        return;
      }

      const today = time >= start;
      const key = JSON.stringify([event.messageId, event.recipientDid]);
      let pair = pairs.get(key);

      if (pair === undefined) {
        pair = {
          accepted: undefined,
          acceptedToday: false,
          ackedToday: undefined,
          delivered: undefined,
          deliveriesToday: 0,
          recipient: event.recipientDid,
        };
        pairs.set(key, pair);
      }

      if (event.state === "accepted") {
        pair.accepted = Math.min(pair.accepted ?? time, time);

        if (today) {
          pair.acceptedToday = true;
          sent += 1;
          sentTo.set(
            event.recipientDid,
            (sentTo.get(event.recipientDid) ?? 0) + 1
          );
          senders.set(event.senderDid, (senders.get(event.senderDid) ?? 0) + 1);
        }
      } else if (event.state === "delivered") {
        pair.delivered = Math.min(pair.delivered ?? time, time);

        if (today) {
          delivered += 1;
          pair.deliveriesToday += 1;
          deliveredTo.add(event.recipientDid);
        }
      } else if (event.state === "acked" && today) {
        acked += 1;
        pair.ackedToday = Math.min(pair.ackedToday ?? time, time);
      }
    })
  );
  const readerless = new Set<string>();

  if (excludeReaderless) {
    for (const [recipient, count] of sentTo) {
      if (!deliveredTo.has(recipient)) {
        readerless.add(recipient);
        sent -= count;
      }
    }
  }

  let undelivered = 0;
  let replays = 0;
  const stranded = new Map<string, number>();
  const latencies: number[] = [];
  const deliveries: number[] = [];

  for (const pair of pairs.values()) {
    if (readerless.has(pair.recipient)) {
      continue;
    }

    if (pair.acceptedToday && pair.delivered === undefined) {
      undelivered += 1;
      stranded.set(pair.recipient, (stranded.get(pair.recipient) ?? 0) + 1);
    }

    if (
      pair.acceptedToday &&
      pair.accepted !== undefined &&
      pair.delivered !== undefined &&
      pair.delivered >= pair.accepted
    ) {
      deliveries.push(pair.delivered - pair.accepted);
    }

    replays +=
      pair.deliveriesToday -
      (pair.delivered !== undefined && pair.delivered >= start ? 1 : 0);

    if (
      pair.accepted !== undefined &&
      pair.ackedToday !== undefined &&
      pair.ackedToday >= pair.accepted
    ) {
      latencies.push(pair.ackedToday - pair.accepted);
    }
  }

  latencies.sort((a, b) => a - b);
  deliveries.sort((a, b) => a - b);

  return {
    ackLatency: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    acked,
    delivered,
    deliveryLatency: {
      p50: percentile(deliveries, 0.5),
      p95: percentile(deliveries, 0.95),
    },
    readerless: readerless.size,
    replays,
    senders,
    sent,
    stranded,
    undelivered,
  };
});

export const usageWindow = Effect.fn("Usage.window")(function* usageWindow<
  E,
  R,
>(bounds: WindowBounds, events: Stream.Stream<TrafficEvent, E, R>) {
  const {
    ackLatency,
    acked,
    delivered,
    deliveryLatency,
    readerless,
    replays,
    sent,
    stranded,
    undelivered,
  } = yield* foldTraffic(bounds, events, true);

  return {
    ackLatency,
    acked,
    delivered,
    deliveryLatency,
    end: DateTime.formatIso(DateTime.makeUnsafe(bounds.end)),
    readerless,
    replays,
    sent,
    start: DateTime.formatIso(DateTime.makeUnsafe(bounds.start)),
    undelivered,
    undeliveredRecipients: [...stranded]
      .map(([did, count]) => ({ count, did }))
      .toSorted(
        (a, b) => b.count - a.count || a.did.localeCompare(b.did, "en")
      ),
  };
});

export const usageDigest = Effect.fn("Usage.digest")(function* usageDigest<
  E,
  R,
>(day: string, events: Stream.Stream<TrafficEvent, E, R>, restarts = 0) {
  const { ackLatency, acked, delivered, replays, senders, sent, undelivered } =
    yield* foldTraffic(yield* dayBounds(day), events);

  return {
    ackLatency,
    acked,
    ccRatio: Unavailable.make({
      source: "traffic export gives each cc copy its own messageId",
    }),
    day,
    delivered,
    refusals: Unavailable.make({
      source: "traffic export carries no refusal metadata",
    }),
    replays,
    replaysPerRestart: restarts === 0 ? null : replays / restarts,
    restarts,
    sent,
    topSenders: [...senders]
      .toSorted(
        ([a, countA], [b, countB]) =>
          countB - countA || a.localeCompare(b, "en")
      )
      .slice(0, 10)
      .map(([did, count]) => ({ count, did, name: senderName(did) })),
    trims: Unavailable.make({
      source: "traffic export carries no trim metadata",
    }),
    undelivered,
  };
});

export const fileLines = (fs: FileSystem.FileSystem, path: string) =>
  fs.stream(path).pipe(
    Stream.mapError(
      () => new UsageError({ reason: "Cannot read usage input" })
    ),
    Stream.decodeText(),
    Stream.splitLines
  );

const RestartMetadata = Schema.Struct({
  celldRestarted: Schema.NullOr(Schema.Boolean),
  end: Schema.Finite.pipe(
    Schema.decodeTo(
      Schema.Finite,
      SchemaTransformation.transform({
        decode: (seconds) => seconds * 1000,
        encode: (milliseconds) => milliseconds / 1000,
      })
    )
  ),
});

const countRestarts = Effect.fn("Usage.countRestarts")(function* countRestarts(
  day: string,
  lines: Stream.Stream<string, UsageError>
) {
  const { start, end } = yield* dayBounds(day);

  return yield* lines.pipe(
    Stream.mapEffect((line) =>
      Effect.gen(function* decodeRestartMetadata() {
        const value = yield* parseObject(line);

        const receipt = yield* Schema.decodeUnknownEffect(RestartMetadata)(
          value
        ).pipe(
          Effect.mapError(
            () => new UsageError({ reason: "Invalid restart metadata" })
          )
        );

        return receipt.celldRestarted === true &&
          receipt.end >= start &&
          receipt.end < end
          ? 1
          : 0;
      })
    ),
    Stream.runFold(
      () => 0,
      (total, count) => total + count
    )
  );
});

export const usageCommand = Effect.fn("Usage.command")(function* usageCommand(
  args: readonly string[]
) {
  const flags = new Map<string, string>();

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (
      flag === undefined ||
      !["--day", "--input", "--restarts"].includes(flag) ||
      value === undefined ||
      value.startsWith("--") ||
      flags.has(flag)
    ) {
      return yield* new UsageError({
        reason:
          "Usage: usage --day YYYY-MM-DD --input <traffic.jsonl> [--restarts <ship-receipts.jsonl>]",
      });
    }

    flags.set(flag, value);
  }

  const day = flags.get("--day");
  const input = flags.get("--input");

  if (day === undefined || input === undefined) {
    return yield* new UsageError({
      reason: "Usage requires --day and --input",
    });
  }

  yield* dayBounds(day);
  const fs = yield* FileSystem.FileSystem;
  const restartPath = flags.get("--restarts");

  const restarts =
    restartPath === undefined
      ? 0
      : yield* countRestarts(day, fileLines(fs, restartPath));

  const digest = yield* usageDigest(
    day,
    fileLines(fs, input).pipe(Stream.mapEffect(decodeTrafficLine)),
    restarts
  );

  return yield* Console.log(JSON.stringify(digest));
});
