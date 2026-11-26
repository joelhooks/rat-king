import * as ListNames from "@rat-king/lexicon/identity.listNames";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Effect } from "effect";

import { failure } from "./failure.ts";
import type { IssuerStore, IssuedName } from "./issuer-store.ts";

type Status = "live" | "idle" | "retired";

type Presence = (
  did: string
) => Effect.Effect<
  { readonly leaseExpiresAt?: number | undefined },
  XrpcFailure
>;

export interface ClassifiedName extends IssuedName {
  readonly status?: Status;
}

interface NamePage {
  names: readonly ClassifiedName[];
  scanned: number;
  cursor?: string;
}

const candidateFilter = (
  all: boolean,
  statuses: readonly string[],
  classify: boolean
) => {
  if (all || (classify && statuses.includes("retired"))) {
    return "all";
  }

  return statuses.includes("retired") ? "retired" : "active";
};

const reserveScanReads = Effect.fn("Issuer.reserveScanReads")(
  function* reserveScanReads(
    store: typeof IssuerStore.Service,
    caller: string,
    reads: number
  ) {
    if (reads === 0) {
      return yield* Effect.void;
    }

    const now = yield* Clock.currentTimeMillis;

    const admitted = yield* store.transaction((tx) =>
      tx.spendScanReads(caller, now, reads)
    );

    return yield* admitted
      ? Effect.void
      : failure(
          "ScanBudgetSpent",
          429,
          "Mailbox scan budget spent. Use `ratking snapshot` for inventory or look up a single named row."
        );
  }
);

const classifyName = Effect.fn("Issuer.classifyName")(function* classifyName(
  row: IssuedName,
  classify: boolean,
  presence: Presence,
  now: number
): Effect.fn.Return<ClassifiedName, XrpcFailure> {
  if (row.retired) {
    return { ...row, status: "retired" };
  }

  if (!classify) {
    return row;
  }

  const standing = yield* presence(row.did);

  if (standing.leaseExpiresAt === undefined) {
    return yield* failure(
      "MailboxUnavailable",
      503,
      "Mailbox lease state is unavailable; retry after the mailbox is upgraded"
    );
  }

  return {
    ...row,
    status: standing.leaseExpiresAt > now ? "live" : "idle",
  };
});

export const namePage = Effect.fn("Issuer.namePage")(function* namePage(
  params: ListNames.ParamsValue,
  presence: Presence,
  store: typeof IssuerStore.Service,
  caller: string
) {
  const now = yield* Clock.currentTimeMillis;
  const limit = params.limit ?? ListNames.Method.defaults.limit;
  const statuses = params.all === true ? [] : (params.status?.split(",") ?? []);
  const classify = statuses.includes("live") || statuses.includes("idle");
  const filter = candidateFilter(params.all === true, statuses, classify);
  const found: ClassifiedName[] = [];
  let cursor = params.cursor ?? "";
  let scanned = 0;
  let more = true;

  while (more && found.length <= limit && scanned < 200) {
    const size = Math.min(limit + 1 - found.length, 200 - scanned);
    const after = cursor;

    const candidates = yield* store.transaction((tx) =>
      tx.names(after, size + 1, filter, params.match)
    );

    const batch = candidates.slice(0, size);

    more = candidates.length > size;

    if (classify) {
      yield* reserveScanReads(
        store,
        caller,
        batch.filter((row) => !row.retired).length
      );
    }

    const entries = yield* Effect.forEach(
      batch,
      (row) => classifyName(row, classify, presence, now),
      { concurrency: 8 }
    );

    found.push(
      ...entries.filter(
        (entry) =>
          !classify ||
          (entry.status !== undefined && statuses.includes(entry.status))
      )
    );
    scanned += batch.length;
    cursor = batch.at(-1)?.name ?? cursor;
  }

  const names = found.slice(0, limit);
  let next = more ? cursor : undefined;

  if (found.length > limit) {
    next = names.at(-1)?.name;
  }

  const page: NamePage = { names, scanned };

  if (next !== undefined) {
    page.cursor = next;
  }

  return page;
});
