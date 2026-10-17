import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractItems,
  judgeCi,
  parseNextLink,
  readAllPages,
} from "../../scripts/host_apply/ci.ts";
import {
  CI_WORKFLOW_PATH,
  REQUIRED_CHECKS,
} from "../../scripts/host_apply/constants.ts";

const REPO_ROOT = join(import.meta.dir, "../..");

// mainの先端で実測した応答の形(認証あり、読み取り)。
// 必須の7つはci.ymlのcheck suite、`build`はconsole-dist.ymlの別のsuiteにある。
const CI_SUITE = 105533738648;
const DIST_SUITE = 105533738632;

function checkRun(
  name: string,
  conclusion: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: Math.floor(Math.random() * 1e9),
    name,
    status: conclusion === null ? "in_progress" : "completed",
    conclusion,
    app: { slug: "github-actions" },
    check_suite: { id: CI_SUITE },
    ...overrides,
  };
}

function measuredCheckRuns(): Record<string, unknown>[] {
  return [
    checkRun("console-fetcher-image", "skipped"),
    checkRun("console", "skipped"),
    checkRun("caddyfile", "skipped"),
    checkRun("check", "success"),
    checkRun("test-db", "success"),
    checkRun("metadata", "success"),
    checkRun("scope", "success"),
    checkRun("build", "success", { check_suite: { id: DIST_SUITE } }),
  ];
}

const measuredRuns = [
  {
    id: 38940584019,
    path: ".github/workflows/console-dist.yml",
    event: "push",
    check_suite_id: DIST_SUITE,
    status: "completed",
    conclusion: "success",
  },
  {
    id: 38940583986,
    path: ".github/workflows/ci.yml",
    event: "push",
    check_suite_id: CI_SUITE,
    status: "completed",
    conclusion: "success",
  },
];

describe("judgeCi: which check-runs count", () => {
  test("passes on the measured response", () => {
    expect(
      judgeCi({ runs: measuredRuns, checkRuns: measuredCheckRuns() }),
    ).toEqual({ kind: "pass" });
  });

  test("ignores a same-named check-run from another workflow suite", () => {
    const checkRuns = [
      ...measuredCheckRuns().filter((r) => r.name !== "check"),
      checkRun("check", "success", { check_suite: { id: DIST_SUITE } }),
    ];
    expect(judgeCi({ runs: measuredRuns, checkRuns })).toEqual({
      kind: "pending",
      why: "missing_checks",
    });
  });

  test("ignores a same-named check-run from another app", () => {
    const checkRuns = [
      ...measuredCheckRuns().filter((r) => r.name !== "check"),
      checkRun("check", "success", { app: { slug: "some-other-app" } }),
    ];
    expect(judgeCi({ runs: measuredRuns, checkRuns })).toEqual({
      kind: "pending",
      why: "missing_checks",
    });
  });

  test("a failing same-named check-run from another app does not reject", () => {
    const checkRuns = [
      ...measuredCheckRuns(),
      checkRun("check", "failure", { app: { slug: "some-other-app" } }),
    ];
    expect(judgeCi({ runs: measuredRuns, checkRuns })).toEqual({
      kind: "pass",
    });
  });

  test("ignores a run that is not a push of ci.yml", () => {
    const runs = [{ ...measuredRuns[1], event: "pull_request" }];
    expect(judgeCi({ runs, checkRuns: measuredCheckRuns() })).toEqual({
      kind: "pending",
      why: "no_run",
    });
  });

  test("reads the workflow path from the constant", () => {
    expect(CI_WORKFLOW_PATH).toBe(".github/workflows/ci.yml");
  });
});

describe("judgeCi: verdicts", () => {
  test.each(["failure", "cancelled", "timed_out"])(
    "rejects when a required check is %s",
    (conclusion) => {
      const checkRuns = [
        ...measuredCheckRuns().filter((r) => r.name !== "check"),
        checkRun("check", conclusion),
      ];
      expect(judgeCi({ runs: measuredRuns, checkRuns })).toEqual({
        kind: "rejected",
        reason: "ci_failed",
        failed: ["check"],
      });
    },
  );

  test("rejects even when another required check is still running", () => {
    const checkRuns = [
      ...measuredCheckRuns().filter(
        (r) => r.name !== "check" && r.name !== "scope",
      ),
      checkRun("check", "failure"),
      checkRun("scope", null),
    ];
    expect(judgeCi({ runs: measuredRuns, checkRuns }).kind).toBe("rejected");
  });

  test("is pending when a required check is running", () => {
    const checkRuns = [
      ...measuredCheckRuns().filter((r) => r.name !== "check"),
      checkRun("check", null),
    ];
    expect(judgeCi({ runs: measuredRuns, checkRuns })).toEqual({
      kind: "pending",
      why: "unsettled",
    });
  });

  test("is pending when a required check is missing", () => {
    const checkRuns = measuredCheckRuns().filter((r) => r.name !== "metadata");
    expect(judgeCi({ runs: measuredRuns, checkRuns })).toEqual({
      kind: "pending",
      why: "missing_checks",
    });
  });

  test("is pending when ci.yml has not run yet", () => {
    expect(judgeCi({ runs: [], checkRuns: [] })).toEqual({
      kind: "pending",
      why: "no_run",
    });
  });

  test("is pending when fetching failed", () => {
    expect(judgeCi(null)).toEqual({ kind: "pending", why: "fetch_failed" });
  });

  test("is pending when the response is not the expected shape", () => {
    expect(judgeCi({ runs: "x", checkRuns: 3 })).toEqual({
      kind: "pending",
      why: "fetch_failed",
    });
  });

  test("is pending for a conclusion it does not know", () => {
    const checkRuns = [
      ...measuredCheckRuns().filter((r) => r.name !== "check"),
      checkRun("check", "action_required"),
    ];
    expect(judgeCi({ runs: measuredRuns, checkRuns })).toEqual({
      kind: "pending",
      why: "unsettled",
    });
  });
});

describe("extractItems", () => {
  test("reads the array under the key", () => {
    expect(
      extractItems({ total_count: 1, check_runs: [{ a: 1 }] }, "check_runs"),
    ).toEqual([{ a: 1 }]);
  });

  test("returns null when the key is missing", () => {
    expect(extractItems({ total_count: 0 }, "check_runs")).toBeNull();
  });
});

describe("parseNextLink", () => {
  const next =
    "https://api.github.com/repositories/1/commits/x/check-runs?per_page=100&page=2";

  test("finds rel=next among several links", () => {
    const header = `<${next}>; rel="next", <https://api.github.com/x?page=5>; rel="last"`;
    expect(parseNextLink(header)).toBe(next);
  });

  test("returns null on the last page", () => {
    expect(
      parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'),
    ).toBeNull();
  });

  test("returns null when there is no Link header", () => {
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("readAllPages", () => {
  function pager(pages: string[][]) {
    const urls: (string | null)[] = [];
    const fetchPage = async (url: string | null) => {
      urls.push(url);
      const index =
        url === null ? 0 : Number(new URL(url).searchParams.get("page")) - 1;
      const items = pages[index] ?? [];
      const hasNext = index + 1 < pages.length;
      return {
        items,
        link: hasNext
          ? `<https://api.github.com/x?page=${index + 2}>; rel="next"`
          : null,
      };
    };
    return { fetchPage, urls };
  }

  test("reads every page", async () => {
    const { fetchPage } = pager([["a", "b"], ["c"], ["d"]]);
    expect(await readAllPages(fetchPage)).toEqual(["a", "b", "c", "d"]);
  });

  test("asks for the first page without a url", async () => {
    const { fetchPage, urls } = pager([["a"]]);
    await readAllPages(fetchPage);
    expect(urls).toEqual([null]);
  });

  test("refuses a next link on another origin", async () => {
    const fetchPage = async () => ({
      items: ["a"],
      link: '<https://evil.example/x?page=2>; rel="next"',
    });
    await expect(readAllPages(fetchPage)).rejects.toThrow("origin");
  });

  test("stops at the page limit", async () => {
    const fetchPage = async () => ({
      items: ["a"],
      link: '<https://api.github.com/x?page=2>; rel="next"',
    });
    await expect(readAllPages(fetchPage, { maxPages: 3 })).rejects.toThrow(
      "page limit",
    );
  });
});

describe("required check names", () => {
  test("lists the seven required checks", () => {
    expect([...REQUIRED_CHECKS]).toEqual([
      "scope",
      "check",
      "test-db",
      "metadata",
      "console",
      "caddyfile",
      "console-fetcher-image",
    ]);
  });

  test("matches the checks that docs/security.md says main requires", () => {
    const doc = readFileSync(join(REPO_ROOT, "docs/security.md"), "utf8");
    const line = doc.split("\n").find((l) => l.startsWith("- 必須チェックは"));
    const names = [...(line ?? "").matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
    expect(names).toEqual([...REQUIRED_CHECKS]);
  });

  test("matches the jobs that ci.yml defines", () => {
    const workflow = readFileSync(
      join(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const missing = REQUIRED_CHECKS.filter(
      (name) => !new RegExp(`^  ${name}:`, "m").test(workflow),
    );
    expect(missing).toEqual([]);
  });
});
