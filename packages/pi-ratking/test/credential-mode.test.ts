import { NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { NotConfigured, Settings } from "@rat-king/ratking-client/config";
import { ConfigProvider, Effect, FileSystem, Layer, Schema } from "effect";
import { expect } from "vitest";

import { settingsLayer } from "../src/pi-settings.ts";

it.effect.prop(
  "Pi stays on legacy settings by default and rejects invalid or inherited systemd mode before reading any config",
  [Schema.Literals(["unset", "invalid", "systemd"])],
  ([mode]) =>
    Effect.gen(function* verify() {
      const reads: string[] = [];

      const files = FileSystem.layerNoop({
        readFileString: (file) =>
          Effect.sync(() => {
            reads.push(file);

            return JSON.stringify({
              didTemplate: "did:web:{agent}.example.invalid",
              endpoint: "https://mailbox.example.invalid",
              serviceDid: "did:web:service.example.invalid",
            });
          }),
      });

      const config = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          HOME: "/fixture",
          RAT_KING_SECRET_SOURCE: mode === "unset" ? undefined : mode,
        })
      );

      const read = Settings.pipe(
        Effect.provide(
          settingsLayer.pipe(Layer.provide([files, NodePath.layer, config]))
        )
      );

      if (mode === "unset") {
        const settings = yield* read;
        expect(settings.secretsCommand).toBe("secrets");
        expect(settings.state).toBe("/fixture/.local/state/rat-king/pi");
        expect(reads).toEqual(["/fixture/.config/rat-king/pi.json"]);
      } else {
        const error = yield* read.pipe(Effect.flip);
        expect(Schema.is(NotConfigured)(error)).toBe(true);
        expect(error.reason).toContain("Pi requires agent-secrets");
        expect(reads).toEqual([]);
      }
    }),
  { arbitrary: { runs: 9 } }
);
