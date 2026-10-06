// @effect-diagnostics globalConsole:off -- Host diagnostics emit only constructed metadata, never raw errors.
import { Schema } from "effect";

import { SidecarFailure } from "./port.ts";

const assistantCodes = [
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "rate_limit",
  "overloaded",
  "invalid_request",
  "model_not_found",
  "server_error",
  "unknown",
  "max_output_tokens",
  "cloud_credential_error",
];

const resultCodes = [
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
  "success",
];

const safeMessages = new Set([
  ...assistantCodes.map((code) => `Claude Code assistant failed: ${code}`),
  ...resultCodes.map((code) => `Claude Code failed: ${code}`),
  "Authorization refused",
  "Route not found",
  "Claude Code assistant failed",
  "Unserved tool call",
  "Claude Code failed",
  "Request exceeds 1 MiB",
  "Command-form user text is not accepted",
  "Unsupported model",
  "Cannot create private working directory",
  "Cannot create private config directory",
  "Cannot create private temp root",
  "Private temp cleanup failed",
  "Claude Code initialized with an unexpected model or host tool",
  "Claude Code assistant returned an unexpected model",
  "Sidecar turn expired after 120 seconds",
  "Claude Code ended without a result",
  "Session is not awaiting tool results",
  "Missing or duplicate durable tool results",
  "Tool result has no live sidecar session; restart replay is not supported",
  "Importing prior sidecar history is not supported",
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Catch boundary projects only allowlisted messages from unknown failures.
export const failureMessage = (error: unknown) => {
  let message = "";

  if (Schema.is(SidecarFailure)(error)) {
    message = error.reason;
  } else if (error instanceof Error) {
    ({ message } = error);
  }

  return safeMessages.has(message) ? message : "Untrusted error detail omitted";
};

export const logHttpFailure = (
  status: number,
  kind: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- HTTP catch boundary projects safe metadata, never raw errors.
  error: unknown
) => {
  console.error(
    JSON.stringify({
      event: "sidecar_http_failure",
      kind,
      message: failureMessage(error),
      status,
      tag: Schema.is(SidecarFailure)(error) ? error._tag : "Error",
    })
  );
};
