import * as Runtime from "@rat-king/lexicon/runtime";
/* oxlint-disable typescript/promise-function-async, promise/prefer-await-to-callbacks -- Test Worker RPC and fetch boundaries return Effect-run promises directly. */
import { Effect, Schema } from "effect";

import type { Bindings } from "../src/bindings.ts";
import production from "../src/worker.ts";

export { AuthTokens, Mailbox } from "../src/worker.ts";

const Command = Schema.Struct({
  generation: Schema.Int,
  leaseId: Runtime.lexString({ format: "tid", type: "string" }),
  messageId: Schema.String,
  operation: Schema.Literals(["acquire", "renew", "release", "inject"]),
  recipientDid: Runtime.lexString({ format: "did", type: "string" }),
  senderDid: Schema.String,
  ttl: Schema.Int,
});

export default {
  fetch: (request: Request, env: Bindings) => {
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

    if (new URL(request.url).pathname !== "/test/lease") {
      return production.fetch(request, env);
    }

    return Effect.runPromise(
      Effect.gen(function* privateRpc() {
        const command = yield* Schema.decodeUnknownEffect(Command)(
          yield* Effect.promise(() => request.json())
        );

        const stub = env.MAILBOX.getByName(command.recipientDid);

        if (command.operation === "acquire") {
          return Response.json(
            yield* Effect.promise(() =>
              stub.acquireLease(command.leaseId, command.ttl)
            )
          );
        }

        if (command.operation === "renew") {
          return Response.json(
            yield* Effect.promise(() =>
              stub.renewLease(command.leaseId, command.generation, command.ttl)
            )
          );
        }

        if (command.operation === "release") {
          yield* Effect.promise(() =>
            stub.releaseLease(command.leaseId, command.generation)
          );

          return Response.json({ released: true });
        }

        return new Response(
          yield* Effect.promise(() =>
            stub.inject(
              command.senderDid,
              command.messageId,
              command.leaseId,
              command.generation
            )
          ),
          { headers: { "content-type": "application/json" } }
        );
      })
    );
  },
};
