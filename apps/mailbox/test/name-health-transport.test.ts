import { NodeHttpServer } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Health from "@rat-king/lexicon/mailbox.nameHealth";
import { Clock, Effect, FileSystem, Schema } from "effect";
import {
  FetchHttpClient,
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
import { collectWakeHealth } from "../../../stacks/nest/alarm-wake-collector.ts";
import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";
import { SecretStore } from "../cli/secrets.ts";
import { authenticate, ReplayAuthority, staticResolver } from "../src/auth.ts";
import { nameHealth } from "../src/name-health.ts";
import { MailboxStore } from "../src/store.ts";
import { testStoreFor } from "./helpers.ts";

it.effect.prop(
  "alarm retirement observations cross real HTTP, service authentication and mailbox storage without a fleet scan",
  {
    alarm: AlarmSettings,
    base: StageConfig,
    legacy: Schema.Boolean,
    retired: Schema.Boolean,
    ship: ShipSettings,
  },
  ({ alarm, base, legacy, retired, ship }) =>
    Effect.gen(function* transportProof() {
      const operator = yield* identity("did:web:operator.invalid");
      const target = yield* identity("did:web:target.invalid");
      const operatorDocument = yield* document(operator);
      const targetDocument = yield* document(target);
      const storage = yield* testStoreFor(target.did);
      const store = yield* MailboxStore.pipe(Effect.provide(storage.layer));
      const replayed = new Set<string>();
      const requests: string[] = [];
      const resolver = staticResolver([operatorDocument]);

      const replay = ReplayAuthority.of({
        consume: (claims) =>
          Effect.sync(() => {
            expect(replayed.has(claims.jti)).toBe(false);
            replayed.add(claims.jti);
          }),
      });

      const setRetired = (value: boolean) =>
        store.transaction((tx) => {
          tx.setRetirement(
            value
              ? { by: operator.did, name: "target", retiredAt: 0 }
              : undefined
          );
        });

      yield* setRetired(retired);

      yield* HttpServer.serveEffect(
        Effect.gen(function* requestPath() {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const url = new URL(request.url, "http://fixture.invalid");
          requests.push(url.pathname);
          expect(request.method).toBe("GET");
          expect(yield* request.text).toBe("");
          expect(url.pathname).toBe(Health.Method.path);

          const caller = yield* authenticate({
            audience: "did:web:service.invalid#mailbox",
            authorization: request.headers.authorization ?? null,
            now: yield* Clock.currentTimeMillis,
            nsid: Health.Method.nsid,
          }).pipe(
            Effect.provide(resolver),
            Effect.provideService(ReplayAuthority, replay)
          );

          expect(caller).toBe(operator.did);

          const params = yield* Health.decodeParams([
            ...url.searchParams.entries(),
          ]);

          expect(params).toMatchObject({
            name: "target",
            recipientDid: target.did,
          });

          const result = yield* nameHealth(storage.sql, params, caller, [
            operator.did,
          ]);

          const encoded = yield* Schema.encodeEffect(Health.Output)(result);
          const { retired: flag, ...older } = encoded;
          expect(flag).toBe(requests.length === 1 ? retired : !retired);

          return yield* HttpServerResponse.json(legacy ? older : encoded);
        }).pipe(Effect.orDie)
      );

      const serverUrl = new URL(
        yield* HttpServer.addressFormattedWith(Effect.succeed)
      );

      serverUrl.hostname = "127.0.0.1";
      const endpoint = serverUrl.origin;

      const settings = {
        didTemplate: "did:web:fixture.invalid:{agent}",
        endpoint,
        serviceDid: "did:web:service.invalid",
      };

      const entries = {
        operator: { did: operator.did, document: operatorDocument },
        target: { did: target.did, document: targetDocument },
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
          wakeTargets: [{ name: "target", owner: "owner-invalid" }],
        },
        runtime: {
          ...base.runtime,
          HOME: "/fixture.invalid",
          RAT_KING_ENDPOINT: endpoint,
          RAT_KING_SERVICE_DID: settings.serviceDid,
        },
        ship,
      };

      const observe = collectWakeHealth(config).pipe(
        Effect.provide([
          FetchHttpClient.layer,
          FileSystem.layerNoop({
            readFileString: (file) =>
              Effect.succeed(
                JSON.stringify(
                  file === "/fixture.invalid/directory.json"
                    ? entries
                    : settings
                )
              ),
          }),
        ]),
        Effect.provideService(
          SecretStore,
          SecretStore.of({
            add: () => Effect.void,
            exists: () => Effect.succeed(true),
            lease: () => Effect.succeed(JSON.stringify(operator)),
          })
        )
      );

      const first = yield* observe;
      expect(first).toHaveLength(1);
      expect(first?.[0]?.retired).toBe(legacy ? null : retired);
      yield* setRetired(!retired);
      const second = yield* observe;
      expect(second?.[0]?.retired).toBe(legacy ? null : !retired);
      expect(requests).toEqual([Health.Method.path, Health.Method.path]);
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest))
);
