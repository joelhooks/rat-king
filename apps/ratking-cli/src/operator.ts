import { settingsLayer } from "@rat-king/ratking-client/config";
import { Directory, directoryLayer } from "@rat-king/ratking-client/directory";
import {
  retireSelf,
  SelfRetireError,
} from "@rat-king/ratking-client/retirement";
import { secretStoreLayer as localSecretStoreLayer } from "@rat-king/ratking-client/secrets";
import { Config, Console, Effect, Layer, Option } from "effect";
import { CliError as CommandError, Command, Flag } from "effect/cli";
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
import { refuse } from "./output.ts";
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

const recordRetired = (name: string, successor: string | undefined) =>
  Directory.use((directory) => directory.recordRetired(name, successor));

const overlayFailure =
  "Name retired remotely, but local retired overlay update failed";

export const retireAsOperator = Effect.fn("RatkingCli.retireAsOperator")(
  function* retireAsOperator(name: string, successor: Option.Option<string>) {
    const result = yield* retireName(yield* authority, name, successor);
    yield* recordRetired(name, Option.getOrUndefined(successor)).pipe(
      Effect.mapError(() => new CliError({ reason: overlayFailure })),
      Effect.provide(localDirectoryLayer)
    );

    return result;
  }
);

export const retireAsName = Effect.fn("RatkingCli.retireAsName")(
  function* retireAsName(name: string, successor: Option.Option<string>) {
    const result = yield* retireSelf({ name, successor });
    yield* recordRetired(result.name, result.successor).pipe(
      Effect.mapError(
        () => new SelfRetireError({ code: "Partial", reason: overlayFailure })
      )
    );

    return result;
  }
);

const selfRetireLayer = Layer.mergeAll(
  localSecretStoreLayer,
  directoryLayer,
  FetchHttpClient.layer
).pipe(Layer.provideMerge(settingsLayer));

const retireCommand = Command.make(
  "retire",
  {
    as: Flag.String("as").pipe(Flag.optional),
    name: Flag.String("name").pipe(Flag.optional),
    successor: Flag.String("successor").pipe(Flag.optional),
  },
  (args) => {
    if (Option.isSome(args.as)) {
      const name = args.as.value;

      return retireAsName(name, args.successor).pipe(
        Effect.provide(selfRetireLayer),
        Effect.matchEffect({
          onFailure: (fault) => refuse(false, "retire", { as: name }, fault),
          onSuccess: (result) => Console.log(JSON.stringify(result)),
        })
      );
    }

    return retireAsOperator(
      Option.getOrElse(args.name, () => ""),
      args.successor
    ).pipe(
      Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]),
      Effect.flatMap((result) => Console.log(JSON.stringify(result)))
    );
  }
).pipe(
  Command.validate(({ as, name }) =>
    Option.isSome(as) === Option.isSome(name)
      ? Effect.fail(
          new CommandError.ValidationError({
            message: "Supply exactly one of --as or --name",
          })
        )
      : Effect.void
  )
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
      "Retire a name and update its local listing overlay. Use --as to sign with its local key or --name for operator authority. With --as, stop the reader and keep it stopped until retirement finishes: the lease check and retirement are separate requests."
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
