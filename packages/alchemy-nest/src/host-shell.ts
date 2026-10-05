import { Context, Effect, Layer } from "effect";

import { HostError } from "./host-error.ts";

export { HostError } from "./host-error.ts";

export interface Entry {
  readonly kind: "file" | "directory";
  readonly mode: number;
}

export interface Result {
  readonly code: number;
  readonly stdout: string;
}

export interface Interface {
  readonly exec: (argv: readonly string[]) => Effect.Effect<Result, HostError>;
  readonly read: (
    path: string
  ) => Effect.Effect<Uint8Array | undefined, HostError>;
  readonly stat: (path: string) => Effect.Effect<Entry | undefined, HostError>;
  readonly write: (input: {
    readonly path: string;
    readonly bytes: Uint8Array;
    readonly mode: number;
  }) => Effect.Effect<void, HostError>;
  readonly remove: (path: string) => Effect.Effect<void, HostError>;
  readonly mkdir: (input: {
    readonly path: string;
    readonly mode: number;
  }) => Effect.Effect<void, HostError>;
  readonly rmdir: (path: string) => Effect.Effect<void, HostError>;
}

export class HostShell extends Context.Service<HostShell, Interface>()(
  "@rat-king/HostShell"
) {}

export const must = Effect.fn("HostShell.must")(function* must(
  shell: Interface,
  argv: readonly string[]
) {
  const result = yield* shell.exec(argv);

  if (result.code !== 0) {
    return yield* new HostError({
      operation: "exec",
      reason: "Remote command failed; values redacted.",
    });
  }

  return result.stdout;
});

export const testLayer = (shell: Interface) => Layer.succeed(HostShell, shell);
