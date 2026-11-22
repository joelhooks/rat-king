import { Config, Console, Effect, Logger, Schema, Stdio, Stream } from "effect";
import { FetchHttpClient } from "effect/http";

import {
  SendOutcomes,
  SUMMARY_MAX,
} from "../../packages/mailbox-client/src/index.ts";
import {
  loadSettings,
  Settings,
} from "../../packages/ratking-client/src/config.ts";
import { directoryLayer } from "../../packages/ratking-client/src/directory.ts";
import { AgentName } from "../../packages/ratking-client/src/name.ts";
import { PayloadJson } from "../../packages/ratking-client/src/payload.ts";
import { secretStoreLayer } from "../../packages/ratking-client/src/secrets.ts";
import { secretSource } from "../../packages/ratking-client/src/systemd-credentials.ts";
import { prepareScript } from "./send.ts";
import { FleetError } from "./stage-config.ts";

const refused = () =>
  new FleetError({ reason: "Front desk delivery not confirmed" });

const Payload = Schema.Struct({
  body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(24_576)),
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  quiet: Schema.Boolean,
  summary: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SUMMARY_MAX)
  ),
});

export const readFrontDeskInput = Effect.fn("Nest.frontDeskInput")(
  function* readInput<E, R>(input: Stream.Stream<Uint8Array, E, R>) {
    const bytes = new Uint8Array(65_536);
    let used = 0;

    yield* Stream.runForEach(input, (chunk) =>
      Effect.gen(function* append() {
        if (used + chunk.byteLength > bytes.byteLength) {
          return yield* refused();
        }

        bytes.set(chunk, used);
        used += chunk.byteLength;

        return yield* Effect.void;
      })
    );

    const text = yield* Effect.try({
      catch: refused,
      try: () =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, used)
        ),
    });

    return yield* Schema.decodeEffect(Schema.fromJsonString(Payload))(text, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(refused));
  }
);

export const sendFrontDesk = Effect.fn("Nest.frontDeskSend")(
  function* frontDeskSend(payload: typeof Payload.Type) {
    const as = yield* Config.String("RAT_KING_FRONT_DESK_SIGNER");
    const to = yield* Config.schema(AgentName, "RAT_KING_FRONT_DESK_TO");
    const cc = yield* Config.schema(AgentName, "RAT_KING_FRONT_DESK_CC");

    const { client, from, primary, targets } = yield* prepareScript({
      as,
      cc: [cc],
      to,
    });

    const [, copy] = targets;

    if (
      copy === undefined ||
      !targets.every(({ did, document }) =>
        document.keyAgreement.includes(`${did}#encryption`)
      )
    ) {
      return yield* refused();
    }

    const body = yield* Schema.encodeEffect(PayloadJson)({
      body: payload.body,
      cc: [copy.name],
      from,
      kind: "message",
      summary: payload.summary,
      to: primary.name,
    });

    const envelope = yield* client.seal(primary.did, body, { encrypt: true });

    const receipt = yield* client.send(envelope, {
      cc: copy.did,
      wakeReason: payload.quiet ? "quiet" : "to",
      woke: !payload.quiet,
    });

    if (
      !SendOutcomes.$is("Accepted")(receipt) ||
      !SendOutcomes.$is("Accepted")(receipt.cc)
    ) {
      return yield* refused();
    }

    return { messageId: receipt.receipt.message.messageId, ok: true };
  },
  Effect.scoped
);

export const frontDeskCommand = (argv: readonly string[]) =>
  Effect.gen(function* relay() {
    if (argv.length !== 1 || argv[0] !== "--stdin") {
      return yield* new FleetError({
        reason: "Expected ops-front-desk-send --stdin",
      });
    }

    if ((yield* secretSource) !== "systemd") {
      return yield* refused();
    }

    const payload = yield* Stdio.Stdio.use((stdio) =>
      readFrontDeskInput(stdio.stdin)
    );

    const settings = yield* loadSettings();

    const receipt = yield* sendFrontDesk(payload).pipe(
      Effect.provide([directoryLayer, secretStoreLayer, FetchHttpClient.layer]),
      Effect.provideService(Settings, settings)
    );

    return yield* Console.log(JSON.stringify(receipt));
  }).pipe(
    Effect.provide(Logger.layer([])),
    Effect.timeout("12 seconds"),
    Effect.mapError(refused)
  );
