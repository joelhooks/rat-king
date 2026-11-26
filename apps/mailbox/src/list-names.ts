import * as ListNames from "@rat-king/lexicon/identity.listNames";
import * as ListRetired from "@rat-king/lexicon/identity.listRetired";
import type { XrpcFailure } from "@rat-king/lexicon/xrpc-failure";
import { Clock, Context, Effect, Layer, Schema } from "effect";

import { failure } from "./failure.ts";
import { IssuerStore } from "./issuer-store.ts";
import type { IssuedName, RetiredName } from "./issuer-store.ts";
import { observedStatus } from "./name-state.ts";
import { isoTime } from "./retirement.ts";

export const projectionViews = (value?: string) => {
  const enabled = new Set(value?.split(","));

  return {
    names: enabled.has("names"),
    retired: enabled.has("retired"),
    snapshot: enabled.has("snapshot"),
  };
};

export type ProjectionViews = ReturnType<typeof projectionViews>;

export const directoryMode = (configured?: string) => {
  if (configured === undefined) {
    return "bootstrap";
  }

  const { names, retired, snapshot } = projectionViews(configured);

  return names || retired || snapshot ? "projected" : "degraded";
};

export const isDirectoryMethod = (nsid: string) =>
  nsid === ListNames.Method.nsid || nsid === ListRetired.Method.nsid;

export const retiredOutput = (retired: RetiredName) => {
  const row = {
    by: retired.by,
    did: retired.did,
    name: retired.name,
    retiredAt: isoTime(retired.retiredAt),
  };

  if (retired.successor !== undefined) {
    Object.assign(row, { successor: retired.successor });
  }

  if (retired.updatedAt !== undefined) {
    Object.assign(row, { updatedAt: isoTime(retired.updatedAt) });
  }

  if (retired.observedAt !== undefined) {
    Object.assign(row, { observedAt: isoTime(retired.observedAt) });
  }

  return row;
};

const encodeListEntry = (
  row: IssuedName,
  status: ReturnType<typeof observedStatus>,
  projected: boolean
) => {
  const entry = { did: row.did, document: row.document, name: row.name };

  if (row.parent !== undefined) {
    Object.assign(entry, { parent: row.parent });
  }

  if (row.roleTarget) {
    Object.assign(entry, { roleTarget: true });
  }

  if (projected || status === "retired") {
    Object.assign(entry, { status });
  }

  if (projected && row.observation !== undefined) {
    Object.assign(entry, { observedAt: isoTime(row.observation.observedAt) });
  }

  return entry;
};

const rowStatus = (row: IssuedName, projected: boolean, now: number) => {
  if (projected) {
    return observedStatus(row.observation, now);
  }

  return row.retired ? "retired" : "unknown";
};

const enumeratePage = Effect.fn("Issuer.enumeratePage")(function* enumeratePage(
  params: ListNames.ParamsValue,
  projected: boolean
) {
  const store = yield* IssuerStore;
  const now = yield* Clock.currentTimeMillis;
  const limit = params.limit ?? ListNames.Method.defaults.limit;
  const statuses = params.status?.split(",");
  const found: ReturnType<typeof encodeListEntry>[] = [];
  let cursor = params.cursor ?? "";
  let scanned = 0;
  let more = true;

  while (more && found.length <= limit && scanned < 200) {
    const size = Math.min(limit + 1 - found.length, 200 - scanned);
    const after = cursor;

    const candidates = yield* store.transaction((tx) =>
      tx.names(after, size + 1, "all", params.match)
    );

    const batch = candidates.slice(0, size);
    more = candidates.length > size;

    for (const row of batch) {
      const status = rowStatus(row, projected, now);

      if (
        params.all === true ||
        (statuses?.includes(status) ?? status !== "retired")
      ) {
        found.push(encodeListEntry(row, status, projected));
      }
    }

    scanned += batch.length;
    cursor = batch.at(-1)?.name ?? cursor;
  }

  const names = found.slice(0, limit);
  const page = { names, scanned };
  const last = names.at(-1)?.name;

  if (found.length > limit && last !== undefined) {
    return { ...page, cursor: last };
  }

  return more ? { ...page, cursor } : page;
});

interface Enumeration {
  readonly listNames: (
    params: ListNames.ParamsValue
  ) => Effect.Effect<ListNames.OutputValue, XrpcFailure>;
  readonly listRetired: (
    params: ListRetired.ParamsValue
  ) => Effect.Effect<ListRetired.OutputValue, XrpcFailure>;
}

export class IssuerEnumeration extends Context.Service<
  IssuerEnumeration,
  Enumeration
>()("mailbox/IssuerEnumeration") {}

export const enumeration = (
  views: ProjectionViews
): Layer.Layer<IssuerEnumeration, never, IssuerStore> =>
  Layer.effect(
    IssuerEnumeration,
    Effect.gen(function* makeEnumeration() {
      const store = yield* IssuerStore;

      return IssuerEnumeration.of({
        listNames: Effect.fn("Issuer.listNames")(function* listNames(params) {
          const projected =
            params.snapshot === true ? views.snapshot : views.names;

          const page = yield* enumeratePage(params, projected).pipe(
            Effect.provideService(IssuerStore, store)
          );

          return yield* Schema.decodeUnknownEffect(ListNames.Output)(page).pipe(
            Effect.mapError(() => failure("MailboxUnavailable", 503))
          );
        }),
        listRetired: Effect.fn("Issuer.listRetired")(
          function* listRetired(params) {
            const limit = params.limit ?? ListRetired.Method.defaults.limit;

            const rows = yield* store.transaction((tx) =>
              (params.snapshot === true ? views.snapshot : views.retired)
                ? tx.projectedRetirements(params.cursor ?? "", limit + 1)
                : tx.retired(params.cursor ?? "", limit + 1)
            );

            const page = rows.slice(0, limit);
            const last = page.at(-1);
            const retired = page.map(retiredOutput);

            const encoded =
              rows.length > limit && last !== undefined
                ? { cursor: last.name, retired }
                : { retired };

            return yield* Schema.decodeUnknownEffect(ListRetired.Output)(
              encoded
            ).pipe(Effect.mapError(() => failure("MailboxUnavailable", 503)));
          }
        ),
      });
    })
  );
