import * as Plan from "alchemy/Plan";
import { Effect, Option, Schema } from "effect";

import {
  digest,
  refuse,
  textDigest,
} from "../../packages/alchemy-nest/src/files.ts";
import type { Interface } from "../../packages/alchemy-nest/src/host-shell.ts";
import {
  renderUnit,
  UnitSchema,
  unitPath,
} from "../../packages/alchemy-nest/src/systemd.ts";

const Declaration = Schema.Struct({
  enabled: UnitSchema.fields.enabled,
  home: UnitSchema.fields.home,
  name: UnitSchema.fields.name,
  scope: UnitSchema.fields.scope,
  sections: UnitSchema.fields.sections,
  started: UnitSchema.fields.started,
});

const Ownership = Schema.Struct({
  attr: Schema.Struct({ path: Schema.String, sha256: Schema.String }),
});

const Saved = Schema.Struct({ props: Schema.Unknown });

export const stageOwnedUnit = Effect.fn("Ship.stageOwnedUnit")(
  function* stageOwnedUnit(
    shell: Interface,
    unit: typeof Declaration.Type,
    owner: typeof Ownership.Type | undefined
  ) {
    const path = unitPath(unit);
    const text = renderUnit(unit);
    const existing = yield* shell.read(path);

    if (existing !== undefined && digest(existing) === textDigest(text)) {
      return yield* Effect.void;
    }

    if (existing !== undefined) {
      if (owner === undefined) {
        return yield* refuse(
          "Existing unit has no qualified owner for staging"
        );
      }

      if (owner.attr.path !== path || owner.attr.sha256 !== digest(existing)) {
        return yield* refuse(
          "Unit changed outside its qualified owner; staging refused"
        );
      }
    }

    yield* shell.write({
      bytes: new TextEncoder().encode(text),
      mode: 0o644,
      path,
    });

    return yield* Effect.void;
  }
);

export const stageShipUnits = Effect.fn("Ship.stageUnits")(
  function* stageShipUnits(plan: Plan.Plan, shell: Interface) {
    for (const row of Object.values(plan.resources)) {
      const description = Plan.describeResource(row);

      if (
        description.resourceType !== "Celld.Node" &&
        !(
          description.resourceType === "RatsNest.SystemdUnit" &&
          description.fqn.endsWith("/store/server")
        )
      ) {
        continue;
      }

      if (row.action === "replace") {
        return yield* refuse(
          "Unit identity replacement cannot be staged as an ordinary restart"
        );
      }

      const state: unknown = row.state;

      const input: unknown =
        row.action === "noop"
          ? (yield* Schema.decodeUnknownEffect(Saved)(state)).props
          : row.props;

      const unit = yield* Schema.decodeUnknownEffect(Declaration)(input).pipe(
        Effect.mapError(() =>
          refuse("Unit declaration is unresolved; refusing restart staging")
        )
      );

      const owner = yield* Schema.decodeUnknownEffect(Ownership)(state).pipe(
        Effect.option,
        Effect.map(Option.getOrUndefined)
      );

      yield* stageOwnedUnit(shell, unit, owner);
    }

    return yield* Effect.void;
  }
);
