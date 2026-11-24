import {
  ECDH,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  // @effect-diagnostics-next-line nodeBuiltinImport:off -- Independent verifier for historical Multikey material from workerd.
} from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Connect to loopback while supplying the virtual Host verbatim.
import { request as nodeRequest } from "node:http";

import {
  Worker,
  providers as cloudflareProviders,
} from "@alchemy.run/cloudflare";
import { providers as domainProviders } from "@alchemy.run/domain/Cloudflare";
import { resolveDev } from "@alchemy.run/test/Core";
import * as Test from "@alchemy.run/test/Vitest";
import { Clock, ConfigProvider, Effect, Layer, Schema } from "effect";
import { uuidV4Unsafe } from "effect/crypto/SecureRandom";
import { base58btc } from "multiformats/bases/base58";
import { assert, expect } from "vitest";

import { bindIdentityRoutes } from "../src/deploy-routing.ts";
import {
  adminBytes,
  adminPath,
  Issuer,
  Mutation,
} from "../src/identity/admin.ts";
import {
  boardHost,
  Handle,
  identityZone,
  pdsHost,
} from "../src/identity/names.ts";
import {
  importIssuer,
  peopleHandle,
  peopleHost,
  SeedFailure,
  seedIdentity,
} from "../src/identity/seed.ts";
import { Document } from "../src/identity/views.ts";
import RatKingEdge from "../src/worker.ts";
import IdentityProofWorker, { ProofIssuer } from "./identity-proof-worker.ts";

if (!resolveDev({ dev: true })) {
  throw new Error("Identity proof requires local Alchemy dev mode");
}

const { test } = Test.make({
  dev: true,
  dotAlchemy: `.alchemy/identity-proof-${uuidV4Unsafe()}`,
  providers: Layer.merge(cloudflareProviders(), domainProviders()),
  sidecar: false,
});

const zone = identityZone;

const issuerDid = "did:web:issuer.example.invalid";

const apex = `did:web:${zone}`;

const host = `agent--project.${zone}`;

const did = `did:web:${host}`;

const handle = Handle.make(`agent.project.${zone}`);

const changed = Handle.make(`renamed.project.${zone}`);

const documentPath = "/.well-known/did.json";

const handlePath = "/.well-known/atproto-did";

const keyPair = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  const jwk = publicKey.export({ format: "jwk" });
  assert(jwk.x !== undefined && jwk.y !== undefined);
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");

  const publicKeyMultibase = base58btc.encode(
    Uint8Array.of(0x80, 0x24, 2 + ((y.at(-1) ?? 0) % 2), ...x)
  );

  return { jwk, privateKey, publicKeyMultibase };
};

const getHistoricalKey = (key: string) => {
  const point = base58btc.decode(key).subarray(2);

  const rawPoint = ECDH.convertKey(
    point,
    "prime256v1",
    undefined,
    undefined,
    "uncompressed"
  );

  assert(Buffer.isBuffer(rawPoint));

  return createPublicKey({
    format: "jwk",
    key: {
      crv: "P-256",
      kty: "EC",
      x: rawPoint.subarray(1, 33).toString("base64url"),
      y: rawPoint.subarray(33).toString("base64url"),
    },
  });
};

const send = ({
  port,
  hostname,
  path,
  body,
}: {
  readonly port: string;
  readonly hostname: string;
  readonly path: string;
  readonly body?: string | undefined;
}) =>
  Effect.callback<
    { readonly body: string; readonly status: number | undefined },
    Error
  >((resume) => {
    const fail = (error: Error) => {
      resume(Effect.fail(error));
    };

    const request = nodeRequest(
      {
        headers: { host: hostname },
        hostname: "127.0.0.1",
        method: body === undefined ? "GET" : "POST",
        path,
        port,
      },
      (response) => {
        response.setEncoding("utf-8");
        let text = "";
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("error", fail);
        response.on("end", () => {
          resume(Effect.succeed({ body: text, status: response.statusCode }));
        });
      }
    );

    request.on("error", fail);
    request.end(body);

    return Effect.sync(() => {
      request.destroy();
    });
  });

const decodeDocument = Schema.decodeEffect(Schema.fromJsonString(Document));

const portOf = (url: string | undefined) => {
  assert(url !== undefined);
  const parsed = new URL(url);
  assert(parsed.protocol === "http:" && parsed.port !== "");

  return parsed.port;
};

const routeSeed = Effect.fn("Proof.routeSeed")(function* routeSeed(
  request: Request,
  ports: ReadonlyMap<string, string>
) {
  const { hostname, pathname } = new URL(request.url);
  const port = ports.get(hostname);
  assert(port !== undefined);

  const body =
    request.method === "POST"
      ? yield* Effect.promise(request.text.bind(request))
      : undefined;

  const response = yield* send({ body, hostname, path: pathname, port }).pipe(
    Effect.mapError(
      () => new SeedFailure({ reason: "Loopback request failed" })
    )
  );

  assert(response.status !== undefined);

  return new Response(response.body, { status: response.status });
});

test.provider(
  "workerd routes production hosts, protects existing origins, and seeds only with the deployed issuer pin",
  (stack) =>
    Effect.gen(function* proveDeployment() {
      const issuer = keyPair();

      const pin = yield* Schema.decodeUnknownEffect(Issuer)({
        did: issuerDid,
        key: issuer.jwk,
      });

      const signingKey = yield* importIssuer(
        JSON.stringify({
          did: issuerDid,
          signing: issuer.privateKey.export({ format: "jwk" }),
        }),
        pin
      );

      const plan = {
        apexKeys: [
          {
            publicKeyMultibase: keyPair().publicKeyMultibase,
            purpose: "atproto" as const,
          },
        ],
      };

      const tenant = `tenant.${pdsHost}`;
      const other = `existing.${zone}`;
      const preserved = [boardHost, pdsHost, tenant, other];

      const deploy = (pinned: boolean) =>
        // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Alchemy's scratch provider erases its errors.
        stack.deploy(
          Effect.gen(function* deployProof() {
            const commitBinding = { RATKING_COMMIT: "a".repeat(40) };

            const env = pinned
              ? {
                  ...commitBinding,
                  RATKING_IDENTITY_ISSUER: JSON.stringify(pin),
                }
              : commitBinding;

            const edge = yield* RatKingEdge.pipe(
              Effect.provide(
                ConfigProvider.layer(ConfigProvider.fromUnknown(env))
              )
            );

            const url = yield* bindIdentityRoutes({
              protectedHosts: [other],
              script: edge.workerName,
              zoneId: "test-zone",
            });

            const loopbackOrigins = yield* Effect.forEach(
              [...preserved, peopleHost, peopleHandle],
              (hostname) =>
                Worker(`Origin-${hostname}`, {
                  domain: hostname,
                  main: new URL("routing-origin.ts", import.meta.url).href,
                }).pipe(Effect.map((worker) => ({ hostname, url: worker.url })))
            );

            return { origins: loopbackOrigins, url };
          })
        );

      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Alchemy's scratch provider erases its errors.
      const unpinned = yield* deploy(false).pipe(Effect.orDie);

      const ports = (deployed: typeof unpinned) =>
        new Map([
          [zone, portOf(deployed.url)],
          ...deployed.origins.map(
            ({ hostname, url }) => [hostname, portOf(url)] as const
          ),
        ]);

      const seed = (deployed: typeof unpinned) =>
        seedIdentity({
          pin,
          plan,
          send: (request) => routeSeed(request, ports(deployed)),
          signingKey,
        });

      const refusal = yield* Effect.flip(seed(unpinned));
      expect(refusal.reason).toContain(
        "Register for did:web:ratking.dev returned HTTP 401"
      );

      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Alchemy's scratch provider erases its errors.
      const pinned = yield* deploy(true).pipe(Effect.orDie);
      yield* seed(pinned);
      yield* seed(pinned);

      const get = (hostname: string, path: string) => {
        const port = ports(pinned).get(hostname);
        assert(port !== undefined);

        return send({ hostname, path, port });
      };

      const people = yield* decodeDocument(
        (yield* get(peopleHost, documentPath)).body
      );

      expect(people.verificationMethod).toEqual([]);
      expect(people.alsoKnownAs).toEqual([`at://${peopleHandle}`]);
      expect(yield* get(peopleHandle, handlePath)).toEqual({
        body: people.id,
        status: 200,
      });
      expect((yield* get(zone, "/")).status).toBe(404);
      expect((yield* get(peopleHost, "/mcp")).status).toBe(404);

      for (const hostname of preserved) {
        expect(yield* get(hostname, "/board/tasks?keep=query")).toEqual({
          body: "existing origin",
          status: 200,
        });
        expect(yield* get(hostname, documentPath)).toEqual({
          body: "existing origin",
          status: 200,
        });
      }
    }),
  { timeout: 30_000 }
);

test.provider(
  "workerd serves the identity graph, rejects untrusted writes and retains historical verification keys",
  (stack) =>
    Effect.gen(function* proveIdentity() {
      const issuer = keyPair();
      const oldKey = keyPair();
      const newKey = keyPair();
      const config = JSON.stringify({ did: issuerDid, key: issuer.jwk });

      // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- Alchemy's scratch adapter erases provider errors; fail on any defect.
      const { worker } = yield* stack
        .deploy(
          Effect.gen(function* deploy() {
            return {
              worker: yield* IdentityProofWorker.pipe(
                Effect.provideService(ProofIssuer, config)
              ),
            };
          })
        )
        .pipe(Effect.orDie);

      assert(worker.workerId.startsWith("dev:") && worker.url !== undefined);
      const { port, protocol } = new URL(worker.url);
      assert(protocol === "http:" && port !== "");

      const get = (hostname: string, path: string) =>
        send({ hostname, path, port });

      const post = (body: string) =>
        send({ body, hostname: zone, path: adminPath, port });

      const now = yield* Clock.currentTimeMillis;

      const signed = ({
        target,
        mutation,
        expiresIn = 60_000,
        signingKey = issuer.privateKey,
      }: {
        readonly target: string;
        readonly mutation: object;
        readonly expiresIn?: number;
        readonly signingKey?: typeof issuer.privateKey;
      }) => {
        const payload = JSON.stringify({
          audience: apex,
          did: target,
          expiresAt: now + expiresIn,
          issuedAt: now,
          issuer: issuerDid,
          mutation,
          nonce: uuidV4Unsafe().replaceAll("-", ""),
        });

        return JSON.stringify({
          payload,
          signature: sign("sha256", adminBytes(payload), {
            dsaEncoding: "ieee-p1363",
            key: signingKey,
          }).toString("base64url"),
        });
      };

      const register = Mutation.cases.Register.make({});
      const publicEdgeFallback = { body: "Not found", status: 404 };

      expect(yield* get("ratking.sh", documentPath)).toEqual(
        publicEdgeFallback
      );
      expect(yield* get("ratking.sh", handlePath)).toEqual(publicEdgeFallback);
      expect(
        yield* send({
          body: signed({ mutation: register, target: did }),
          hostname: "ratking.sh",
          path: adminPath,
          port,
        })
      ).toEqual(publicEdgeFallback);
      expect((yield* post(JSON.stringify(register))).status).toBe(401);
      expect(
        (yield* post(
          signed({
            mutation: register,
            signingKey: oldKey.privateKey,
            target: did,
          })
        )).status
      ).toBe(401);
      expect(
        (yield* post(
          signed({ expiresIn: -1, mutation: register, target: did })
        )).status
      ).toBe(401);
      expect(yield* get(host, documentPath)).toEqual({ body: "", status: 404 });
      expect(
        (yield* post(
          signed({ mutation: register, target: `did:web:${handle}` })
        )).status
      ).toBe(400);
      expect(
        (yield* post(signed({ mutation: register, target: apex }))).status
      ).toBe(200);
      expect(
        yield* decodeDocument((yield* get(zone, documentPath)).body)
      ).toMatchObject({ id: apex });
      expect(
        (yield* post(signed({ mutation: register, target: did }))).status
      ).toBe(200);

      const old = {
        publicKeyMultibase: oldKey.publicKeyMultibase,
        purpose: "atproto" as const,
      };

      const publish = signed({
        mutation: Mutation.cases.PublishKey.make({ key: old }),
        target: did,
      });

      expect((yield* post(publish)).status).toBe(200);

      const claim = signed({
        mutation: Mutation.cases.ClaimHandle.make({ handle }),
        target: did,
      });

      expect((yield* post(claim)).status).toBe(200);
      expect((yield* get(handle, handlePath)).body).toBe(did);
      expect((yield* get(handle, documentPath)).status).toBe(404);
      expect(
        yield* decodeDocument((yield* get(host, documentPath)).body)
      ).toMatchObject({
        alsoKnownAs: [`at://${handle}`],
        id: did,
      });

      const initial = yield* decodeDocument(
        (yield* get(host, documentPath)).body
      );

      expect(
        initial.verificationMethod.find(({ id }) => id === `${did}#atproto`)
      ).toEqual({
        controller: did,
        id: `${did}#atproto`,
        publicKeyMultibase: old.publicKeyMultibase,
        type: "Multikey",
      });

      expect(
        JSON.parse(
          (yield* post(
            signed({
              mutation: Mutation.cases.ClaimHandle.make({ handle }),
              target: apex,
            })
          )).body
        )
      ).toEqual({ error: "HandleTaken" });
      expect(
        (yield* post(
          signed({
            mutation: Mutation.cases.ClaimHandle.make({ handle: changed }),
            target: did,
          })
        )).status
      ).toBe(200);
      expect((yield* post(claim)).status).toBe(200);
      expect((yield* get(handle, handlePath)).status).toBe(404);
      expect((yield* get(changed, handlePath)).body).toBe(did);

      const next = { ...old, publicKeyMultibase: newKey.publicKeyMultibase };
      expect(
        JSON.parse(
          (yield* post(
            signed({
              mutation: Mutation.cases.PublishKey.make({ key: next }),
              target: did,
            })
          )).body
        )
      ).toEqual({ error: "KeyPurposeConflict" });
      expect(
        (yield* post(
          signed({
            mutation: Mutation.cases.RotateKey.make({ key: next }),
            target: did,
          })
        )).status
      ).toBe(200);

      const rotated = yield* decodeDocument(
        (yield* get(host, documentPath)).body
      );

      expect(
        rotated.verificationMethod.find(({ id }) => id === `${did}#atproto`)
          ?.publicKeyMultibase
      ).toBe(next.publicKeyMultibase);

      expect(
        (yield* post(
          signed({ mutation: Mutation.cases.Retire.make({}), target: did })
        )).status
      ).toBe(200);
      expect((yield* get(changed, handlePath)).status).toBe(404);

      const retired = yield* decodeDocument(
        (yield* get(host, documentPath)).body
      );

      expect(retired).toMatchObject({
        alsoKnownAs: [],
        id: did,
      });

      expect(retired.verificationMethod.map(({ id }) => id)).toEqual([
        `${did}#atproto-1`,
        `${did}#atproto-2`,
      ]);
      expect(
        retired.verificationMethod.every(
          ({ rotatedOutAt }) => rotatedOutAt !== undefined
        )
      ).toBe(true);
      const bytes = Buffer.from("historical signature");
      const signature = sign("sha256", bytes, oldKey.privateKey);
      const [historical] = retired.verificationMethod;
      assert(historical !== undefined);
      expect(
        verify(
          "sha256",
          bytes,
          getHistoricalKey(historical.publicKeyMultibase),
          signature
        )
      ).toBe(true);
      expect(
        JSON.parse(
          (yield* post(signed({ mutation: register, target: did }))).body
        )
      ).toEqual({ error: "Retired" });
    }),
  { timeout: 90_000 }
);
