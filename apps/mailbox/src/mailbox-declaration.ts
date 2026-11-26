export const issuerMigration = { new_sqlite_classes: ["Issuer"], tag: "v2" };

export const deskMigration = { new_sqlite_classes: ["Desk"], tag: "v3" };

export const bindings = {
  compatibility_date: "2026-10-04",
  compatibility_flags: ["nodejs_compat"],
  durable_objects: {
    bindings: [
      { class_name: "Mailbox", name: "MAILBOX" },
      { class_name: "AuthTokens", name: "AUTH_TOKENS" },
      { class_name: "Issuer", name: "ISSUER" },
      { class_name: "Desk", name: "DESK" },
    ],
  },
  migrations: [
    { new_sqlite_classes: ["Mailbox", "AuthTokens"], tag: "v1" },
    issuerMigration,
    deskMigration,
  ],
  name: "rat-king-mailbox",
  triggers: { crons: ["* * * * *"] },
};
