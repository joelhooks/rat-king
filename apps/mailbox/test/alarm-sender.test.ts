import { NodePath } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { EnvelopeFailure } from "@rat-king/envelope/failure";
import { openPlaintext } from "@rat-king/envelope/signed";
import * as Send from "@rat-king/lexicon/mailbox.send";
import { Clock, ConfigProvider, Effect, FileSystem, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import { Turn } from "../../../packages/lexicon/turns.ts";
import { PayloadJson } from "../../../packages/mailbox-client/src/payload.ts";
import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { AgentName } from "../../../packages/ratking-client/src/name.ts";
import { AlarmSettings } from "../../../stacks/nest/alarm-config.ts";
import {
  deskWakeMail,
  prepareAlarmDeliveries,
  prepareAlarmMail,
  sendAlarmDelivery,
} from "../../../stacks/nest/alarm-mail.ts";
import { readOpsName } from "../../../stacks/nest/ops-read.ts";
import { ShipSettings } from "../../../stacks/nest/ship-config.ts";
import { prepareShipNotification } from "../../../stacks/nest/ship-notify.ts";
import { StageConfig } from "../../../stacks/nest/stage-config.ts";
import type { StageConfigValue } from "../../../stacks/nest/stage-config.ts";
import { prepareCrash } from "../../../stacks/nest/turn-crashes.ts";
import { SecretStore } from "../cli/secrets.ts";
import {
  DidResolver,
  ReplayAuthority,
  authenticate,
  staticResolver,
} from "../src/auth.ts";

const settings = {
  didTemplate: "did:web:fixture.invalid:{agent}",
  endpoint: "https://service.invalid",
  serviceDid: "did:web:service.invalid",
};

const custom = "fixture/alarm";

const notice = "Alarm firing";

const at = "2026-01-01T00:00:00.000Z";

const wake = {
  $type: "sh.mschf.ratking.desk.wake",
  messageId: "2222222222222",
  name: "target",
  recordedAt: at,
  wake: true,
} as const;

const fixture = Effect.fn("Test.alarmSigner")(function* fixture(
  base: StageConfigValue,
  alarm: typeof AlarmSettings.Type,
  ship: typeof ShipSettings.Type,
  useDefault: boolean
) {
  const sender = useDefault ? "operator" : custom;
  const operator = yield* identity("did:web:operator.invalid");
  const alarmIdentity = yield* identity("did:web:alarm.invalid");
  const target = yield* identity("did:web:target.invalid");
  const signer = useDefault ? operator : alarmIdentity;
  const wrongSigner = useDefault ? alarmIdentity : operator;

  const entries = {
    [custom]: {
      did: alarmIdentity.did,
      document: yield* document(alarmIdentity),
    },
    operator: { did: operator.did, document: yield* document(operator) },
    target: { did: target.did, document: yield* document(target) },
  };

  const notify = {
    config: "/fixture/config.json",
    directory: "/fixture/directory.json",
    secret: alarm.notify.secret,
  };

  const config = {
    ...base,
    alarm: { ...alarm, notify: useDefault ? notify : { ...notify, sender } },
    runtime: {
      ...base.runtime,
      HOME: "/fixture",
      RAT_KING_ENDPOINT: settings.endpoint,
      RAT_KING_SERVICE_DID: settings.serviceDid,
    },
    ship,
  };

  const files = FileSystem.layerNoop({
    readFileString: (file) =>
      Effect.succeed(
        JSON.stringify(file === notify.directory ? entries : settings)
      ),
  });

  const secrets = (mismatch: boolean) =>
    SecretStore.of({
      add: () => Effect.void,
      exists: () => Effect.succeed(true),
      lease: (name) => {
        expect(name).toBe(notify.secret);

        return Effect.succeed(JSON.stringify(mismatch ? wrongSigner : signer));
      },
    });

  return {
    config,
    files,
    resolver: staticResolver([
      entries[custom].document,
      entries.operator.document,
    ]),
    secrets,
    sender,
    signer,
    target,
  };
});

const arb = {
  alarm: AlarmSettings,
  base: StageConfig,
  ship: ShipSettings,
  useDefault: Schema.Boolean,
};

it.effect.prop(
  "ops health refuses a cached name whose authoritative peer document is missing before reading name health",
  arb,
  ({ alarm, base, ship, useDefault }) =>
    Effect.gen(function* check() {
      const { config, files, secrets } = yield* fixture(
        base,
        alarm,
        ship,
        useDefault
      );

      const calls: string[] = [];

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          calls.push(request.url);

          return HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "DocumentNotFound" }, { status: 404 })
          );
        })
      );

      const failure = yield* readOpsName(config, "target").pipe(
        Effect.provide([files, NodePath.layer]),
        Effect.provideService(SecretStore, secrets(false)),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.flip
      );

      expect(failure.reason).toBe("Unknown ops health name");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("mailbox.getPeerDocument");
    }),
  { arbitrary: { runs: 5 } }
);

it.effect.prop(
  "ship notify preserves the malformed config reason but not its path in either credential mode",
  [StageConfig, ShipSettings, Schema.Literals(["agent-secrets", "systemd"])],
  ([base, ship, mode]) =>
    Effect.gen(function* verify() {
      const path = "/fixture/private-config-probe.json";

      const files = FileSystem.layerNoop({
        readFileString: () => Effect.succeed("not-json"),
      });

      const config = {
        ...base,
        ship: { ...ship, notify: { ...ship.notify, config: path } },
      };

      const result = yield* prepareShipNotification(config, "").pipe(
        Effect.provide([
          files,
          NodePath.layer,
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ RAT_KING_SECRET_SOURCE: mode })
          ),
        ]),
        Effect.provideService(SecretStore, {
          add: () => Effect.die("Unexpected credential mutation"),
          exists: () => Effect.die("Unexpected credential lookup"),
          lease: () => Effect.die("Unexpected credential lease"),
        }),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected request"))
        ),
        Effect.flip
      );

      expect(result.reason).toBe(
        "Ship notification settings: NotConfigured: Malformed Rat King config at [path withheld]"
      );
      expect(result.reason).not.toContain("private-config-probe");
    }),
  { arbitrary: { runs: 5 } }
);

it.effect.prop(
  "alarm notices, pruned broadcasts, typed desk wakes and reader-crash records sign at both wire boundaries as the selected sender",
  arb,
  ({ alarm, base, ship, useDefault }) =>
    Effect.gen(function* verifySends() {
      const { config, files, resolver, secrets, sender, signer, target } =
        yield* fixture(base, alarm, ship, useDefault);

      const bodies: string[] = [];

      const http = HttpClient.make((request) =>
        Effect.gen(function* accept() {
          if (!(request.body instanceof HttpBody.Uint8Array)) {
            return yield* Effect.die("Expected a JSON request body");
          }

          const input = yield* Schema.decodeEffect(
            Schema.fromJsonString(Send.Input)
          )(new TextDecoder().decode(request.body.body));

          const caller = yield* authenticate({
            audience: `${settings.serviceDid}#mailbox`,
            authorization: request.headers.authorization ?? null,
            now: yield* Clock.currentTimeMillis,
            nsid: Send.Method.nsid,
          });

          const { envelope } = input;

          expect(caller).toBe(signer.did);
          expect(envelope.aad.senderDid).toBe(signer.did);
          expect(envelope.aad.recipientDid).toBe(target.did);

          const keys = yield* DidResolver;

          const verified = yield* openPlaintext(envelope, (did, keyId) =>
            keys
              .resolve(did, keyId, "authentication")
              .pipe(
                Effect.mapError(
                  () => new EnvelopeFailure({ reason: "Unknown signer" })
                )
              )
          );

          bodies.push(new TextDecoder().decode(verified.body));

          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              receipt: {
                message: {
                  messageId: envelope.aad.messageId,
                  senderDid: signer.did,
                },
                recipientDid: target.did,
                seq: bodies.length,
                state: "accepted",
              },
            })
          );
        }).pipe(
          Effect.provide(resolver),
          Effect.provideService(
            ReplayAuthority,
            ReplayAuthority.of({ consume: () => Effect.void })
          ),
          Effect.orDie
        )
      );

      const crash = yield* Schema.decodeUnknownEffect(Turn)({
        $type: "sh.mschf.agentgraph.turn",
        agent: "fixture/worker",
        at,
        session: "session",
        state: "crashed",
        turnId: "session:1",
        version: "0.1",
      });

      yield* Effect.gen(function* send() {
        const desk = deskWakeMail(config);

        const regular = yield* prepareAlarmDeliveries(
          config,
          "digest.fail",
          ["target"],
          notice
        );

        const pruned = yield* prepareAlarmDeliveries(
          config,
          "digest.fail",
          ["target", "retired"],
          notice
        );

        const wakeDelivery = yield* desk.prepare("target", wake);

        const crashDelivery = yield* prepareCrash(config, {
          owner: "target",
          record: crash,
        });

        for (const delivery of [...regular, ...pruned]) {
          yield* sendAlarmDelivery(config, delivery);
        }

        yield* desk.send(wakeDelivery);
        yield* sendAlarmDelivery(config, crashDelivery);
      }).pipe(
        Effect.provide(files),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(SecretStore, secrets(false))
      );

      expect(bodies).toHaveLength(4);

      const [regular, pruned, typedWake, typedCrash] = bodies;

      const payload = yield* Schema.decodeUnknownEffect(PayloadJson)(typedWake);

      expect(regular).toBe(
        JSON.stringify({ body: notice, from: sender, kind: "message" })
      );
      expect(pruned).toBe(
        JSON.stringify({
          body: `${notice} Evidence: 1 retired or unknown recipient(s) dropped.`,
          from: sender,
          kind: "message",
        })
      );
      expect(JSON.parse(payload.body)).toEqual(wake);
      expect(payload).toMatchObject({
        from: sender,
        kind: "data",
        to: "target",
      });
      expect(
        yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Turn))(
          typedCrash
        )
      ).toEqual(crash);
    }).pipe(Effect.provide(NodePath.layer)),
  { arbitrary: { runs: 10 } }
);

it.effect.prop(
  "the alarm refuses an identity secret whose DID belongs to a different sender",
  arb,
  ({ alarm, base, ship, useDefault }) =>
    Effect.gen(function* verifyRefusal() {
      const { config, files, secrets, sender } = yield* fixture(
        base,
        alarm,
        ship,
        useDefault
      );

      const http = HttpClient.make(() =>
        Effect.die("signer mismatch must not reach the mailbox")
      );

      const result = yield* prepareAlarmMail(config, ["target"], "").pipe(
        Effect.flip,
        Effect.provide(files),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(SecretStore, secrets(true))
      );

      expect(result.reason).toBe(
        `Alarm signer is not the configured ${sender}`
      );
    }).pipe(Effect.provide(NodePath.layer)),
  { arbitrary: { runs: 10 } }
);

it.prop(
  "stage decode rejects push with an explicit sender but permits either separately",
  { alarm: AlarmSettings, base: StageConfig, sender: AgentName },
  ({ alarm, base, sender }) => {
    const { sender: _sender, ...notify } = alarm.notify;
    const { push: _push, ...withoutPush } = alarm;
    const push = { names: ["target"], secret: "fixture" };
    const withSender = { ...notify, sender };

    const decode = Schema.decodeUnknownSync(StageConfig, {
      onExcessProperty: "error",
    });

    expect(() =>
      decode({ ...base, alarm: { ...withoutPush, notify, push } })
    ).not.toThrow();
    expect(() =>
      decode({ ...base, alarm: { ...withoutPush, notify: withSender } })
    ).not.toThrow();
    expect(() =>
      decode({ ...base, alarm: { ...withoutPush, notify: withSender, push } })
    ).toThrow("alarm.push requires the default operator sender");
  }
);
