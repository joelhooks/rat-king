/* oxlint-disable promise/prefer-await-to-callbacks -- Effect HttpClient test adapter. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
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
import { RatKing } from "../src/ratking.ts";
import { harness } from "./harness.ts";

const Status = Schema.Literals([400, 403, 409, 500, 503]);

it.live.prop(
  "a send the mailbox does not take is a typed NOT DELIVERED, and an unknown name never reaches the network",
  [Arbitrary.schema(Status)],
  ([status]) =>
    Effect.gen(function* loudFailure() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const submitted: string[] = [];

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const isSend = request.url.endsWith("sh.mschf.ratking.mailbox.send");

          if (isSend && Predicate.isTagged(request.body, "Uint8Array")) {
            submitted.push(new TextDecoder().decode(request.body.body));
          }

          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              { error: isSend ? "Conflict" : "MailboxUnavailable" },
              { status: isSend ? status : 503 }
            )
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
            pane: Option.none(),
            pid: 1,
            session: "test-session",
          },
          () => Effect.void
        );

        const unknown = yield* ratking
          .send("nobody", "hello")
          .pipe(Effect.flip);

        expect(unknown.code).toBe("UnknownName");
        expect(submitted).toEqual([]);

        const refused = yield* ratking.send("peer", "hello").pipe(Effect.flip);

        expect(refused.code).toBe(status < 500 ? "Rejected" : "Uncertain");
        expect(submitted.length).toBe(status < 500 ? 1 : 3);
        expect(new Set(submitted).size).toBe(1);
      }).pipe(Effect.provide(harness(state, http)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 }, timeout: 60_000 }
);
