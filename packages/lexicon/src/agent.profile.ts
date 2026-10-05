import { Schema } from "effect";

import * as Defs from "./defs.ts";
import * as Runtime from "./runtime.ts";

export const Main = Schema.StructWithRest(
  Schema.Struct({
    $type: Schema.Literal("sh.mschf.ratking.agent.profile"),
    birthContext: Defs.BirthContext,
    callSign: Schema.optionalKey(
      Runtime.lexString({
        description:
          "Human display call sign, not an address or verified handle.",
        type: "string",
      })
    ),
    emoji: Schema.optionalKey(Runtime.lexString({ type: "string" })),
    genesisCid: Runtime.lexString({
      description:
        "CIDv1 0x71 SHA-256 of the DID-independent genesis certificate, not the profile or its resulting DID.",
      format: "cid",
      type: "string",
    }).pipe(Schema.brand("Lexicon:cid")),
    icon: Schema.optionalKey(
      Runtime.Blob.check(
        Schema.makeFilter(
          (value) =>
            value.ref.code === 0x55 &&
            value.size <= 1_000_000 &&
            ["image/png", "image/jpeg", "image/webp"].some(
              (mime) =>
                mime === "*/*" ||
                mime === value.mimeType ||
                (mime.endsWith("/*") &&
                  value.mimeType.startsWith(mime.slice(0, -1)))
            ),
          { expected: "blob MIME, raw CID and size constraints" }
        )
      )
    ),
    themeRef: Schema.optionalKey(
      Runtime.lexString({
        description: "Actual desk theme record URI.",
        format: "at-uri",
        type: "string",
      }).pipe(Schema.brand("Lexicon:at-uri"))
    ),
    updatedAt: Schema.optionalKey(
      Runtime.lexString({ format: "datetime", type: "string" }).pipe(
        Schema.brand("Lexicon:datetime")
      )
    ),
  }),
  [Schema.Record(Schema.String, Runtime.Data)]
);

export type MainValue = typeof Main.Type;

export const RecordMetadata = {
  collection: "sh.mschf.ratking.agent.profile",
  key: "tid",
} as const;
