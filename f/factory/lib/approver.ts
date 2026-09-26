// Shared fail-closed approver-identity derivation (team-lead fix round,
// [MUST] #1: issue_proposal_decide.ts used to record `process.env.WM_USERNAME
// ?? "unknown"` as `decided_by` — a decision could silently land under the
// literal string "unknown" when the job's run context carried no identity at
// all, defeating the whole point of recording who decided). Extracted from
// approval_decide.ts (its module doc's first security-auditor note explains
// why a caller-supplied argument can never be trusted as identity instead)
// so every step script that records a human decision derives it the same,
// fail-closed way: approval_decide.ts (requirement-draft approval) and
// issue_proposal_decide.ts (Issue-proposal approval) both import this.

export type ApproverEnv = {
  readonly WM_USERNAME?: string | undefined;
  readonly WM_EMAIL?: string | undefined;
};

/**
 * Derives the recorded approver's identity from the job's own Windmill run
 * context (pure, for testing) — never from a caller-supplied argument, which
 * cannot be trusted as identity. `WM_USERNAME` is preferred; `WM_EMAIL` is
 * the fallback for a context where only the email is set. Throws if neither
 * is available: a decision must never be recorded under an unidentified
 * approver (fail closed).
 */
export function deriveApprover(env: ApproverEnv): string {
  const username = env.WM_USERNAME;
  if (username !== undefined && username.length > 0) {
    return username;
  }
  const email = env.WM_EMAIL;
  if (email !== undefined && email.length > 0) {
    return email;
  }
  throw new Error(
    "deriveApprover: cannot determine approver identity (WM_USERNAME and WM_EMAIL are both unset)",
  );
}
