import { Effect, Function as Fn } from "effect";
import * as fc from "fast-check";

export interface EffectCommand<Model, Real, E = never, R = never> {
  readonly check: (model: Readonly<Model>) => boolean;
  readonly run: (model: Model, real: Real) => Effect.Effect<void, E, R>;
  readonly toString: () => string;
}

export const runModel = <Model extends object, Real, E, R>(
  setup: () => { model: Model; real: Real },
  commands: readonly EffectCommand<Model, Real, E, R>[]
) =>
  Effect.gen(function* executeModel() {
    const context = yield* Effect.context<R>();

    const adapted = commands.map((command) => ({
      check: command.check.bind(command),
      run: Fn.flow(command.run.bind(command), Effect.runPromiseWith(context)),
      toString: command.toString.bind(command),
    }));

    const run = fc.asyncModelRun<Model, Real, false, Model>;

    yield* Effect.promise(run.bind(null, setup, adapted));
  });
