# Keep deploy confidence mechanical

`scripts/deploy-capabilities.ts` owns the current state. `scripts/deploy-instructions.ts` renders the marked section of `skills/ship/SKILL.md`. `scripts/ship-confidence.ts` is the Effect CLI boundary.

Change the capability entry in the same PR as behavior. Run `pnpm generate:ship-confidence`, then `pnpm check:ship-confidence`. Checking never rewrites files. Missing, duplicate or reversed markers fail instead of creating another section. `pnpm check` runs the drift check; the Turbo check graph must run it too.

`AGENTS.md`, README and the other skills point here; they do not carry a second confidence table. Client projections will consume the canonical skill when those surfaces exist.

## Wait authority

The project mapping names the sole tracked waits ledger. The Effect check decodes its records, rejects new IDs or extended expiry, and checks every tracked WAIT token against live IDs. Untracked notes cannot create waits. A candidate-superseded expiry cancels the current work item's wait, not another release's gate.

## Proposed enablement gate

The drift check proves instructions match the catalog. It does not prove an on entry has a working adapter.

Extend the composition root with a typed capability-to-adapter registry. An on entry must resolve to its real Layer and named contract suite; unavailable adapters have no registry member. Avoid file-existence checks or a caller-supplied evidence label.

The release gate should also decode a qualification receipt bound to the exact candidate SHA, run attempt, deployed version and configuration digest. Require successful stage behavior for automatic deploy, forced-failure restoration and exact readback for automatic rollback, and the synthetic actor/receipt chain for the canary tenant. The existing verdict contracts stay authoritative.

Make CI exercise every selected adapter's behavioral suite and refuse missing or mismatched qualification. Keep owner activation separate from code availability. An import or fixture test alone cannot grant production authority. The CI/CD lane owns this follow-up; it is proposed, not enforced by the drift check.
