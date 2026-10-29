// @effect-diagnostics nodeBuiltinImport:off -- Inventory decoding validates literal IP addresses at the Node boundary.
import { isIP } from "node:net";

import { Schema } from "effect";

const value = Schema.NonEmptyString.check(Schema.isPattern(/\S/u));

const path = value.check(
  Schema.isPattern(
    /^\/(?!$)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\/\/)[^\r\n\0]*[^/\r\n\0]$/u
  )
);

export const NodeSchema = Schema.Struct({
  celldMemoryMax: Schema.optionalKey(
    value.check(Schema.isPattern(/^[1-9][0-9]*(?:\.[0-9]+)?[KMGT]?$/u))
  ),
  dataRoot: path,
  home: path,
  privateCgroupView: Schema.optionalKey(Schema.Boolean),
  ssh: value.check(Schema.isPattern(/^(?!-)[A-Za-z0-9_.@:-]+$/u)),
  tailnetIPv4: value.check(
    Schema.isPattern(/^(?:\d{1,3}\.){3}\d{1,3}$/u),
    Schema.makeFilter((ip) => isIP(ip) === 4)
  ),
});

export type Node = typeof NodeSchema.Type;

export const Nodes = Schema.Record(Schema.NonEmptyString, NodeSchema);

const nonemptyValues = Schema.NonEmptyArray(
  Schema.NonEmptyString.check(Schema.isPattern(/\S/u))
);

export const Instance = Schema.Struct({
  domains: nonemptyValues,
  hosts: nonemptyValues,
  ips: Schema.NonEmptyArray(
    Schema.String.check(Schema.makeFilter((ip) => isIP(ip) !== 0))
  ),
  nodes: Schema.optionalKey(Nodes),
  s3Credentials: Schema.optionalKey(
    Schema.Struct({
      accessKey: value.check(
        Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u)
      ),
      secretKey: value.check(
        Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/u)
      ),
    })
  ),
  secretNames: nonemptyValues,
  sites: nonemptyValues,
});
