import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import { Effect, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import { routeIssuer } from "../src/issuer-runtime.ts";
import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import { projectionViews } from "../src/list-names.ts";
import { NameCommand } from "../src/name-state.ts";
import { testStoreFor } from "./helpers.ts";

interface PageParams {
  all?: boolean;
  cursor?: string;
  limit: number;
  match?: string;
  snapshot?: boolean;
  status?: string;
}

const operator = "did:web:operator.invalid";

const fixtureName = (index: number) => {
  const name = `team/name-${String(index).padStart(4, "0")}`;
  const did = `did:web:team.name-${index}.example.invalid`;
  const retirement = { by: operator, name, retiredAt: 2 };

  return {
    did,
    name,
    retirement,
    status: ["live", "idle", "retired", "unknown", "unknown"][index % 5],
  };
};

it.effect(
  "pages 6,200 names through every enumeration variant without dispatching a Mailbox call",
  () =>
    Effect.gen(function* proof() {
      yield* TestClock.setTime(100);
      const { sql } = yield* testStoreFor(operator);
      const store = issuerStore(sql);

      const expected = Array.from({ length: 6200 }, (_, index) =>
        fixtureName(index)
      );

      yield* IssuerStore.use((db) =>
        db.transaction((tx) => {
          for (const [index, row] of expected.entries()) {
            const { did, name, retirement, status } = row;
            tx.bind(
              name,
              { did, fingerprint: name, host: operator },
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
                  expectedVersion: 1,
                  opId: name,
                },
                0
              );
            }

            if (index % 5 !== 3) {
              const state = {
                did,
                leaseExpiresAt: status === "live" ? 101 : 100,
                leaseGeneration: 1,
                observedAt: 50,
                retirement: status === "retired" ? retirement : null,
                version: 2,
              };

              tx.observe(state);

              if (index % 5 === 4) {
                tx.observe({ ...state, leaseExpiresAt: 101 });
              }
            }
          }

          const stale = fixtureName(0);
          tx.observe({
            did: stale.did,
            leaseExpiresAt: 0,
            leaseGeneration: 0,
            observedAt: 40,
            retirement: stale.retirement,
            version: 1,
          });
          tx.retire({ ...stale.retirement, did: stale.did });
        })
      ).pipe(Effect.provide(store));
      sql.exec("UPDATE pending_ops SET next_at=0");

      let getByName = 0;

      const call = (nsid: string, params: PageParams, flags: string) =>
        routeIssuer({
          caller: operator,
          mailboxes: {
            getByName: () => {
              getByName += 1;
              throw new Error("enumeration dispatched Mailbox");
            },
          },
          policy: {
            config: Option.none(),
            operators: [operator],
            staticDids: new Set(),
          },
          request: {
            input: undefined,
            method: "GET",
            nsid,
            params: { ...params },
          },
          store,
          views: projectionViews(flags),
        });

      for (const status of [
        undefined,
        "live",
        "idle",
        "retired",
        "unknown",
        "live,idle",
        "retired,live",
        "retired,idle",
        "live,idle,retired,unknown",
        "all",
        "snapshot",
        "no-match",
      ]) {
        const names: string[] = [];
        let cursor: string | undefined;

        do {
          const params: PageParams = {
            limit: 71,
            match: status === "no-match" ? "not a name" : "TEAM/",
          };

          if (cursor !== undefined) {
            params.cursor = cursor;
          }

          if (status === "all" || status === "snapshot") {
            params.all = true;
            params.snapshot = status === "snapshot";
          } else if (status !== undefined && status !== "no-match") {
            params.status = status;
          }

          const result = yield* call(
            ListNames.Method.nsid,
            params,
            status === "snapshot" ? "snapshot" : "names"
          );

          expect(result.status).toBe(200);

          const page = yield* Schema.decodeEffect(
            Schema.fromJsonString(ListNames.Output)
          )(result.body);

          for (const entry of page.names) {
            expect(entry.observedAt === undefined).toBe(
              entry.status === "unknown"
            );
            names.push(entry.name);
          }

          ({ cursor } = page);
        } while (cursor !== undefined);

        expect(names).toEqual(
          expected
            .filter(
              (row) =>
                status === "all" ||
                status === "snapshot" ||
                (status === undefined
                  ? row.status !== "retired"
                  : status.split(",").some((part) => part === row.status))
            )
            .map(({ name }) => name)
        );
      }

      for (const snapshot of [false, true]) {
        let cursor: string | undefined;
        const names: string[] = [];

        do {
          const params: PageParams = {
            limit: 83,
            snapshot,
          };

          if (cursor !== undefined) {
            params.cursor = cursor;
          }

          const result = yield* call(
            ListRetired.Method.nsid,
            params,
            snapshot ? "snapshot" : "retired"
          );

          const page = yield* Schema.decodeEffect(
            Schema.fromJsonString(ListRetired.Output)
          )(result.body);

          names.push(...page.retired.map(({ name }) => name));
          expect(
            page.retired.every(({ observedAt }) => observedAt !== undefined)
          ).toBe(true);
          ({ cursor } = page);
        } while (cursor !== undefined);

        expect(names).toEqual(
          expected
            .filter(({ status }) => status === "retired")
            .map(({ name }) => name)
        );
      }

      const degraded = yield* call(
        ListNames.Method.nsid,
        { limit: 1, status: "live" },
        ""
      );

      const unavailable = yield* Schema.decodeEffect(
        Schema.fromJsonString(ListNames.Output)
      )(degraded.body);

      expect(unavailable.names).toEqual([]);
      expect([...sql.exec("SELECT op_id FROM pending_ops")]).toHaveLength(4);
      expect(getByName).toBe(0);
    }).pipe(Effect.scoped),
  30_000
);
