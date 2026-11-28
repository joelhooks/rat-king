import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
} from "effect";
import { expect } from "vitest";

import {
  loadSettings,
  PiConfig,
  readConfig,
  relaysOf,
  RelaySetting,
  resolveAttentionLevers,
  resolveTurnOwner,
  resolveTurnRecords,
  toolName,
} from "../src/config.ts";
import { alpha, id, integer, template } from "./client-rule-inputs.ts";

const base = {
  didTemplate: template,
  endpoint: "https://example.invalid",
  serviceDid: "did:web:example.invalid:mailbox",
};

const decode = Schema.decodeUnknownOption(PiConfig);

const configLayer = (env: Readonly<Record<string, string>>) =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(env));

const files = (
  body: typeof PiConfig.Type,
  env: Readonly<Record<string, string>> = {}
) =>
  Layer.mergeAll(
    FileSystem.layerNoop({
      readFileString: () => Effect.succeed(JSON.stringify(body)),
    }),
    Path.layer,
    configLayer({ HOME: "/home/example", ...env })
  );

const systemd = {
  RATKING_CONFIG: "/example/pi.json",
  RAT_KING_SECRET_SOURCE: "systemd",
};

it.prop(
  "mailbox endpoints accept either HTTP transport without normalizing the path",
  [id, Schema.Literals(["http", "https"])],
  ([n, protocol]) => {
    const endpoint = `${protocol}://example.invalid/api/${n}`;
    expect(decode({ ...base, endpoint })).toEqual(
      Option.some({ ...base, endpoint })
    );
  }
);

it.prop(
  "a scheme-less or non-HTTP endpoint does not decode",
  [id, Schema.Literals(["", "ftp://", "file://"])],
  ([n, scheme]) => {
    expect(
      decode({ ...base, endpoint: `${scheme}example.invalid/${n}` })
    ).toEqual(Option.none());
  }
);

it.prop(
  "the DID template must contain exactly one agent placeholder",
  [alpha(12)],
  ([name]) => {
    expect(decode({ ...base, didTemplate: `did:web:${name}.invalid` })).toEqual(
      Option.none()
    );
    expect(
      decode({
        ...base,
        didTemplate: `did:web:${name}.invalid:{agent}:{agent}`,
      })
    ).toEqual(Option.none());
  }
);

it.prop(
  "a fragment is not allowed on a service DID or template",
  [alpha(12)],
  ([fragment]) => {
    expect(
      decode({ ...base, serviceDid: `${base.serviceDid}#${fragment}` })
    ).toEqual(Option.none());
    expect(
      decode({ ...base, didTemplate: `${base.didTemplate}#${fragment}` })
    ).toEqual(Option.none());
  }
);

it.prop(
  "ask timeouts must be positive integral milliseconds",
  [id, Schema.Boolean],
  ([n, fractional]) => {
    expect(decode({ ...base, askTimeoutMs: n })).toEqual(
      Option.some({ ...base, askTimeoutMs: n })
    );
    expect(
      decode({ ...base, askTimeoutMs: fractional ? n + 0.5 : -n })
    ).toEqual(Option.none());
  }
);

it.prop(
  "each digest window must be positive even when the other recipient's window is valid",
  [id, id],
  ([valid, invalid]) => {
    expect(
      decode({ ...base, ccDigestMinutes: { alpha: valid, beta: -invalid } })
    ).toEqual(Option.none());
  }
);

it.prop(
  "an issuer command retains argument boundaries, including an intentionally empty argument",
  [alpha(12), id],
  ([tool, n]) => {
    const issuer = { command: [tool, "", `value ${n}`] };
    expect(decode({ ...base, issuer })).toEqual(
      Option.some({ ...base, issuer })
    );
  }
);

it.prop(
  "a command string is not an argv vector",
  [alpha(12), id],
  ([tool, n]) => {
    expect(
      decode({ ...base, issuer: { command: `${tool} --id ${n}` } })
    ).toEqual(Option.none());
  }
);

it.prop(
  "service issuer host IDs cannot contain path separators or spaces",
  [alpha(12), alpha(12), Schema.Literals(["/", " "])],
  ([left, right, separator]) => {
    const endpoint = "https://issuer.example.invalid";
    expect(
      decode({
        ...base,
        issuer: { endpoint, host: `${left}${separator}${right}` },
      })
    ).toEqual(Option.none());
  }
);

it.prop(
  "valid tool names enforce the 64-character limit at the boundary",
  [alpha(12)],
  ([prefix]) => {
    const name = prefix.padEnd(64, "z");
    expect(decode({ ...base, toolName: name })).toEqual(
      Option.some({ ...base, toolName: name })
    );
    expect(decode({ ...base, toolName: `${name}z` })).toEqual(Option.none());
  }
);

it.prop(
  "relay fallback allows a positive fraction but refuses disabled or negative timers",
  [RelaySetting, id],
  ([seed, n]) => {
    const fractional = { ...seed, fallbackMinutes: n / 10 };
    expect(decode({ ...base, relay: fractional })).toEqual(
      Option.some({ ...base, relay: fractional })
    );
    expect(
      decode({ ...base, relay: { ...seed, fallbackMinutes: -n } })
    ).toEqual(Option.none());
  }
);

it.prop(
  "normalizing mixed relay modes preserves list order and repeated destination entries",
  [RelaySetting, RelaySetting],
  ([a, b]) => {
    const front = { ...a, mode: "front" as const };
    const copy = { ...b, mode: "copy" as const, to: a.to };
    expect(relaysOf([front, copy, front])).toEqual([front, copy, front]);
    expect(relaysOf(copy)).toEqual([copy]);
  }
);

it.prop(
  "thread owner prefixes are accepted separately from complete names",
  [alpha(16)],
  ([project]) => {
    const threadRouting = [
      { name: "router", owners: [`${project}/`, `${project}/desk`] },
    ];

    expect(decode({ ...base, threadRouting })).toEqual(
      Option.some({ ...base, threadRouting })
    );
    expect(
      decode({
        ...base,
        threadRouting: [{ name: "router", senders: [`${project}/`] }],
      })
    ).toEqual(Option.none());
  }
);

it.prop(
  "signer and role lists may contain project names but not a bare project prefix",
  [alpha(12), Schema.Literals(["signerNames", "roleAllowlist", "refuse"])],
  ([project, key]) => {
    expect(Option.isSome(decode({ ...base, [key]: [`${project}/desk`] }))).toBe(
      true
    );
    expect(decode({ ...base, [key]: [`${project}/`] })).toEqual(Option.none());
  }
);

it.effect.prop(
  "standalone settings derive directory from the overridden state, not HOME",
  [id],
  ([n]) =>
    Effect.gen(function* settingsPaths() {
      const state = `/example/state-${n}`;

      const settings = yield* loadSettings().pipe(
        Effect.provide(files({ ...base, state }))
      );

      expect(settings).toMatchObject({
        directory: `${state}/directory.json`,
        state,
      });
    })
);

it.effect.prop(
  "settings preserve explicit timing, encryption and issuer instead of defaults",
  [id, Schema.Boolean, alpha(12)],
  ([askTimeoutMs, encrypt, tool]) =>
    Effect.gen(function* settingsValues() {
      const issuer = { command: [tool] } as const;

      const settings = yield* loadSettings().pipe(
        Effect.provide(files({ ...base, askTimeoutMs, encrypt, issuer }))
      );

      expect(settings).toMatchObject({
        askTimeoutMs,
        encrypt,
        issuer: Option.some(issuer),
      });
    })
);

it.effect.prop(
  "systemd rejects a relative config path before the file is consumed",
  [alpha(12)],
  ([part]) =>
    Effect.gen(function* relativeConfig() {
      const result = yield* readConfig().pipe(
        Effect.provide(
          files(base, { ...systemd, RATKING_CONFIG: `${part}/pi.json` })
        ),
        Effect.result
      );

      expect(result).toMatchObject({
        failure: {
          reason: "Systemd mode requires an explicit absolute RATKING_CONFIG",
        },
      });
    })
);

it.effect.prop(
  "systemd permits only absolute reader state paths",
  [alpha(12)],
  ([part]) =>
    Effect.gen(function* relativeState() {
      const result = yield* loadSettings().pipe(
        Effect.provide(files({ ...base, state: `${part}/state` }, systemd)),
        Effect.result
      );

      expect(result).toMatchObject({
        failure: {
          reason: "Systemd mode requires an explicit absolute state path",
        },
      });
    })
);

it.effect.prop(
  "systemd refuses a relative document or directory even beside a valid absolute path",
  [alpha(12), Schema.Boolean],
  ([part, relativeDoc]) =>
    Effect.gen(function* relativeInputs() {
      const directory = relativeDoc ? `/example/${part}` : `${part}/directory`;

      const documents = [
        "/example/first.json",
        relativeDoc ? `${part}/second.json` : "/example/second.json",
      ];

      const result = yield* readConfig().pipe(
        Effect.provide(files({ ...base, directory, documents }, systemd)),
        Effect.result
      );

      expect(result).toMatchObject({
        failure: {
          reason: "Systemd mode requires absolute document and directory paths",
        },
      });
    })
);

it.effect.prop(
  "systemd preserves explicit absolute state and document paths without a derived HOME state",
  [alpha(12)],
  ([part]) =>
    Effect.gen(function* absoluteSettings() {
      const state = `/example/${part}`;
      const documents = [`${state}/doc.json`];

      const settings = yield* loadSettings().pipe(
        Effect.provide(files({ ...base, documents, state }, systemd))
      );

      expect(settings).toMatchObject({
        directory: `${state}/directory.json`,
        documents,
        state,
      });
    })
);

it.effect.prop(
  "an explicit environment tool name outranks the configured one",
  [alpha(15), alpha(15)],
  ([name, configured]) =>
    Effect.gen(function* overrideName() {
      const actual = yield* toolName.pipe(
        Effect.provide(
          files(
            { ...base, toolName: `fallback_${configured}` },
            { RATKING_TOOL: name }
          )
        )
      );

      expect(actual).toBe(name);
    })
);

it.effect.prop(
  "when the environment omits a tool name the configured one survives",
  [alpha(15)],
  ([name]) =>
    Effect.gen(function* defaultName() {
      const actual = yield* toolName.pipe(
        Effect.provide(files({ ...base, toolName: name }))
      );

      expect(actual).toBe(name);
    })
);

it.effect.prop(
  "turn-record environment overrides either value from the config",
  [Schema.Boolean, Schema.Boolean],
  ([configured, override]) =>
    Effect.gen(function* turnGate() {
      const actual = yield* resolveTurnRecords({
        turnRecords: configured,
      }).pipe(
        Effect.provide(
          configLayer({ RATKING_TURN_RECORDS: override ? "1" : "0" })
        )
      );

      expect(actual).toBe(override);
    })
);

it.effect.prop(
  "attention accepts only a 0 or 1 environment override",
  [integer(2, 99), Schema.Boolean],
  ([n, attentionLevers]) =>
    Effect.gen(function* invalidAttention() {
      const result = yield* resolveAttentionLevers({ attentionLevers }).pipe(
        Effect.provide(configLayer({ RATKING_ATTENTION: String(n) })),
        Effect.result
      );

      expect(result).toMatchObject({
        failure: { reason: "RATKING_ATTENTION must be 1 or 0" },
      });
    })
);

it.effect.prop(
  "self-owned turn delivery is suppressed after the explicit owner wins over fallback",
  [alpha(15), Schema.Boolean],
  ([part, printOnly]) =>
    Effect.gen(function* selfOwner() {
      const own = `desk-${part}`;

      const actual = yield* resolveTurnOwner().pipe(
        Effect.provide(
          configLayer({
            MUSTER_OWNER_NAME: "other",
            RATKING_TURN_OWNER: own,
            [printOnly ? "RATKING_PRINT_NAME" : "RATKING_NAME"]: own,
          })
        )
      );

      expect(actual).toEqual(Option.none());
    })
);
