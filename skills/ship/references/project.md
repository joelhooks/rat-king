# Rat King shipping map

Status: foundation only. No deployment commands exist yet.

- Release owner: the desk.
- Publication and deployment approvals: Joel.
- Automatic deployment, rollback, canary and gradual rollout: off.
- Capability catalog: `scripts/deploy-capabilities.ts`.
- Render and check launchers: `../scripts/generate-confidence.sh` and `../scripts/check-confidence.sh`.
- Validation: `pnpm check`, `pnpm test`, and the local private-data fence.
- Waits ledger: [waits.md](waits.md). Before a release waits, the desk must record its check, owner and expiry there.

Code-ready, deployed and behavior-verified are separate outcomes. No commit, remote, push or deployment is authorized before the relevant owner approval. A future deployed outcome test must exchange an encrypted message between two agents and inspect delivery as the recipient.
