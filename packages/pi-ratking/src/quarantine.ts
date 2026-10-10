import type * as Defs from "@rat-king/lexicon/defs";
import type {
  MailboxClientError,
  OpenedMessage,
} from "@rat-king/mailbox-client";
import {
  Clock,
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Result,
  Schema,
} from "effect";

import { writePrivateJson } from "./directory.ts";

export const QuarantineRecord = Schema.Struct({
  at: Schema.String,
  messageId: Schema.String,
  reason: Schema.String,
  senderDid: Schema.String,
  seq: Schema.Int,
});

export type QuarantineRecordValue = typeof QuarantineRecord.Type;

export interface Quarantined {
  readonly count: number;
  readonly latest: Option.Option<QuarantineRecordValue>;
}

export interface Recovery {
  readonly refresh: (did: string) => Effect.Effect<unknown, MailboxClientError>;
  readonly open: (
    envelope: Defs.EncryptedEnvelopeValue
  ) => Effect.Effect<OpenedMessage, MailboxClientError>;
}

const Entry = Schema.String.check(Schema.isPattern(/^\d+\.json$/u));

const recordJson = Schema.fromJsonString(QuarantineRecord);

const seqOf = (entry: string) => Number(entry.slice(0, -".json".length));

export const quarantined = Effect.fn("RatKing.quarantined")(
  function* quarantined(dir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const entries = (yield* fs
      .readDirectory(dir)
      .pipe(Effect.orElseSucceed((): string[] => []))).filter(Schema.is(Entry));

    const [newest] = entries.toSorted(
      (left, right) => seqOf(right) - seqOf(left)
    );

    const latest =
      newest === undefined
        ? Option.none()
        : yield* fs
            .readFileString(path.join(dir, newest))
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(recordJson)),
              Effect.option
            );

    return { count: entries.length, latest } satisfies Quarantined;
  }
);

export const recover = (dir: string, recovery: Recovery) =>
  Effect.fn("RatKing.recover")(function* recoverOrQuarantine(
    event: Defs.MessageEventValue,
    error: MailboxClientError
  ) {
    const path = yield* Path.Path;
    const { senderDid } = event.envelope.aad;

    const retried = yield* recovery
      .refresh(senderDid)
      .pipe(Effect.andThen(recovery.open(event.envelope)), Effect.result);

    if (Result.isSuccess(retried)) {
      return Option.some(retried.success);
    }

    const now = yield* Clock.currentTimeMillis;

    const record: QuarantineRecordValue = {
      at: DateTime.formatIso(DateTime.makeUnsafe(now)),
      messageId: event.receipt.message.messageId,
      reason: `${error.reason}; sender document lookup: ${retried.failure.reason}`,
      senderDid,
      seq: event.seq,
    };

    yield* Schema.encodeEffect(recordJson)(record).pipe(
      Effect.flatMap((json) =>
        writePrivateJson(path.join(dir, `${event.seq}.json`), json)
      ),
      Effect.tapError(() =>
        Effect.logWarning("Rat King quarantine record not written")
      ),
      Effect.ignore
    );

    return Option.none<OpenedMessage>();
  });
