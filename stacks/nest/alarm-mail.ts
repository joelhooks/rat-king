import { Effect, Schema } from "effect";

import { SendOutcomes } from "../../packages/mailbox-client/src/index.ts";
import type { AlarmKeyValue } from "./alarm-config.ts";
import type { Delivery } from "./alarm.ts";
import { ShipSettings } from "./ship-config.ts";
import { prepareShipNotification } from "./ship-notify.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

export const prepareAlarmMail = Effect.fn("Alarm.prepareMail")(
  function* prepareAlarmMail(
    config: StageConfigValue,
    names: readonly string[],
    text: string
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

    const prepared = yield* prepareShipNotification({ ...config, ship }, text);

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
    const prepared = yield* prepareAlarmMail(config, names, text);
    const deliveries: (typeof Delivery.Type)[] = [];

    for (const name of names) {
      const target = prepared.targets.find((item) => item.name === name);

      if (target === undefined) {
        return yield* new FleetError({
          reason: "Alarm recipient could not be resolved",
        });
      }

      deliveries.push({
        envelope: yield* prepared.client.seal(target.did, prepared.body, {
          encrypt: false,
        }),
        key,
        recipient: name,
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

    if (!SendOutcomes.$is("Accepted")(result)) {
      return yield* new FleetError({
        reason: "Alarm message delivery not accepted",
      });
    }

    return yield* Effect.void;
  },
  Effect.scoped
);
