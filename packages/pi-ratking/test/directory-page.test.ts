import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import { IssuerError } from "@rat-king/ratking-client/issuer";
import { Arbitrary, Effect, Schema } from "effect";
import { expect } from "vitest";

import { directoryPage } from "../src/directory-page.ts";

const Status = Schema.Literals(["live", "idle", "retired"]);

it.effect.prop(
  "a refused lease page is surfaced without retrying or following the cursor",
  [Arbitrary.schema(Schema.Literals(["live", "idle"]))],
  ([status]) =>
    Effect.gen(function* refusal() {
      let calls = 0;

      const refused = new IssuerError({
        reason:
          "HTTP 429; ScanBudgetSpent: use ratking snapshot or look up a single named row",
      });

      const error = yield* directoryPage(
        {
          directory: (params) =>
            Effect.sync(() => {
              expect(params.cursor).toBe("previous-page");
              calls += 1;
            }).pipe(Effect.andThen(Effect.fail(refused))),
        },
        { cursor: "previous-page", status }
      ).pipe(Effect.flip);

      expect(error).toBe(refused);
      expect(calls).toBe(1);
    })
);

it.effect.prop(
  "explicit filters, matches and byte-limited continuation preserve every matching name",
  [
    Arbitrary.schema(Status),
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }))
    ),
  ],
  ([status, size]) =>
    Effect.gen(function* proof() {
      const names = Array.from({ length: size }, (_, index) => {
        const name = `project/name-${String(index).padStart(3, "0")}`;
        const did = `did:web:${"x".repeat(200)}${index}.example.invalid`;

        return {
          did,
          document: {
            authentication: [],
            id: did,
            keyAgreement: [],
            verificationMethod: [],
          },
          name,
          roleTarget: index % 2 === 0,
          status,
        };
      });

      const seen: string[] = [];
      let cursor: string | undefined;

      do {
        const request = { limit: 100, match: "project/", status: [status] };

        if (cursor !== undefined) {
          Object.assign(request, { cursor });
        }

        const text = yield* directoryPage(
          {
            directory: (params) =>
              Effect.gen(function* page() {
                expect(params.status).toBe(status);
                expect(params.limit).toBe(100);

                return yield* Schema.decodeUnknownEffect(ListNames.Output)({
                  names: names.filter(
                    (entry) => entry.name > (params.cursor ?? "")
                  ),
                  scanned: size,
                });
              }).pipe(Effect.orDie),
          },
          request
        );

        expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(4096);
        const lines = text.split("\n").filter((line) => line.startsWith("- "));

        for (const line of lines) {
          expect(line).toContain(` · ${status}`);
          seen.push(line.split(" · ")[0]?.slice(2) ?? "");
        }

        const next = /continue with cursor: (?<cursor>"[^"]+")/u.exec(text)
          ?.groups?.cursor;

        cursor =
          next === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(
                Schema.fromJsonString(Schema.String)
              )(next);

        if (cursor !== undefined) {
          expect(cursor).toBe(seen.at(-1));
        }
      } while (cursor !== undefined);

      expect(seen).toEqual(names.map((entry) => entry.name));
    })
);

it.effect.prop(
  "all inventory offsets skip exactly the requested number of rows",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 150, minimum: 0 }))
    ),
  ],
  ([offset]) =>
    Effect.gen(function* proof() {
      const names = Array.from({ length: 120 }, (_, index) => {
        const name = `name-${String(index).padStart(3, "0")}`;
        const did = `did:web:${name}.example.invalid`;

        return {
          did,
          document: {
            authentication: [],
            id: did,
            keyAgreement: [],
            verificationMethod: [],
          },
          name,
        };
      });

      const text = yield* directoryPage(
        {
          directory: (params) =>
            Effect.gen(function* page() {
              expect(params.all).toBe(true);

              const remaining = names.filter(
                (entry) => entry.name > (params.cursor ?? "")
              );

              const entries = remaining.slice(0, params.limit ?? 100);

              const result = { names: entries };

              if (remaining.length > entries.length) {
                Object.assign(result, { cursor: entries.at(-1)?.name });
              }

              return yield* Schema.decodeUnknownEffect(ListNames.Output)(
                result
              );
            }).pipe(Effect.orDie),
        },
        { all: true, limit: 5, offset }
      );

      expect(
        text
          .split("\n")
          .filter((line) => line.startsWith("- "))
          .map((line) => line.split(" · ")[0]?.slice(2))
      ).toEqual(names.slice(offset, offset + 5).map((entry) => entry.name));
    })
);
