# Independent envelope cross-check

Go seals open in TypeScript. TypeScript seals open in Go. Both implementations agree on signing bytes, AAD bytes, HPKE info and the rejection corpus. This adds interoperability evidence, not a cryptographic audit. `reviewStatus` remains `unreviewed`.

The Go implementation imports no Rat King code. It uses exactly pinned circl v1.6.1 for HPKE base mode `(16,1,1)`, fxamacker CBOR v2.9.0 for canonical encoding, and Go's standard-library P-256 ECDSA with SHA-256 and raw 64-byte low-S signatures. It constructs the signature and AAD domains independently.

## Regenerate

Install Go 1.26.6 and the repository's pinned Node and pnpm dependencies. From the repository root, run:

```sh
node packages/envelope/test/regenerate-xcheck.ts
```

That command samples a finite payload Schema with seed 9180, requires all 36 combinations, calls Go `generate`, opens the Go seals in TS, seals each payload in TS, and calls Go `verify`. It writes the corpus only after agreement. HPKE ephemeral keys and ECDSA nonces use system randomness, so regeneration changes ciphertext and signatures, not the canonical preimages.

The committed evidence lives in `packages/envelope/test/vectors/xcheck/`:

- `go.json`: independent signing/AAD/info bytes, 36 Go seals, and rejection envelopes.
- `ts.json`: 36 TS seals plus 720 rejected cases, all checked by Go `verify`.
- `receipt.json`: the seed, suite, payload count and 756-case Go verification count.

The three TS `it.effect.prop` checks derive inputs from the same Schema. They compare independent bytes, open Go seals, and replay accepted/rejected corpus outcomes. Ordinary `pnpm test` reads these files and never invokes Go. Fresh TS-to-Go sealing is checked by the regeneration command, not by CI.

Standalone verification accepts a JSON array of `{ accepted, envelope, payload }`, using atproto `$bytes` wrappers:

```sh
(cd tools/envelope-xcheck && go run . verify) < packages/envelope/test/vectors/xcheck/ts.json
```

## Evidence and limits

The payload space varies absent/true urgency, empty/text/binary bodies, UTF-8 unknown AAD strings, and negative/zero/multibyte unknown AAD integers. It also binds nested unknown AAD bytes and a list, preserving timestamp spelling.

The rejection corpus covers nonminimal CBOR integers/lengths, indefinite maps, duplicate/unsorted map keys, truncation, trailing data, floats, undefined, nonstring map keys, invalid UTF-8 and tags. These are tested both as raw CBOR and as authenticated HPKE plaintext. Other cases cover the signature domain, high-S signatures, a valid signature over a noncanonical payload, inner/outer metadata mismatch, ciphertext tampering, unknown AAD tampering, an unsupported suite and malformed encapsulation.

This is a bounded test implementation, not a production parser or a second full Lexicon validator. It doesn't cover CID links, optional reply references, arbitrary DID/date syntax, every valid P-256 point, every signature mutation, all payload sizes, replay/expiry policy, or side channels. Its signing-key resolver recognizes only the fixture sender's `#atproto` key. Tests do not establish an exhaustive equivalence over arbitrary hostile input.

The scalar values 7 (signing) and 11 (recipient) are invented public fixture keys. Never use them for real messages. Only the Go implementation and TS tests/vectors changed; envelope production source did not.
