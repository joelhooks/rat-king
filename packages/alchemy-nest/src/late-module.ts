import { Effect } from "effect";

import { refuse } from "./files.ts";

export const awaitModule = <A>(pending: Promise<A>, reason: string) => {
  const settle: (module: Promise<A>) => Promise<A> =
    Promise.resolve.bind(Promise);

  return Effect.tryPromise({
    catch: () => refuse(reason),
    try: settle.bind(undefined, pending),
  });
};
