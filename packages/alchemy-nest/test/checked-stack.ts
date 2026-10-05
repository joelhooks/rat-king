// @effect-diagnostics anyUnknownInErrorContext:off -- Alchemy beta.79's scratch harness declares any errors; this test-only adapter turns them into test defects.
import type { ScratchStack } from "alchemy/Test/Vitest";
import { Effect } from "effect";

export const checkedStack = (stack: ScratchStack) => ({
  deploy: <A, E, R>(program: Effect.Effect<A, E, R>) =>
    stack.deploy(program).pipe(Effect.orDie),
  destroy: () => stack.destroy().pipe(Effect.orDie),
  plan: <A, E, R>(program: Effect.Effect<A, E, R>) =>
    stack.plan(program).pipe(Effect.orDie),
});
