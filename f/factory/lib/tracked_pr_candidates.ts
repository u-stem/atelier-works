// `poll_prs`が、DBで追跡中のPRを、開いているものだけ候補に足す手順。

import type { TrackedPr } from "./db.ts";
import type { PrSearchItem, PullRequest } from "./github.ts";
import type { Logger } from "./log.ts";

export type TrackedPrCandidateDeps = {
  readonly limit: number;
  readonly readDbNow: () => Promise<Date>;
  readonly listTracked: () => Promise<TrackedPr[]>;
  readonly isRepoAllowed: (owner: string, repo: string) => boolean;
  readonly getPr: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<Pick<PullRequest, "state" | "merged" | "title">>;
  readonly markClosed: (pr: TrackedPr, readAt: Date) => Promise<boolean>;
  readonly recordFailure: (step: string, err: unknown) => Promise<void>;
  readonly log: Logger;
};

export type TrackedPrCandidates = {
  readonly items: PrSearchItem[];
  readonly failed: number;
  readonly closedMarked: number;
  readonly overLimit: boolean;
};

/** 追跡中のPRのうち、開いているものを候補にして返す。 */
export async function collectTrackedPrCandidates(
  _alreadyFound: ReadonlySet<string>,
  _deps: TrackedPrCandidateDeps,
): Promise<TrackedPrCandidates> {
  return { items: [], failed: 0, closedMarked: 0, overLimit: false };
}
