// @effect-diagnostics nodeBuiltinImport:off -- Process entry point owns the loopback listener and systemd file read.
/* oxlint-disable typescript/promise-function-async -- Effect owns the lazy platform operations. */
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { cryptoOperation } from "@rat-king/envelope/webcrypto";
import { PrivateJwk } from "@rat-king/mailbox-client/identity";
import { Config, Effect, Exit, Schema } from "effect";

import { trafficSource, Unavailable } from "./client.ts";
import { Feed, feedLayer } from "./feed.ts";
import type { Snapshot } from "./feed.ts";
import { internalError, route } from "./http.ts";

const Did = Schema.String.check(Schema.isPattern(/^did:web:[^#\s]+$/u));

const Identity = Schema.fromJsonString(
  Schema.Struct({ did: Did, signing: PrivateJwk })
);

const HttpsOrigin = Schema.URL.check(
  Schema.makeFilter(
    (url) => url.protocol === "https:" && url.href === `${url.origin}/`,
    { expected: "an HTTPS origin without credentials, path, query or fragment" }
  )
);

const CredentialName = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_-]+$/u)
);

const Logins = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[^\s,]+$/u))
).check(Schema.isMinLength(1));

const settings = Effect.gen(function* settings() {
  const endpoint = yield* Config.schema(HttpsOrigin, "VIEWER_MAILBOX_ORIGIN");
  const serviceDid = yield* Config.schema(Did, "VIEWER_MAILBOX_DID");
  const logins = yield* Config.String("VIEWER_LOGINS");

  const allow = yield* Schema.decodeEffect(Logins)(
    logins.split(",").map((login) => login.trim())
  );

  const port = yield* Config.Port("VIEWER_PORT").pipe(Config.withDefault(4100));
  const directory = yield* Config.String("CREDENTIALS_DIRECTORY");
  const file = yield* Config.schema(CredentialName, "VIEWER_CREDENTIAL_FILE");

  const identity = yield* Effect.tryPromise(() =>
    readFile(path.join(directory, file), "utf-8")
  ).pipe(
    Effect.flatMap(Schema.decodeEffect(Identity)),
    Effect.mapError(() => new Unavailable())
  );

  const key = yield* cryptoOperation(() =>
    crypto.subtle.importKey(
      "jwk",
      identity.signing,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    )
  );

  return {
    logins: new Set(allow),
    observer: {
      audience: `${serviceDid}#mailbox`,
      did: identity.did,
      endpoint,
      key,
    },
    port,
  };
});

const serverFor = (logins: ReadonlySet<string>, snapshot: () => Snapshot) => {
  const handle = (request: IncomingMessage, response: ServerResponse) => {
    let result;

    try {
      result = route({
        loginHeaders: request.headersDistinct["tailscale-user-login"],
        logins,
        method: request.method,
        snapshot,
        target: request.url,
      });
    } catch {
      result = internalError();
    }

    response.writeHead(result.status, result.headers).end(result.body);
  };

  return createServer({ requestTimeout: 10_000 }, handle)
    .on("checkContinue", handle)
    .on("checkExpectation", handle)
    .on("clientError", (_error, socket) => {
      socket.destroy();
    });
};

const listening = (server: ReturnType<typeof serverFor>, port: number) =>
  Effect.callback<boolean, Unavailable>((resume) => {
    server.once("error", () => {
      resume(Effect.fail(new Unavailable()));
    });
    server.listen(port, "127.0.0.1", () => {
      resume(Effect.succeed(true));
    });
  });

const snapshotReader = (read: Effect.Effect<Snapshot>) => () =>
  Effect.runSync(read);

const run = Effect.gen(function* run() {
  const config = yield* settings;

  const source = trafficSource(config.observer, {
    connect: (url) => new WebSocket(url),
    fetch: globalThis.fetch,
  });

  yield* Effect.gen(function* serve() {
    const feed = yield* Feed;

    const server = yield* Effect.acquireRelease(
      Effect.sync(() => serverFor(config.logins, snapshotReader(feed.read))),
      (listener) =>
        Effect.sync(() => {
          listener.closeAllConnections();
          listener.close();
        })
    );

    yield* listening(server, config.port);
    yield* feed.run;
  }).pipe(Effect.provide(feedLayer(source)));
}).pipe(Effect.scoped);

const result = await Effect.runPromiseExit(run);

if (Exit.isFailure(result)) {
  process.stderr.write(
    "Traffic viewer stopped; check mailbox settings, signing credential and loopback port.\n"
  );
  process.exitCode = 1;
}
