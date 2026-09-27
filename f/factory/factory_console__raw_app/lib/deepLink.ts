// Deep-link parsing for "jump straight to a work item's requirements
// document" — the fragment lib/approval_support.ts's `buildConsoleUrl`
// appends to every Console link it hands out (Issue comment / Discord
// notification): `#requirements/<work_item_id>` or
// `#requirements/<work_item_id>/attempt-<k>`.
//
// A raw app is served from an opaque/sandboxed origin (see the `raw-app`
// skill's "wmill client is already authenticated" note on `WM_RAW_APP`), so
// there is no guarantee this App can read the *embedding* page's URL — only
// its own `window.location.hash` is reliably readable. `collectDeepLinkCandidates`
// still tries `window.parent.location.hash` and `document.referrer` (both
// wrapped in try/catch — a cross-origin `window.parent.location` read throws
// a `SecurityError`, and `document.referrer` is plain best-effort) since a
// same-origin embedding (e.g. the Windmill UI's own app-preview iframe) can
// make either work. Whichever of the three yields a match first wins.

export type RequirementsDeepLink = {
  readonly work_item_id: number;
  readonly attempt: number | null;
};

const DEEP_LINK_PATTERN = /#requirements\/(\d+)(?:\/attempt-(\d+))?/;

/** Parses the first candidate string containing a `#requirements/<id>`
 * fragment (pure, for testing) — `null` when none of `candidates` matches. */
export function parseDeepLink(
  candidates: readonly string[],
): RequirementsDeepLink | null {
  for (const candidate of candidates) {
    const match = DEEP_LINK_PATTERN.exec(candidate);
    if (match === null) {
      continue;
    }
    const workItemIdText = match[1];
    if (workItemIdText === undefined) {
      continue;
    }
    const workItemId = Number(workItemIdText);
    if (!Number.isInteger(workItemId) || workItemId <= 0) {
      continue;
    }
    const attemptText = match[2];
    const attempt =
      attemptText === undefined ? Number.NaN : Number(attemptText);
    return {
      work_item_id: workItemId,
      attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : null,
    };
  }
  return null;
}

/** Gathers every candidate string `parseDeepLink` should try, in priority
 * order: this window's own hash, the parent frame's hash (same-origin
 * embedding only), then the referrer URL. Not unit-tested (thin `window` /
 * `document` access with no branching logic of its own) — `parseDeepLink`
 * carries the actual behavior under test. */
export function collectDeepLinkCandidates(): string[] {
  const candidates: string[] = [window.location.hash];
  try {
    candidates.push(window.parent.location.hash);
  } catch {
    // Cross-origin parent frame: window.parent.location throws SecurityError.
  }
  if (document.referrer.length > 0) {
    candidates.push(document.referrer);
  }
  return candidates;
}
