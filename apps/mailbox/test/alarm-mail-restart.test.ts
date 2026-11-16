import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import type { Path } from "effect";
import {
  HttpClient,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  prepareAlarmDeliveries,
  sendAlarmDelivery,
  withAlarmMailTransport,
} from "../../../stacks/nest/alarm-mail.ts";
import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";
import { SecretStore } from "../cli/secrets.ts";
import { runModel } from "./record-retired-model.ts";
import type { EffectCommand } from "./record-retired-model.ts";

it.effect.prop(
  "a pending sealed delivery survives dropped connections and uses a fresh transport and identity lease on the next cycle",
  {
    alarm: AlarmSettings,
    base: StageConfig,
    restarts: Schema.Int.check(Schema.isBetween({ maximum: 3, minimum: 1 })),
    ship: ShipSettings,
  },
  ({ alarm, base, restarts, ship }) =>
    Effect.gen(function* proof() {
      const operator = yield* identity("did:web:operator.invalid");
      const target = yield* identity("did:web:target.invalid");

      const entries = {
        operator: { did: operator.did, document: yield* document(operator) },
        target: { did: target.did, document: yield* document(target) },
      };

      let stopped = false;
      let accepted = 0;
      let leases = 0;
      const requests: unknown[] = [];
      const transports = new Set<HttpClient.HttpClient>();

      yield* HttpServer.serveEffect(
        Effect.gen(function* receive() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          requests.push(yield* request.json);

          if (stopped) {
            NodeHttpServerRequest.toIncomingMessage(request).socket.destroy();

            return HttpServerResponse.empty();
          }

          accepted += 1;

          return yield* HttpServerResponse.json({
            receipt: {
              message: { messageId: "2222222222222", senderDid: operator.did },
              recipientDid: target.did,
              seq: accepted,
              state: "accepted",
            },
          });
        }).pipe(Effect.orDie)
      );

      const url = new URL(
        yield* HttpServer.addressFormattedWith(Effect.succeed)
      );

      url.hostname = "127.0.0.1";

      const settings = {
        didTemplate: "did:web:fixture.invalid:{agent}",
        endpoint: url.origin,
        serviceDid: "did:web:service.invalid",
      };

      const config = {
        ...base,
        alarm: {
          ...alarm,
          notify: {
            ...alarm.notify,
            config: "/fixture.invalid/config.json",
            directory: "/fixture.invalid/directory.json",
          },
        },
        runtime: {
          ...base.runtime,
          HOME: "/fixture.invalid",
          RAT_KING_ENDPOINT: url.origin,
          RAT_KING_SERVICE_DID: settings.serviceDid,
        },
        ship,
      };

      yield* Effect.gen(function* cycles() {
        const pending = yield* prepareAlarmDeliveries(
          config,
          "digest.fail",
          ["target"],
          "Measurements unavailable: liveness"
        ).pipe(withAlarmMailTransport);

        const [delivery] = pending;
        expect(delivery).toBeDefined();

        if (delivery === undefined) {
          return;
        }

        const cycle = Effect.gen(function* cycle() {
          const transport = yield* HttpClient.HttpClient;
          expect(transports.has(transport)).toBe(false);
          transports.add(transport);

          return yield* sendAlarmDelivery(config, delivery).pipe(
            Effect.isSuccess
          );
        }).pipe(withAlarmMailTransport);

        const command = (
          down: boolean
        ): EffectCommand<
          { accepted: number },
          object,
          never,
          FileSystem.FileSystem | Path.Path | SecretStore
        > => ({
          check: () => true,
          run: (model) =>
            Effect.gen(function* step() {
              stopped = down;
              expect(yield* cycle).toBe(!down);
              model.accepted += down ? 0 : 1;
              expect(accepted).toBe(model.accepted);
            }),
          toString: () =>
            down ? "stop and drop connection" : "deliver after restart",
        });

        const commands = Array.from({ length: restarts }, () => [
          false,
          true,
          false,
        ])
          .flat()
          .map(command);

        yield* runModel(() => ({ model: { accepted: 0 }, real: {} }), commands);
        expect(requests).toHaveLength(restarts * 3);
        expect(
          requests.every(
            (request) => JSON.stringify(request) === JSON.stringify(requests[0])
          )
        ).toBe(true);
        expect(leases).toBe(1 + restarts * 3);
      }).pipe(
        Effect.provide(
          FileSystem.layerNoop({
            readFileString: (file) =>
              Effect.succeed(
                JSON.stringify(
                  file === "/fixture.invalid/directory.json"
                    ? entries
                    : settings
                )
              ),
          })
        ),
        Effect.provideService(
          SecretStore,
          SecretStore.of({
            add: () => Effect.void,
            exists: () => Effect.succeed(true),
            lease: () =>
              Effect.sync(() => {
                leases += 1;

                return JSON.stringify(operator);
              }),
          })
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  { arbitrary: { runs: 3 } }
);
