import { it } from "@effect/vitest";
import * as Fork from "@rat-king/lexicon/desk.fork";
import { MailboxHandlers } from "@rat-king/lexicon/mailbox-handlers";
import * as Mark from "@rat-king/lexicon/mailbox.markRead";
import * as Health from "@rat-king/lexicon/mailbox.nameHealth";
import * as Runtime from "@rat-king/lexicon/runtime";
import { Effect, Layer, Option, Schema } from "effect";
import { expect } from "vitest";

import {
  document,
  identity,
} from "../../../packages/mailbox-client/test/identity.ts";
import { AgentName } from "../../../packages/ratking-client/src/name.ts";
import { staticResolver } from "../src/auth.ts";
import { Caller } from "../src/caller.ts";
import { deskStore } from "../src/desk-store.ts";
import { DeskRegistry, deskHandlers, deskRoute } from "../src/desk.ts";
import { pendingPush } from "../src/device.ts";
import { didAllowlist } from "../src/documents.ts";
import { markRead } from "../src/inbox-page.ts";
import { nameDid } from "../src/issuer-policy.ts";
import { issuerStore } from "../src/issuer-store.ts";
import {
  DocumentRegistry,
  issuerHandlers,
  issuerRoute,
  RetirementRegistry,
} from "../src/issuer.ts";
import { mailboxHandlers } from "../src/mailbox.ts";
import {
  nameHealthReaders,
  nameHealthRequest,
} from "../src/name-health-http.ts";
import { nameHealth } from "../src/name-health.ts";
import { trafficPermission } from "../src/traffic-store.ts";
import { testStoreFor, unleasedSender } from "./helpers.ts";

const operator = "did:web:operator.invalid";

const reader = "did:web:reader.invalid";

const didTemplate = "did:web:fixture.invalid:{agent}";

const target = "target";

const recipient = nameDid(didTemplate, target);

const authority = { OPERATOR_DIDS: JSON.stringify([operator]) };

const scopedAuthority = {
  ...authority,
  HEALTH_READER_DIDS: JSON.stringify([reader]),
};

const bindings = {
  absent: authority,
  empty: { ...authority, HEALTH_READER_DIDS: "[]" },
  reader: scopedAuthority,
};

const query = { name: target, recipientDid: recipient };

const healthRequest = (
  env: (typeof bindings)[keyof typeof bindings],
  issuer: string
) => {
  const url = new URL(Health.Method.path, "https://service.invalid");
  url.search = new URLSearchParams(query).toString();

  return nameHealthRequest(
    new Request(url),
    {
      ...env,
      MAILBOX: {
        getByName: (did) => {
          expect(did).toBe(recipient);

          const reply = Promise.resolve({ body: "{}", status: 200 });

          return {
            readNameHealth: (): PromiseLike<{ body: string; status: number }> =>
              reply,
          };
        },
      },
    },
    issuer
  );
};

it.effect.prop(
  "nameHealth admits operators and configured health readers, and an empty binding grants nothing",
  {
    asOperator: Schema.Boolean,
    binding: Schema.Literals(["absent", "empty", "reader"]),
  },
  ({ binding, asOperator }) =>
    Effect.gen(function* access() {
      const env = bindings[binding];
      const issuer = asOperator ? operator : reader;
      const storage = yield* testStoreFor(recipient);
      const params = yield* Schema.decodeEffect(Health.Params)(query);

      const read = nameHealth(
        storage.sql,
        params,
        issuer,
        nameHealthReaders(env)
      );

      const request = healthRequest(env, issuer);

      if (asOperator || binding === "reader") {
        expect((yield* request).status).toBe(200);
        expect((yield* read).retired).toBe(false);
      } else {
        expect(yield* Effect.flip(request)).toMatchObject({
          error: "Forbidden",
          status: 403,
        });
        expect(yield* Effect.flip(read)).toMatchObject({
          error: "Forbidden",
          status: 403,
        });
      }
    })
);

const operators = didAllowlist(scopedAuthority.OPERATOR_DIDS);

const callerLayer = Layer.succeed(Caller, { did: reader });

it.effect.prop(
  "a health reader cannot retire or unretire another name, enroll hosts, record retirements or manage roles and successors",
  { role: AgentName },
  ({ role }) =>
    Effect.gen(function* access() {
      const { sql } = yield* testStoreFor(recipient);
      const peer = yield* document(yield* identity(recipient));

      const layer = issuerHandlers({
        config: Option.some({ didTemplate, reserved: [] }),
        operators,
        staticDids: new Set(),
      }).pipe(
        Layer.provide(issuerStore(sql)),
        Layer.provide(callerLayer),
        Layer.provide(Layer.mock(DocumentRegistry, {})),
        Layer.provide(Layer.mock(RetirementRegistry, {}))
      );

      const inputs = {
        deleteRole: { name: role },
        enrollHost: { document: peer },
        recordRetired: { names: [target] },
        retireName: { name: target },
        setRole: { name: role, role: "fixture", target },
        setSuccessor: { name: target, successor: "replacement" },
        unretireName: { name: target },
      };

      for (const [operation, raw] of Object.entries(inputs)) {
        const input = yield* Schema.decodeUnknownEffect(
          Schema.toEncoded(Runtime.Data)
        )(raw);

        const response = yield* issuerRoute({
          input,
          method: "POST",
          nsid: `sh.mschf.ratking.identity.${operation}`,
          params: undefined,
        }).pipe(Effect.provide(layer));

        expect(response, operation).toMatchObject({ status: 403 });
        expect(JSON.parse(response.body), operation).toMatchObject({
          error: "Forbidden",
        });
      }
    })
);

it.effect.prop(
  "a health reader cannot write documents, mark mail read, read pending push or traffic, or fork an unrelated desk",
  { name: AgentName },
  ({ name }) =>
    Effect.gen(function* access() {
      const did = nameDid(didTemplate, name);
      const storage = yield* testStoreFor(did);
      const peer = yield* document(yield* identity(did));

      const mailbox = yield* MailboxHandlers.pipe(
        Effect.provide(
          mailboxHandlers({
            operators,
            resolvers: [],
            staticDocuments: [],
          }).pipe(
            Layer.provide([
              callerLayer,
              staticResolver([]),
              storage.layer,
              unleasedSender,
            ])
          )
        )
      );

      const mark = yield* Schema.decodeEffect(Mark.Input)({
        recipientDid: did,
        upToSeq: 0,
      });

      expect(
        yield* Effect.flip(mailbox.putDidDocument({ document: peer }))
      ).toMatchObject({ error: "Forbidden" });
      expect(
        yield* Effect.flip(
          markRead(mark, reader, operators).pipe(Effect.provide(storage.layer))
        )
      ).toMatchObject({ error: "Forbidden" });
      expect(
        yield* Effect.flip(pendingPush(storage.sql, reader, operators))
      ).toMatchObject({ error: "Forbidden" });
      expect(() => {
        trafficPermission(reader, operators, []);
      }).toThrow(expect.objectContaining({ error: "Forbidden" }));

      const fork = yield* deskRoute({
        input: { atSeq: 0, desk: did, fromDid: reader },
        method: "POST",
        nsid: Fork.Method.nsid,
        params: undefined,
      }).pipe(
        Effect.provide(
          deskHandlers(did, operators).pipe(
            Layer.provide([
              callerLayer,
              deskStore(storage.sql),
              Layer.mock(DeskRegistry, {
                parent: () => Effect.succeed(operator),
              }),
            ])
          )
        )
      );

      expect(fork.status).toBe(403);
      expect(JSON.parse(fork.body)).toMatchObject({ error: "Forbidden" });
    })
);
