// @effect-diagnostics asyncFunction:off -- fast-check async commands drive the real issuer route over node SQLite.
import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as Enroll from "@rat-king/lexicon/identity.enrollHost";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as Register from "@rat-king/lexicon/identity.register";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import { Arbitrary, Effect, Layer, Option, Result, Schema } from "effect";
import * as fc from "fast-check";
import { expect } from "vitest";

import {
  AgentName as PiAgentName,
  didFor,
} from "../../../packages/pi-ratking/src/name.ts";
import { Caller } from "../src/caller.ts";
import {
  AgentName,
  decideRegistration,
  nameDid,
} from "../src/issuer-policy.ts";
import type { PublicDocument } from "../src/issuer-policy.ts";
import { issuerStore } from "../src/issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
} from "../src/issuer.ts";
import { storeDocument } from "../src/mailbox.ts";
import { MailboxStore } from "../src/store.ts";
import { TestFailure } from "./celld.ts";
import { testStoreFor } from "./helpers.ts";

const didTemplate = "did:web:{agent}.pi.example.invalid";

const publicDocument = (did: string, variant: number): PublicDocument => ({
  authentication: [`${did}#atproto`],
  id: did,
  keyAgreement: [`${did}#encryption`],
  verificationMethod: [
    {
      controller: did,
      id: `${did}#atproto`,
      publicKeyJwk: { crv: "P-256", kty: "EC", x: `x${variant}`, y: "y" },
    },
  ],
});

it.effect.prop(
  "the issuer accepts exactly pi-ratking's names and derives pi-ratking's DID",
  [
    Arbitrary.schema(
      Schema.Union([PiAgentName, Schema.String.check(Schema.isMaxLength(40))])
    ),
  ],
  ([name]) =>
    Effect.sync(() => {
      const did = didFor(didTemplate, {}, name);

      const decision = decideRegistration(
        { didTemplate, reserved: [] },
        {
          document: publicDocument(did, 0),
          enrolled: true,
          host: "did:web:host.example.invalid",
          name,
        }
      );

      expect(Result.isSuccess(decision)).toBe(Schema.is(PiAgentName)(name));

      if (Result.isSuccess(decision)) {
        expect(decision.success.did).toBe(did);
      } else {
        expect(decision.failure).toBe("InvalidName");
      }
    })
);

it.effect.prop(
  "distinct names never share a DID",
  [Arbitrary.schema(AgentName), Arbitrary.schema(AgentName)],
  ([left, right]) =>
    Effect.sync(() => {
      expect(nameDid(didTemplate, left) === nameDid(didTemplate, right)).toBe(
        left === right
      );
    })
);

it.effect.prop(
  "a reserved name is refused whatever its document or prior binding",
  [
    Arbitrary.schema(AgentName),
    Arbitrary.schema(Schema.Array(AgentName)),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([name, others, bound]) =>
    Effect.sync(() => {
      const did = nameDid(didTemplate, name);
      const host = "did:web:host.example.invalid";

      const decision = decideRegistration(
        { didTemplate, reserved: [...others, name] },
        { document: publicDocument(did, 0), enrolled: true, host, name },
        bound ? { did, fingerprint: "", host } : undefined
      );

      expect(decision).toEqual(Result.fail("NameReserved"));
    })
);

const operator = "did:web:operator.example.invalid";

const hosts = [0, 1, 2].map((index) => `did:web:host-${index}.example.invalid`);

const names = ["alpha", "proj/beta", "gamma", "switchboard"];

const reserved = ["switchboard"];

const seededName = "gamma";

interface Model {
  readonly enrolled: Set<string>;
  readonly bound: Map<
    string,
    { readonly host: string; readonly variant: number }
  >;
}

const emptyModel = (): Model => ({ bound: new Map(), enrolled: new Set() });

interface Real {
  readonly route: (
    caller: string,
    request: XrpcRequest
  ) => Promise<{ readonly status: number; readonly body: string }>;
  readonly mailboxDocument: (
    did: string
  ) => Promise<Defs.DidDocumentValue | undefined>;
}

const errorOf = (body: string) =>
  Schema.decodeUnknownSync(
    Schema.fromJsonString(Schema.Struct({ error: Schema.String }))
  )(body).error;

const post = (nsid: string, input: XrpcRequest["input"]): XrpcRequest => ({
  input,
  method: "POST",
  nsid,
  params: undefined,
});

const listFrom = async (
  real: Real,
  cursor?: string
): Promise<readonly ListNames.EntryValue[]> => {
  const response = await real.route(operator, {
    input: undefined,
    method: "GET",
    nsid: ListNames.Method.nsid,
    params: cursor === undefined ? { limit: 2 } : { cursor, limit: 2 },
  });

  expect(response.status).toBe(200);

  const page = Schema.decodeUnknownSync(
    Schema.fromJsonString(ListNames.Output)
  )(response.body);

  return page.cursor === undefined
    ? page.names
    : [...page.names, ...(await listFrom(real, page.cursor))];
};

const checkModel = async (model: Model, real: Real) => {
  const expected = [...model.bound.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, { variant }]) => {
      const did = nameDid(didTemplate, name);

      return { did, document: publicDocument(did, variant), name };
    });

  expect(await listFrom(real)).toEqual(expected);

  expect(
    await Promise.all(
      expected.map(async (entry) => await real.mailboxDocument(entry.did))
    )
  ).toEqual(expected.map((entry) => entry.document));
};

const enroll = (
  caller: string,
  host: string
): fc.AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    const response = await real.route(
      caller,
      post(Enroll.Method.nsid, { document: publicDocument(host, 9) })
    );

    if (caller === operator) {
      expect(response.status).toBe(200);
      model.enrolled.add(host);
    } else {
      expect(errorOf(response.body)).toBe("Forbidden");
    }

    await checkModel(model, real);
  },
  toString: () => `enroll(${caller} -> ${host})`,
});

interface Claim {
  readonly host: string;
  readonly name: string;
  readonly variant: number;
  readonly secret: boolean;
}

const expectedOutcome = (model: Model, claim: Claim) => {
  const existing = model.bound.get(claim.name);

  if (claim.secret) {
    return "InvalidRequest";
  }

  if (!model.enrolled.has(claim.host)) {
    return "Forbidden";
  }

  if (reserved.includes(claim.name)) {
    return "NameReserved";
  }

  if (existing !== undefined) {
    return existing.host === claim.host && existing.variant === claim.variant
      ? "ok"
      : "NameTaken";
  }

  return claim.name === seededName && claim.variant !== 0
    ? "DocumentConflict"
    : "ok";
};

const withSecret = (document: PublicDocument) => ({
  ...document,
  verificationMethod: document.verificationMethod.map((method) => ({
    ...method,
    publicKeyJwk: { ...method.publicKeyJwk, d: "k" },
  })),
});

const register = (claim: Claim): fc.AsyncCommand<Model, Real> => ({
  check: () => true,
  run: async (model, real) => {
    const did = nameDid(didTemplate, claim.name);
    const document = publicDocument(did, claim.variant);
    const expected = expectedOutcome(model, claim);

    const response = await real.route(
      claim.host,
      post(Register.Method.nsid, {
        document: claim.secret ? withSecret(document) : document,
        name: claim.name,
      })
    );

    if (expected === "ok") {
      expect(response.status).toBe(200);
      expect(
        Schema.decodeUnknownSync(Schema.fromJsonString(Register.Output))(
          response.body
        ).did
      ).toBe(did);
      model.bound.set(claim.name, { host: claim.host, variant: claim.variant });
    } else {
      expect(errorOf(response.body)).toBe(expected);
    }

    await checkModel(model, real);
  },
  toString: () => `register(${JSON.stringify(claim)})`,
});

const Index = (size: number) =>
  Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(size - 1)
  );

const Spec = Schema.Union([
  Schema.Struct({
    host: Index(hosts.length),
    kind: Schema.Literal("enroll"),
    operator: Schema.Boolean,
  }),
  Schema.Struct({
    host: Index(hosts.length),
    kind: Schema.Literal("register"),
    name: Index(names.length),
    secret: Schema.Boolean,
    variant: Index(2),
  }),
]);

const command = (spec: typeof Spec.Type) => {
  const host = hosts[spec.host] ?? operator;

  if (spec.kind === "enroll") {
    return enroll(spec.operator ? operator : host, host);
  }

  return register({
    host,
    name: names[spec.name] ?? "alpha",
    secret: spec.secret,
    variant: spec.variant,
  });
};

it.effect.prop(
  "first enrolled host owns a name; repeats are idempotent and every other claim is refused",
  [Arbitrary.array(Arbitrary.schema(Spec), { maxLength: 30 })],
  ([specs]) =>
    Effect.gen(function* issuerModel() {
      const issuer = yield* testStoreFor("did:web:issuer.example.invalid");
      const mailboxes = new Map<string, Layer.Layer<MailboxStore>>();

      for (const did of [
        ...hosts,
        ...names.map((name) => nameDid(didTemplate, name)),
      ]) {
        mailboxes.set(did, (yield* testStoreFor(did)).layer);
      }

      const missing = Layer.effect(
        MailboxStore,
        Effect.die(new Error("Unknown mailbox"))
      );

      const mailbox = (did: string) =>
        MailboxStore.pipe(Effect.provide(mailboxes.get(did) ?? missing));

      const registry = Layer.succeed(
        DocumentRegistry,
        DocumentRegistry.of({
          put: Effect.fn("TestRegistry.put")(function* put(
            document: PublicDocument
          ) {
            const store = yield* mailbox(document.id);

            const decoded = yield* Schema.decodeUnknownEffect(Defs.DidDocument)(
              document
            ).pipe(Effect.orDie);

            yield* store.transaction((tx) => {
              storeDocument(tx, [], decoded);
            });
          }),
        })
      );

      const seeded = yield* mailbox(nameDid(didTemplate, seededName));

      const seed = yield* Schema.decodeUnknownEffect(Defs.DidDocument)(
        publicDocument(nameDid(didTemplate, seededName), 0)
      );

      yield* seeded.transaction((tx) => {
        tx.setDocument(seed);
      });

      const handlersFor = (caller: string) =>
        issuerHandlers({
          config: Option.some({ didTemplate, reserved }),
          operators: [operator],
        }).pipe(
          Layer.provide(issuerStore(issuer.sql)),
          Layer.provide(registry),
          Layer.provide(Layer.succeed(Caller, { did: caller }))
        );

      const context = yield* Effect.context();

      const run = async <A, E>(effect: Effect.Effect<A, E>) =>
        // oxlint-disable-next-line effect-tests/no-manual-effect-runtime-in-tests -- fast-check AsyncCommand requires a Promise; the owning property uses it.effect.
        await Effect.runPromiseWith(context)(effect);

      const real: Real = {
        mailboxDocument: async (did) =>
          await run(
            mailbox(did).pipe(
              Effect.flatMap((store) =>
                store.transaction((tx) => tx.document())
              )
            )
          ),
        route: async (caller, request) =>
          await run(
            issuerRoute(request).pipe(Effect.provide(handlersFor(caller)))
          ),
      };

      const [first = operator, second = operator] = hosts;

      const claim = (
        host: string,
        name: string,
        variant: number,
        secret = false
      ) => register({ host, name, secret, variant });

      const required = [
        claim(first, "alpha", 0),
        enroll(first, first),
        enroll(operator, first),
        enroll(operator, second),
        claim(first, "alpha", 0, true),
        claim(first, "switchboard", 0),
        claim(first, "alpha", 0),
        claim(first, "alpha", 0),
        claim(first, "alpha", 1),
        claim(second, "alpha", 0),
        claim(second, "gamma", 1),
        claim(second, "gamma", 0),
        claim(second, "proj/beta", 1),
      ];

      yield* Effect.tryPromise({
        catch: (cause) => new TestFailure({ message: String(cause) }),
        try: async () => {
          await fc.asyncModelRun(
            () => ({ model: emptyModel(), real }),
            [...required, ...specs.map(command)]
          );
        },
      });
    }).pipe(Effect.scoped),
  { arbitrary: { runs: 25 }, timeout: 30_000 }
);
