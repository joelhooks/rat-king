// @effect-diagnostics asyncFunction:off -- WebCrypto independently checks the receipt hash.
import { NodeServices, NodeCrypto } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { resolveName } from "@rat-king/ratking-client/resolve";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Path,
  Schema,
  Layer,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { collectResolutions, writeResolutions } from "../src/resolve.ts";

const document = (did: string) => ({
  authentication: [],
  id: did,
  keyAgreement: [],
  verificationMethod: [],
});

const lookup = (name: string) =>
  Effect.succeed({
    did: `did:web:example.test:${name}`,
    document: document(`did:web:example.test:${name}`),
  });

it.effect.prop(
  "resolves local and refreshed names independently with fixed failure tags and exact totals",
  { count: Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 1 })) },
  ({ count }) =>
    Effect.gen(function* test() {
      const cases = [
        "local",
        "fresh",
        "unknown",
        "failed",
        "mismatch",
        "invalid",
      ];

      const names = Array.from({ length: count }, (_, i) =>
        cases.map((kind) => `${kind}${i}`)
      ).flat();

      const refreshed: string[] = [];

      const result = yield* collectResolutions(names, (name) =>
        resolveName(name, {
          didTemplate: "did:web:example.test:{agent}",
          refresh: (did) => {
            refreshed.push(did);

            if (did.includes("failed")) {
              return Effect.fail("refresh-failed" as const);
            }

            if (did.includes("unknown")) {
              return Effect.fail("unknown-name" as const);
            }

            if (did.includes("mismatch")) {
              return Effect.succeed(document("did:web:wrong.test"));
            }

            if (did.includes("invalid")) {
              return Effect.succeed({ secret: "private-exception-text" });
            }

            return Effect.succeed(document(did));
          },
          reserved: {},
          resolveLocal: (requested) =>
            requested.startsWith("local")
              ? Effect.succeed({
                  did: `did:web:cached.test:${requested}`,
                  document: document(`did:web:cached.test:${requested}`),
                })
              : Effect.fail("not-local"),
        })
      );

      expect(result.total).toBe(names.length);
      expect(Object.keys(result.resolved)).toHaveLength(2 * count);
      expect(refreshed).toHaveLength(5 * count);

      for (let i = 0; i < count; i += 1) {
        expect(result.resolved[`local${i}`]?.did).toBe(
          `did:web:cached.test:local${i}`
        );
        expect(result.resolved[`fresh${i}`]?.did).toBe(
          `did:web:example.test:fresh${i}`
        );

        for (const [kind, reason] of [
          ["unknown", "unknown-name"],
          ["failed", "refresh-failed"],
          ["mismatch", "did-mismatch"],
          ["invalid", "invalid-document"],
        ]) {
          expect(result.unresolved).toContainEqual({
            name: `${kind}${i}`,
            reason,
          });
        }
      }

      expect(JSON.stringify(result)).not.toContain("private-exception-text");
    })
);

it.effect(
  "canonicalizes aliases, rejects invalid names, and refuses private or mismatched local documents",
  () =>
    Effect.gen(function* test() {
      const did = "did:web:reserved.test";
      const refresh = (value: string) => Effect.succeed(document(value));

      const options = {
        didTemplate: "did:web:example.test:{agent}",
        refresh,
        reserved: { fixed: { aliases: ["alias"], did } },
        resolveLocal: () => Effect.fail("not-local"),
      };

      expect(yield* resolveName("alias", options)).toEqual({
        did,
        document: document(did),
      });
      expect(yield* resolveName("not a name", options).pipe(Effect.flip)).toBe(
        "unknown-name"
      );
      expect(
        yield* resolveName("fixed", {
          ...options,
          resolveLocal: () =>
            Effect.succeed({ did, document: document("did:web:wrong.test") }),
        }).pipe(Effect.flip)
      ).toBe("did-mismatch");
      expect(
        yield* resolveName("fixed", {
          ...options,
          resolveLocal: () =>
            Effect.succeed({
              did,
              document: {
                ...document(did),
                verificationMethod: [
                  {
                    controller: did,
                    id: `${did}#key`,
                    publicKeyJwk: {
                      crv: "P-256",
                      d: "private-key",
                      kty: "EC",
                      x: "x",
                      y: "y",
                    },
                  },
                ],
              },
            }),
        }).pipe(Effect.flip)
      ).toBe("invalid-document");
    })
);

it.effect(
  "times out one slow name, cancels it, and keeps other names moving within the concurrency bound",
  () =>
    Effect.gen(function* test() {
      const started = yield* Deferred.make<boolean>();
      let active = 0;
      let peak = 0;
      let cancelled = false;

      const fiber = yield* collectResolutions(
        ["slow", "one", "two", "three", "four"],
        (name) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              active += 1;
              peak = Math.max(peak, active);
            }),
            () =>
              name === "slow"
                ? Deferred.succeed(started, true).pipe(
                    Effect.andThen(Effect.never),
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        cancelled = true;
                      })
                    )
                  )
                : Effect.yieldNow.pipe(
                    Effect.as({
                      did: `did:web:example.test:${name}`,
                      document: document(`did:web:example.test:${name}`),
                    })
                  ),
            () =>
              Effect.sync(() => {
                active -= 1;
              })
          )
      ).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(fiber);
      expect(result.total).toBe(5);
      expect(Object.keys(result.resolved)).toHaveLength(4);
      expect(result.unresolved).toEqual([
        { name: "slow", reason: "refresh-failed" },
      ]);
      expect(peak).toBeLessThanOrEqual(4);
      expect(peak).toBeGreaterThan(1);
      expect(active).toBe(0);
      expect(cancelled).toBe(true);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "publishes a private file with an independently verified hash and preserves existing outputs",
  {
    count: Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: 0 })),
  },
  ({ count }) =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const names = path.join(root, "names.json");
      const out = path.join(root, "resolved.json");
      yield* fs.writeFileString(
        names,
        JSON.stringify(Array.from({ length: count }, (_, i) => `agent${i}`))
      );

      const receipt = yield* writeResolutions(names, out, lookup);
      const text = yield* fs.readFileString(out);
      expect(JSON.parse(text)).toEqual({
        resolved: Object.fromEntries(
          Array.from({ length: count }, (_, i) => [
            `agent${i}`,
            {
              did: `did:web:example.test:agent${i}`,
              document: document(`did:web:example.test:agent${i}`),
            },
          ])
        ),
        run: receipt.run,
        total: count,
        unresolved: [],
      });
      expect(receipt).toMatchObject({
        resolved: count,
        total: count,
        unresolved: 0,
      });
      expect((yield* fs.stat(out)).mode % 0o1000).toBe(0o600);

      const hash = new Uint8Array(
        yield* Effect.promise(
          async () =>
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(text)
            )
        )
      );

      expect(receipt.sha256).toBe(
        Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("")
      );
      expect(
        (yield* writeResolutions(names, out, lookup).pipe(Effect.flip)).code
      ).toBe("OutputExists");
      expect(yield* fs.readFileString(out)).toBe(text);
      expect((yield* fs.readDirectory(root)).toSorted()).toEqual([
        "names.json",
        "resolved.json",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    ),
  { arbitrary: { runs: 5 } }
);

it.effect.prop(
  "bad input fails before lookup or publication",
  {
    input: Schema.Literals([
      "not json",
      "{}",
      "[1]",
      '["same","same"]',
      '[""]',
    ]),
  },
  ({ input }) =>
    Effect.gen(function* test() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const names = path.join(root, "names.json");
      yield* fs.writeFileString(names, input);

      const error = yield* writeResolutions(names, path.join(root, "out"), () =>
        Effect.die("must not look up")
      ).pipe(Effect.flip);

      expect(error.code).toBe("InvalidNames");
      expect(yield* fs.readDirectory(root)).toEqual(["names.json"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))
    )
);
