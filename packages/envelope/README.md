# @rat-king/envelope

**Unreviewed proof code.** Do not rely on this outside the proof until full-envelope cross-implementation golden vectors and an independent crypto review pass.

V0 uses wire version 1, sign-then-encrypt, HPKE base mode (16,1,1), info `sh.mschf.ratking.hpke.v1`, and domain-separated canonical AAD and signing bytes. Application signatures are ES256, fixed-width 64-byte r || s, normalized low-S on sign and rejected high-S on verify. WebCrypto hashes the original signing bytes once.

- `@hpke/core@1.9.0`: maintained RFC 9180 implementation using WebCrypto for P-256, HKDF-SHA256 and AES-128-GCM. No handwritten HPKE construction.
- `@ipld/dag-cbor@10.0.2`: normalized DAG-CBOR/DRISL bytes. Generated Lexicon data schemas restrict values; decoding re-encodes and compares canonical bytes.
- `@rat-king/lexicon`: generated schemas preserve unknown fields. All transmitted AAD fields are authenticated.

Suite `{ kemId: 0, kdfId: 0, aeadId: 0 }` (reserved HPKE ids) is signed plaintext. It uses the same envelope shape: `ciphertext` carries the canonical signed message in the clear and `enc` is the single byte `00`. The ES256 signature covers the AAD, suite, version and body exactly as it does under HPKE. `open` verifies both suites the same way. `openPlaintext` and `plaintextBody` let the mailbox verify and project plaintext without importing HPKE. Readers that predate this suite refuse it as unsupported.

`seal` requires a recipient key and its authorized DID URL. `open` requires the expected recipient/key ID and an authorization-aware signing-key resolver. Supplying a public key hint never authorizes it. The static proof resolver does not prove historical key rotation.

Unit tests cover RFC derivation, KEM shared secrets, key schedule, 257 encryptions/decryptions and three exports, envelope round-trip, every AAD field (including a future field), suite/version/enc/ciphertext tampering, wrong recipients, wrong signing bytes, high-S, and inner/outer metadata disagreement. The mailbox test Worker also imports the HPKE seal/open graph for the local isolate proof.

## celld P-256 compatibility

HPKE now runs inside the local celld v0.6.1 Worker isolate through two guarded, instance-local adapters in `src/hpke-p256.ts`. One real-node test proves Node seals → Worker opens and Worker seals → Node opens. This is local proof, not deployment or independent crypto review.

celld v0.6.1 `crates/celld/js/crypto.js:339-344` exports stored P-256 public bytes as 91-byte SPKI, not 65-byte SEC1. Minimal repro inside its Worker:

```js
const pair = await crypto.subtle.generateKey(
  { name: "ECDH", namedCurve: "P-256" },
  true,
  ["deriveBits"]
);
(await crypto.subtle.exportKey("raw", pair.publicKey)).byteLength; // 91, expected 65
```

The export adapter accepts only 65 bytes starting `04`, unchanged, or 91 bytes with the exact 26-byte P-256 SPKI prefix `3059301306072a8648ce3d020106082a8648ce3d030107034200` and a trailing 65-byte point starting `04`. Everything else fails with `EnvelopeFailure`. Only raw P-256 public-key serialization is normalized; other exports are unchanged.

A second defect appears when opening a Node envelope: celld v0.6.1 `crates/celld/js/crypto.js:254-327` supports raw asymmetric import for OKP only, not ECDH P-256. Repro with a valid Node-exported 65-byte SEC1 point:

```js
const algorithm = { name: "ECDH", namedCurve: "P-256" };
await crypto.subtle.importKey("raw", nodeExportedPoint, algorithm, true, []); // NotSupportedError: unsupported key import
```

The import adapter accepts only 65-byte uncompressed SEC1 points. Before converting x/y to a public P-256 JWK and using the existing JWK import path, it checks `0 ≤ x,y < p` and `y² ≡ x³ − 3x + b (mod p)`. Malformed or off-curve points fail with `EnvelopeFailure`. No global WebCrypto methods change.

The extension point is `@hpke/core@1.9.0 esm/src/kems/dhkemNative.js:5-6`, which installs the EC primitive as protected `_prim`. Its installed dependency `@hpke/common@1.10.1 esm/src/kems/dhkemPrimitives/ec.js:229-232,355-358` uses raw public-key export/import. `esm/src/kems/dhkem.js:118-119,156,163` calls those primitives in both KEM directions. Patching only the KEM's public `serializePublicKey` method would miss those internal calls.

Both adapters are removable once celld fixes these WebCrypto operations. Suite (16,1,1), AAD, signing bytes, wire version and dependency pins remain unchanged. Crypto remains **unreviewed**.

No application private keys are tracked. The only fixed private inputs are published RFC test data, with provenance in `test/vectors/README.md`.
