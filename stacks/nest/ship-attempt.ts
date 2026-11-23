import {
  Config,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Ref,
  Schema,
} from "effect";

import { RestartEvent } from "./ship-config.ts";
import type { ShipAttempt, ShipSettingsValue } from "./ship-config.ts";
import { deployOutcome } from "./ship-observation.ts";
import type { ReleaseCurrent } from "./ship-prune.ts";
import { causeDetail, FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const startAttempt = Effect.fn("Ship.startAttempt")(
  function* startAttempt(
    ship: ShipSettingsValue,
    config: StageConfigValue,
    sha: string,
    version: string,
    shipping: Ref.Ref<ReleaseCurrent>
  ) {
    const fs = yield* FileSystem.FileSystem;

    const directory = yield* fs.makeTempDirectory({
      directory: ship.releases,
      prefix: "attempt-",
    });

    yield* Ref.set(shipping, {
      attempt: directory.slice(directory.lastIndexOf("/") + 1),
      sha,
    });

    const override = yield* Config.option(
      Config.schema(Schema.NonEmptyString, "RAT_KING_SHIP_RESTART_OVERRIDE")
    );

    const events = `${directory}/restart-events.jsonl`;

    const shipAttempt: typeof ShipAttempt.Type = Option.isSome(override)
      ? { events, override: override.value, restart: ship.restart, sha }
      : { events, restart: ship.restart, sha };

    yield* fs.writeFileString(events, "", { flag: "wx", mode: 0o600 });

    return {
      config: {
        ...config,
        runtime: {
          ...config.runtime,
          RAT_KING_COMMIT: sha,
          RAT_KING_VERSION: version,
        },
        shipAttempt,
      },
      directory,
      events,
    };
  }
);

export const observeAttempt = Effect.fn("Ship.observeAttempt")(
  function* observeAttempt(
    events: string,
    result: { readonly code: number; readonly stderrTail: string | undefined }
  ) {
    const fs = yield* FileSystem.FileSystem;

    const observations = yield* Effect.forEach(
      (yield* fs.readFileString(events))
        .split("\n")
        .filter((line) => line !== ""),
      (line) => Schema.decodeEffect(Schema.fromJsonString(RestartEvent))(line)
    );

    const verdict = deployOutcome(result.code, observations);

    return result.stderrTail === undefined
      ? verdict
      : {
          ...verdict,
          stderrTail:
            `candidate deploy exited ${result.code}: ${result.stderrTail}`.slice(
              0,
              2048
            ),
        };
  }
);

export const boundDeploy = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.timeout("20 minutes"),
    Effect.mapError((cause) =>
      Schema.is(FleetError)(cause)
        ? cause
        : new FleetError({
            reason: `Candidate deploy failed; restart outcome unknown: ${Predicate.isTagged(cause, "TimeoutError") ? "timed out after 20 min" : causeDetail(cause)}`,
          })
    )
  );
