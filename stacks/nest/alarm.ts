import { DateTime, Effect, Option, Schema } from "effect";

import * as Defs from "../../packages/lexicon/src/defs.ts";
import { AlarmKey, AlarmState, alarmKeys } from "./alarm-config.ts";
import type {
  AlarmKeyValue,
  AlarmSettingsValue,
  AlarmStateValue,
} from "./alarm-config.ts";
import { advanceAlarm, emptyAlarm } from "./alarm-machine.ts";
import { SourceState, emptySources, observeAlarms } from "./alarm-sources.ts";
import type { AlarmFacts } from "./alarm-sources.ts";
import type { FleetError } from "./stage-config.ts";

export const Delivery = Schema.Struct({
  envelope: Defs.EncryptedEnvelope,
  key: AlarmKey,
  recipient: Schema.String,
});

const Notice = Schema.Struct({
  incident: Schema.Finite,
  key: AlarmKey,
  kind: Schema.Literals(["fire", "clear"]),
  recipients: Schema.Array(Schema.String),
  text: Schema.String,
});

export const AlarmJournal = Schema.Struct({
  alarms: Schema.Record(Schema.String, AlarmState),
  notices: Schema.Array(Notice),
  pages: Schema.Array(Schema.Struct({ at: Schema.Finite, key: AlarmKey })),
  pending: Schema.Array(Delivery),
  sources: SourceState,
  version: Schema.Literal(1),
});

export type AlarmJournalValue = typeof AlarmJournal.Type;

export const emptyJournal: AlarmJournalValue = {
  alarms: {},
  notices: [],
  pages: [],
  pending: [],
  sources: emptySources,
  version: 1,
};

export interface AlarmPorts<R> {
  readonly save: (
    state: AlarmJournalValue
  ) => Effect.Effect<void, FleetError, R>;
  readonly prepare: (
    key: AlarmKeyValue,
    recipients: readonly string[],
    text: string
  ) => Effect.Effect<readonly (typeof Delivery.Type)[], FleetError, R>;
  readonly send: (
    delivery: typeof Delivery.Type
  ) => Effect.Effect<void, FleetError, R>;
  readonly page: (text: string) => Effect.Effect<void, FleetError, R>;
  readonly unavailable: Effect.Effect<void, never, R>;
}

const summaries: Record<AlarmKeyValue, string> = {
  "celld.down": "Mailbox health is unavailable",
  "celld.restarted": "Unexplained process restart",
  "digest.fail": "Fleet digest failed",
  "filer.slots": "Storage free slots are low",
  "issuer.broken": "Identity configuration is broken",
  "quarantine.growth": "Quarantine is growing",
  "readers.stuck": "Desk readers are stuck",
  "ship.failed": "Candidate deployment failed",
};

export const alarmRecipients = (
  settings: AlarmSettingsValue,
  key: AlarmKeyValue
) => {
  const [owner] = Object.keys(settings.owners)
    .filter((prefix) => key === prefix || key.startsWith(`${prefix}.`))
    .toSorted((a, b) => b.length - a.length);

  const recipients = [settings.broadcast];

  if (key.startsWith("readers.") || key.startsWith("issuer.")) {
    recipients.push(settings.musterDesk);
  }

  if (owner !== undefined) {
    const target = settings.owners[owner];

    if (target !== undefined) {
      recipients.push(target);
    }
  }

  return [...new Set(recipients)];
};

export const mayPage = (
  pages: AlarmJournalValue["pages"],
  key: AlarmKeyValue,
  now: number
) =>
  pages.filter((page) => now - page.at < 86_400_000).length < 6 &&
  !pages.some((page) => page.key === key && now - page.at < 21_600_000);

export const alarmText = (
  key: AlarmKeyValue,
  state: AlarmStateValue,
  now: number,
  evidence: string,
  clear: boolean
) =>
  clear
    ? `✅ ${key} cleared after ${Math.max(0, Math.floor((now - state.context.since) / 1000))} seconds. SR 🐀`
    : `🚨 ${key} ${state.context.severity}: ${summaries[key]}. Evidence: ${evidence}. Since ${DateTime.formatIso(DateTime.makeUnsafe(state.context.since))}. SR 🐀`;

const withAlarmState = (
  journal: AlarmJournalValue,
  key: AlarmKeyValue,
  state: AlarmStateValue
): AlarmJournalValue => ({
  ...journal,
  alarms: { ...journal.alarms, [key]: state },
});

export const alarmCycle = Effect.fn("Alarm.cycle")(function* alarmCycle<R>(
  prior: AlarmJournalValue,
  facts: typeof AlarmFacts.Type,
  now: number,
  settings: AlarmSettingsValue,
  ports: AlarmPorts<R>
) {
  const observation = observeAlarms(prior.sources, facts, now);

  let current: AlarmJournalValue = {
    ...prior,
    pages: prior.pages.filter((page) => now - page.at < 86_400_000),
    sources: observation.sources,
  };

  yield* ports.save(current);

  for (const key of alarmKeys) {
    const reading = observation.readings[key];

    if (reading === undefined) {
      continue;
    }

    const before = current.alarms[key] ?? emptyAlarm;

    const next = advanceAlarm(
      before,
      reading,
      now,
      (settings.renotifyMinutes ?? 120) * 60_000
    );

    if (next.notice === "none") {
      current = withAlarmState(current, key, next.state);
      continue;
    }

    const text = alarmText(
      key,
      next.state,
      now,
      reading.status === "firing" ? reading.evidence : "",
      next.notice === "clear"
    );

    if (
      next.notice === "fire" &&
      next.state.context.severity === "critical" &&
      mayPage(current.pages, key, now)
    ) {
      current = { ...current, pages: [...current.pages, { at: now, key }] };
      yield* ports.save(current);
      yield* ports.page(text).pipe(Effect.catch(() => ports.unavailable));
    }

    const notice = {
      incident: next.state.context.since,
      key,
      kind: next.notice,
      recipients: alarmRecipients(settings, key),
      text,
    };

    const notices = current.notices.filter(
      (item) =>
        !(
          item.key === key &&
          item.kind === notice.kind &&
          item.incident === notice.incident
        )
    );

    current = {
      ...withAlarmState(current, key, next.state),
      notices: [...notices, notice],
    };
    yield* ports.save(current);
  }

  yield* ports.save(current);

  const preparing = new Set<AlarmKeyValue>();

  for (const notice of current.notices) {
    if (preparing.has(notice.key)) {
      continue;
    }

    const prepared = yield* ports
      .prepare(notice.key, notice.recipients, notice.text)
      .pipe(Effect.option);

    if (Option.isNone(prepared)) {
      preparing.add(notice.key);
      yield* ports.unavailable;
      continue;
    }

    current = {
      ...current,
      notices: current.notices.filter((item) => item !== notice),
      pending: [...current.pending, ...prepared.value],
    };
    yield* ports.save(current);
  }

  const blocked = new Set<string>();

  for (const delivery of current.pending) {
    if (blocked.has(delivery.recipient)) {
      continue;
    }

    const accepted = yield* ports.send(delivery).pipe(Effect.isSuccess);

    if (accepted) {
      current = {
        ...current,
        pending: current.pending.filter((item) => item !== delivery),
      };
      yield* ports.save(current);
    } else {
      blocked.add(delivery.recipient);
      yield* ports.unavailable;
    }
  }

  return current;
});
