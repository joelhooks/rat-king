import {
  loadSettings,
  NotConfigured,
  Settings,
} from "@rat-king/ratking-client/config";
import { secretSource } from "@rat-king/ratking-client/systemd-credentials";
import { Effect, Layer } from "effect";

export const loadPiSettings = Effect.fn("PiRatKing.loadSettings")(
  function* loadPiSettings() {
    const source = yield* secretSource.pipe(
      Effect.mapError(
        () =>
          new NotConfigured({
            reason: "Invalid RAT_KING_SECRET_SOURCE; Pi requires agent-secrets",
          })
      )
    );

    if (source === "systemd") {
      return yield* new NotConfigured({
        reason:
          "RAT_KING_SECRET_SOURCE=systemd is reserved for service units; Pi requires agent-secrets",
      });
    }

    return yield* loadSettings();
  }
);

export const settingsLayer = Layer.effect(Settings, loadPiSettings());
