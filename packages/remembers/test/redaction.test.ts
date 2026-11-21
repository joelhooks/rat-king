import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { expect } from "vitest";

import { testLayer } from "../adapters/testing.ts";
import { codePoints } from "../src/code-points.ts";
import { Store } from "../src/contract.ts";
import { dedupe, postObservation, sha256 } from "../src/pipeline.ts";
import { search } from "../src/recall.ts";
import { draft, fixture, slice } from "./fixtures.ts";

const Pattern = Schema.Literals([
  "bearer",
  "blob",
  "email",
  "hex",
  "home",
  "ip",
  "key",
  "token",
]);

it.effect.prop(
  "regex redaction removes generated sensitive strings from claim metadata and subject-vector keys before durable output",
  [Pattern, Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }))],
  ([pattern, seed]) => {
    const values = {
      bearer: ["Bearer", "Z".repeat(24), seed].join(" "),
      blob: "Z".repeat(56),
      email: ["person", seed, "@", "example", ".invalid"].join(""),
      hex: "a".repeat(40),
      home: ["", "home", `fixture-${seed}`].join("/"),
      ip: [10, 7, seed % 200, 2].join("."),
      key: [
        "-----BEGIN ",
        "PRIVATE",
        " KEY-----\n",
        "fixture",
        "\n-----END ",
        "PRIVATE",
        " KEY-----",
      ].join(""),
      token: ["sk", "-", "q".repeat(20), seed].join(""),
    };

    const value = values[pattern];
    const candidate = draft("one", seed);
    const sentence = `Orchid contact ${value}.`;

    const observed = {
      ...candidate,
      claim: {
        ...candidate.claim,
        concepts: [value],
        project: value,
        sentence,
      },
      subject: { [value]: 1 },
    };

    return Effect.gen(function* redactionProof() {
      const result = yield* postObservation(slice("one"), [
        { ...observed, claim: { ...observed.claim, concepts: [value] } },
      ]);

      expect(result.candidates).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(value);
    }).pipe(Effect.provide(testLayer(fixture(seed))));
  }
);

const Evidence = Schema.Literals(["redacted", "raw-copy"]);

it.effect.prop(
  "unsafe evidence cannot create a citation or surface through a legacy citation",
  [Evidence, Schema.Boolean],
  ([kind, keepSafe]) => {
    const base = fixture(7);
    const conversation = slice("one");
    const candidate = draft("one", 7);
    const [safe] = candidate.evidence;

    const raw =
      kind === "redacted"
        ? ["a", "example.invalid"].join("@")
        : "The copied phrase is long enough";

    const unsafe = { chunk_id: "unsafe", quote: raw };

    const source = {
      ...conversation,
      chunks: [
        ...conversation.chunks,
        { id: unsafe.chunk_id, role: "user", text: raw },
      ],
    };

    return Effect.gen(function* proof() {
      const observed = yield* postObservation(source, [
        { ...candidate, evidence: keepSafe ? [unsafe, safe] : [unsafe] },
      ]);

      expect(
        observed.candidates.map(({ cites }) =>
          cites.map((cite) => cite.chunk_id)
        )
      ).toEqual(keepSafe ? [[safe.chunk_id]] : []);

      const original = yield* postObservation(source, [candidate]);
      const [policy] = yield* dedupe([original], base.at);

      if (policy === undefined) {
        return yield* Effect.die("Missing evidence fixture");
      }

      const legacy = {
        ...policy,
        cites: [
          {
            chunk_id: unsafe.chunk_id,
            end: codePoints(raw).length,
            sha256: yield* sha256(raw),
            start: 0,
          },
          ...policy.cites,
        ],
      } satisfies typeof policy;

      const store = yield* Store;
      yield* store.commit(
        { epoch: 0, key: "legacy", runId: "legacy", visit: 0 },
        [legacy]
      );
      const [hit] = yield* search({ project: "orchid", text: "Orchid" });

      expect(hit?.quotes).toEqual([
        { status: "unavailable", text: null },
        { status: "verified", text: safe.quote },
      ]);

      return yield* Effect.void;
    }).pipe(Effect.provide(testLayer({ ...base, slices: [source] })));
  }
);
