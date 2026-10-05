import { Effect } from "effect";

import { HostShell, HostError } from "./host-shell.ts";
import type { Interface, Result } from "./host-shell.ts";

export interface Call {
  readonly operation: string;
  readonly argv: readonly string[];
}

interface StoredFile {
  readonly bytes: Uint8Array;
  readonly mode: number;
}

interface Unit {
  readonly path: string;
  readonly loaded: string;
  readonly active: boolean;
  readonly enabled: boolean;
}

export const makeFakeShell = Effect.fn("HostShell.fake")(() =>
  Effect.sync(() => {
    const files = new Map<string, StoredFile>();

    const directories = new Map<string, number>([
      ["/home/example/.config/systemd/user", 0o755],
      ["/srv/example", 0o755],
    ]);

    const units = new Map<string, Unit>();
    const calls: Call[] = [];
    let failStart = false;

    const record = (operation: string, argv: readonly string[]) =>
      calls.push({ argv, operation });

    const chmod = (argv: readonly string[]): Result => {
      const [, rawMode, , path] = argv;

      if (path === undefined) {
        return { code: 1, stdout: "" };
      }

      const mode = Number.parseInt(rawMode ?? "", 8);
      const file = files.get(path);

      if (file !== undefined) {
        files.set(path, { ...file, mode });
      } else if (directories.has(path)) {
        directories.set(path, mode);
      } else {
        return { code: 1, stdout: "" };
      }

      return { code: 0, stdout: "" };
    };

    const reload = (): Result => {
      for (const [path, file] of files) {
        if (!/\.(?:service|slice)$/u.test(path)) {
          continue;
        }

        const key = path.slice(path.lastIndexOf("/") + 1);
        const prior = units.get(key);
        units.set(key, {
          active: prior?.active ?? false,
          enabled: prior?.enabled ?? false,
          loaded: new TextDecoder().decode(file.bytes),
          path,
        });
      }

      for (const [key, unit] of units) {
        if (!files.has(unit.path) && !unit.active && !unit.enabled) {
          units.delete(key);
        }
      }

      return { code: 0, stdout: "" };
    };

    const show = (name: string): Result => {
      const unit = units.get(name);

      if (unit === undefined) {
        return {
          code: 0,
          stdout: "LoadState=not-found\nActiveState=inactive\n",
        };
      }

      return {
        code: 0,
        stdout: `LoadState=loaded\nActiveState=${unit.active ? "active" : "inactive"}\nSubState=${unit.active ? "running" : "dead"}\nUnitFileState=${unit.enabled ? "enabled" : "disabled"}\nNeedDaemonReload=${new TextDecoder().decode(files.get(unit.path)?.bytes) === unit.loaded ? "no" : "yes"}\nFragmentPath=${unit.path}\n`,
      };
    };

    const changeUnit = (action: string, name: string): Result => {
      const unit = units.get(name);

      if (unit === undefined) {
        return { code: 1, stdout: "" };
      }

      if ((action === "start" || action === "restart") && failStart) {
        failStart = false;

        return { code: 1, stdout: "" };
      }

      if (action === "enable" || action === "disable") {
        units.set(name, { ...unit, enabled: action === "enable" });
      } else if (["start", "restart", "stop"].includes(action)) {
        units.set(name, { ...unit, active: action !== "stop" });
      } else {
        return { code: 1, stdout: "" };
      }

      return { code: 0, stdout: "" };
    };

    const shell: Interface = {
      exec: Effect.fn("HostShell.fake.exec")(function* exec(argv) {
        record("exec", argv);
        const [program, scope, action = "", name = ""] = argv;

        if (program === "chmod") {
          return chmod(argv);
        }

        if (program !== "systemctl" || scope !== "--user") {
          return yield* new HostError({
            operation: "exec",
            reason: "Fake refuses unknown command.",
          });
        }

        if (action === "daemon-reload") {
          return reload();
        }

        if (action === "show") {
          return show(name);
        }

        return changeUnit(action, name);
      }),
      mkdir: Effect.fn("HostShell.fake.mkdir")(function* mkdir({ path, mode }) {
        record("mkdir", [path]);

        if (
          !directories.has(path.slice(0, path.lastIndexOf("/"))) ||
          files.has(path) ||
          directories.has(path)
        ) {
          return yield* new HostError({
            operation: "mkdir",
            reason: "Invalid directory creation.",
          });
        }

        directories.set(path, mode);

        return yield* Effect.void;
      }),
      read: Effect.fn("HostShell.fake.read")((path) =>
        Effect.sync(() => {
          record("read", [path]);
          const file = files.get(path);

          return file === undefined ? undefined : new Uint8Array(file.bytes);
        })
      ),
      remove: Effect.fn("HostShell.fake.remove")((path) =>
        Effect.sync(() => {
          record("remove", [path]);
          files.delete(path);
        })
      ),
      rmdir: Effect.fn("HostShell.fake.rmdir")(function* rmdir(path) {
        record("rmdir", [path]);

        if (
          [...files.keys(), ...directories.keys()].some((name) =>
            name.startsWith(`${path}/`)
          )
        ) {
          return yield* new HostError({
            operation: "rmdir",
            reason: "Directory is not empty.",
          });
        }

        directories.delete(path);

        return yield* Effect.void;
      }),
      stat: Effect.fn("HostShell.fake.stat")((path) =>
        Effect.sync(() => {
          record("stat", [path]);
          const file = files.get(path);

          if (file !== undefined) {
            return { kind: "file" as const, mode: file.mode };
          }

          const mode = directories.get(path);

          return mode === undefined
            ? undefined
            : { kind: "directory" as const, mode };
        })
      ),
      write: Effect.fn("HostShell.fake.write")(function* write({
        path,
        bytes,
        mode,
      }) {
        record("write", [path]);

        if (!directories.has(path.slice(0, path.lastIndexOf("/")))) {
          return yield* new HostError({
            operation: "write",
            reason: "Missing parent.",
          });
        }

        files.set(path, { bytes: new Uint8Array(bytes), mode });

        return yield* Effect.void;
      }),
    };

    return {
      calls: () => Effect.sync(() => [...calls]),
      clear: () =>
        Effect.sync(() => {
          calls.length = 0;
        }),
      failStart: () =>
        Effect.sync(() => {
          failStart = true;
        }),
      shell: HostShell.of(shell),
    };
  })
);
