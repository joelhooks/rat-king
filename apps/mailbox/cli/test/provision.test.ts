import { it } from "@effect/vitest";
import { Identity } from "@rat-king/mailbox-client";
import { Arbitrary, Effect, Predicate, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { CliError } from "../identity.ts";
import { provisionAgent } from "../register.ts";
import { SecretStore } from "../secrets.ts";
import { identity, document } from "./helpers.ts";
import {
  isolatedSecretStoreLayer,
  memorySecretStoreLayer,
  secretsBinaryAbsentFromPath,
} from "./secret-store.ts";

const Agent = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,15}$/u));

const Did = Schema.String.check(
  Schema.isPattern(/^did:web:[a-z]{1,12}\.example\.invalid$/u)
);

const provisioningClaims = (agent: string, did: string) =>
  Effect.gen(function* claims() {
    const operator = yield* identity("did:web:operator.example.invalid");
    const operatorDoc = yield* document(operator);
    const store = yield* SecretStore;
    expect(yield* store.exists("operator")).toBe(false);
    const missing = yield* store.lease("operator").pipe(Effect.result);
    expect(Result.isFailure(missing)).toBe(true);

    if (Result.isFailure(missing)) {
      expect(missing.failure).toBeInstanceOf(CliError);
    }

    const operatorValue = JSON.stringify(operator);
    yield* store.add("operator", operatorValue);
    expect(yield* store.exists("operator")).toBe(true);

    const duplicate = yield* store
      .add("operator", "replacement")
      .pipe(Effect.result);

    expect(Result.isFailure(duplicate)).toBe(true);

    if (Result.isFailure(duplicate)) {
      expect(duplicate.failure).toBeInstanceOf(CliError);
    }

    expect(yield* store.lease("operator")).toBe(operatorValue);
    let registered = "";
    let conflict = false;

    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (!Predicate.isTagged(request.body, "Uint8Array")) {
          throw new Error("Expected JSON request");
        }

        const body = new TextDecoder().decode(request.body.body);

        if (conflict || (registered !== "" && body !== registered)) {
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "DocumentConflict" }, { status: 409 })
          );
        }

        registered = body;

        return HttpClientResponse.fromWeb(
          request,
          Response.json({ did }, { status: 200 })
        );
      })
    );

    const input = {
      agent,
      did,
      documents: [operatorDoc],
      endpoint: "https://mailbox.example.invalid",
      operatorSecret: "operator",
      serviceDid: "did:web:service.example",
    };

    const first = yield* provisionAgent(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http)
    );

    const original = yield* store.lease(first.secret);
    const originalRegistration = registered;

    const second = yield* provisionAgent(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http)
    );

    expect(second).toEqual(first);
    conflict = true;

    const conflicted = yield* provisionAgent(input).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.result
    );

    expect(Result.isFailure(conflicted)).toBe(true);

    if (Result.isFailure(conflicted)) {
      expect(conflicted.failure).toMatchObject({
        error: "DocumentConflict",
        status: 409,
      });
    }

    conflict = false;
    expect(yield* store.lease(first.secret)).toBe(original);

    const refused = yield* provisionAgent({
      ...input,
      did: `${did}:different`,
    }).pipe(Effect.provideService(HttpClient.HttpClient, http), Effect.result);

    expect(Result.isFailure(refused)).toBe(true);

    if (Result.isFailure(refused)) {
      expect(refused.failure).toBeInstanceOf(CliError);
      expect(refused.failure).toMatchObject({
        reason: "Existing secret has a different DID; never replacing keys",
      });
    }

    expect(yield* store.lease(first.secret)).toBe(original);
    expect(registered).toBe(originalRegistration);
    expect(JSON.stringify(first)).not.toContain('"d":');
    expect(JSON.stringify(first)).not.toContain("privateKey");
    expect(Schema.is(Identity)(JSON.parse(original))).toBe(true);
  });

it.effect.prop(
  "provision reuses both keys, refuses DID changes without mutation, and emits only public JWKs",
  { agent: Arbitrary.schema(Agent), did: Arbitrary.schema(Did) },
  ({ agent, did }) =>
    provisioningClaims(agent, did).pipe(Effect.provide(memorySecretStoreLayer)),
  { arbitrary: { runs: 5 } }
);

it.live.skipIf(secretsBinaryAbsentFromPath)(
  "live secrets CLI: isolated store preserves provisioning and create-only semantics (requires secrets on PATH)",
  () =>
    Effect.gen(function* liveProvisioning() {
      const storeLayer = yield* isolatedSecretStoreLayer;
      yield* provisioningClaims("a", "did:web:a.example.invalid").pipe(
        Effect.provide(storeLayer)
      );
    }).pipe(Effect.scoped)
);
