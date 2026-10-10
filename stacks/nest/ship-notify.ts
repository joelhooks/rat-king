import { ConfigProvider, Effect, Schema } from "effect";

import { CliError } from "../../apps/mailbox/cli/identity.ts";
import { SecretStore } from "../../apps/mailbox/cli/secrets.ts";
import {
  Identity,
  MailboxClientError,
  ownIdentity,
  prepare,
  SendOutcomes,
} from "../../packages/mailbox-client/src/index.ts";
import {
  loadSettings,
  NotConfigured,
  Settings,
} from "../../packages/pi-ratking/src/config.ts";
import {
  Directory,
  directoryLayer,
  UnknownName,
} from "../../packages/pi-ratking/src/directory.ts";
import { encodePayload } from "../../packages/pi-ratking/src/payload.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const Tagged = Schema.Struct({ _tag: Schema.String });

const redact = (reason: string) =>
  reason
    .replaceAll(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
    .replaceAll(/[\r\n]/gu, " ")
    .slice(0, 240);

interface TaggedFailure {
  readonly _tag: string;
}

export const notificationDiagnostic = (failure: TaggedFailure) => {
  const tag = Schema.is(Tagged)(failure)
    ? redact(failure._tag)
    : "UnknownError";

  if (
    Schema.is(CliError)(failure) ||
    Schema.is(MailboxClientError)(failure) ||
    Schema.is(UnknownName)(failure) ||
    Schema.is(NotConfigured)(failure)
  ) {
    return `${tag}: ${redact(failure.reason)}`;
  }

  return `${tag}: boundary or transport failed; input values withheld`;
};

const step = <A, E extends TaggedFailure, R>(
  phase: string,
  effect: Effect.Effect<A, E, R>
) =>
  effect.pipe(
    Effect.mapError(
      (failure) =>
        new FleetError({
          reason: `Ship notification ${phase}: ${notificationDiagnostic(failure)}`,
        })
    )
  );

export const prepareShipNotification = Effect.fn("Ship.prepareNotification")(
  function* prepareShipNotification(config: StageConfigValue, text: string) {
    const { ship } = config;

    if (ship === undefined) {
      return yield* new FleetError({
        reason: "Ship notification config missing",
      });
    }

    const settings = yield* step(
      "settings",
      loadSettings().pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              HOME: config.runtime.HOME,
              RATKING_CONFIG: ship.notify.config,
            })
          )
        )
      )
    );

    const targets = yield* step(
      "resolve",
      Effect.gen(function* resolveTargets() {
        const directory = yield* Directory;

        return yield* Effect.all(
          ship.notify.to.map((name) => directory.resolve(name))
        );
      }).pipe(
        Effect.provide(directoryLayer),
        Effect.provideService(Settings, {
          ...settings,
          directory: ship.notify.directory,
        })
      )
    );

    const store = yield* SecretStore;
    const secret = yield* step("lease", store.lease(ship.notify.secret));

    const identity = yield* step(
      "identity-json",
      Schema.decodeEffect(Schema.fromJsonString(Identity))(secret)
    );

    const own = yield* step("ownIdentity", ownIdentity(identity));

    const client = yield* step(
      "prepare",
      prepare({
        endpoint: config.runtime.RAT_KING_ENDPOINT,
        own,
        peers: targets.map((target) => target.document),
        serviceDid: config.runtime.RAT_KING_SERVICE_DID,
      })
    );

    const body = yield* step(
      "payload",
      encodePayload({ body: text, from: ship.notify.from, kind: "message" })
    );

    return { body, client, senderDid: identity.did, targets };
  }
);

export const shipRecipients = (
  notify: {
    readonly to: readonly string[];
    readonly quiet?: readonly string[];
  },
  routine: boolean
): readonly string[] =>
  notify.to.filter((name) => !(routine && (notify.quiet ?? []).includes(name)));

export const sendShipNotification = Effect.fn("Ship.notify")(
  function* sendShipNotification(
    config: StageConfigValue,
    text: string,
    routine: boolean
  ) {
    const { body, client, targets } = yield* prepareShipNotification(
      config,
      text
    );

    const wanted = new Set(
      config.ship === undefined
        ? []
        : shipRecipients(config.ship.notify, routine)
    );

    const recipients = targets.filter((_target, index) =>
      wanted.has(config.ship?.notify.to[index] ?? "")
    );

    for (const target of recipients) {
      const envelope = yield* step(
        `seal ${target.name}`,
        client.seal(target.did, body, { encrypt: false })
      );

      const outcome = yield* client.send(envelope);

      if (!SendOutcomes.$is("Accepted")(outcome)) {
        const detail = SendOutcomes.$match(outcome, {
          Accepted: () => "Accepted",
          NotAttempted: (value) => redact(value.reason),
          Rejected: (value) => notificationDiagnostic(value.error),
          Uncertain: (value) => notificationDiagnostic(value.error),
        });

        return yield* new FleetError({
          reason: `Ship notification send ${target.name} ${outcome._tag}: ${detail}`,
        });
      }
    }

    return yield* Effect.void;
  },
  Effect.scoped,
  (effect) =>
    effect.pipe(
      Effect.timeout("30 seconds"),
      Effect.mapError((failure) =>
        Schema.is(FleetError)(failure)
          ? failure
          : new FleetError({
              reason: `Ship notification timeout: ${notificationDiagnostic(failure)}`,
            })
      )
    )
);
