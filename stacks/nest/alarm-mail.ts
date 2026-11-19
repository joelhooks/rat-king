import { NodeHttpClient } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";

import * as Wake from "../../packages/lexicon/src/desk.wake.ts";
import { SendOutcomes } from "../../packages/mailbox-client/src/index.ts";
import { encodePayload } from "../../packages/ratking-client/src/payload.ts";
import type { AlarmKeyValue } from "./alarm-config.ts";
import type { PendingWake } from "./alarm-desk-wake.ts";
import { terminalRefusal } from "./alarm-refusal.ts";
import type { Delivery } from "./alarm.ts";
import { ShipSettings } from "./ship-config.ts";
import { prepareShipNotification } from "./ship-notify.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const withAlarmMailTransport = <A, E, R>(
  operation: Effect.Effect<A, E, R | HttpClient.HttpClient>
) =>
  operation.pipe(
    Effect.provide(NodeHttpClient.layerUndiciOptions()),
    Effect.scoped
  );

export const prepareAlarmMail = Effect.fn("Alarm.prepareMail")(
  function* prepareAlarmMail(
    config: StageConfigValue,
    names: readonly string[],
    text: string,
    skipUnknown?: boolean
  ) {
    if (config.alarm === undefined || config.ship === undefined) {
      return yield* new FleetError({
        reason: "Alarm notification configuration required",
      });
    }

    const ship = yield* Schema.decodeUnknownEffect(ShipSettings)({
      ...config.ship,
      notify: {
        ...config.alarm.notify,
        from: "operator",
        to: ["operator", ...new Set(names)],
      },
    }).pipe(
      Effect.mapError(
        () =>
          new FleetError({ reason: "Invalid alarm notification configuration" })
      )
    );

    const prepared = yield* prepareShipNotification(
      { ...config, ship },
      text,
      skipUnknown
    );

    if (
      prepared.targets.find((target) => target.name === "operator")?.did !==
      prepared.senderDid
    ) {
      return yield* new FleetError({
        reason: "Alarm signer is not the configured operator",
      });
    }

    return prepared;
  }
);

export const prepareAlarmDeliveries = Effect.fn("Alarm.prepareDeliveries")(
  function* prepareAlarmDeliveries(
    config: StageConfigValue,
    key: AlarmKeyValue,
    names: readonly string[],
    text: string
  ) {
    const prepared = yield* prepareAlarmMail(config, names, text, true);

    const resolved = names.filter((name) =>
      prepared.targets.some((item) => item.name === name)
    );

    if (resolved.length === 0) {
      return yield* new FleetError({
        reason: "Alarm recipient could not be resolved",
      });
    }

    const dropped = names.length - resolved.length;

    const body =
      dropped === 0
        ? prepared.body
        : yield* encodePayload({
            body: `${text} Evidence: ${dropped} retired or unknown recipient(s) dropped.`,
            from: "operator",
            kind: "message",
          }).pipe(
            Effect.mapError(
              () =>
                new FleetError({
                  reason: "Alarm notification payload invalid",
                })
            )
          );

    const deliveries: (typeof Delivery.Type)[] = [];

    for (const name of resolved) {
      const target = prepared.targets.find((item) => item.name === name);

      if (target === undefined) {
        continue;
      }

      deliveries.push({
        envelope: yield* prepared.client.seal(target.did, body, {
          encrypt: false,
        }),
        key,
        recipient: name,
        text,
      });
    }

    return deliveries;
  },
  Effect.scoped
);

export const sendAlarmDelivery = Effect.fn("Alarm.sendDelivery")(
  function* sendAlarmDelivery(
    config: StageConfigValue,
    delivery: typeof Delivery.Type
  ) {
    const prepared = yield* prepareAlarmMail(config, [delivery.recipient], "");
    const result = yield* prepared.client.send(delivery.envelope);

    if (SendOutcomes.$is("Rejected")(result)) {
      const refusal = terminalRefusal(result.error);

      if (refusal !== undefined) {
        return yield* refusal;
      }
    }

    if (!SendOutcomes.$is("Accepted")(result)) {
      return yield* new FleetError({
        reason: "Alarm message delivery not accepted",
      });
    }

    return yield* Effect.void;
  },
  Effect.scoped
);

const prepareDeskWake = Effect.fn("Alarm.prepareDeskWake")(
  function* prepareDeskWake(
    config: StageConfigValue,
    recipient: string,
    record: typeof Wake.Main.Encoded
  ) {
    const prepared = yield* prepareAlarmMail(config, [recipient], "");
    const target = prepared.targets.find((item) => item.name === recipient);

    if (target === undefined) {
      return yield* new FleetError({
        reason: "Desk waker could not be resolved",
      });
    }

    const typed = yield* Schema.decodeEffect(Wake.Main)(record);

    const body = yield* encodePayload({
      body: yield* Schema.encodeEffect(Schema.fromJsonString(Wake.Main))(typed),
      from: "operator",
      kind: "data",
      summary: `wake ${record.name} for ${record.messageId}`,
      to: recipient,
    });

    const envelope = yield* prepared.client.seal(target.did, body, {
      encrypt: false,
    });

    return { envelope, recipient };
  },
  Effect.scoped
);

const sendDeskWake = Effect.fn("Alarm.sendDeskWake")(function* sendDeskWake(
  config: StageConfigValue,
  delivery: PendingWake
) {
  const prepared = yield* prepareAlarmMail(config, [delivery.recipient], "");

  const result = yield* prepared.client.send(delivery.envelope, {
    wakeReason: "data",
    woke: false,
  });

  if (!SendOutcomes.$is("Accepted")(result)) {
    return yield* new FleetError({ reason: "Desk wake delivery not accepted" });
  }

  return yield* Effect.void;
}, Effect.scoped);

const withDeskWakeDeadline = <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  phase: "prepare" | "send"
) =>
  operation.pipe(
    Effect.mapError(
      () => new FleetError({ reason: `Desk wake ${phase} unavailable` })
    ),
    Effect.timeoutOrElse({
      duration: "8 seconds",
      orElse: () =>
        Effect.fail(new FleetError({ reason: `Desk wake ${phase} timed out` })),
    })
  );

export const deskWakeMail = (config: StageConfigValue) => ({
  prepare: (recipient: string, record: typeof Wake.Main.Encoded) =>
    withDeskWakeDeadline(prepareDeskWake(config, recipient, record), "prepare"),
  send: (delivery: PendingWake) =>
    withDeskWakeDeadline(sendDeskWake(config, delivery), "send"),
});

export { AlarmRefused, terminalRefusal } from "./alarm-refusal.ts";
