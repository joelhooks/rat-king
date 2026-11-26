// @effect-diagnostics nodeBuiltinImport:off asyncFunction:off -- This Node adapter needs O_NOFOLLOW and descriptor chmod, absent from Effect FileSystem.
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Option, Schema } from "effect";

import { JEV_MODEL } from "./jev-shadow.ts";
import type { ClassifyJev, ShadowRowValue } from "./jev-shadow.ts";

export const piClassifier =
  (
    registry: Pick<
      ExtensionContext["modelRegistry"],
      "findOfType" | "classify" | "getProvider"
    >
  ): ClassifyJev =>
  (question) =>
    Effect.gen(function* classifyInPi() {
      const model = registry.findOfType("classifier", "typesafe", JEV_MODEL);
      const auth = registry.getProvider("typesafe")?.auth.apiKey;

      if (model === undefined || auth === undefined) {
        return yield* Effect.fail("unavailable" as const);
      }

      const resolved = yield* Effect.tryPromise({
        catch: () => "provider-error" as const,
        try: async (signal) =>
          await auth.resolve({
            ctx: {
              // oxlint-disable-next-line require-await -- Pi's auth context returns a Promise even for a synchronous environment lookup.
              env: async (name) => process.env[name],
              // oxlint-disable-next-line require-await -- Environment-only auth never opens a credential file.
              fileExists: async () => false,
            },
            signal,
          }),
      });

      const key = resolved?.auth.apiKey;

      if (key === undefined || key.trim() === "") {
        return yield* Effect.fail("no-key" as const);
      }

      const result = yield* Effect.tryPromise({
        catch: () => "provider-error" as const,
        try: async (signal) =>
          await registry.classify(
            model,
            {
              questions: {
                attention: {
                  criteria: {
                    false: "Does not need attention or an answer now",
                    true: "Needs attention or an answer now",
                  },
                  instructions: question.judgment,
                  type: "bool",
                },
              },
              state: { ...question.state },
            },
            { apiKey: key, signal }
          ),
      });

      const answer = result.answers.attention;

      if (result.stopReason !== "stop" || answer?.type !== "bool") {
        return yield* Effect.fail("provider-error" as const);
      }

      return {
        inputTokens: result.usage?.input ?? null,
        outputTokens: result.usage?.output ?? null,
        probability: answer.probability,
      };
    });

const ReaderName = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)*$/u)
);

const flags =
  // oxlint-disable-next-line no-bitwise -- POSIX open takes a flags bitmask.
  constants.O_WRONLY |
  constants.O_APPEND |
  constants.O_CREAT |
  constants.O_NOFOLLOW |
  constants.O_NONBLOCK;

export const shadowJournal =
  (state: string) => (reader: string, row: ShadowRowValue) =>
    Effect.tryPromise(async () => {
      if (Option.isNone(Schema.decodeOption(ReaderName)(reader))) {
        return;
      }

      const directory = path.join(state, "jev-shadow");
      await mkdir(directory, { mode: 0o700, recursive: true });

      const file = await open(
        path.join(directory, `${reader.replaceAll("/", ".")}.jsonl`),
        flags,
        0o600
      );

      try {
        const stat = await file.stat();

        if (!stat.isFile() || stat.nlink !== 1) {
          return;
        }

        // oxlint-disable-next-line no-bitwise -- Only the permission bits should be compared.
        if ((stat.mode & 0o777) !== 0o600) {
          await file.chmod(0o600);
        }

        await file.appendFile(`${JSON.stringify(row)}\n`);
      } finally {
        await file.close();
      }
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning("Rat King Jev shadow journal write failed")
      ),
      Effect.ignore
    );
