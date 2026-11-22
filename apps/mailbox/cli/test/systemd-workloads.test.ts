import { NodeServices } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Schema } from "effect";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../../packages/mailbox-client/test/identity.ts";
import { AlarmSettings } from "../../../../stacks/nest/alarm-config.ts";
import { SealedJson } from "../../../../stacks/nest/seal.ts";
import { ShipSettings } from "../../../../stacks/nest/ship-config.ts";
import { StageConfig } from "../../../../stacks/nest/stage-config.ts";
import { fixtureChild } from "./fixture-child.ts";

const alarmAndDigest = `
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Effect, FileSystem, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { secretStoreLayer } from "./apps/mailbox/cli/secrets.ts";
import { prepareAlarmMail } from "./stacks/nest/alarm-mail.ts";
import { collectDigestWaitingMail } from "./stacks/nest/digest-mail-collector.ts";
import { StageConfig } from "./stacks/nest/stage-config.ts";
NodeRuntime.runMain(Effect.gen(function* check() {
  const file = yield* Config.String("FIXTURE_STAGE");
  const fs = yield* FileSystem.FileSystem;
  const stage = yield* Schema.decodeEffect(Schema.fromJsonString(StageConfig))(yield* fs.readFileString(file));
  const alarm = yield* prepareAlarmMail(stage, [], "").pipe(Effect.flip);
  const digest = yield* collectDigestWaitingMail(stage);
  process.stdout.write(JSON.stringify({ alarm: alarm.reason, digest }));
}).pipe(Effect.scoped, Effect.provide([secretStoreLayer(), FetchHttpClient.layer, NodeServices.layer])));
`;

const fixture = Effect.fn("Test.scopedWorkload")(function* fixture(
  base: typeof StageConfig.Type,
  alarm: typeof AlarmSettings.Type,
  ship: typeof ShipSettings.Type
) {
  const fs = yield* FileSystem.FileSystem;
  const home = yield* fs.makeTempDirectoryScoped();
  const { readerHeartbeats: _remote, ...safeAlarm } = alarm;

  const signer = yield* identity("did:web:operator.example.invalid");
  const peer = yield* identity("did:web:peer.example.invalid");
  const docs = yield* Effect.forEach([signer, peer], document);

  const notify = {
    config: `${home}/pi.json`,
    directory: `${home}/directory.json`,
    secret: "fixture-signer",
  };

  const stageFile = `${home}/stage.json`;
  const credentials = `${home}/credentials`;
  const empty = `${home}/empty-credentials`;
  const fallback = `${home}/fallback`;

  const settings = {
    didTemplate: "did:web:{agent}.example.invalid",
    directory: notify.directory,
    documents: [`${home}/peers.json`],
    endpoint: "https://mailbox.example.invalid",
    reserved: { operator: { did: signer.did }, peer: { did: peer.did } },
    serviceDid: "did:web:service.example.invalid",
    state: home,
  };

  const stage = {
    ...base,
    alarm: {
      ...safeAlarm,
      notify,
      wakeTargets: [{ name: "peer", owner: "peer" }],
    },
    runtime: {
      ...base.runtime,
      HOME: home,
      RAT_KING_ENDPOINT: settings.endpoint,
      RAT_KING_SERVICE_DID: settings.serviceDid,
      RAT_KING_STATE_DIR: home,
    },
    ship,
  };

  yield* fs.writeFileString(
    `${home}/secrets`,
    `#!/bin/sh\nprintf 'fallback' > "$FIXTURE_FALLBACK"\nexit 77\n`,
    { mode: 0o700 }
  );
  yield* fs.makeDirectory(credentials);
  yield* fs.makeDirectory(empty);
  yield* fs.writeFileString(
    `${credentials}/${notify.secret}`,
    JSON.stringify(signer)
  );
  yield* fs.writeFileString(`${home}/peers.json`, JSON.stringify(docs));
  yield* fs.writeFileString(notify.config, JSON.stringify(settings));
  yield* fs.writeFileString(
    stageFile,
    yield* Schema.encodeEffect(Schema.fromJsonString(StageConfig))(stage)
  );

  return {
    credentials,
    empty,
    env: {
      CREDENTIALS_DIRECTORY: credentials,
      FIXTURE_FALLBACK: fallback,
      FIXTURE_STAGE: stageFile,
      RATKING_CONFIG: notify.config,
      RAT_KING_SECRET_SOURCE: "systemd",
    },
    fallback,
    home,
    signer: notify.secret,
  };
});

it.effect.prop(
  "systemd alarm, digest, seal and sealed send use mounted credentials and never run agent-secrets",
  [StageConfig, AlarmSettings, ShipSettings],
  ([base, alarm, ship]) =>
    Effect.gen(function* check() {
      const fs = yield* FileSystem.FileSystem;

      const { empty, env, fallback, home, signer } = yield* fixture(
        base,
        alarm,
        ship
      );

      const missing = { ...env, CREDENTIALS_DIRECTORY: empty };

      const probes = yield* fixtureChild(
        ["--input-type=module", "--eval", alarmAndDigest],
        home,
        missing
      );

      expect(probes.code).toBe(0);
      expect(probes.stdout).toContain("Systemd credential slot is absent");
      expect(probes.stdout).toContain('"digest":[]');

      const sealed = yield* fixtureChild(
        [
          "stacks/nest/cli.ts",
          "seal",
          "--as",
          signer,
          "--to",
          "peer",
          "--body",
          "fixture",
          "--encrypt",
        ],
        home,
        env
      );

      expect(sealed.code).toBe(0);

      const journal = yield* Schema.decodeEffect(SealedJson)(
        sealed.stdout.trim()
      );

      const refused = yield* fixtureChild(
        [
          "stacks/nest/cli.ts",
          "send",
          "--as",
          signer,
          "--sealed",
          "-",
          "--encrypt",
        ],
        home,
        missing,
        JSON.stringify(journal.envelope)
      );

      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain("Systemd credential slot is absent");
      expect(yield* fs.exists(fallback)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 3 } }
);
