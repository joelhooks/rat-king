import { it } from "@effect/vitest";
import { Schema } from "effect";
import { expect } from "vitest";

import { notificationDiagnostic } from "../../../stacks/nest/ship-notify.ts";
import { MailboxClientError } from "../../mailbox-client/src/index.ts";

class InputFailure extends Schema.TaggedError<InputFailure>()("InputFailure", {
  message: Schema.String,
}) {}

const Credential = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)
);

it.prop(
  "notification diagnostics preserve failure tags and reasons without exposing key-shaped tokens or schema input",
  [Credential],
  ([credential]) => {
    const diagnostic = notificationDiagnostic(
      new MailboxClientError({
        reason: `Authorization denied token=${credential}`,
      })
    );

    expect(diagnostic).toContain("MailboxClientError: Authorization denied");
    expect(diagnostic).toContain("[redacted]");
    expect(diagnostic).not.toContain(credential);
    const schemaFailure = new InputFailure({ message: credential });
    const boundary = notificationDiagnostic(schemaFailure);
    expect(boundary).toContain("InputFailure");
    expect(boundary).not.toContain(credential);
  }
);
