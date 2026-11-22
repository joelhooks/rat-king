import { Array as Arr, Option, Schema } from "effect";

import { literalPrompt } from "./prompt.ts";
import type { PromptInput } from "./prompt.ts";

export const AskAimedAtCc = Schema.Struct({
  cc: Schema.Array(Schema.String),
  name: Schema.String,
  snippet: Schema.String,
  to: Schema.String,
});

export type AskAimedAtCcValue = typeof AskAimedAtCc.Type;

export interface Addressing {
  readonly cc: readonly string[];
  readonly texts: readonly string[];
  readonly to: string;
}

export interface LintInput {
  readonly body: Option.Option<string>;
  readonly ccOnPurpose: boolean | undefined;
  readonly kind: string | undefined;
  readonly names: readonly string[];
  readonly summary: string | undefined;
}

export interface FixParams {
  readonly action: "ask" | "send";
  readonly cc: readonly string[];
  readonly message: string;
  readonly summary: string;
  readonly to: string;
}

export interface RefusalInput {
  readonly action: string;
  readonly addressed: AskAimedAtCcValue;
  readonly call: (params: FixParams | { readonly action: "list" }) => string;
}

const SNIPPET_MAX = 60;

const rowPart = (name: string) => name.slice(name.lastIndexOf("/") + 1);

const forms = (name: string) =>
  Arr.dedupe([name.toLowerCase(), rowPart(name).toLowerCase()]);

const escaped = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);

const END = String.raw`(?![\w/-])`;

const ASK_LINE = String.raw`^[\s>*_-]*(?:asked of you:|ask for|question for)\s*:?\s*@?`;

const patterns = (form: string) => [
  new RegExp(String.raw`(?<![\w/@-])@${escaped(form)}${END}`, "iu"),
  new RegExp(`${ASK_LINE}${escaped(form)}${END}`, "imu"),
];

const snippetAt = (text: string, index: number) => {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const line = text.slice(start, end === -1 ? text.length : end).trim();

  if (line.length <= SNIPPET_MAX) {
    return line;
  }

  const from = Math.max(0, line.length - SNIPPET_MAX);
  const offset = Math.min(from, Math.max(0, index - start - 20));

  return line.slice(offset, offset + SNIPPET_MAX);
};

const firstMatch = (texts: readonly string[], form: string) =>
  Arr.findFirst(texts, (text) =>
    Arr.findFirst(patterns(form), (pattern) =>
      Option.map(Option.fromNullishOr(pattern.exec(text)), (found) =>
        snippetAt(text, found.index)
      )
    )
  );

export const ccAddressed = (
  input: Addressing
): Option.Option<AskAimedAtCcValue> => {
  const primary = forms(input.to);

  return Arr.findFirst(input.cc, (name) =>
    Option.map(
      Arr.findFirst(
        forms(name).filter((form) => !primary.includes(form)),
        (form) => firstMatch(input.texts, form)
      ),
      (snippet) => ({ cc: input.cc, name, snippet, to: input.to })
    )
  );
};

export const ccLint = (input: LintInput) => {
  const [to, ...cc] = input.names;

  if (
    to === undefined ||
    Option.isNone(input.body) ||
    input.kind === "data" ||
    input.ccOnPurpose === true
  ) {
    return Option.none<AskAimedAtCcValue>();
  }

  return ccAddressed({
    cc,
    texts: [input.body.value, input.summary ?? ""],
    to,
  });
};

const FYI =
  /^\s*(?:fyi|for your information|for awareness|heads[ -]up|no action (?:needed|required))\b[ .,;:—-]*/iu;

const REQUEST =
  /\?|(?:^|[.!;:\n])\s*(?:[-*]\s*)?(?:please|(?:can|could|would|will) you|ack|approve|check|confirm|deploy|investigate|review|reply|send|update|verify)\b/iu;

export const fyiHint = (input: {
  readonly body: string;
  readonly summary?: string | undefined;
  readonly to: string;
}) => {
  const texts = [input.summary ?? "", input.body];

  return texts.some((text) => FYI.test(text)) &&
    !texts.some((text) => REQUEST.test(text.replace(FYI, ""))) &&
    forms(input.to).every((form) => Option.isNone(firstMatch(texts, form)))
    ? "This reads like an FYI. Next time use cc or quiet to avoid starting a turn."
    : undefined;
};

const ccWhy = (addressed: AskAimedAtCcValue) =>
  `you sent to ${addressed.to} with ${addressed.name} in cc, and the text addresses ${addressed.name} (${addressed.snippet}), so ${addressed.name} would get a quiet copy and not wake.`;

export const ccRefusal = (addressed: AskAimedAtCcValue) =>
  `AskAimedAtCc: ${ccWhy(addressed)}`;

export const fixParams = (
  action: string,
  addressed: AskAimedAtCcValue
): FixParams => ({
  action: action === "ask" ? "ask" : "send",
  cc: [addressed.to, ...addressed.cc.filter((name) => name !== addressed.name)],
  message: "...",
  summary: "...",
  to: addressed.name,
});

export const ccRefusalFields = (input: RefusalInput): PromptInput => {
  const { name } = input.addressed;

  return {
    accepted: `${name} in to, or ccOnPurpose: true.`,
    debug: `${input.call({ action: "list" })} shows names; ${name}'s own wake level is its business. Send with ccOnPurpose: true if a quiet copy is what you meant.`,
    fix: `${input.call(fixParams(input.action, input.addressed))} with ${name} moved into to and ${input.addressed.to} moved into cc; put back your own summary and message.`,
    tag: "AskAimedAtCc",
    why: ccWhy(input.addressed),
  };
};

export const ccRefusalPrompt = (input: RefusalInput) =>
  literalPrompt(ccRefusalFields(input));
