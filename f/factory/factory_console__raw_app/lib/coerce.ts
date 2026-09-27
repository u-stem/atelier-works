// Small, permissive coercion helpers for reading fields off the `unknown`
// values `backend.console_query(...)` resolves to.
//
// This is deliberately looser than the repo's usual "Parse, don't validate"
// convention (f/factory/lib/db.ts / f/factory/steps/console_query.ts throw
// on a malformed field): console_query.ts already validates every row
// strictly before returning it, so a value reaching this App has already
// passed that check — the only way a field could still be "wrong" here is a
// job-level failure (network/exception, handled separately via try/catch)
// or an App bundling mismatch, neither of which a stricter per-field check
// would surface any better. Coercing to a safe default keeps one odd field
// from blanking an entire tab.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function bool(value: unknown): boolean {
  return value === true;
}

export function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}
