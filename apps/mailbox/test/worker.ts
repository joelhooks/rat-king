/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Test Worker RPC and fetch boundaries return Effect-run promises directly. */
import { Effect, Schema } from "effect";

import type { Bindings } from "../src/bindings.ts";
import { SocketAttachment } from "../src/socket.ts";
import production, { Mailbox as ProductionMailbox } from "../src/worker.ts";
import { hpkeProof } from "./hpke-proof.ts";

export { AuthTokens } from "../src/worker.ts";

export class Mailbox extends ProductionMailbox {
  override fetch(request: Request) {
    if (new URL(request.url).pathname === "/test/sockets") {
      const states = this.ctx
        .getWebSockets()
        .map(
          (socket) =>
            Schema.decodeUnknownSync(SocketAttachment)(
              socket.deserializeAttachment()
            ).state
        );

      return Promise.resolve(Response.json({ states }));
    }

    return super.fetch(request);
  }
}

export default {
  fetch: (request: Request, env: Bindings) => {
    if (new URL(request.url).pathname.startsWith("/test/hpke/")) {
      return Effect.runPromise(hpkeProof(request));
    }

    if (new URL(request.url).pathname === "/test/p256-raw") {
      return Effect.runPromise(
        Effect.gen(function* rawPublicKeyProbe() {
          const generated = yield* Effect.promise(() =>
            crypto.subtle.generateKey(
              { name: "ECDH", namedCurve: "P-256" },
              true,
              ["deriveBits"]
            )
          );

          const pair = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ publicKey: Schema.instanceOf(CryptoKey) })
          )(generated);

          const raw = yield* Effect.promise(() =>
            crypto.subtle.exportKey("raw", pair.publicKey)
          );

          const bytes = yield* Schema.decodeUnknownEffect(
            Schema.instanceOf(ArrayBuffer)
          )(raw);

          return Response.json({ rawLength: bytes.byteLength });
        })
      );
    }

    if (new URL(request.url).pathname === "/test/sockets") {
      const did = new URL(request.url).searchParams.get("recipientDid") ?? "";

      return env.MAILBOX.getByName(did).fetch(
        new Request("https://test.example.invalid/test/sockets")
      );
    }

    return production.fetch(request, env);
  },
};
