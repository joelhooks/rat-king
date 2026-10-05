# @rat-king/envelope

**Unreviewed proof code.** Do not rely on this outside the proof until full-envelope cross-implementation golden vectors and an independent crypto review pass.

V0 uses wire version 1, sign-then-encrypt, HPKE base mode (16,1,1), info `sh.mschf.ratking.hpke.v1`, and domain-separated canonical AAD and signing bytes. Application signatures are ES256, fixed-width 64-byte r || s, normalized low-S on sign and rejected high-S on verify. WebCrypto hashes the original signing bytes once.

- `@hpke/core@1.9.0`: maintained RFC 9180 implementation using WebCrypto for P-256, HKDF-SHA256 and AES-128-GCM. No handwritten HPKE construction.
- `@ipld/dag-cbor@10.0.2`: normalized DAG-CBOR/DRISL bytes. Generated Lexicon data schemas restrict values; decoding re-encodes and compares canonical bytes.
- `@rat-king/lexicon`: generated schemas preserve unknown fields. All transmitted AAD fields are authenticated.

`seal` requires a recipient key and its authorized DID URL. `open` requires the expected recipient/key ID and an authorization-aware signing-key resolver. Supplying a public key hint never authorizes it. The static proof resolver does not prove historical key rotation.

Unit tests cover RFC derivation, KEM shared secrets, key schedule, 257 encryptions/decryptions and three exports, envelope round-trip, every AAD field (including a future field), suite/version/enc/ciphertext tampering, wrong recipients, wrong signing bytes, high-S, and inner/outer metadata disagreement. The mailbox Worker uses only the ES256 and canonical-byte entry points, never the HPKE seal/open graph.

celld v0.6.1 `crypto.subtle.exportKey('raw')` returns a 91-byte SPKI for P-256 public keys instead of the 65-byte SEC1 point, so P-256 HPKE does not run inside its Worker isolate. Node clients are unaffected.

No application private keys are tracked. The only fixed private inputs are published RFC test data, with provenance in `test/vectors/README.md`.
