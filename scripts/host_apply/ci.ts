/** 目標のコミットの必須チェックを、GitHubのAPIの応答から判定する。ネットワークには触れない。 */

import { CI_WORKFLOW_PATH, REQUIRED_CHECKS } from "./constants.ts";

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

type WorkflowRun = {
  readonly path: string;
  readonly event: string;
  readonly check_suite_id: number;
};

type CheckRun = {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly appSlug: string;
  readonly suiteId: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWorkflowRun(value: unknown): WorkflowRun | null {
  if (!isRecord(value)) return null;
  const { path, event, check_suite_id: suiteId } = value;
  if (typeof path !== "string" || typeof event !== "string") return null;
  if (typeof suiteId !== "number") return null;
  return { path, event, check_suite_id: suiteId };
}

function readCheckRun(value: unknown): CheckRun | null {
  if (!isRecord(value)) return null;
  const { id, name, status, conclusion, app, check_suite: suite } = value;
  if (typeof id !== "number" || typeof name !== "string") return null;
  if (typeof status !== "string") return null;
  if (typeof conclusion !== "string" && conclusion !== null) return null;
  if (!isRecord(app) || typeof app.slug !== "string") return null;
  if (!isRecord(suite) || typeof suite.id !== "number") return null;
  return {
    id,
    name,
    status,
    conclusion,
    appSlug: app.slug,
    suiteId: suite.id,
  };
}

/** 失敗とみなす結論。 */
const FAILED_CONCLUSIONS: readonly string[] = [
  "failure",
  "cancelled",
  "timed_out",
];

/** 通過とみなす結論。条件付きのジョブはスキップで通過になる。 */
const PASSING_CONCLUSIONS: readonly string[] = ["success", "skipped"];

const GITHUB_ACTIONS_APP = "github-actions";

/**
 * 必須チェックの結果から判定する。
 * 数えるのは、`ci.yml`のpushの実行と同じcheck suiteにある、`github-actions`のcheck-runだけ。
 * 同名のチェックを別のworkflowやappが作っても無視する。
 * 失敗が1つでもあれば、ほかが走行中でも拒否する。
 * 同じ名前のcheck-runが複数あるときは、idが最大のもの(最新)を使う。
 * `input`が`null`のとき(取得に失敗)と、応答の形が読めないときは保留にする。
 */
export function judgeCi(
  input: { readonly runs: unknown; readonly checkRuns: unknown } | null,
): CiVerdict {
  if (input === null) return { kind: "pending", why: "fetch_failed" };
  if (!Array.isArray(input.runs) || !Array.isArray(input.checkRuns)) {
    return { kind: "pending", why: "fetch_failed" };
  }
  const suites = new Set<number>();
  for (const raw of input.runs) {
    const run = readWorkflowRun(raw);
    if (run === null) continue;
    if (run.path === CI_WORKFLOW_PATH && run.event === "push") {
      suites.add(run.check_suite_id);
    }
  }
  if (suites.size === 0) return { kind: "pending", why: "no_run" };

  const latest = new Map<string, CheckRun>();
  for (const raw of input.checkRuns) {
    const run = readCheckRun(raw);
    if (run === null) continue;
    if (run.appSlug !== GITHUB_ACTIONS_APP || !suites.has(run.suiteId)) {
      continue;
    }
    const current = latest.get(run.name);
    if (current === undefined || run.id > current.id) {
      latest.set(run.name, run);
    }
  }

  const failed: string[] = [];
  let missing = false;
  let unsettled = false;
  for (const name of REQUIRED_CHECKS) {
    const run = latest.get(name);
    if (run === undefined) {
      missing = true;
    } else if (run.status !== "completed") {
      unsettled = true;
    } else if (
      run.conclusion !== null &&
      FAILED_CONCLUSIONS.includes(run.conclusion)
    ) {
      failed.push(name);
    } else if (
      run.conclusion === null ||
      !PASSING_CONCLUSIONS.includes(run.conclusion)
    ) {
      unsettled = true;
    }
  }
  if (failed.length > 0) {
    return { kind: "rejected", reason: "ci_failed", failed };
  }
  if (missing) return { kind: "pending", why: "missing_checks" };
  if (unsettled) return { kind: "pending", why: "unsettled" };
  return { kind: "pass" };
}

/** ページ送りのある応答の本文から、キーの下の配列を取り出す。形が違えば`null`。 */
export function extractItems(
  body: unknown,
  key: "workflow_runs" | "check_runs",
): unknown[] | null {
  if (!isRecord(body)) return null;
  const items = body[key];
  return Array.isArray(items) ? items : null;
}

/** `Link`ヘッダーから`rel="next"`のURLを取り出す。無ければ`null`。 */
export function parseNextLink(link: string | null): string | null {
  if (link === null) return null;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/.exec(part);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export type Page<T> = {
  readonly items: readonly T[];
  readonly link: string | null;
};

const DEFAULT_MAX_PAGES = 50;
const DEFAULT_ALLOWED_ORIGIN = "https://api.github.com";

/**
 * `Link`ヘッダーの`next`を辿って全ページを読む。
 * 次のURLが別のオリジンなら、トークンを送らないよう読まずに失敗する。
 * ページ数が上限を超えても失敗する。呼び出し側は、失敗を保留として扱う。
 */
export async function readAllPages<T>(
  fetchPage: (url: string | null) => Promise<Page<T>>,
  options?: { readonly maxPages?: number; readonly allowedOrigin?: string },
): Promise<T[]> {
  const maxPages = options?.maxPages ?? DEFAULT_MAX_PAGES;
  const allowedOrigin = options?.allowedOrigin ?? DEFAULT_ALLOWED_ORIGIN;
  const all: T[] = [];
  let url: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const result: Page<T> = await fetchPage(url);
    all.push(...result.items);
    const next = parseNextLink(result.link);
    if (next === null) return all;
    if (new URL(next).origin !== allowedOrigin) {
      throw new Error("next page is on another origin");
    }
    url = next;
  }
  throw new Error("page limit exceeded");
}
