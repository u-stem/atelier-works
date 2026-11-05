export type GitHubFetch = (url: string, init: RequestInit) => Promise<Response>;

export type CollectEnv = Readonly<Record<string, string | undefined>>;

export async function tokenExpiresAt(
  _token: string,
  _fetchImpl: GitHubFetch,
): Promise<string | null> {
  return null;
}

export async function interactionLimitsExpiresAt(
  _repo: string,
  _token: string,
  _fetchImpl: GitHubFetch,
): Promise<string | null> {
  return null;
}

export function configuredExpiresAt(_value: string | undefined): string | null {
  return null;
}

export function parseDays(
  _value: string | undefined,
  _fallback: number,
): number {
  return 0;
}

export function readTokenMap(_raw: string | undefined): Record<string, string> {
  return {};
}

export function sha256Fingerprint(_token: string): string {
  return "";
}

export async function collectCredentialExpiry(
  _env: CollectEnv,
  _fetchImpl: GitHubFetch,
  _now: Date,
): Promise<string> {
  return "";
}
