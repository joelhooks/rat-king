/* oxlint-disable typescript/promise-function-async -- The fake fetch returns generated Promise responses without async control flow. */
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { teardownProbe } from "./teardown.ts";

it.effect.prop(
  "read-only probe succeeds iff the script and all paginated namespaces are absent",
  {
    namespaceAbsent: Schema.Boolean,
    pages: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
    scriptAbsent: Schema.Boolean,
  },
  ({ scriptAbsent, namespaceAbsent, pages }) =>
    Effect.gen(function* absenceProperty() {
      const urls: string[] = [];

      const http: typeof fetch = (input, init) => {
        const url = input instanceof Request ? input.url : input.toString();
        urls.push(url);
        expect(init?.method).toBe("GET");
        expect(init?.headers).toEqual({ Authorization: "Bearer fixture" });

        if (url.endsWith("/settings")) {
          return Promise.resolve(
            Response.json(
              scriptAbsent
                ? { errors: [{ code: 10_007 }], success: false }
                : { result: {}, success: true },
              { status: scriptAbsent ? 404 : 200 }
            )
          );
        }

        const page = Number(new URL(url).searchParams.get("page"));

        return Promise.resolve(
          Response.json({
            result:
              !namespaceAbsent && page === pages
                ? [{ script: "rat-king-mailbox-preview" }]
                : [{ script: "unrelated-fixture" }],
            result_info: { total_pages: pages },
            success: true,
          })
        );
      };

      const labels = yield* teardownProbe(
        "fixture",
        "rat-king-mailbox-preview",
        "fixture",
        http
      );

      expect(labels).toEqual(
        scriptAbsent
          ? [
              "WORKER_ABSENT_PASS",
              namespaceAbsent
                ? "NAMESPACES_ABSENT_PASS"
                : "NAMESPACES_ABSENT_FAIL",
            ]
          : ["WORKER_ABSENT_FAIL", "NAMESPACES_ABSENT_FAIL"]
      );
      expect(urls.length).toBe(scriptAbsent ? pages + 1 : 1);
    })
);

it.effect.prop(
  "arbitrary HTTP failures never prove absence",
  {
    status: Schema.Literals([400, 401, 403, 404, 429, 500, 503]),
  },
  ({ status }) =>
    Effect.gen(function* failureProperty() {
      const http: typeof fetch = () =>
        Promise.resolve(
          Response.json(
            { errors: [{ code: 10_000 }], success: false },
            { status }
          )
        );

      expect(
        yield* teardownProbe("fixture", "fixture", "fixture", http)
      ).toEqual(["WORKER_ABSENT_FAIL", "NAMESPACES_ABSENT_FAIL"]);
    })
);
