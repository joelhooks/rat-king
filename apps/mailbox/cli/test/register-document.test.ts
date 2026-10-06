import { it } from "@effect/vitest";
import { Arbitrary, Effect, Predicate, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import {
  publicRegistrationDocument,
  registerDocument,
} from "../register-document.ts";
import { SecretStore } from "../secrets.ts";
import { document, identity } from "./helpers.ts";
import { memorySecretStoreLayer } from "./secret-store.ts";

const Did = Schema.String.check(
  Schema.isPattern(/^did:web:[a-z]{1,12}\.example\.invalid$/u)
);

const PrivateField = Schema.Literals([
  "d",
  "privateKey",
  "private_key",
  "seed",
  "secret",
  "p",
  "q",
  "dp",
  "dq",
  "qi",
  "oth",
  "k",
]);

it.effect.prop(
  "register uses only the supplied public document, repeats safely, and refuses private material or mismatched identity before any request",
  { did: Arbitrary.schema(Did), privateField: Arbitrary.schema(PrivateField) },
  ({ did, privateField }) =>
    Effect.gen(function* registrationClaims() {
      const operator = yield* identity("did:web:operator.example.invalid");
      const operatorDoc = yield* document(operator);
      const phoneDoc = yield* document(yield* identity(did));
      const store = yield* SecretStore;
      yield* store.add("operator", JSON.stringify(operator));
      let requests = 0;

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (!Predicate.isTagged(request.body, "Uint8Array")) {
            throw new Error("Expected JSON request");
          }

          expect(
            JSON.parse(new TextDecoder().decode(request.body.body))
          ).toEqual({
            document: phoneDoc,
          });
          requests += 1;

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ did }, { status: 200 })
          );
        })
      );

      const input = {
        did,
        documents: [operatorDoc],
        endpoint: "https://mailbox.example.invalid",
        json: JSON.stringify(phoneDoc),
        operatorSecret: "operator",
        serviceDid: "did:web:service.example.invalid",
      };

      const first = yield* registerDocument(input).pipe(
        Effect.provideService(HttpClient.HttpClient, http)
      );

      const repeated = yield* registerDocument(input).pipe(
        Effect.provideService(HttpClient.HttpClient, http)
      );

      expect(repeated).toEqual(first);
      expect(requests).toBe(2);

      for (const json of [
        JSON.stringify({
          ...phoneDoc,
          nested: [{ [privateField]: "private" }],
        }),
        JSON.stringify({ ...phoneDoc, extra: "-----BEGIN PRIVATE KEY-----" }),
      ]) {
        const refused = yield* registerDocument({ ...input, json }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.result
        );

        expect(Result.isFailure(refused)).toBe(true);
      }

      const mismatch = yield* publicRegistrationDocument(
        `${did}:different`,
        input.json
      ).pipe(Effect.result);

      expect(Result.isFailure(mismatch)).toBe(true);
      expect(requests).toBe(2);
    }).pipe(Effect.provide(memorySecretStoreLayer)),
  { arbitrary: { runs: 5 } }
);
