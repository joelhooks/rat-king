import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { expect } from "vitest";

import { HostShell } from "../src/host-shell.ts";
import {
  commandStarted,
  layer as shellLayer,
  refusedBeforeCommand,
} from "../src/ssh.ts";

const refused = "kex_exchange_identification: Connection closed by remote host";

const fakeSsh = `#!/bin/sh
for last; do :; done
case "$last" in *"uname -s; id -u"*) printf 'Linux\\n1000\\n'; exit 0 ;; esac
n=$(cat "$FAKE_SSH_DIR/count" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$FAKE_SSH_DIR/count"
if [ "$n" -le "$FAKE_SSH_REFUSE" ]; then
  printf '%s\\n' "$FAKE_SSH_STDERR" >&2
  exit 255
fi
eval "$last"
printf ok
if [ "$FAKE_SSH_LATE" = 1 ]; then
  printf '%s\\n' "$FAKE_SSH_STDERR" >&2
  exit 255
fi
`;

const withFakeSsh = (refuse: number, stderr: string, late = false) =>
  Effect.gen(function* fake() {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(`${dir}/ssh`, fakeSsh);
    yield* fs.chmod(`${dir}/ssh`, 0o755);

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const saved = { ...process.env };

        process.env.PATH = `${dir}:${saved.PATH ?? ""}`;
        process.env.FAKE_SSH_DIR = dir;
        process.env.FAKE_SSH_REFUSE = String(refuse);
        process.env.FAKE_SSH_STDERR = stderr;
        process.env.FAKE_SSH_LATE = late ? "1" : "0";

        return saved;
      }),
      (saved) =>
        Effect.sync(() => {
          process.env.PATH = saved.PATH;
          delete process.env.FAKE_SSH_DIR;
          delete process.env.FAKE_SSH_REFUSE;
          delete process.env.FAKE_SSH_STDERR;
          delete process.env.FAKE_SSH_LATE;
        })
    );

    const shell = yield* Effect.gen(function* built() {
      return yield* HostShell;
    }).pipe(
      Effect.provide(
        shellLayer({
          dataRoot: "/srv/example-data",
          home: "/home/example",
          ssh: "example@zzexample",
          tailnetIPv4: "203.0.113.10",
        }).pipe(Layer.provide(NodeServices.layer))
      )
    );

    const outcome = yield* Effect.result(shell.exec(["true"]));
    const calls = Number(yield* fs.readFileString(`${dir}/count`));

    return { calls, outcome };
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const dropped = [
  "kex_exchange_identification: read: Connection reset by peer",
  "ssh_exchange_identification: Connection closed by remote host",
  "Connection closed by UNKNOWN port 65535",
  "Connection reset by 203.0.113.9 port 22",
  "Connection timed out during banner exchange",
  "channel 0: open failed: connect failed: Connection refused",
  "stdio forwarding failed",
];

const droppedStderr = Arbitrary.schema(Schema.Literals(dropped));

const noise = Arbitrary.schema(Schema.String);

const unmarked = (text: string) => text.replaceAll(commandStarted, "");

it.prop(
  "every dropped-before-command stderr form is retried at exit 255",
  { after: noise, before: noise, form: droppedStderr },
  ({ after, before, form }) => {
    expect(
      refusedBeforeCommand(
        255,
        `${unmarked(before)}\n${form}\n${unmarked(after)}`
      )
    ).toBe(true);
  }
);

it.prop(
  "the started marker blocks a retry whatever the stderr says",
  { after: noise, before: noise, form: droppedStderr },
  ({ after, before, form }) => {
    expect(
      refusedBeforeCommand(255, `${before}${commandStarted}${form}\n${after}`)
    ).toBe(false);
  }
);

it.prop(
  "only exit 255 is retried",
  {
    code: Arbitrary.schema(Schema.Int),
    form: droppedStderr,
  },
  ({ code, form }) => {
    expect(refusedBeforeCommand(code === 255 ? 1 : code, form)).toBe(false);
  }
);

it("unrelated ssh stderr is not retried", () => {
  expect(
    refusedBeforeCommand(255, "Connection to host closed by remote host.")
  ).toBe(false);
  expect(
    refusedBeforeCommand(255, "ssh: connect to host port 22: timed out")
  ).toBe(false);
});

it.live(
  "a server that drops the handshake twice is retried and the command runs once",
  () =>
    Effect.gen(function* handshake() {
      const { calls, outcome } = yield* withFakeSsh(2, refused);

      expect(Result.isSuccess(outcome) && outcome.success.stdout).toBe("ok");
      expect(calls).toBe(3);
    })
);

it.live("other ssh failures are not retried", () =>
  Effect.gen(function* other() {
    const { calls, outcome } = yield* withFakeSsh(
      9,
      "Connection to host closed by remote host."
    );

    expect(Result.isFailure(outcome)).toBe(true);
    expect(calls).toBe(1);
  })
);

it.live(
  "a command that started and then failed a nested ssh handshake runs once",
  () =>
    Effect.gen(function* late() {
      const { calls, outcome } = yield* withFakeSsh(0, refused, true);

      expect(Result.isFailure(outcome)).toBe(true);
      expect(calls).toBe(1);
    })
);

it.live("a server that keeps refusing gives up after five retries", () =>
  Effect.gen(function* giveUp() {
    const { calls, outcome } = yield* withFakeSsh(9, refused);

    expect(Result.isFailure(outcome) && outcome.failure).toMatchObject({
      operation: "ssh",
    });
    expect(calls).toBe(6);
  })
);
