import { canonical } from "@rat-king/envelope/canonical";
import { Result, Schema } from "effect";

import { base64url, Document } from "./auth.ts";

export const AgentName = Schema.String.check(
  Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z][a-z0-9_-]{0,31}$/u)
);

export const DidTemplate = Schema.String.check(
  Schema.isPattern(/^did:web:[^#{}\s]*\{agent\}[^#{}\s]*$/u)
);

export const IssuerConfig = Schema.Struct({
  didTemplate: DidTemplate,
  reserved: Schema.Array(Schema.String),
});

export type IssuerConfigValue = typeof IssuerConfig.Type;

export type PublicDocument = typeof Document.Type;

export interface Binding {
  readonly did: string;
  readonly host: string;
  readonly fingerprint: string;
}

export interface RegistrationRequest {
  readonly name: string;
  readonly host: string;
  readonly enrolled: boolean;
  readonly document: PublicDocument;
}

export type Refusal =
  | "Forbidden"
  | "InvalidName"
  | "NameReserved"
  | "NameTaken"
  | "InvalidRequest";

export interface Decision {
  readonly kind: "bind" | "repeat";
  readonly did: string;
  readonly binding: Binding;
}

export const refusalStatus: Readonly<Record<Refusal, number>> = {
  Forbidden: 403,
  InvalidName: 400,
  InvalidRequest: 400,
  NameReserved: 403,
  NameTaken: 409,
};

const isName = Schema.is(AgentName);

export const nameDid = (template: string, name: string) =>
  template.replace("{agent}", name.replace("/", "."));

export const fingerprint = (document: PublicDocument) =>
  base64url(canonical(document));

export const publicOnly = (document: Schema.Json) =>
  Schema.decodeUnknownOption(Document)(document, {
    onExcessProperty: "error",
  });

export const decideRegistration = (
  config: IssuerConfigValue,
  request: RegistrationRequest,
  existing?: Binding
): Result.Result<Decision, Refusal> => {
  if (!request.enrolled) {
    return Result.fail("Forbidden");
  }

  if (!isName(request.name)) {
    return Result.fail("InvalidName");
  }

  if (config.reserved.includes(request.name)) {
    return Result.fail("NameReserved");
  }

  const did = nameDid(config.didTemplate, request.name);

  if (request.document.id !== did) {
    return Result.fail("InvalidRequest");
  }

  const binding = {
    did,
    fingerprint: fingerprint(request.document),
    host: request.host,
  };

  if (existing === undefined) {
    return Result.succeed({ binding, did, kind: "bind" });
  }

  return existing.host === binding.host &&
    existing.fingerprint === binding.fingerprint
    ? Result.succeed({ binding, did, kind: "repeat" })
    : Result.fail("NameTaken");
};
