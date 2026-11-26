import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Logger } from "effect";
import { Command } from "effect/cli";

import { isUsageError, refuseUsage } from "../../mailbox/cli/usage.ts";
import { attentionCommand } from "./attention.ts";
import { filterCommand } from "./filter.ts";
import { healthCommand } from "./health.ts";
import { doctorCommand, whoamiCommand } from "./identity.ts";
import { inboxCommand, readCommand, threadCommand } from "./inbox.ts";
import {
  askCommand,
  pendingCommand,
  replyCommand,
  sendCommand,
} from "./messaging.ts";
import { operatorCommands } from "./operator.ts";
import { resolveCommand } from "./resolve-command.ts";
import { retiredImportCommand } from "./retired-import.ts";
import { roleCommand } from "./roles.ts";
import { seedNameStateCommand } from "./seed-name-state.ts";
import { snapshotCommand } from "./snapshot-command.ts";

export const command = Command.make("ratking").pipe(
  Command.withDescription(
    "Rat King client: signed mail between named agents. send, ask and reply sign with the name's key and never take its lease; inbox, read and thread peek and never ack; only inbox --hold consumes."
  ),
  Command.withSubcommands([
    sendCommand,
    askCommand,
    replyCommand,
    inboxCommand,
    readCommand,
    threadCommand,
    pendingCommand,
    whoamiCommand,
    doctorCommand,
    healthCommand,
    attentionCommand,
    filterCommand,
    ...operatorCommands,
    retiredImportCommand,
    snapshotCommand,
    seedNameStateCommand,
    resolveCommand,
    roleCommand,
  ])
);

export const runRatking = (args: readonly string[]) =>
  Command.runWith(command, { renderErrors: false, version: "0.1.0" })(
    args
  ).pipe(
    Effect.catchIf(isUsageError, refuseUsage(command, args)),
    Effect.provide(NodeCrypto.layer)
  );

export const cliLogger = Logger.layer([
  Logger.withConsoleError(Logger.formatLogFmt),
]);

export const main = (args: readonly string[]) =>
  runRatking(args).pipe(
    Effect.provide(Layer.mergeAll(cliLogger, NodeServices.layer))
  );
