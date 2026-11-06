import { Effect, Option, Semaphore } from "effect";

import type { Inbound } from "./payload.ts";
import type { ThreadJournal, ThreadsApi } from "./threads.ts";

export interface ThreadPorts<E> {
  readonly load: (
    name: string
  ) => Effect.Effect<Option.Option<typeof ThreadJournal.Type>, E>;
  readonly save: (
    name: string,
    entries: typeof ThreadJournal.Type
  ) => Effect.Effect<void, E>;
}

export const durableThreads = <E>(memory: ThreadsApi, ports: ThreadPorts<E>) =>
  Effect.gen(function* makeDurableThreads() {
    const lock = yield* Semaphore.make(1);
    let name: string | undefined;

    const mutate = (action: Effect.Effect<void>) =>
      lock.withPermits(1)(
        Effect.gen(function* persistThread() {
          yield* action;

          if (name !== undefined) {
            yield* ports.save(name, yield* memory.snapshot);
          }
        })
      );

    return {
      ...memory,
      answer: (id: string) => mutate(memory.answer(id)),
      open: (own: string) =>
        lock.withPermits(1)(
          Effect.gen(function* loadThreads() {
            const entries = yield* ports.load(own);

            if (Option.isSome(entries)) {
              yield* memory.restore(entries.value);
            }

            name = own;
          })
        ),
      remember: (inbound: Inbound) =>
        mutate(memory.remember(inbound)).pipe(Effect.orDie),
    };
  });
