import { Clock, Console, Effect, Logger, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import type { MailboxHealthValue } from "../../packages/mailbox-client/src/health.ts";
import { AgentName } from "../../packages/ratking-client/src/name.ts";
import { prepareAlarmMail } from "./alarm-mail.ts";
import { FleetDigest } from "./digest-config.ts";
import type { HealthDigest } from "./health.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const OpsName = AgentName.check(Schema.isMaxLength(128));

const unavailable = () => new FleetError({ reason: "Ops reading unavailable" });

const unknownName = () => new FleetError({ reason: "Unknown ops health name" });

export const projectOpsDigest = (digest: typeof FleetDigest.Type) => ({
  at: digest.at,
  comms: digest.comms,
  doctorUnavailableCount: digest.doctorUnavailableCount ?? 0,
  issueCount: digest.reasons.length,
  mailbox: {
    status: digest.rat_king.status,
    storage: {
      slots:
        "storage" in digest.rat_king ? digest.rat_king.storage.slots : null,
    },
  },
  status: digest.status,
  waitingMailCount: digest.waitingMail?.length ?? 0,
});

export const opsDigest = <E, R>(digest: Effect.Effect<string, E, R>) =>
  digest.pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FleetDigest))),
    Effect.map(projectOpsDigest),
    Effect.provide(Logger.layer([])),
    Effect.mapError(unavailable),
    Effect.flatMap((value) => Console.log(JSON.stringify(value)))
  );

const mailboxState = (facts: MailboxHealthValue, now: number) => {
  if (facts.retired === true) {
    return "retired";
  }

  return facts.complete && facts.lease !== null && facts.lease.expiresAt > now
    ? "ok"
    : "unknown";
};

export const projectOpsHealth = (
  name: string,
  facts: MailboxHealthValue,
  health: HealthDigest,
  now: number
) => ({
  mailbox: {
    status: health.status,
    storage: { slots: health.storage.slots },
  },
  name,
  quietUnacked: facts.quietUnacked,
  status: mailboxState(facts, now),
  undelivered: facts.undelivered ?? null,
});

const readName = Effect.fn("Nest.opsHealth.name")(function* readName(
  config: StageConfigValue,
  name: string
) {
  const { client, targets } = yield* prepareAlarmMail(
    config,
    [name],
    "",
    true
  ).pipe(Effect.mapError(unavailable));

  const target = targets.find((entry) => entry.name === name);

  if (target === undefined) {
    return yield* unknownName();
  }

  return yield* client
    .health(target.did, name)
    .pipe(Effect.mapError(unavailable));
}, Effect.scoped);

export const opsHealth = <E, R>(
  config: StageConfigValue,
  input: string,
  health: Effect.Effect<HealthDigest, E, R>
) =>
  Effect.gen(function* healthCommand() {
    const name = yield* Schema.decodeEffect(OpsName)(input).pipe(
      Effect.mapError(unknownName)
    );

    const facts = yield* readName(config, name);
    const mailbox = yield* health.pipe(Effect.mapError(unavailable));

    const value = projectOpsHealth(
      name,
      facts,
      mailbox,
      yield* Clock.currentTimeMillis
    );

    return yield* Console.log(JSON.stringify(value));
  }).pipe(
    Effect.provide([
      FetchHttpClient.layer,
      secretStoreLayer(),
      Logger.layer([]),
    ])
  );
