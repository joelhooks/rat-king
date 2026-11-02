import type { SendOptions } from "./ratking.ts";
import { clampSummary } from "./summary.ts";
import type { ClampedSummary } from "./summary.ts";

export interface SendingInput {
  readonly critical?: boolean | undefined;
  readonly ccOnPurpose?: boolean | undefined;
  readonly encrypt?: boolean | undefined;
  readonly quiet?: boolean | undefined;
  readonly summary?: string | undefined;
  readonly thread?: string | undefined;
}

export interface Sending {
  readonly clamp: ClampedSummary | undefined;
  readonly options: SendOptions;
}

export const sendingOptions = (input: SendingInput): Sending => {
  const options: SendOptions = {};

  const clamp =
    input.summary === undefined ? undefined : clampSummary(input.summary);

  if (input.critical !== undefined) {
    Object.assign(options, { critical: input.critical });
  }

  if (input.encrypt !== undefined) {
    Object.assign(options, { encrypt: input.encrypt });
  }

  if (input.ccOnPurpose !== undefined) {
    Object.assign(options, { ccOnPurpose: input.ccOnPurpose });
  }

  if (input.quiet === true) {
    Object.assign(options, { quiet: true });
  }

  if (input.thread !== undefined) {
    Object.assign(options, { thread: input.thread });
  }

  if (input.summary !== undefined) {
    Object.assign(options, { summary: clamp?.summary ?? input.summary });
  }

  return { clamp, options };
};
