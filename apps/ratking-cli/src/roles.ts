import { RatKing } from "@rat-king/ratking-client/ratking";
import { Effect } from "effect";
import { Command } from "effect/cli";

import type { Report } from "./output.ts";
import { commonFlags, named } from "./session.ts";

export const roleListCommand = Command.make("list", commonFlags, (args) =>
  named("role list", args, () =>
    Effect.gen(function* roleList() {
      const roles = yield* (yield* RatKing).roles;

      return {
        document: {
          roles: roles.map(({ name, role, target }) => ({
            name,
            role,
            target,
          })),
        },
        lines:
          roles.length === 0
            ? ["No roles."]
            : roles.map(
                (entry) =>
                  `${entry.name}${entry.target === entry.name ? "" : ` (row ${entry.target})`} · ${entry.role}`
              ),
      } satisfies Report;
    })
  )
).pipe(
  Command.withDescription(
    "List roles: the names to address, the row each delivers to and its role line."
  )
);

export const roleCommand = Command.make("role").pipe(
  Command.withSubcommands([roleListCommand]),
  Command.withDescription(
    "Roles: stable names that deliver to their current row."
  )
);
