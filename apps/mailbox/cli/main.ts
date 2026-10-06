import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Defs from "@rat-king/lexicon/defs";
import * as Ack from "@rat-king/lexicon/mailbox.ack";
import * as Deliver from "@rat-king/lexicon/mailbox.deliver";
import * as List from "@rat-king/lexicon/mailbox.list";
import * as Send from "@rat-king/lexicon/mailbox.send";
import * as Lease from "@rat-king/lexicon/runtime.lease";
import { RatKingMailbox, layer } from "@rat-king/mailbox-client";
import type { OpenedMessage, SendOptions } from "@rat-king/mailbox-client";
import {
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

import { CliError, readIdentity } from "./identity.ts";
import { provision } from "./provision.ts";
import { registerDocument } from "./register-document.ts";
import { provisionAgent } from "./register.ts";
import { secretStoreLayer } from "./secrets.ts";
import { sendBody } from "./send-body.ts";

type MutableSendOptions = {
  -readonly [K in keyof SendOptions]: SendOptions[K];
};

interface ListParams {
  cursor?: string;
  afterSeq?: number;
  limit?: number;
}

interface MutableSecretOptions {
  config?: string;
  socket?: string;
}

const environment = Effect.gen(function* environment() {
  const fs = yield* FileSystem.FileSystem;

  const documents = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Array(Defs.DidDocument))
  )(yield* fs.readFileString(yield* Config.String("RAT_KING_DOCUMENTS"))).pipe(
    Effect.mapError(
      () => new CliError({ reason: "Invalid public DID documents" })
    )
  );

  return {
    documents,
    endpoint: yield* Config.String("RAT_KING_ENDPOINT"),
    home: yield* Config.String("HOME"),
    serviceDid: yield* Config.String("RAT_KING_SERVICE_DID"),
  };
});

const withClient = <A, E, R>(
  agent: string,
  call: Effect.Effect<A, E, R | RatKingMailbox>
) =>
  Effect.gen(function* invokeClient() {
    const env = yield* environment;
    const identity = yield* readIdentity(env.home, agent);

    return yield* call.pipe(
      Effect.provide(
        layer({ ...env, identity }).pipe(Layer.provide(FetchHttpClient.layer))
      )
    );
  });

type CliOutput =
  | typeof Send.Output.Encoded
  | typeof List.Output.Encoded
  | typeof Ack.Output.Encoded
  | typeof Deliver.Output.Encoded
  | typeof Lease.Main.Encoded
  | Effect.Success<ReturnType<typeof provision>>
  | Effect.Success<ReturnType<typeof provisionAgent>>
  | Effect.Success<ReturnType<typeof registerDocument>>
  | OpenedMessage
  | { released: true };

const print = (value: CliOutput) => Console.log(JSON.stringify(value));

const fenceFlags = {
  as: Flag.String("as"),
  generation: Flag.Int("generation"),
  leaseId: Flag.String("lease-id"),
};

const messageFlags = {
  ...fenceFlags,
  sender: Flag.String("sender"),
  tid: Flag.String("tid"),
};

const message = (args: { readonly sender: string; readonly tid: string }) =>
  Schema.decodeUnknownEffect(Schema.toType(Defs.MessageRef))({
    messageId: args.tid,
    senderDid: args.sender,
  });

const fence = (
  agent: string,
  args: { readonly leaseId: string; readonly generation: number }
) =>
  Effect.gen(function* loadFence() {
    const identity = yield* readIdentity(yield* Config.String("HOME"), agent);

    return {
      did: identity.did,
      generation: args.generation,
      leaseId: args.leaseId,
    };
  });

const sendCommand = Command.make(
  "send",
  {
    body: Flag.String("body").pipe(Flag.optional),
    from: Flag.String("from"),
    generation: Flag.Int("generation").pipe(Flag.optional),
    leaseId: Flag.String("lease-id").pipe(Flag.optional),
    record: Flag.String("record").pipe(Flag.optional),
    to: Flag.String("to"),
    urgent: Flag.Boolean("urgent"),
  },
  Effect.fn("MailboxCli.send")(function* send(args) {
    const body = yield* sendBody({
      body: Option.getOrUndefined(args.body),
      record: Option.getOrUndefined(args.record),
    });

    const clientCall = Effect.gen(function* call() {
      const client = yield* RatKingMailbox;
      const leaseId = Option.getOrUndefined(args.leaseId);
      const generation = Option.getOrUndefined(args.generation);

      if ((leaseId === undefined) !== (generation === undefined)) {
        return yield* new CliError({
          reason: "Supply both --lease-id and --generation",
        });
      }

      const opts: MutableSendOptions = {};

      if (args.urgent) {
        opts.urgent = true;
      }

      if (leaseId !== undefined && generation !== undefined) {
        opts.fence = yield* fence(args.from, { generation, leaseId });
      }

      return yield* Schema.encodeEffect(Send.Output)(
        yield* client.send(args.to, body, opts)
      );
    });

    yield* print(yield* withClient(args.from, clientCall));
  })
);

const listCommand = Command.make(
  "list",
  {
    afterSeq: Flag.Int("after-seq").pipe(Flag.optional),
    as: Flag.String("as"),
    cursor: Flag.String("cursor").pipe(Flag.optional),
    limit: Flag.Int("limit").pipe(Flag.optional),
  },
  Effect.fn("MailboxCli.list")(function* list(args) {
    yield* print(
      yield* withClient(
        args.as,
        Effect.gen(function* call() {
          const client = yield* RatKingMailbox;

          const params: ListParams = {};

          if (Option.isSome(args.cursor)) {
            params.cursor = args.cursor.value;
          }

          if (Option.isSome(args.afterSeq)) {
            params.afterSeq = args.afterSeq.value;
          }

          if (Option.isSome(args.limit)) {
            params.limit = args.limit.value;
          }

          return yield* Schema.encodeEffect(List.Output)(
            yield* client.list(params)
          );
        })
      )
    );
  })
);

const openCommand = Command.make(
  "open",
  { as: Flag.String("as"), file: Flag.String("file") },
  Effect.fn("MailboxCli.open")(function* open(args) {
    const fs = yield* FileSystem.FileSystem;

    const envelope = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Defs.EncryptedEnvelope)
    )(yield* fs.readFileString(args.file));

    yield* print(
      yield* withClient(
        args.as,
        Effect.gen(function* call() {
          return yield* (yield* RatKingMailbox).open(envelope);
        })
      )
    );
  })
);

const identityCommand = Command.make(
  "identity",
  { as: Flag.String("as"), did: Flag.String("did") },
  Effect.fn("MailboxCli.identity")(function* identity(args) {
    yield* print(
      yield* provision(yield* Config.String("HOME"), args.as, args.did)
    );
  })
);

const provisionCommand = Command.make(
  "provision",
  {
    agent: Flag.String("agent"),
    did: Flag.String("did"),
    secret: Flag.String("secret").pipe(Flag.optional),
    secretsConfig: Flag.String("secrets-config").pipe(Flag.optional),
    secretsSocket: Flag.String("secrets-socket").pipe(Flag.optional),
  },
  Effect.fn("MailboxCli.provision")(function* provisionCommand(args) {
    const env = yield* environment;
    const secretOptions: MutableSecretOptions = {};

    if (Option.isSome(args.secretsConfig)) {
      secretOptions.config = args.secretsConfig.value;
    }

    if (Option.isSome(args.secretsSocket)) {
      secretOptions.socket = args.secretsSocket.value;
    }

    const input = {
      ...env,
      agent: args.agent,
      did: args.did,
      operatorSecret: yield* Config.String("RAT_KING_OPERATOR_IDENTITY"),
    };

    const withSecret = Option.isSome(args.secret)
      ? { ...input, secret: args.secret.value }
      : input;

    yield* print(
      yield* provisionAgent(withSecret).pipe(
        Effect.provide([FetchHttpClient.layer, secretStoreLayer(secretOptions)])
      )
    );
  })
);

const registerCommand = Command.make(
  "register",
  {
    did: Flag.String("did"),
    document: Flag.String("document"),
  },
  Effect.fn("MailboxCli.register")(function* register(args) {
    const env = yield* environment;
    const fs = yield* FileSystem.FileSystem;
    yield* print(
      yield* registerDocument({
        ...env,
        did: args.did,
        json: yield* fs.readFileString(args.document),
        operatorSecret: yield* Config.String("RAT_KING_OPERATOR_IDENTITY"),
      }).pipe(Effect.provide([FetchHttpClient.layer, secretStoreLayer({})]))
    );
  })
);

const acquireCommand = Command.make(
  "acquire",
  {
    as: Flag.String("as"),
    expiresAt: Flag.String("expires-at"),
    sessionId: Flag.String("session-id"),
  },
  Effect.fn("MailboxCli.acquire")(function* acquire(args) {
    const identity = yield* readIdentity(yield* Config.String("HOME"), args.as);
    yield* print(
      yield* withClient(
        args.as,
        Effect.gen(function* call() {
          return yield* Schema.encodeEffect(Lease.Main)(
            yield* (yield* RatKingMailbox).lease.acquire({
              did: identity.did,
              expiresAt: args.expiresAt,
              harness: {
                $type: "sh.mschf.ratking.runtime.lease#pi",
                sessionId: args.sessionId,
              },
            })
          );
        })
      )
    );
  })
);

const renewCommand = Command.make(
  "renew",
  { ...fenceFlags, expiresAt: Flag.String("expires-at") },
  Effect.fn("MailboxCli.renew")(function* renew(args) {
    const input = {
      ...(yield* fence(args.as, args)),
      expiresAt: args.expiresAt,
    };

    yield* print(
      yield* withClient(
        args.as,
        Effect.gen(function* call() {
          return yield* Schema.encodeEffect(Lease.Main)(
            yield* (yield* RatKingMailbox).lease.renew(input)
          );
        })
      )
    );
  })
);

const resolveCommand = Command.make(
  "resolve",
  { as: Flag.String("as"), did: Flag.String("did") },
  Effect.fn("MailboxCli.resolve")(function* resolve(args) {
    yield* print(
      yield* withClient(
        args.as,
        Effect.gen(function* call() {
          return yield* Schema.encodeEffect(Lease.Main)(
            yield* (yield* RatKingMailbox).lease.resolve(args.did)
          );
        })
      )
    );
  })
);

const releaseCommand = Command.make(
  "release",
  fenceFlags,
  Effect.fn("MailboxCli.release")(function* release(args) {
    const input = yield* fence(args.as, args);
    yield* withClient(
      args.as,
      Effect.gen(function* call() {
        yield* (yield* RatKingMailbox).lease.release(input);
      })
    );
    yield* print({ released: true });
  })
);

const leaseCommand = Command.make("lease").pipe(
  Command.withSubcommands([
    acquireCommand,
    renewCommand,
    resolveCommand,
    releaseCommand,
  ])
);

const deliverCommand = Command.make(
  "deliver",
  messageFlags,
  Effect.fn("MailboxCli.deliver")(function* deliver(args) {
    const input = {
      generation: args.generation,
      leaseId: args.leaseId,
      message: yield* message(args),
    };

    yield* print(
      yield* withClient(
        args.as,
        Effect.gen(function* call() {
          return yield* Schema.encodeEffect(Deliver.Output)(
            yield* (yield* RatKingMailbox).deliver(input)
          );
        })
      )
    );
  })
);

const ackCommand = Command.make(
  "ack",
  messageFlags,
  Effect.fn("MailboxCli.ack")(function* ack(args) {
    const input = {
      generation: args.generation,
      leaseId: args.leaseId,
      message: yield* message(args),
    };

    yield* print(
      yield* withClient(
        args.as,
        Effect.gen(function* call() {
          return yield* Schema.encodeEffect(Ack.Output)(
            yield* (yield* RatKingMailbox).ack(input)
          );
        })
      )
    );
  })
);

const command = Command.make("mailbox").pipe(
  Command.withSubcommands([
    sendCommand,
    listCommand,
    openCommand,
    identityCommand,
    provisionCommand,
    registerCommand,
    leaseCommand,
    deliverCommand,
    ackCommand,
  ])
);

NodeRuntime.runMain(
  Command.runWith(command, { version: "0.1.0" })(process.argv.slice(2)).pipe(
    Effect.provide(NodeServices.layer)
  )
);
