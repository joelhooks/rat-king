import { Schema } from "effect";

export const AlarmStep = Schema.Literals([
  "journal.read",
  "journal.write",
  "facts.collect",
  "maintenance.inbox",
  "maintenance.notices",
  "notifications.prepare",
  "notifications.send",
  "notifications.page",
  "cycle",
]);

const ErrorTag = Schema.Literals([
  "FleetError",
  "PlatformError",
  "SystemError",
  "BadArgument",
  "SchemaError",
  "TimeoutError",
  "UnknownError",
]);

export const TaggedFailure = Schema.Struct({ _tag: ErrorTag });

export const StepOutcome = Schema.TemplateLiteral([
  "Alarm step ",
  AlarmStep,
  " failed (",
  ErrorTag,
  ")",
]);

export const Outcome = Schema.Union([
  StepOutcome,
  Schema.Literals([
    "ok",
    "Alarm measurements unavailable",
    "Alarm cycle timed out",
    "Alarm journal unavailable",
    "Alarm notifications unavailable",
    "Alarm operation unavailable",
  ]),
]);

export const AlarmHeartbeat = Schema.Struct({
  at: Schema.Finite,
  consecutiveFailures: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Outcome,
});
