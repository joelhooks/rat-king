import { InMemory } from "@alchemy.run/domain";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, Layer, Result, Schema } from "effect";
import { asyncModelRun } from "fast-check";
import type { AsyncCommand } from "fast-check";
import { expect } from "vitest";

import { Account } from "../src/identity/account.ts";
import { applyAdmin } from "../src/identity/commands.ts";
import { Identity, IdentityReads } from "../src/identity/identity.ts";
import { AccountDid, Handle } from "../src/identity/names.ts";
import { handleTxtPlan, identityViews } from "../src/identity/views.ts";

const dids = [
  AccountDid.make("did:web:one--sample.example.invalid"),
  AccountDid.make("did:web:two--sample.example.invalid"),
] as const;

const handles = [
  Handle.make("one.sample.example.invalid"),
  Handle.make("two.sample.example.invalid"),
] as const;

const ModelStep = Schema.Struct({
  account: Schema.Literals([0, 1]),
  action: Schema.Literals(["Register", "ClaimHandle", "Retire"]),
  handle: Schema.Literals([0, 1]),
});

type Step = typeof ModelStep.Type;

type Did = typeof AccountDid.Type;

type Name = typeof Handle.Type;

type Status = "unregistered" | "active" | "retired";

interface Model {
  sequence: number;
  readonly status: Map<Did, Status>;
  readonly reserved: Map<Name, Did>;
  readonly current: Map<Did, Name>;
}

const decide = (model: Model, { account, action, handle }: Step) => {
  const did = dids[account];
  const name = handles[handle];
  const status = model.status.get(did) ?? "unregistered";

  if (status === "retired") {
    return "Retired";
  }

  if (action === "Register") {
    if (status === "active") {
      return "AccountExists";
    }

    model.status.set(did, "active");

    return "accepted";
  }

  if (status === "unregistered") {
    return "UnknownAccount";
  }

  if (action === "Retire") {
    model.status.set(did, "retired");
    model.current.delete(did);

    return "accepted";
  }

  const owner = model.reserved.get(name);

  if (owner !== undefined && owner !== did) {
    return "HandleTaken";
  }

  model.reserved.set(name, did);
  model.current.set(did, name);

  return "accepted";
};

const runStep = (model: Model, step: Step) =>
  Effect.gen(function* applyModelStep() {
    const did = dids[step.account];

    const mutation =
      step.action === "ClaimHandle"
        ? { _tag: step.action, handle: handles[step.handle] }
        : { _tag: step.action };

    const expected = decide(model, step);
    model.sequence += 1;

    const actual = yield* applyAdmin({
      commandId: String(model.sequence),
      did,
      mutation,
    }).pipe(Effect.result);

    expect(Result.isSuccess(actual) ? "accepted" : actual.failure._tag).toBe(
      expected
    );

    const reads = yield* IdentityReads.clientInProcess;
    const accounts = yield* Account;

    for (const accountDid of dids) {
      const document = yield* reads.DidDocument({ did: accountDid });
      const current = model.current.get(accountDid);
      expect(document?.id).toBe(
        model.status.has(accountDid) ? accountDid : undefined
      );

      if (model.status.has(accountDid)) {
        expect(document?.alsoKnownAs).toEqual(
          current === undefined ? [] : [`at://${current}`]
        );
      }
    }

    for (const handle of handles) {
      const owner = model.reserved.get(handle);

      const current =
        owner !== undefined && model.current.get(owner) === handle;

      expect(yield* reads.HandleResolution({ handle })).toBe(
        current ? owner : null
      );
    }

    const snapshots = yield* Effect.all(
      dids.map((id) =>
        accounts.get(id).pipe(Effect.map((account) => ({ account, did: id })))
      )
    );

    expect(handleTxtPlan(snapshots)).toEqual(
      [...dids].flatMap((id) => {
        const handle = model.current.get(id);

        return handle === undefined
          ? []
          : [{ name: `_atproto.${handle}`, type: "TXT", value: `did=${id}` }];
      })
    );
  });

type Run = (model: Model, step: Step) => Promise<void>;

const command = (step: Step): AsyncCommand<Model, Run> => ({
  check: () => true,
  // oxlint-disable-next-line typescript/promise-function-async -- fast-check takes a Promise; Effect owns the operation.
  run: (model, run) => run(model, step),
  toString: () => JSON.stringify(step),
});

const memory = Identity.layer(identityViews).pipe(Layer.provide(InMemory));

it.effect.prop(
  "the DID, handle and DNS plan agree as accounts claim, compete for ownership, rename and retire",
  [Arbitrary.schema(Schema.Array(ModelStep).check(Schema.isMaxLength(25)))],
  ([steps]) =>
    Effect.gen(function* checkIdentityLifecycle() {
      const context =
        yield* Effect.context<Effect.Services<ReturnType<typeof runStep>>>();

      const model: Model = {
        current: new Map(),
        reserved: new Map(),
        sequence: 0,
        status: new Map(),
      };

      // oxlint-disable-next-line typescript/promise-function-async -- fast-check takes an Effect runtime promise.
      const run: Run = (state, step) =>
        // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check AsyncCommand requires a Promise at this test boundary.
        Effect.runPromiseWith(context)(
          runStep(state, step).pipe(Effect.scoped)
        );

      // oxlint-disable-next-line typescript/promise-function-async -- This adapter passes fast-check’s promise to Effect.
      const execute = () =>
        asyncModelRun(() => ({ model, real: run }), steps.map(command));

      yield* Effect.promise(execute);
    }).pipe(Effect.provide(memory))
);
