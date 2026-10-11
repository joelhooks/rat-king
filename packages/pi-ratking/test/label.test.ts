/* oxlint-disable promise/prefer-await-to-callbacks -- Effect HttpClient test adapter. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { plaintextBody } from "@rat-king/envelope/signed";
import * as Send from "@rat-king/lexicon/mailbox.send";
import {
  Arbitrary,
  Effect,
  FileSystem,
  Option,
  Predicate,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Directory } from "../src/directory.ts";
import { decodePayload, renderInbound } from "../src/payload.ts";
import { RatKing } from "../src/ratking.ts";
import { harness } from "./harness.ts";

const CallSign = Schema.UndefinedOr(
  Schema.Literals(["🔮 Nicodemus · Rat King desk", "🦉 Owl · signed plaintext"])
);

it.live.prop(
  "a call sign travels inside the signed payload and renders before the verified name, and without one the name stands alone",
  [Arbitrary.schema(CallSign)],
  ([callSign]) =>
    Effect.gen(function* callSigns() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const submitted: string[] = [];

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (Predicate.isTagged(request.body, "Uint8Array")) {
            submitted.push(new TextDecoder().decode(request.body.body));
          }

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "Conflict" }, { status: 409 })
          );
        })
      );

      const peer = yield* identity("did:web:peer.agents.example.invalid");

      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;

        yield* directory.record("peer", yield* document(peer));

        yield* ratking.run(
          {
            alive: () => false,
            env: Option.some("tester"),
            label: () => Option.fromNullishOr(callSign),
            pane: Option.none(),
            pid: 1,
            session: "test-session",
          },
          () => Effect.void
        );

        yield* ratking
          .send("peer", "hello", { summary: "  Deploy\n done,  all green " })
          .pipe(Effect.flip);

        const [wire] = submitted;

        const input = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Send.Input)
        )(wire);

        const payload = yield* decodePayload(
          yield* plaintextBody(input.envelope)
        );

        expect(payload.pipe(Option.map((value) => value.label))).toEqual(
          Option.some(callSign)
        );

        expect(payload.pipe(Option.map((value) => value.summary))).toEqual(
          Option.some("Deploy done, all green")
        );

        const rendered = renderInbound("ratking", {
          body: "hello",
          cc: false,
          did: "did:web:tester.agents.example.invalid",
          from: "tester",
          id: "3m7x2ka4xv22a",
          kind: "message",
          label: Option.flatMapNullishOr(payload, (value) => value.label),
          replyTo: Option.none(),
          summary: Option.none(),
          verified: true,
        });

        expect(rendered.split("\n")[0]).toContain(
          callSign === undefined
            ? "from tester**"
            : `from ${callSign} (tester)**`
        );
      }).pipe(Effect.provide(harness(state, http)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 60_000 }
);
