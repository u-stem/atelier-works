/** 目標のコミットの必須チェックを、GitHubのAPIの応答から判定する。ネットワークには触れない。 */

export type CiPendingWhy =
  | "no_run"
  | "unsettled"
  | "missing_checks"
  | "fetch_failed";

export type CiVerdict =
  | { readonly kind: "pass" }
  | {
      readonly kind: "rejected";
      readonly reason: "ci_failed";
      readonly failed: readonly string[];
    }
  | { readonly kind: "pending"; readonly why: CiPendingWhy };

export function judgeCi(
  _input: { readonly runs: unknown; readonly checkRuns: unknown } | null,
): CiVerdict {
  return { kind: "pending", why: "fetch_failed" };
}

export function extractItems(
  _body: unknown,
  _key: "workflow_runs" | "check_runs",
): unknown[] | null {
  return null;
}

export function parseNextLink(_link: string | null): string | null {
  return null;
}

export type Page<T> = {
  readonly items: readonly T[];
  readonly link: string | null;
};

export async function readAllPages<T>(
  _fetchPage: (url: string | null) => Promise<Page<T>>,
  _options?: { readonly maxPages?: number; readonly allowedOrigin?: string },
): Promise<T[]> {
  return [];
}
