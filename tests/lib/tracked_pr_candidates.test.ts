import { describe, expect, test } from "bun:test";
import type { TrackedPr } from "../../f/factory/lib/db.ts";
import type { LogFields, Logger } from "../../f/factory/lib/log.ts";
import {
  collectTrackedPrCandidates,
  type TrackedPrCandidateDeps,
} from "../../f/factory/lib/tracked_pr_candidates.ts";

const DB_NOW = new Date("2026-11-07T01:00:00.123Z");

function tracked(
  number: number,
  overrides: Partial<TrackedPr> = {},
): TrackedPr {
  return {
    owner: "acme",
    repo: "widgets",
    pr_number: number,
    head_sha: null,
    kind: "pr_review",
    status: "reviewed",
    updated_at: new Date("2026-11-01T00:00:00Z"),
    ...overrides,
  };
}

type PrReply = {
  state: "open" | "closed";
  merged: boolean;
  title: string;
};

type Setup = {
  list?: TrackedPr[];
  listFails?: boolean;
  /** PRの番号ごとの読み取り。`Error`なら失敗する。無い番号は開いたPR。 */
  prs?: Record<number, PrReply | Error>;
  /** 許可しないリポジトリ(`owner/repo`)。 */
  disallowed?: string[];
  limit?: number;
  clockFails?: boolean;
  markFailsFor?: number[];
  /** 印を付けられなかった(行が動いていた)PRの番号。 */
  markMissesFor?: number[];
};

type Warning = { message: string; fields: LogFields | undefined };

function harness(setup: Setup = {}) {
  const order: string[] = [];
  const getPrCalls: number[] = [];
  const marked: { prNumber: number; readAt: Date }[] = [];
  const failures: string[] = [];
  const warnings: Warning[] = [];
  const log: Logger = {
    info() {},
    warn: (message, fields) => warnings.push({ message, fields }),
    error() {},
  };
  const deps: TrackedPrCandidateDeps = {
    limit: setup.limit ?? 200,
    readDbNow: async () => {
      order.push("clock");
      if (setup.clockFails === true) throw new Error("clock failed");
      return DB_NOW;
    },
    listTracked: async () => {
      order.push("list");
      if (setup.listFails === true) throw new Error("list failed");
      return setup.list ?? [];
    },
    isRepoAllowed: (owner, repo) =>
      setup.disallowed?.includes(`${owner}/${repo}`) !== true,
    getPr: async (_owner, _repo, number) => {
      getPrCalls.push(number);
      const reply = setup.prs?.[number] ?? {
        state: "open",
        merged: false,
        title: `pr ${String(number)}`,
      };
      if (reply instanceof Error) throw reply;
      return reply;
    },
    markClosed: async (pr, readAt) => {
      if (setup.markFailsFor?.includes(pr.pr_number) === true) {
        throw new Error("mark failed");
      }
      marked.push({ prNumber: pr.pr_number, readAt });
      return setup.markMissesFor?.includes(pr.pr_number) !== true;
    },
    recordFailure: async (step) => {
      failures.push(step);
    },
    log,
  };
  return { deps, order, getPrCalls, marked, failures, warnings };
}

function numbered(count: number): TrackedPr[] {
  return Array.from({ length: count }, (_, index) => tracked(index + 1));
}

describe("collectTrackedPrCandidates for an open pull request", () => {
  test("returns the pull request as a candidate with its title and page", async () => {
    const h = harness({
      list: [tracked(7)],
      prs: { 7: { state: "open", merged: false, title: "Fix it" } },
    });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.items).toEqual([
      {
        owner: "acme",
        repo: "widgets",
        number: 7,
        title: "Fix it",
        htmlUrl: "https://github.com/acme/widgets/pull/7",
      },
    ]);
  });

  test("does not mark an open pull request", async () => {
    const h = harness({ list: [tracked(7)] });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.marked).toEqual([]);
  });

  test("skips a pull request that the discovery already found without reading it", async () => {
    const h = harness({ list: [tracked(7)] });
    await collectTrackedPrCandidates(new Set(["acme/widgets#7"]), h.deps);
    expect(h.getPrCalls).toEqual([]);
  });

  test("skips a repository that is not allowed without reading it", async () => {
    const h = harness({ list: [tracked(7)], disallowed: ["acme/widgets"] });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.getPrCalls).toEqual([]);
  });

  test("reads a pull request that two rows of the list name only once", async () => {
    const h = harness({ list: [tracked(7), tracked(7, { kind: "pr_fix" })] });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.getPrCalls).toEqual([7]);
  });
});

describe("collectTrackedPrCandidates for a closed pull request", () => {
  const merged: PrReply = { state: "closed", merged: true, title: "t" };
  const unmerged: PrReply = { state: "closed", merged: false, title: "t" };

  test("does not return a merged pull request as a candidate", async () => {
    const h = harness({ list: [tracked(7)], prs: { 7: merged } });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.items).toEqual([]);
  });

  test("marks a merged pull request with the clock read before the list", async () => {
    const h = harness({ list: [tracked(7)], prs: { 7: merged } });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.marked).toEqual([{ prNumber: 7, readAt: DB_NOW }]);
  });

  test("counts the pull requests that it marked", async () => {
    const h = harness({ list: [tracked(7), tracked(8)], prs: { 7: merged } });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.closedMarked).toBe(1);
  });

  test("does not count a mark that did not apply because the row moved", async () => {
    const h = harness({
      list: [tracked(7)],
      prs: { 7: merged },
      markMissesFor: [7],
    });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.closedMarked).toBe(0);
  });

  test("does not mark a pull request that was closed without a merge", async () => {
    const h = harness({ list: [tracked(7)], prs: { 7: unmerged } });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.marked).toEqual([]);
  });

  test("does not return a pull request closed without a merge as a candidate", async () => {
    const h = harness({ list: [tracked(7)], prs: { 7: unmerged } });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.items).toEqual([]);
  });
});

describe("collectTrackedPrCandidates when something fails", () => {
  test("goes on to the next pull request when reading one fails", async () => {
    const h = harness({
      list: [tracked(7), tracked(8)],
      prs: { 7: new Error("gh failed") },
    });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.items.map((item) => item.number)).toEqual([8]);
  });

  test("records the step of a failed read of a pull request", async () => {
    const h = harness({
      list: [tracked(7)],
      prs: { 7: new Error("gh failed") },
    });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.failures).toEqual(["fetch_tracked_pr:acme/widgets#7"]);
  });

  test("counts a failed read of a pull request", async () => {
    const h = harness({
      list: [tracked(7)],
      prs: { 7: new Error("gh failed") },
    });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.failed).toBe(1);
  });

  test("records the step of a failed mark", async () => {
    const h = harness({
      list: [tracked(7)],
      prs: { 7: { state: "closed", merged: true, title: "t" } },
      markFailsFor: [7],
    });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.failures).toEqual(["mark_tracked_pr_closed:acme/widgets#7"]);
  });

  test("counts a failed mark", async () => {
    const h = harness({
      list: [tracked(7)],
      prs: { 7: { state: "closed", merged: true, title: "t" } },
      markFailsFor: [7],
    });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.failed).toBe(1);
  });

  test("records the step of a failed list", async () => {
    const h = harness({ listFails: true });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.failures).toEqual(["list_tracked_prs"]);
  });

  test("counts a failed list", async () => {
    const h = harness({ listFails: true });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.failed).toBe(1);
  });

  test("reads the clock before the list", async () => {
    const h = harness({ list: [] });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.order).toEqual(["clock", "list"]);
  });

  test("records the step of a failed clock read", async () => {
    const h = harness({ clockFails: true, list: [] });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.failures).toEqual(["read_db_now"]);
  });

  test("does not mark when the clock could not be read", async () => {
    const h = harness({
      clockFails: true,
      list: [tracked(7)],
      prs: { 7: { state: "closed", merged: true, title: "t" } },
    });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.marked).toEqual([]);
  });

  test("still returns the open pull requests when the clock failed", async () => {
    const h = harness({ clockFails: true, list: [tracked(7)] });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.items.map((item) => item.number)).toEqual([7]);
  });
});

describe("collectTrackedPrCandidates at the limit", () => {
  test("reads only the first limit pull requests when the list has one more", async () => {
    const h = harness({ list: numbered(4), limit: 3 });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.getPrCalls).toEqual([1, 2, 3]);
  });

  test("reports that the limit was exceeded when the list has one more", async () => {
    const h = harness({ list: numbered(4), limit: 3 });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(result.overLimit).toBe(true);
  });

  test("warns with the limit and the pull requests that it skipped without reading", async () => {
    const h = harness({
      list: numbered(4),
      limit: 3,
      disallowed: ["acme/widgets"],
    });
    await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.warnings[0]?.fields).toMatchObject({
      limit: 3,
      skipped_not_allowed: 3,
      skipped_already_found: 0,
    });
  });

  test("counts the pull requests that the discovery already found in the warning", async () => {
    const h = harness({ list: numbered(4), limit: 3 });
    await collectTrackedPrCandidates(new Set(["acme/widgets#1"]), h.deps);
    expect(h.warnings[0]?.fields).toMatchObject({ skipped_already_found: 1 });
  });

  test("does not warn when the list has exactly the limit", async () => {
    const h = harness({ list: numbered(3), limit: 3 });
    const result = await collectTrackedPrCandidates(new Set(), h.deps);
    expect(h.warnings).toEqual([]);
    expect(result.overLimit).toBe(false);
  });
});
