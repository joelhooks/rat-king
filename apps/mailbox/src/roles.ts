import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Effect, Option } from "effect";

import { failure } from "./failure.ts";
import { retiredMessage } from "./retirement.ts";
import type { RetirementValue } from "./store.ts";

export const MAX_HOPS = 3;

export interface RouteView<E, R> {
  readonly role: (name: string) => Effect.Effect<string | undefined, E, R>;
  readonly retired: (
    name: string
  ) => Effect.Effect<Option.Option<RetirementValue>, E, R>;
}

export interface Route {
  readonly name: string;
  readonly chain: readonly string[];
}

const arrow = (chain: readonly string[]) => chain.join(" → ");

export const resolveRoute = Effect.fn("Roles.resolveRoute")(
  function* resolveRoute<E, R>(
    start: string,
    view: RouteView<E, R>
  ): Effect.fn.Return<Route, E | XrpcFailure, R> {
    const chain = [start];
    let current = start;

    while (true) {
      const target = yield* view.role(current);
      let next = target === current ? undefined : target;

      if (next === undefined) {
        const retired = yield* view.retired(current);

        if (Option.isNone(retired)) {
          return { chain, name: current };
        }

        const retirement = retired.value;

        if (retirement.successor === undefined) {
          return yield* failure(
            "Retired",
            410,
            chain.length === 1
              ? retiredMessage(retirement)
              : `${retiredMessage(retirement)}; chain ${arrow(chain)}`
          );
        }

        next = retirement.successor;
      }

      if (chain.includes(next)) {
        return yield* failure(
          "RoleUnresolved",
          409,
          `${start} cycles: ${arrow([...chain, next])}`
        );
      }

      if (chain.length > MAX_HOPS) {
        return yield* failure(
          "RoleUnresolved",
          409,
          `${start} needs more than ${MAX_HOPS} hops: ${arrow([...chain, next])}`
        );
      }

      chain.push(next);
      current = next;
    }
  }
);
