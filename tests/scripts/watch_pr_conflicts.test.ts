import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { GhClient } from "../../f/factory/lib/github.ts";
import type { Logger } from "../../f/factory/lib/log.ts";
import {
  buildConflictFixDeps,
  buildConflictRecoveryDeps,
  resolveConflictTableUse,
} from "../../f/factory/watch_pr_conflicts.ts";

// watch_pr_conflictsの配線を静的に確かめる。判断と流れは`tests/lib/pr_conflict_watch.test.ts`が確かめる。
// 無効のときに何も読まず何も書かないことは、設定の確認が外部の読み取りより前にあることで確かめる。

const ROOT = join(import.meta.dir, "..", "..");

async function read(path: string): Promise<string> {
  return Bun.file(join(ROOT, path)).text();
}

describe("watch_pr_conflicts schedule", () => {
  test("runs every five minutes, offset from watch_pr_ci", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("schedule: 30 */5 * * * *");
  });

  test("skips a run while the previous one is running", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("no_flow_overlap: true");
  });

  test("runs the watch_pr_conflicts script", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("script_path: f/factory/watch_pr_conflicts");
  });

  test("uses the Tokyo time zone", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("timezone: Asia/Tokyo");
  });

  test("is enabled", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.schedule.yaml");
    expect(yaml).toContain("enabled: true");
  });
});

describe("watch_pr_conflicts script", () => {
  test("times out after the run time budget with room for the waits", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.script.yaml");
    const match = /^timeout: (\d+)$/m.exec(yaml);
    expect(Number(match?.[1])).toBe(600);
  });

  test("runs on the default worker", async () => {
    const yaml = await read("f/factory/watch_pr_conflicts.script.yaml");
    expect(yaml).not.toMatch(/^tag:/m);
  });

  test("does not use the native runtime", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toContain("//native");
  });

  // `main`はWindmillのクライアントに直接依存するので、テストでは呼べない。
  // 無効のときに何も呼ばないことは、`runPrConflictWatchIfEnabled`の動作を`tests/lib/pr_conflict_watch.test.ts`が確かめる。
  // ここでは、`main`が設定をその関数に渡し、変数の取得などの読み取りをすべて渡した関数の中に置いていることを確かめる。
  test("passes the setting to the guard", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toMatch(
      /runPrConflictWatchIfEnabled\(\s*config\.pr_conflict_watch_enabled,/,
    );
  });

  test("reads every variable inside the guarded function", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    const guard = source.indexOf("runPrConflictWatchIfEnabled(");
    expect(source.indexOf("wmill.getVariable")).toBeGreaterThan(guard);
  });

  test("does not check the setting by itself", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toContain("if (!config.pr_conflict_watch_enabled)");
  });

  test("does not depend on the CI watch setting", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).not.toMatch(/config\.pr_ci_watch_enabled/);
  });

  test("lists the open pull requests of the repositories that have pr_open items", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("listPrOpenRepos");
  });

  test("starts a fix through the shared pr_fix launch", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("launchPrFixFlow");
  });

  test("passes the recovery whatever the fix setting is", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toMatch(/\{ recovery, fix \}|\{ recovery \}/);
  });

  test("passes the fix only together with the recovery", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toMatch(
      /fix === undefined \? \{ recovery \} : \{ recovery, fix \}/,
    );
  });

  test("counts the rounds with the prefixes of the stale image notes", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("AUTO_RETRY_REASON_PREFIXES");
  });
});

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
};

const ENABLED = {
  ...RAW_CONFIG,
  pr_conflict_watch_enabled: true,
  pr_conflict_fix_enabled: true,
  pr_conflict_fix_enabled_since: "2026-10-16T03:00:00Z",
  pr_conflict_fix_max_rounds: 3,
  pr_conflict_fix_max_rounds_per_pr: 7,
  pr_conflict_fix_notify_grace_min: 30,
};

const CLIENT: GhClient = {
  run: async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
  }),
  ghToken: "token",
};

describe("buildConflictFixDeps", () => {
  test("builds nothing while the fix is disabled", () => {
    const config = parseFactoryConfig({
      ...RAW_CONFIG,
      pr_conflict_watch_enabled: true,
    });
    expect(buildConflictFixDeps(config, CLIENT)).toBeUndefined();
  });

  test("passes the rounds of an episode", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.maxRounds).toBe(3);
  });

  test("passes the rounds of a pull request", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.maxRoundsPerPr).toBe(7);
  });

  test("passes the time since which the fix is enabled", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.enabledSince).toEqual(
      new Date("2026-10-16T03:00:00Z"),
    );
  });

  test("passes the grace in minutes", () => {
    const config = parseFactoryConfig(ENABLED);
    expect(buildConflictFixDeps(config, CLIENT)?.graceMin).toBe(30);
  });
});

describe("buildConflictFixDeps: the reads of the decision", () => {
  const SHA = "c".repeat(40);

  type Calls = { name: string; args: unknown[] }[];

  function lookups(calls: Calls, options: { file?: string | null } = {}) {
    return {
      getBranchSha: async (...args: unknown[]) => {
        calls.push({ name: "getBranchSha", args: args.slice(1) });
        return SHA;
      },
      getMainCiStateBySha: async (...args: unknown[]) => {
        calls.push({ name: "getMainCiStateBySha", args });
        return "failed" as const;
      },
      getFileAtRef: async (...args: unknown[]) => {
        calls.push({ name: "getFileAtRef", args: args.slice(1) });
        return options.file === undefined ? null : options.file;
      },
    };
  }

  const config = parseFactoryConfig(ENABLED);

  test("reads the main CI of the head of the default branch", async () => {
    const calls: Calls = [];
    const deps = buildConflictFixDeps(config, CLIENT, lookups(calls));
    expect(await deps?.mainCiState("Acme", "Widgets", "main")).toBe("failed");
  });

  test("asks for the head of the default branch that it was given", async () => {
    const calls: Calls = [];
    await buildConflictFixDeps(config, CLIENT, lookups(calls))?.mainCiState(
      "Acme",
      "Widgets",
      "main",
    );
    expect(calls[0]).toEqual({
      name: "getBranchSha",
      args: ["Acme", "Widgets", "main"],
    });
  });

  test("looks up the main CI by the sha of that head", async () => {
    const calls: Calls = [];
    await buildConflictFixDeps(config, CLIENT, lookups(calls))?.mainCiState(
      "Acme",
      "Widgets",
      "main",
    );
    expect(calls[1]).toEqual({
      name: "getMainCiStateBySha",
      args: ["Acme", "Widgets", SHA],
    });
  });

  test("finds the marker in the skill of the factory branch", async () => {
    const calls: Calls = [];
    const deps = buildConflictFixDeps(
      config,
      CLIENT,
      lookups(calls, { file: "text conflict-fix-skill:v1 text" }),
    );
    expect(await deps?.hasSkillMarker()).toBe(true);
  });

  test("does not find the marker in a skill without it", async () => {
    const calls: Calls = [];
    const deps = buildConflictFixDeps(
      config,
      CLIENT,
      lookups(calls, { file: "ci-fix-skill:v1 only" }),
    );
    expect(await deps?.hasSkillMarker()).toBe(false);
  });

  test("does not find the marker when the skill file is missing", async () => {
    const calls: Calls = [];
    const deps = buildConflictFixDeps(config, CLIENT, lookups(calls));
    expect(await deps?.hasSkillMarker()).toBe(false);
  });

  test("reads the skill file of the factory repository at the factory branch", async () => {
    const calls: Calls = [];
    await buildConflictFixDeps(
      config,
      CLIENT,
      lookups(calls),
    )?.hasSkillMarker();
    expect(calls[0]).toEqual({
      name: "getFileAtRef",
      args: [
        "octo-owner",
        "atelier-works",
        ".claude/skills/factory-fix/SKILL.md",
        config.factory_branch,
      ],
    });
  });
});

describe("buildConflictRecoveryDeps: the reads of the recovery", () => {
  const stored = {
    status: "blocked" as const,
    flow_job_id: "job-1",
    conflict_episode: 2,
  };

  test("reads the note of the latest entry into the status of the work item", async () => {
    const asked: [number, string][] = [];
    const deps = buildConflictRecoveryDeps({
      getWorkItem: async () => stored,
      latestStatusEvent: async (id, status) => {
        asked.push([id, status]);
        return { note: "conflict round: check failed" };
      },
      latestFixRound: async () => null,
    });
    const state = await deps.readFixItem(55, 2);
    expect([state?.note, asked]).toEqual([
      "conflict round: check failed",
      [[55, "blocked"]],
    ]);
  });

  test("reads that the latest round pushed a commit", async () => {
    const deps = buildConflictRecoveryDeps({
      getWorkItem: async () => stored,
      latestStatusEvent: async () => null,
      latestFixRound: async () => ({ commit_shas: ["d".repeat(40)] }),
    });
    expect((await deps.readFixItem(55, 2))?.pushed).toBe(true);
  });

  test("reads that the latest round pushed nothing", async () => {
    const deps = buildConflictRecoveryDeps({
      getWorkItem: async () => stored,
      latestStatusEvent: async () => null,
      latestFixRound: async () => ({ commit_shas: [] }),
    });
    expect((await deps.readFixItem(55, 2))?.pushed).toBe(false);
  });

  test("passes the id of the work item to the release", async () => {
    const released: unknown[] = [];
    const deps = buildConflictRecoveryDeps({
      releasePrConflictFix: async (id, options) => {
        released.push([id, options]);
        return true;
      },
    });
    await deps.release(7, { fixWorkItemId: 55 });
    expect(released).toEqual([[7, { fixWorkItemId: 55 }]]);
  });
});

describe("watch_pr_conflicts: the use of the table in the round", () => {
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

  test("reads the table when the collection is fully enabled", () => {
    const { log } = capture();
    expect(
      resolveConflictTableUse(
        { gh_collect_enabled: true, gh_collect_detail_enabled: true },
        log,
      ),
    ).toBe(true);
  });

  test("does not read the table when the detail collection is off", () => {
    const { log } = capture();
    expect(
      resolveConflictTableUse(
        { gh_collect_enabled: true, gh_collect_detail_enabled: false },
        log,
      ),
    ).toBe(false);
  });

  test("does not read the table when the collection is off", () => {
    const { log } = capture();
    expect(
      resolveConflictTableUse(
        { gh_collect_enabled: false, gh_collect_detail_enabled: true },
        log,
      ),
    ).toBe(false);
  });

  test("warns with the names of the false settings when the table is not read", () => {
    const { log, warnings } = capture();
    resolveConflictTableUse(
      { gh_collect_enabled: true, gh_collect_detail_enabled: false },
      log,
    );
    expect(warnings).toEqual([
      {
        message:
          "the collection is not fully enabled, so the round does not discover repositories from the table",
        fields: {
          gh_collect_enabled: true,
          gh_collect_detail_enabled: false,
        },
      },
    ]);
  });

  test("does not warn when the table is read", () => {
    const { log, warnings } = capture();
    resolveConflictTableUse(
      { gh_collect_enabled: true, gh_collect_detail_enabled: true },
      log,
    );
    expect(warnings).toEqual([]);
  });

  test("passes the decision to the watch", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("useTable: resolveConflictTableUse(config, log),");
  });

  test("passes the verified owners to the watch", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain("owners: verifiedOwners,");
  });

  test("passes a reader of the owner rows to the watch", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain(
      "readOwnerPrs: (owner) => readGhOwnerOpenPullRequests(owner)",
    );
  });

  test("uses the number of owners for the threshold", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source).toContain(
      "staleAfterMs: ghDetailStaleAfterMs(config.owners.length)",
    );
  });
});

describe("watch_pr_conflicts does not use the search API", () => {
  const githubImport = /import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/github\.ts"/;

  test("imports no name that starts with search from github.ts", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    const names = (githubImport.exec(source)?.[1] ?? "")
      .split(",")
      .map((name) => name.replace(/^\s*type\s+/, "").trim());
    expect(names.filter((name) => /^search/i.test(name))).toEqual([]);
  });

  test("does not call the search endpoint", async () => {
    const source = await read("f/factory/watch_pr_conflicts.ts");
    expect(source.includes("search/issues")).toBe(false);
  });

  test("the watch has no dependency on a search of repositories", async () => {
    const source = await read("f/factory/lib/pr_conflict_watch.ts");
    expect(/searchOwners|searchOpenRepos|searchBlocked/.test(source)).toBe(
      false,
    );
  });

  test("the watch no longer reports a rate limit of the search", async () => {
    const source = await read("f/factory/lib/pr_conflict_watch.ts");
    expect(source.includes("search_rate_limited")).toBe(false);
  });
});

describe("watch_pr_conflicts: the result", () => {
  test("no longer reports a source of the round", async () => {
    const source = await read("f/factory/lib/pr_conflict_watch.ts");
    expect(/\bsource: /.test(source)).toBe(false);
  });

  test("no longer reports fallback searches", async () => {
    const source = await read("f/factory/lib/pr_conflict_watch.ts");
    expect(source.includes("fallback_searches")).toBe(false);
  });

  test("reports whether the collection was off", async () => {
    const source = await read("f/factory/lib/pr_conflict_watch.ts");
    expect(source).toContain("collect_disabled");
  });
});
