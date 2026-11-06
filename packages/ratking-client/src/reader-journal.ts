import { Effect, Option, Schema, Semaphore } from "effect";

export const PendingIds = Schema.Struct({
  inbound: Schema.Array(Schema.String),
  outbound: Schema.Array(Schema.String),
});

export const ReaderJournal = Schema.Struct({
  did: Schema.String,
  generation: Schema.Int,
  keyReference: Schema.String,
  name: Schema.String,
  pending: PendingIds,
  session: Schema.String,
  shownIds: Schema.Array(Schema.String),
  shownTurns: Schema.Array(Schema.String),
});

export const PivotReceipt = Schema.Struct({
  after: PendingIds,
  before: PendingIds,
  counts: Schema.Struct({
    after: Schema.Struct({ inbound: Schema.Int, outbound: Schema.Int }),
    before: Schema.Struct({ inbound: Schema.Int, outbound: Schema.Int }),
  }),
  did: Schema.String,
  generation: Schema.Int,
  name: Schema.String,
  parentGeneration: Schema.Int,
  parentSession: Schema.String,
  session: Schema.String,
  source: Schema.Literal("local-journals+mailbox-inbound-events"),
});

export const sameReaderIdentity = (
  saved: typeof ReaderJournal.Type,
  own: Pick<typeof ReaderJournal.Type, "did" | "keyReference" | "name">
) =>
  saved.name === own.name &&
  saved.did === own.did &&
  saved.keyReference === own.keyReference;

export const pivotReceipt = (
  parent: typeof ReaderJournal.Type,
  child: typeof ReaderJournal.Type
): typeof PivotReceipt.Type => ({
  after: child.pending,
  before: parent.pending,
  counts: {
    after: {
      inbound: child.pending.inbound.length,
      outbound: child.pending.outbound.length,
    },
    before: {
      inbound: parent.pending.inbound.length,
      outbound: parent.pending.outbound.length,
    },
  },
  did: child.did,
  generation: child.generation,
  name: child.name,
  parentGeneration: parent.generation,
  parentSession: parent.session,
  session: child.session,
  source: "local-journals+mailbox-inbound-events",
});

export const readerJournal = <E>(ports: {
  readonly pending: Effect.Effect<typeof PendingIds.Type>;
  readonly save: (journal: typeof ReaderJournal.Type) => Effect.Effect<void, E>;
}) =>
  Effect.gen(function* makeReaderJournal() {
    const lock = yield* Semaphore.make(1);
    let current = Option.none<typeof ReaderJournal.Type>();
    const ids = new Set<string>();
    const turns = new Set<string>();

    const snapshot = Effect.gen(function* snapshot() {
      return Option.isSome(current)
        ? Option.some({
            ...current.value,
            pending: yield* ports.pending,
            shownIds: [...ids],
            shownTurns: [...turns],
          })
        : Option.none();
    });

    const save = snapshot.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ports.save,
        })
      )
    );

    return {
      checkpoint: lock.withPermits(1)(save),
      restore: (journal: typeof ReaderJournal.Type) =>
        Effect.sync(() => {
          current = Option.some(journal);
          ids.clear();
          turns.clear();

          for (const id of journal.shownIds) {
            ids.add(id);
          }

          for (const key of journal.shownTurns) {
            turns.add(key);
          }
        }),
      shown: (id: string, turn: string | undefined) =>
        lock.withPermits(1)(
          Effect.gen(function* shown() {
            const previous = yield* snapshot;

            if (Option.isSome(previous)) {
              yield* ports.save({
                ...previous.value,
                shownIds: [...new Set([...ids, id])],
                shownTurns:
                  turn === undefined
                    ? [...turns]
                    : [...new Set([...turns, turn])],
              });
              ids.add(id);

              if (turn !== undefined) {
                turns.add(turn);
              }
            }
          })
        ),
      skips: (id: string, turn?: string) =>
        ids.has(id) || (turn !== undefined && turns.has(turn)),
      snapshot,
    };
  });
