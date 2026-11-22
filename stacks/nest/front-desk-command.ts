import {
  Clock,
  Config,
  Console,
  Effect,
  Logger,
  Schema,
  Stdio,
  Stream,
} from "effect";

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
import {
  CredentialSlot,
  secretSource,
} from "../../packages/ratking-client/src/systemd-credentials.ts";
import {
  frontDeskJournalHealth,
  frontDeskRefused as refused,
  frontDeskReviewReason,
  withFrontDeskJournal,
} from "./front-desk-journal.ts";
import { prepareScript } from "./send.ts";
import { FleetError } from "./stage-config.ts";

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

const prepareDelivery = Effect.fn("Nest.prepareFrontDeskDelivery")(
  function* prepareDelivery() {
    const as = yield* Config.schema(
      CredentialSlot,
      "RAT_KING_FRONT_DESK_SIGNER"
    );

    const to = yield* Config.schema(AgentName, "RAT_KING_FRONT_DESK_TO");
    const cc = yield* Config.schema(AgentName, "RAT_KING_FRONT_DESK_CC");

    const prepared = yield* prepareScript({ as, cc: [cc], to });
    const [, copy] = prepared.targets;

    if (
      copy === undefined ||
      !prepared.targets.every(({ did, document }) =>
        document.keyAgreement.includes(`${did}#encryption`)
      )
    ) {
      return yield* refused();
    }

    return { ...prepared, copy };
  }
);

type Delivery = Effect.Success<ReturnType<typeof prepareDelivery>>;

const sealDelivery = Effect.fn("Nest.sealFrontDeskDelivery")(
  function* sealDelivery(
    { client, copy, from, primary }: Delivery,
    payload: typeof Payload.Type,
    hash: string
  ) {
    const body = yield* Schema.encodeEffect(PayloadJson)({
      body: payload.body,
      cc: [copy.name],
      from,
      kind: "message",
      summary: payload.summary,
      to: primary.name,
    });

    const sealed = yield* client.seal(primary.did, body, { encrypt: true });
    const carbon = yield* client.sealCopy(sealed, copy.did);

    return { copy: carbon, hash, primary: sealed, step: "prepared" as const };
  }
);

const requireReceipt = (
  envelope: Parameters<Delivery["client"]["send"]>[0],
  sent: Effect.Success<ReturnType<Delivery["client"]["send"]>>
) =>
  SendOutcomes.$is("Accepted")(sent) &&
  sent.receipt.message.messageId === envelope.aad.messageId &&
  sent.receipt.message.senderDid === envelope.aad.senderDid &&
  sent.receipt.recipientDid === envelope.aad.recipientDid
    ? Effect.void
    : Effect.fail(refused());

export const sendFrontDesk = Effect.fn("Nest.frontDeskSend")(
  function* frontDeskSend(payload: typeof Payload.Type) {
    const settings = yield* Settings;

    return yield* withFrontDeskJournal(
      settings.state,
      payload.id,
      ({ read, sign, write }) =>
        Effect.gen(function* deliver() {
          const hash = yield* sign(
            JSON.stringify([
              payload.id,
              payload.summary,
              payload.body,
              payload.quiet,
            ])
          );

          const prior = yield* read;

          if (prior !== null && prior.hash !== hash) {
            return yield* new FleetError({ reason: frontDeskReviewReason });
          }

          if (prior?.step === "done") {
            return { messageId: prior.messageId, ok: true };
          }

          const delivery = yield* prepareDelivery();

          const row = prior ?? (yield* sealDelivery(delivery, payload, hash));

          if (
            row.primary.aad.recipientDid !== delivery.primary.did ||
            row.copy.aad.recipientDid !== delivery.copy.did
          ) {
            return yield* refused();
          }

          if (prior === null) {
            yield* write(row);
          }

          if (row.step === "prepared") {
            const sent = yield* delivery.client.send(row.primary, {
              wakeReason: payload.quiet ? "quiet" : "to",
              woke: !payload.quiet,
            });

            yield* requireReceipt(row.primary, sent);
            yield* write({ ...row, step: "primary-accepted" });
          }

          const copied = yield* delivery.client.send(row.copy, {
            wakeReason: "cc",
            woke: false,
          });

          yield* requireReceipt(row.copy, copied);

          const { messageId } = row.primary.aad;
          yield* write({
            completedAt: yield* Clock.currentTimeMillis,
            hash,
            messageId,
            step: "done",
          });

          return { messageId, ok: true };
        }).pipe(Effect.scoped)
    );
  }
);

const publicError = (error: { readonly _tag: string }) =>
  Schema.is(FleetError)(error) ? error : refused();

export const frontDeskServiceHealth = Effect.gen(
  function* readFrontDeskHealth() {
    if ((yield* secretSource) !== "systemd") {
      return yield* refused();
    }

    const { state } = yield* loadSettings();
    const result = yield* frontDeskJournalHealth(state);

    return yield* Console.log(
      JSON.stringify({ ...result, service: "front-desk" })
    );
  }
).pipe(Effect.timeout("5 seconds"), Effect.mapError(publicError));

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
      Effect.provide([directoryLayer, secretStoreLayer]),
      Effect.provideService(Settings, settings)
    );

    return yield* Console.log(JSON.stringify(receipt));
  }).pipe(
    Effect.provide(Logger.layer([])),
    Effect.timeout("12 seconds"),
    Effect.mapError(publicError)
  );
