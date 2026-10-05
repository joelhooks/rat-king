import { Identity } from "@rat-king/mailbox-client";
import { Effect, FileSystem, Path, Schema } from "effect";

export {
  Identity,
  PrivateJwk,
  importSigning,
  importAgreement,
} from "@rat-king/mailbox-client";

export type { IdentityValue } from "@rat-king/mailbox-client";

export class CliError extends Schema.TaggedError<CliError>()("CliError", {
  reason: Schema.String,
}) {}

export const readIdentity = Effect.fn("MailboxCli.readIdentity")(
  function* readIdentity(home: string, agent: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(agent)) {
      return yield* new CliError({ reason: "Invalid agent label" });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(home, ".config/rat-king/agents", `${agent}.jwk`);
    const stat = yield* fs.stat(file);

    if (stat.type !== "File" || stat.mode % 512 !== 0o600) {
      return yield* new CliError({
        reason: "Identity must be a regular file with mode 600",
      });
    }

    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Identity))(
      yield* fs.readFileString(file)
    ).pipe(
      Effect.mapError(
        () => new CliError({ reason: "Invalid private identity file" })
      )
    );
  }
);
