import { it } from "@effect/vitest";
import { Effect, Function as Fn, Schema } from "effect";
import { expect } from "vitest";

import { sliceHttp } from "../adapters/slices.ts";
import { testLayer } from "../adapters/testing.ts";
import { Store } from "../src/contract.ts";
import { runNight } from "../src/night.ts";
import { sha256 } from "../src/pipeline.ts";
import { search } from "../src/recall.ts";
import { fixture } from "./fixtures.ts";

it.effect.prop(
  "HTTP recall refuses changed evidence and keeps astral-prefix code-point offsets",
  [Schema.Boolean],
  ([changed]) => {
    const data = fixture(9);

    return Effect.gen(function* httpProof() {
      yield* runNight({
        at: data.at,
        owner: "orchid-desk",
        runId: "http-night",
      });
      const store = yield* Store;
      const [record] = yield* store.search("Orchid", "orchid");

      if (record === undefined) {
        return yield* Effect.die("Missing fixture memory");
      }

      const [cite] = record.cites;

      const text = changed
        ? "changed fictional evidence"
        : "approved the violet";

      const body = {
        chunk: cite.chunk_id,
        end: cite.end,
        sha256: yield* sha256(text),
        start: cite.start,
        text,
      };

      const layer = sliceHttp({
        baseUrl: "https://source.example.invalid",
        bearer: "fixture-authority",
        defectCount: () => Effect.succeed(0),
        page: () => Effect.succeed({ cursor: "", keys: [] }),
        transport: Fn.constant(Promise.resolve(Response.json(body))),
      });

      const hits = yield* search({ project: "orchid", text: "Orchid" }).pipe(
        Effect.provide(layer)
      );

      expect(hits[0]?.quotes[0]).toEqual(
        changed ? { status: "stale", text: null } : { status: "verified", text }
      );

      return yield* Effect.void;
    }).pipe(Effect.provide(testLayer(data)));
  }
);
