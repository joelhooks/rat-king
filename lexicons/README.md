# Rat King v0 Lexicons

Lexicon JSON is the contract for shared encrypted-message definitions, mailbox send/ack/list, public agent profiles and desk themes, and private runtime leases. Fixtures contain invented identities and opaque example data, not cryptographic vectors or live bindings.

Unions use $type. Known tags must validate against their declared variant. Only unknown tags use the lossless forward-compatible branch. Delivery states and signature algorithms are open strings with known-value helpers.

After publication, new fields stay optional. Keep existing identifiers, fields, formats, bounds, defaults and encodings. Keep unions open and retain their variants. Breaking changes need a new NSID. Compare against the last published immutable bundle before release; this candidate has no published baseline.

Regenerate Effect schemas and XRPC Layers with `pnpm lexgen:write`. `pnpm lexgen:check` rejects generated drift.
