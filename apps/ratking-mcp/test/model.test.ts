// @effect-diagnostics asyncFunction:off -- fast-check asyncModelRun drives the MCP stdio boundary.
/* oxlint-disable typescript/promise-function-async -- fast-check commands require Promise-returning methods. */
import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Directory } from "@rat-king/ratking-client/directory";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { harness } from "../../../packages/pi-ratking/test/harness.ts";
import {
  fakeMailbox,
  mail,
  people,
  seeded,
  socketLayer,
} from "../../ratking-cli/test/fixture.ts";
import type { Mail } from "../../ratking-cli/test/fixture.ts";
import { stdio } from "./stdio.ts";

const Step = Schema.Struct({
  index: Schema.Literals([0, 1]),
  op: Schema.Literals(["inbox", "read", "ack"]),
});

interface Model {
  states: string[];
}

interface Real {
  readonly call: (tool: string, args: Schema.Json) => Promise<Schema.Json>;
  readonly messages: readonly Mail[];
  readonly calls: readonly { readonly nsid: string }[];
}

const terminalReceipt = (message: Mail): Mail => {
  let current = message.state;

  return {
    event: message.event,
    get state() {
      return current;
    },
    set state(next: string) {
      if (current !== "acked" && current !== "expired") {
        current = next;
      }
    },
  };
};

const Listed = Schema.Struct({
  messages: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const command = (step: typeof Step.Type): AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    const message = real.messages[step.index];

    if (message === undefined) {
      throw new Error("missing fixture");
    }

    const id = message.event.receipt.message.messageId;

    const before = real.calls.filter((call) =>
      /\.(?:ack|deliver|acquireLease)$/u.test(call.nsid)
    ).length;

    if (step.op === "inbox") {
      const result = Schema.decodeUnknownSync(Listed)(
        await real.call("inbox", { after: 0 })
      );

      expect(result.messages.map((item) => item.id)).toEqual(
        real.messages
          .filter((_, index) => model.states[index] !== "acked")
          .map((item) => item.event.receipt.message.messageId)
      );
    } else if (step.op === "read") {
      expect(await real.call("read", { id })).toMatchObject({
        message: { id },
      });
    } else if (model.states[step.index] === "acked") {
      expect(await real.call("ack", { ids: [id] })).toMatchObject({
        failed: "NotAttempted",
      });
    } else {
      expect(await real.call("ack", { ids: [id] })).toEqual({ acked: [id] });
      model.states = model.states.map((state, index) => {
        if (index === step.index) {
          return "acked";
        }

        return state === "acked" ? state : "delivered";
      });
    }

    expect(real.messages.map((item) => item.state)).toEqual(model.states);

    if (step.op !== "ack") {
      expect(
        real.calls.filter((call) =>
          /\.(?:ack|deliver|acquireLease)$/u.test(call.nsid)
        ).length
      ).toBe(before);
    }
  },
  toString: () => JSON.stringify(step),
});

it.live.prop(
  "mailbox commands follow a model: peeks never settle, acknowledgements only settle selected ids, and repeated acknowledgements refuse",
  [Schema.Array(Step).check(Schema.isMinLength(1), Schema.isMaxLength(8))],
  ([steps]) =>
    Effect.gen(function* proof() {
      const state = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped()
      );

      const who = yield* people;

      const messages = yield* Effect.forEach([1, 2], (seq) =>
        mail(who, seq, "accepted", {
          body: `mail-${seq}`,
          cc: [],
          thread: `thread-${seq}`,
        }).pipe(Effect.map(terminalReceipt))
      );

      const fake = fakeMailbox(messages);
      yield* Effect.gen(function* runModel() {
        yield* Directory.use((directory) =>
          directory.record("peer", who.peerDocument)
        );
        const mcp = yield* stdio("tester");
        const context = yield* Effect.context();

        const call = (tool: string, args: Schema.Json) =>
          // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check commands need a Promise boundary for the real MCP client.
          Effect.runPromiseWith(context)(mcp.call(tool, args));

        yield* Effect.promise(() =>
          asyncModelRun(
            () => ({
              model: { states: ["accepted", "accepted"] },
              real: { call, calls: fake.calls, messages },
            }),
            steps.map(command)
          )
        );
      }).pipe(
        Effect.provide(
          harness(state, fake.http, [], { secrets: seeded(who) }).pipe(
            Layer.provideMerge(socketLayer)
          )
        )
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 5 }, timeout: 60_000 }
);
