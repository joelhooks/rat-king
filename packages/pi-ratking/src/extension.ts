// @effect-diagnostics asyncFunction:off -- Pi's extension API is the Promise boundary; Effect owns the work behind it.
import type {
  EventBus,
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { NodeServices } from "@effect/platform-node";
import {
  Cause,
  Config,
  Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Match,
  Option,
  Schema,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { Type } from "typebox";

import { NotConfigured, settingsLayer, Settings, toolName } from "./config.ts";
import { directoryLayer } from "./directory.ts";
import { paneLabel } from "./herdr.ts";
import type { SessionFacts } from "./identity.ts";
import { issuerLayer } from "./issuer.ts";
import { messageView } from "./message-view.ts";
import { LexiconRecord, renderInbound } from "./payload.ts";
import type { Inbound } from "./payload.ts";
import { RatKing, ratKingLayer } from "./ratking.ts";
import type { Deliver, SendOptions } from "./ratking.ts";
import { secretStoreLayer } from "./secrets.ts";
import {
  description,
  notConfiguredText,
  notDeliveredText,
  promptSnippet,
  runAction,
  ToolParams,
} from "./tool.ts";
import type { ToolText } from "./tool.ts";

export const SEND_EVENT = "ratking/send";

export const SEND_RESULT_EVENT = "ratking/send:result";

export const MESSAGE_EVENT = "ratking/message";

export const RECORD_EVENT = "ratking/record";

export const STATUS_EVENT = "ratking/status";

export const STATUS_RESULT_EVENT = "ratking/status:result";

export interface ReaderStatus {
  readonly name: string | null;
  readonly did: string | null;
  readonly reader: "live" | "acquiring" | "retired" | "off" | "send-only";
  readonly leaseGeneration?: number;
  readonly leaseUntil?: string;
}

export const RETIRE_EVENT = "ratking/retire";

export const RETIRE_RESULT_EVENT = "ratking/retire:result";

const RELEASE_WAIT_MS = 2000;

export const injects = (inbound: { readonly kind: string }, settled: boolean) =>
  !settled && inbound.kind !== "data";

const sendFields = {
  encrypt: Schema.optionalKey(Schema.Boolean),
  kind: Schema.optionalKey(Schema.Literals(["message", "ask", "data"])),
  replyTo: Schema.optionalKey(Schema.String),
  requestId: Schema.String,
  to: Schema.optionalKey(Schema.String),
};

const SendRequest = Schema.Union([
  Schema.Struct({
    ...sendFields,
    body: Schema.String,
    record: Schema.optionalKey(Schema.Never),
  }),
  Schema.Struct({
    ...sendFields,
    body: Schema.optionalKey(Schema.Never),
    record: LexiconRecord,
  }),
]);

const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer);

export const appLayer = ratKingLayer.pipe(
  Layer.provideMerge(issuerLayer),
  Layer.provideMerge(secretStoreLayer),
  Layer.provideMerge(directoryLayer),
  Layer.provideMerge(settingsLayer),
  Layer.provideMerge(platform)
);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return Schema.is(Schema.Struct({ code: Schema.Literal("EPERM") }))(error);
  }
};

export const collectFacts = (
  session: string,
  sessionName?: () => string | undefined,
  interactive = true
) =>
  Effect.gen(function* sessionFacts() {
    const env = yield* Config.option(
      Config.String(interactive ? "RATKING_NAME" : "RATKING_PRINT_NAME")
    );

    const paneId = interactive
      ? yield* Config.option(Config.String("HERDR_PANE_ID"))
      : Option.none<string>();

    const pane = Option.isSome(paneId)
      ? yield* paneLabel(paneId.value)
      : Option.none<string>();

    return {
      alive,
      env,
      label: () =>
        Option.orElse(
          Option.filter(
            Option.fromNullishOr(sessionName?.()),
            (name) => name.trim() !== ""
          ),
          () => pane
        ),
      pane,
      pid: process.pid,
      reads: interactive || Option.isSome(env),
      session,
    } satisfies SessionFacts;
  }).pipe(Effect.provide(NodeServices.layer));

const inboundDetails = (inbound: Inbound, settled: boolean) => ({
  body: inbound.body,
  cc: inbound.cc,
  did: inbound.did,
  from: inbound.from,
  id: inbound.id,
  kind: inbound.kind,
  label: Option.getOrUndefined(inbound.label),
  replyTo: Option.getOrUndefined(inbound.replyTo),
  settled,
  summary: Option.getOrUndefined(inbound.summary),
  verified: inbound.verified,
});

const toolResult = (result: ToolText) => {
  const content = [{ text: result.text, type: "text" as const }];

  return result.isError
    ? { content, details: result.details, isError: true as const }
    : { content, details: result.details };
};

type Services = Layer.Success<typeof appLayer>;

type Runtime = ManagedRuntime.ManagedRuntime<Services, NotConfigured>;

export interface SessionStart {
  readonly interactive?: boolean;
  readonly session: string;
  readonly sessionName?: () => string | undefined;
  readonly warn: (message: string) => void;
}

export interface PiHost {
  readonly events: EventBus;
  readonly registerMessageRenderer: ExtensionAPI["registerMessageRenderer"];
  readonly registerTool: ExtensionAPI["registerTool"];
  readonly sendMessage: ExtensionAPI["sendMessage"];
  readonly onSessionStart: (
    handler: (start: SessionStart) => Promise<void>
  ) => void;
  readonly onSessionEnd: (handler: () => Promise<void>) => void;
}

const piHost = (pi: ExtensionAPI): PiHost => ({
  events: pi.events,
  onSessionEnd: (handler) => {
    pi.on("session_shutdown", handler);
  },
  onSessionStart: (handler) => {
    pi.on("session_start", async (_event, ctx) => {
      await handler({
        interactive: ctx.hasUI,
        session: ctx.sessionManager.getSessionId(),
        sessionName: () => pi.getSessionName(),
        warn: (message) => {
          ctx.ui.notify(message, "warning");
        },
      });
    });
  },
  registerMessageRenderer: (customType, renderer) => {
    pi.registerMessageRenderer(customType, renderer);
  },
  registerTool: (tool) => {
    pi.registerTool(tool);
  },
  sendMessage: (message, delivery) => {
    pi.sendMessage(message, delivery);
  },
});

export interface ExtensionOptions {
  readonly layer: Layer.Layer<Services, NotConfigured>;
  readonly facts: (
    session: string,
    sessionName?: () => string | undefined,
    interactive?: boolean
  ) => Effect.Effect<SessionFacts, Config.ConfigError>;
  readonly tool: Effect.Effect<string>;
}

const notRunning = (cause: Cause.Cause<NotConfigured>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "Rat King is not running in this Pi",
    onSome: (error) => error.reason,
  });

const forwardSend = (request: typeof SendRequest.Type) =>
  Effect.gen(function* forward() {
    const ratking = yield* RatKing;

    const body = request.record ?? request.body;

    const options: Pick<SendOptions, "encrypt" | "kind"> = {
      kind: request.kind ?? "message",
    };

    if (request.encrypt !== undefined) {
      Object.assign(options, { encrypt: request.encrypt });
    }

    const delivered =
      request.replyTo === undefined
        ? yield* ratking.send(request.to ?? "", body, options)
        : yield* ratking.reply(request.replyTo, body, options);

    return {
      id: delivered.id,
      requestId: request.requestId,
      seq: delivered.seq,
      status: "delivered",
      to: delivered.to,
    } as const;
  }).pipe(
    Effect.catchTags({
      AskFailed: (error) =>
        Effect.succeed({
          code: error.code,
          reason: error.reason,
          requestId: request.requestId,
          status: "not-delivered",
        } as const),
      NotDelivered: (error) =>
        Effect.succeed({
          code: error.code,
          reason: notDeliveredText(error),
          requestId: request.requestId,
          status: "not-delivered",
        } as const),
    })
  );

const parameters = Type.Object({
  action: Type.Union(
    [
      "list",
      "list-cwd",
      "send",
      "ask",
      "handover",
      "reply",
      "pending",
      "status",
      "cancel",
    ].map((action) => Type.Literal(action)),
    {
      description:
        "send, ask (waits for the reply), reply, pending, list, status. handover and cancel are refused on Rat King.",
    }
  ),
  attachments: Type.Optional(
    Type.Array(
      Type.Object({
        content: Type.String(),
        language: Type.Optional(Type.String()),
        name: Type.String(),
        type: Type.Union([
          Type.Literal("file"),
          Type.Literal("snippet"),
          Type.Literal("context"),
        ]),
      })
    )
  ),
  cwd: Type.Optional(
    Type.String({ description: "Not supported: Rat King addresses by name." })
  ),
  encrypt: Type.Optional(
    Type.Boolean({
      description:
        "End-to-end encrypt this send, ask or reply. Use it for secrets, credentials, customer data or private transcripts. Default: signed plaintext, readable by observers.",
    })
  ),
  focus: Type.Optional(Type.Boolean({ description: "Unused." })),
  message: Type.Optional(
    Type.String({ description: "Message text for send, ask or reply." })
  ),
  messageId: Type.Optional(
    Type.String({ description: "Accepted for compatibility; unused." })
  ),
  openProjectPaneIfMissing: Type.Optional(
    Type.Boolean({ description: "Not available on Rat King." })
  ),
  replyTo: Type.Optional(
    Type.String({
      description: "Message id to answer, from the inbound message.",
    })
  ),
  retryOf: Type.Optional(
    Type.String({ description: "Accepted for compatibility; unused." })
  ),
  summary: Type.Optional(
    Type.String({
      description:
        "One-line concise summary of the message (at most 280 characters), shown first on phones and in compact views. Include it on every send, ask or reply; lead with the point or the ask.",
    })
  ),
  supersedes: Type.Optional(
    Type.String({ description: "Accepted for compatibility; unused." })
  ),
  to: Type.Optional(Type.String({ description: "Target Rat King name." })),
});

export const ratkingExtension = (options: ExtensionOptions) =>
  async function piRatking(pi: PiHost) {
    const tool = await Effect.runPromise(options.tool);

    pi.registerMessageRenderer(
      "ratking_message",
      (message, renderOptions, theme) =>
        messageView({
          details: message.details,
          expanded: renderOptions.expanded,
          theme,
          tool,
        })
    );

    let runtime = Option.none<Runtime>();

    const deliver: Deliver = (inbound, settled) =>
      Effect.sync(() => {
        if ("record" in inbound) {
          pi.events.emit(RECORD_EVENT, {
            did: inbound.did,
            from: inbound.from,
            id: inbound.id,
            record: inbound.record,
            ...Option.match(inbound.replyTo, {
              onNone: () => ({}),
              onSome: (replyTo) => ({ replyTo }),
            }),
            verified: inbound.verified,
          });

          return;
        }

        pi.events.emit(MESSAGE_EVENT, inboundDetails(inbound, settled));

        if (injects(inbound, settled)) {
          pi.sendMessage(
            {
              content: renderInbound(tool, inbound),
              customType: "ratking_message",
              details: inboundDetails(inbound, settled),
              display: true,
            },
            { deliverAs: "followUp", triggerTurn: true }
          );
        }
      });

    let retired = false;

    const run = async <A>(
      effect: Effect.Effect<A, never, Services>,
      fallback: (reason: string) => A,
      signal?: AbortSignal
    ) => {
      if (Option.isNone(runtime)) {
        return fallback(
          retired
            ? "Rat King reader retired; a successor session holds this name"
            : "Rat King has not started"
        );
      }

      const exit = await runtime.value.runPromiseExit(
        effect,
        signal === undefined ? undefined : { signal }
      );

      return Exit.match(exit, {
        onFailure: (cause) =>
          fallback(
            Cause.hasInterruptsOnly(cause) ? "Cancelled" : notRunning(cause)
          ),
        onSuccess: (value) => value,
      });
    };

    const stop = async () => {
      const previous = runtime;

      runtime = Option.none();

      if (Option.isSome(previous)) {
        await Effect.runPromise(
          Effect.promise(async () => {
            await previous.value.dispose();
          }).pipe(
            Effect.timeoutOption(Duration.millis(RELEASE_WAIT_MS)),
            Effect.asVoid
          )
        );
      }
    };

    pi.registerTool({
      description: description(tool),
      execute: async (_id, params, signal) =>
        await run(
          Effect.gen(function* execute() {
            const decoded = yield* Schema.decodeEffect(ToolParams)(params);
            const settings = yield* Settings;

            return yield* runAction(tool, settings.askTimeoutMs, decoded);
          }).pipe(
            Effect.orElseSucceed((): ToolText => ({
              details: { error: true },
              isError: true,
              text: "Invalid Rat King tool parameters",
            })),
            Effect.map(toolResult)
          ),
          (reason) =>
            toolResult(notConfiguredText(new NotConfigured({ reason }))),
          signal
        ),
      label: "Rat King",
      name: tool,
      parameters,
      promptSnippet: promptSnippet(tool),
    });

    const forward = async (request: typeof SendRequest.Type) => {
      const outcome = await run(forwardSend(request), (reason) => ({
        code: "NotConfigured" as const,
        reason,
        requestId: request.requestId,
        status: "not-delivered" as const,
      }));

      pi.events.emit(SEND_RESULT_EVENT, outcome);
    };

    pi.events.on(SEND_EVENT, (data) => {
      const request = Schema.decodeUnknownOption(SendRequest)(data);

      if (Option.isSome(request)) {
        void forward(request.value);

        return;
      }

      const loose = Schema.decodeUnknownOption(
        Schema.Struct({ requestId: Schema.String })
      )(data);

      if (Option.isSome(loose)) {
        pi.events.emit(SEND_RESULT_EVENT, {
          code: "NotAttempted" as const,
          reason:
            "InvalidRequest: ratking/send needs requestId and exactly one of body or record ($type string), with optional to, replyTo, encrypt and kind message, ask or data",
          requestId: loose.value.requestId,
          status: "not-delivered" as const,
        });
      }
    });

    pi.events.on(STATUS_EVENT, (data) => {
      const request = Schema.decodeUnknownOption(
        Schema.Struct({ requestId: Schema.String })
      )(data);

      if (Option.isNone(request)) {
        return;
      }

      const status = async () => {
        const current = await run<ReaderStatus>(
          RatKing.use((ratking) => ratking.status).pipe(
            Effect.map((value) => ({
              did: value.self.pipe(
                Option.map((own) => own.did),
                Option.getOrNull
              ),
              name: value.self.pipe(
                Option.map((own) => own.name),
                Option.getOrNull
              ),
              ...Match.value(value.reader).pipe(
                Match.tag("Live", (reader) => ({
                  leaseGeneration: reader.generation,
                  leaseUntil: reader.expiresAt,
                  reader: "live" as const,
                })),
                Match.tag("Acquiring", () => ({
                  reader: "acquiring" as const,
                })),
                Match.tag("SendOnly", () => ({ reader: "send-only" as const })),
                Match.tag("Starting", "Minting", "Retrying", "Refused", () => ({
                  reader: "off" as const,
                })),
                Match.exhaustive
              ),
            }))
          ),
          () => ({
            did: null,
            name: null,
            reader: retired ? ("retired" as const) : ("off" as const),
          })
        );

        pi.events.emit(STATUS_RESULT_EVENT, {
          requestId: request.value.requestId,
          ...current,
        });
      };

      void status();
    });

    pi.events.on(RETIRE_EVENT, (data) => {
      const request = Schema.decodeUnknownOption(
        Schema.Struct({ requestId: Schema.optionalKey(Schema.String) })
      )(data ?? {});

      retired = true;

      const retire = async () => {
        await stop();

        pi.events.emit(RETIRE_RESULT_EVENT, {
          ...Option.getOrElse(request, () => ({})),
          status: "retired" as const,
        });
      };

      void retire();
    });

    pi.onSessionStart(async (start) => {
      retired = false;

      await stop();

      const facts = await Effect.runPromise(
        options.facts(start.session, start.sessionName, start.interactive)
      );

      const live: Runtime = ManagedRuntime.make(
        Layer.effectDiscard(
          RatKing.use((ratking) => ratking.run(facts, deliver))
        ).pipe(Layer.provideMerge(options.layer))
      );

      runtime = Option.some(live);

      const exit = await live.runPromiseExit(Effect.void);

      if (Exit.isFailure(exit)) {
        start.warn(`Rat King is off: ${notRunning(exit.cause)}`);
      }
    });

    pi.onSessionEnd(stop);
  };

const production = ratkingExtension({
  facts: collectFacts,
  layer: appLayer,
  tool: toolName.pipe(Effect.provide(NodeServices.layer)),
});

const extension: ExtensionFactory = async (pi) => {
  await production(piHost(pi));
};

export default extension;
