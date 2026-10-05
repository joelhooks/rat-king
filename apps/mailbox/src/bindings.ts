import type { Mailbox, AuthTokens } from "./worker.ts";

export interface Bindings {
  readonly MAILBOX: DurableObjectNamespace<Mailbox>;
  readonly AUTH_TOKENS: DurableObjectNamespace<AuthTokens>;
  readonly SERVICE_DID: string;
  readonly DID_DOCUMENTS: string;
}

export interface Build {
  readonly version: string;
  readonly commit: string;
  readonly serviceDid: string;
  readonly documents: string;
}

export const bindings = {
  compatibility_date: "2026-10-04",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      { class_name: "Mailbox", name: "MAILBOX" },
      { class_name: "AuthTokens", name: "AUTH_TOKENS" },
    ],
  },
  migrations: [{ new_sqlite_classes: ["Mailbox", "AuthTokens"], tag: "v1" }],
  name: "rat-king-mailbox",
};

export const configuration = (main: string, build: Build) => ({
  ...bindings,
  define: {
    __BUNDLE_COMMIT__: JSON.stringify(build.commit),
    __BUNDLE_VERSION__: JSON.stringify(build.version),
  },
  main,
  vars: { DID_DOCUMENTS: build.documents, SERVICE_DID: build.serviceDid },
});
