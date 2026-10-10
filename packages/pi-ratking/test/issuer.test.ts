/* oxlint-disable promise/prefer-await-to-callbacks -- Effect HttpClient test adapter. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { verify } from "@rat-king/envelope/es256";
import * as Register from "@rat-king/lexicon/identity.register";
import {
  Claims,
  DidResolver,
  staticResolver,
  unbase64url,
} from "@rat-king/mailbox-client";
import type { PeerDocument } from "@rat-king/mailbox-client";
import {
  Arbitrary,
  Effect,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Redacted,
  Result,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Settings } from "../src/config.ts";
import { Directory, directoryLayer } from "../src/directory.ts";
import { Issuer, issuerLayer } from "../src/issuer.ts";
import { AgentName, didFor } from "../src/name.ts";
import { RatKing, ratKingLayer } from "../src/ratking.ts";
import { SecretStore } from "../src/secrets.ts";

const serviceDid = "did:web:mailbox.example.invalid";

const didTemplate = "did:web:{agent}.agents.example.invalid";

const hostSecret = "host_identity";

const fakeDocument = (did: string, x: string): PeerDocument => ({
  authentication: [`${did}#atproto`],
  id: did,
  keyAgreement: [],
  verificationMethod: [
    {
      controller: did,
      id: `${did}#atproto`,
      publicKeyJwk: { crv: "P-256", kty: "EC", x, y: "y" },
    },
  ],
});

const secrets = (values: ReadonlyMap<string, string>) =>
  Layer.succeed(
    SecretStore,
    SecretStore.of({
      add: () => Effect.void,
      exists: (name) => Effect.succeed(values.has(name)),
      lease: (name) => Effect.succeed(Redacted.make(values.get(name) ?? "")),
    })
  );

const services = (
  state: string,
  http: HttpClient.HttpClient,
  values: ReadonlyMap<string, string>
) =>
  ratKingLayer.pipe(
    Layer.provideMerge(issuerLayer),
    Layer.provideMerge(secrets(values)),
    Layer.provideMerge(directoryLayer),
    Layer.provideMerge(
      Layer.succeed(
        Settings,
        Settings.of({
          askTimeoutMs: 1000,
          didTemplate,
          directory: `${state}/directory.json`,
          documents: [],
          encrypt: false,
          endpoint: "https://mailbox.example.invalid",
          issuer: Option.some({
            endpoint: "https://issuer.example.invalid",
            host: hostSecret,
          }),
          refuse: [],
          reserved: {},
          secretsCommand: "secrets",
          serviceDid,
          state,
        })
      )
    ),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, http)),
    Layer.provideMerge(NodeServices.layer)
  );

const Outcome = Schema.Literals([
  "ok",
  "NameTaken",
  "NameReserved",
  "Forbidden",
  "MailboxUnavailable",
]);

const statusOf = (outcome: typeof Outcome.Type) =>
  ({
    Forbidden: 403,
    MailboxUnavailable: 503,
    NameReserved: 403,
    NameTaken: 409,
    ok: 200,
  })[outcome];

it.live.prop(
  "the service issuer signs registration as the host and records only names the issuer bound",
  [Arbitrary.schema(AgentName), Arbitrary.schema(Outcome)],
  ([name, outcome]) =>
    Effect.gen(function* serviceIssuer() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const host = yield* identity("did:web:host.example.invalid");
      const hostDocument = yield* document(host);
      const tokens: string[] = [];
      const bodies: string[] = [];
      const did = didFor(didTemplate, {}, name);
      const peer = fakeDocument(did, "x");

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          tokens.push(
            request.headers.authorization?.replace(/^Bearer /u, "") ?? ""
          );

          if (Predicate.isTagged(request.body, "Uint8Array")) {
            bodies.push(new TextDecoder().decode(request.body.body));
          }

          return HttpClientResponse.fromWeb(
            request,
            outcome === "ok"
              ? Response.json({ did })
              : Response.json({ error: outcome }, { status: statusOf(outcome) })
          );
        })
      );

      yield* Effect.gen(function* proof() {
        const issuer = yield* Issuer;
        const directory = yield* Directory;
        const result = yield* issuer.ensure(name, peer).pipe(Effect.result);

        expect(Result.isSuccess(result)).toBe(outcome === "ok");

        if (Result.isFailure(result)) {
          expect(result.failure.reason).toContain(outcome);
        }

        const recorded = yield* directory.resolve(name).pipe(Effect.option);

        expect(recorded.pipe(Option.map((entry) => entry.document))).toEqual(
          outcome === "ok" ? Option.some(peer) : Option.none()
        );
      }).pipe(
        Effect.provide(
          services(state, http, new Map([[hostSecret, JSON.stringify(host)]]))
        )
      );

      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.fromJsonString(Schema.Json))
        )(bodies)
      ).toEqual([{ document: peer, name }]);

      const [token = ""] = tokens;
      const [header = "", payload = "", signature = ""] = token.split(".");

      const claims = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(Claims)
      )(new TextDecoder().decode(unbase64url(payload)));

      expect(claims).toMatchObject({
        aud: `${serviceDid}#mailbox`,
        iss: host.did,
        lxm: Register.Method.nsid,
      });

      const key = yield* DidResolver.use((resolver) =>
        resolver.resolve(host.did, `${host.did}#atproto`, "authentication")
      ).pipe(Effect.provide(staticResolver([hostDocument])));

      expect(
        yield* verify(
          key,
          new TextEncoder().encode(`${header}.${payload}`),
          unbase64url(signature)
        )
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 60_000 }
);

it.live.prop(
  "list adds every issued name across pages without replacing a local entry",
  [
    Arbitrary.schema(
      Schema.Array(AgentName).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(7)
      )
    ),
  ],
  ([generated]) =>
    Effect.gen(function* issuedNames() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const host = yield* identity("did:web:host.example.invalid");
      const names = [...new Set(generated)].toSorted();
      const [local = ""] = names;

      const remote = names.map((name) => {
        const did = didFor(didTemplate, {}, name);

        return { did, document: fakeDocument(did, "remote"), name };
      });

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const cursor = new URL(request.url).searchParams.get("cursor");
          const start = cursor === null ? 0 : names.indexOf(cursor) + 1;
          const page = remote.slice(start, start + 2);
          const last = page.at(-1);

          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              start + 2 < remote.length && last !== undefined
                ? { cursor: last.name, names: page }
                : { names: page }
            )
          );
        })
      );

      const localDocument = fakeDocument(
        didFor(didTemplate, {}, local),
        "local"
      );

      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;

        yield* directory.record(local, localDocument);

        const listed = yield* ratking.list;

        expect(listed.map((entry) => entry.name)).toEqual(
          names.toSorted((left, right) => left.localeCompare(right))
        );

        const resolved = yield* Effect.all(names.map(directory.resolve));

        expect(resolved.map((entry) => entry.document)).toEqual([
          localDocument,
          ...remote.slice(1).map((entry) => entry.document),
        ]);
      }).pipe(
        Effect.provide(
          services(state, http, new Map([[hostSecret, JSON.stringify(host)]]))
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 10 }, timeout: 60_000 }
);
