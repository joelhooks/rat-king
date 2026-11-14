import * as Cloudflare from "@alchemy.run/cloudflare";
import { Credential, whoami } from "@rat-king/lexicon/trust";
import { Clock, Effect, Schema } from "effect";

import { publicDesk, trustLayer } from "./contact-session.ts";
import { PublicDesk, contactPolicy } from "./policy.ts";

export default class DeskPeon extends Cloudflare.DurableObject<DeskPeon>()(
  "DeskPeon",
  Effect.gen(function* deskPeonDefinition() {
    const state = yield* Cloudflare.DurableObjectState;

    const desk = yield* Schema.decodeUnknownEffect(PublicDesk)(
      yield* publicDesk
    ).pipe(Effect.orDie);

    // @effect-diagnostics-next-line returnEffectInGen:off -- Alchemy initializes each Durable Object separately from its resource declaration.
    return Effect.gen(function* initializeDeskPeon() {
      const remembered = yield* state.storage.get<string>("public-desk");

      if (remembered !== undefined && remembered !== desk) {
        return yield* Effect.die(new Error("A desk peon cannot be reassigned"));
      }

      yield* state.storage.put("public-desk", desk);

      return {
        describe: Effect.fn("DeskPeon.describe")(function* describe(
          presented: typeof Credential.Type | undefined
        ) {
          const credential =
            presented === undefined
              ? undefined
              : yield* Schema.decodeUnknownEffect(Credential)(presented);

          const now = yield* Clock.currentTimeMillis;

          return contactPolicy(desk, yield* whoami(credential, desk, now), now);
        }, Effect.provide(trustLayer)),
      };
    });
  }).pipe(Effect.orDie)
) {}
