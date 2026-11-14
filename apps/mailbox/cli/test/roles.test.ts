import { it } from "@effect/vitest";
import * as DeleteRole from "@rat-king/lexicon/identity.deleteRole";
import * as ListRoles from "@rat-king/lexicon/identity.listRoles";
import * as SetRole from "@rat-king/lexicon/identity.setRole";
import * as SetSuccessor from "@rat-king/lexicon/identity.setSuccessor";
import { Arbitrary, Effect, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { expect } from "vitest";

import type { CliError } from "../identity.ts";
import { deleteRole, listRoles, setRole, setSuccessor } from "../retire.ts";
import { SecretStore } from "../secrets.ts";
import { identity } from "./helpers.ts";
import { memorySecretStoreLayer } from "./secret-store.ts";

const authority = {
  endpoint: "https://mailbox.example.invalid",
  operatorSecret: "operator",
  serviceDid: "did:web:mailbox.example.invalid",
};

const role = { name: "proj", role: "Project desk", target: "proj/row" };

const retirement = {
  by: "did:web:operator.example.invalid",
  did: "did:web:proj.old.example.invalid",
  name: "proj/old",
  retiredAt: "2026-10-01T00:00:00.000Z",
  successor: "proj",
  updatedAt: "2026-10-29T00:00:00.000Z",
};

const pages = [
  { cursor: "a", roles: [role] },
  { roles: [{ ...role, name: "owners", target: "owners" }] },
];

const Operation = Schema.Literals(["set", "delete", "list", "successor"]);

const answer = (nsid: string, cursor: string | null) => {
  switch (nsid) {
    case SetRole.Method.nsid: {
      return role;
    }

    case DeleteRole.Method.nsid: {
      return { deleted: true, name: "proj" };
    }

    case SetSuccessor.Method.nsid: {
      return retirement;
    }

    default: {
      return pages[cursor === null ? 0 : 1];
    }
  }
};

const invocations: Record<
  typeof Operation.Type,
  () => Effect.Effect<unknown, CliError, HttpClient.HttpClient | SecretStore>
> = {
  delete: () => deleteRole(authority, "proj"),
  list: () => listRoles(authority),
  set: () => setRole(authority, role),
  successor: () => setSuccessor(authority, "proj/old", "proj"),
};

it.effect.prop(
  "role and successor commands sign one operator request per page and print the issuer's JSON unchanged",
  [Arbitrary.schema(Operation)],
  ([operation]) =>
    Effect.gen(function* commands() {
      const store = yield* SecretStore;

      yield* store.add(
        "operator",
        JSON.stringify(yield* identity("did:web:operator.example.invalid"))
      );

      const requests: { nsid: string; body: unknown; method: string }[] = [];

      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          const url = new URL(request.url);
          const nsid = url.pathname.replace("/xrpc/", "");

          expect(request.headers.authorization).toMatch(/^Bearer /u);
          requests.push({
            body: Predicate.isTagged(request.body, "Uint8Array")
              ? JSON.parse(new TextDecoder().decode(request.body.body))
              : null,
            method: request.method,
            nsid,
          });

          return HttpClientResponse.fromWeb(
            request,
            Response.json(answer(nsid, url.searchParams.get("cursor")))
          );
        })
      );

      const printed = yield* invocations[operation]().pipe(
        Effect.provideService(HttpClient.HttpClient, http)
      );

      const expected = {
        delete: {
          printed: { deleted: true, name: "proj" },
          requests: [
            {
              body: { name: "proj" },
              method: "POST",
              nsid: DeleteRole.Method.nsid,
            },
          ],
        },
        list: {
          printed: { roles: pages.flatMap((page) => page.roles) },
          requests: [
            { body: null, method: "GET", nsid: ListRoles.Method.nsid },
            { body: null, method: "GET", nsid: ListRoles.Method.nsid },
          ],
        },
        set: {
          printed: role,
          requests: [{ body: role, method: "POST", nsid: SetRole.Method.nsid }],
        },
        successor: {
          printed: retirement,
          requests: [
            {
              body: { name: "proj/old", successor: "proj" },
              method: "POST",
              nsid: SetSuccessor.Method.nsid,
            },
          ],
        },
      }[operation];

      expect(printed).toEqual(expected.printed);
      expect(requests).toEqual(expected.requests);
    }).pipe(Effect.provide(memorySecretStoreLayer))
);
