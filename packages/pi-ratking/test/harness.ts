/* oxlint-disable promise/prefer-await-to-callbacks -- Effect layer test adapters. */
import { NodeServices } from "@effect/platform-node";
import { Settings } from "@rat-king/ratking-client/config";
import type { RelaySettingValue } from "@rat-king/ratking-client/config";
import { Directory, directoryLayer } from "@rat-king/ratking-client/directory";
import { Issuer, IssuerError } from "@rat-king/ratking-client/issuer";
import type { ReservedValue } from "@rat-king/ratking-client/name";
import {
  ratKingLayer,
  AdmissionBackoff,
} from "@rat-king/ratking-client/ratking";
import { SecretStore } from "@rat-king/ratking-client/secrets";
import { Effect, Layer, Option, Redacted, Duration } from "effect";
import { HttpClient } from "effect/http";

const secrets = (values: Map<string, string>) =>
  Layer.sync(SecretStore, () =>
    SecretStore.of({
      add: (name, value) =>
        Effect.sync(() => {
          values.set(name, Redacted.value(value));
        }),
      exists: (name) => Effect.sync(() => values.has(name)),
      lease: (name) => Effect.sync(() => Redacted.make(values.get(name) ?? "")),
    })
  );

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
      names: Effect.succeed([]),
    });
  })
);

export const harness = (
  state: string,
  http: HttpClient.HttpClient,
  refuse: readonly string[] = [],
  overrides: {
    readonly attentionLevers?: boolean;
    readonly ccDigestMinutes?: Readonly<Record<string, number>>;
    readonly reserved?: ReservedValue;
    readonly roleAllowlist?: readonly string[];
    readonly turnRecords?: boolean;
    readonly relays?: readonly RelaySettingValue[];
    readonly documents?: readonly string[];
    readonly secrets?: Map<string, string>;
  } = {}
) =>
  ratKingLayer.pipe(
    Layer.provideMerge(Layer.succeed(AdmissionBackoff, () => Duration.zero)),
    Layer.provideMerge(issuer),
    Layer.provideMerge(secrets(overrides.secrets ?? new Map<string, string>())),
    Layer.provideMerge(directoryLayer),
    Layer.provideMerge(
      Layer.succeed(
        Settings,
        Settings.of({
          askTimeoutMs: 1000,
          didTemplate: "did:web:{agent}.agents.example.invalid",
          directory: `${state}/directory.json`,
          documents: [],
          encrypt: false,
          endpoint: "https://mailbox.example.invalid",
          issuer: Option.none(),
          refuse,
          relays: [],
          reserved: {},
          secretsCommand: "secrets",
          serviceDid: "did:web:mailbox.example.invalid",
          state,
          ...overrides,
        })
      )
    ),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(NodeServices.layer)
  );
