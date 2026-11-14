import { it } from "@effect/vitest";
import { IssuerError } from "@rat-king/ratking-client/issuer";
import { RatKing, ReaderState } from "@rat-king/ratking-client/ratking";
import { Effect, Layer, Option, Schema } from "effect";
import { expect } from "vitest";

import { runAction } from "../src/tool.ts";

it.effect.prop(
  "retired directory failures show the issuer reason rather than only its error tag",
  [
    Schema.Literals([
      "Issuer refused sh.mschf.ratking.identity.listNames (HTTP 503; MailboxUnavailable: retry)",
      "Issuer answered sh.mschf.ratking.identity.listNames with an invalid body (HTTP 200)",
    ]),
  ],
  ([reason]) =>
    runAction("ratking", 1000, {
      action: "list",
      limit: 1,
      status: "retired",
    }).pipe(
      Effect.provide(
        Layer.mock(RatKing, {
          directory: () => Effect.fail(new IssuerError({ reason })),
          status: Effect.succeed({
            endpoint: "https://mailbox.example.invalid",
            openAsks: 0,
            quarantine: { count: 0, latest: Option.none() },
            reader: ReaderState.Starting({ reason: "test" }),
            self: Option.none(),
          }),
        })
      ),
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.isError).toBe(true);
          expect(result.text).toContain(`Directory unavailable: ${reason}`);
        })
      )
    )
);
