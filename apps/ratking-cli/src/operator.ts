import { Directory } from "@rat-king/ratking-client/directory";
import { Config, Console, Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { CliError } from "../../mailbox/cli/identity.ts";
import {
  identityCommand,
  provisionFlags,
  provisionFromFlags,
  provisionServices,
  retiredCommand,
  trafficCommand,
} from "../../mailbox/cli/main.ts";
import type { ProvisionArgs } from "../../mailbox/cli/main.ts";
import { retireName, unretireName } from "../../mailbox/cli/retire.ts";
import { secretStoreLayer } from "../../mailbox/cli/secrets.ts";
import { localDirectoryLayer } from "./retired-import.ts";

const authority = Effect.gen(function* authority() {
  return {
    endpoint: yield* Config.String("RAT_KING_ENDPOINT"),
    operatorSecret: yield* Config.String("RAT_KING_OPERATOR_IDENTITY"),
    serviceDid: yield* Config.String("RAT_KING_SERVICE_DID"),
  };
});

export const provisionAndRestore = Effect.fn("RatkingCli.provision")(
  function* provisionAndRestore(args: ProvisionArgs) {
    const result = yield* provisionFromFlags(args);
    yield* Directory.use((directory) =>
      directory.clearRetired(args.agent)
    ).pipe(
      Effect.mapError(
        () =>
          new CliError({
            reason:
              "Name provisioned remotely, but local retired overlay update failed",
          })
      )
    );

    return result;
  }
);

const provisionCommand = Command.make("provision", provisionFlags, (args) =>
  provisionAndRestore(args).pipe(
    Effect.provide([provisionServices(args), localDirectoryLayer]),
    Effect.flatMap((result) => Console.log(JSON.stringify(result)))
  )
);

const retireCommand = Command.make(
  "retire",
  {
    name: Flag.String("name"),
    successor: Flag.String("successor").pipe(Flag.optional),
  },
  Effect.fn("RatkingCli.retire")(function* retire(args) {
    const result = yield* retireName(
      yield* authority,
      args.name,
      args.successor
    ).pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]));

    yield* Directory.use((directory) =>
      directory.recordRetired(args.name, Option.getOrUndefined(args.successor))
    ).pipe(
      Effect.provide(localDirectoryLayer),
      Effect.mapError(
        () =>
          new CliError({
            reason:
              "Name retired remotely, but local retired overlay update failed",
          })
      )
    );
    yield* Console.log(JSON.stringify(result));
  })
);

const unretireCommand = Command.make(
  "unretire",
  { name: Flag.String("name") },
  Effect.fn("RatkingCli.unretire")(function* unretire(args) {
    const result = yield* unretireName(yield* authority, args.name).pipe(
      Effect.provide([FetchHttpClient.layer, secretStoreLayer({})])
    );

    yield* Directory.use((directory) => directory.clearRetired(args.name)).pipe(
      Effect.provide(localDirectoryLayer),
      Effect.mapError(
        () =>
          new CliError({
            reason:
              "Name unretired remotely, but local retired overlay update failed",
          })
      )
    );
    yield* Console.log(JSON.stringify(result));
  })
);

export const operatorCommands = [
  identityCommand.pipe(
    Command.withDescription(
      "Operator: mint a P-256 identity and print its public document. Needs RAT_KING_* operator configuration."
    )
  ),
  provisionCommand.pipe(
    Command.withDescription(
      "Operator: mint and register an agent, keeping keys in agent-secrets. Needs RAT_KING_OPERATOR_IDENTITY."
    )
  ),
  retireCommand.pipe(
    Command.withDescription(
      "Operator: retire a name, optionally naming its successor, and update its local listing overlay."
    )
  ),
  unretireCommand.pipe(
    Command.withDescription(
      "Operator: clear a name's retirement and its local listing overlay."
    )
  ),
  retiredCommand.pipe(
    Command.withDescription("Operator: list retired names and successors.")
  ),
  trafficCommand.pipe(
    Command.withDescription("Operator: print mailbox traffic for a name.")
  ),
] as const;
