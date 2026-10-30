import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { expect } from "vitest";

import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import {
  fakeMailbox,
  LEASE_ID,
  mail,
  people,
  seeded,
  socketLayer,
} from "../../ratking-cli/test/fixture.ts";
import { stdio } from "./stdio.ts";

const Refusal = Schema.Struct({
  failed: Schema.String,
  next: Schema.NonEmptyString,
  why: Schema.NonEmptyString,
});

const Payload = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50)
);

it.live.prop(
  "every MCP tool round-trips through stdio into the real client; only ack takes a lease and acknowledges selected ids",
  [Payload],
  ([body]) =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const who = yield* people;

      const mails = yield* Effect.forEach([1, 2], (seq) =>
        mail(who, seq, "accepted", {
          body,
          cc: [],
          kind: "ask",
          thread: `thread-${seq}`,
        })
      );

      const fake = fakeMailbox(mails);

      const wiring = harness(state, fake.http, [], {
        secrets: seeded(who),
      }).pipe(Layer.provideMerge(socketLayer));

      yield* Effect.gen(function* roundtrip() {
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        const mcp = yield* stdio("tester");
        const id = mails[0]?.event.receipt.message.messageId;
        expect(id).toBeDefined();

        if (id === undefined) {
          return;
        }

        expect(yield* mcp.call("whoami")).toEqual({
          did: who.tester.did,
          name: "tester",
        });
        expect(yield* mcp.call("lookup", { name: "peer" })).toEqual({
          did: who.peer.did,
          exists: true,
          name: "peer",
        });
        expect(yield* mcp.call("lookup", { name: "missing" })).toEqual({
          exists: false,
          name: "missing",
        });
        const listed = yield* mcp.call("inbox", { after: 0 });
        expect(listed).toMatchObject({
          hasMore: false,
          messages: [{ body }, { body }],
          throughSeq: 2,
        });
        expect(yield* mcp.call("inbox", { after: 1 })).toMatchObject({
          messages: [{ id: mails[1]?.event.receipt.message.messageId }],
        });
        expect(yield* mcp.call("read", { id })).toMatchObject({
          message: { body, id },
        });
        expect(yield* mcp.call("pending")).toHaveProperty("pending");
        expect(
          yield* mcp.call("send", {
            message: body,
            quiet: true,
            summary: "sent",
            to: "peer",
          })
        ).toHaveProperty("delivered");
        expect(
          yield* mcp.call("ask", {
            message: body,
            summary: "asked",
            to: "peer",
          })
        ).toHaveProperty("delivered");
        expect(
          yield* mcp.call("reply", {
            message: body,
            replyTo: id,
            summary: "answered",
          })
        ).toHaveProperty("delivered");
        expect(fake.sends).toHaveLength(3);
        expect(
          fake.sends.every(
            (envelope) => envelope.enc.length === 1 && envelope.enc[0] === 0
          )
        ).toBe(true);
        expect(
          fake.calls.filter((call) =>
            /\.(?:acquireLease|ack|deliver)$/u.test(call.nsid)
          )
        ).toEqual([]);
        expect(yield* mcp.call("ack", { ids: [id] })).toEqual({ acked: [id] });
        expect(mails.map((item) => item.state)).toEqual(["acked", "delivered"]);
        expect(fake.lease()).toBeUndefined();
      }).pipe(Effect.provide(wiring));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 }, timeout: 120_000 }
);

it.live.prop(
  "missing local keys refuse every tool without provisioning",
  [Payload],
  ([slug]) =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const fake = fakeMailbox([]);
      const secrets = new Map<string, string>();
      yield* Effect.gen(function* refused() {
        const mcp = yield* stdio("grokbot/missing");

        for (const [tool, args] of [
          ["whoami", {}],
          ["inbox", {}],
          ["read", { id: slug }],
          ["ack", { ids: [slug] }],
          ["pending", {}],
          ["lookup", { name: "peer" }],
          ["send", { message: "body", summary: "summary", to: "peer" }],
          ["ask", { message: "body", summary: "summary", to: "peer" }],
          ["reply", { message: "body", replyTo: slug, summary: "summary" }],
        ] satisfies [string, Schema.Json][]) {
          const result = yield* Schema.decodeUnknownEffect(Refusal)(
            yield* mcp.call(tool, args)
          );

          expect(result.failed).toBe("NoIdentity");
        }
      }).pipe(Effect.provide(harness(state, fake.http, [], { secrets })));
      expect(secrets.size).toBe(0);
      expect(fake.calls).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 2 }, timeout: 120_000 }
);

it.live("ack refuses a live lease and unknown ids without settling mail", () =>
  Effect.gen(function* proof() {
    const state = yield* FileSystem.FileSystem.use((fs) =>
      fs.makeTempDirectoryScoped()
    );

    const who = yield* people;

    const message = yield* mail(who, 1, "accepted", {
      body: "hello",
      cc: [],
      thread: "thread",
    });

    const holder = {
      did: who.tester.did,
      expiresAt: "2099-01-01T00:00:00.000Z",
      generation: 7,
      harness: {
        $type: "sh.mschf.ratking.runtime.lease#pi",
        sessionId: "other-reader",
      },
      leaseId: LEASE_ID,
    };

    const fake = fakeMailbox([message], holder);
    yield* Effect.gen(function* refused() {
      yield* Directory.use((directory) =>
        directory.record("peer", who.peerDocument)
      );
      const mcp = yield* stdio("tester");
      expect(yield* mcp.call("ack", { ids: ["unknown"] })).toMatchObject({
        failed: "NotAttempted",
      });

      const refusal = yield* Schema.decodeUnknownEffect(Refusal)(
        yield* mcp.call("ack", {
          ids: [message.event.receipt.message.messageId],
        })
      );

      expect(refusal.failed).toBe("LeaseHeld");
      expect(refusal.why).toContain("other-reader");
      expect(message.state).toBe("accepted");
      expect(fake.lease()).toEqual(holder);
      expect(
        fake.calls.filter((call) =>
          /\.(?:ack|deliver|releaseLease)$/u.test(call.nsid)
        )
      ).toEqual([]);
    }).pipe(
      Effect.provide(harness(state, fake.http, [], { secrets: seeded(who) }))
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer))
);
