import { forkName, ForkParent } from "@rat-king/ratking-client/fork";
import type { ForkIdentity } from "@rat-king/ratking-client/fork";
import type { SessionFacts } from "@rat-king/ratking-client/identity";
import { AgentName } from "@rat-king/ratking-client/name";
import { ReaderState } from "@rat-king/ratking-client/ratking";
import type { LeaseHolder } from "@rat-king/ratking-client/ratking";
import { heldReason as readerHeld } from "@rat-king/ratking-client/reader-health";
import { Option, Schema } from "effect";

export const NAME_ENTRY = "ratking.name";

export const autoName = (session: string) => `pi-${session.slice(0, 8)}`;

export const interactiveSession = (ctx: {
  readonly hasUI: boolean;
  readonly mode: string;
}) => ctx.hasUI && ctx.mode === "tui";

export const NameSource = Schema.Literals([
  "default",
  "interactive",
  "connected",
  "env",
  "forked",
  "restored",
]);

export type NameSourceValue = typeof NameSource.Type;

export const NameEntry = Schema.Struct({
  derived: Schema.optionalKey(Schema.Boolean),
  name: AgentName,
  parent: Schema.optionalKey(ForkParent),
  session: Schema.optionalKey(Schema.String),
  source: NameSource,
});

export type NameEntryValue = typeof NameEntry.Type;

export interface NameChoice {
  readonly name: Option.Option<string>;
  readonly derived?: boolean;
  readonly source: NameSourceValue;
  readonly fork?: ForkIdentity;
  readonly parent?: typeof ForkParent.Type;
}

export interface NamedFacts extends SessionFacts {
  readonly source?: NameSourceValue;
}

export const connectedFacts = (
  facts: NamedFacts,
  name: string
): NamedFacts => ({
  ...facts,
  derived: true,
  env: Option.some(name),
  fork: undefined,
  nameless: false,
  reads: true,
  source: "connected",
  successor: false,
});

export interface ChooseInput {
  readonly env: Option.Option<string>;
  readonly entries: readonly NameEntryValue[];
  readonly session?: string;
  readonly parentSession?: string | undefined;
  readonly label?: string;
  readonly fork?: boolean;
  readonly parent?: Option.Option<string>;
  readonly succeeds?: string | undefined;
}

export const parseNameEntries = (
  entries: readonly unknown[]
): readonly NameEntryValue[] =>
  entries.flatMap((entry) => {
    const custom = Schema.decodeUnknownOption(
      Schema.Struct({
        customType: Schema.Literal(NAME_ENTRY),
        data: NameEntry,
        type: Schema.Literal("custom"),
      })
    )(entry);

    return Option.isSome(custom) ? [custom.value.data] : [];
  });

export const parentEntry = (
  entries: readonly NameEntryValue[],
  session: string | undefined
) =>
  entries.findLast(
    (entry) => entry.session === session || entry.session === undefined
  );

const restoredChoice = (entry: NameEntryValue): NameChoice => {
  const choice: NameChoice = {
    name: Option.some(entry.name),
    source: "restored",
  };

  if (entry.derived !== undefined) {
    Object.assign(choice, { derived: entry.derived });
  }

  if (entry.parent !== undefined) {
    Object.assign(choice, { parent: entry.parent });
  }

  return choice;
};

const ownChoice = (
  input: ChooseInput,
  isFork: boolean,
  canonicalParent: Option.Option<string>,
  successor: boolean
): NameChoice | undefined => {
  const own = input.entries.findLast(
    (entry) =>
      input.session !== undefined &&
      entry.source !== "default" &&
      entry.session === input.session
  );

  if (own === undefined || (successor && Option.isSome(input.env))) {
    return undefined;
  }

  const renamed =
    Option.isSome(input.env) &&
    input.env.value !== own.name &&
    !(isFork && Option.contains(canonicalParent, input.env.value));

  return renamed ? { name: input.env, source: "env" } : restoredChoice(own);
};

export const chooseName = (input: ChooseInput): NameChoice => {
  const isFork =
    input.fork ??
    (input.parentSession !== undefined &&
      input.parentSession !== input.session);

  const parent = parentEntry(input.entries, input.parentSession);
  const canonicalParent = input.parent ?? Option.fromNullishOr(parent?.name);

  const successor =
    input.succeeds !== undefined && input.succeeds === input.parentSession;

  const own = ownChoice(input, isFork, canonicalParent, successor);

  if (own !== undefined) {
    return own;
  }

  const explicit =
    Option.isSome(input.env) &&
    (!isFork ||
      successor ||
      !Option.contains(canonicalParent, input.env.value));

  if (explicit) {
    return { name: input.env, source: "env" };
  }

  const restorable = input.entries.findLast(
    (entry) =>
      entry.source !== "default" &&
      (entry.session === input.session ||
        (entry.session === undefined && !isFork))
  );

  if (restorable !== undefined) {
    return restoredChoice(restorable);
  }

  if (
    isFork &&
    parent !== undefined &&
    input.session !== undefined &&
    input.parentSession !== undefined
  ) {
    const link = {
      name: Option.getOrElse(canonicalParent, () => parent.name),
      session: input.parentSession,
    };

    const fork = {
      label: input.label ?? `fork-${input.session.slice(0, 6)}`,
      parent: link,
    };

    return {
      fork,
      name: Option.some(forkName(fork, input.session)),
      parent: link,
      source: "forked",
    };
  }

  return { name: Option.none(), source: "default" };
};

export const shouldRecord = (
  last: NameEntryValue | undefined,
  next: NameEntryValue
) =>
  last === undefined ||
  last.name !== next.name ||
  last.session !== next.session ||
  (last.source === "default" && next.source !== "default");

export const stateName = (reader: ReaderState): Option.Option<string> =>
  ReaderState.$match(reader, {
    Acquiring: ({ name }) => Option.some(name),
    Live: ({ name }) => Option.some(name),
    Minting: ({ name }) => Option.some(name),
    Refused: ({ name }) => Option.some(name),
    Retrying: ({ name }) => name,
    SendOnly: ({ name }) => Option.some(name),
    Starting: () => Option.none(),
  });

export const heldElsewhere = (
  holder: Option.Option<LeaseHolder>,
  session: string
) => Option.exists(holder, (held) => held.live && held.session !== session);

export { heldReason } from "@rat-king/ratking-client/reader-health";

export const heldNotice = (name: string) =>
  `🐀 SEND-ONLY: ${readerHeld(name)}; use /ratking connect or action: claim to retry once`;
