import { createConnection } from "node:net";
import type { Socket } from "node:net";

export const pause = "P";

export const resume = "R";

export const quiesced = "Q";

export const online = "O";

export const copied = "D";

export const accepted = "C";

export const command = async (socket: Socket, timeoutMs = 90_000) => {
  const response = Promise.withResolvers<string | null>();

  const closed = () => {
    response.resolve(null);
  };

  const read = () => {
    const byte: unknown = socket.read(1);

    if (Buffer.isBuffer(byte)) {
      response.resolve(byte.toString());
    } else if (socket.destroyed || socket.readableEnded) {
      closed();
    }
  };

  const timeout = setTimeout(closed, timeoutMs);
  socket.on("readable", read);
  socket.once("close", closed);
  read();

  try {
    return await response.promise;
  } finally {
    clearTimeout(timeout);
    socket.off("readable", read);
    socket.off("close", closed);
  }
};

export const withControl = async <T>(
  location: string,
  use: (socket: Socket) => Promise<T>
) => {
  const socket = createConnection(location);
  socket.on("error", () => {
    socket.destroy();
  });

  try {
    return await use(socket);
  } finally {
    socket.destroy();
  }
};

export const recover = async (location: string) => {
  await withControl(location, async (socket) => {
    socket.write(resume);

    if ((await command(socket)) !== online) {
      throw new Error("PDS did not return to online state after the snapshot.");
    }
  });
};
