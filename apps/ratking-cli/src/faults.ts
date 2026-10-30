import type { InvalidRecord } from "@rat-king/ratking-client/agentgraph";
import { ccRefusalFields } from "@rat-king/ratking-client/cc-lint";
import type { NotConfigured } from "@rat-king/ratking-client/config";
import type { QuietAsk } from "@rat-king/ratking-client/errors";
import { literalPrompt } from "@rat-king/ratking-client/prompt";
import type { PromptInput } from "@rat-king/ratking-client/prompt";
import type {
  AskFailed,
  LeaseHeld,
  NotDelivered,
} from "@rat-king/ratking-client/ratking";
import { Match, Predicate, Schema } from "effect";

export class Usage extends Schema.TaggedError<Usage>()("Usage", {
  accepted: Schema.String,
  fix: Schema.String,
  reason: Schema.String,
}) {}

export type Fault =
  | AskFailed
  | InvalidRecord
  | LeaseHeld
  | NotConfigured
  | NotDelivered
  | QuietAsk
  | Usage;

export interface Faulted {
  readonly code: number;
  readonly prompt: PromptInput;
}

export interface Ground {
  readonly action?: "ask" | "send";
  readonly as: string;
  readonly to?: string | undefined;
}

const asFlag = (ground: Ground) => `--as ${ground.as}`;

const cliCall =
  (ground: Ground) =>
  (params: {
    readonly action: string;
    readonly cc?: readonly string[];
    readonly to?: string;
  }) => {
    if (params.action === "list") {
      return `ratking doctor ${asFlag(ground)}`;
    }

    return [
      `ratking ${params.action}`,
      asFlag(ground),
      `--to ${params.to ?? "<name>"}`,
      ...(params.cc ?? []).map((name) => `--cc ${name}`),
      '--summary "..."',
      '--body "..."',
    ].join(" ");
  };

const notDelivered = (failure: NotDelivered, ground: Ground): PromptInput =>
  Match.value(failure.code).pipe(
    Match.when("NoIdentity", () => ({
      accepted: "--as <name> naming a key this machine holds, or RATKING_NAME",
      debug: `ratking doctor ${asFlag(ground)}`,
      fix: `ratking whoami ${asFlag(ground)}`,
      tag: "NoIdentity",
      why: failure.reason,
    })),
    Match.when("UnknownName", () => ({
      accepted: "a name as project/row that the directory or the issuer knows",
      debug: `ratking doctor ${asFlag(ground)}`,
      fix: `ratking send ${asFlag(ground)} --to <project/row> --summary "..." --body "..."`,
      tag: "UnknownName",
      why: failure.reason,
    })),
    Match.when("Self", () => ({
      accepted: "a recipient other than the sending name",
      debug: `ratking whoami ${asFlag(ground)}`,
      fix: `ratking send ${asFlag(ground)} --to <other-name> --summary "..." --body "..."`,
      tag: "Self",
      why: failure.reason,
    })),
    Match.when("Partial", () => ({
      accepted: "a resend only to the recipients that did not accept",
      debug: `ratking pending ${asFlag(ground)}`,
      fix: "send again to the recipients not listed as accepted; do not resend to the accepted ones",
      tag: "Partial",
      why: failure.reason,
    })),
    Match.when("Uncertain", () => ({
      accepted:
        "a resend only after you have checked that the first did not land; a resend can duplicate",
      debug: `ratking doctor ${asFlag(ground)}`,
      fix: `ratking pending ${asFlag(ground)}`,
      tag: "Uncertain",
      why: failure.reason,
    })),
    Match.when("Retired", () => ({
      accepted: "the successor named in the reason",
      debug: `ratking doctor ${asFlag(ground)}`,
      fix: `ratking send ${asFlag(ground)} --to <successor> --summary "..." --body "..."`,
      tag: "Retired",
      why: failure.reason,
    })),
    Match.when("RoleUnresolved", () => ({
      accepted:
        "a name whose role or successor chain ends at a live row within 3 hops",
      debug: `ratking role list ${asFlag(ground)}`,
      fix: `ratking send ${asFlag(ground)} --to <row> --summary "..." --body "..."`,
      tag: "RoleUnresolved",
      why: failure.reason,
    })),
    Match.when("ReaderCannotRender", () => ({
      accepted:
        "a plain message, or a recipient whose reader renders this record type",
      debug: `ratking doctor ${asFlag(ground)}`,
      fix: `ratking send ${asFlag(ground)} --to ${ground.to ?? "<name>"} --summary "..." --body "..."`,
      tag: "ReaderCannotRender",
      why: failure.reason,
    })),
    Match.orElse((code) => ({
      accepted: "a complete request; nothing reached the mailbox",
      debug: `ratking doctor ${asFlag(ground)}`,
      fix: "rerun the same command once the reason above is fixed; a retry is safe",
      tag: code,
      why: failure.reason,
    }))
  );

const askFailed = (failure: AskFailed, ground: Ground): PromptInput =>
  Match.value(failure.code).pipe(
    Match.when("NoReply", () => ({
      accepted: "a later reply; the ask stays open",
      debug: `ratking inbox ${asFlag(ground)}`,
      fix: `ratking pending ${asFlag(ground)}`,
      tag: "NoReply",
      why: failure.reason,
    })),
    Match.when("NoSuchMessage", () => ({
      accepted: "an id shown by ratking inbox",
      debug: `ratking inbox ${asFlag(ground)} --all`,
      fix: `ratking reply <id> ${asFlag(ground)} --summary "..." --body "..."`,
      tag: "NoSuchMessage",
      why: failure.reason,
    })),
    Match.orElse((code) => ({
      accepted: "a reader that holds the lease",
      debug: `ratking whoami ${asFlag(ground)}`,
      fix: `ratking send ${asFlag(ground)} --to <name> --summary "..." --body "..."`,
      tag: code,
      why: failure.reason,
    }))
  );

const promptOf = (fault: Fault, ground: Ground): PromptInput =>
  Match.value(fault).pipe(
    Match.tag("NotDelivered", (failure) => notDelivered(failure, ground)),
    Match.tag("AskFailed", (failure) => askFailed(failure, ground)),
    Match.tag("LeaseHeld", (failure) => ({
      accepted:
        "ratking inbox without --hold, which peeks and never takes the lease",
      debug: `ratking whoami ${asFlag(ground)}`,
      fix: `ratking inbox ${asFlag(ground)}`,
      tag: "LeaseHeld",
      why: `${failure.name} is held by session ${failure.holder} (${failure.harness}) until ${failure.expiresAt}; nothing was taken`,
    })),
    Match.tag("NotConfigured", (failure) => ({
      accepted:
        "a Rat King config file at RATKING_CONFIG or ~/.config/rat-king/pi.json",
      debug: "ratking doctor",
      fix: "write that file with endpoint, serviceDid and didTemplate, then rerun the same command",
      tag: "NotConfigured",
      why: failure.reason,
    })),
    Match.tag("InvalidRecord", (failure) => ({
      accepted:
        "--type naming a supported agent-graph record and --record a JSON object file",
      debug: `ratking send ${asFlag(ground)} --help`,
      fix: `ratking send ${asFlag(ground)} --to ${ground.to ?? "<name>"} --record <file.json> --type <nsid>`,
      tag: "InvalidRecord",
      why: failure.reason,
    })),
    Match.tag("QuietAsk", (failure) => ({
      accepted: "quiet messages and replies; asks without --quiet",
      debug: failure.debug,
      fix: failure.fix,
      tag: failure._tag,
      why: failure.why,
    })),
    Match.tag("Usage", (failure) => ({
      accepted: failure.accepted,
      debug: "ratking --help",
      fix: failure.fix,
      tag: "Usage",
      why: failure.reason,
    })),
    Match.exhaustive
  );

export const faulted = (fault: Fault, ground: Ground): Faulted => {
  if (
    Predicate.isTagged(fault, "NotDelivered") &&
    fault.addressed !== undefined
  ) {
    return {
      code: 2,
      prompt: ccRefusalFields({
        action: ground.action ?? "send",
        addressed: fault.addressed,
        call: cliCall(ground),
      }),
    };
  }

  const code = Match.value(fault).pipe(
    Match.tag("LeaseHeld", () => 4),
    Match.tag("NotDelivered", (failure) =>
      failure.code === "Uncertain" || failure.code === "Partial" ? 3 : 2
    ),
    Match.orElse(() => 2)
  );

  return { code, prompt: promptOf(fault, ground) };
};

export const promptText = (prompt: PromptInput) => literalPrompt(prompt);
