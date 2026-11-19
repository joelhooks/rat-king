import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  collectDeskWakeHealth,
  collectWakeHealth,
} from "../../../stacks/nest/alarm-wake-collector.ts";
import {
  DEFAULT_WAKE_UNACKED_MINUTES,
  wakeReading,
} from "../../../stacks/nest/alarm-wakes.ts";
import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import { prepareShipNotification } from "../../../stacks/nest/ship-notify.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";
import { SecretStore } from "../cli/secrets.ts";

it.effect.prop(
  "an unknown heartbeat costs only that name; configured backlog still fires and unresolved configured targets stay unknown",
  [
    StageConfig,
    ShipSettings,
    AlarmSettings,
    Schema.Int.check(
      Schema.isBetween({ maximum: 1_000_000, minimum: 901_000 })
    ),
  ],
  ([base, ship, alarm, now]) =>
    Effect.gen(function* proof() {
      const operator = yield* identity("did:web:operator.invalid");
      const target = yield* identity("did:web:target.invalid");

      const entries = {
        operator: { did: operator.did, document: yield* document(operator) },
        target: { did: target.did, document: yield* document(target) },
      };

      const settings = {
        didTemplate: "did:web:fixture.invalid:{agent}",
        endpoint: "https://mailbox.invalid",
        serviceDid: "did:web:service.invalid",
      };

      const fs = FileSystem.layerNoop({
        readFileString: (file) =>
          Effect.succeed(
            JSON.stringify(
              file === "/fixture.invalid/directory.json" ? entries : settings
            )
          ),
      });

      const requests: string[] = [];

      const http = HttpClient.make((request) => {
        requests.push(request.url);

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              complete: true,
              oldestWake: {
                id: "2222222222222",
                recordedAt: "1970-01-01T00:00:00.000Z",
                sender: operator.did,
                woke: true,
              },
              oldestWakeSinceAck: {
                id: "2222222222222",
                recordedAt: "1970-01-01T00:00:00.000Z",
                sender: operator.did,
                seq: 12,
                woke: true,
              },
              quietUnacked: 0,
              wakesSinceAck: 1,
            })
          )
        );
      });

      const config = {
        ...base,
        alarm: {
          ...alarm,
          notify: {
            ...alarm.notify,
            config: "/fixture.invalid/config.json",
            directory: "/fixture.invalid/directory.json",
          },
          wakeTargets: [
            { name: "target", owner: "owner" },
            { name: "unknown-configured", owner: "owner" },
          ],
          wakeUnackedMinutes: DEFAULT_WAKE_UNACKED_MINUTES,
        },
        runtime: {
          ...base.runtime,
          HOME: "/fixture.invalid",
          RAT_KING_ENDPOINT: settings.endpoint,
          RAT_KING_SERVICE_DID: settings.serviceDid,
        },
        ship,
      };

      yield* Effect.gen(function* observe() {
        const sightings = yield* collectWakeHealth(config, [
          { name: "unknown-heartbeat", owner: null },
        ]);

        expect(sightings).not.toBeNull();
        expect(
          sightings?.find((entry) => entry.name === "unknown-configured")
            ?.health
        ).toBeNull();
        expect(
          sightings?.find((entry) => entry.name === "unknown-heartbeat")?.health
        ).toBeNull();

        const reading = wakeReading(sightings ?? [], now);

        expect(reading.status).toBe("firing");
        expect(requests).toHaveLength(1);
        expect(
          requests.every((url) => url.includes("mailbox.nameHealth"))
        ).toBe(true);

        if (reading.status === "firing") {
          expect(reading.evidence).toContain("target");
          expect(reading.recipients).toContain("owner");
        }

        const unresolved = yield* collectWakeHealth({
          ...config,
          alarm: {
            ...config.alarm,
            wakeTargets: [{ name: "unknown-configured", owner: "owner" }],
          },
        });

        expect(unresolved).toHaveLength(1);
        expect(wakeReading(unresolved ?? [], now).status).toBe("unknown");
        expect(requests).toHaveLength(1);
        expect(
          yield* prepareShipNotification(
            {
              ...config,
              ship: {
                ...ship,
                notify: {
                  ...ship.notify,
                  config: "/fixture.invalid/config.json",
                  directory: "/fixture.invalid/directory.json",
                  to: ["unknown-configured"],
                },
              },
            },
            ""
          ).pipe(Effect.scoped, Effect.isFailure)
        ).toBe(true);

        const optedIn = {
          ...config,
          alarm: {
            ...config.alarm,
            wakeOnMail: [{ name: "target" }],
            wakeTargets: [],
          },
        };

        expect(yield* collectWakeHealth(optedIn)).toBeNull();

        const desk = yield* collectDeskWakeHealth({
          ...optedIn,
          alarm: {
            ...optedIn.alarm,
            wakeTargets: [{ name: "operator", owner: "owner" }],
          },
        });

        expect(desk).toMatchObject([
          {
            health: { oldestWakeSinceAck: { seq: 12 } },
            name: "target",
          },
        ]);
        expect(requests).toHaveLength(2);
      }).pipe(
        Effect.provide(fs),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(
          SecretStore,
          SecretStore.of({
            add: () => Effect.void,
            exists: () => Effect.succeed(true),
            lease: () => Effect.succeed(JSON.stringify(operator)),
          })
        ),
        Effect.provide(NodeServices.layer)
      );
    }),
  { arbitrary: { runs: 10 } }
);
