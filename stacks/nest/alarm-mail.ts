import { Effect, Schema } from "effect";

import { SendOutcomes } from "../../packages/mailbox-client/src/index.ts";
import { encodePayload } from "../../packages/ratking-client/src/payload.ts";
import type { AlarmKeyValue } from "./alarm-config.ts";
import { terminalRefusal } from "./alarm-refusal.ts";
import type { Delivery } from "./alarm.ts";
import { ShipSettings } from "./ship-config.ts";
import { prepareShipNotification } from "./ship-notify.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

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

export { AlarmRefused, terminalRefusal } from "./alarm-refusal.ts";
