// @effect-diagnostics nodeBuiltinImport:off -- Shell bootstrap is exercised through disposable fake executables.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

const script = (file: string, body: string) => {
  writeFileSync(file, `#!/usr/bin/env bash\nset -eu\n${body}\n`, {
    mode: 0o700,
  });
};

it.prop(
  "ensure skips joined hosts, joins with a file key only, and refuses unsafe key modes",
  [Schema.Boolean],
  ([joined]) => {
    const home = mkdtempSync(path.join(tmpdir(), "grokbox-ensure-"));

    try {
      const bin = path.join(home, ".local/tailscale/bin");
      const fake = path.join(home, "fake");
      const run = path.join(home, ".local/run/tailscale");
      const privateDir = path.join(home, ".local/share/rat-king");

      for (const dir of [
        bin,
        fake,
        run,
        privateDir,
        path.join(home, ".config/rat-king"),
        path.join(home, "repo/.git"),
        path.join(home, "repo/node_modules"),
      ]) {
        mkdirSync(dir, { recursive: true });
      }

      const sha = "a".repeat(40);
      script(
        path.join(bin, "tailscale"),
        `if [[ "$1" == version ]]; then echo 1.2.3; elif [[ "$*" == *status* ]]; then echo '{"BackendState":"${joined ? "Running" : "NeedsLogin"}"}'; else printf '%s\\n' "$@" >> "$HOME/up-log"; fi`
      );
      script(path.join(bin, "tailscaled"), "exit 99");
      script(path.join(fake, "git"), `echo ${sha}`);
      script(path.join(fake, "corepack"), "exit 99");
      script(path.join(fake, "curl"), "printf 200");
      writeFileSync(path.join(privateDir, `deps-${sha}`), "");
      writeFileSync(
        path.join(privateDir, "tailnet.key"),
        "test-key-not-a-credential",
        { mode: 0o600 }
      );
      writeFileSync(
        path.join(home, ".config/rat-king/pi.json"),
        JSON.stringify({ endpoint: "https://mailbox.example.invalid" })
      );
      expect(
        spawnSync("python3", [
          "-c",
          "import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])",
          path.join(run, "tailscaled.sock"),
        ]).status
      ).toBe(0);

      const env = {
        ...process.env,
        HOME: home,
        PATH: `${fake}:${process.env.PATH}`,
        RATKING_CONFIG: path.join(home, ".config/rat-king/pi.json"),
        RATKING_REPO: path.join(home, "repo"),
        RATKING_SHA: sha,
        TS_HOSTNAME: "example-bot-host",
        TS_VERSION: "1.2.3",
      };

      const execute = () =>
        spawnSync("bash", [path.resolve("tools/grokbox/ensure.sh")], {
          encoding: "utf-8",
          env,
        });

      expect(execute().status).toBe(0);
      const environment = readFileSync(path.join(privateDir, "env"), "utf-8");
      expect(environment).toContain("NODE_USE_ENV_PROXY=1");

      if (!joined) {
        const args = readFileSync(path.join(home, "up-log"), "utf-8");
        expect(args).toContain(`--auth-key=file:${privateDir}/tailnet.key`);
        expect(args).not.toContain("test-key-not-a-credential");
        chmodSync(path.join(privateDir, "tailnet.key"), 0o644);
        expect(execute().status).toBe(1);
      }

      expect(execute().status).toBe(joined ? 0 : 1);
    } finally {
      expect(spawnSync("gio", ["trash", home]).status).toBe(0);
    }
  },
  { arbitrary: { runs: 2 } }
);
