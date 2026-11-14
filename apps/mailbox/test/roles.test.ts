import { it } from "@effect/vitest";
import * as Defs from "@rat-king/lexicon/defs";
import * as DeleteRole from "@rat-king/lexicon/identity.deleteRole";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import * as ListRoles from "@rat-king/lexicon/identity.listRoles";
import * as Register from "@rat-king/lexicon/identity.register";
import * as ResolveRecipient from "@rat-king/lexicon/identity.resolveRecipient";
import * as Retire from "@rat-king/lexicon/identity.retireName";
import * as SetRole from "@rat-king/lexicon/identity.setRole";
import * as SetSuccessor from "@rat-king/lexicon/identity.setSuccessor";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import type { Request as XrpcRequest } from "@rat-king/lexicon/transport";
import {
  Arbitrary,
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { sealed } from "../../../packages/envelope/test/helpers.ts";
import { staticResolver } from "../src/auth.ts";
import { Caller } from "../src/caller.ts";
import { nameDid } from "../src/issuer-policy.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
} from "../src/issuer.ts";
import { handlersLayer } from "../src/mailbox.ts";
import { confirmResolution } from "../src/resolution.ts";
import { MAX_HOPS, resolveRoute } from "../src/roles.ts";
import type { RetirementValue } from "../src/store.ts";
import { MailboxStore } from "../src/store.ts";
import { pendingTraffic } from "../src/traffic-store.ts";
import {
  documents,
  storeRetirements,
  testStoreFor,
  unleasedSender,
} from "./helpers.ts";

const didTemplate = "did:web:{agent}.pi.example.invalid";

const operator = "did:web:operator.example.invalid";

const host = "did:web:host.example.invalid";

const stranger = "did:web:stranger.example.invalid";

const reserved = "switchboard";

const rows = ["proj/a", "proj/b", "proj/c", "proj/d", "proj/e", "proj/f"];

const ErrorBody = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.String,
    message: Schema.optionalKey(Schema.String),
  })
);

const decode = <S extends Schema.Top>(schema: S, body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body);

const refusal = (response: { readonly status: number; body: string }) => {
  const body = Schema.decodeUnknownSync(ErrorBody)(response.body);

  return { error: body.error, message: body.message ?? "" };
};

const documentJson = (id: string) => ({
  authentication: [`${id}#atproto`],
  id,
  keyAgreement: [`${id}#encryption`],
  verificationMethod: [
    {
      controller: id,
      id: `${id}#atproto`,
      publicKeyJwk: { crv: "P-256", kty: "EC", x: "x", y: "y" },
    },
  ],
});

const documentFor = (id: string) =>
  Schema.decodeUnknownSync(Defs.DidDocument)(documentJson(id));

const harness = Effect.gen(function* harness() {
  const issuerStorage = yield* testStoreFor("did:web:issuer.example.invalid");
  const issuerLayer = issuerStore(issuerStorage.sql);
  const mailboxes = new Map<string, typeof MailboxStore.Service>();

  for (const row of [
    ...rows,
    "proj/unbound",
    "proj/ghost",
    reserved,
    "proj",
    "owners",
  ]) {
    const did = nameDid(didTemplate, row);
    const storage = yield* testStoreFor(did);

    mailboxes.set(did, yield* MailboxStore.pipe(Effect.provide(storage.layer)));
  }

  const mailbox = (did: string) => {
    const found = mailboxes.get(did);

    return found === undefined
      ? Effect.die(new Error(`no test mailbox for ${did}`))
      : Effect.succeed(found);
  };

  const bind = (row: string) =>
    Effect.gen(function* bindRow() {
      const did = nameDid(didTemplate, row);
      const document = documentFor(did);

      yield* (yield* mailbox(did)).transaction((tx) => {
        tx.setDocument(document);
      });
      yield* IssuerStore.use((store) =>
        store.transaction((tx) => {
          tx.bind(row, { did, fingerprint: "seed", host }, document);
        })
      ).pipe(Effect.provide(issuerLayer));
    });

  for (const row of rows) {
    yield* bind(row);
  }

  const unbound = documentFor(nameDid(didTemplate, "proj/unbound"));

  yield* (yield* mailbox(unbound.id)).transaction((tx) => {
    tx.setDocument(unbound);
  });

  const call = (caller: string, request: XrpcRequest) =>
    issuerRoute(request).pipe(
      Effect.provide(
        issuerHandlers({
          config: Option.some({ didTemplate, reserved: [reserved] }),
          operators: [operator],
        }).pipe(
          Layer.provide(issuerLayer),
          Layer.provide(
            Layer.mock(DocumentRegistry, { put: () => Effect.void })
          ),
          Layer.provide(storeRetirements(mailbox)),
          Layer.provide(Layer.succeed(Caller, { did: caller }))
        )
      )
    );

  const procedure = (
    caller: string,
    nsid: string,
    input: Record<string, string>
  ) => call(caller, { input, method: "POST", nsid, params: undefined });

  const query = (
    caller: string,
    nsid: string,
    params: Record<string, string | number>
  ) => call(caller, { input: undefined, method: "GET", nsid, params });

  const resolve = (name: string) =>
    query(stranger, ResolveRecipient.Method.nsid, { name });

  const seedRetired = (row: string, successor?: string) =>
    Effect.gen(function* seedRetirement() {
      const did = nameDid(didTemplate, row);

      const retirement: RetirementValue =
        successor === undefined
          ? { by: operator, name: row, retiredAt: 1 }
          : { by: operator, name: row, retiredAt: 1, successor };

      yield* (yield* mailbox(did)).transaction((tx) => {
        tx.setRetirement(retirement);
      });
      yield* IssuerStore.use((store) =>
        store.transaction((tx) => {
          tx.retire({ ...retirement, did });
        })
      ).pipe(Effect.provide(issuerLayer));
    });

  const bindAs = (row: string, did: string) =>
    IssuerStore.use((store) =>
      store.transaction((tx) => {
        tx.bind(row, { did, fingerprint: "seed", host }, documentFor(did));
      })
    ).pipe(Effect.provide(issuerLayer));

  const seedRole = (name: string, target: string) =>
    IssuerStore.use((store) =>
      store.transaction((tx) => {
        tx.setRole({ name, role: "seeded", target });
      })
    ).pipe(Effect.provide(issuerLayer));

  return {
    bindAs,
    call,
    mailbox,
    procedure,
    query,
    resolve,
    seedRetired,
    seedRole,
  };
});

const NodeKind = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("live") }),
  Schema.Struct({
    kind: Schema.Literals(["role", "forward"]),
    to: Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 })),
  }),
  Schema.Struct({ kind: Schema.Literal("dead") }),
]);

it.effect.prop(
  "resolution never ends at a retired name or a redirecting role, follows only real edges and stops at 3 hops",
  [
    Arbitrary.schema(
      Schema.Tuple([NodeKind, NodeKind, NodeKind, NodeKind, NodeKind, NodeKind])
    ),
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 5, minimum: 0 }))
    ),
  ],
  ([graph, start]) =>
    Effect.gen(function* resolution() {
      const nodeOf = (name: string) =>
        graph[rows.indexOf(name)] ?? { kind: "live" as const };

      const target = (name: string) => {
        const node = nodeOf(name);

        return "to" in node ? (rows[node.to] ?? name) : undefined;
      };

      const retirementOf = (name: string): Option.Option<RetirementValue> => {
        const node = nodeOf(name);

        if (node.kind === "dead") {
          return Option.some({ by: operator, name, retiredAt: 1 });
        }

        if (node.kind === "forward") {
          return Option.some({
            by: operator,
            name,
            retiredAt: 1,
            successor: target(name) ?? name,
          });
        }

        return Option.none();
      };

      const view = {
        retired: (name: string) => Effect.succeed(retirementOf(name)),
        role: (name: string) =>
          Effect.succeed(
            nodeOf(name).kind === "role" ? target(name) : undefined
          ),
      };

      const from = rows[start] ?? "proj/a";
      const outcome = yield* resolveRoute(from, view).pipe(Effect.result);

      if (Result.isSuccess(outcome)) {
        const { chain, name } = outcome.success;
        const last = nodeOf(name);

        expect(
          last.kind === "live" ||
            (last.kind === "role" && target(name) === name)
        ).toBe(true);
        expect(chain[0]).toBe(from);
        expect(chain.at(-1)).toBe(name);
        expect(chain.length - 1).toBeLessThanOrEqual(MAX_HOPS);
        expect(new Set(chain).size).toBe(chain.length);

        for (const [index, hop] of chain.slice(1).entries()) {
          expect(target(chain[index] ?? "")).toBe(hop);
        }
      } else {
        expect(["Retired", "RoleUnresolved"]).toContain(outcome.failure.error);
        expect(outcome.failure.message).toContain(from);
      }
    })
);

it.effect.prop(
  "a forward chain delivers through 1 to 3 hops, and a 4-hop chain or a cycle refuses RoleUnresolved naming the chain",
  [
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))
    ),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([hops, cycle]) =>
    Effect.gen(function* forward() {
      const world = yield* harness;
      const chain = rows.slice(0, hops + 1);

      for (const [index, row] of chain.slice(0, -1).entries()) {
        yield* world.seedRetired(row, chain[index + 1]);
      }

      const last = chain.at(-1) ?? "";

      if (cycle) {
        yield* world.seedRetired(last, chain[0]);
      }

      const response = yield* world.resolve(chain[0] ?? "");

      if (cycle || hops > MAX_HOPS) {
        const refused = refusal(response);

        expect([response.status, refused.error]).toEqual([
          409,
          "RoleUnresolved",
        ]);
        expect(refused.message).toContain(chain.slice(0, 4).join(" → "));
      } else {
        expect(response.status).toBe(200);
        expect(yield* decode(ResolveRecipient.Output, response.body)).toEqual({
          chain,
          did: nameDid(didTemplate, last),
          name: last,
        });
      }
    }).pipe(Effect.scoped)
);

it.effect(
  "a role resolves to its target, through the target's successor, and a dead end refuses Retired with the chain",
  () =>
    Effect.gen(function* roles() {
      const world = yield* harness;

      const set = yield* world.procedure(operator, SetRole.Method.nsid, {
        name: "proj",
        role: "Project owner",
        target: "proj/a",
      });

      expect(set.status).toBe(200);

      const direct = yield* decode(
        ResolveRecipient.Output,
        (yield* world.resolve("proj")).body
      );

      expect(direct).toEqual({
        chain: ["proj", "proj/a"],
        did: nameDid(didTemplate, "proj/a"),
        name: "proj/a",
      });

      yield* world.seedRetired("proj/a", "proj/b");

      expect(
        (yield* decode(
          ResolveRecipient.Output,
          (yield* world.resolve("proj")).body
        )).chain
      ).toEqual(["proj", "proj/a", "proj/b"]);

      yield* world.seedRetired("proj/b");

      const dead = yield* world.resolve("proj");

      expect([dead.status, refusal(dead).error]).toEqual([410, "Retired"]);
      expect(refusal(dead).message).toContain("chain proj → proj/a → proj/b");

      const self = yield* world.procedure(operator, SetRole.Method.nsid, {
        name: reserved,
        role: "Front door",
        target: reserved,
      });

      expect(self.status).toBe(200);
      expect(
        yield* decode(
          ResolveRecipient.Output,
          (yield* world.resolve(reserved)).body
        )
      ).toEqual({ chain: [reserved], name: reserved });
    }).pipe(Effect.scoped)
);

const Subject = Schema.Literals([
  "bound",
  "unbound",
  "reserved",
  "retired",
  "role",
  "fresh",
]);

it.effect.prop(
  "setRole refuses NameCollision for a bound, reserved or retired name unless it is a self-role, UnknownName for an unknown target, and Forbidden for a non-operator",
  [
    Arbitrary.schema(Subject),
    Arbitrary.schema(Schema.Literals(["row", "self", "ghost", "reserved"])),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([subject, targetKind, asOperator]) =>
    Effect.gen(function* collisions() {
      const world = yield* harness;

      const name = {
        bound: "proj/b",
        fresh: "proj",
        reserved,
        retired: "proj/c",
        role: "owners",
        unbound: "proj/unbound",
      }[subject];

      if (subject === "retired") {
        yield* world.seedRetired(name);
      }

      if (subject === "role") {
        yield* world.seedRole(name, "proj/d");
      }

      const target = {
        ghost: "proj/ghost",
        reserved,
        row: "proj/a",
        self: name,
      }[targetKind];

      const response = yield* world.procedure(
        asOperator ? operator : stranger,
        SetRole.Method.nsid,
        { name, role: "A role", target }
      );

      const self = name === target;

      const collides =
        !self && ["bound", "unbound", "reserved", "retired"].includes(subject);

      const knownTarget = self
        ? subject !== "fresh" && subject !== "role"
        : targetKind === "row";

      const expected = Option.firstSomeOf([
        Option.liftPredicate("Forbidden", () => !asOperator),
        Option.liftPredicate("NameCollision", () => collides),
        Option.liftPredicate("UnknownName", () => !knownTarget),
      ]);

      if (Option.isSome(expected)) {
        expect(refusal(response).error).toBe(expected.value);
      } else {
        expect(response.status).toBe(200);
        expect(yield* decode(SetRole.Output, response.body)).toEqual({
          name,
          role: "A role",
          target,
        });
      }
    }).pipe(Effect.scoped)
);

it.effect(
  "a role name cannot be registered, retired or re-pointed, and deleteRole is idempotent",
  () =>
    Effect.gen(function* roleNames() {
      const world = yield* harness;

      yield* world.seedRole("proj", "proj/a");

      const registered = yield* world.call(host, {
        input: {
          document: documentJson(nameDid(didTemplate, "proj")),
          name: "proj",
        },
        method: "POST",
        nsid: Register.Method.nsid,
        params: undefined,
      });

      expect(refusal(registered).error).toBe("NameCollision");

      for (const nsid of [Retire.Method.nsid, SetSuccessor.Method.nsid]) {
        const response = yield* world.procedure(operator, nsid, {
          name: "proj",
          successor: "proj/b",
        });

        expect(refusal(response).error).toBe("NameReserved");
      }

      const remove = world
        .procedure(operator, DeleteRole.Method.nsid, { name: "proj" })
        .pipe(
          Effect.flatMap((response) => decode(DeleteRole.Output, response.body))
        );

      expect((yield* remove).deleted).toBe(true);
      expect((yield* remove).deleted).toBe(false);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "listRoles pages return every role exactly once in name order",
  [
    Arbitrary.schema(
      Schema.Array(Schema.Literals(["r-a", "r-b", "r-c", "r-d", "r-e"]))
    ),
    Arbitrary.schema(
      Schema.Int.check(Schema.isBetween({ maximum: 4, minimum: 1 }))
    ),
  ],
  ([names, limit]) =>
    Effect.gen(function* paging() {
      const world = yield* harness;

      for (const name of names) {
        yield* world.seedRole(name, "proj/a");
      }

      const seen: string[] = [];
      let cursor: string | undefined;

      do {
        const page = yield* decode(
          ListRoles.Output,
          (yield* world.query(
            stranger,
            ListRoles.Method.nsid,
            cursor === undefined ? { limit } : { cursor, limit }
          )).body
        );

        expect(page.roles.length).toBeLessThanOrEqual(limit);
        seen.push(...page.roles.map((role) => role.name));
        ({ cursor } = page);
      } while (cursor !== undefined);

      expect(seen).toEqual([...new Set(names)].toSorted());
    }).pipe(Effect.scoped)
);

const Successor = Schema.Literals([
  "row",
  "role",
  "forwarded",
  "loop",
  "long",
  "ghost",
]);

it.effect.prop(
  "setSuccessor re-points only a retired name, keeps retiredAt and by, stamps updatedAt once, and refuses loops, long chains and unknown successors",
  [Arbitrary.schema(Successor), Arbitrary.schema(Schema.Boolean)],
  ([kind, retired]) =>
    Effect.gen(function* repoint() {
      const world = yield* harness;
      const name = "proj/a";

      if (retired) {
        yield* world.seedRetired(name);
      }

      yield* world.seedRole("owners", "proj/b");
      yield* world.seedRole("loop", name);
      yield* world.seedRetired("proj/c", "proj/d");
      yield* world.seedRetired("proj/d", "proj/e");
      yield* world.seedRetired("proj/e", "proj/f");

      const successor = {
        forwarded: "proj/e",
        ghost: "proj/ghost",
        long: "proj/c",
        loop: "loop",
        role: "owners",
        row: "proj/b",
      }[kind];

      yield* TestClock.setTime(5000);

      const set = () =>
        world.procedure(operator, SetSuccessor.Method.nsid, {
          name,
          successor,
        });

      const first = yield* set();

      const expected = Option.firstSomeOf([
        Option.liftPredicate("RoleUnresolved", () =>
          ["loop", "long"].includes(kind)
        ),
        Option.liftPredicate("UnknownName", () => kind === "ghost"),
        Option.liftPredicate("NotRetired", () => !retired),
      ]);

      if (Option.isSome(expected)) {
        expect(refusal(first).error).toBe(expected.value);

        return;
      }

      yield* TestClock.setTime(9000);

      const second = yield* set();

      for (const response of [first, second]) {
        expect(yield* decode(SetSuccessor.Output, response.body)).toEqual({
          by: operator,
          did: nameDid(didTemplate, name),
          name,
          retiredAt: DateTime.formatIso(DateTime.makeUnsafe(1)),
          successor,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(5000)),
        });
      }

      const listed = yield* decode(
        ListRetired.Output,
        (yield* world.query(stranger, ListRetired.Method.nsid, {})).body
      );

      expect(listed.retired.find((entry) => entry.name === name)).toMatchObject(
        {
          successor,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(5000)),
        }
      );

      expect((yield* world.resolve(name)).status).toBe(200);
    }).pipe(Effect.scoped)
);

it.effect(
  "retireName accepts a role successor and refuses one that leads back to the retiring name",
  () =>
    Effect.gen(function* roleSuccessor() {
      const world = yield* harness;

      yield* world.seedRole("owners", "proj/b");
      yield* world.seedRole("back", "proj/a");

      const looped = yield* world.procedure(operator, Retire.Method.nsid, {
        name: "proj/a",
        successor: "back",
      });

      expect(refusal(looped).error).toBe("RoleUnresolved");

      const accepted = yield* world.procedure(operator, Retire.Method.nsid, {
        name: "proj/a",
        successor: "owners",
      });

      expect(accepted.status).toBe(200);
      expect(
        (yield* decode(
          ResolveRecipient.Output,
          (yield* world.resolve("proj/a")).body
        )).chain
      ).toEqual(["proj/a", "owners", "proj/b"]);
    }).pipe(Effect.scoped)
);

it.effect(
  "a send through a role records resolvedFrom on its receipt and traffic, and is refused once the role points elsewhere",
  () =>
    Effect.gen(function* sendThroughRole() {
      const world = yield* harness;
      const sample = yield* sealed();
      const { envelope } = sample;
      const recipient = envelope.aad.recipientDid;

      yield* world.bindAs("proj/r", recipient);
      yield* world.seedRole("proj", "proj/r");

      const route = (request: XrpcRequest) =>
        world.call(envelope.aad.senderDid, request);

      yield* confirmResolution(route, "proj", recipient);
      yield* world.seedRole("proj", "proj/a");

      const refused = yield* confirmResolution(route, "proj", recipient).pipe(
        Effect.flip
      );

      expect(refused.error).toBe("RoleUnresolved");
      expect(refused.message).toContain("proj → proj/a");

      const unrouted = yield* confirmResolution(
        undefined,
        "proj",
        recipient
      ).pipe(Effect.flip);

      expect(unrouted.error).toBe("MailboxUnavailable");

      const docs = yield* documents(
        sample.keys.sender.publicKey,
        sample.keys.recipient.publicKey
      );

      const storage = yield* testStoreFor(recipient);

      const handlers = yield* MailboxHandlers.pipe(
        Effect.provide(
          handlersLayer.pipe(
            Layer.provide(unleasedSender),
            Layer.provide(storage.layer),
            Layer.provide(staticResolver(docs)),
            Layer.provide(
              Layer.succeed(Caller, { did: envelope.aad.senderDid })
            )
          )
        )
      );

      const { receipt } = yield* handlers.send({
        envelope,
        resolvedFrom: "proj",
      });

      expect(receipt.resolvedFrom).toBe("proj");
      expect(
        pendingTraffic(storage.sql).map((entry) => entry.resolvedFrom)
      ).toEqual(["proj"]);
    }).pipe(Effect.scoped)
);
