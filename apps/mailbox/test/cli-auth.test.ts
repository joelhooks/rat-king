import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { clientLayer } from "@rat-king/lexicon/mailbox-client";
import { Clock, Effect, FileSystem, Layer, Ref } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { transportLayer } from "../cli/client.ts";
import { readIdentity } from "../cli/identity.ts";
import { list } from "../cli/operations.ts";
import { provision } from "../cli/provision.ts";
import { authenticate, ReplayAuthority, staticResolver } from "../src/auth.ts";
import type { ClaimsValue } from "../src/auth.ts";

it.effect(
  "proof identity provisioning preserves keys, exports only public keys and mints a fresh JWT each call",
  () =>
    Effect.gen(function* cliAuth() {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const did = "did:web:agent.example";
      const document = yield* provision(home, "agent", did);
      expect(document).toBeDefined();
      const privateFile = `${home}/.config/rat-king/agents/agent.jwk`;
      const original = yield* fs.readFileString(privateFile);
      const again = yield* provision(home, "agent", did);
      expect(again).toEqual(document);
      expect(yield* fs.readFileString(privateFile)).toBe(original);
      expect(JSON.stringify(document)).not.toContain('"d":');
      expect((yield* fs.stat(privateFile)).mode % 512).toBe(0o600);
      const identity = yield* readIdentity(home, "agent");
      const claims = yield* Ref.make<readonly ClaimsValue[]>([]);
      const resolver = staticResolver(document === undefined ? [] : [document]);

      const replay = Layer.succeed(
        ReplayAuthority,
        ReplayAuthority.of({
          consume: (value) =>
            Ref.update(claims, (entries) => [...entries, value]),
        })
      );

      const http = HttpClient.make((request) =>
        Effect.gen(function* authenticateRequest() {
          expect(
            yield* authenticate({
              audience: "did:web:service.example",
              authorization: request.headers.authorization ?? null,
              now: yield* Clock.currentTimeMillis,
              nsid: "sh.mschf.ratking.mailbox.list",
            }).pipe(Effect.provide([resolver, replay]))
          ).toBe(did);

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ events: [], throughSeq: 0 })
          );
        }).pipe(Effect.orDie)
      );

      const client = clientLayer.pipe(
        Layer.provide(
          transportLayer(
            "http://worker.example",
            "did:web:service.example",
            identity
          ).pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, http)))
        )
      );

      yield* Effect.gen(function* requests() {
        expect((yield* list(identity)).events).toEqual([]);
        expect((yield* list(identity)).events).toEqual([]);
      }).pipe(Effect.provide(client));
      const observed = yield* Ref.get(claims);
      expect(observed).toHaveLength(2);
      expect(observed[0]?.jti).not.toBe(observed[1]?.jti);
      expect(observed[0]?.exp).toBe((observed[0]?.iat ?? 0) + 60);
    }).pipe(Effect.provide(NodeServices.layer))
);
