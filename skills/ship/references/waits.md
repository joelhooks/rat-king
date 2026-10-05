# Rat King waits ledger

Re-check these records monthly. Expiry escalates to the desk; it never clears a wait or passes a gate. Do not add overrides for these dependencies.

A shrink-only CI check is a later packet; it is not implemented yet.

## WAIT[alchemy-prisma-dev-advisories]

- Waiting for: an Alchemy release that drops or upgrades `@prisma/dev`. `alchemy` 2.0.0-beta.79 currently reaches `hono` 4.11.4, `@hono/node-server` 1.19.9, `lodash` 4.17.21 (via chevrotain), and `valibot` 1.2.0 through `@prisma/dev`.
- Exposure: dev-only. Alchemy's local Prisma dev server is never started and is not bundled.
- Clearing check: after an Alchemy upgrade, `pnpm audit` reports none of these advisories through `@prisma/dev`. Upgrading Alchemy is its own packet.
- Owner: the desk.
- Expiry: 2026-11-05. Re-check monthly; escalate to the desk on expiry.

## WAIT[ultracite-braces-advisory]

- Waiting for: an ultracite release that resolves a fixed `braces`. `ultracite` 7.12.0 currently reaches `braces` 3.0.3 through fast-glob and micromatch (stack-exhaustion denial of service).
- Exposure: lint-time only.
- Clearing check: after an ultracite upgrade, `pnpm audit` reports no `braces` advisory through ultracite.
- Owner: the desk.
- Expiry: 2026-11-05. Re-check monthly; escalate to the desk on expiry.
