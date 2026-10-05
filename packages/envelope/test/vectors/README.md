# RFC 9180 public test data

Source: https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json Full upstream file SHA-256: `61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6`.

Extraction: parse the upstream JSON, filter `mode === 0 && kem_id === 16 && kdf_id === 1 && aead_id === 1`, serialize those entries without changing field names or values. One entry, 257 encryptions, three exports. Fixed private inputs are published RFC test data, not agent or service identities. All application test identities use ephemeral keys.
