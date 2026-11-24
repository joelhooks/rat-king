import { Schema } from "effect";
import { base58btc } from "multiformats/bases/base58";

export const Purpose = Schema.Literals([
  "atproto",
  "mailbox-auth",
  "encryption",
  "kem",
]);

const matchingKey = ({
  publicKeyMultibase,
  purpose,
}: {
  readonly publicKeyMultibase: string;
  readonly purpose: typeof Purpose.Type;
}) => {
  const bytes = base58btc.decode(publicKeyMultibase);
  const [first, second, point] = bytes;
  const p256 = first === 0x80 && second === 0x24;
  const secp256k1 = first === 0xe7 && second === 0x01;
  const compressed = bytes.length === 35 && (point === 2 || point === 3);

  switch (purpose) {
    case "atproto":
    case "mailbox-auth": {
      return compressed && (p256 || secp256k1);
    }

    case "encryption": {
      return (
        (compressed && p256) ||
        (bytes.length === 34 && first === 0xec && second === 0x01)
      );
    }

    case "kem": {
      return bytes.length === 1186 && first === 0x8c && second === 0x24;
    }

    default: {
      const exhaustive: never = purpose;

      return exhaustive;
    }
  }
};

export const Key = Schema.Struct({
  publicKeyMultibase: Schema.String.check(
    Schema.isMaxLength(1622),
    Schema.isPattern(/^z[1-9A-HJ-NP-Za-km-z]+$/u)
  ),
  purpose: Purpose,
}).check(
  Schema.makeFilter(matchingKey, {
    expected: "public Multikey for the key purpose",
  })
);

export const PublishedKey = Schema.Struct({
  ...Key.fields,
  rotatedOutAt: Schema.NullOr(Schema.Int),
  version: Schema.Int,
});
