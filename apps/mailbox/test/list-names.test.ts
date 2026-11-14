import { it } from "@effect/vitest";
import * as ListNames from "@rat-king/lexicon/identity.listNames";
import { Arbitrary, Effect, Schema } from "effect";
import * as fc from "fast-check";
import { expect } from "vitest";

import { IssuerStore, issuerStore } from "../src/issuer-store.ts";
import type { IssuerTransaction } from "../src/issuer-store.ts";
import { namePage } from "../src/list-names.ts";
import { testStoreFor } from "./helpers.ts";

const Row = Schema.Struct({
  live: Schema.Boolean,
  retired: Schema.Boolean,
  role: Schema.Boolean,
});

const Rows = Schema.Array(Row).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(45)
);

const Limit = Schema.Int.check(Schema.isBetween({ maximum: 10, minimum: 1 }));

const seed = Effect.fn("test.seedNames")(function* seed(
  rows: readonly (typeof Row.Type)[]
) {
  const db = yield* testStoreFor("did:web:issuer.example.invalid");
  const store = yield* IssuerStore.pipe(Effect.provide(issuerStore(db.sql)));
  yield* store.transaction((tx) => {
    for (const [index, row] of rows.entries()) {
      const name = `name-${String(index).padStart(3, "0")}`;
      const did = `did:web:${name}.example.invalid`;
      tx.bind(
        name,
        { did, fingerprint: name, host: "did:web:host.example.invalid" },
        {
          authentication: [],
          id: did,
          keyAgreement: [],
          verificationMethod: [],
        }
      );

      if (row.retired) {
        tx.retire({ by: did, did, name, retiredAt: 1 });
      }

      if (row.role) {
        tx.setRole({
          name: `role-${index}`,
          role: "standing desk",
          target: name,
        });
      }
    }
  });

  return store;
});

it.effect.prop(
  "SQL pages fill across retired rows, preserve role targets and never inspect leases",
  [
    Arbitrary.schema(Rows),
    Arbitrary.schema(Limit),
    Arbitrary.schema(
      Schema.Literals(["", "NAME-0", "ame-", "name-%", "name_", "name-000/"])
    ),
  ],
  ([rows, limit, match]) =>
    Effect.gen(function* proof() {
      const store = yield* seed(rows);

      const queries: ListNames.ParamsValue[] = [
        { match },
        { match, status: "retired" },
        { all: true, match },
      ];

      for (const params of queries) {
        const expected = rows
          .flatMap((row, index) =>
            params.all === true || row.retired === (params.status !== undefined)
              ? [`name-${String(index).padStart(3, "0")}`]
              : []
          )
          .filter((name) =>
            match.endsWith("/")
              ? name.startsWith(match.toLowerCase())
              : name.includes(match.toLowerCase())
          );

        const names: string[] = [];
        let cursor: string | undefined;

        do {
          const request = { ...params, limit };

          if (cursor !== undefined) {
            Object.assign(request, { cursor });
          }

          const page = yield* namePage(
            request,
            () => Effect.die("SQL listing must not inspect leases"),
            store
          );

          expect(page.names.map((entry) => entry.name)).toEqual(
            expected.slice(names.length, names.length + limit)
          );

          for (const entry of page.names) {
            expect(entry.roleTarget).toBe(
              rows[Number(entry.name.slice(5))]?.role
            );
            expect(entry.status).toBe(entry.retired ? "retired" : undefined);
          }

          names.push(...page.names.map((entry) => entry.name));
          ({ cursor } = page);
          expect(cursor).toBe(
            names.length < expected.length ? names.at(-1) : undefined
          );
        } while (cursor !== undefined);

        expect(names).toEqual(expected);
      }
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "lease filters classify candidates and preserve cursor order for combined statuses",
  [
    Arbitrary.schema(Rows),
    Arbitrary.schema(Limit),
    Arbitrary.schema(Schema.Boolean),
  ],
  ([rows, limit, includeRetired]) =>
    Effect.gen(function* proof() {
      const store = yield* seed(rows);
      const status = includeRetired ? "live,retired" : "idle";

      const expected = rows.flatMap((row, index) =>
        (row.retired ? includeRetired : row.live === includeRetired)
          ? [`name-${String(index).padStart(3, "0")}`]
          : []
      );

      let cursor: string | undefined;
      const names: string[] = [];
      let inFlight = 0;
      let maximum = 0;

      const presence = Effect.fn("test.presence")(function* presence(
        did: string
      ) {
        inFlight += 1;
        maximum = Math.max(maximum, inFlight);
        yield* Effect.yieldNow;
        inFlight -= 1;

        const row =
          rows[Number(did.split(":").at(-1)?.split(".")[0]?.slice(5))];

        return { leaseExpiresAt: row?.live === true ? 1 : 0 };
      });

      do {
        const request = { limit, status };

        if (cursor !== undefined) {
          Object.assign(request, { cursor });
        }

        const page = yield* namePage(request, presence, store);

        expect(page.names.map((entry) => entry.name)).toEqual(
          expected.slice(names.length, names.length + limit)
        );
        names.push(...page.names.map((entry) => entry.name));
        ({ cursor } = page);
      } while (cursor !== undefined);

      expect(names).toEqual(expected);
      expect(maximum).toBeLessThanOrEqual(8);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "a sparse lease scan stops at 200 and resumes even after an empty page",
  [Arbitrary.schema(Schema.Boolean)],
  ([live]) =>
    Effect.gen(function* proof() {
      const rows = Array.from({ length: 240 }, () => ({
        live: false,
        retired: false,
        role: false,
      }));

      const store = yield* seed(rows);
      let calls = 0;

      const presence = () =>
        Effect.sync(() => {
          calls += 1;

          return { leaseExpiresAt: live ? 0 : 1 };
        });

      const first = yield* namePage(
        { status: live ? "live" : "idle" },
        presence,
        store
      );

      expect(first.names).toEqual([]);
      expect(first.scanned).toBe(200);
      expect(first.cursor).toBe("name-199");
      expect(calls).toBe(200);

      const second = yield* namePage(
        { cursor: "name-199", status: live ? "live" : "idle" },
        presence,
        store
      );

      expect(second.names).toEqual([]);
      expect(second.scanned).toBe(40);
      expect(second.cursor).toBeUndefined();
      expect(calls).toBe(240);
    }).pipe(Effect.scoped)
);

it.effect.prop(
  "status filters survive XRPC query encoding",
  [
    Arbitrary.schema(
      Schema.Array(Schema.Literals(["live", "idle", "retired"])).check(
        Schema.isMaxLength(3)
      )
    ),
  ],
  ([status]) =>
    Effect.gen(function* proof() {
      const params = {
        all: false,
        cursor: "name-000",
        limit: 7,
      };

      if (status.length > 0) {
        Object.assign(params, { status: status.join(",") });
      }

      expect(
        yield* ListNames.decodeParams(yield* ListNames.encodeParams(params))
      ).toEqual(params);
    })
);

class ChangeRetirement implements fc.Command<Set<number>, IssuerTransaction> {
  readonly index: number;
  readonly retired: boolean;

  constructor(index: number, retired: boolean) {
    this.index = index;
    this.retired = retired;
  }

  check(model: Set<number>) {
    return this.retired !== model.has(this.index);
  }

  run(model: Set<number>, tx: IssuerTransaction) {
    const { index, retired } = this;
    const name = `name-${String(index).padStart(3, "0")}`;
    const did = `did:web:${name}.example.invalid`;

    if (retired) {
      tx.retire({ by: did, did, name, retiredAt: 1 });
      model.add(index);
    } else {
      tx.unretire(name);
      model.delete(index);
    }

    const names = Array.from(
      { length: 10 },
      (_, row) => `name-${String(row).padStart(3, "0")}`
    );

    expect(tx.names("", 100).map((entry) => entry.name)).toEqual(
      names.filter((_name, row) => !model.has(row))
    );
    expect(tx.names("", 100, "retired").map((entry) => entry.name)).toEqual(
      names.filter((_name, row) => model.has(row))
    );
  }

  toString() {
    return `${this.retired ? "retire" : "unretire"}(${this.index})`;
  }
}

it.effect.prop(
  "lease filters do not guess idle when an older mailbox omits lease evidence",
  [Arbitrary.schema(Schema.Boolean)],
  ([live]) =>
    Effect.gen(function* proof() {
      const store = yield* seed([{ live: false, retired: false, role: false }]);

      const error = yield* namePage(
        { status: live ? "live" : "idle" },
        () => Effect.succeed({}),
        store
      ).pipe(Effect.flip);

      expect(error.error).toBe("MailboxUnavailable");
      expect(error.status).toBe(503);
    }).pipe(Effect.scoped)
);

const RetirementChange = Schema.Struct({
  index: Schema.Int.check(Schema.isBetween({ maximum: 9, minimum: 0 })),
  retired: Schema.Boolean,
});

it.effect.prop(
  "retire and unretire commands immediately update directory visibility",
  [
    Arbitrary.schema(
      Schema.Array(RetirementChange).check(Schema.isMaxLength(30))
    ),
  ],
  ([changes]) =>
    Effect.gen(function* proof() {
      const store = yield* seed(
        Array.from({ length: 10 }, () => ({
          live: false,
          retired: false,
          role: false,
        }))
      );

      yield* store.transaction((tx) => {
        fc.modelRun(
          () => ({ model: new Set<number>(), real: tx }),
          changes.map(
            ({ index, retired }) => new ChangeRetirement(index, retired)
          )
        );
      });
    }).pipe(Effect.scoped)
);
