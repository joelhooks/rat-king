// @effect-diagnostics nodeBuiltinImport:off -- Exercise bootstrap daemon recovery using a test-owned process and Unix socket.
import { spawn, spawnSync } from "node:child_process";
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

// oxlint-disable-next-line no-comments/no-comments -- Explain the platform-specific test skip.
describe.skipIf(process.platform !== "linux")(
  "Linux-only daemon bootstrap",
  () => {
    it.prop(
      "ensure recovers stale sockets, refuses live unresponsive daemons, and waits for delayed first-start readiness",
      [Schema.Literals(["stale", "live", "delayed"])],
      ([scenario]) => {
        const home = mkdtempSync(path.join(tmpdir(), "grokbox-daemon-"));
        const runtime = path.join(home, "runtime");
        const run = path.join(runtime, `tailscale-${process.getuid?.()}`);
        const sock = path.join(run, "tailscaled.sock");
        const bin = path.join(home, ".local/tailscale/bin");
        const fake = path.join(home, "fake");
        const privateDir = path.join(home, ".local/share/rat-king");
        let ownPid: number | undefined;

        try {
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

          script(
            path.join(bin, "tailscale"),
            'if [[ "$1" == version ]]; then echo 1.2.3; elif [[ "$*" == *status* ]]; then [[ -f "$HOME/ready" ]] || exit 1; echo \'{"BackendState":"NeedsLogin"}\'; else printf "%s\\n" "$@" >> "$HOME/up-log"; fi'
          );
          const daemon = path.join(bin, "tailscaled");
          writeFileSync(
            daemon,
            `#!/usr/bin/env python3\nimport os,socket,sys,time,signal\nhome=os.environ["HOME"]\nwith open(home+"/starts","a") as f: f.write("start\\n")\nif os.environ.get("FAKE_LIVE")=="1": signal.pause()\ntime.sleep(${scenario === "delayed" ? 2 : 0})\nsock=next(a.split("=",1)[1] for a in sys.argv if a.startswith("--socket="))\ns=socket.socket(socket.AF_UNIX);s.bind(sock)\nopen(home+"/ready","w").close()\nsignal.pause()\n`,
            { mode: 0o700 }
          );
          const sha = "b".repeat(40);
          script(path.join(fake, "git"), `echo ${sha}`);
          script(path.join(fake, "corepack"), "exit 99");
          script(path.join(fake, "curl"), "printf 200");
          writeFileSync(path.join(privateDir, `deps-${sha}`), "");
          writeFileSync(path.join(privateDir, "tailnet.key"), "test-value", {
            mode: 0o600,
          });
          writeFileSync(
            path.join(home, ".config/rat-king/pi.json"),
            JSON.stringify({ endpoint: "https://mailbox.example.invalid" })
          );

          const env = {
            ...process.env,
            HOME: home,
            PATH: `${fake}:${process.env.PATH}`,
            RATKING_CONFIG: path.join(home, ".config/rat-king/pi.json"),
            RATKING_REPO: path.join(home, "repo"),
            RATKING_SHA: sha,
            TS_HOSTNAME: "example-host",
            TS_VERSION: "1.2.3",
            XDG_RUNTIME_DIR: runtime,
          };

          if (scenario === "stale") {
            expect(
              spawnSync("python3", [
                "-c",
                "import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1])",
                sock,
              ]).status
            ).toBe(0);
            writeFileSync(path.join(run, "tailscaled.pid"), "999999999\n");
          }

          if (scenario === "live") {
            const child = spawn(daemon, [`--socket=${sock}`], {
              detached: true,
              env: { ...env, FAKE_LIVE: "1" },
              stdio: "ignore",
            });

            ownPid = child.pid;
            child.unref();
            expect(ownPid).toBeDefined();
            writeFileSync(path.join(run, "tailscaled.pid"), `${ownPid}\n`);
          }

          const result = spawnSync(
            "bash",
            [path.resolve("tools/grokbox/ensure.sh")],
            { encoding: "utf-8", env, timeout: 40_000 }
          );

          if (scenario === "live") {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain("live daemon is unresponsive");
          } else {
            expect(result.status).toBe(0);
            ownPid = Number(
              readFileSync(path.join(run, "tailscaled.pid"), "utf-8").trim()
            );
            expect(readFileSync(path.join(home, "starts"), "utf-8")).toBe(
              "start\n"
            );
            expect(readFileSync(path.join(home, "up-log"), "utf-8")).toContain(
              `--auth-key=file:${privateDir}/tailnet.key`
            );
            expect(existsSync(path.join(home, "ready"))).toBe(true);
          }
        } finally {
          if (ownPid !== undefined) {
            process.kill(ownPid, "SIGTERM");
          }

          expect(spawnSync("gio", ["trash", home]).status).toBe(0);
        }
      },
      { arbitrary: { runs: 6 }, timeout: 60_000 }
    );
  }
);
