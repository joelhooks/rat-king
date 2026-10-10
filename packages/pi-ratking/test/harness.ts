/* oxlint-disable promise/prefer-await-to-callbacks -- Effect layer test adapters. */
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpClient } from "effect/http";

import { Settings } from "../src/config.ts";
import { Directory, directoryLayer } from "../src/directory.ts";
import { Issuer, IssuerError } from "../src/issuer.ts";
import { ratKingLayer } from "../src/ratking.ts";
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

export const harness = (state: string, http: HttpClient.HttpClient) =>
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
