import { it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";
import * as fc from "fast-check";
import type { Command } from "fast-check";
import { expect } from "vitest";

import { inbox } from "../src/pending.ts";
import type { PendingMail } from "../src/pending.ts";

const Operation = Schema.Struct({
  action: Schema.Literals(["take", "tick", "shown", "withdraw", "clear"]),
  id: Schema.Literals(["a", "b", "c"]),
  minutes: Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 0 })),
  timed: Schema.Boolean,
  wake: Schema.Boolean,
});

interface Held {
  deadline: number | undefined;
  emitted: boolean;
  id: string;
  minutes: number;
  wake: boolean;
}

interface Model {
  elapsed: number;
  lastEmission: number | undefined;
  mails: Held[];
  output: string[];
}

interface Real {
  box: ReturnType<typeof inbox>;
  output: string[];
}

const emitted = (mails: readonly { id: string }[], variant: string) =>
  `${variant}:${mails.map((mail) => mail.id).join(",")}`;

const command = (op: typeof Operation.Type): Command<Model, Real> => ({
  check: () => true,
  run: (model, real) => {
    if (op.action === "take") {
      if (!model.mails.some((mail) => mail.id === op.id)) {
        model.mails.push({
          deadline: op.timed ? model.elapsed + op.minutes * 60_000 : undefined,
          emitted: false,
          id: op.id,
          minutes: op.minutes,
          wake: op.wake,
        });
      }

      const mail: PendingMail = {
        content: op.id,
        details: {},
        digestMinutes: op.minutes,
        id: op.id,
        notBefore: op.timed ? model.elapsed + op.minutes * 60_000 : undefined,
        wake: op.wake,
        wakeSender: "fixture",
        watch: op.id,
      };

      real.box.take(mail, "digest");
    }

    if (op.action === "tick") {
      model.elapsed += op.minutes * 60_000;

      const due = model.mails.filter(
        (mail) =>
          !mail.emitted &&
          (mail.deadline === undefined || mail.deadline <= model.elapsed)
      );

      const interval = Math.min(
        ...due.map((mail) =>
          mail.deadline === undefined ? mail.minutes * 60_000 : 0
        )
      );

      if (model.lastEmission === undefined) {
        model.lastEmission = model.elapsed;
      } else if (
        due.length > 0 &&
        model.elapsed - model.lastEmission >= interval
      ) {
        model.lastEmission = model.elapsed;
        model.output.push(
          emitted(
            due.toReversed(),
            due.every((mail) => mail.wake) ? "wake" : "cc"
          )
        );

        for (const mail of due) {
          mail.emitted = true;
        }
      }

      real.box.tick(model.elapsed);
    }

    if (op.action === "shown") {
      model.mails = model.mails.filter((mail) => mail.id !== op.id);
      real.box.shown(op.id);
    }

    if (op.action === "withdraw") {
      const removable = model.mails.filter(
        (mail) => mail.id === op.id && !mail.emitted
      );

      expect(real.box.withdraw(op.id, "fixture")).toEqual(
        removable.map((mail) => mail.id)
      );
      model.mails = model.mails.filter((mail) => !removable.includes(mail));
    }

    if (op.action === "clear") {
      model.mails = [];
      model.lastEmission = undefined;
      real.box.clear();
    }

    expect(real.output).toEqual(model.output);
  },
  toString: () => JSON.stringify(op),
});

it.prop(
  "mixed digest deadlines retain custody through emissions, withdrawal, display, redelivery and clear",
  [Arbitrary.schema(Schema.Array(Operation).check(Schema.isMaxLength(60)))],
  ([operations]) => {
    fc.modelRun(() => {
      const output: string[] = [];

      return {
        model: { elapsed: 0, lastEmission: undefined, mails: [], output: [] },
        real: {
          box: inbox({
            digest: (mails, variant) => {
              output.push(emitted(mails, variant ?? "cc"));
            },
            show: () => {
              throw new Error("digest mail must not show individually");
            },
          }),
          output,
        },
      };
    }, operations.map(command));
  },
  { arbitrary: { runs: 200, seed: 31_337 } }
);

const ReentrantIds = Schema.Literals(["a", "b", "c"]);

it("synchronous display acknowledgment releases digest custody for redelivery", () => {
  fc.assert(
    fc.property(fc.constantFrom(...ReentrantIds.literals), (id) => {
      const output: string[] = [];

      const box = inbox({
        digest: (mails) => {
          for (const mail of mails) {
            output.push(mail.id);
            box.shown(mail.id);
          }
        },
        show: () => {
          throw new Error("unexpected individual delivery");
        },
      });

      const mail = { content: id, details: {}, digestMinutes: 0, id };
      box.tick(0);
      box.take(mail, "digest");
      box.tick(0);
      box.take(mail, "digest");
      box.tick(0);
      expect(output).toEqual([id, id]);
    }),
    { numRuns: 20, seed: 31_337 }
  );
});
