import { afterAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChangedFile } from "../../scripts/host_apply/approval.ts";
import {
  buildPlan,
  type PlanGit,
  type PlanResult,
  parsePlanArgs,
} from "../../scripts/host_apply/plan.ts";
import {
  createFixtureRepo,
  type FixtureRepo,
  fixtureGitEnv,
} from "../fixtures/host_apply_repo.ts";

const REPO_ROOT = join(import.meta.dir, "../..");
const MISE = readFileSync(join(REPO_ROOT, "mise.toml"), "utf8");
const COMPOSE = readFileSync(
  join(REPO_ROOT, "infra/docker-compose.yml"),
  "utf8",
);

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);

type FakeCommit = { parent: string | null; files: Record<string, string> };

/** コミットの鎖を持つ、読み取り専用の偽のgit。呼ばれた操作を記録する。 */
function fakeGit(commits: Record<string, FakeCommit>) {
  const calls: string[] = [];
  function chain(sha: string): string[] {
    const result: string[] = [];
    let current: string | null = sha;
    while (current !== null) {
      result.push(current);
      current = commits[current]?.parent ?? null;
    }
    return result;
  }
  const git: PlanGit = {
    async commitExists(sha) {
      calls.push("commitExists");
      return sha in commits;
    },
    async isAncestor(ancestor, descendant) {
      calls.push("isAncestor");
      return chain(descendant).includes(ancestor);
    },
    async changedFiles(base, target) {
      calls.push("changedFiles");
      const before = commits[base]?.files ?? {};
      const after = commits[target]?.files ?? {};
      const out: ChangedFile[] = [];
      for (const path of new Set([
        ...Object.keys(before),
        ...Object.keys(after),
      ])) {
        if (!(path in before)) out.push({ path, status: "A" });
        else if (!(path in after)) out.push({ path, status: "D" });
        else if (before[path] !== after[path]) out.push({ path, status: "M" });
      }
      return out;
    },
    async readBlob(sha, path) {
      calls.push("readBlob");
      return commits[sha]?.files[path] ?? null;
    },
  };
  return { git, calls };
}

const BASE_FILES = {
  "mise.toml": MISE,
  "infra/docker-compose.yml": COMPOSE,
  "scripts/doctor.sh": "#!/bin/sh\n",
  "docs/a.md": "a\n",
};

function chainOf(...overrides: Record<string, string>[]) {
  const commits: Record<string, FakeCommit> = {
    [A]: { parent: null, files: { ...BASE_FILES } },
  };
  const shas = [B, C, D];
  let parent = A;
  overrides.forEach((override, index) => {
    const sha = shas[index] ?? "";
    commits[sha] = {
      parent,
      files: { ...(commits[parent]?.files ?? {}), ...override },
    };
    parent = sha;
  });
  return commits;
}

async function planOf(
  commits: Record<string, FakeCommit>,
  input: { applied: string; target: string; approved?: string | null },
): Promise<PlanResult> {
  return buildPlan(fakeGit(commits).git, {
    applied: input.applied,
    target: input.target,
    approved: input.approved ?? null,
    root: "/staging",
  });
}

describe("buildPlan: noop and ordering", () => {
  test("is noop when the target equals the applied sha", async () => {
    expect(
      (await planOf(chainOf({}), { applied: A, target: A })).decision,
    ).toBe("noop");
  });

  test("is noop when the target is an ancestor of the applied sha", async () => {
    expect(
      (await planOf(chainOf({}, {}), { applied: C, target: B })).decision,
    ).toBe("noop");
  });

  test("rejects a target that does not descend from the applied sha", async () => {
    const commits = chainOf({});
    commits[D] = { parent: null, files: { ...BASE_FILES } };
    const plan = await planOf(commits, { applied: B, target: D });
    expect(plan).toMatchObject({ decision: "rejected", kind: "not_ff" });
  });

  test("would converge for a documentation-only change", async () => {
    const plan = await planOf(chainOf({ "docs/a.md": "b\n" }), {
      applied: A,
      target: B,
    });
    expect(plan.decision).toBe("would_converge");
  });

  test("says that the CI was not checked, since plan has no network", async () => {
    const plan = await planOf(chainOf({ "docs/a.md": "b\n" }), {
      applied: A,
      target: B,
    });
    expect(plan).toMatchObject({ ci: "not_checked" });
  });

  test("throws when a commit does not exist", async () => {
    await expect(
      planOf(chainOf({}), { applied: A, target: C }),
    ).rejects.toThrow("commit");
  });

  test("throws when a sha is not forty hex digits", async () => {
    await expect(
      planOf(chainOf({}), { applied: A, target: "main" }),
    ).rejects.toThrow("sha");
  });
});

describe("buildPlan: approval", () => {
  test("waits for approval when a host-run script changed", async () => {
    const plan = await planOf(
      chainOf({ "scripts/doctor.sh": "#!/bin/sh\necho changed\n" }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "pending_approval",
      files: ["scripts/doctor.sh"],
      base: A,
    });
  });

  test("does not wait for approval when only enumerated mise values changed", async () => {
    const plan = await planOf(
      chainOf({
        "mise.toml": MISE.replace(
          'WM_VERSION = "1.817.0"',
          'WM_VERSION = "1.818.0"',
        ),
      }),
      { applied: A, target: B },
    );
    expect(plan.decision).toBe("would_converge");
  });

  test("waits for approval when another mise value changed", async () => {
    const plan = await planOf(
      chainOf({
        "mise.toml": MISE.replace(
          'WM_BASE_URL = "http://127.0.0.1:8080"',
          'WM_BASE_URL = "http://127.0.0.1:9090"',
        ),
      }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "pending_approval",
      files: ["mise.toml"],
    });
  });

  test("waits for approval when a new mise config appears", async () => {
    const plan = await planOf(chainOf({ "mise/config.toml": "[env]\n" }), {
      applied: A,
      target: B,
    });
    expect(plan).toMatchObject({
      decision: "pending_approval",
      files: ["mise/config.toml"],
    });
  });

  test("stops waiting once the change is approved", async () => {
    const plan = await planOf(
      chainOf({ "scripts/doctor.sh": "changed\n" }, { "docs/a.md": "c\n" }),
      { applied: A, target: C, approved: B },
    );
    expect(plan.decision).toBe("would_converge");
  });

  test("waits again when a target file changes after the approval", async () => {
    const plan = await planOf(
      chainOf(
        { "scripts/doctor.sh": "changed\n" },
        { "scripts/doctor.sh": "again\n" },
      ),
      { applied: A, target: C, approved: B },
    );
    expect(plan).toMatchObject({
      decision: "pending_approval",
      base: B,
      files: ["scripts/doctor.sh"],
    });
  });

  test("ignores an approved sha that is not an ancestor of the target", async () => {
    const commits = chainOf({ "scripts/doctor.sh": "changed\n" });
    commits[D] = { parent: A, files: { ...BASE_FILES, "docs/a.md": "z\n" } };
    const plan = await planOf(commits, { applied: A, target: B, approved: D });
    expect(plan.decision).toBe("pending_approval");
  });
});

describe("buildPlan: static checks", () => {
  test("rejects an enumerated mise value that does not fit its format", async () => {
    const plan = await planOf(
      chainOf({
        "mise.toml": MISE.replace(
          'WM_BIND = "127.0.0.1"',
          'WM_BIND = "0.0.0.0"',
        ),
      }),
      { applied: A, target: B, approved: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "mise_forbidden",
    });
  });

  test("rejects a compose definition with a privileged service", async () => {
    const plan = await planOf(
      chainOf({
        "infra/docker-compose.yml": COMPOSE.replace(
          "  windmill_extra:\n",
          "  windmill_extra:\n    privileged: true\n",
        ),
      }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "compose_forbidden",
    });
  });

  test("rejects a compose definition with a service that is not allowed", async () => {
    const plan = await planOf(
      chainOf({
        "infra/docker-compose.yml": COMPOSE.replace(
          "\nvolumes:\n  db_data: null",
          "\n  extra:\n    image: x\n\nvolumes:\n  db_data: null",
        ),
      }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "unknown_service",
    });
  });

  test("rejects a compose definition that is not valid YAML", async () => {
    const plan = await planOf(
      chainOf({ "infra/docker-compose.yml": "services: [\n" }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "compose_forbidden",
    });
  });

  test("rejects a target that has no compose file", async () => {
    const commits = chainOf({});
    delete commits[B]?.files["infra/docker-compose.yml"];
    const plan = await planOf(commits, { applied: A, target: B });
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "compose_forbidden",
    });
  });

  test("takes the compose variables from the target mise.toml", async () => {
    const plan = await planOf(
      chainOf({
        "mise.toml": MISE.replace(
          'WM_HTTP_PORT = "8080"',
          'WM_HTTP_PORT = "8081"',
        ),
      }),
      { applied: A, target: B },
    );
    expect(plan.decision).toBe("would_converge");
  });
});

describe("buildPlan only reads", () => {
  test("uses nothing but the four read operations", async () => {
    const fake = fakeGit(chainOf({ "docs/a.md": "x\n" }));
    await buildPlan(fake.git, {
      applied: A,
      target: B,
      approved: null,
      root: "/staging",
    });
    expect([...new Set(fake.calls)].sort()).toEqual(
      ["changedFiles", "commitExists", "isAncestor", "readBlob"].sort(),
    );
  });
});

describe("parsePlanArgs", () => {
  const ok = ["--repo", "/r", "--applied", A, "--target", B];

  test("reads the required flags", () => {
    expect(parsePlanArgs(ok)).toEqual({
      ok: true,
      args: { repo: "/r", applied: A, target: B, approved: null },
    });
  });

  test("reads the optional approved flag", () => {
    const parsed = parsePlanArgs([...ok, "--approved", C]);
    expect(parsed.ok && parsed.args.approved).toBe(C);
  });

  test("fails without --target", () => {
    expect(parsePlanArgs(["--repo", "/r", "--applied", A]).ok).toBe(false);
  });

  test("fails for a ref name instead of a sha", () => {
    expect(
      parsePlanArgs(["--repo", "/r", "--applied", A, "--target", "main"]).ok,
    ).toBe(false);
  });

  test("fails for an unknown flag", () => {
    expect(parsePlanArgs([...ok, "--fetch", "yes"]).ok).toBe(false);
  });

  test("fails for a flag given twice", () => {
    expect(parsePlanArgs([...ok, "--repo", "/other"]).ok).toBe(false);
  });

  test("fails for a flag without a value", () => {
    expect(parsePlanArgs(["--repo", "/r", "--applied", A, "--target"]).ok).toBe(
      false,
    );
  });
});

describe("plan against a real repository", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  function run(repo: FixtureRepo, args: string[]) {
    const result = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts/host-apply.ts"), "plan", ...args],
      { env: fixtureGitEnv(dirname(repo.dir)) },
    );
    return {
      code: result.exitCode,
      out: result.stdout.toString(),
      err: result.stderr.toString(),
    };
  }

  function setup() {
    const repo = createFixtureRepo();
    repos.push(repo);
    const applied = repo.commit(BASE_FILES, "base");
    const docs = repo.commit({ "docs/a.md": "changed\n" }, "docs");
    const doctor = repo.commit({ "scripts/doctor.sh": "changed\n" }, "doctor");
    return { repo, applied, docs, doctor };
  }

  test("prints would_converge for a documentation change", () => {
    const { repo, applied, docs } = setup();
    const { out } = run(repo, [
      "--repo",
      repo.dir,
      "--applied",
      applied,
      "--target",
      docs,
    ]);
    expect(JSON.parse(out).decision).toBe("would_converge");
  });

  test("prints pending_approval with the files for a doctor.sh change", () => {
    const { repo, applied, doctor } = setup();
    const { out } = run(repo, [
      "--repo",
      repo.dir,
      "--applied",
      applied,
      "--target",
      doctor,
    ]);
    expect(JSON.parse(out).files).toEqual(["scripts/doctor.sh"]);
  });

  test("prints noop when the target is the applied sha", () => {
    const { repo, applied } = setup();
    const { out } = run(repo, [
      "--repo",
      repo.dir,
      "--applied",
      applied,
      "--target",
      applied,
    ]);
    expect(JSON.parse(out).decision).toBe("noop");
  });

  test("exits 0 for a decision", () => {
    const { repo, applied, doctor } = setup();
    expect(
      run(repo, ["--repo", repo.dir, "--applied", applied, "--target", doctor])
        .code,
    ).toBe(0);
  });

  test("exits 1 when the commit does not exist", () => {
    const { repo, applied } = setup();
    expect(
      run(repo, [
        "--repo",
        repo.dir,
        "--applied",
        applied,
        "--target",
        "e".repeat(40),
      ]).code,
    ).toBe(1);
  });

  test("exits 2 for a bad command line", () => {
    const { repo } = setup();
    expect(run(repo, ["--repo", repo.dir]).code).toBe(2);
  });

  test("exits 2 for a subcommand other than plan", () => {
    const { repo } = setup();
    const result = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts/host-apply.ts"), "converge"],
      { env: fixtureGitEnv(dirname(repo.dir)) },
    );
    expect(result.exitCode).toBe(2);
  });

  test("leaves the repository, its work tree and its refs untouched", () => {
    const { repo, applied, doctor } = setup();
    const snapshot = () => {
      const entries: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          const full = join(dir, name);
          const stat = statSync(full);
          entries.push(`${full}:${stat.size}:${stat.mtimeMs}`);
          if (stat.isDirectory()) walk(full);
        }
      };
      walk(repo.dir);
      return entries;
    };
    const before = snapshot();
    run(repo, ["--repo", repo.dir, "--applied", applied, "--target", doctor]);
    expect(snapshot()).toEqual(before);
  });
});

describe("plan stays off the network, docker and the work tree", () => {
  const entry = readFileSync(join(REPO_ROOT, "scripts/host-apply.ts"), "utf8");
  const plan = readFileSync(
    join(REPO_ROOT, "scripts/host_apply/plan.ts"),
    "utf8",
  );

  test("the entry point never calls fetch or opens a socket", () => {
    expect(entry).not.toMatch(
      /\bfetch\s*\(|node:(net|http|https|dgram|tls)|Bun\.(connect|listen|serve)/,
    );
  });

  test("the entry point never names docker or curl", () => {
    expect(entry).not.toMatch(/docker|curl/i);
  });

  test("the entry point spawns only git with arguments from the read-only builders", () => {
    expect(entry.match(/Bun\.spawn\w*\(/g)?.length).toBe(1);
  });

  test("the entry point never runs a git command that writes or touches the network", () => {
    expect(entry).not.toMatch(
      /"(fetch|pull|push|checkout|worktree|clone|reset|merge|rebase|commit|add)"/,
    );
  });

  test("the plan logic spawns no process", () => {
    expect(plan).not.toMatch(/Bun\.spawn|child_process|Bun\.\$/);
  });
});
