# @rat-king/lexicon

Generated from the v0 JSON contract in `lexicons/`. Do not edit `src/` or `manifest.json`; run `pnpm lexgen:write`.

The package root exports `MailboxClient` and `clientLayer`. Subpaths expose `mailbox-handlers`, `mailbox-server`, `transport`, `transport-failure`, `xrpc-failure`, `runtime`, `query` and each NSID suffix (`defs`, `mailbox.send`, `mailbox.ack`, `mailbox.list`, `agent.profile`, `runtime.lease`, `desk.theme`).

Schemas use PascalCase names; decoded types use the `Value` suffix. Method modules export `Params`, `Input`, `Output`, `ErrorBody`, `KnownErrors` and `Method`. List also exports query codecs and entry encoders/decoders. Known-value helpers never treat unknown strings as known delivery states.

JSON schemas decode byte and link wrappers into native bytes and CIDs. Use the schemas' native type views for already-decoded data. Blobs require the current structured representation; legacy string-blob reads are rejected.

Checked recursive rest maps preserve extra fields at every object boundary; signed data must retain these fields.

Supply the abstract transport to the client Layer and the application handler service to the server Layer. Adapters own authentication, HTTP serialization and retries; handlers own mailbox behavior. No network, crypto or storage implementation lives here.
