/* oxlint-disable eslint/max-classes-per-file, promise/prefer-await-to-callbacks -- Effect service and Schema contracts share their owning port; Effect error mapping is not a Promise callback. */
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as Register from "@rat-king/lexicon/identity.register";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Transport } from "@rat-king/lexicon/transport";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { Identity, transportLayer } from "@rat-king/mailbox-client";
import type { PeerDocument } from "@rat-king/mailbox-client";
import * as Deadline from "@rat-king/mailbox-client/deadline";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { CommandIssuer, Settings } from "./config.ts";
import type { IssuerSettingValue } from "./config.ts";
import { Directory } from "./directory.ts";
import type { Resolved } from "./directory.ts";
import type { ForkParent } from "./fork.ts";
import { runCommand } from "./process.ts";
import { SecretStore } from "./secrets.ts";

export class IssuerError extends Schema.TaggedError<IssuerError>()(
  "IssuerError",
  { reason: Schema.String }
) {}

export class Issuer extends Context.Service<
  Issuer,
  {
    readonly ensure: (
      name: string,
      document: PeerDocument,
      parent?: typeof ForkParent.Type
    ) => Effect.Effect<string, IssuerError>;
    readonly names: Effect.Effect<readonly Resolved[], IssuerError>;
    readonly directory: (
      params: ListNames.ParamsValue
    ) => Effect.Effect<ListNames.OutputValue, IssuerError>;
  }
>()("pi-ratking/Issuer") {}

const ErrorBody = Schema.Struct({
  error: Schema.String,
  message: Schema.optionalKey(Schema.String),
});

const maxPages = 20;

const fail = (reason: string) => () => new IssuerError({ reason });

export const issuerLayer = Layer.effect(
  Issuer,
  Effect.gen(function* makeIssuer() {
    const settings = yield* Settings;
    const directory = yield* Directory;
    const store = yield* SecretStore;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const http = yield* HttpClient.HttpClient;

    const viaCommand = Effect.fn("Issuer.command")(
      function* viaCommand(command: readonly string[], document: PeerDocument) {
        const [program, ...args] = command;

        if (program === undefined) {
          return yield* new IssuerError({ reason: "Empty issuer command" });
        }

        const temp = yield* fs.makeTempDirectoryScoped({
          prefix: "pi-ratking-",
        });

        const file = path.join(temp, "document.json");

        yield* fs.writeFileString(file, JSON.stringify(document), {
          flag: "wx",
          mode: 0o600,
        });

        const result = yield* runCommand([
          program,
          ...args,
          "register",
          "--did",
          document.id,
          "--document",
          file,
        ]).pipe(Effect.mapError(fail("Issuer command could not run")));

        if (result.code !== 0) {
          return yield* new IssuerError({
            reason: `Issuer refused ${document.id} (exit ${result.code})`,
          });
        }

        return document.id;
      },
      Effect.scoped,
      Effect.mapError((error) =>
        Schema.is(IssuerError)(error)
          ? error
          : new IssuerError({ reason: "Issuer document could not be written" })
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
    );

    const call = Effect.fn("Issuer.call")(function* call(
      service: { readonly endpoint: string; readonly host: string },
      request: XrpcRequest
    ) {
      const host = yield* Schema.decodeEffect(Schema.fromJsonString(Identity))(
        Redacted.value(
          yield* store
            .lease(service.host)
            .pipe(Effect.mapError(fail("Host identity is not leasable")))
        )
      ).pipe(Effect.mapError(fail("Host identity secret is malformed")));

      const response = yield* Transport.use((transport) =>
        transport.request(request)
      ).pipe(
        Effect.provide(
          transportLayer(
            service.endpoint,
            `${settings.serviceDid}#mailbox`,
            host
          )
        ),
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError(fail("Issuer service is unreachable"))
      );

      if (response.status !== 200) {
        const error = Schema.decodeUnknownOption(ErrorBody)(response.body);

        return yield* new IssuerError({
          reason: `Issuer refused ${request.nsid} (HTTP ${response.status}; ${Option.match(
            error,
            {
              onNone: () => "invalid error body",
              onSome: (body) =>
                body.message === undefined || body.message === body.error
                  ? body.error
                  : `${body.error}: ${body.message}`,
            }
          )})`,
        });
      }

      return response.body;
    });

    const viaService = Effect.fn("Issuer.service")(function* viaService(
      service: { readonly endpoint: string; readonly host: string },
      name: string,
      document: PeerDocument,
      parent?: typeof ForkParent.Type
    ) {
      const data = { document, name };

      if (parent !== undefined) {
        Object.assign(data, { parent });
      }

      const input = yield* Schema.decodeUnknownEffect(
        Schema.toEncoded(Runtime.Data)
      )(data).pipe(Effect.mapError(fail("Registration is not encodable")));

      const output = yield* Schema.decodeUnknownEffect(Register.Output)(
        yield* call(service, {
          input,
          method: "POST",
          nsid: Register.Method.nsid,
          params: undefined,
        })
      ).pipe(Effect.mapError(fail("Issuer answered with an invalid body")));

      if (output.did !== document.id) {
        return yield* new IssuerError({
          reason: `Issuer bound ${name} to ${output.did}, not ${document.id}`,
        });
      }

      return output.did;
    });

    const page = Effect.fn("Issuer.page")(function* page(
      service: { readonly endpoint: string; readonly host: string },
      params: ListNames.ParamsValue
    ) {
      return yield* Schema.decodeUnknownEffect(ListNames.Output)(
        yield* call(service, {
          input: undefined,
          method: "GET",
          nsid: ListNames.Method.nsid,
          params: yield* Schema.encodeEffect(ListNames.Params)(params).pipe(
            Effect.mapError(fail("Directory filters are not encodable"))
          ),
        })
      ).pipe(
        Effect.mapError(
          fail(
            `Issuer answered ${ListNames.Method.nsid} with an invalid body (HTTP 200)`
          )
        )
      );
    });

    const remoteNames = Effect.fn("Issuer.remoteNames")(
      function* remoteNames(service: {
        readonly endpoint: string;
        readonly host: string;
      }) {
        const found: Resolved[] = [];
        let cursor: Option.Option<string> = Option.none();

        for (let index = 0; index < maxPages; index += 1) {
          const listed = yield* page(
            service,
            Option.match(cursor, {
              onNone: () => ({}),
              onSome: (value) => ({ cursor: value }),
            })
          );

          found.push(...listed.names);
          cursor = Option.fromNullishOr(listed.cursor);

          if (Option.isNone(cursor)) {
            break;
          }
        }

        return found;
      },
      (effect) =>
        effect.pipe(
          Deadline.timeout(Deadline.OPERATION_MS),
          Effect.mapError(fail("Issuer directory deadline exceeded"))
        )
    );

    const configured = Option.match(settings.issuer, {
      onNone: () =>
        Effect.fail(
          new IssuerError({
            reason: "No Rat King issuer is configured on this host",
          })
        ),
      onSome: (setting: IssuerSettingValue) => Effect.succeed(setting),
    });

    return Issuer.of({
      directory: Effect.fn("Issuer.directory")(function* readDirectory(params) {
        const setting = yield* configured;

        if (Schema.is(CommandIssuer)(setting)) {
          return yield* new IssuerError({
            reason: "Directory status filters require a service issuer",
          });
        }

        return yield* page(setting, params).pipe(
          Deadline.timeoutOrElse({
            duration: Deadline.OPERATION_MS,
            orElse: () =>
              Effect.fail(
                new IssuerError({
                  reason: "Issuer directory deadline exceeded",
                })
              ),
          })
        );
      }),
      ensure: Effect.fn("Issuer.ensure")(
        function* ensure(name, document, parent) {
          const setting = yield* configured;

          const did = Schema.is(CommandIssuer)(setting)
            ? yield* viaCommand(setting.command, document)
            : yield* viaService(setting, name, document, parent);

          yield* directory
            .record(name, document, parent)
            .pipe(
              Effect.mapError(
                (error) => new IssuerError({ reason: error.reason })
              )
            );

          yield* directory.clearRetired(name).pipe(
            Effect.tapError((failure) =>
              Effect.logWarning(
                "Registration succeeded; local retired overlay clear failed",
                { reason: failure.reason }
              )
            ),
            Effect.ignore
          );

          return did;
        },
        (effect) =>
          effect.pipe(
            Deadline.timeout(Deadline.OPERATION_MS),
            Effect.mapError((error) =>
              Schema.is(IssuerError)(error)
                ? error
                : new IssuerError({ reason: "Issuer deadline exceeded" })
            )
          )
      ),
      names: Option.match(settings.issuer, {
        onNone: () => Effect.succeed([]),
        onSome: (setting) =>
          Schema.is(CommandIssuer)(setting)
            ? Effect.succeed([])
            : remoteNames(setting),
      }),
    });
  })
);
