import { spawn } from "node:child_process";
import { once } from "node:events";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import { ageRecipient } from "./recipient.ts";

const awaitSuccess = async (child: ReturnType<typeof spawn>, stage: string) => {
  const result: readonly unknown[] = await once(child, "close");

  if (result[0] !== 0 || result[1] !== null) {
    throw new Error(`PDS archive ${stage} failed.`);
  }
};

export const encryptArchive = async ({
  age,
  destination,
  generation,
  recipient,
}: {
  readonly age: string;
  readonly destination: string;
  readonly generation: string;
  readonly recipient: string;
}) => {
  if (!ageRecipient.test(recipient)) {
    throw new Error("Expected a native age X25519 recipient.");
  }

  await using output = await open(destination, "wx", 0o600);

  const archive = spawn("/usr/bin/tar", ["-C", generation, "-cf", "-", "."], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const encrypted = spawn(age, ["-r", recipient], {
    stdio: ["pipe", output.fd, "inherit"],
  });

  const done = [awaitSuccess(archive, "tar"), awaitSuccess(encrypted, "age")];

  try {
    if (archive.stdout === null || encrypted.stdin === null) {
      throw new Error("PDS archive pipe was not created.");
    }

    await Promise.all([...done, pipeline(archive.stdout, encrypted.stdin)]);
    await output.sync();
  } catch (error) {
    archive.kill();
    encrypted.kill();
    await Promise.allSettled(done);
    throw error;
  }
};
