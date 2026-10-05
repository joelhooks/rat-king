# Lexicon generator

Run `node tools/lexgen/cli.ts --write` to regenerate and `--check` to reject drift.

The official parser validates each document before refs are resolved. Unsupported Lexicon kinds, non-JSON bodies, unresolved refs and dependency cycles fail explicitly rather than emitting a guessed contract. The supported v0 graph is acyclic.

Generated objects use checked recursive rest maps to preserve extra fields, including nested bytes and links; signed data must use that retained data rather than a stripped projection.

Open unions dispatch by fully qualified $type: known tags have only their strict variant branch, while the unknown branch explicitly excludes every known tag.

The manifest hashes sorted source paths and exact document bytes. Output is formatted with the pinned formatter and has no clock-dependent fields. The source digest covers Lexicon documents; fixture-byte pins remain independent.

The client and server validate the boundary only. Their transport and handler ports own authentication, policy, storage and retries. Non-JSON failures and HTTP status remain transport evidence.
