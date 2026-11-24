import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

import { ageRecipient } from "./recipient.ts";

const awaitSuccess = async (child: ReturnType<typeof spawn>, stage: string) => {
  const result: readonly unknown[] = await once(child, "close");

  if (result[0] !== 0 || result[1] !== null) {
    throw new Error(`PDS archive ${stage} failed.`);
  }
};

const hashCiphertext = async (destination: string) => {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(destination)) {
    if (!Buffer.isBuffer(chunk)) {
      throw new TypeError("Expected binary ciphertext on read-back.");
    }

    hash.update(chunk);
  }

  return hash.digest("hex");
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

  const archive = spawn("/usr/bin/tar", ["-C", generation, "-cf", "-", "."], {
    stdio: ["ignore", "pipe", "inherit"],
  });

  const encrypted = spawn(age, ["-r", recipient], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const done = [awaitSuccess(archive, "tar"), awaitSuccess(encrypted, "age")];
  const expected = createHash("sha256");
  let size = 0;

  const hashStream = async function* hashStream(
    source: AsyncIterable<unknown>
  ) {
    for await (const chunk of source) {
      if (!Buffer.isBuffer(chunk)) {
        throw new TypeError("Expected binary age output.");
      }

      size += chunk.length;
      expected.update(chunk);
      yield chunk;
    }
  };

  try {
    if (
      archive.stdout === null ||
      encrypted.stdin === null ||
      encrypted.stdout === null
    ) {
      throw new Error("PDS archive pipe was not created.");
    }

    await Promise.all([
      ...done,
      pipeline(archive.stdout, encrypted.stdin),
      pipeline(
        encrypted.stdout,
        hashStream,
        createWriteStream(destination, { flags: "wx", mode: 0o600 })
      ),
    ]);
    await using output = await open(destination, "r");
    await output.sync();
    const info = await output.stat();

    if (
      size === 0 ||
      info.size !== size ||
      (await hashCiphertext(destination)) !== expected.digest("hex")
    ) {
      throw new Error("PDS snapshot ciphertext failed read-back verification.");
    }
  } catch (error) {
    archive.kill();
    encrypted.kill();
    await Promise.allSettled(done);
    throw error;
  }
};
