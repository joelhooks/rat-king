import type { Snapshot } from "./feed.ts";
import { content, documentHtml, liveScript } from "./page.ts";
import { stylesheet } from "./style.ts";

export const privateHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
};

const response = (status: number, body: string, mime = "text/plain") => ({
  body,
  headers: { ...privateHeaders, "content-type": `${mime}; charset=utf-8` },
  status,
});

export const route = (options: {
  readonly logins: ReadonlySet<string>;
  readonly loginHeaders: readonly string[] | undefined;
  readonly method: string | undefined;
  readonly target: string | undefined;
  readonly snapshot: () => Snapshot;
}) => {
  const [login] = options.loginHeaders ?? [];

  if (
    options.loginHeaders?.length !== 1 ||
    login === undefined ||
    !options.logins.has(login)
  ) {
    return response(403, "Forbidden\n");
  }

  if (options.method !== "GET") {
    return response(405, "Method not allowed\n");
  }

  const [path, query] = options.target?.split("?", 2) ?? [];

  switch (path ?? "") {
    case "/viewer.css": {
      return response(200, stylesheet, "text/css");
    }

    case "/viewer.js": {
      return response(200, liveScript, "text/javascript");
    }

    case "/healthz": {
      const { status } = options.snapshot();

      return response(status === "live" ? 200 : 503, `${status}\n`);
    }

    case "/snapshot": {
      const snapshot = options.snapshot();
      const params = new URLSearchParams(query);

      return params.get("revision") === String(snapshot.revision)
        ? response(204, "")
        : response(200, content(snapshot, params), "text/html");
    }

    case "/": {
      return response(
        200,
        documentHtml(content(options.snapshot(), new URLSearchParams(query))),
        "text/html"
      );
    }

    default: {
      return response(404, "Not found\n");
    }
  }
};

export const internalError = () => response(500, "Viewer unavailable\n");
