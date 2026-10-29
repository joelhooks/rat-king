import { Effect, Schema } from "effect";

import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import type { AlarmKeyValue } from "../../../stacks/nest/alarm-config.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import { alarmCycle } from "../../../stacks/nest/alarm.ts";
import type {
  AlarmJournalValue,
  AlarmPorts,
} from "../../../stacks/nest/alarm.ts";

export const settings = Schema.decodeUnknownSync(AlarmSettings)({
  broadcast: "observer-invalid",
  enabled: false,
  instances: [
    {
      name: "instance-a",
      owner: "owner-a",
      page: true,
      versionUrl: "https://instance-a.invalid/.well-known/rat-king/version",
    },
    {
      name: "instance-b",
      owner: "owner-b",
      versionUrl: "https://instance-b.invalid/.well-known/rat-king/version",
    },
  ],
  launchd: {
    errorLog: "/fixture.invalid/err",
    label: "alarm.invalid",
    node: "node",
    outputLog: "/fixture.invalid/out",
    path: "/fixture.invalid/bin",
    source: "/fixture.invalid",
  },
  musterDesk: "desk-invalid",
  notify: {
    directory: "/fixture.invalid/directory.json",
    secret: "operator.invalid",
  },
  owners: { celld: "mailbox-owner" },
  page: { node: "node", script: "/fixture.invalid/page.mjs" },
});

export const healthy: typeof AlarmFacts.Type = {
  cacheBreaches: [],
  deploy: null,
  deployKnown: true,
  digest: "ok",
  doctor: true,
  entered: null,
  health: 200,
  instances: [
    { name: "instance-a", page: true, status: "ok" },
    { name: "instance-b", status: "ok" },
  ],
  measurementFailed: false,
  quarantinedHour: 0,
  readers: null,
  receipts: [],
  receiptsKnown: true,
  slots: { free: 100, max: 100 },
};

export const down = (
  facts: typeof AlarmFacts.Type,
  names: readonly string[]
): typeof AlarmFacts.Type => ({
  ...facts,
  instances: (facts.instances ?? []).map((instance) =>
    names.includes(instance.name)
      ? { ...instance, reason: "transport error", status: "down" as const }
      : instance
  ),
});

export interface Sent {
  readonly key: AlarmKeyValue;
  readonly recipients: readonly string[];
  readonly text: string;
}

export const recorder = () => {
  const pages: string[] = [];
  const sent: Sent[] = [];

  const ports: AlarmPorts<never> = {
    page: (text) =>
      Effect.sync(() => {
        pages.push(text);
      }),
    prepare: (key, recipients, text) =>
      Effect.sync(() => {
        sent.push({ key, recipients, text });

        return [];
      }),
    save: () => Effect.void,
    send: () => Effect.void,
    unavailable: Effect.die("fixture ports are available"),
  };

  return { pages, ports, sent };
};

export const runTicks = Effect.fn("Fixture.runTicks")(function* runTicks(
  journal: AlarmJournalValue,
  ticks: readonly {
    readonly at: number;
    readonly facts: typeof AlarmFacts.Type;
  }[],
  ports: AlarmPorts<never>
) {
  let current = journal;

  for (const tick of ticks) {
    current = yield* alarmCycle(current, tick.facts, tick.at, settings, ports);
  }

  return current;
});

export const MINUTE = 60_000;
