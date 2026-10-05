// @effect-diagnostics nodeBuiltinImport:off -- Provider adapters hash the exact bytes installed on Linux.
import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";

import { absent } from "./absent.ts";
import { HostError, must } from "./host-shell.ts";
import type { Interface } from "./host-shell.ts";

export const AbsolutePath = Schema.String.check(
  Schema.isPattern(
    /^\/(?!$)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\/\/)[^\r\n\0]*[^/\r\n\0]$/u
  )
);

export const Mode = Schema.Int.check(
  Schema.isBetween({ maximum: 0o777, minimum: 0 })
);

export const FileSchema = Schema.Struct({
  content: Schema.String,
  mode: Schema.optionalKey(Mode),
  path: AbsolutePath,
});

export type FileProps = typeof FileSchema.Type;

export interface FileAttributes {
  readonly path: string;
  readonly sha256: string;
  readonly mode: number;
}

export const DirectorySchema = Schema.Struct({
  mode: Schema.optionalKey(Mode),
  path: AbsolutePath,
});

export type DirectoryProps = typeof DirectorySchema.Type;

export interface DirectoryAttributes {
  readonly path: string;
  readonly mode: number;
}

export const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const textDigest = (text: string): string =>
  digest(new TextEncoder().encode(text));

export const refuse = (reason: string) =>
  new HostError({ operation: "provider", reason });

export const validateFile = (props: FileProps) =>
  Schema.decodeEffect(FileSchema)(props).pipe(
    Effect.mapError(() => refuse("Invalid file declaration."))
  );

export const validateDirectory = (props: DirectoryProps) =>
  Schema.decodeEffect(DirectorySchema)(props).pipe(
    Effect.mapError(() => refuse("Invalid directory declaration."))
  );

export const readFile = Effect.fn("RemoteFile.read")(function* readFile(
  shell: Interface,
  path: string
) {
  const entry = yield* shell.stat(path);

  if (entry === undefined) {
    return absent;
  }

  if (entry.kind !== "file") {
    return yield* refuse("Expected a regular file.");
  }

  const bytes = yield* shell.read(path);

  if (bytes === undefined) {
    return yield* refuse("File disappeared while reading.");
  }

  return {
    mode: entry.mode,
    path,
    sha256: digest(bytes),
  } satisfies FileAttributes;
});

export const reconcileBytes = Effect.fn("RemoteFile.reconcileBytes")(
  function* reconcileBytes(
    shell: Interface,
    input: {
      readonly path: string;
      readonly bytes: Uint8Array;
      readonly mode: number;
    },
    output: FileAttributes | undefined,
    adopt: boolean
  ) {
    if (output !== undefined && output.path !== input.path) {
      return yield* refuse("Path changes require replacement.");
    }

    const before = yield* readFile(shell, input.path);
    const sha256 = digest(input.bytes);

    if (before !== undefined && output === undefined && !adopt) {
      return yield* refuse("Existing file requires explicit adoption.");
    }

    if (before?.sha256 !== sha256) {
      yield* shell.write(input);
    } else if (before.mode !== input.mode) {
      yield* must(shell, ["chmod", input.mode.toString(8), "--", input.path]);
    }

    const after = yield* readFile(shell, input.path);

    if (
      after === undefined ||
      after.sha256 !== sha256 ||
      after.mode !== input.mode
    ) {
      return yield* refuse("Installed file failed readback.");
    }

    return after;
  }
);

export const reconcileFile = Effect.fn("RemoteFile.reconcile")(
  function* reconcileFile(
    shell: Interface,
    props: FileProps,
    output: FileAttributes | undefined,
    adopt: boolean
  ) {
    const valid = yield* validateFile(props);

    return yield* reconcileBytes(
      shell,
      {
        bytes: new TextEncoder().encode(valid.content),
        mode: valid.mode ?? 0o644,
        path: valid.path,
      },
      output,
      adopt
    );
  }
);

export const deleteFile = Effect.fn("RemoteFile.delete")(function* deleteFile(
  shell: Interface,
  output: FileAttributes
) {
  const live = yield* readFile(shell, output.path);

  if (live !== undefined) {
    yield* shell.remove(output.path);
  }
});

export const readDirectory = Effect.fn("HostDirectory.read")(
  function* readDirectory(shell: Interface, path: string) {
    const entry = yield* shell.stat(path);

    if (entry === undefined) {
      return absent;
    }

    if (entry.kind !== "directory") {
      return yield* refuse("Expected a directory.");
    }

    return { mode: entry.mode, path } satisfies DirectoryAttributes;
  }
);

export const reconcileDirectory = Effect.fn("HostDirectory.reconcile")(
  function* reconcileDirectory(
    shell: Interface,
    props: DirectoryProps,
    output: DirectoryAttributes | undefined,
    adopt: boolean
  ) {
    const valid = yield* validateDirectory(props);

    if (output !== undefined && output.path !== valid.path) {
      return yield* refuse("Path changes require replacement.");
    }

    const before = yield* readDirectory(shell, valid.path);
    const mode = valid.mode ?? 0o755;

    if (before !== undefined && output === undefined && !adopt) {
      return yield* refuse("Existing directory requires explicit adoption.");
    }

    if (before === undefined) {
      yield* shell.mkdir({ mode, path: valid.path });
    } else if (before.mode !== mode) {
      yield* must(shell, ["chmod", mode.toString(8), "--", valid.path]);
    }

    const after = yield* readDirectory(shell, valid.path);

    if (after === undefined || after.mode !== mode) {
      return yield* refuse("Directory failed readback.");
    }

    return after;
  }
);

export const deleteDirectory = Effect.fn("HostDirectory.delete")(
  function* deleteDirectory(shell: Interface, output: DirectoryAttributes) {
    if ((yield* readDirectory(shell, output.path)) !== undefined) {
      yield* shell.rmdir(output.path);
    }
  }
);
