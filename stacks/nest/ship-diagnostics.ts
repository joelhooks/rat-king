const reasons = [
  "Only a matching file may be adopted",
  "Only a matching unit may be adopted",
  "Existing file requires explicit adoption",
  "Existing unit requires explicit adoption",
  "Only the pinned binary may be adopted",
  "Adoption requires the inventory-owned mode-700 root",
  "Adoption refuses non-private or redirected parent directories",
  "Prior deployment file ownership could not be verified",
  "Unit changed outside its qualified owner; staging refused",
  "Remote command failed; values redacted",
  "Storage readiness deadline exceeded before node startup",
  "Host listener approval required",
  "User unit failed readback",
  "Invalid stage configuration",
  "POC plan refuses delete or replace",
  "Ship command failed; values redacted",
  "Candidate checkout does not match the fenced SHA",
  "Candidate command failed",
  "NoIdentity",
  "LeaseHeld",
] as const;

const providers = [
  "RemoteFile.provider.read",
  "Celld.Deployment.reconcile",
  "SystemdUnit.reconcile",
  "Celld.Node.reconcile",
] as const;

export const sanitizeCandidateStderr = (raw: string): string => {
  const tail = raw.slice(-65_536);
  const known = reasons.filter((reason) => tail.includes(reason));
  const frames = providers.filter((provider) => tail.includes(provider));

  const code =
    /\b(?:ENOENT|EACCES|ECONNREFUSED|ETIMEDOUT|ERR_MODULE_NOT_FOUND)\b/u.exec(
      tail
    )?.[0];

  const exit = /Candidate command failed \(exit (?<exit>\d+)\)/u.exec(tail)
    ?.groups?.exit;

  const parts = [
    ...known,
    ...frames,
    ...(code === undefined ? [] : [code]),
    ...(exit === undefined ? [] : [`exit ${exit}`]),
  ];

  return parts.length === 0
    ? "Candidate stderr withheld: unrecognized diagnostic"
    : [...new Set(parts)].join("; ").slice(-2048);
};
