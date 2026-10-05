/* oxlint-disable typescript/promise-function-async -- The fake fetch returns generated Promise responses without async control flow. */
import { expect, it } from "@effect/vitest";
import { Effect, Match, Schema } from "effect";

import { teardownProbe } from "./teardown.ts";

it.effect.prop(
  "GET-only probe proves absence through optional totals, short pages and full pages followed by empty pages",
  {
    lastFull: Schema.Boolean,
    lastSize: Schema.Int.check(Schema.isBetween({ maximum: 99, minimum: 0 })),
    namespaceAbsent: Schema.Boolean,
    pages: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 1 })),
    scriptAbsent: Schema.Boolean,
    totalPresent: Schema.Boolean,
  },
  ({
    scriptAbsent,
    namespaceAbsent,
    pages,
    totalPresent,
    lastSize,
    lastFull,
  }) =>
    Effect.gen(function* absenceProperty() {
      const urls: string[] = [];
      const endPage = !totalPresent && lastFull ? pages + 1 : pages;

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
        expect(new URL(url).searchParams.get("per_page")).toBe("100");
        let size = 0;

        if (page < pages) {
          size = 100;
        } else if (page === pages) {
          size = lastFull ? 100 : lastSize;
        }

        const result = Array.from({ length: size }, () => ({
          script: "unrelated-fixture",
        }));

        if (!namespaceAbsent && page === pages) {
          result.splice(0, 1, { script: "rat-king-mailbox-preview" });
        }

        return Promise.resolve(
          Response.json({
            result,
            result_info: totalPresent ? { total_pages: pages } : {},
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
                : "NAMESPACES_ABSENT_FAIL status=200 step=namespace-present",
            ]
          : [
              "WORKER_ABSENT_FAIL status=200 schema=script-missing",
              "NAMESPACES_ABSENT_FAIL step=not-checked",
            ]
      );
      expect(urls.length).toBe(
        scriptAbsent ? (namespaceAbsent ? endPage : pages) + 1 : 1
      );
    })
);

it.effect.prop(
  "HTTP failures report only status and Cloudflare codes without erasing a proven worker PASS",
  {
    code: Schema.Int.check(
      Schema.isBetween({ maximum: 10_006, minimum: 10_000 })
    ),
    privateText: Schema.String,
    status: Schema.Literals([400, 401, 403, 404, 429, 500, 503]),
    workerPassed: Schema.Boolean,
  },
  ({ status, workerPassed, code, privateText }) =>
    Effect.gen(function* failureProperty() {
      const http: typeof fetch = (input) => {
        const url = input instanceof Request ? input.url : input.toString();
        const settings = url.endsWith("/settings");
        const missing = workerPassed && settings;

        return Promise.resolve(
          Response.json(
            {
              errors: [{ code: missing ? 10_007 : code, message: privateText }],
              success: false,
            },
            { status: missing ? 404 : status }
          )
        );
      };

      expect(
        yield* teardownProbe("fixture", "fixture", "fixture", http)
      ).toEqual(
        workerPassed
          ? [
              "WORKER_ABSENT_PASS",
              `NAMESPACES_ABSENT_FAIL status=${status} codes=${code}`,
            ]
          : [
              `WORKER_ABSENT_FAIL status=${status} codes=${code}`,
              "NAMESPACES_ABSENT_FAIL step=not-checked",
            ]
      );
    })
);

it.effect.prop(
  "malformed namespace responses and transport failures fail closed with sanitised steps",
  {
    mode: Schema.Literals([
      "null-total",
      "string-total",
      "fraction-total",
      "zero-total",
      "huge-total",
      "missing-info",
      "null-info",
      "bad-result",
      "bad-script",
      "oversized-page",
      "false-success",
      "invalid-json",
      "transport",
      "regressed-total",
    ]),
    privateText: Schema.String,
  },
  ({ mode, privateText }) =>
    Effect.gen(function* malformedProperty() {
      const http: typeof fetch = (input) => {
        const url = input instanceof Request ? input.url : input.toString();

        if (url.endsWith("/settings")) {
          return Promise.resolve(
            Response.json(
              { errors: [{ code: 10_007 }], success: false },
              { status: 404 }
            )
          );
        }

        if (mode === "transport") {
          return Promise.reject(new Error(privateText));
        }

        if (mode === "invalid-json") {
          return Promise.resolve(new Response("not json"));
        }

        const page = Number(new URL(url).searchParams.get("page"));

        const full = Array.from({ length: 100 }, () => ({
          script: "unrelated",
        }));

        const valid = { result: [], result_info: {}, success: true };

        const bodies = {
          "bad-result": { ...valid, result: privateText },
          "bad-script": { ...valid, result: [{ script: null }] },
          "false-success": { ...valid, success: false },
          "fraction-total": { ...valid, result_info: { total_pages: 1.5 } },
          "huge-total": { ...valid, result_info: { total_pages: 1001 } },
          "missing-info": { result: [], success: true },
          "null-info": { ...valid, result_info: null },
          "null-total": { ...valid, result_info: { total_pages: null } },
          "oversized-page": {
            ...valid,
            result: [...full, { script: "unrelated" }],
          },
          "regressed-total": {
            ...valid,
            result: full,
            result_info: { total_pages: page === 1 ? 2 : 1 },
          },
          "string-total": {
            ...valid,
            result_info: { total_pages: privateText },
          },
          "zero-total": { ...valid, result_info: { total_pages: 0 } },
        };

        return Promise.resolve(Response.json(bodies[mode]));
      };

      const reason = Match.value(mode).pipe(
        Match.when("transport", () => "step=http-transport"),
        Match.when("invalid-json", () => "status=200 schema=json"),
        Match.when("regressed-total", () => "status=200 schema=pagination"),
        Match.orElse(() => "status=200 schema=namespaces")
      );

      expect(
        yield* teardownProbe("fixture", "fixture", "fixture", http)
      ).toEqual(["WORKER_ABSENT_PASS", `NAMESPACES_ABSENT_FAIL ${reason}`]);
    })
);

it.effect.prop(
  "a full-page stream without a total cannot exceed the hard page cap",
  { totalPresent: Schema.Boolean },
  ({ totalPresent }) =>
    Effect.gen(function* capProperty() {
      let pages = 0;

      const http: typeof fetch = (input) => {
        const url = input instanceof Request ? input.url : input.toString();

        if (url.endsWith("/settings")) {
          return Promise.resolve(
            Response.json(
              { errors: [{ code: 10_007 }], success: false },
              { status: 404 }
            )
          );
        }

        pages += 1;

        return Promise.resolve(
          Response.json({
            result: Array.from({ length: 100 }, () => ({
              script: "unrelated",
            })),
            result_info: totalPresent ? { total_pages: 1000 } : {},
            success: true,
          })
        );
      };

      expect(
        yield* teardownProbe("fixture", "fixture", "fixture", http)
      ).toEqual([
        "WORKER_ABSENT_PASS",
        totalPresent
          ? "NAMESPACES_ABSENT_PASS"
          : "NAMESPACES_ABSENT_FAIL schema=pagination-page-cap",
      ]);
      expect(pages).toBe(1000);
    }),
  { arbitrary: { runs: 10 } }
);
