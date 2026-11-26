/* oxlint-disable typescript/promise-function-async -- Test Durable Object RPCs return Effect runtime Promises. */
import { Effect } from "effect";

import type { Bindings } from "../../src/bindings.ts";
import { Issuer, issuerInstance } from "../../src/issuer-object.ts";
import { IssuerStore, issuerStore } from "../../src/issuer-store.ts";
import { NameCommand } from "../../src/name-state.ts";
import production from "../../src/worker.ts";

export { AuthTokens, Desk, Mailbox } from "../../src/worker.ts";

const fixtureDid = (name: string) => `did:web:${name}.example.invalid`;

export class FixtureIssuer extends Issuer {
  fill(start: number, size: number) {
    const { storage } = this.ctx;

    const store = issuerStore({
      exec: (query, ...values) => storage.sql.exec(query, ...values),
      transaction: (operation) => storage.transactionSync(operation),
    });

    return Effect.runPromise(
      IssuerStore.use((db) =>
        db.transaction((tx) => {
          for (let index = start; index < start + size; index += 1) {
            const name = `reader-${String(index).padStart(4, "0")}`;
            const did = fixtureDid(name);
            tx.bind(
              name,
              { did, fingerprint: name, host: fixtureDid("operator") },
              {
                authentication: [],
                id: did,
                keyAgreement: [],
                verificationMethod: [],
              }
            );

            if (index < 4) {
              tx.writeTicket(
                {
                  command: NameCommand.cases.Clear.make({ name }),
                  did,
                  expectedVersion: 0,
                  opId: name,
                },
                0
              );
            }

            if (index % 4 !== 3) {
              tx.observe({
                did,
                leaseExpiresAt: index % 4 === 0 ? 2_000_000_000_000 : 0,
                leaseGeneration: 1,
                observedAt: 1,
                retirement:
                  index % 4 === 2 ? { by: did, name, retiredAt: 1 } : null,
                version: 0,
              });
            }
          }
        })
      ).pipe(Effect.provide(store))
    );
  }
}

interface FixtureBindings extends Bindings {
  readonly ISSUER: DurableObjectNamespace<FixtureIssuer>;
}

export default {
  fetch: (request: Request, env: FixtureBindings, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    const issuer = env.ISSUER.getByName(issuerInstance);

    switch (url.pathname) {
      case "/fixture/fill": {
        return Effect.runPromise(
          Effect.promise(() =>
            issuer.fill(Number(url.searchParams.get("start")), 100)
          ).pipe(Effect.as(new Response(null, { status: 204 })))
        );
      }

      case "/fixture/document": {
        return Effect.runPromise(
          Effect.promise(() => request.text()).pipe(
            Effect.flatMap((json) =>
              Effect.promise(() => issuer.cacheDirectoryDocument(json))
            ),
            Effect.as(new Response(null, { status: 204 }))
          )
        );
      }

      case "/fixture/acquire": {
        return Effect.runPromise(
          Effect.promise(() =>
            env.MAILBOX.getByName(fixtureDid("reader-0001")).acquireLease(
              JSON.stringify({
                did: fixtureDid("reader-0001"),
                expiresAt: url.searchParams.get("expiresAt"),
                harness: {
                  $type: "sh.mschf.ratking.runtime.lease#pi",
                  sessionId: "fixture",
                },
              })
            )
          ).pipe(Effect.map((json) => new Response(json)))
        );
      }

      default: {
        return production.fetch(request, env, ctx);
      }
    }
  },
};
