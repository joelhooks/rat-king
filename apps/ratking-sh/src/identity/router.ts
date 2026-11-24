import type { Signatures } from "@rat-king/lexicon/trust";
import { Effect, Option } from "effect";
import type { Scope } from "effect";

import { secure } from "../http.ts";
import type { Account } from "./account.ts";
import { adminPath, verifyAdmin } from "./admin.ts";
import type { Issuer } from "./admin.ts";
import { applyAdmin } from "./commands.ts";
import type { HandleOwnership } from "./handle-ownership.ts";
import { IdentityReads } from "./identity.ts";
import { didForHost, handleForHost } from "./names.ts";

const notFound = () => secure(new Response(null, { status: 404 }));

const rejected = (status: number, error: string) =>
  secure(Response.json({ error }, { status }));

const adminResponse = (input: Parameters<typeof verifyAdmin>[0]) =>
  verifyAdmin(input).pipe(
    Effect.flatMap(applyAdmin),
    Effect.map(({ stream, version }) =>
      secure(Response.json({ stream, version }))
    ),
    Effect.catchTags({
      AccountExists: ({ _tag }) => Effect.succeed(rejected(409, _tag)),
      AdminUnauthorized: ({ _tag }) => Effect.succeed(rejected(401, _tag)),
      EdgeFailure: ({ status }) =>
        Effect.succeed(rejected(status, "InvalidBody")),
      HandleTaken: ({ _tag }) => Effect.succeed(rejected(409, _tag)),
      InvalidTarget: ({ _tag }) => Effect.succeed(rejected(400, _tag)),
      KeyPurposeConflict: ({ _tag }) => Effect.succeed(rejected(409, _tag)),
      Retired: ({ _tag }) => Effect.succeed(rejected(409, _tag)),
      SchemaError: () => Effect.succeed(rejected(400, "InvalidCommand")),
      TrustFailure: () => Effect.succeed(rejected(503, "IdentityUnavailable")),
      UnknownAccount: ({ _tag }) => Effect.succeed(rejected(404, _tag)),
    })
  );

const methodNotAllowed = (allow: string) =>
  secure(new Response(null, { headers: { allow }, status: 405 }));

const didDocumentPath = "/.well-known/did.json";

const handlePath = "/.well-known/atproto-did";

const routeIdentity = Effect.fn("Identity.route")(function* routeIdentity({
  issuer,
  request,
  zone,
}: {
  readonly issuer: typeof Issuer.Type | undefined;
  readonly request: Request;
  readonly zone: string;
}) {
  const url = new URL(request.url);

  if (url.hostname !== zone && !url.hostname.endsWith(`.${zone}`)) {
    return Option.none<Response>();
  }

  switch (url.pathname) {
    case adminPath: {
      return Option.some(
        request.method === "POST"
          ? yield* adminResponse({ issuer, request, zone })
          : methodNotAllowed("POST")
      );
    }

    case didDocumentPath:
    case handlePath: {
      break;
    }

    default: {
      return Option.none<Response>();
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Option.some(methodNotAllowed("GET, HEAD"));
  }

  const head = request.method === "HEAD";
  const reads = yield* IdentityReads.clientInProcess;

  if (url.pathname === didDocumentPath) {
    const did = didForHost(url.hostname, zone);

    if (Option.isNone(did)) {
      return Option.some(notFound());
    }

    const document = yield* reads.DidDocument({ did: did.value });

    return Option.some(
      document === null
        ? notFound()
        : secure(
            new Response(head ? null : JSON.stringify(document), {
              headers: { "content-type": "application/did+ld+json" },
            })
          )
    );
  }

  const handle = handleForHost(url.hostname, zone);

  if (Option.isNone(handle)) {
    return Option.some(notFound());
  }

  const did = yield* reads.HandleResolution({ handle: handle.value });

  return Option.some(
    did === null
      ? notFound()
      : secure(
          new Response(head ? null : did, {
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        )
  );
});

export const identityRouter = Effect.context<
  | typeof Account.Identifier
  | typeof HandleOwnership.Identifier
  | Exclude<Effect.Services<typeof IdentityReads.clientInProcess>, Scope.Scope>
  | Signatures
>().pipe(
  Effect.map(
    (context) => (input: Parameters<typeof routeIdentity>[0]) =>
      routeIdentity(input).pipe(Effect.scoped, Effect.provideContext(context))
  )
);
