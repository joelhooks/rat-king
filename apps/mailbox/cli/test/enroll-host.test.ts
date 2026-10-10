import { it } from "@effect/vitest";
import * as Enroll from "@rat-king/lexicon/identity.enrollHost";
import { Claims, unbase64url } from "@rat-king/mailbox-client";
import { Arbitrary, Effect, Predicate, Result, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { enrollHost } from "../enroll-host.ts";
import { SecretStore } from "../secrets.ts";
import { document, identity } from "./helpers.ts";
import { memorySecretStoreLayer } from "./secret-store.ts";

const Outcome = Schema.Literals([
  "ok",
  "Forbidden",
  "DocumentConflict",
  "MailboxUnavailable",
]);

const statusOf = (outcome: typeof Outcome.Type) =>
  ({ DocumentConflict: 409, Forbidden: 403, MailboxUnavailable: 503, ok: 200 })[
    outcome
  ];

it.effect.prop(
  "enroll-host sends only the host's public document to enrollHost as the operator and surfaces refusals",
  { outcome: Arbitrary.schema(Outcome) },
  ({ outcome }) =>
    Effect.gen(function* enrollment() {
      const operator = yield* identity("did:web:operator.example.invalid");
      const hostDid = "did:web:host.example.invalid";
      const hostDoc = yield* document(yield* identity(hostDid));
      const store = yield* SecretStore;
      yield* store.add("operator", JSON.stringify(operator));
      const seen: { url: string; token: string; body: string }[] = [];

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push({
            body: Predicate.isTagged(request.body, "Uint8Array")
              ? new TextDecoder().decode(request.body.body)
              : "",
            token: request.headers.authorization ?? "",
            url: request.url,
          });

          return HttpClientResponse.fromWeb(
            request,
            outcome === "ok"
              ? Response.json({ did: hostDid })
              : Response.json({ error: outcome }, { status: statusOf(outcome) })
          );
        })
      );

      const result = yield* enrollHost({
        did: hostDid,
        endpoint: "https://mailbox.example.invalid",
        json: JSON.stringify(hostDoc),
        operatorSecret: "operator",
        serviceDid: "did:web:service.example.invalid",
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.result
      );

      expect(Result.isSuccess(result)).toBe(outcome === "ok");

      if (Result.isSuccess(result)) {
        expect(result.success).toEqual({ did: hostDid });
      } else {
        expect(result.failure.reason).toContain(outcome);
      }

      const [call] = seen;

      expect(seen.length).toBe(1);
      expect(call?.url).toBe(
        `https://mailbox.example.invalid${Enroll.Method.path}`
      );
      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
          call?.body ?? ""
        )
      ).toEqual({ document: hostDoc });

      const [, payload = ""] = (call?.token ?? "").split(".");

      const claims = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Claims)
      )(new TextDecoder().decode(unbase64url(payload)));

      expect(claims.iss).toBe(operator.did);
      expect(claims.lxm).toBe(Enroll.Method.nsid);
    }).pipe(Effect.provide(memorySecretStoreLayer)),
  { arbitrary: { runs: 5 } }
);
