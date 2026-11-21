// @effect-diagnostics asyncFunction:off -- fast-check owns the Promise model boundary.
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Option, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { inbox } from "../src/pending.ts";
import type { PendingMail } from "../src/pending.ts";
import { receiveWake } from "../src/wake-record.ts";

interface Model {
  readonly acked: string[];
  readonly pending: Map<string, string>;
  readonly shown: string[];
}

interface Real {
  readonly acked: string[];
  readonly box: ReturnType<typeof inbox>;
  readonly shown: string[];
}

const Operation = Schema.Literals([
  "matched",
  "cancelled",
  "unverifiedCancel",
  "otherSenderCancel",
  "targetGone",
  "idle",
  "shown",
  "tick",
]);

const isCancellation = (operation: string) =>
  ["cancelled", "unverifiedCancel", "otherSenderCancel"].includes(operation);

const arrival = (operation: string, id: string) => ({
  did: operation === "otherSenderCancel" ? "did:key:other" : "did:key:invented",
  from: "worker",
  id,
  record: {
    $type: "sh.mschf.agentgraph.wake",
    finishedAt: "2026-01-01T00:01:00Z",
    kind: "pane_output",
    label: "Worker",
    result: "pane result",
    source: "herdr_watch",
    startedAt: "2026-01-01T00:00:00Z",
    status: isCancellation(operation) ? "cancelled" : operation,
    text: "Expanded text",
    watch: "watch-a",
  },
  replyTo: Option.none<string>(),
  verified: operation !== "unverifiedCancel",
});

const step = (
  operation: typeof Operation.Type,
  id: string,
  model: Model,
  real: Real
) => {
  if (operation === "matched") {
    model.pending.set(id, "held");
  }

  if (operation === "targetGone") {
    model.pending.set(id, "shown");
    model.shown.push(id);
  }

  if (operation === "cancelled") {
    for (const [key, state] of model.pending) {
      if (state === "held") {
        model.acked.push(key);
        model.pending.delete(key);
      }
    }
  }

  if (isCancellation(operation)) {
    model.acked.push(id);
  }

  if (operation === "idle") {
    for (const [key, state] of model.pending) {
      if (state === "held") {
        model.shown.push(key);
        model.pending.set(key, "shown");
      }
    }

    real.box.flushNext();
  }

  if (operation === "shown") {
    for (const [key, state] of model.pending) {
      if (state === "shown") {
        model.acked.push(key);
        model.pending.delete(key);
        real.acked.push(key);
        real.box.shown(key);
      }
    }
  }

  if (operation === "tick") {
    real.box.tick(60_000);
  }

  if (
    operation === "matched" ||
    operation === "targetGone" ||
    isCancellation(operation)
  ) {
    receiveWake(
      {
        consume: (key) => {
          real.acked.push(key);
        },
        take: real.box.take,
        withdraw: real.box.withdraw,
      },
      arrival(operation, id),
      false,
      0
    );
  }

  expect(real.shown).toEqual(model.shown);
  expect(real.acked).toEqual(model.acked);
};

it.effect.prop(
  "wake custody model: Next holds, only verified same-DID withdrawal clears a held wake, failures wake Now, display alone acknowledges",
  [Arbitrary.schema(Schema.Array(Operation).check(Schema.isMaxLength(40)))],
  ([operations]) =>
    Effect.promise(async () => {
      const commands: AsyncCommand<Model, Real>[] = [
        "matched",
        "unverifiedCancel",
        "otherSenderCancel",
        "cancelled",
        "idle",
        "targetGone",
        "shown",
        ...operations,
      ].map((value, index) => {
        const operation = Schema.decodeUnknownSync(Operation)(value);

        return {
          check: () => true,
          run: async (model, real) => {
            step(operation, String(index), model, real);

            await Promise.resolve();
          },
          toString: () => operation,
        };
      });

      await asyncModelRun(() => {
        const shown: string[] = [];

        const show = (mail: PendingMail) => {
          expect(mail.details).toMatchObject({
            body: "Expanded text",
            wake: { result: "pane result" },
          });
          shown.push(mail.id);
        };

        return {
          model: { acked: [], pending: new Map(), shown: [] },
          real: {
            acked: [],
            box: inbox({
              digest: (mails) => {
                for (const mail of mails) {
                  show(mail);
                }
              },
              show,
            }),
            shown,
          },
        };
      }, commands);
    })
);
