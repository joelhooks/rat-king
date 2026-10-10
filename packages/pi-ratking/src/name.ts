import { Option, Result, Schema } from "effect";

export const AgentName = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u)
);

export const Did = Schema.String.check(Schema.isPattern(/^did:web:[^#\s]+$/u));

export const ReservedName = Schema.Struct({
  aliases: Schema.optionalKey(Schema.Array(AgentName)),
  did: Did,
});

export const Reserved = Schema.Record(AgentName, ReservedName);

export type ReservedValue = typeof Reserved.Type;

export class NameError extends Schema.TaggedError<NameError>()("NameError", {
  reason: Schema.String,
}) {}

export type NameSource = "env" | "pane" | "session";

export interface OwnName {
  readonly name: string;
  readonly source: NameSource;
}

export interface NameRequest {
  readonly env: Option.Option<string>;
  readonly pane: Option.Option<string>;
  readonly session: string;
  readonly reserved: ReservedValue;
  readonly taken: (name: string) => boolean;
}

const isName = Schema.is(AgentName);

export const canonicalName = (reserved: ReservedValue, name: string) =>
  Object.entries(reserved).find(
    ([, entry]) => entry.aliases?.includes(name) === true
  )?.[0] ?? name;

export const isReserved = (reserved: ReservedValue, name: string) =>
  Object.hasOwn(reserved, canonicalName(reserved, name));

export const labelSlug = (label: string): Option.Option<string> => {
  const slug = label
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .slice(0, 32)
    .replace(/-+$/u, "");

  return isName(slug) ? Option.some(slug) : Option.none();
};

export const sessionName = (session: string) =>
  `pi-${session
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/gu, "")
    .slice(0, 29)}`.replace(/-+$/u, "");

export const provisionLabel = (name: string) => name.replace("/", ".");

export const secretName = (name: string) =>
  `rat_king_fleet_agent_${provisionLabel(name)}_identity`;

export const didFor = (
  template: string,
  reserved: ReservedValue,
  name: string
) =>
  reserved[canonicalName(reserved, name)]?.did ??
  template.replace("{agent}", provisionLabel(name));

export const deriveName = (
  request: NameRequest
): Result.Result<OwnName, NameError> => {
  if (Option.isSome(request.env)) {
    return isName(request.env.value)
      ? Result.succeed({
          name: canonicalName(request.reserved, request.env.value),
          source: "env",
        })
      : Result.fail(
          new NameError({ reason: "RATKING_NAME is not a valid agent name" })
        );
  }

  const free = (name: string) =>
    !isReserved(request.reserved, name) && !request.taken(name);

  const pane = request.pane.pipe(
    Option.flatMap(labelSlug),
    Option.filter(free)
  );

  if (Option.isSome(pane)) {
    return Result.succeed({ name: pane.value, source: "pane" });
  }

  const fallback = sessionName(request.session);

  return free(fallback)
    ? Result.succeed({ name: fallback, source: "session" })
    : Result.fail(
        new NameError({ reason: `Session name ${fallback} is already taken` })
      );
};

export const verifiedSender = (input: {
  readonly template: string;
  readonly reserved: ReservedValue;
  readonly known: Option.Option<string>;
  readonly claimed: string;
  readonly did: string;
}) =>
  Option.exists(input.known, (name) => name === input.claimed) ||
  (Schema.is(AgentName)(input.claimed) &&
    didFor(input.template, input.reserved, input.claimed) === input.did);
