import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { CheckEnvironmentProblems } from "../../f/factory/lib/check_sandbox.ts";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { GhClient } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import { OPERATOR_CANCELLED_NOTE } from "../../f/factory/lib/operator_cancel.ts";
import { ciRoundTimeoutMisfit } from "../../f/factory/steps/pr_workflow_support.ts";
import {
  buildClaimDeps,
  type ClaimDepsLookups,
  resolvePrCiHumanTableUse,
} from "../../f/factory/watch_pr_ci.ts";

// `watch_pr_ci`が組む起動の依存に、時間設定の不整合が設定から渡ることを確かめる。
describe("watch_pr_ci claim deps", () => {
  const RAW_CONFIG = {
    owners: [{ name: "octo-owner", kind: "user" }],
    trigger_label: "factory",
    allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
    model: "claude-opus-5-5",
    max_attempts: 3,
    max_turns: 40,
    max_budget_usd_per_run: 5,
    daily_budget_usd: 50,
    worktree_ttl_days: 7,
    factory_repo: "https://github.com/octo-owner/atelier-works",
    instance_name: "local",
    windmill_public_url: "http://127.0.0.1:8080",
    pr_ci_fix_enabled: true,
    pr_ci_fix_enabled_since: "2026-10-13T03:00:00Z",
  };

  const CLIENT: GhClient = {
    ghToken: "token",
  };

  describe("buildClaimDeps", () => {
    test("passes no misfit for the default time settings", () => {
      const config = parseFactoryConfig({
        ...RAW_CONFIG,
        claude_timeout_sec: 1800,
      });
      expect(buildClaimDeps(config, CLIENT)?.configMisfit).toBeNull();
    });

    test("passes the misfit that ciRoundTimeoutMisfit returns for the config", () => {
      const config = parseFactoryConfig({
        ...RAW_CONFIG,
        claude_timeout_sec: 3000,
      });
      expect(buildClaimDeps(config, CLIENT)?.configMisfit).toBe(
        ciRoundTimeoutMisfit(config),
      );
    });

    test("passes the verify step misfit that the number of check commands causes", () => {
      const config = parseFactoryConfig({
        ...RAW_CONFIG,
        claude_timeout_sec: 2000,
        allowed_check_commands: ["a", "b", "c", "d"],
      });
      expect(buildClaimDeps(config, CLIENT)?.configMisfit).toMatch(
        /^ci round: time settings do not fit .*the verify step needs/,
      );
    });
  });

  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  const OTHER_HEAD = "89abcdef0123456789abcdef0123456789abcdef";

  /** 中止の判定が読むDBの読み取りを差し替える。`latest`はPRの最新の作業項目、`note`は取り消しの注記。 */
  function cancelLookups(
    latest: { id: number; status: string; head_sha: string | null } | null,
    note: string | null,
    asked: unknown[][] = [],
  ): Partial<ClaimDepsLookups> {
    return {
      latestPrWorkItem: async (...args) => {
        asked.push(args);
        return latest;
      },
      latestStatusEvent: async () => (note === null ? null : { note }),
    };
  }

  describe("buildClaimDeps operatorCancelledAtHead", () => {
    const config = parseFactoryConfig(RAW_CONFIG);

    test("is true when a person cancelled the latest work item at the head", async () => {
      const deps = buildClaimDeps(
        config,
        CLIENT,
        undefined,
        undefined,
        undefined,
        cancelLookups(
          { id: 7, status: "cancelled", head_sha: HEAD },
          OPERATOR_CANCELLED_NOTE,
        ),
      );
      expect(
        await deps?.operatorCancelledAtHead("acme", "widgets", 3, HEAD),
      ).toBe(true);
    });

    test("reads the latest work item of the pull request it is asked about", async () => {
      const asked: unknown[][] = [];
      const deps = buildClaimDeps(
        config,
        CLIENT,
        undefined,
        undefined,
        undefined,
        cancelLookups(null, null, asked),
      );
      await deps?.operatorCancelledAtHead("acme", "widgets", 3, HEAD);
      expect(asked).toEqual([["acme", "widgets", 3]]);
    });

    test("is false when the cancel was at another head", async () => {
      const deps = buildClaimDeps(
        config,
        CLIENT,
        undefined,
        undefined,
        undefined,
        cancelLookups(
          { id: 7, status: "cancelled", head_sha: OTHER_HEAD },
          OPERATOR_CANCELLED_NOTE,
        ),
      );
      expect(
        await deps?.operatorCancelledAtHead("acme", "widgets", 3, HEAD),
      ).toBe(false);
    });

    test("is false when the latest work item is not cancelled", async () => {
      const deps = buildClaimDeps(
        config,
        CLIENT,
        undefined,
        undefined,
        undefined,
        cancelLookups(
          { id: 7, status: "failed", head_sha: HEAD },
          OPERATOR_CANCELLED_NOTE,
        ),
      );
      expect(
        await deps?.operatorCancelledAtHead("acme", "widgets", 3, HEAD),
      ).toBe(false);
    });
  });

  describe("buildClaimDeps branchItemOperatorCancelled", () => {
    const config = parseFactoryConfig(RAW_CONFIG);
    const ISSUE = {
      kind: "issue" as const,
      owner: "acme",
      repo: "widgets",
      status: "cancelled" as const,
    };

    test("is true when a person cancelled the Issue work item of the branch", async () => {
      const deps = buildClaimDeps(
        config,
        CLIENT,
        undefined,
        undefined,
        undefined,
        {
          getWorkItem: async () => ISSUE,
          latestStatusEvent: async () => ({ note: OPERATOR_CANCELLED_NOTE }),
        },
      );
      expect(
        await deps?.branchItemOperatorCancelled(
          "acme",
          "widgets",
          "factory/issue-5-wi-33",
        ),
      ).toBe(true);
    });

    test("is false for the work item of another pull request", async () => {
      const deps = buildClaimDeps(
        config,
        CLIENT,
        undefined,
        undefined,
        undefined,
        {
          getWorkItem: async () => ({ ...ISSUE, kind: "pr_fix" as const }),
          latestStatusEvent: async () => ({ note: OPERATOR_CANCELLED_NOTE }),
        },
      );
      expect(
        await deps?.branchItemOperatorCancelled(
          "acme",
          "widgets",
          "factory/issue-5-wi-33",
        ),
      ).toBe(false);
    });
  });

  const FIT: CheckEnvironmentProblems = { image: [], runtime: [] };
  const STALE: CheckEnvironmentProblems = {
    image: ["/usr/bin/setfacl is missing"],
    runtime: [],
  };
  const UNSAFE: CheckEnvironmentProblems = {
    image: [],
    runtime: ["world-writable paths created at runtime: /tmp/x"],
  };

  describe("buildClaimDeps workerEnvProblem", () => {
    const withChecks = parseFactoryConfig({
      ...RAW_CONFIG,
      allowed_check_commands: ["mise run check"],
    });

    test("returns null when the worker environment fits", async () => {
      const deps = buildClaimDeps(withChecks, CLIENT, async () => FIT);
      expect(await deps?.workerEnvProblem()).toBeNull();
    });

    test("returns the stale image reason with its message", async () => {
      const deps = buildClaimDeps(withChecks, CLIENT, async () => STALE);
      expect(await deps?.workerEnvProblem()).toEqual({
        reason: "worker_image_stale",
        message:
          "worker image is stale: run mise run up: /usr/bin/setfacl is missing",
      });
    });

    test("returns the unsafe runtime reason with its message", async () => {
      const deps = buildClaimDeps(withChecks, CLIENT, async () => UNSAFE);
      expect(await deps?.workerEnvProblem()).toEqual({
        reason: "worker_runtime_unsafe",
        message:
          "worker runtime is unsafe for checks: chmod o-w the paths or recreate windmill_worker: world-writable paths created at runtime: /tmp/x",
      });
    });

    test("reports the error to leave the notice with the paths", async () => {
      const reported: Error[] = [];
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => UNSAFE,
        async (error) => {
          reported.push(error);
        },
      );
      await deps?.workerEnvProblem();
      expect(reported.map((error) => error.name)).toEqual([
        "CheckRuntimeUnsafeError",
      ]);
    });

    test("does not report when the worker environment fits", async () => {
      const reported: Error[] = [];
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => FIT,
        async (error) => {
          reported.push(error);
        },
      );
      await deps?.workerEnvProblem();
      expect(reported).toEqual([]);
    });

    test("does not look at the environment when no check commands are configured", async () => {
      let called = false;
      const config = parseFactoryConfig({
        ...RAW_CONFIG,
        allowed_check_commands: [],
      });
      const deps = buildClaimDeps(config, CLIENT, async () => {
        called = true;
        return STALE;
      });
      await deps?.workerEnvProblem();
      expect(called).toBe(false);
    });
  });

  describe("buildClaimDeps workerEnvProblem when the image is stale and the paths cannot be listed", () => {
    const withChecks = parseFactoryConfig({
      ...RAW_CONFIG,
      allowed_check_commands: ["mise run check"],
    });
    const STALE_AND_UNLISTED: CheckEnvironmentProblems = {
      image: ["/usr/bin/setfacl is missing"],
      runtime: ["world-writable paths could not be listed: listing timed out"],
    };

    test("reports the error once", async () => {
      const reported: Error[] = [];
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => STALE_AND_UNLISTED,
        async (error) => {
          reported.push(error);
        },
      );
      await deps?.workerEnvProblem();
      expect(reported).toHaveLength(1);
    });

    test("holds the row as worker_image_stale", async () => {
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => STALE_AND_UNLISTED,
        async () => {},
      );
      expect((await deps?.workerEnvProblem())?.reason).toBe(
        "worker_image_stale",
      );
    });
  });

  describe("buildClaimDeps workerEnvProblem when the paths cannot be listed", () => {
    const withChecks = parseFactoryConfig({
      ...RAW_CONFIG,
      allowed_check_commands: ["mise run check"],
    });
    const UNLISTED: CheckEnvironmentProblems = {
      image: [],
      runtime: ["world-writable paths could not be listed: listing timed out"],
    };

    function recordingLog(): { log: Logger; warns: string[] } {
      const warns: string[] = [];
      const log: Logger = {
        info: () => {},
        warn: (message) => {
          warns.push(message);
        },
        error: () => {},
      };
      return { log, warns };
    }

    test("still holds the row as worker_runtime_unsafe", async () => {
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => UNLISTED,
        async () => {},
        recordingLog().log,
      );
      expect((await deps?.workerEnvProblem())?.reason).toBe(
        "worker_runtime_unsafe",
      );
    });

    test("does not leave a notice that a person would have to resolve", async () => {
      const reported: Error[] = [];
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => UNLISTED,
        async (error) => {
          reported.push(error);
        },
        recordingLog().log,
      );
      await deps?.workerEnvProblem();
      expect(reported).toEqual([]);
    });

    test("leaves a warning log instead", async () => {
      const { log, warns } = recordingLog();
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => UNLISTED,
        async () => {},
        log,
      );
      await deps?.workerEnvProblem();
      expect(warns).toEqual([
        "world-writable paths could not be listed, so the hold leaves no notice",
      ]);
    });

    test("still reports a path that was found next to the failure to list", async () => {
      const reported: Error[] = [];
      const deps = buildClaimDeps(
        withChecks,
        CLIENT,
        async () => ({
          image: [],
          runtime: [
            ...UNLISTED.runtime,
            "world-writable paths created at runtime: /workspaces",
          ],
        }),
        async (error) => {
          reported.push(error);
        },
        recordingLog().log,
      );
      await deps?.workerEnvProblem();
      expect(reported.map((error) => error.name)).toEqual([
        "CheckRuntimeUnsafeError",
      ]);
    });
  });
});

// `watch_pr_ci.ts`が、人のPRの候補を表で見つけるかを収集の設定から決め、発見の部品に配線していることのテスト。
// 発見の判断は`tests/lib/pr_ci_watch.test.ts`が確かめる。
describe("watch_pr_ci source", () => {
  const ROOT = join(import.meta.dir, "..", "..");

  async function read(path: string): Promise<string> {
    return Bun.file(join(ROOT, path)).text();
  }

  function capture() {
    const warnings: { message: string; fields: unknown }[] = [];
    const log: Logger = {
      info() {},
      warn(message, fields) {
        warnings.push({ message, fields });
      },
      error() {},
    };
    return { log, warnings };
  }

  const ENABLED = {
    gh_collect_enabled: true,
    gh_collect_detail_enabled: true,
    pr_ci_watch_human_prs: true,
  };

  describe("watch_pr_ci: the use of the table in the human discovery", () => {
    test("reads the table when the collection is fully enabled", () => {
      const { log } = capture();
      expect(resolvePrCiHumanTableUse(ENABLED, log)).toBe(true);
    });

    test("does not read the table when the collection is off", () => {
      const { log } = capture();
      expect(
        resolvePrCiHumanTableUse(
          { ...ENABLED, gh_collect_enabled: false },
          log,
        ),
      ).toBe(false);
    });

    test("does not read the table when the detail collection is off", () => {
      const { log } = capture();
      expect(
        resolvePrCiHumanTableUse(
          { ...ENABLED, gh_collect_detail_enabled: false },
          log,
        ),
      ).toBe(false);
    });

    test("warns with the names of the false settings when the table is not read", () => {
      const { log, warnings } = capture();
      resolvePrCiHumanTableUse({ ...ENABLED, gh_collect_enabled: false }, log);
      expect(warnings).toEqual([
        {
          message:
            "the collection is not fully enabled, so the human discovery reads only the repositories that the config names",
          fields: {
            gh_collect_enabled: false,
            gh_collect_detail_enabled: true,
          },
        },
      ]);
    });

    test("does not warn when the collection is on", () => {
      const { log, warnings } = capture();
      resolvePrCiHumanTableUse(ENABLED, log);
      expect(warnings).toEqual([]);
    });

    test("does not warn when the human discovery is off", () => {
      const { log, warnings } = capture();
      resolvePrCiHumanTableUse(
        {
          gh_collect_enabled: false,
          gh_collect_detail_enabled: false,
          pr_ci_watch_human_prs: false,
        },
        log,
      );
      expect(warnings).toEqual([]);
    });
  });

  describe("watch_pr_ci: the wiring of the rows that wait", () => {
    test("does not count the rounds that ended on a note that waits", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain(
        "countPrCiFixRounds(owner, repo, prNumber, CI_CLAUDE_WAIT_NOTES)",
      );
    });

    test("closes the gate when the stop cannot be confirmed as released", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toMatch(/stopHeld:[\s\S]*holdsGate\(/);
    });
  });

  describe("watch_pr_ci: the wiring of the human discovery", () => {
    test("decides the use of the table from the settings", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain(
        "useTable: resolvePrCiHumanTableUse(config, log),",
      );
    });

    test("uses the number of owners for the threshold", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain(
        "staleAfterMs: ghDetailStaleAfterMs(config.owners.length),",
      );
    });

    test("passes a reader of the owner rows to the discovery", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain(
        "readOwnerPrs: (owner) => readGhOwnerOpenPullRequests(owner),",
      );
    });

    test("passes a reader of the repository rows to the discovery", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain(
        "readRepoPrs: (owner, repo) => readGhRepoOpenPullRequests(owner, repo),",
      );
    });

    test("passes a list of the open pull requests that does not wait for the rate limit", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain(
        "listOpenPullRequestsWithoutWait(client, owner, repo)",
      );
    });
  });

  describe("watch_pr_ci does not use the search API", () => {
    const githubImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/github\.ts"/;

    test("imports no name that starts with search from github.ts", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      const names = (githubImport.exec(source)?.[1] ?? "")
        .split(",")
        .map((name) => name.replace(/^\s*type\s+/, "").trim());
      expect(names.filter((name) => /^search/i.test(name))).toEqual([]);
    });

    test("does not call the search endpoint", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source.includes("search/issues")).toBe(false);
    });

    test("the watch has no dependency on a search of pull requests", async () => {
      const source = await read("f/factory/lib/pr_ci_watch.ts");
      expect(
        /searchHumanScope|HumanSearchState|OpenAuthoredPr|\bsearch:/.test(
          source,
        ),
      ).toBe(false);
    });

    test("the watch no longer reports a rate limit of the search", async () => {
      const source = await read("f/factory/lib/pr_ci_watch.ts");
      expect(source.includes("human_search_rate_limited")).toBe(false);
    });
  });

  describe("watch_pr_ci: the result", () => {
    test("no longer reports a source of the human discovery", async () => {
      const source = await read("f/factory/lib/pr_ci_watch.ts");
      expect(/human_source|human_fallback/.test(source)).toBe(false);
    });

    test("reports whether the collection was off", async () => {
      const source = await read("f/factory/lib/pr_ci_watch.ts");
      expect(source).toContain("human_collect_disabled");
    });
  });

  describe("watch_pr_ci: the tracked work items", () => {
    test("asks for one more than the limit so that the watch can see an overflow", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain("TRACKED_PR_LIMIT + 1,");
    });

    test("reads the database clock through the db module", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain("readDbNow: () => readDbNow(),");
    });

    test("marks the work item through the db module", async () => {
      const source = await read("f/factory/watch_pr_ci.ts");
      expect(source).toContain("markWorkItemPrClosed(id, prUrl, readAt),");
    });
  });
});
