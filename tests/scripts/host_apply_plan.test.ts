import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangedFile } from "../../scripts/host_apply/approval.ts";
import { createApproveGit } from "../../scripts/host_apply/approve.ts";
import {
  approvedFilePath,
  writeApproved,
} from "../../scripts/host_apply/approved_io.ts";
import {
  type CommandResult,
  type CommandRunner,
  HOST_PROBE_ENV,
  type IssuedSpec,
  issueSpec,
} from "../../scripts/host_apply/command.ts";
import {
  COMMAND_TIMEOUT_MS,
  MAX_BLOB_BYTES,
} from "../../scripts/host_apply/constants.ts";
import { GIT_BIN, PS_BIN } from "../../scripts/host_apply/exec_paths.ts";
import {
  approveGitEnv,
  parseLsTreeZ,
  showBlobArgs,
} from "../../scripts/host_apply/git.ts";
import {
  buildPlan,
  type PlanGit,
  type PlanResult,
  parsePlanArgs,
  suspiciousTreePaths,
} from "../../scripts/host_apply/plan.ts";
import { createPlanGit } from "../../scripts/host_apply/plan_git.ts";
import { createRunner } from "../../scripts/host_apply/spawn_runner.ts";
import {
  createGitRunner,
  createLimitedRunner,
  formatFailure,
  main,
  readOnlyRunner,
} from "../../scripts/host-apply.ts";
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

type FakeCommit = {
  parent: string | null;
  files: Record<string, string>;
  /** 通常のファイル(100644)以外のmode。 */
  modes?: Record<string, string>;
};

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
    async listTree(sha) {
      calls.push("listTree");
      const commit = commits[sha];
      return Object.keys(commit?.files ?? {}).map((path) => ({
        mode: commit?.modes?.[path] ?? "100644",
        type: commit?.modes?.[path] === "160000" ? "commit" : "blob",
        path,
      }));
    },
    async readBlob(sha, path) {
      calls.push("readBlob");
      const text = commits[sha]?.files[path];
      if (text === undefined) return { kind: "absent" };
      if (text.length > MAX_BLOB_BYTES) return { kind: "too_large" };
      return { kind: "found", text };
    },
  };
  return { git, calls };
}

const PACKAGE_JSON = JSON.stringify({
  name: "x",
  dependencies: {},
  devDependencies: { typescript: "^7.0.2" },
});

const BASE_FILES = {
  "package.json": PACKAGE_JSON,
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
  input: {
    applied: string;
    target: string;
    approved?: string | null;
    approvedFrom?: string | null;
  },
): Promise<PlanResult> {
  return buildPlan(fakeGit(commits).git, {
    applied: input.applied,
    target: input.target,
    approved: input.approved ?? null,
    ...(input.approvedFrom !== undefined
      ? { approvedFrom: input.approvedFrom }
      : {}),
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

describe("buildPlan: symlinks and submodules in the target tree", () => {
  test("rejects a target tree that contains a symlink", async () => {
    const commits = chainOf({ "docs/link.md": "target" });
    const commit = commits[B];
    if (commit) commit.modes = { "docs/link.md": "120000" };
    const plan = await planOf(commits, { applied: A, target: B });
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "tree_forbidden",
    });
  });

  test("rejects a target tree that contains a submodule", async () => {
    const commits = chainOf({ vendor: "sha" });
    const commit = commits[B];
    if (commit) commit.modes = { vendor: "160000" };
    const plan = await planOf(commits, { applied: A, target: B });
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "tree_forbidden",
    });
  });

  test("rejects before asking for approval", async () => {
    const commits = chainOf({
      "docs/link.md": "target",
      "scripts/doctor.sh": "changed\n",
    });
    const commit = commits[B];
    if (commit) commit.modes = { "docs/link.md": "120000" };
    const plan = await planOf(commits, { applied: A, target: B });
    expect(plan.decision).toBe("rejected");
  });

  test("a symlink that already existed in an applied tree still rejects the target", async () => {
    const commits = chainOf({}, {});
    const commit = commits[C];
    if (commit) commit.modes = { "docs/a.md": "120000" };
    const plan = await planOf(commits, { applied: A, target: C });
    expect(plan).toMatchObject({ kind: "tree_forbidden" });
  });

  test("lists forbidden entries in the detail without file contents", async () => {
    const commits = chainOf({ "docs/link.md": "secret-looking-target" });
    const commit = commits[B];
    if (commit) commit.modes = { "docs/link.md": "120000" };
    const plan = await planOf(commits, { applied: A, target: B });
    expect(plan.decision === "rejected" ? plan.detail : "").toBe(
      "docs/link.md",
    );
  });
});

describe("buildPlan: more approval cases", () => {
  test("waits for approval when ci.yml changes", async () => {
    const plan = await planOf(
      chainOf({ ".github/workflows/ci.yml": "jobs: {}\n" }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "pending_approval",
      files: [".github/workflows/ci.yml"],
    });
  });

  test.each([
    ".github/workflows/console-dist.yml",
    ".github/workflows/brand-new.yml",
  ])("waits for approval when %s changes", async (path) => {
    const plan = await planOf(chainOf({ [path]: "jobs: {}\n" }), {
      applied: A,
      target: B,
    });
    expect(plan).toMatchObject({
      decision: "pending_approval",
      files: [path],
    });
  });

  test("does not wait for approval when a file next to the workflows changes", async () => {
    const plan = await planOf(
      chainOf({ ".github/dependabot.yml": "version: 2\n" }),
      { applied: A, target: B },
    );
    expect(plan.decision).toBe("would_converge");
  });

  test("waits for approval when CONSOLE_GITHUB_REPO changes", async () => {
    const plan = await planOf(
      chainOf({
        "mise.toml": MISE.replace(
          "https://github.com/u-stem/atelier-works",
          "https://github.com/someone/fork",
        ),
      }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "pending_approval",
      files: ["mise.toml"],
    });
  });

  test("rejects a mise file whose name differs only in case with tree_forbidden", async () => {
    const plan = await planOf(
      chainOf({
        "Mise.toml": MISE.replace(
          'WM_VERSION = "1.817.0"',
          'WM_VERSION = "1.818.0"',
        ),
      }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "tree_forbidden",
    });
  });

  test("does not wait for approval when only a dependency version changes", async () => {
    const plan = await planOf(
      chainOf({
        "package.json": PACKAGE_JSON.replace("^7.0.2", "^7.0.3"),
      }),
      { applied: A, target: B },
    );
    expect(plan.decision).toBe("would_converge");
  });

  test("waits for approval when package.json gets a scripts field", async () => {
    const plan = await planOf(
      chainOf({
        "package.json": JSON.stringify({
          ...JSON.parse(PACKAGE_JSON),
          scripts: { postinstall: "echo x" },
        }),
      }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "pending_approval",
      files: ["package.json"],
    });
  });

  test("rejects a package.json whose name differs only in case with tree_forbidden", async () => {
    const plan = await planOf(
      chainOf({ "Package.json": PACKAGE_JSON.replace("^7.0.2", "^7.0.3") }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "tree_forbidden",
    });
  });

  test("does not wait for approval when only bun.lock changes", async () => {
    const plan = await planOf(chainOf({ "bun.lock": "{}\n" }), {
      applied: A,
      target: B,
    });
    expect(plan.decision).toBe("would_converge");
  });
});

describe("buildPlan: paths that can name one file in two ways", () => {
  async function rejectedFor(paths: string[]): Promise<PlanResult> {
    const files: Record<string, string> = {};
    for (const path of paths) files[path] = "x";
    return planOf(chainOf(files), { applied: A, target: B });
  }

  test.each([
    "ſcripts/doctor.sh",
    "bunﬁg.toml",
    "infra/doc\u212A er-compose.yml".replace(" ", ""),
    "docs/café.md",
  ])("rejects the non-ASCII path %s", async (path) => {
    expect(await rejectedFor([path])).toMatchObject({
      decision: "rejected",
      kind: "tree_forbidden",
    });
  });

  test("rejects paths that differ only in Unicode normalization", async () => {
    expect(
      await rejectedFor(["docs/caf\u00e9.md", "docs/cafe\u0301.md"]),
    ).toMatchObject({ kind: "tree_forbidden" });
  });

  test("rejects two paths that differ only in case", async () => {
    expect(await rejectedFor(["docs/Foo", "docs/foo"])).toMatchObject({
      kind: "tree_forbidden",
    });
  });

  test("rejects files under directories that differ only in case", async () => {
    expect(await rejectedFor(["Scripts/a.ts", "scripts/b.ts"])).toMatchObject({
      kind: "tree_forbidden",
    });
  });

  test.each([
    "infra/docker-compose.override.yml",
    "infra/docker-compose.override.yaml",
    "infra/compose.override.yml",
    "infra/Compose.Override.yaml",
    "compose.override.yml",
  ])("rejects the compose override file %s", async (path) => {
    expect(await rejectedFor([path])).toMatchObject({
      kind: "tree_forbidden",
    });
  });

  test("accepts ASCII paths that differ in more than case", async () => {
    expect((await rejectedFor(["docs/foo", "docs/bar"])).decision).toBe(
      "would_converge",
    );
  });

  test("escapes non-ASCII characters in the detail", async () => {
    const plan = await rejectedFor(["docs/café.md"]);
    expect(
      plan.decision === "rejected" ? /^[\x20-\x7e]*$/.test(plan.detail) : false,
    ).toBe(true);
  });
});

describe("suspiciousTreePaths on the real tree", () => {
  test("finds nothing in the current tree", () => {
    const listing = Bun.spawnSync(["git", "ls-tree", "-r", "-z", "HEAD"], {
      cwd: REPO_ROOT,
    });
    expect(
      suspiciousTreePaths(parseLsTreeZ(listing.stdout.toString())),
    ).toEqual([]);
  });
});

describe("buildPlan: unreadable files", () => {
  test("rejects a compose file over the size limit", async () => {
    const plan = await planOf(
      chainOf({
        "infra/docker-compose.yml": `${COMPOSE}\nx-pad: ${"a".repeat(MAX_BLOB_BYTES)}\n`,
      }),
      { applied: A, target: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "compose_forbidden",
    });
  });

  test("rejects a mise.toml over the size limit", async () => {
    const plan = await planOf(
      chainOf({ "mise.toml": `${MISE}\n# ${"a".repeat(MAX_BLOB_BYTES)}\n` }),
      { applied: A, target: B, approved: B },
    );
    expect(plan).toMatchObject({
      decision: "rejected",
      kind: "mise_forbidden",
    });
  });
});

describe("createPlanGit", () => {
  const BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
  type Reply = { code: number; stdout: string };

  function planGitWith(reply: (args: string[]) => Reply) {
    const seen: string[][] = [];
    const git = createPlanGit(async (args) => {
      seen.push(args);
      return reply(args);
    });
    return { git, seen };
  }

  function subcommand(args: string[]): string {
    return args.find((arg) => !arg.startsWith("-") && !arg.includes("=")) ?? "";
  }

  test("reads a regular file", async () => {
    const { git } = planGitWith((args) =>
      subcommand(args) === "ls-tree"
        ? { code: 0, stdout: `100644 blob ${BLOB}      12\tmise.toml\u0000` }
        : { code: 0, stdout: "[env]\n" },
    );
    expect(await git.readBlob(A, "mise.toml")).toEqual({
      kind: "found",
      text: "[env]\n",
    });
  });

  test("tells that a path is absent", async () => {
    const { git } = planGitWith(() => ({ code: 0, stdout: "" }));
    expect(await git.readBlob(A, "mise.toml")).toEqual({ kind: "absent" });
  });

  test("does not call show for a path that is absent", async () => {
    const { git, seen } = planGitWith(() => ({ code: 0, stdout: "" }));
    await git.readBlob(A, "mise.toml");
    expect(seen.map(subcommand)).toEqual(["ls-tree"]);
  });

  test("throws when the listing of the path fails", async () => {
    const { git } = planGitWith(() => ({ code: 128, stdout: "" }));
    await expect(git.readBlob(A, "mise.toml")).rejects.toThrow("ls-tree");
  });

  test("throws, instead of reporting absent, when show fails", async () => {
    const { git } = planGitWith((args) =>
      subcommand(args) === "ls-tree"
        ? { code: 0, stdout: `100644 blob ${BLOB}      12\tmise.toml\u0000` }
        : { code: 128, stdout: "" },
    );
    await expect(git.readBlob(A, "mise.toml")).rejects.toThrow("show");
  });

  test("reports a file over the size limit without reading it", async () => {
    const { git, seen } = planGitWith(() => ({
      code: 0,
      stdout: `100644 blob ${BLOB}  ${MAX_BLOB_BYTES + 1}\tmise.toml\u0000`,
    }));
    const result = await git.readBlob(A, "mise.toml");
    expect([result.kind, seen.map(subcommand)]).toEqual([
      "too_large",
      ["ls-tree"],
    ]);
  });

  test("reports a symlink as not regular without reading it", async () => {
    const { git } = planGitWith(() => ({
      code: 0,
      stdout: `120000 blob ${BLOB}      9\tmise.toml\u0000`,
    }));
    expect(await git.readBlob(A, "mise.toml")).toEqual({ kind: "not_regular" });
  });

  test("lists the whole tree", async () => {
    const { git } = planGitWith(() => ({
      code: 0,
      stdout: `100644 blob ${BLOB}\ta\u0000120000 blob ${BLOB}\tb\u0000`,
    }));
    expect((await git.listTree(A)).map((entry) => entry.mode)).toEqual([
      "100644",
      "120000",
    ]);
  });

  test("answers false when merge-base says not an ancestor", async () => {
    const { git } = planGitWith(() => ({ code: 1, stdout: "" }));
    expect(await git.isAncestor(A, B)).toBe(false);
  });

  test("throws when merge-base fails for another reason", async () => {
    const { git } = planGitWith(() => ({ code: 128, stdout: "" }));
    await expect(git.isAncestor(A, B)).rejects.toThrow("merge-base");
  });

  test("throws when diff fails", async () => {
    const { git } = planGitWith(() => ({ code: 128, stdout: "" }));
    await expect(git.changedFiles(A, B)).rejects.toThrow("diff");
  });

  test("answers false when the commit does not exist", async () => {
    const { git } = planGitWith(() => ({ code: 128, stdout: "" }));
    expect(await git.commitExists(A)).toBe(false);
  });
});

describe("buildPlan: the applied sha that an approval was made for", () => {
  const DOCTOR = { "scripts/doctor.sh": "#!/bin/sh\necho changed\n" };

  test("uses the approval when approvedFrom equals the applied sha", async () => {
    const plan = await planOf(chainOf(DOCTOR), {
      applied: A,
      target: B,
      approved: B,
      approvedFrom: A,
    });
    expect(plan.decision).toBe("would_converge");
  });

  test("uses --approved as before when approvedFrom is not given", async () => {
    const plan = await planOf(chainOf(DOCTOR), {
      applied: A,
      target: B,
      approved: B,
    });
    expect(plan.decision).toBe("would_converge");
  });

  test.each([
    ["a descendant of the applied sha", B],
    ["a commit that does not exist", "e".repeat(40)],
  ])("ignores an approval made for %s", async (_name, approvedFrom) => {
    const plan = await planOf(chainOf(DOCTOR, {}), {
      applied: A,
      target: C,
      approved: C,
      approvedFrom,
    });
    expect(plan.decision).toBe("pending_approval");
  });

  test("ignores an approval made for an ancestor of the applied sha", async () => {
    const plan = await planOf(
      chainOf(DOCTOR, { "scripts/bootstrap.sh": "#!/bin/sh\n" }),
      { applied: B, target: C, approved: C, approvedFrom: A },
    );
    expect(plan.decision).toBe("pending_approval");
  });

  test("ignores an approval without an approvedFrom value", async () => {
    const plan = await planOf(chainOf(DOCTOR), {
      applied: A,
      target: B,
      approved: B,
      approvedFrom: null,
    });
    expect(plan.decision).toBe("pending_approval");
  });

  test("does not use an approval that was made before a change was reverted", async () => {
    // Aから見て差が無いSの承認は、AからRへ変えてSで戻した変更を見ていない。
    const commits = chainOf(DOCTOR, { "scripts/doctor.sh": "#!/bin/sh\n" });
    const plan = await planOf(commits, {
      applied: B,
      target: C,
      approved: C,
      approvedFrom: A,
    });
    expect(plan).toMatchObject({
      decision: "pending_approval",
      base: B,
      files: ["scripts/doctor.sh"],
    });
  });

  test("starts the next difference at the approved sha", async () => {
    const plan = await planOf(
      chainOf(DOCTOR, { "scripts/bootstrap.sh": "#!/bin/sh\n" }),
      { applied: A, target: C, approved: B, approvedFrom: A },
    );
    expect(plan).toMatchObject({
      decision: "pending_approval",
      base: B,
      files: ["scripts/bootstrap.sh"],
    });
  });

  test("throws for an approvedFrom value that is not a sha", async () => {
    await expect(
      planOf(chainOf(DOCTOR), {
        applied: A,
        target: B,
        approved: B,
        approvedFrom: "main",
      }),
    ).rejects.toThrow("sha");
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
      [
        "changedFiles",
        "commitExists",
        "isAncestor",
        "listTree",
        "readBlob",
      ].sort(),
    );
  });
});

describe("parsePlanArgs", () => {
  const ok = ["--repo", "/r", "--applied", A, "--target", B];

  test("reads the required flags", () => {
    expect(parsePlanArgs(ok)).toEqual({
      ok: true,
      args: {
        repo: "/r",
        applied: A,
        target: B,
        approved: null,
        stateDir: null,
      },
    });
  });

  test("reads the optional approved flag", () => {
    const parsed = parsePlanArgs([...ok, "--approved", C]);
    expect(parsed.ok && parsed.args.approved).toBe(C);
  });

  test("reads the optional state directory", () => {
    const parsed = parsePlanArgs([...ok, "--state-dir", "/var/state"]);
    expect(parsed.ok && parsed.args.stateDir).toBe("/var/state");
  });

  test("fails for a relative state directory", () => {
    expect(parsePlanArgs([...ok, "--state-dir", "state"]).ok).toBe(false);
  });

  test("fails for a state directory with a C1 control character", () => {
    expect(parsePlanArgs([...ok, "--state-dir", "/var/st\u0085ate"]).ok).toBe(
      false,
    );
  });

  test("fails for a state directory with a control character", () => {
    expect(parsePlanArgs([...ok, "--state-dir", "/var/st\nate"]).ok).toBe(
      false,
    );
  });

  test("fails when --approved and --state-dir are both given", () => {
    expect(
      parsePlanArgs([...ok, "--approved", C, "--state-dir", "/var/state"]).ok,
    ).toBe(false);
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

  test("rejects a target that contains a symlink", () => {
    const { repo, applied } = setup();
    const target = repo.symlink("docs/link.md", "../secret");
    const { out } = run(repo, [
      "--repo",
      repo.dir,
      "--applied",
      applied,
      "--target",
      target,
    ]);
    expect(JSON.parse(out)).toMatchObject({
      decision: "rejected",
      kind: "tree_forbidden",
    });
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

describe("formatFailure", () => {
  test("writes a control character of the message as an escape", () => {
    expect(formatFailure(new Error("bad \u001b[2J path"))).toBe(
      "host-apply: bad \\u001b[2J path",
    );
  });

  test("keeps a plain message as it is", () => {
    expect(formatFailure(new Error("commit not found"))).toBe(
      "host-apply: commit not found",
    );
  });

  test("names a value that is not an Error", () => {
    expect(formatFailure("oops")).toBe("host-apply: unknown error");
  });
});

describe("plan --state-dir against a real repository", () => {
  const repos: FixtureRepo[] = [];
  const dirs: string[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
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
    const stateDir = mkdtempSync(join(tmpdir(), "host-apply-state-"));
    dirs.push(stateDir);
    chmodSync(stateDir, 0o700);
    return { repo, applied, docs, doctor, stateDir };
  }

  function record(sha: string, applied: string) {
    return {
      schema: 1 as const,
      sha,
      applied,
      approved_at: "2026-10-18T01:02:03.000Z",
      files: [{ path: "scripts/doctor.sh", status: "M" as const }],
    };
  }

  function plan(
    s: ReturnType<typeof setup>,
    extra: string[] = ["--state-dir", s.stateDir],
  ) {
    return run(s.repo, [
      "--repo",
      s.repo.dir,
      "--applied",
      s.applied,
      "--target",
      s.doctor,
      ...extra,
    ]);
  }

  test("uses a record that was made for the applied sha", () => {
    const s = setup();
    writeApproved(s.stateDir, record(s.doctor, s.applied));
    expect(JSON.parse(plan(s).out).decision).toBe("would_converge");
  });

  test("ignores a record that was made for another applied sha", () => {
    const s = setup();
    writeApproved(s.stateDir, record(s.doctor, s.docs));
    expect(JSON.parse(plan(s).out).decision).toBe("pending_approval");
  });

  test("waits for approval when there is no record", () => {
    const s = setup();
    expect(JSON.parse(plan(s).out).decision).toBe("pending_approval");
  });

  test("waits for approval when the record is broken", () => {
    const s = setup();
    writeFileSync(approvedFilePath(s.stateDir), "{", { mode: 0o600 });
    expect(JSON.parse(plan(s).out).decision).toBe("pending_approval");
  });

  test("warns on the standard error when the record is broken", () => {
    const s = setup();
    writeFileSync(approvedFilePath(s.stateDir), "{", { mode: 0o600 });
    expect(plan(s).err).toContain("approved.json");
  });

  test("ignores a record that others can read", () => {
    const s = setup();
    writeApproved(s.stateDir, record(s.doctor, s.applied));
    chmodSync(approvedFilePath(s.stateDir), 0o644);
    expect(JSON.parse(plan(s).out).decision).toBe("pending_approval");
  });

  test("exits 2 when --approved and --state-dir are both given", () => {
    const s = setup();
    expect(
      plan(s, ["--approved", s.doctor, "--state-dir", s.stateDir]).code,
    ).toBe(2);
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

  test("the entry point starts no process itself", () => {
    expect(entry).not.toMatch(/Bun\.spawn|child_process|Bun\.\$/);
  });

  test("the entry point gets its runner from spawn_runner", () => {
    expect(entry).toContain('from "./host_apply/spawn_runner.ts"');
  });

  test("the entry point builds its git commands only with gitReadSpec", () => {
    expect(entry).toContain('from "./host_apply/run_git.ts"');
  });

  test("the entry point never runs a git command that writes or touches the network", () => {
    expect(entry).not.toMatch(
      /"(fetch|pull|push|checkout|worktree|clone|reset|merge|rebase|commit|add)"/,
    );
  });

  test("the read adapter spawns no process, since the runner is injected", () => {
    const adapter = readFileSync(
      join(REPO_ROOT, "scripts/host_apply/plan_git.ts"),
      "utf8",
    );
    expect(adapter).not.toMatch(/Bun\.spawn|child_process|Bun\.\$/);
  });

  test("the plan logic spawns no process", () => {
    expect(plan).not.toMatch(/Bun\.spawn|child_process|Bun\.\$/);
  });
});

describe("the runner that the entry point gives to plan and approve", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  function readSpec(): IssuedSpec {
    return issueSpec({
      kind: "git_read",
      bin: GIT_BIN,
      args: showBlobArgs(SHA, "a"),
      env: approveGitEnv(),
      cwd: "/srv/repo",
      timeoutMs: COMMAND_TIMEOUT_MS.git_read,
    });
  }

  function probeSpec(): IssuedSpec {
    return issueSpec({
      kind: "host_probe",
      bin: PS_BIN,
      args: ["-o", "lstart=", "-p", "1"],
      env: HOST_PROBE_ENV,
      cwd: "/",
      timeoutMs: COMMAND_TIMEOUT_MS.host_probe,
    });
  }

  function done(stdout: string, code = 0): CommandResult {
    return {
      kind: "done",
      code,
      stdout,
      stderr: "",
      stdoutDropped: false,
      stderrDropped: false,
    };
  }

  const TRUNCATED: CommandResult = {
    kind: "truncated",
    stderr: "",
    stderrDropped: false,
  };

  function recording(result: CommandResult) {
    const calls: IssuedSpec[] = [];
    const run: CommandRunner = async (spec) => {
      calls.push(spec);
      return result;
    };
    return { calls, run };
  }

  test("readOnlyRunner refuses a kind other than git_read", async () => {
    const inner = recording(done(""));
    await expect(readOnlyRunner(inner.run)(probeSpec())).rejects.toMatchObject({
      reason: "invalid_spec",
    });
  });

  test("readOnlyRunner does not start a command of another kind", async () => {
    const inner = recording(done(""));
    await readOnlyRunner(inner.run)(probeSpec()).catch(() => {});
    expect(inner.calls).toEqual([]);
  });

  test("readOnlyRunner passes a git_read command through", async () => {
    const inner = recording(done("body"));
    expect(await readOnlyRunner(inner.run)(readSpec())).toEqual(done("body"));
  });

  test("createGitRunner returns the exit code and the output", async () => {
    const run = createGitRunner(recording(done("out", 3)).run, "/srv/repo");
    expect(await run(showBlobArgs(SHA, "a"))).toEqual({
      code: 3,
      stdout: "out",
    });
  });

  test("createGitRunner runs git in the given directory", async () => {
    const inner = recording(done(""));
    await createGitRunner(inner.run, "/srv/repo")(showBlobArgs(SHA, "a"));
    expect(inner.calls[0]?.cwd).toBe("/srv/repo");
  });

  test("createGitRunner fails for output over the limit", async () => {
    const run = createGitRunner(recording(TRUNCATED).run, "/srv/repo");
    await expect(run(showBlobArgs(SHA, "a"))).rejects.toThrow("too large");
  });

  test("createLimitedRunner passes the limit to the command", async () => {
    const inner = recording(done(""));
    await createLimitedRunner(inner.run, "/srv/repo")(
      showBlobArgs(SHA, "a"),
      99,
    );
    expect(inner.calls[0]?.maxStdoutBytes).toBe(99);
  });

  test("createLimitedRunner reports output over the limit as truncated", async () => {
    const run = createLimitedRunner(recording(TRUNCATED).run, "/srv/repo");
    expect(await run(showBlobArgs(SHA, "a"), 99)).toEqual({ truncated: true });
  });

  test("createLimitedRunner returns the exit code and the output", async () => {
    const run = createLimitedRunner(recording(done("out", 2)).run, "/srv/repo");
    expect(await run(showBlobArgs(SHA, "a"), 99)).toEqual({
      truncated: false,
      code: 2,
      stdout: "out",
    });
  });

  describe("plan through main", () => {
    function quiet() {
      const err = spyOn(console, "error").mockImplementation(() => {});
      const out = spyOn(process.stdout, "write").mockImplementation(() => true);
      return {
        errors: () => err.mock.calls.map((call) => String(call[0])),
        restore: () => {
          err.mockRestore();
          out.mockRestore();
        },
      };
    }

    const ARGS = ["plan", "--repo", "/srv/repo", "--applied", A, "--target", B];

    test("fails when git output is over the limit, even if git exited with 0", async () => {
      const io = quiet();
      try {
        expect(await main(ARGS, { runner: recording(TRUNCATED).run })).toBe(1);
      } finally {
        io.restore();
      }
    });

    test("says that the output is too large", async () => {
      const io = quiet();
      try {
        await main(ARGS, { runner: recording(TRUNCATED).run });
        expect(io.errors()).toContain("host-apply: git output is too large");
      } finally {
        io.restore();
      }
    });

    test("resolves a relative --repo against the working directory", async () => {
      const io = quiet();
      const inner = recording(done("", 1));
      try {
        await main(["plan", "--repo", ".", "--applied", A, "--target", B], {
          runner: inner.run,
        });
        expect(inner.calls[0]?.cwd).toBe(process.cwd());
      } finally {
        io.restore();
      }
    });

    test("starts only git_read commands", async () => {
      const io = quiet();
      const inner = recording(done("", 1));
      try {
        await main(ARGS, { runner: inner.run });
        expect([...new Set(inner.calls.map((spec) => spec.kind))]).toEqual([
          "git_read",
        ]);
      } finally {
        io.restore();
      }
    });
  });
});

describe("the entry point with the real runner", () => {
  const repos: FixtureRepo[] = [];
  afterAll(() => {
    for (const repo of repos) repo.cleanup();
  });

  function run(cwd: string, args: string[]) {
    const result = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "scripts/host-apply.ts"), "plan", ...args],
      { cwd, env: fixtureGitEnv(dirname(cwd)) },
    );
    return { code: result.exitCode, out: result.stdout.toString() };
  }

  function setup() {
    const repo = createFixtureRepo();
    repos.push(repo);
    const applied = repo.commit(BASE_FILES, "base");
    const doctor = repo.commit({ "scripts/doctor.sh": "changed\n" }, "doctor");
    return { repo, applied, doctor };
  }

  test("plan --repo . judges the repository of the working directory", () => {
    const { repo, applied, doctor } = setup();
    const { out } = run(repo.dir, [
      "--repo",
      ".",
      "--applied",
      applied,
      "--target",
      doctor,
    ]);
    expect(JSON.parse(out).files).toEqual(["scripts/doctor.sh"]);
  });

  test("plan finds a change outside the directory that --repo names", () => {
    const { repo, applied, doctor } = setup();
    const { out } = run(repo.dir, [
      "--repo",
      join(repo.dir, "docs"),
      "--applied",
      applied,
      "--target",
      doctor,
    ]);
    expect(JSON.parse(out).files).toEqual(["scripts/doctor.sh"]);
  });

  test("plan rejects a symlink that is outside the directory that --repo names", () => {
    const { repo, applied } = setup();
    const target = repo.symlink("scripts/link.sh", "../secret");
    const { out } = run(repo.dir, [
      "--repo",
      join(repo.dir, "docs"),
      "--applied",
      applied,
      "--target",
      target,
    ]);
    expect(JSON.parse(out)).toMatchObject({
      decision: "rejected",
      kind: "tree_forbidden",
    });
  });

  function bigDiff(lines: number) {
    const repo = createFixtureRepo();
    repos.push(repo);
    const base = repo.commit({ "big.txt": "start\n" }, "base");
    const target = repo.commit(
      { "big.txt": `start\n${`${"x".repeat(99)}\n`.repeat(lines)}` },
      "big",
    );
    return { repo, base, target };
  }

  function approveGit(repo: FixtureRepo) {
    return createApproveGit(
      createGitRunner(createRunner(), repo.dir),
      createLimitedRunner(createRunner(), repo.dir),
    );
  }

  test("approve can read a difference between 256 KiB and 512 KiB", async () => {
    const { repo, base, target } = bigDiff(3000);
    const patch = await approveGit(repo).diffPatch(base, target, ["big.txt"]);
    expect(patch.truncated).toBe(false);
  });

  test("approve reports a difference over 512 KiB as truncated", async () => {
    const { repo, base, target } = bigDiff(6000);
    const patch = await approveGit(repo).diffPatch(base, target, ["big.txt"]);
    expect(patch.truncated).toBe(true);
  });

  test("approve reads the text of the difference", async () => {
    const { repo, base, target } = bigDiff(3);
    const patch = await approveGit(repo).diffPatch(base, target, ["big.txt"]);
    expect(patch.text).toContain(`+${"x".repeat(99)}\n`);
  });
});
