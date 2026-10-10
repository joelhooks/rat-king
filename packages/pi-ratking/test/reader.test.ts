/* oxlint-disable promise/prefer-await-to-callbacks -- Effect HttpClient test adapter. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import { MailboxClientError } from "@rat-king/mailbox-client";
import {
  Arbitrary,
  Duration,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { sealed } from "../../envelope/test/helpers.ts";
import { document, identity } from "../../mailbox-client/test/identity.ts";
import { Directory } from "../src/directory.ts";
import { QuarantineRecord, recover } from "../src/quarantine.ts";
import { RatKing, ReaderState } from "../src/ratking.ts";
import { statusText } from "../src/tool.ts";
import { harness } from "./harness.ts";

const facts = {
  alive: () => false,
  env: Option.some("tester"),
  pane: Option.none(),
  pid: 1,
  session: "test-session",
};

const fakeMailbox = (head: number) => {
  const calls: string[] = [];

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const nsid = new URL(request.url).pathname.replace("/xrpc/", "");

      calls.push(nsid);

      return HttpClientResponse.fromWeb(
        request,
        nsid === "sh.mschf.ratking.mailbox.list"
          ? Response.json({ events: [], throughSeq: head })
          : Response.json({ error: "MailboxUnavailable" }, { status: 503 })
      );
    })
  );

  return { calls, http };
};

const eventually = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.retry(
      Schedule.spaced("20 millis").pipe(
        Schedule.while(({ attempt }) => attempt < 250)
      )
    )
  );

it.live.prop(
  "a refused name starts no reader and fails sends at once; any other name starts one",
  [Arbitrary.schema(Schema.Boolean)],
  ([refused]) =>
    Effect.gen(function* refuseProof() {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped();
      const mailbox = fakeMailbox(0);
      const peer = yield* identity("did:web:peer.agents.example.invalid");

      yield* Effect.gen(function* proof() {
        const directory = yield* Directory;
        const ratking = yield* RatKing;

        yield* directory.record("peer", yield* document(peer));
        yield* ratking.run(facts, () => Effect.void);

        const sent = yield* ratking
          .send("peer", "hello")
          .pipe(Effect.flip, Effect.timeout(Duration.seconds(10)));

        yield* Effect.sleep(Duration.millis(300));

        const status = yield* ratking.status;

        if (refused) {
          expect(sent.code).toBe("Refused");
          expect(ReaderState.$is("Refused")(status.reader)).toBe(true);
          expect(statusText("ratking", status)).toContain("REFUSED");
          expect(mailbox.calls).toEqual([]);
        } else {
          expect(sent.code).not.toBe("Refused");
          expect(mailbox.calls).toContain("sh.mschf.ratking.mailbox.list");
        }
      }).pipe(
        Effect.provide(harness(state, mailbox.http, refused ? ["tester"] : []))
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 60_000 }
);

it.live.prop(
  "a reader without a cursor starts at the mailbox head, never seq 0; a saved cursor wins",
  [
    Arbitrary.schema(
      Schema.Option(
        Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 0 }))
      )
    ),
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 1000, minimum: 1 }))
    ),
  ],
  ([saved, head]) =>
    Effect.gen(function* headProof() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const cursor = path.join(state, "cursors", "tester.json");
      const mailbox = fakeMailbox(head);

      if (Option.isSome(saved)) {
        yield* fs.makeDirectory(path.dirname(cursor), { recursive: true });
        yield* fs.writeFileString(
          cursor,
          JSON.stringify({ afterSeq: saved.value })
        );
      }

      yield* Effect.gen(function* proof() {
        const ratking = yield* RatKing;

        yield* ratking.run(facts, () => Effect.void);

        yield* eventually(
          Effect.suspend(() =>
            mailbox.calls.includes("sh.mschf.ratking.runtime.acquireLease")
              ? Effect.void
              : Effect.fail("reader has not reached the lease")
          )
        );
      }).pipe(Effect.provide(harness(state, mailbox.http)));

      const written = yield* fs
        .readFileString(cursor)
        .pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.fromJsonString(Schema.Struct({ afterSeq: Schema.Int }))
            )
          )
        );

      expect(written.afterSeq).toBe(Option.getOrElse(saved, () => head));
      expect(
        mailbox.calls.filter((call) => call === "sh.mschf.ratking.mailbox.list")
          .length
      ).toBe(Option.isSome(saved) ? 0 : 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 6 }, timeout: 60_000 }
);

it.live.prop(
  "an unopenable message is quarantined with metadata only and shows in status, unless the sender document lookup lets it open",
  [Arbitrary.schema(Schema.Boolean)],
  ([fetchable]) =>
    Effect.gen(function* quarantineProof() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const dir = path.join(state, "quarantine", "tester");
      const sample = yield* sealed();
      const mailbox = fakeMailbox(0);

      const event = yield* Schema.decodeUnknownEffect(
        Schema.toType(Defs.MessageEvent)
      )({
        $type: "sh.mschf.ratking.defs#messageEvent",
        envelope: sample.envelope,
        receipt: {
          message: {
            messageId: sample.envelope.aad.messageId,
            senderDid: sample.envelope.aad.senderDid,
          },
          recipientDid: sample.envelope.aad.recipientDid,
          seq: 7,
          state: "accepted",
        },
        seq: 7,
      });

      const refused = new MailboxClientError({
        reason: "Peer directory request refused",
      });

      const result = yield* recover(dir, {
        open: () =>
          fetchable
            ? Effect.succeed({
                body: "recovered",
                senderDid: sample.envelope.aad.senderDid,
                tid: sample.envelope.aad.messageId,
                verified: true as const,
              })
            : Effect.fail(refused),
        refresh: () => (fetchable ? Effect.void : Effect.fail(refused)),
      })(
        event,
        new MailboxClientError({ reason: "Unauthorized sender signing key" })
      );

      const files = yield* fs
        .readDirectory(dir)
        .pipe(Effect.orElseSucceed((): string[] => []));

      yield* Effect.gen(function* proof() {
        const ratking = yield* RatKing;

        yield* ratking.run(facts, () => Effect.void);

        const status = yield* eventually(
          ratking.status.pipe(
            Effect.flatMap((current) =>
              Option.isSome(current.self)
                ? Effect.succeed(current)
                : Effect.fail("identity not ready")
            )
          )
        );

        expect(status.quarantine.count).toBe(fetchable ? 0 : 1);
        expect(statusText("ratking", status).includes("quarantined 1")).toBe(
          !fetchable
        );
      }).pipe(Effect.provide(harness(state, mailbox.http)));

      if (fetchable) {
        expect(Option.getOrUndefined(result)?.body).toBe("recovered");
        expect(files).toEqual([]);
      } else {
        expect(Option.isNone(result)).toBe(true);
        expect(files).toEqual(["7.json"]);

        const text = yield* fs.readFileString(path.join(dir, "7.json"));

        const record = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(QuarantineRecord)
        )(text);

        const fields = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))
        )(text);

        expect(Object.keys(fields).toSorted()).toEqual([
          "at",
          "messageId",
          "reason",
          "senderDid",
          "seq",
        ]);
        expect(record.seq).toBe(7);
        expect(record.senderDid).toBe(sample.envelope.aad.senderDid);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 4 }, timeout: 60_000 }
);
