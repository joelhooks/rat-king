import { Option, Schema } from "effect";

export const identityZone = "ratking.dev";

const label = "[a-z0-9]+(?:-[a-z0-9]+)*";

const dnsLabel = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

const dnsName = `(?:${dnsLabel}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?`;

const agentLabel = new RegExp(`^${label}--${label}$`, "u");

const handleLabels = new RegExp(`^${label}\\.${label}$`, "u");

export const AccountDid = Schema.String.check(
  Schema.isMaxLength(261),
  Schema.isPattern(new RegExp(`^did:web:${dnsName}$`, "u"))
).pipe(Schema.brand("AccountDid"));

export const Handle = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(new RegExp(`^${dnsName}$`, "u"))
).pipe(Schema.brand("IdentityHandle"));

export const didForHost = (hostname: string, zone: string) => {
  const prefix = hostname.slice(0, -(zone.length + 1));

  if (
    hostname !== zone &&
    (!hostname.endsWith(`.${zone}`) ||
      prefix.length > 63 ||
      !agentLabel.test(prefix))
  ) {
    return Option.none();
  }

  return Schema.decodeOption(AccountDid)(`did:web:${hostname}`);
};

export const handleForHost = (hostname: string, zone: string) =>
  hostname.endsWith(`.${zone}`) &&
  handleLabels.test(hostname.slice(0, -(zone.length + 1)))
    ? Schema.decodeOption(Handle)(hostname)
    : Option.none();
