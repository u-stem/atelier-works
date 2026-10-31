import { describe, expect, test } from "bun:test";
import {
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
} from "../../f/factory/lib/doc_tree_hash.ts";
import {
  type BuildImplementContextInput,
  buildImplementContext,
  type ResolveImplementSpecDeps,
  requirementsGateReason,
  resolveImplementSpec,
} from "../../f/factory/steps/implement_prepare.ts";

const BASE = "b".repeat(40);
const INPUT: BuildImplementContextInput = {
  workItem: {
    id: 3,
    owner: "acme",
    repo: "widgets",
    attempt: 2,
    pr_url: null,
    title: "CSV出力",
    body: "CSVで出力したい",
    issue_url: "https://github.com/acme/widgets/issues/7",
    profile: "standard",
  },
  issueNumber: 7,
  issue: {
    title: "CSV出力",
    body: "CSVで出力したい",
    htmlUrl: "https://github.com/acme/widgets/issues/7",
  },
  draft: {
    attempt: 2,
    markdown: "# 要件定義",
    diagrams: [],
    doc_dir:
      "/var/lib/factory/requirements/acme/widgets/issue-7/wi-3/attempt-2",
    doc_hash: "c".repeat(64),
  },
  branch: "factory/issue-7-wi-3",
  baseBranch: "main",
  baseSha: BASE,
  repoDir: "/workspaces/acme/widgets/main",
  worktreeDir: "/workspaces/acme/widgets/factory-issue-7-wi-3",
  factoryCloneDir: "/workspaces/factory/atelier-works",
  expectedHeadSha: BASE,
  worktreeGitPointer:
    "gitdir: /workspaces/acme/widgets/main/.git/worktrees/factory-issue-7-wi-3\n",
  existingPr: null,
  designMarkdown: null,
  startedAt: 1_000,
  config: {
    windmill_public_url: "http://127.0.0.1:8080",
    factory_repo: "https://github.com/acme/atelier-works",
    implement_flow_timeout_sec: 14_400,
  },
};

describe("buildImplementContext and the approved design", () => {
  test("carries no design when the design stage is not used", () => {
    expect(buildImplementContext(INPUT).design_markdown).toBeNull();
  });

  test("carries the design the gate handed over", () => {
    expect(
      buildImplementContext({ ...INPUT, designMarkdown: "# 設計" })
        .design_markdown,
    ).toBe("# 設計");
  });
});

describe("buildImplementContext", () => {
  test("has no previous implementation on a fresh branch without a PR", () => {
    expect(buildImplementContext(INPUT).has_previous_implementation).toBe(
      false,
    );
  });

  test("has a previous implementation when an open PR uses the branch", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        existingPr: {
          number: 9,
          htmlUrl: "https://github.com/acme/widgets/pull/9",
        },
      }).has_previous_implementation,
    ).toBe(true);
  });

  test("has a previous implementation when the work item recorded a PR url", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: {
          ...INPUT.workItem,
          pr_url: "https://github.com/acme/widgets/pull/9",
        },
      }).has_previous_implementation,
    ).toBe(true);
  });

  test("has a previous implementation when the branch is ahead of the base", () => {
    expect(
      buildImplementContext({ ...INPUT, expectedHeadSha: "e".repeat(40) })
        .has_previous_implementation,
    ).toBe(true);
  });

  test("carries the base sha", () => {
    expect(buildImplementContext(INPUT).base_sha).toBe(BASE);
  });

  test("links the approved requirements in the Console", () => {
    expect(buildImplementContext(INPUT).requirements_console_url).toBe(
      "http://127.0.0.1:8080/console/items/3/requirements?attempt=2",
    );
  });

  test("sets the flow deadline from the start time", () => {
    expect(buildImplementContext(INPUT).deadline_at).toBe(14_401_000);
  });

  test("marks a repo that is not the factory repo", () => {
    expect(buildImplementContext(INPUT).is_factory_repo).toBe(false);
  });

  test("marks the factory repo when factory_repo names the same repo", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        config: {
          ...INPUT.config,
          factory_repo: "https://github.com/acme/widgets",
        },
      }).is_factory_repo,
    ).toBe(true);
  });

  test("carries an existing PR's number", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        existingPr: {
          number: 9,
          htmlUrl: "https://github.com/acme/widgets/pull/9",
        },
      }).existing_pr_number,
    ).toBe(9);
  });

  test("carries an existing PR's url", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        existingPr: {
          number: 9,
          htmlUrl: "https://github.com/acme/widgets/pull/9",
        },
      }).existing_pr_url,
    ).toBe("https://github.com/acme/widgets/pull/9");
  });

  test("carries the worktree's .git pointer", () => {
    expect(buildImplementContext(INPUT).worktree_git_pointer).toBe(
      "gitdir: /workspaces/acme/widgets/main/.git/worktrees/factory-issue-7-wi-3\n",
    );
  });

  test("uses the work item's attempt", () => {
    expect(buildImplementContext(INPUT).attempt).toBe(2);
  });

  test("uses the intake snapshot's title, not the live Issue's", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        issue: { ...INPUT.issue, title: "書き換えた題名" },
      }).issue_title,
    ).toBe("CSV出力");
  });

  test("uses the intake snapshot's body, not the live Issue's", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        issue: { ...INPUT.issue, body: "承認後に足した指示" },
      }).issue_body,
    ).toBe("CSVで出力したい");
  });

  test("uses an empty title when the snapshot has none", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: { ...INPUT.workItem, title: null },
      }).issue_title,
    ).toBe("");
  });

  test("links the Issue URL recorded at intake, not the live one", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        issue: {
          ...INPUT.issue,
          htmlUrl: "https://github.com/acme/moved/issues/1",
        },
      }).issue_url,
    ).toBe("https://github.com/acme/widgets/issues/7");
  });

  test("falls back to the live Issue URL when the snapshot has none", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: { ...INPUT.workItem, issue_url: null },
        issue: {
          ...INPUT.issue,
          htmlUrl: "https://github.com/acme/moved/issues/1",
        },
      }).issue_url,
    ).toBe("https://github.com/acme/moved/issues/1");
  });

  test("falls back to the live Issue URL when the snapshot is empty", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        workItem: { ...INPUT.workItem, issue_url: "" },
        issue: {
          ...INPUT.issue,
          htmlUrl: "https://github.com/acme/moved/issues/1",
        },
      }).issue_url,
    ).toBe("https://github.com/acme/moved/issues/1");
  });

  test("carries the baseline hash of the approved requirements", () => {
    expect(buildImplementContext(INPUT).requirements_doc_hash).toBe(
      "c".repeat(64),
    );
  });

  test("carries a missing baseline as null", () => {
    expect(
      buildImplementContext({
        ...INPUT,
        draft: { ...INPUT.draft, doc_hash: null },
      }).requirements_doc_hash,
    ).toBeNull();
  });
});

describe("buildImplementContext with the requirements as the specification", () => {
  test("marks the specification as the requirements", () => {
    expect(buildImplementContext(INPUT).spec_kind).toBe("requirements");
  });

  test("carries the profile of the work item", () => {
    expect(buildImplementContext(INPUT).profile).toBe("standard");
  });

  test("carries the approved markdown", () => {
    expect(buildImplementContext(INPUT).requirements_markdown).toBe(
      "# 要件定義",
    );
  });
});

describe("buildImplementContext with the issue as the specification", () => {
  const ISSUE_INPUT: BuildImplementContextInput = {
    ...INPUT,
    workItem: { ...INPUT.workItem, profile: "direct" },
    draft: null,
  };

  test("marks the specification as the issue", () => {
    expect(buildImplementContext(ISSUE_INPUT).spec_kind).toBe("issue");
  });

  test("carries the profile of the work item", () => {
    expect(buildImplementContext(ISSUE_INPUT).profile).toBe("direct");
  });

  test("carries no requirements markdown", () => {
    expect(buildImplementContext(ISSUE_INPUT).requirements_markdown).toBeNull();
  });

  test("carries no diagrams", () => {
    expect(buildImplementContext(ISSUE_INPUT).requirements_diagrams).toEqual(
      [],
    );
  });

  test("carries no requirements directory", () => {
    expect(buildImplementContext(ISSUE_INPUT).requirements_doc_dir).toBeNull();
  });

  test("carries no baseline hash", () => {
    expect(buildImplementContext(ISSUE_INPUT).requirements_doc_hash).toBeNull();
  });

  test("carries no link to the requirements in the Console", () => {
    expect(
      buildImplementContext(ISSUE_INPUT).requirements_console_url,
    ).toBeNull();
  });

  test("keeps the body recorded at intake as the specification", () => {
    expect(
      buildImplementContext({
        ...ISSUE_INPUT,
        issue: { ...INPUT.issue, body: "承認なしに書き換えた本文" },
      }).issue_body,
    ).toBe("CSVで出力したい");
  });

  test("keeps the title recorded at intake as the specification", () => {
    expect(
      buildImplementContext({
        ...ISSUE_INPUT,
        issue: { ...INPUT.issue, title: "書き換えた題名" },
      }).issue_title,
    ).toBe("CSV出力");
  });

  test("carries no design", () => {
    expect(buildImplementContext(ISSUE_INPUT).design_markdown).toBeNull();
  });
});

describe("resolveImplementSpec", () => {
  const DIR =
    "/var/lib/factory/requirements/acme/widgets/issue-7/wi-3/attempt-2";
  const HASH = "d".repeat(64);
  const APPROVED = { status: "approved", attempt: 2, draft_id: 11 };
  const DRAFT = {
    id: 11,
    work_item_id: 3,
    attempt: 2,
    summary: "要約",
    markdown: "# 要件定義",
    diagrams: [],
    open_questions: [],
    doc_dir: DIR,
    doc_hash: HASH,
    created_at: new Date(0),
  };
  const WORK_ITEM = {
    id: 3,
    attempt: 2,
    design_attempt: 0,
    profile: "standard",
  };

  function setup(overrides: Partial<ResolveImplementSpecDeps> = {}): {
    deps: ResolveImplementSpecDeps;
    calls: string[];
  } {
    const calls: string[] = [];
    const deps: ResolveImplementSpecDeps = {
      latestRequirementsApproval: async () => {
        calls.push("latestRequirementsApproval");
        return APPROVED;
      },
      getRequirementDraft: async () => {
        calls.push("getRequirementDraft");
        return DRAFT;
      },
      hashTree: async () => {
        calls.push("hashTree");
        return HASH;
      },
      warn: () => {
        calls.push("warn");
      },
      designGate: {
        latestDesignApproval: async () => {
          calls.push("latestDesignApproval");
          return null;
        },
        getDesignDraft: async () => {
          calls.push("getDesignDraft");
          return null;
        },
        warn: () => {
          calls.push("designWarn");
        },
      },
      ...overrides,
    };
    return { deps, calls };
  }

  function resolve(
    deps: ResolveImplementSpecDeps,
    input: { requirementsRequired: boolean; designEnabled?: boolean },
  ) {
    return resolveImplementSpec(
      {
        workItem: WORK_ITEM,
        requirementsRequired: input.requirementsRequired,
        designEnabled: input.designEnabled ?? false,
      },
      deps,
    );
  }

  test("takes the issue as the specification when the requirements are not required", async () => {
    const { deps } = setup();
    expect(await resolve(deps, { requirementsRequired: false })).toEqual({
      kind: "issue",
    });
  });

  test("reads no approval and no draft when the requirements are not required", async () => {
    const { deps, calls } = setup();
    await resolve(deps, { requirementsRequired: false });
    expect(calls).toEqual([]);
  });

  test("skips the design gate when the requirements are not required, even with the design stage on", async () => {
    const { deps, calls } = setup();
    await resolve(deps, { requirementsRequired: false, designEnabled: true });
    expect(calls).toEqual([]);
  });

  test("stops when no requirements were approved", async () => {
    const { deps } = setup({ latestRequirementsApproval: async () => null });
    expect(await resolve(deps, { requirementsRequired: true })).toEqual({
      kind: "stop",
      reason: "no approved requirements for attempt 2",
    });
  });

  test("stops when the approval is for another attempt", async () => {
    const { deps } = setup({
      latestRequirementsApproval: async () => ({ ...APPROVED, attempt: 1 }),
    });
    expect(await resolve(deps, { requirementsRequired: true })).toEqual({
      kind: "stop",
      reason: "no approved requirements for attempt 2",
    });
  });

  test("stops when the newest approval was rejected", async () => {
    const { deps } = setup({
      latestRequirementsApproval: async () => ({
        ...APPROVED,
        status: "rejected",
      }),
    });
    expect(await resolve(deps, { requirementsRequired: true })).toEqual({
      kind: "stop",
      reason: "no approved requirements for attempt 2",
    });
  });

  test("stops when the draft the approval points to is gone", async () => {
    const { deps } = setup({ getRequirementDraft: async () => null });
    expect(await resolve(deps, { requirementsRequired: true })).toEqual({
      kind: "stop",
      reason: "no approved requirements for attempt 2",
    });
  });

  test("stops when the approved directory was modified", async () => {
    const { deps } = setup({ hashTree: async () => "e".repeat(64) });
    expect(await resolve(deps, { requirementsRequired: true })).toEqual({
      kind: "stop",
      reason: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    });
  });

  test("stops when the approved directory is gone", async () => {
    const { deps } = setup({ hashTree: async () => null });
    expect(await resolve(deps, { requirementsRequired: true })).toEqual({
      kind: "stop",
      reason: REQUIREMENTS_DIR_MISSING_REASON,
    });
  });

  test("stops at the design gate when the design stage is on and no design was approved", async () => {
    const { deps } = setup();
    expect(
      await resolve(deps, { requirementsRequired: true, designEnabled: true }),
    ).toEqual({
      kind: "stop",
      reason: "no approved design for design attempt 0",
    });
  });

  test("takes the approved draft as the specification", async () => {
    const { deps } = setup();
    expect(await resolve(deps, { requirementsRequired: true })).toEqual({
      kind: "requirements",
      draft: DRAFT,
      designMarkdown: null,
    });
  });

  test("hashes the approved directory", async () => {
    const { deps, calls } = setup();
    await resolve(deps, { requirementsRequired: true });
    expect(calls).toContain("hashTree");
  });
});

describe("requirementsGateReason", () => {
  const DIR =
    "/var/lib/factory/requirements/acme/widgets/issue-7/wi-3/attempt-2";
  const HASH = "d".repeat(64);

  function warnings() {
    const messages: string[] = [];
    return {
      messages,
      warn: (message: string) => {
        messages.push(message);
      },
    };
  }

  test("returns null when the directory matches the baseline", async () => {
    const w = warnings();
    expect(
      await requirementsGateReason(
        { doc_dir: DIR, doc_hash: HASH },
        async () => HASH,
        w.warn,
      ),
    ).toBeNull();
  });

  test("hashes the approved directory", async () => {
    const w = warnings();
    const hashed: string[] = [];
    await requirementsGateReason(
      { doc_dir: DIR, doc_hash: HASH },
      async (dir) => {
        hashed.push(dir);
        return HASH;
      },
      w.warn,
    );
    expect(hashed).toEqual([DIR]);
  });

  test("returns the reason for a modified directory", async () => {
    const w = warnings();
    expect(
      await requirementsGateReason(
        { doc_dir: DIR, doc_hash: HASH },
        async () => "e".repeat(64),
        w.warn,
      ),
    ).toBe(REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON);
  });

  test("returns the reason for a missing directory apart from a modified one", async () => {
    const w = warnings();
    expect(
      await requirementsGateReason(
        { doc_dir: DIR, doc_hash: HASH },
        async () => null,
        w.warn,
      ),
    ).toBe(REQUIREMENTS_DIR_MISSING_REASON);
  });

  test("skips the check and warns when there is no baseline", async () => {
    const w = warnings();
    const reason = await requirementsGateReason(
      { doc_dir: DIR, doc_hash: null },
      async () => "anything",
      w.warn,
    );
    expect([reason, w.messages]).toEqual([
      null,
      [
        "the approved requirements have no baseline hash; skipping the comparison",
      ],
    ]);
  });

  test("does not hash a draft that has no baseline", async () => {
    const w = warnings();
    const hashed: string[] = [];
    await requirementsGateReason(
      { doc_dir: DIR, doc_hash: null },
      async (dir) => {
        hashed.push(dir);
        return HASH;
      },
      w.warn,
    );
    expect(hashed).toEqual([]);
  });

  test("returns null without a warning when the draft has no directory", async () => {
    const w = warnings();
    const reason = await requirementsGateReason(
      { doc_dir: null, doc_hash: null },
      async () => HASH,
      w.warn,
    );
    expect([reason, w.messages]).toEqual([null, []]);
  });
});

// mainはWindmillとDBを直接使うので、関門の結線はソースの文面で固定する。
describe("the wiring of the requirements gate in implement_prepare main", () => {
  /** コメントを除いたソース。コメントに書いた呼び出しの名前を、順序の比較に混ぜないため。 */
  async function source(): Promise<string> {
    const text = await Bun.file(
      new URL("../../f/factory/steps/implement_prepare.ts", import.meta.url),
    ).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  /** `needle`がちょうど1回だけ出現するときにその位置を返す。0回か複数回なら-1を返す。 */
  function onlyIndex(text: string, needle: string): number {
    const first = text.indexOf(needle);
    if (first < 0) return -1;
    return text.indexOf(needle, first + needle.length) < 0 ? first : -1;
  }

  const GATE = "await requirementsGateReason(";

  test("hashes the approved directory with the real hash function", async () => {
    expect(await source()).toContain(
      "hashTree: (dir) => hashDirectoryTree(dir, realDirectoryIo),",
    );
  });

  test("stops for a person with the reason of the gate", async () => {
    expect(await source()).toContain(
      'if (untrusted !== null) return { kind: "stop", reason: untrusted };',
    );
  });

  test("calls the gate exactly once", async () => {
    expect(onlyIndex(await source(), GATE)).toBeGreaterThanOrEqual(0);
  });

  test("checks the gate before it looks at the branch", async () => {
    const text = await source();
    const gate = onlyIndex(text, GATE);
    const branch = onlyIndex(text, "await findOpenPullRequestByHead(");
    expect(gate >= 0 && branch >= 0 && gate < branch).toBe(true);
  });

  test("checks the gate before it prepares the worktree", async () => {
    const text = await source();
    const gate = onlyIndex(text, GATE);
    const worktree = onlyIndex(text, "await prepareImplementWorktree(");
    expect(gate >= 0 && worktree >= 0 && gate < worktree).toBe(true);
  });

  test("carries the baseline of the draft into the context", async () => {
    expect(await source()).toContain(
      "requirements_doc_hash: draft?.doc_hash ?? null,",
    );
  });

  test("resolves the specification before it looks at the branch", async () => {
    const text = await source();
    const spec = onlyIndex(text, "await resolveImplementSpec(");
    const branch = onlyIndex(text, "await findOpenPullRequestByHead(");
    expect(spec >= 0 && branch >= 0 && spec < branch).toBe(true);
  });

  test("resolves the specification before it prepares the worktree", async () => {
    const text = await source();
    const spec = onlyIndex(text, "await resolveImplementSpec(");
    const worktree = onlyIndex(text, "await prepareImplementWorktree(");
    expect(spec >= 0 && worktree >= 0 && spec < worktree).toBe(true);
  });

  test("asks the table of approvals whether the requirements are required", async () => {
    expect(await source()).toMatch(
      /requirementsRequired: requiredApprovals\(workItem\.profile\)\.requirements,/,
    );
  });

  test("stops for a person with the reason of the specification", async () => {
    expect(await source()).toContain(
      'if (spec.kind === "stop") return stop("needs_human", spec.reason);',
    );
  });
});

// 設計の承認の判定の実体は`lib/approval_gate.ts`にある。ここには呼び出しと、止める1文だけを残す。
describe("the wiring of the design gate in implement_prepare main", () => {
  async function source(): Promise<string> {
    const text = await Bun.file(
      new URL("../../f/factory/steps/implement_prepare.ts", import.meta.url),
    ).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  const GATE = "await designGate(";

  /** `needle`がちょうど1回だけ出現するときにその位置を返す。0回か複数回なら-1を返す。 */
  function onlyIndex(text: string, needle: string): number {
    const first = text.indexOf(needle);
    if (first < 0) return -1;
    return text.indexOf(needle, first + needle.length) < 0 ? first : -1;
  }

  test("calls the design gate exactly once", async () => {
    expect(onlyIndex(await source(), GATE)).toBeGreaterThanOrEqual(0);
  });

  test("tells the gate whether the design is enabled", async () => {
    expect(await source()).toContain("designEnabled: config.design_enabled,");
  });

  test("hands the gate the work item and the requirements approval", async () => {
    expect(await source()).toMatch(
      /await designGate\(\s*\{[^}]*workItem,[^}]*requirementsApproval: approval,/,
    );
  });

  test("reads the design approval and the design draft from the database", async () => {
    expect(await source()).toMatch(
      /await designGate\([\s\S]*?latestDesignApproval[\s\S]*?getDesignDraft/,
    );
  });

  test("stops for a person with the reason of the gate", async () => {
    expect(await source()).toContain(
      'if (gate.kind === "stop") return { kind: "stop", reason: gate.reason };',
    );
  });

  test("checks the design gate after the gate of the requirements", async () => {
    const text = await source();
    const design = onlyIndex(text, GATE);
    const requirements = onlyIndex(text, "await requirementsGateReason(");
    expect(design >= 0 && requirements >= 0 && requirements < design).toBe(
      true,
    );
  });

  test("checks the design gate before it looks at the branch", async () => {
    const text = await source();
    const design = onlyIndex(text, GATE);
    const branch = onlyIndex(text, "await findOpenPullRequestByHead(");
    expect(design >= 0 && branch >= 0 && design < branch).toBe(true);
  });

  test("checks the design gate before it prepares the worktree", async () => {
    const text = await source();
    const design = onlyIndex(text, GATE);
    const worktree = onlyIndex(text, "await prepareImplementWorktree(");
    expect(design >= 0 && worktree >= 0 && design < worktree).toBe(true);
  });

  test("hands the context the markdown the gate passed", async () => {
    expect(await source()).toContain(
      'designMarkdown: gate.kind === "pass" ? gate.markdown : null,',
    );
  });

  test("logs the change of the design with the logger of implement_prepare", async () => {
    expect(await source()).toMatch(
      /warn: \(message, fields\) =>\s*logger\("implement_prepare"\)\.warn\(message, fields\)/,
    );
  });

  test.each([
    "designApprovalVerdict(",
    "isDesignApprovedForAttempt(",
    "designGateReason(",
  ])("does not hold the body of the verdict (%s)", async (name) => {
    expect(await source()).not.toContain(name);
  });
});
