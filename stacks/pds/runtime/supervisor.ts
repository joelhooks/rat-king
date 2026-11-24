import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import path from "node:path";

import {
  accepted,
  command,
  copied,
  online,
  pause,
  quiesced,
  resume,
} from "./control.ts";

const untilStop = async <T>(work: Promise<T>, signal: AbortSignal) => {
  const stopped = Promise.withResolvers<null>();

  const abort = () => {
    stopped.resolve(null);
  };

  signal.addEventListener("abort", abort, { once: true });

  if (signal.aborted) {
    abort();
  }

  try {
    return await Promise.race([work, stopped.promise]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
};

const launch = (args: string[]) => {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "server.ts"), ...args],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] }
  );

  const exited = async () => {
    const result: readonly unknown[] = await once(child, "exit");

    return result;
  };

  const exit = exited();

  const watchExit = async (): Promise<never> => {
    await exit;

    throw new Error("Reference PDS exited without a quiesce or stop request.");
  };

  const unexpected = watchExit();

  const readiness = async () => {
    const messages: readonly unknown[] = await once(child, "message");

    if (messages[0] !== online) {
      throw new Error("Unexpected reference PDS startup response.");
    }
  };

  return {
    ready: Promise.race([readiness(), unexpected]),
    stop: async () => {
      if (child.connected) {
        child.disconnect();
      }

      const kill = setTimeout(() => {
        child.kill("SIGKILL");
      }, 45_000);

      try {
        const [code, signal] = await exit;

        if (code !== 0 || signal !== null) {
          throw new Error(
            "Reference PDS did not exit cleanly; snapshot refused."
          );
        }
      } finally {
        clearTimeout(kill);
      }
    },
    unexpected,
  };
};

const completeLease = async (socket: Socket, signal: AbortSignal) => {
  if (socket.destroyed) {
    return;
  }

  const released = once(socket, "close");
  socket.write(quiesced);

  if ((await untilStop(command(socket, 31 * 60_000), signal)) === copied) {
    socket.end(accepted);
  } else {
    socket.destroy();
  }

  await untilStop(released, signal);
};

const supervise = async (
  location: string,
  args: string[],
  signal: AbortSignal
) => {
  const sockets = new Set<Socket>();
  let ready = Promise.withResolvers<null>();
  let next = Promise.withResolvers<Socket>();
  let lease: Socket | undefined;

  const serve = async (socket: Socket) => {
    const request = await command(socket);

    if (request === resume) {
      await untilStop(ready.promise, signal);

      if (!signal.aborted) {
        socket.end(online);
      }
    } else if (
      request === pause &&
      lease === undefined &&
      !socket.destroyed &&
      !signal.aborted
    ) {
      lease = socket;
      ready = Promise.withResolvers<null>();
      next.resolve(socket);
    } else {
      socket.destroy();
    }
  };

  const listener = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {
      socket.destroy();
    });
    socket.once("close", () => {
      sockets.delete(socket);
    });

    const handle = async () => {
      try {
        await serve(socket);
      } catch {
        socket.destroy();
      }
    };

    void handle();
  });

  listener.listen(location);
  await once(listener, "listening");

  const runUntilPause = async () => {
    const reported = ready;
    const child = launch(args);

    try {
      await untilStop(child.ready, signal);
      reported.resolve(null);

      if (!signal.aborted && process.connected) {
        process.send?.(online);
      }

      return await untilStop(
        Promise.race([next.promise, child.unexpected]),
        signal
      );
    } finally {
      await child.stop();
    }
  };

  try {
    /* oxlint-disable no-await-in-loop -- One child per lease, with no overlap between writer and snapshot. */
    while (!signal.aborted) {
      const requested = await runUntilPause();

      if (requested === null || signal.aborted) {
        break;
      }

      await completeLease(requested, signal);
      next = Promise.withResolvers<Socket>();
      lease = undefined;
    }
    /* oxlint-enable no-await-in-loop */
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }

    listener.close();
  }
};

if (import.meta.main) {
  const [location, ...args] = process.argv.slice(2);

  if (location === undefined) {
    throw new Error(
      "Expected a private control socket and the origin arguments."
    );
  }

  process.umask(0o077);
  const stop = new AbortController();

  const abort = () => {
    stop.abort();
  };

  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  await supervise(location, args, stop.signal);
}
