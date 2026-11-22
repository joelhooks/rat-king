import {
  Clock,
  Config,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  Redacted,
  Schema,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Alerts, RETENTION } from "../../apps/billing-ingress/contracts.ts";
import {
  loadSettings,
  Settings,
} from "../../packages/ratking-client/src/config.ts";
import { directoryLayer } from "../../packages/ratking-client/src/directory.ts";
import { AgentName } from "../../packages/ratking-client/src/name.ts";
import { secretStoreLayer } from "../../packages/ratking-client/src/secrets.ts";
import {
  CredentialSlot,
  secretSource,
  systemdCredential,
} from "../../packages/ratking-client/src/systemd-credentials.ts";
import {
  billingBody,
  BillingRelay,
  billingSummary,
  JournalEntry,
  relayAlert,
  RelayFailure,
} from "./billing-relay.ts";
import { scriptSeal } from "./seal.ts";

const failure = (operation: string) => () => new RelayFailure({ operation });

const JournalJson = Schema.fromJsonString(JournalEntry);

const signer = "rat_king_script_billing-alerts_identity";

export const billingCredentials = Effect.fn("Nest.billingCredentials")(
  function* billingCredentials() {
    const source = yield* secretSource.pipe(
      Effect.mapError(failure("secret-source"))
    );

    if (source === "agent-secrets") {
      return {
        identity: yield* Config.String("RAT_KING_BILLING_IDENTITY").pipe(
          Config.withDefault(signer)
        ),
        token: yield* Config.Redacted("BILLING_PULL_CREDENTIAL"),
      };
    }

    const token = yield* Config.schema(
      CredentialSlot,
      "RAT_KING_BILLING_PULL_SLOT"
    ).pipe(
      Effect.flatMap(systemdCredential),
      Effect.mapError(failure("pull-credential"))
    );

    const bearer = Redacted.value(token);

    if (/^[A-Za-z0-9._~+/-]+=*$/u.exec(bearer)?.[0] !== bearer) {
      return yield* new RelayFailure({ operation: "invalid-pull-credential" });
    }

    return { identity: signer, token };
  }
);

export const billingCommand = Effect.fn("Nest.billing-relay")(
  function* billingCommand(argv: readonly string[]) {
    if (argv.length > 0) {
      yield* Console.error(
        "Usage: nest billing-relay (configuration comes from private environment inputs)"
      );
      process.exitCode = 2;

      return;
    }

    const result = yield* Effect.gen(function* run() {
      const origin = yield* Config.String("RAT_KING_BILLING_URL");

      const url = yield* Effect.try({
        catch: failure("invalid-url"),
        try: () => new URL(origin),
      });

      if (
        url.protocol !== "https:" ||
        url.username !== "" ||
        url.password !== "" ||
        url.pathname !== "/" ||
        url.search !== "" ||
        url.hash !== ""
      ) {
        return yield* Effect.fail(
          new RelayFailure({ operation: "https-origin-required" })
        );
      }

      const { identity, token } = yield* billingCredentials();

      const recipient = yield* Config.schema(
        AgentName,
        "RAT_KING_BILLING_RECIPIENT"
      ).pipe(Config.withDefault("switchboard"));

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const root = yield* fs.realPath(
        path.resolve(import.meta.dirname, "../..")
      );

      const directory = path.resolve(
        yield* Config.String("RAT_KING_BILLING_JOURNAL_DIR")
      );

      yield* fs.makeDirectory(directory, { mode: 0o700, recursive: true });
      const canonical = yield* fs.realPath(directory);

      if (canonical === root || canonical.startsWith(`${root}/`)) {
        return yield* Effect.fail(
          new RelayFailure({ operation: "journal-must-be-external" })
        );
      }

      yield* fs.chmod(canonical, 0o700);

      const journalPath = (id: string) => path.join(canonical, `${id}.json`);

      return yield* Effect.gen(function* serializedPass() {
        const client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.filterStatusOk
        );

        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const authorize = HttpClientRequest.bearerToken(Redacted.value(token));

        const pending = yield* client
          .execute(
            HttpClientRequest.get(new URL("/pull", url).href).pipe(authorize)
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Alerts)),
            Effect.mapError(failure("pull"))
          );

        const settings = yield* loadSettings();

        const runtimeContext = yield* Effect.context<
          | FileSystem.FileSystem
          | Path.Path
          | ChildProcessSpawner.ChildProcessSpawner
        >();

        const relay = BillingRelay.of({
          ack: (id) =>
            HttpClientRequest.bodyJson(
              HttpClientRequest.post(new URL("/ack", url).href).pipe(authorize),
              { ids: [id] }
            ).pipe(
              Effect.flatMap(client.execute),
              Effect.asVoid,
              Effect.mapError(failure("ack"))
            ),
          load: (id) =>
            Effect.gen(function* load() {
              const file = journalPath(id);

              if (!(yield* fs.exists(file))) {
                // oxlint-disable-next-line unicorn/no-useless-undefined -- The journal contract returns undefined, not void, for absence.
                return yield* Effect.succeed<undefined>(undefined);
              }

              const entry = yield* fs
                .readFileString(file)
                .pipe(Effect.flatMap(Schema.decodeUnknownEffect(JournalJson)));

              if (entry.alert.id !== id || entry.sealed.to !== recipient) {
                return yield* Effect.fail(
                  new RelayFailure({ operation: "journal-identity-mismatch" })
                );
              }

              return entry;
            }).pipe(Effect.mapError(failure("journal-load"))),
          refused: (_id, code) =>
            Console.error(`billing relay: send exit ${code}; not acked`),
          save: (entry) =>
            Effect.scoped(
              Effect.gen(function* save() {
                const file = journalPath(entry.alert.id);
                const temp = `${file}.tmp`;
                const handle = yield* fs.open(temp, { flag: "w", mode: 0o600 });
                const text = yield* Schema.encodeEffect(JournalJson)(entry);
                yield* handle.writeAll(new TextEncoder().encode(text));
                yield* handle.sync;
                yield* fs.rename(temp, file);
                const parent = yield* fs.open(canonical, { flag: "r" });
                yield* parent.sync;
              })
            ).pipe(Effect.mapError(failure("journal-save"))),
          seal: (alert) =>
            scriptSeal({
              as: identity,
              body: billingBody(alert.payload),
              encrypt: true,
              summary: billingSummary(alert.payload),
              to: recipient,
            }).pipe(
              Effect.scoped,
              Effect.provide(
                Layer.mergeAll(
                  directoryLayer,
                  secretStoreLayer,
                  FetchHttpClient.layer
                )
              ),
              Effect.provide(runtimeContext),
              Effect.provideService(Settings, settings),
              Effect.mapError(failure("seal-encrypted-recipient-key-required"))
            ),
          send: (sealed) =>
            Effect.scoped(
              Effect.gen(function* send() {
                const child = yield* spawner.spawn(
                  ChildProcess.make(
                    process.execPath,
                    [
                      path.resolve(import.meta.dirname, "cli.ts"),
                      "send",
                      "--as",
                      identity,
                      "--encrypt",
                      "--sealed",
                      "-",
                    ],
                    { stderr: "inherit", stdin: "pipe", stdout: "pipe" }
                  )
                );

                const [code] = yield* Effect.all(
                  [
                    child.exitCode,
                    Stream.succeed(
                      new TextEncoder().encode(JSON.stringify(sealed.envelope))
                    ).pipe(Stream.run(child.stdin)),
                    Stream.runDrain(child.stdout),
                  ],
                  { concurrency: "unbounded" }
                );

                return Number(code);
              })
            ).pipe(
              Effect.mapError(
                failure("send-status-unknown-replay-same-envelope")
              )
            ),
        });

        const outcomes = yield* Effect.forEach(
          pending,
          (alert) =>
            relayAlert(alert).pipe(Effect.provideService(BillingRelay, relay)),
          { concurrency: 1 }
        );

        const now = yield* Clock.currentTimeMillis;

        for (const name of yield* fs.readDirectory(canonical)) {
          if (!/^[a-f0-9]{64}\.json$/u.test(name)) {
            continue;
          }

          const file = path.join(canonical, name);

          const entry = yield* fs
            .readFileString(file)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(JournalJson)));

          if (entry.alert.receivedAt + RETENTION + 86_400_000 < now) {
            yield* fs.remove(file);
          }
        }

        if (outcomes.includes("retry")) {
          return 3;
        }

        return outcomes.includes("refused") ? 2 : 0;
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.match({
        onFailure: () => 2,
        onSuccess: (code) => code,
      })
    );

    if (result !== 0) {
      yield* Console.error(
        `billing relay: incomplete pass (exit ${result}); journal retained, no failed send acked`
      );
    }

    process.exitCode = result;
  }
);
