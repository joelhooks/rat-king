import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { expect } from "vitest";

import { receivedMail } from "../../ratking-client/src/received-mail.ts";

it.live.prop(
  "only explicitly signed plaintext is recoverable, and updates privately replace the journal instead of overwriting it",
  [Schema.String],
  ([body]) =>
    Effect.gen(function* privateJournal() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const state = yield* fs.makeTempDirectoryScoped();
      const journal = yield* receivedMail(state, "tester");

      const received = {
        body,
        cc: false,
        did: "sender",
        from: "peer",
        id: "signed",
        kind: "message" as const,
        label: Option.none<string>(),
        replyTo: Option.none<string>(),
        summary: Option.none<string>(),
        verified: true,
      };

      const sealed = { ...received, body: "sealed body", id: "sealed" };

      yield* journal.save({ encrypted: true, received: sealed });
      const dir = path.join(state, "received-mail");
      expect(yield* fs.exists(dir)).toBe(false);

      yield* journal.save({ encrypted: false, received });
      const [name] = yield* fs.readDirectory(dir);
      expect(name).toBeDefined();
      const file = path.join(dir, name ?? "missing");
      const before = yield* fs.stat(file);
      expect(before.mode % 0o1000).toBe(0o600);

      yield* journal.save({ received: sealed });
      expect(yield* journal.find(sealed.id)).toEqual(Option.none());
      yield* journal.save({
        encrypted: false,
        received: { ...received, body: `${body}!` },
      });

      const after = yield* fs.stat(file);
      expect(after.mode % 0o1000).toBe(0o600);
      expect(Option.isSome(before.ino)).toBe(true);
      expect(after.ino).not.toEqual(before.ino);
      expect(yield* fs.readDirectory(dir)).toEqual([name]);
      expect(yield* fs.readFileString(file)).not.toContain('"sealed"');
      expect(yield* journal.find(received.id)).toEqual(
        Option.some({
          encrypted: false,
          received: { ...received, body: `${body}!` },
        })
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 } }
);
