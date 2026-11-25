import { authenticateClaims as verifyClaims } from "@rat-king/mailbox-client";
import type { AuthenticateRequest } from "@rat-king/mailbox-client";
import { Effect } from "effect";

export {
  base64url,
  unbase64url,
  Claims,
  Document,
  Documents,
  DidResolver,
  documentResolver,
  ReplayAuthority,
  staticResolver,
  serviceToken,
} from "@rat-king/mailbox-client";

export type {
  AuthenticateRequest,
  ClaimsValue,
  DocumentsValue,
} from "@rat-king/mailbox-client";

const mailboxAuthSkewSeconds = 5;

type MailboxAuthenticateRequest = Omit<AuthenticateRequest, "skewSeconds">;

export const authenticateClaims = (request: MailboxAuthenticateRequest) =>
  verifyClaims({ ...request, skewSeconds: mailboxAuthSkewSeconds });

export const authenticate = Effect.fn("ServiceAuth.authenticate")(
  (request: MailboxAuthenticateRequest) =>
    authenticateClaims(request).pipe(Effect.map((claims) => claims.iss))
);
