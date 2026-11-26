import type * as ListNames from "@rat-king/lexicon/identity.listNames";
import { matchesName } from "@rat-king/ratking-client/directory-view";
import type { RatKing } from "@rat-king/ratking-client/ratking";
import { Effect, Schema } from "effect";

export const DirectoryStatus = Schema.Literals([
  "live",
  "idle",
  "retired",
  "unknown",
]);

const renderPage = (page: ListNames.OutputValue, match: string | undefined) => {
  const lines: string[] = [];
  let { cursor } = page;
  let previous: string | undefined;

  for (const entry of page.names) {
    if (match !== undefined && !matchesName(entry.name, match)) {
      previous = entry.name;
      continue;
    }

    const did =
      entry.did.length > 512 ? `${entry.did.slice(0, 512)}…` : entry.did;

    const line = `- ${entry.name} · ${did} · ${entry.status ?? "non-retired"}${entry.roleTarget === true ? " · role target" : ""}${entry.parent === undefined ? "" : ` · child of ${entry.parent.name}`}`;

    if (new TextEncoder().encode([...lines, line].join("\n")).length > 3500) {
      cursor = previous;
      break;
    }

    lines.push(line);
    previous = entry.name;
  }

  return { cursor, lines };
};

interface DirectoryParams {
  readonly all?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  readonly match?: string;
  readonly offset?: number;
  readonly status?: unknown;
}

const directoryRequest = (
  params: DirectoryParams,
  cursor: string | undefined,
  offset: number,
  statuses: readonly string[]
) => {
  const request: ListNames.ParamsValue = {
    limit: Math.min(offset > 0 ? offset : (params.limit ?? 50), 100),
  };

  if (params.all !== undefined) {
    Object.assign(request, { all: params.all });
  }

  if (cursor !== undefined) {
    Object.assign(request, { cursor });
  }

  if (params.match !== undefined) {
    Object.assign(request, { match: params.match });
  }

  if (statuses.length > 0) {
    Object.assign(request, { status: statuses.join(",") });
  }

  return request;
};

export const directoryPage = Effect.fn("RatKing.directoryPage")(
  function* directoryPage(
    ratking: Pick<typeof RatKing.Service, "directory">,
    params: DirectoryParams
  ) {
    const status =
      params.status === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(
            Schema.Union([DirectoryStatus, Schema.Array(DirectoryStatus)])
          )(params.status);

    const statuses = Schema.is(DirectoryStatus)(status)
      ? [status]
      : (status ?? []);

    let offset = params.offset ?? 0;

    if (
      offset > 0 &&
      params.all !== true &&
      statuses?.some((value) => value === "live" || value === "idle")
    ) {
      return "Live/idle pages use cursor: instead of offset:. Use `ratking snapshot` for inventory or look up a single named row.";
    }

    let { cursor } = params;
    let page: ListNames.OutputValue;

    do {
      page = yield* ratking.directory(
        directoryRequest(params, cursor, offset, statuses)
      );
      ({ cursor } = page);

      if (offset === 0) {
        break;
      }

      offset -= page.names.length;

      if (cursor === undefined) {
        return "0 shown · end of directory.";
      }
    } while (cursor !== undefined);

    const rendered = renderPage(
      offset === 0 ? page : { ...page, names: [] },
      params.match
    );

    return [
      `${rendered.lines.length} shown${page.scanned === undefined ? "" : ` · scanned ${page.scanned}`}`,
      ...rendered.lines,
      rendered.cursor === undefined
        ? "End of directory."
        : `More to scan; continue with cursor: ${JSON.stringify(rendered.cursor)} and the same filters.`,
      params.all === true || statuses?.includes("retired")
        ? ""
        : "Retired hidden; use status: retired or all: true.",
    ]
      .filter(Boolean)
      .join("\n");
  }
);
