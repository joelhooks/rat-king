import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Defs from "@rat-king/lexicon/defs";
import { clientLayer } from "@rat-king/lexicon/mailbox-client";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
} from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { Documents, staticResolver } from "../src/auth.ts";
import { transportLayer } from "./client.ts";
import { CliError, readIdentity } from "./identity.ts";
import { send, list, open, lease, ack, tid } from "./operations.ts";
import type { ProofLeaseInput } from "./operations.ts";
import { provision } from "./provision.ts";

const environment = Effect.gen(function* environment() {
  const fs = yield* FileSystem.FileSystem;

  const documents = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Documents)
  )(yield* fs.readFileString(yield* Config.String("RAT_KING_DOCUMENTS"))).pipe(
    Effect.mapError(
      () => new CliError({ reason: "Invalid public DID documents" })
    )
  );

  return {
    audience: (yield* Config.String("RAT_KING_SERVICE_DID")).replace(
      /(?:#mailbox)?$/u,
      "#mailbox"
    ),
    documents,
    endpoint: yield* Config.String("RAT_KING_ENDPOINT"),
    home: yield* Config.String("HOME"),
  };
});

const sendCommand = Command.make(
  "send",
  {
    body: Flag.String("body"),
    from: Flag.String("from"),
    to: Flag.String("to"),
  },
  Effect.fn("MailboxCli.command.send")(function* sendCommand(args) {
    const env = yield* environment;
    const identity = yield* readIdentity(env.home, args.from);

    const transport = transportLayer(env.endpoint, env.audience, identity).pipe(
      Layer.provide(FetchHttpClient.layer)
    );

    const result = yield* send(identity, args.to, args.body).pipe(
      Effect.provide([
        staticResolver(env.documents),
        clientLayer.pipe(Layer.provide(transport)),
      ])
    );

    yield* Console.log(
      JSON.stringify(yield* Schema.encodeEffect(Send.Output)(result))
    );
  })
);

const listCommand = Command.make(
  "list",
  {
    as: Flag.String("as"),
    cursor: Flag.String("cursor").pipe(Flag.optional),
  },
  Effect.fn("MailboxCli.command.list")(function* listCommand(args) {
    const env = yield* environment;
    const identity = yield* readIdentity(env.home, args.as);

    const transport = transportLayer(env.endpoint, env.audience, identity).pipe(
      Layer.provide(FetchHttpClient.layer)
    );

    const result = yield* list(
      identity,
      Option.getOrUndefined(args.cursor)
    ).pipe(Effect.provide(clientLayer.pipe(Layer.provide(transport))));

    yield* Console.log(
      JSON.stringify(yield* Schema.encodeEffect(List.Output)(result))
    );
  })
);

const openCommand = Command.make(
  "open",
  {
    as: Flag.String("as"),
    file: Flag.String("file"),
  },
  Effect.fn("MailboxCli.command.open")(function* openCommand(args) {
    const env = yield* environment;
    const identity = yield* readIdentity(env.home, args.as);
    const fs = yield* FileSystem.FileSystem;

    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.toEncoded(Defs.EncryptedEnvelope))
    )(yield* fs.readFileString(args.file));

    const result = yield* open(identity, input).pipe(
      Effect.provide(staticResolver(env.documents))
    );

    yield* Console.log(JSON.stringify(result));
  })
);

const identityCommand = Command.make(
  "identity",
  {
    as: Flag.String("as"),
    did: Flag.String("did"),
  },
  Effect.fn("MailboxCli.command.identity")(function* identityCommand(args) {
    yield* Console.log(
      JSON.stringify(
        yield* provision(yield* Config.String("HOME"), args.as, args.did)
      )
    );
  })
);

const leaseCommand = Command.make(
  "lease",
  {
    as: Flag.String("as"),
    generation: Flag.Int("generation").pipe(Flag.optional),
    leaseId: Flag.String("lease-id").pipe(Flag.optional),
    sender: Flag.String("sender").pipe(Flag.optional),
    tid: Flag.String("tid").pipe(Flag.optional),
  },
  Effect.fn("MailboxCli.command.lease")(function* leaseCommand(args) {
    const env = yield* environment;
    const identity = yield* readIdentity(env.home, args.as);

    const leaseId =
      Option.getOrUndefined(args.leaseId) ??
      tid(yield* Clock.currentTimeMillis, 0);

    const input: ProofLeaseInput = { leaseId, ttl: 60_000 };

    if (Option.isSome(args.generation)) {
      input.generation = args.generation.value;
    }

    if (Option.isSome(args.sender) && Option.isSome(args.tid)) {
      input.message = {
        messageId: args.tid.value,
        senderDid: args.sender.value,
      };
    } else if (Option.isSome(args.sender) || Option.isSome(args.tid)) {
      return yield* new CliError({
        reason: "Supply both --sender and --tid to record delivery",
      });
    }

    const transport = transportLayer(env.endpoint, env.audience, identity).pipe(
      Layer.provide(FetchHttpClient.layer)
    );

    yield* Console.log(
      JSON.stringify(yield* lease(input).pipe(Effect.provide(transport)))
    );

    return yield* Effect.void;
  })
);

const ackCommand = Command.make(
  "ack",
  {
    as: Flag.String("as"),
    generation: Flag.Int("generation"),
    leaseId: Flag.String("lease-id"),
    sender: Flag.String("sender"),
    tid: Flag.String("tid"),
  },
  Effect.fn("MailboxCli.command.ack")(function* ackCommand(args) {
    const env = yield* environment;
    const identity = yield* readIdentity(env.home, args.as);

    const transport = transportLayer(env.endpoint, env.audience, identity).pipe(
      Layer.provide(FetchHttpClient.layer)
    );

    const result = yield* ack(identity, args).pipe(
      Effect.provide(clientLayer.pipe(Layer.provide(transport)))
    );

    yield* Console.log(
      JSON.stringify(yield* Schema.encodeEffect(Ack.Output)(result))
    );
  })
);

const command = Command.make("mailbox").pipe(
  Command.withSubcommands([
    sendCommand,
    listCommand,
    openCommand,
    identityCommand,
    leaseCommand,
    ackCommand,
  ])
);

NodeRuntime.runMain(
  Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
    Effect.provide(NodeServices.layer)
  )
);
