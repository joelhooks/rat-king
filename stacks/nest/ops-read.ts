import { Clock, Console, DateTime, Effect, Logger, Schema } from "effect";
import { FetchHttpClient } from "effect/http";

import { secretStoreLayer } from "../../apps/mailbox/cli/secrets.ts";
import type { MailboxHealthValue } from "../../packages/mailbox-client/src/health.ts";
import { AgentName } from "../../packages/ratking-client/src/name.ts";
import { prepareAlarmMail } from "./alarm-mail.ts";
import { collectComms, Counts } from "./comms.ts";
import type { CountsValue } from "./comms.ts";
import { Digest, MemoryMax, Status } from "./health.ts";
import type { HealthDigest, UnitState } from "./health.ts";
import { FleetError } from "./stage-config.ts";
import type { StageConfigValue } from "./stage-config.ts";

const OpsName = AgentName.check(
  Schema.isMaxLength(128),
  Schema.makeFilter((value) => !/\s/u.test(value))
);

const Count = Counts.fields.sent;

const Mailbox = Schema.Struct({
  status: Status,
  storage: Schema.Struct({ slots: Digest.fields.storage.fields.slots }),
});

const OpsDigest = Schema.Struct({
  at: Schema.DateTimeUtcFromString,
  comms: Schema.Struct({
    fallbacks_24h: Count,
    lost_24h: Count,
    quarantined_24h: Count,
    sent_24h: Count,
  }),
  issueCount: Count,
  mailbox: Mailbox,
  status: Status,
});

const OpsHealth = Schema.Struct({
  mailbox: Mailbox,
  name: OpsName,
  quietUnacked: Count,
  status: Schema.Literals(["ok", "unknown", "retired"]),
  undelivered: Schema.NullOr(Count),
});

const ServiceStatus = Schema.Literals([
  "active",
  "activating",
  "deactivating",
  "failed",
  "inactive",
  "maintenance",
  "refreshing",
  "reloading",
  "unknown",
]);

const Service = Schema.Struct({
  activeState: ServiceStatus,
  mainPidPresent: Schema.NullOr(Schema.Boolean),
  memoryMax: Schema.NullOr(MemoryMax),
  nRestarts: Count,
});

const MailboxOpsHealth = Schema.Struct({
  mailbox: Mailbox,
  name: Schema.Literal("mailbox"),
  services: Schema.Struct({
    celld: Schema.NullOr(Service),
    seaweedfs: Schema.NullOr(Service),
  }),
  status: Status,
});

const unavailable = () => new FleetError({ reason: "Ops reading unavailable" });

const unknownName = () => new FleetError({ reason: "Unknown ops health name" });

const boundedPrint = <S extends Schema.Codec<unknown, Schema.Json>>(
  schema: S,
  value: S["Type"]
) =>
  Effect.gen(function* print() {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(schema))(
      value,
      { onExcessProperty: "error" }
    );

    if (new TextEncoder().encode(json).byteLength > 2048) {
      return yield* unavailable();
    }

    return yield* Console.log(json);
  }).pipe(Effect.mapError(unavailable));

const opsMailbox = ({ status, storage }: HealthDigest): typeof Mailbox.Type => {
  const { slots } = storage;

  return {
    status,
    storage: {
      slots:
        slots === null
          ? null
          : { alarm: slots.alarm, free: slots.free, max: slots.max },
    },
  };
};

const digestStatus = (status: HealthDigest["status"], counts: CountsValue) => {
  if (status === "fail" || counts.lost > 0) {
    return "fail";
  }

  return counts.fallbacks > 0 || counts.quarantined > 0 ? "warn" : status;
};

export const projectOpsDigest = (
  health: HealthDigest,
  counts: CountsValue,
  now: number
): typeof OpsDigest.Type => ({
  at: DateTime.makeUnsafe(now),
  comms: {
    fallbacks_24h: counts.fallbacks,
    lost_24h: counts.lost,
    quarantined_24h: counts.quarantined,
    sent_24h: counts.sent,
  },
  issueCount: health.reasons.length,
  mailbox: opsMailbox(health),
  status: digestStatus(health.status, counts),
});

export const opsDigest = <E, R>(
  config: StageConfigValue,
  health: Effect.Effect<HealthDigest, E, R>
) =>
  Effect.gen(function* digestCommand() {
    const now = yield* Clock.currentTimeMillis;

    const results = yield* Effect.all(
      { counts: collectComms(config.comms.local, now - 86_400_000), health },
      { concurrency: "unbounded" }
    );

    return yield* boundedPrint(
      OpsDigest,
      projectOpsDigest(results.health, results.counts, now)
    );
  }).pipe(
    Effect.provide(Logger.layer([])),
    Effect.timeout("20 seconds"),
    Effect.mapError(unavailable)
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
): typeof OpsHealth.Type => ({
  mailbox: opsMailbox(health),
  name,
  quietUnacked: facts.quietUnacked,
  status: mailboxState(facts, now),
  undelivered: facts.undelivered ?? null,
});

const projectService = (
  unit: typeof UnitState.Type | null
): typeof Service.Type | null =>
  unit === null
    ? null
    : {
        activeState: Schema.is(ServiceStatus)(unit.activeState)
          ? unit.activeState
          : "unknown",
        mainPidPresent: unit.mainPidPresent ?? null,
        memoryMax: unit.memoryMax ?? null,
        nRestarts: unit.nRestarts,
      };

export const projectMailboxOpsHealth = (
  health: HealthDigest
): typeof MailboxOpsHealth.Type => ({
  mailbox: opsMailbox(health),
  name: "mailbox",
  services: {
    celld: projectService(health.services.celld),
    seaweedfs: projectService(health.services.seaweedfs),
  },
  status: health.status,
});

export const opsMailboxHealth = <E, R>(
  health: Effect.Effect<HealthDigest, E, R>
) =>
  health.pipe(
    Effect.flatMap((value) =>
      boundedPrint(MailboxOpsHealth, projectMailboxOpsHealth(value))
    ),
    Effect.provide(Logger.layer([])),
    Effect.timeout("20 seconds"),
    Effect.mapError(unavailable)
  );

export const readOpsName = Effect.fn("Nest.opsHealth.name")(function* readName(
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

  yield* client
    .refresh(target.did)
    .pipe(
      Effect.mapError((error) =>
        error.status === 404 ? unknownName() : unavailable()
      )
    );

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

    const facts = yield* readOpsName(config, name);
    const mailbox = yield* health.pipe(Effect.mapError(unavailable));

    return yield* boundedPrint(
      OpsHealth,
      projectOpsHealth(name, facts, mailbox, yield* Clock.currentTimeMillis)
    );
  }).pipe(
    Effect.provide([
      FetchHttpClient.layer,
      secretStoreLayer(),
      Logger.layer([]),
    ]),
    Effect.timeout("20 seconds"),
    Effect.catchTag("TimeoutError", () => Effect.fail(unavailable()))
  );
