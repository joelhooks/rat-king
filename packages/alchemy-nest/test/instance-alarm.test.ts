import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Match, Ref, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import { collectInstanceHealth } from "../../../stacks/nest/alarm-instances.ts";
import {
  emptySources,
  observeAlarms,
} from "../../../stacks/nest/alarm-sources.ts";
import type { AlarmFacts } from "../../../stacks/nest/alarm-sources.ts";
import {
  AlarmJournal,
  PAGE_ACK_WAIT_MS,
  alarmCycle,
  emptyJournal,
} from "../../../stacks/nest/alarm.ts";
import type { AlarmPorts } from "../../../stacks/nest/alarm.ts";

const settings = Schema.decodeUnknownSync(AlarmSettings)({
  broadcast: "observer-invalid",
  enabled: false,
  instances: [
    {
      name: "instance-a",
      owner: "owner-a",
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
  owners: { celld: "mailbox-owner", instance: "unrelated-owner" },
  page: { node: "node", script: "/fixture.invalid/page.mjs" },
});

const restart = (journal: typeof AlarmJournal.Type) =>
  Schema.encodeEffect(Schema.fromJsonString(AlarmJournal))(journal).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(AlarmJournal)))
  );

const healthy: typeof AlarmFacts.Type = {
  cacheBreaches: [],
  deploy: null,
  deployKnown: true,
  digest: "ok",
  doctor: true,
  entered: null,
  health: 200,
  measurementFailed: false,
  quarantinedHour: 0,
  readers: null,
  receipts: [],
  receiptsKnown: true,
  slots: { free: 100, max: 100 },
};

it.effect.prop(
  "configured HTTP version probes warn only, route only down owners and preserve mailbox critical paging",
  {
    commit: Schema.String,
    status: Schema.Int.check(Schema.isBetween({ maximum: 599, minimum: 201 })),
    version: Schema.String,
  },
  ({ commit, status, version }) =>
    Effect.gen(function* probes() {
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(AlarmSettings)
      )(settings);

      const decoded = yield* Schema.decodeEffect(
        Schema.fromJsonString(AlarmSettings)
      )(encoded);

      for (const mode of [
        "healthy",
        "status",
        "shape",
        "bootstrap",
        "transport",
        "both",
        "missing",
      ]) {
        const calls: string[] = [];

        const client = HttpClient.make((request) => {
          expect(request.method).toBe("GET");
          calls.push(request.url);

          const down =
            mode === "both" || request.url.includes("instance-a.invalid");

          if (down && mode === "transport") {
            return Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request }),
              })
            );
          }

          let body = JSON.stringify({ commit, version });

          if (down && mode === "shape") {
            body = JSON.stringify({ commit: 5, version: "example" });
          } else if (down && mode === "bootstrap") {
            body = "rat-king bootstrap";
          }

          const code =
            down && (mode === "status" || mode === "both") ? status : 200;

          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(code === 200 ? body : null, { status: code })
            )
          );
        });

        const instances = yield* collectInstanceHealth(
          mode === "missing" ? undefined : decoded.instances
        ).pipe(Effect.provideService(HttpClient.HttpClient, client));

        expect(calls.toSorted()).toEqual(
          mode === "missing"
            ? []
            : (decoded.instances ?? [])
                .map((instance) => instance.versionUrl)
                .toSorted()
        );

        const expectedDown = ["instance-a", "instance-b"].filter(
          (name) =>
            !["healthy", "missing"].includes(mode) &&
            (mode === "both" || name === "instance-a")
        );

        expect(
          instances
            .filter((instance) => instance.status === "down")
            .map((instance) => instance.name)
        ).toEqual(expectedDown);
        const facts = { ...healthy, instances };

        const reading = observeAlarms(emptySources, facts, 1000).readings[
          "instance.down"
        ];

        const recipients: {
          key: string;
          recipients: readonly string[];
          text: string;
        }[] = [];

        const pages: string[] = [];

        const ports: AlarmPorts<never> = {
          page: (text) =>
            Effect.sync(() => {
              pages.push(text);
            }),
          prepare: (key, targets, text) =>
            Effect.sync(() => {
              recipients.push({ key, recipients: targets, text });

              return [];
            }),
          save: () => Effect.void,
          send: () => Effect.die("empty test preparation sends nothing"),
          unavailable: Effect.die("test ports are available"),
        };

        yield* alarmCycle(emptyJournal, facts, 1000, decoded, ports);
        expect(pages).toEqual([]);

        if (expectedDown.length === 0) {
          expect(reading.status).toBe("ok");
          expect(recipients).toEqual([]);
        } else {
          expect(reading.status).toBe("firing");
          expect(recipients).toHaveLength(1);
          expect(recipients[0]?.recipients.toSorted()).toEqual(
            [
              "observer-invalid",
              ...expectedDown.map((name) =>
                name === "instance-a" ? "owner-a" : "owner-b"
              ),
            ].toSorted()
          );

          if (reading.status === "firing") {
            expect(reading.severity).toBe("warn");

            for (const name of expectedDown) {
              expect(reading.evidence).toContain(name);
            }

            expect(reading.evidence).toContain(
              Match.value(mode).pipe(
                Match.when("transport", () => "transport error"),
                Match.when("shape", () => "invalid version response"),
                Match.when("bootstrap", () => "invalid version response"),
                Match.orElse(() => `HTTP ${status}`)
              )
            );
            expect(reading.evidence).not.toContain("https://");
          }
        }

        recipients.length = 0;

        const first = yield* alarmCycle(
          emptyJournal,
          { ...facts, health: 503 },
          2000,
          decoded,
          ports
        );

        const confirmed = yield* alarmCycle(
          first,
          { ...facts, health: 503 },
          3000,
          decoded,
          ports
        );

        expect(pages).toEqual([]);

        yield* alarmCycle(
          confirmed,
          { ...facts, health: 503 },
          3000 + PAGE_ACK_WAIT_MS,
          decoded,
          ports
        );
        expect(pages).toHaveLength(1);
        expect(pages[0]).toContain(
          "celld.down critical: Mailbox health is unavailable"
        );

        const mailbox = recipients.find(
          (notice) => notice.key === "celld.down"
        );

        expect(mailbox?.recipients.toSorted()).toEqual([
          "mailbox-owner",
          "observer-invalid",
        ]);
      }
    })
);

it.effect.prop(
  "persisted instance fire recipients receive aggregate recovery, while mailbox clear routing stays unchanged",
  { renotify: Schema.Boolean },
  ({ renotify }) =>
    Effect.gen(function* recovery() {
      const notices: {
        key: string;
        recipients: readonly string[];
        text: string;
      }[] = [];

      const checkpoints: (typeof AlarmJournal.Type)[] = [];

      const ports: AlarmPorts<never> = {
        page: () => Effect.void,
        prepare: (key, recipients, text) =>
          Effect.sync(() => {
            notices.push({ key, recipients, text });

            return [];
          }),
        save: (journal) =>
          Effect.sync(() => {
            checkpoints.push(journal);
          }),
        send: () => Effect.die("empty test preparation sends nothing"),
        unavailable: Effect.die("test ports are available"),
      };

      const legacy = yield* restart(emptyJournal);
      expect(legacy.instanceRecipients).toBeUndefined();

      let journal = yield* alarmCycle(
        legacy,
        {
          ...healthy,
          instances: [
            { name: "instance-a", reason: "transport error", status: "down" },
          ],
        },
        1000,
        settings,
        ports
      );

      expect(notices.at(-1)?.recipients.toSorted()).toEqual([
        "observer-invalid",
        "owner-a",
      ]);
      journal = yield* restart(journal);
      expect(journal.instanceRecipients?.toSorted()).toEqual([
        "observer-invalid",
        "owner-a",
      ]);

      if (renotify) {
        journal = yield* alarmCycle(
          journal,
          {
            ...healthy,
            instances: [
              { name: "instance-b", reason: "HTTP 503", status: "down" },
            ],
          },
          7_201_000,
          settings,
          ports
        );
        expect(notices.at(-1)?.recipients.toSorted()).toEqual([
          "observer-invalid",
          "owner-b",
        ]);
        journal = yield* restart(journal);
        expect(journal.instanceRecipients?.toSorted()).toEqual([
          "observer-invalid",
          "owner-a",
          "owner-b",
        ]);
      }

      notices.length = 0;
      const changedSettings = { ...settings, instances: [] };
      journal = yield* alarmCycle(
        journal,
        healthy,
        7_202_000,
        changedSettings,
        ports
      );

      const expected = [
        "observer-invalid",
        "owner-a",
        ...(renotify ? ["owner-b"] : []),
      ];

      expect(notices).toHaveLength(1);
      expect(notices.map((notice) => notice.key)).toEqual(["instance.down"]);
      expect(notices[0]?.text).toContain("instance.down cleared");
      expect(notices[0]?.recipients.toSorted()).toEqual(expected);
      expect(journal.instanceRecipients).toEqual([]);

      const queuedClear = checkpoints.find((checkpoint) =>
        checkpoint.notices.some(
          (notice) => notice.key === "instance.down" && notice.kind === "clear"
        )
      );

      expect(
        queuedClear?.notices
          .find((notice) => notice.kind === "clear")
          ?.recipients.toSorted()
      ).toEqual(expected);
      expect(queuedClear?.instanceRecipients).toEqual([]);
      notices.length = 0;
      journal = yield* restart(journal);
      journal = yield* alarmCycle(
        journal,
        {
          ...healthy,
          instances: [
            { name: "instance-b", reason: "HTTP 503", status: "down" },
          ],
        },
        7_203_000,
        settings,
        ports
      );
      expect(notices.at(-1)?.recipients.toSorted()).toEqual([
        "observer-invalid",
        "owner-b",
      ]);
      expect(journal.instanceRecipients?.toSorted()).toEqual([
        "observer-invalid",
        "owner-b",
      ]);

      const mailboxFirst = yield* alarmCycle(
        journal,
        { ...healthy, health: 503 },
        7_204_000,
        settings,
        ports
      );

      const mailboxDown = yield* alarmCycle(
        mailboxFirst,
        { ...healthy, health: 503 },
        7_205_000,
        settings,
        ports
      );

      notices.length = 0;
      yield* alarmCycle(
        yield* restart(mailboxDown),
        healthy,
        7_206_000,
        settings,
        ports
      );
      expect(notices).toHaveLength(1);
      expect(notices.map((notice) => notice.key)).toEqual(["celld.down"]);
      expect(notices[0]?.text).toContain("celld.down cleared");
      expect(notices[0]?.recipients.toSorted()).toEqual([
        "mailbox-owner",
        "observer-invalid",
      ]);

      const baseline = yield* alarmCycle(
        emptyJournal,
        { ...healthy, entered: 1000 },
        1000,
        settings,
        ports
      );

      const restarted = yield* alarmCycle(
        baseline,
        { ...healthy, entered: 2000 },
        2000,
        settings,
        ports
      );

      expect(restarted.instanceRecipients).toBeUndefined();
      expect(notices.at(-1)?.key).toBe("celld.restarted");
      notices.length = 0;

      const stable = yield* alarmCycle(
        yield* restart(restarted),
        { ...healthy, entered: 2000 },
        3_602_000,
        settings,
        ports
      );

      expect(stable.instanceRecipients).toBeUndefined();
      expect(notices).toHaveLength(1);
      expect(notices[0]?.text).toContain("celld.restarted cleared");
      expect(notices[0]?.recipients.toSorted()).toEqual([
        "mailbox-owner",
        "observer-invalid",
      ]);
    })
);

it.effect.prop(
  "instance probe timeout cancels the request and records a warning reason",
  { name: Schema.NonEmptyString },
  ({ name }) =>
    Effect.gen(function* timeout() {
      const started = yield* Deferred.make<boolean>();
      const cancelled = yield* Ref.make(false);

      const client = HttpClient.make(() =>
        Deferred.succeed(started, true).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.set(cancelled, true))
        )
      );

      const fiber = yield* collectInstanceHealth([
        {
          name,
          owner: "owner-a",
          versionUrl: "https://timeout.invalid/version",
        },
      ]).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkScoped
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("31 seconds");
      const instances = yield* Fiber.join(fiber);
      expect(instances).toEqual([
        { name, reason: "probe timed out", status: "down" },
      ]);
      expect(yield* Ref.get(cancelled)).toBe(true);

      const reading = observeAlarms(
        emptySources,
        { ...healthy, instances },
        1000
      ).readings["instance.down"];

      expect(reading.status === "firing" && reading.severity).toBe("warn");
    })
);
