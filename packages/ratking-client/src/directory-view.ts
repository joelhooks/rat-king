import type { Listed } from "./directory.ts";

export interface ListParams {
  readonly all?: boolean;
  readonly limit?: number;
  readonly match?: string;
  readonly offset?: number;
}

export interface ListView {
  readonly nextOffset: number;
  readonly shown: number;
  readonly text: string;
}

export const ephemeralName = (name: string): boolean =>
  /(?:^|[/_-])(?:probe|canary)(?:$|[/_-])/iu.test(name) ||
  /(?:^|\/)pi-(?:[0-9a-hjkmnp-tv-z]{26}|[0-9a-f]{8,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{5,12})$/iu.test(
    name
  );

export const matchesName = (name: string, match: string): boolean => {
  const value = name.toLowerCase();
  const query = match.toLowerCase();

  return query.endsWith("/") ? value.startsWith(query) : value.includes(query);
};

const bytes = (text: string): number => new TextEncoder().encode(text).length;

const shortLine = (text: string, maximum = 3500): string => {
  const line = text.replaceAll(/[\r\n]/gu, " ");

  if (bytes(line) <= maximum) {
    return line;
  }

  let result = "";
  let length = 0;

  for (const character of line) {
    const width = bytes(character);

    if (length + width > maximum - 3) {
      break;
    }

    result += character;
    length += width;
  }

  return `${result}…`;
};

const entryLine = (entry: Listed, self: string | undefined, all: boolean) =>
  shortLine(
    `- ${entry.parent === undefined ? entry.name : `${entry.name} (child of ${entry.parent.name})`}${entry.aliases.length === 0 ? "" : ` (alias ${shortLine(entry.aliases.join(", "), 120)})`}${all ? ` · ${entry.did}` : ""}${entry.reserved ? " · reserved" : ""}${entry.name === self ? " · you" : ""}`
  );

const pageText = (
  total: number,
  eligible: number,
  offset: number,
  lines: readonly string[]
): string => {
  const remaining = Math.max(0, eligible - offset - lines.length);
  const header = `Directory: ${total} total · ${lines.length} shown · ${total - lines.length} hidden · ${eligible} matched`;

  const footer =
    remaining === 0
      ? []
      : [
          `… ${remaining} more · narrow with match: or page with offset: ${offset + lines.length}`,
        ];

  return [header, ...lines, ...footer].join("\n");
};

export const listView = (
  entries: readonly Listed[],
  self: string | undefined,
  params: ListParams
): ListView => {
  const eligible = entries
    .filter((entry) =>
      params.match === undefined
        ? params.all === true ||
          entry.reserved ||
          entry.name === self ||
          !ephemeralName(entry.name)
        : matchesName(entry.name, params.match)
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const limit = Math.max(
    1,
    Math.min(params.all === true ? 200 : 50, Math.floor(params.limit ?? 50))
  );

  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const lines: string[] = [];

  for (const entry of eligible.slice(offset, offset + limit)) {
    const line = entryLine(entry, self, params.all === true);

    if (
      bytes(
        pageText(entries.length, eligible.length, offset, [...lines, line])
      ) > 4096
    ) {
      break;
    }

    lines.push(line);
  }

  return {
    nextOffset: offset + lines.length,
    shown: lines.length,
    text: pageText(entries.length, eligible.length, offset, lines),
  };
};

const editDistance = (left: string, right: string): number => {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];

    for (let column = 1; column <= right.length; column += 1) {
      current.push(
        Math.min(
          (current[column - 1] ?? 0) + 1,
          (previous[column] ?? 0) + 1,
          (previous[column - 1] ?? 0) +
            (left[row - 1] === right[column - 1] ? 0 : 1)
        )
      );
    }

    previous = current;
  }

  return previous[right.length] ?? left.length;
};

interface RankedName {
  readonly distance: number;
  readonly name: string;
  readonly prefix: boolean;
}

const rankName = (requested: string, name: string): RankedName => {
  const query = requested.toLowerCase();
  const candidate = name.toLowerCase();
  const segment = query.split("/").at(-1) ?? query;

  return {
    distance: editDistance(query, candidate),
    name,
    prefix:
      candidate.startsWith(query) ||
      (segment.length > 0 &&
        candidate.split("/").some((part) => part.startsWith(segment))),
  };
};

export const suggestNames = (
  requested: string,
  names: readonly string[]
): readonly string[] => {
  if (requested.length === 0) {
    return [];
  }

  const close = [...new Set(names)].flatMap((name) => {
    const rank = rankName(requested, name);

    return rank.prefix ||
      rank.distance <= Math.max(2, Math.floor(requested.length / 3))
      ? [rank]
      : [];
  });

  const stable = close.filter((rank) => !ephemeralName(rank.name));

  return (stable.length === 0 ? close : stable)
    .toSorted(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) ||
        a.distance - b.distance ||
        a.name.localeCompare(b.name)
    )
    .slice(0, 3)
    .map((rank) => rank.name);
};

export interface RoleLine {
  readonly name: string;
  readonly target: string;
  readonly role: string;
}

const roleText = (entry: RoleLine, self: string | undefined) =>
  shortLine(
    `- ${entry.name}${entry.target === entry.name ? "" : ` (row ${entry.target})`} · ${shortLine(entry.role, 120)}${entry.target === self ? " · you" : ""}`
  );

const rolePage = (
  total: number,
  eligible: number,
  offset: number,
  lines: readonly string[]
): string => {
  const remaining = Math.max(0, eligible - offset - lines.length);
  const footer: string[] = [];

  if (total === 0) {
    footer.push("No roles yet. Use all: true for the full directory.");
  } else if (remaining > 0) {
    footer.push(
      `… ${remaining} more · narrow with match: or page with offset: ${offset + lines.length}`
    );
  }

  return [
    `Roles: ${total} total · ${lines.length} shown · ${eligible} matched · all: true lists every row`,
    ...lines,
    ...footer,
  ].join("\n");
};

export const rolesView = (
  roles: readonly RoleLine[],
  self: string | undefined,
  params: ListParams
): ListView => {
  const { match } = params;

  const eligible = roles
    .filter(
      (entry) =>
        match === undefined ||
        matchesName(entry.name, match) ||
        matchesName(entry.target, match) ||
        entry.role.toLowerCase().includes(match.toLowerCase())
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));

  const limit = Math.max(1, Math.min(50, Math.floor(params.limit ?? 50)));
  const offset = Math.max(0, Math.floor(params.offset ?? 0));
  const lines: string[] = [];

  for (const entry of eligible.slice(offset, offset + limit)) {
    const line = roleText(entry, self);

    if (
      bytes(rolePage(roles.length, eligible.length, offset, [...lines, line])) >
      4096
    ) {
      break;
    }

    lines.push(line);
  }

  return {
    nextOffset: offset + lines.length,
    shown: lines.length,
    text: rolePage(roles.length, eligible.length, offset, lines),
  };
};
