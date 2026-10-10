/* oxlint-disable promise/prefer-await-to-callbacks -- Effect HttpClient test adapter. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  Arbitrary,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Settings } from "../src/config.ts";
import { Directory, directoryLayer } from "../src/directory.ts";
import { Issuer, IssuerError } from "../src/issuer.ts";
import { RatKing, ratKingLayer } from "../src/ratking.ts";
import { SecretStore } from "../src/secrets.ts";

const secrets = Layer.sync(SecretStore, () => {
  const values = new Map<string, string>();

  return SecretStore.of({
    add: (name, value) =>
      Effect.sync(() => {
        values.set(name, Redacted.value(value));
      }),
    exists: (name) => Effect.sync(() => values.has(name)),
    lease: (name) => Effect.sync(() => Redacted.make(values.get(name) ?? "")),
  });
});

const issuer = Layer.effect(
  Issuer,
  Effect.gen(function* makeTestIssuer() {
    const directory = yield* Directory;

    return Issuer.of({
      ensure: (name, peer) =>
        directory.record(name, peer).pipe(
          Effect.as(peer.id),
          Effect.mapError((error) => new IssuerError({ reason: error.reason }))
        ),
    });
  })
);

const harness = (state: string, http: HttpClient.HttpClient) =>
  ratKingLayer.pipe(
    Layer.provideMerge(issuer),
    Layer.provideMerge(secrets),
    Layer.provideMerge(directoryLayer),
    Layer.provideMerge(
      Layer.succeed(
        Settings,
        Settings.of({
          askTimeoutMs: 1000,
          didTemplate: "did:web:{agent}.agents.example.invalid",
          directory: `${state}/directory.json`,
          documents: [],
          endpoint: "https://mailbox.example.invalid",
          issuer: Option.none(),
          reserved: {},
          secretsCommand: "secrets",
          serviceDid: "did:web:mailbox.example.invalid",
          state,
        })
      )
    ),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(NodeServices.layer)
  );

const Status = Schema.Literals([400, 403, 409, 500, 503]);

it.live.prop(
  "a send the mailbox does not take is a typed NOT DELIVERED, and an unknown name never reaches the network",
  [Arbitrary.schema(Status)],
  ([status]) =>
    Effect.gen(function* loudFailure() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const submitted: string[] = [];

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const isSend = request.url.endsWith("sh.mschf.ratking.mailbox.send");

          if (isSend && Predicate.isTagged(request.body, "Uint8Array")) {
            submitted.push(new TextDecoder().decode(request.body.body));
          }

          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { error: isSend ? "Conflict" : "MailboxUnavailable" },
              { status: isSend ? status : 503 }
            )
          );
        })
      );

      const peer = yield* identity("did:web:peer.agents.example.invalid");

      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;

        yield* directory.record("peer", yield* document(peer));

        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            pane: Option.none(),
            pid: 1,
            session: "test-session",
          },
          () => Effect.void
        );

        const unknown = yield* ratking
          .send("nobody", "hello")
          .pipe(Effect.flip);

        expect(unknown.code).toBe("UnknownName");
        expect(submitted).toEqual([]);

        const refused = yield* ratking.send("peer", "hello").pipe(Effect.flip);

        expect(refused.code).toBe(status < 500 ? "Rejected" : "Uncertain");
        expect(submitted.length).toBe(status < 500 ? 1 : 3);
        expect(new Set(submitted).size).toBe(1);
      }).pipe(Effect.provide(harness(state, http)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 }, timeout: 60_000 }
);
