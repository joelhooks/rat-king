// @effect-diagnostics nodeBuiltinImport:off -- Shell bootstrap is exercised through disposable fake executables.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Schema } from "effect";
import { describe, expect } from "vitest";

const script = (file: string, body: string) => {
  writeFileSync(file, `#!/usr/bin/env bash\nset -eu\n${body}\n`, {
    mode: 0o700,
  });
};

const lostMessage =
  "ensure: node state lost; ask the desk for a fresh one-time key sealed to the host key";

interface Options {
  readonly backend: "Running" | "NeedsLogin";
  readonly socket: boolean;
  readonly state: boolean;
  readonly storedKey: boolean;
  readonly upFails: boolean;
}

const run = (options: Options, args: readonly string[], keyMode = 0o600) => {
  const home = mkdtempSync(path.join(tmpdir(), "grokbox-ensure-"));

  try {
    const bin = path.join(home, ".local/tailscale/bin");
    const fake = path.join(home, "fake");
    const runtime = path.join(home, "runtime");
    const runDir = path.join(runtime, `tailscale-${process.getuid?.()}`);
    const privateDir = path.join(home, ".local/share/rat-king");
    const stateDir = path.join(home, ".local/share/tailscale");

    for (const dir of [
      bin,
      fake,
      runDir,
      privateDir,
      stateDir,
      path.join(home, ".config/rat-king"),
      path.join(home, "repo/.git"),
      path.join(home, "repo/node_modules"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    const sha = "a".repeat(40);
    script(
      path.join(bin, "tailscale"),
      `if [[ "$1" == version ]]; then echo 1.2.3; elif [[ "$*" == *status* ]]; then echo '{"BackendState":"${options.backend}"}'; else printf '%s\\n' "$@" >> "$HOME/up-log"; ${options.upFails ? "exit 1" : "true"}; fi`
    );
    script(path.join(bin, "tailscaled"), "exit 99");
    script(path.join(fake, "git"), `echo ${sha}`);
    script(path.join(fake, "corepack"), "exit 99");
    script(path.join(fake, "curl"), "printf 200");
    writeFileSync(path.join(privateDir, `deps-${sha}`), "");

    if (options.state) {
      writeFileSync(path.join(stateDir, "tailscaled.state"), "{}");
    }

    if (options.storedKey) {
      writeFileSync(
        path.join(privateDir, "tailnet.key"),
        "stored-key-not-a-credential",
        { mode: 0o600 }
      );
    }

    const oneTime = path.join(runDir, "join.key");
    writeFileSync(oneTime, "one-time-key-not-a-credential", { mode: keyMode });
    writeFileSync(
      path.join(home, ".config/rat-king/pi.json"),
      JSON.stringify({ endpoint: "https://mailbox.example.invalid" })
    );

    if (options.socket) {
      expect(
        spawnSync("python3", [
          "-c",
          "import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])",
          path.join(runDir, "tailscaled.sock"),
        ]).status
      ).toBe(0);
    }

    const result = spawnSync(
      "bash",
      [
        path.resolve("tools/grokbox/ensure.sh"),
        ...args.map((a) => a.replace("@KEY", oneTime)),
      ],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${fake}:${process.env.PATH}`,
          RATKING_CONFIG: path.join(home, ".config/rat-king/pi.json"),
          RATKING_REPO: path.join(home, "repo"),
          RATKING_SHA: sha,
          TS_HOSTNAME: "example-bot-host",
          TS_VERSION: "1.2.3",
          XDG_RUNTIME_DIR: runtime,
        },
      }
    );

    const upLog = path.join(home, "up-log");

    return {
      keyExists: existsSync(oneTime),
      result,
      upLog: existsSync(upLog) ? readFileSync(upLog, "utf-8") : "",
    };
  } finally {
    expect(spawnSync("gio", ["trash", home]).status).toBe(0);
  }
};

const base: Options = {
  backend: "NeedsLogin",
  socket: true,
  state: false,
  storedKey: false,
  upFails: false,
};

// oxlint-disable-next-line no-comments/no-comments -- Explain the platform-specific test skip.
describe.skipIf(process.platform !== "linux")("Linux-only ensure.sh", () => {
  it.prop(
    "--join uses the one-time key once and deletes it whether up succeeds or fails",
    [Schema.Boolean, Schema.Boolean],
    ([upFails, storedKey]) => {
      const out = run({ ...base, storedKey, upFails }, ["--join", "@KEY"]);
      expect(out.result.status).toBe(upFails ? 1 : 0);
      expect(out.keyExists).toBe(false);
      expect(out.upLog).toContain("--auth-key=file:");
      expect(out.upLog).not.toContain("tailnet.key");
      expect(out.upLog).not.toContain("not-a-credential");
    },
    { arbitrary: { runs: 4 } }
  );

  it.prop(
    "a stored tailnet.key is never read: without --join a logged-out node refuses and never calls up",
    [Schema.Boolean],
    ([state]) => {
      const out = run({ ...base, state, storedKey: true }, []);
      expect(out.result.status).toBe(1);
      expect(out.result.stderr).toContain(lostMessage);
      expect(out.upLog).toBe("");
    },
    { arbitrary: { runs: 2 } }
  );

  it("lost state with no daemon refuses with the exact message and never calls up", () => {
    const out = run({ ...base, socket: false }, []);
    expect(out.result.status).toBe(1);
    expect(out.result.stderr).toContain(lostMessage);
    expect(out.upLog).toBe("");
  });

  it("an existing state and a running node is a no-op health pass", () => {
    const out = run({ ...base, backend: "Running", state: true }, []);
    expect(out.result.status).toBe(0);
    expect(out.result.stdout).toContain("ensure: healthy");
    expect(out.upLog).toBe("");
  });

  it("a --join file that fails the checks is refused and left untouched", () => {
    const out = run(base, ["--join", "@KEY"], 0o644);
    expect(out.result.status).toBe(1);
    expect(out.keyExists).toBe(true);
    expect(out.result.stderr).toContain(
      "not deleting a file that failed the checks"
    );
    expect(out.upLog).toBe("");
  });
});
