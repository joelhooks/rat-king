Before you plan or change anything, read `VISION.md` and `skills/ship/SKILL.md`.

# Rat King project law

Use pure rat-stack: Effect contracts and job-shaped service ports, provider adapters outside core, Alchemy infrastructure and XState lifecycle machines. No unrequested stack migrations. Pins stay exact.

Read installed Effect guidance and pinned source mirrors before Effect or XState work. Populate mirrors with `pnpm vendor:agent-sources`. They are reference material, never dependencies.

The scaffold inherits rat-stack's type diagnostics, Oxlint plugins, Oxfmt and effect-tsgo patch. Keep these gates strict. Core must not import provider implementations. Every client surface projects one contract. No apps or packages belong in the foundation until a behavior needs them.

Test with properties and models, not examples. Use `it.prop` from `@effect/vitest` with arbitraries derived from Schemas through `effect/Arbitrary`. Test stateful behavior as a model with fast-check commands (`asyncModelRun`): drive real commands and check a small model after each step. Effect has no model runner. Each claim gets one test that would fail if the claim broke. Delete tests that restate the implementation, repeat a case a property already covers, or check what the type checker already proves. List untested claims instead of padding coverage.

Run `pnpm check` and `pnpm test`. Commit and push hooks run the private-data fence and gitleaks. Never bypass hooks. Missing or malformed instance configuration blocks local publication. CI has generic rules only.

Keep inventory, credentials, local Brain, harness state and Alchemy state outside the public candidate. Example configuration uses invented values. Preserve existing work and stage explicit paths only.

First publication needs Joel's gate 1 approval. Until then, leave the candidate uncommitted, with no remote. Later irreversible actions and changes to approval boundaries need their own approval.

The desk owns releases. Joel approves publication and deployment authority. Follow `skills/ship/references/project.md`; off capabilities are unavailable, not permission to improvise.
