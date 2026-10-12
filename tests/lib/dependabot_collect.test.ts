import { describe, expect, test } from "bun:test";
import {
  type CollectDeps,
  collectGateInput,
  deriveTarget,
  LOCKFILE_PATHS,
  NOT_OPEN,
} from "../../f/factory/lib/dependabot_collect.ts";
import {
  type RegistryFacts,
  RegistryHttpError,
  RegistryResponseError,
  RegistryUnavailableError,
} from "../../f/factory/lib/dependabot_registry.ts";
import {
  evaluateGate,
  GITHUB_ACTIONS_APP_ID,
  REQUIRED_CHECKS,
} from "../../f/factory/lib/dependabot_support.ts";
import {
  GitHubHttpError,
  GitHubPaginationLimitError,
  GitHubRateLimitError,
  GitHubResponseError,
  type PrCommit,
  type PullRequest,
} from "../../f/factory/lib/github.ts";

// ---- ロックファイルの fixture ----

type LockEntry = { key: string; id: string; integrity?: string };

// sha512のbase64は、86文字に`==`が付く88文字になる。
const INTEGRITY_A = `sha512-${"A".repeat(86)}==`;
const INTEGRITY_B = `sha512-${"B".repeat(86)}==`;

function lockText(
  workspaceDeps: Record<string, string>,
  entries: readonly LockEntry[],
): string {
  const deps = Object.entries(workspaceDeps)
    .map(([name, spec]) => `        "${name}": "${spec}",\n`)
    .join("");
  const packages = entries
    .map(
      (e) =>
        `    "${e.key}": ["${e.id}", "", {}, "${e.integrity ?? INTEGRITY_A}"],\n`,
    )
    .join("\n");
  return `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "fixture",
      "dependencies": {
${deps}      },
    },
  },
  "packages": {
${packages}  },
}
`;
}

const OTHER: LockEntry = {
  key: "other",
  id: "other@2.0.0",
  integrity: INTEGRITY_A,
};

const LOCK_BEFORE = lockText({ "left-pad": "1.3.0", other: "2.0.0" }, [
  { key: "left-pad", id: "left-pad@1.3.0", integrity: INTEGRITY_A },
  OTHER,
]);

const LOCK_AFTER = lockText({ "left-pad": "1.3.1", other: "2.0.0" }, [
  { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
  OTHER,
]);

const MANIFEST_BEFORE = `${JSON.stringify(
  { name: "fixture", dependencies: { "left-pad": "1.3.0", other: "2.0.0" } },
  null,
  2,
)}\n`;

const MANIFEST_AFTER = `${JSON.stringify(
  { name: "fixture", dependencies: { "left-pad": "1.3.1", other: "2.0.0" } },
  null,
  2,
)}\n`;

function lockFile(
  before: string | null,
  after: string | null,
  path = "bun.lock",
) {
  return { path, before, after };
}

// ---- deriveTarget ----

describe("deriveTarget", () => {
  test("derives the target of a direct dependency update", () => {
    const result = deriveTarget([
      { path: "package.json", before: MANIFEST_BEFORE, after: MANIFEST_AFTER },
      lockFile(LOCK_BEFORE, LOCK_AFTER),
    ]);

    expect(result).toEqual({
      kind: "ok",
      target: { name: "left-pad", to: "1.3.1" },
      from: "1.3.0",
      update: "patch",
    });
  });

  test("derives the target of a transitive update that leaves package.json alone", () => {
    const result = deriveTarget([lockFile(LOCK_BEFORE, LOCK_AFTER)]);

    expect(result.kind).toBe("ok");
  });

  test("ignores the contents of files that are not lockfiles", () => {
    const result = deriveTarget([
      { path: "package.json", before: "not json", after: null },
      lockFile(LOCK_BEFORE, LOCK_AFTER),
    ]);

    expect(result.kind).toBe("ok");
  });

  test("derives the target from the console lockfile", () => {
    const result = deriveTarget([
      lockFile(LOCK_BEFORE, LOCK_AFTER, "console/bun.lock"),
    ]);

    expect(result.kind).toBe("ok");
  });

  test("takes the top-level entry as the new version when nested copies exist", () => {
    const before = lockText({ "left-pad": "1.3.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "foo/left-pad", id: "left-pad@1.3.0" },
    ]);
    const after = lockText({ "left-pad": "1.3.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "foo/left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    expect(deriveTarget([lockFile(before, after)])).toEqual({
      kind: "ok",
      target: { name: "left-pad", to: "1.3.1" },
      from: "1.3.0",
      update: "patch",
    });
  });

  test("reports the heaviest update among the copies of the target", () => {
    const before = lockText({ "left-pad": "1.3.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "foo/left-pad", id: "left-pad@1.2.0" },
    ]);
    const after = lockText({ "left-pad": "1.3.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "foo/left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    const result = deriveTarget([lockFile(before, after)]);

    expect(result.kind === "ok" ? result.update : null).toBe("minor");
  });

  test("reports major when a copy of the target jumps a major version", () => {
    const before = lockText({ "left-pad": "1.3.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "foo/left-pad", id: "left-pad@0.9.0" },
    ]);
    const after = lockText({ "left-pad": "1.3.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "foo/left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    const result = deriveTarget([lockFile(before, after)]);

    expect(result.kind === "ok" ? result.update : null).toBe("major");
  });

  test("reports unknown for a version that cannot be classified", () => {
    const after = lockText({ "left-pad": "1.3.1-beta.1", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.1-beta.1", integrity: INTEGRITY_B },
      OTHER,
    ]);

    const result = deriveTarget([lockFile(LOCK_BEFORE, after)]);

    expect(result.kind === "ok" ? result.update : null).toBe("unknown");
  });

  test("accepts the same update in both lockfiles", () => {
    const result = deriveTarget([
      lockFile(LOCK_BEFORE, LOCK_AFTER),
      lockFile(LOCK_BEFORE, LOCK_AFTER, "console/bun.lock"),
    ]);

    expect(result.kind).toBe("ok");
  });

  test("needs a human when the lockfiles resolve the target differently", () => {
    const other = lockText({ "left-pad": "1.3.2", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.2", integrity: INTEGRITY_B },
      OTHER,
    ]);

    const result = deriveTarget([
      lockFile(LOCK_BEFORE, LOCK_AFTER),
      lockFile(LOCK_BEFORE, other, "console/bun.lock"),
    ]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when more than one package changed", () => {
    const after = lockText({ "left-pad": "1.3.1", other: "2.0.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.1", integrity: INTEGRITY_B },
    ]);

    const result = deriveTarget([lockFile(LOCK_BEFORE, after)]);

    expect(result).toEqual({
      kind: "needs_human",
      reason: "more than one package changed: left-pad, other",
    });
  });

  test("needs a human when no package changed", () => {
    const result = deriveTarget([lockFile(LOCK_BEFORE, LOCK_BEFORE)]);

    expect(result).toEqual({
      kind: "needs_human",
      reason: "no package changed in the lockfiles",
    });
  });

  test("needs a human when there is no lockfile", () => {
    const result = deriveTarget([
      { path: "package.json", before: MANIFEST_BEFORE, after: MANIFEST_AFTER },
    ]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when a lockfile cannot be read", () => {
    const result = deriveTarget([lockFile(LOCK_BEFORE, "{ not json")]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when a lockfile was added", () => {
    const result = deriveTarget([lockFile(null, LOCK_AFTER)]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when a lockfile was deleted", () => {
    const result = deriveTarget([lockFile(LOCK_BEFORE, null)]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when the changed package was added", () => {
    const before = lockText({ other: "2.0.0" }, [OTHER]);

    const result = deriveTarget([lockFile(before, LOCK_AFTER)]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when the changed package was removed", () => {
    const after = lockText({ other: "2.0.0" }, [OTHER]);

    const result = deriveTarget([lockFile(LOCK_BEFORE, after)]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when only a nested copy changed and no top-level entry exists", () => {
    const before = lockText({}, [
      { key: "foo/left-pad", id: "left-pad@1.3.0" },
    ]);
    const after = lockText({}, [
      { key: "foo/left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    const result = deriveTarget([lockFile(before, after)]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when only a nested copy changed and the top-level entry stayed", () => {
    const before = lockText({ "left-pad": "1.3.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "foo/left-pad", id: "left-pad@1.2.0" },
    ]);
    const after = lockText({ "left-pad": "1.3.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0" },
      { key: "foo/left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
    ]);

    expect(deriveTarget([lockFile(before, after)])).toEqual({
      kind: "needs_human",
      reason: "the top-level entry of the target did not change: left-pad",
    });
  });

  test("needs a human when only the integrity of the top-level entry changed", () => {
    const after = lockText({ "left-pad": "1.3.0", other: "2.0.0" }, [
      { key: "left-pad", id: "left-pad@1.3.0", integrity: INTEGRITY_B },
      OTHER,
    ]);

    const result = deriveTarget([lockFile(LOCK_BEFORE, after)]);

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when a changed entry is malformed", () => {
    const after = LOCK_AFTER.replace('"left-pad@1.3.1"', "42");

    const result = deriveTarget([lockFile(LOCK_BEFORE, after)]);

    expect(result.kind).toBe("needs_human");
  });

  test("shortens a long package name in the reason", () => {
    const name = "n".repeat(500);
    const before = lockText({}, [
      { key: name, id: `${name}@1.0.0` },
      { key: "a", id: "a@1.0.0" },
    ]);
    const after = lockText({}, [
      { key: name, id: `${name}@1.0.1`, integrity: INTEGRITY_B },
      { key: "a", id: "a@1.0.1", integrity: INTEGRITY_B },
    ]);

    const result = deriveTarget([lockFile(before, after)]);

    expect(
      result.kind === "needs_human" ? result.reason.length : 0,
    ).toBeLessThan(300);
  });
});

// ---- collectGateInput ----

const HEAD = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);
const OTHER_HEAD = "c".repeat(40);
const BASE_SHA = "d".repeat(40);
const OTHER_BASE_SHA = "e".repeat(40);
const PR_REF = { owner: "acme", repo: "widgets", number: 12 };
const NOW = Date.parse("2026-10-20T00:00:00Z");

function pullRequest(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 12,
    title: "Bump left-pad from 1.3.0 to 1.3.1",
    body: "",
    draft: false,
    state: "open",
    merged: false,
    autoMergeEnabled: false,
    headSha: HEAD,
    headRef: "dependabot/npm_and_yarn/left-pad-1.3.1",
    headRepoFullName: "acme/widgets",
    baseRepoFullName: "acme/widgets",
    baseRepoId: 1,
    baseRef: "main",
    mergeable: true,
    mergeableState: "clean",
    authorLogin: "dependabot[bot]",
    authorType: "Bot",
    ...overrides,
  };
}

const DEPENDABOT_COMMIT: PrCommit = {
  sha: HEAD,
  authorLogin: "dependabot[bot]",
  authorType: "Bot",
  committerLogin: "web-flow",
  verified: true,
  parentCount: 1,
};

function facts(overrides: Partial<RegistryFacts> = {}): RegistryFacts {
  return {
    name: "left-pad",
    version: "1.3.1",
    publishedAtIso: "2026-10-01T00:00:00.000Z",
    installScripts: { before: {}, after: {} },
    integrity: INTEGRITY_B,
    registryMetadata: "",
    missing: [],
    ...overrides,
  };
}

type Setup = {
  prs?: PullRequest[];
  changed?: { filename: string; previousFilename?: string | null }[];
  contents?: Record<string, { before: string | null; after: string | null }>;
  commits?: PrCommit[];
  registry?: () => Promise<RegistryFacts>;
  compare?: () => Promise<{
    mergeBaseSha: string;
    files: {
      filename: string;
      previousFilename: string | null;
      status: string;
    }[];
    commits: PrCommit[];
  }>;
  checks?: { name: string; appId: number | null; conclusion: string | null }[];
  getFile?: (path: string, ref: string) => Promise<string | null>;
  getPr?: () => Promise<PullRequest>;
  /** `getBranchSha`が順に返すsha。使い切ったら最後の値を返す。 */
  baseShas?: string[];
  branchSha?: () => Promise<string>;
};

type Calls = {
  getPr: number;
  compare: { baseSha: string; headSha: string }[];
  branch: string[];
  files: { path: string; ref: string }[];
  checks: string[];
  registry: { name: string; from: string; to: string }[];
};

function setup(options: Setup = {}): { deps: CollectDeps; calls: Calls } {
  const calls: Calls = {
    getPr: 0,
    compare: [],
    branch: [],
    files: [],
    checks: [],
    registry: [],
  };
  const prs = options.prs ?? [pullRequest(), pullRequest()];
  const contents = options.contents ?? {
    "package.json": { before: MANIFEST_BEFORE, after: MANIFEST_AFTER },
    "bun.lock": { before: LOCK_BEFORE, after: LOCK_AFTER },
  };
  const changed = options.changed ?? [
    { filename: "package.json" },
    { filename: "bun.lock" },
  ];
  const deps: CollectDeps = {
    getPr: async () => {
      const index = calls.getPr;
      calls.getPr += 1;
      if (options.getPr !== undefined) return options.getPr();
      const pr = prs[Math.min(index, prs.length - 1)];
      if (pr === undefined) throw new Error("no pull request in the setup");
      return pr;
    },
    getBranchSha: async (_owner, _repo, branch) => {
      const index = calls.branch.length;
      calls.branch.push(branch);
      if (options.branchSha !== undefined) return options.branchSha();
      const shas = options.baseShas ?? [BASE_SHA];
      return shas[Math.min(index, shas.length - 1)] ?? BASE_SHA;
    },
    compareCommits: async (_owner, _repo, baseSha, headSha) => {
      calls.compare.push({ baseSha, headSha });
      if (options.compare !== undefined) return options.compare();
      return {
        mergeBaseSha: MERGE_BASE,
        files: changed.map((file) => ({
          filename: file.filename,
          previousFilename: file.previousFilename ?? null,
          status: "modified",
        })),
        commits: options.commits ?? [DEPENDABOT_COMMIT],
      };
    },
    getFileAtRef: async (_owner, _repo, path, ref) => {
      calls.files.push({ path, ref });
      if (options.getFile !== undefined) return options.getFile(path, ref);
      const entry = contents[path];
      if (entry === undefined) return null;
      return ref === MERGE_BASE ? entry.before : entry.after;
    },
    listPrChecks: async (_owner, _repo, headSha) => {
      calls.checks.push(headSha);
      return (
        options.checks ??
        REQUIRED_CHECKS.map((name) => ({
          name,
          appId: GITHUB_ACTIONS_APP_ID,
          conclusion: "success",
        }))
      );
    },
    getRegistryFacts: async (name, from, to) => {
      calls.registry.push({ name, from, to });
      if (options.registry !== undefined) return options.registry();
      return facts();
    },
    now: () => NOW,
    minPublishedDays: 7,
    expectedBaseRef: "main",
  };
  return { deps, calls };
}

async function readyInput(options: Setup = {}) {
  const result = await collectGateInput(setup(options).deps, PR_REF);
  if (result.kind !== "ready") {
    throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  }
  return result.input;
}

describe("collectGateInput", () => {
  test("builds an input that the gate accepts", async () => {
    const input = await readyInput();

    expect(evaluateGate(input)).toEqual({ ok: true });
  });

  test("returns the head sha and the merge base sha it fixed", async () => {
    const result = await collectGateInput(setup().deps, PR_REF);

    expect(result).toMatchObject({
      kind: "ready",
      headSha: HEAD,
      mergeBaseSha: MERGE_BASE,
    });
  });

  test("derives the target and the update kind from the lockfile", async () => {
    const input = await readyInput();

    expect([input.target, input.update]).toEqual([
      { name: "left-pad", to: "1.3.1" },
      "patch",
    ]);
  });

  test("passes the required checks, the clock, and the minimum days through", async () => {
    const input = await readyInput();

    expect([input.requiredChecks, input.nowMs, input.minPublishedDays]).toEqual(
      [REQUIRED_CHECKS, NOW, 7],
    );
  });

  test("takes the install scripts and the publish date from the registry", async () => {
    const input = await readyInput({
      registry: async () =>
        facts({
          publishedAtIso: "2026-09-01T00:00:00.000Z",
          installScripts: { before: {}, after: { postinstall: "x" } },
        }),
    });

    expect([input.publishedAtIso, input.installScripts]).toEqual([
      "2026-09-01T00:00:00.000Z",
      { before: {}, after: { postinstall: "x" } },
    ]);
  });

  test("returns the version before the update", async () => {
    const result = await collectGateInput(setup().deps, PR_REF);

    expect(result.kind === "ready" ? result.from : null).toBe("1.3.0");
  });

  test("returns the registry metadata for the impact assessment", async () => {
    const result = await collectGateInput(
      setup({
        registry: async () => facts({ registryMetadata: "package: left-pad" }),
      }).deps,
      PR_REF,
    );

    expect(result.kind === "ready" ? result.registryMetadata : null).toBe(
      "package: left-pad",
    );
  });

  test("has no unverified inputs when the registry metadata is complete", async () => {
    const result = await collectGateInput(setup().deps, PR_REF);

    expect(result).toMatchObject({ kind: "ready", unverifiedInputs: [] });
  });

  test("marks the registry metadata as unverified when an item is missing", async () => {
    const result = await collectGateInput(
      setup({
        registry: async () => facts({ missing: ["after publisher"] }),
      }).deps,
      PR_REF,
    );

    expect(result).toMatchObject({
      kind: "ready",
      unverifiedInputs: ["registry metadata"],
    });
  });

  test("passes the registry fact as is", async () => {
    const input = await readyInput();

    expect(input.registry).toEqual({
      name: "left-pad",
      version: "1.3.1",
      integrity: INTEGRITY_B,
    });
  });

  test("passes a null registry fact when the registry has no integrity", async () => {
    const input = await readyInput({
      registry: async () => facts({ integrity: null }),
    });

    expect(input.registry).toBeNull();
  });

  test("asks the registry about the target and its previous version", async () => {
    const { deps, calls } = setup();

    await collectGateInput(deps, PR_REF);

    expect(calls.registry).toEqual([
      { name: "left-pad", from: "1.3.0", to: "1.3.1" },
    ]);
  });

  test("compares the base sha with the fixed head sha", async () => {
    const { deps, calls } = setup();

    await collectGateInput(deps, PR_REF);

    expect(calls.compare).toEqual([{ baseSha: BASE_SHA, headSha: HEAD }]);
  });

  test("reads the sha of the base branch before and after collecting", async () => {
    const { deps, calls } = setup();

    await collectGateInput(deps, PR_REF);

    expect(calls.branch).toEqual(["main", "main"]);
  });

  test("returns the base ref and the base sha it fixed", async () => {
    const result = await collectGateInput(setup().deps, PR_REF);

    expect(result).toMatchObject({
      kind: "ready",
      baseRef: "main",
      baseSha: BASE_SHA,
    });
  });

  test("waits when the base branch moved while collecting", async () => {
    const result = await collectGateInput(
      setup({ baseShas: [BASE_SHA, OTHER_BASE_SHA] }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits instead of stopping when the base branch moved and the target cannot be derived", async () => {
    const result = await collectGateInput(
      setup({
        baseShas: [BASE_SHA, OTHER_BASE_SHA],
        contents: { "bun.lock": { before: LOCK_BEFORE, after: LOCK_BEFORE } },
        changed: [{ filename: "bun.lock" }],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("does not read the base branch again when the head moved", async () => {
    const { deps, calls } = setup({
      prs: [pullRequest(), pullRequest({ headSha: OTHER_HEAD })],
    });

    await collectGateInput(deps, PR_REF);

    expect(calls.branch).toEqual(["main"]);
  });

  test("reads the checks of the fixed head sha", async () => {
    const { deps, calls } = setup();

    await collectGateInput(deps, PR_REF);

    expect(calls.checks).toEqual([HEAD]);
  });

  test("reads files before at the merge base and after at the head", async () => {
    const { deps, calls } = setup();

    await collectGateInput(deps, PR_REF);

    expect(calls.files).toEqual(
      expect.arrayContaining([
        { path: "bun.lock", ref: MERGE_BASE },
        { path: "bun.lock", ref: HEAD },
      ]),
    );
  });

  test("passes the contents of the changed allowed files", async () => {
    const input = await readyInput();

    expect(input.files).toEqual([
      { path: "package.json", before: MANIFEST_BEFORE, after: MANIFEST_AFTER },
      { path: "bun.lock", before: LOCK_BEFORE, after: LOCK_AFTER },
    ]);
  });

  test("passes null for a file that does not exist at one side", async () => {
    const input = await readyInput({
      contents: {
        "package.json": { before: MANIFEST_BEFORE, after: MANIFEST_AFTER },
        "bun.lock": { before: LOCK_BEFORE, after: LOCK_AFTER },
        "console/package.json": { before: null, after: "{}" },
      },
      changed: [
        { filename: "package.json" },
        { filename: "bun.lock" },
        { filename: "console/package.json" },
      ],
    });

    expect(
      input.files.find((file) => file.path === "console/package.json"),
    ).toEqual({ path: "console/package.json", before: null, after: "{}" });
  });

  test("keeps a path outside the allowed set in the changed paths", async () => {
    const input = await readyInput({
      changed: [
        { filename: "bun.lock" },
        { filename: ".github/workflows/ci.yml" },
      ],
    });

    expect(input.changedPaths).toEqual([
      "bun.lock",
      ".github/workflows/ci.yml",
    ]);
  });

  test("does not read the contents of a path outside the allowed set", async () => {
    const { deps, calls } = setup({
      changed: [
        { filename: "bun.lock" },
        { filename: ".github/workflows/ci.yml" },
      ],
    });

    await collectGateInput(deps, PR_REF);

    expect(calls.files.map((file) => file.path)).not.toContain(
      ".github/workflows/ci.yml",
    );
  });

  test("does not read an allowed path that did not change", async () => {
    const { deps, calls } = setup({ changed: [{ filename: "bun.lock" }] });

    await collectGateInput(deps, PR_REF);

    expect(calls.files.map((file) => file.path)).not.toContain("package.json");
  });

  test("puts the previous filename of a rename in the changed paths", async () => {
    const input = await readyInput({
      changed: [
        { filename: "bun.lock" },
        {
          filename: "docs/a.yml",
          previousFilename: ".github/workflows/a.yml",
        },
      ],
    });

    expect(input.changedPaths).toEqual([
      "bun.lock",
      "docs/a.yml",
      ".github/workflows/a.yml",
    ]);
  });

  test("reads an allowed file that was renamed away as a deleted file", async () => {
    const input = await readyInput({
      contents: {
        "bun.lock": { before: LOCK_BEFORE, after: LOCK_AFTER },
        "package.json": { before: MANIFEST_BEFORE, after: null },
      },
      changed: [
        { filename: "bun.lock" },
        { filename: "docs/pkg.json", previousFilename: "package.json" },
      ],
    });

    expect(input.files.find((file) => file.path === "package.json")).toEqual({
      path: "package.json",
      before: MANIFEST_BEFORE,
      after: null,
    });
  });

  test("lists a path once when it appears as both a file and a previous name", async () => {
    const input = await readyInput({
      changed: [
        { filename: "bun.lock" },
        { filename: "bun.lock", previousFilename: "bun.lock" },
      ],
    });

    expect(input.changedPaths).toEqual(["bun.lock"]);
  });

  test("takes the commits from the comparison", async () => {
    const input = await readyInput();

    expect(input.commits).toEqual([DEPENDABOT_COMMIT]);
  });

  test("passes the pull request facts through", async () => {
    const input = await readyInput();

    expect([
      input.authorLogin,
      input.authorType,
      input.headRepoFullName,
      input.baseRepoFullName,
    ]).toEqual(["dependabot[bot]", "Bot", "acme/widgets", "acme/widgets"]);
  });

  test("turns a null author type into an empty string", async () => {
    const input = await readyInput({
      prs: [
        pullRequest({ authorType: null }),
        pullRequest({ authorType: null }),
      ],
    });

    expect(input.authorType).toBe("");
  });

  test("turns a null head repository into an empty string", async () => {
    const input = await readyInput({
      prs: [
        pullRequest({ headRepoFullName: null }),
        pullRequest({ headRepoFullName: null }),
      ],
    });

    expect(input.headRepoFullName).toBe("");
  });

  test("keeps mergeable null when GitHub has not computed it", async () => {
    const input = await readyInput({
      prs: [pullRequest({ mergeable: null }), pullRequest({ mergeable: null })],
    });

    expect(input.mergeable).toBeNull();
  });

  test("does not take the target from the title or the branch name", async () => {
    const input = await readyInput({
      prs: [
        pullRequest({
          title: "Bump evil from 1.0.0 to 9.9.9",
          headRef: "evil",
        }),
        pullRequest({
          title: "Bump evil from 1.0.0 to 9.9.9",
          headRef: "evil",
        }),
      ],
    });

    expect(input.target.name).toBe("left-pad");
  });

  test("waits when the head moved while collecting", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest(), pullRequest({ headSha: OTHER_HEAD })] })
        .deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits when the base ref changed while collecting", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest(), pullRequest({ baseRef: "release" })] }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits when the head repository changed while collecting", async () => {
    const result = await collectGateInput(
      setup({
        prs: [pullRequest(), pullRequest({ headRepoFullName: "evil/widgets" })],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits when the author changed while collecting", async () => {
    const result = await collectGateInput(
      setup({
        prs: [pullRequest(), pullRequest({ authorLogin: "someone" })],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits when the author type changed while collecting", async () => {
    const result = await collectGateInput(
      setup({
        prs: [pullRequest(), pullRequest({ authorType: "User" })],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits when the base repository changed while collecting", async () => {
    const result = await collectGateInput(
      setup({
        prs: [pullRequest(), pullRequest({ baseRepoFullName: "acme/other" })],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits instead of stopping when the head moved and the target cannot be derived", async () => {
    const result = await collectGateInput(
      setup({
        prs: [pullRequest(), pullRequest({ headSha: OTHER_HEAD })],
        contents: {
          "bun.lock": { before: LOCK_BEFORE, after: LOCK_BEFORE },
        },
        changed: [{ filename: "bun.lock" }],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("reports closed when the pull request was closed while collecting", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest(), pullRequest({ state: "closed" })] }).deps,
      PR_REF,
    );

    expect(result).toEqual({ kind: "closed", reason: NOT_OPEN });
  });

  test("reports closed when the pull request is closed", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest({ state: "closed" })] }).deps,
      PR_REF,
    );

    expect(result).toEqual({ kind: "closed", reason: NOT_OPEN });
  });

  test("reports closed when the pull request is merged", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest({ state: "closed", merged: true })] }).deps,
      PR_REF,
    );

    expect(result).toEqual({ kind: "closed", reason: NOT_OPEN });
  });

  test("reports closed instead of waiting when the pull request closed and the head moved", async () => {
    const result = await collectGateInput(
      setup({
        prs: [
          pullRequest(),
          pullRequest({ state: "closed", headSha: OTHER_HEAD }),
        ],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("closed");
  });

  test("states that a pull request is not open", () => {
    expect(NOT_OPEN).toBe("pull request is not open");
  });

  test("needs a human when the base ref is not the expected branch", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest({ baseRef: "release" })] }).deps,
      PR_REF,
    );

    expect(result).toEqual({
      kind: "needs_human",
      reason: "base branch is not the expected one",
    });
  });

  test("needs a human when the base ref is empty", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest({ baseRef: "" })] }).deps,
      PR_REF,
    );

    expect(result).toEqual({
      kind: "needs_human",
      reason: "base branch is not the expected one",
    });
  });

  test("does not read the base branch for an unexpected base ref", async () => {
    const { deps, calls } = setup({
      prs: [pullRequest({ baseRef: "release" })],
    });

    await collectGateInput(deps, PR_REF);

    expect(calls.branch).toEqual([]);
  });

  test("waits when the base ref changed to an unexpected branch while collecting", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest(), pullRequest({ baseRef: "release" })] }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("needs a human when the head sha is not a full sha", async () => {
    const result = await collectGateInput(
      setup({ prs: [pullRequest({ headSha: "abc123" })] }).deps,
      PR_REF,
    );

    expect(result).toEqual({
      kind: "needs_human",
      reason: "head sha is not a full sha",
    });
  });

  test("does not call the comparison for a closed pull request", async () => {
    const { deps, calls } = setup({ prs: [pullRequest({ state: "closed" })] });

    await collectGateInput(deps, PR_REF);

    expect(calls.compare).toEqual([]);
  });

  test("needs a human when more than one package changed", async () => {
    const after = lockText({ "left-pad": "1.3.1", other: "2.0.1" }, [
      { key: "left-pad", id: "left-pad@1.3.1", integrity: INTEGRITY_B },
      { key: "other", id: "other@2.0.1", integrity: INTEGRITY_B },
    ]);

    const result = await collectGateInput(
      setup({
        contents: { "bun.lock": { before: LOCK_BEFORE, after } },
        changed: [{ filename: "bun.lock" }],
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });

  test("does not ask the registry when the target cannot be derived", async () => {
    const { deps, calls } = setup({
      contents: { "bun.lock": { before: LOCK_BEFORE, after: LOCK_BEFORE } },
      changed: [{ filename: "bun.lock" }],
    });

    await collectGateInput(deps, PR_REF);

    expect(calls.registry).toEqual([]);
  });

  test("waits when the registry is unavailable", async () => {
    const result = await collectGateInput(
      setup({
        registry: async () => {
          throw new RegistryUnavailableError("down", new Error("boom"));
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("needs a human when the registry rejects the request", async () => {
    const result = await collectGateInput(
      setup({
        registry: async () => {
          throw new RegistryHttpError(404);
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when the registry response is malformed", async () => {
    const result = await collectGateInput(
      setup({
        registry: async () => {
          throw new RegistryResponseError("packument is not an object");
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });

  test("rethrows a plain Error from the registry as a bug", async () => {
    await expect(
      collectGateInput(
        setup({
          registry: async () => {
            throw new Error("bug");
          },
        }).deps,
        PR_REF,
      ),
    ).rejects.toThrow("bug");
  });

  test("rethrows an unexpected error from the registry", async () => {
    await expect(
      collectGateInput(
        setup({
          registry: async () => {
            throw new TypeError("bug");
          },
        }).deps,
        PR_REF,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("waits on a GitHub rate limit", async () => {
    const result = await collectGateInput(
      setup({
        compare: async () => {
          throw new GitHubRateLimitError(
            "repos/acme/widgets/compare",
            1000,
            true,
          );
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits on a GitHub server error", async () => {
    const result = await collectGateInput(
      setup({
        compare: async () => {
          throw new GitHubHttpError("compare failed with HTTP 502", 502);
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("waits when GitHub gave no response", async () => {
    const result = await collectGateInput(
      setup({
        getPr: async () => {
          throw new GitHubHttpError("no response", 0);
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("rethrows a GitHub client error", async () => {
    await expect(
      collectGateInput(
        setup({
          getPr: async () => {
            throw new GitHubHttpError("not found", 404);
          },
        }).deps,
        PR_REF,
      ),
    ).rejects.toBeInstanceOf(GitHubHttpError);
  });

  test("needs a human when a pull request response has an unexpected shape", async () => {
    const result = await collectGateInput(
      setup({
        getPr: async () => {
          throw new GitHubResponseError("unexpected response shape");
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when pagination exceeds its limit", async () => {
    const result = await collectGateInput(
      setup({
        compare: async () => {
          throw new GitHubPaginationLimitError(4);
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });

  test("waits when GitHub fails with a server error while reading a file", async () => {
    const result = await collectGateInput(
      setup({
        getFile: async () => {
          throw new GitHubHttpError("file failed with HTTP 503", 503);
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("wait");
  });

  test("needs a human when the comparison is truncated", async () => {
    const result = await collectGateInput(
      setup({
        compare: async () => {
          throw new GitHubResponseError("the file list may be truncated");
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when a file cannot be read", async () => {
    const result = await collectGateInput(
      setup({
        getFile: async () => {
          throw new GitHubResponseError("file is too large");
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });

  test("needs a human when GitHub refuses a file", async () => {
    const result = await collectGateInput(
      setup({
        getFile: async () => {
          throw new GitHubHttpError("forbidden", 403);
        },
      }).deps,
      PR_REF,
    );

    expect(result.kind).toBe("needs_human");
  });
});

describe("LOCKFILE_PATHS", () => {
  test("is frozen so that the paths read as lockfiles cannot be replaced", () => {
    expect(Object.isFrozen(LOCKFILE_PATHS)).toBe(true);
  });

  test("an element cannot be appended", () => {
    expect(Reflect.set(LOCKFILE_PATHS, LOCKFILE_PATHS.length, "x")).toBe(false);
  });
});
