import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkUnrunnableReason } from "../../f/factory/lib/check_runner.ts";
import {
  CHECK_IMAGE_STALE_REASON,
  CheckImageStaleError,
  CheckRuntimeUnsafeError,
} from "../../f/factory/lib/check_sandbox.ts";
import type {
  ClaudeRunResult,
  RunClaudeResult,
} from "../../f/factory/lib/claude.ts";
import {
  REQUIREMENTS_DIR_MISSING_REASON,
  REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
} from "../../f/factory/lib/doc_tree_hash.ts";
import { IMPLEMENT_LEASE_LOST_REASON } from "../../f/factory/lib/implement_launch_support.ts";
import {
  buildImplementClaudeOptions,
  type ChangeInspection,
  type DocDirCopyDeps,
  type DocDirGuard,
  type DocEntryFs,
  deadlinePassedReason,
  defaultDocDirCopyDeps,
  docDirGuardFor,
  type FixRoundRequest,
  GITLEAKS_CHECK_NAME,
  IMPLEMENT_CLAUDE_ROUND_KINDS,
  IMPLEMENT_LOOP_EXITS,
  IMPLEMENT_OUTPUT_CONTRACT_NOTE,
  IMPLEMENT_OUTPUT_CONTRACT_NOTE_WITH_DESIGN_GAP,
  type ImplementClaudeRound,
  type ImplementClaudeRunInput,
  type ImplementClaudeRunRound,
  type ImplementContext,
  type ImplementLoopDeps,
  type ImplementLoopInput,
  implementContextHasDesign,
  implementContextSpecKind,
  implementOutputContractNote,
  implementPromptInput,
  isCopyableDocEntry,
  LEASE_LOST_ROUND,
  type LoopCheckResult,
  NO_CHANGES_CHECK_NAME,
  prepareImplementWorktree,
  RequirementsUntrustedError,
  ranClaude,
  runDocDirGuardedRound,
  runImplementClaudeRound,
  runImplementGenerateRound,
  runImplementVerifyLoop,
  scannedTreeChangedReason,
  toImplementClaudeRound,
  type WorktreePrepDeps,
  withReadOnlyDocDirCopy,
} from "../../f/factory/lib/implement_loop.ts";
import {
  IMPLEMENT_CHECK_SKIP_REASONS,
  type ImplementClaudeOutput,
} from "../../f/factory/lib/implement_support.ts";
import { modelChangesAfterFailure } from "../../f/factory/lib/model_policy.ts";
import {
  IMPLEMENT_SCHEMA,
  IMPLEMENT_SCHEMA_WITH_DESIGN_GAP,
} from "../../f/factory/lib/prompts.ts";
import type {
  AgentRunRecord,
  ImplementRoundRecord,
} from "../../f/factory/lib/types.ts";
import {
  type GitleaksResult,
  type WorktreeFingerprint,
  WorktreeGitPointerModifiedError,
} from "../../f/factory/lib/workspace.ts";

const MODEL_CONFIG = { model: "light-model", heavy_model: "heavy-model" };

const DONE: ImplementClaudeOutput = {
  outcome: "done",
  summary: "CSV出力を追加しました。",
  gap_report: null,
  commit_subject: "feat: CSV出力を追加する",
  commit_body: "",
  notes_for_reviewer: [],
};
const GAP: ImplementClaudeOutput = {
  outcome: "requirements_gap",
  summary: "FR-002を満たせません。",
  gap_report: "FR-002は既存APIに無い項目を前提としています。",
  commit_subject: "",
  commit_body: "",
  notes_for_reviewer: [],
};
const DESIGN_GAP: ImplementClaudeOutput = {
  outcome: "design_gap",
  summary: "設計書のAPIでは受入条件を満たせません。",
  gap_report: "設計書は既存APIに無い項目を前提としています。",
  commit_subject: "",
  commit_body: "",
  notes_for_reviewer: [],
};
const DOC_DIR =
  "/var/lib/factory/requirements/acme/widgets/issue-7/wi-3/attempt-1";
const CONTEXT: ImplementContext = {
  owner: "acme",
  repo: "widgets",
  issue_number: 7,
  issue_url: "https://github.com/acme/widgets/issues/7",
  issue_title: "CSV出力",
  issue_body: "CSVで出力したい",
  branch: "factory/issue-7-wi-3",
  base_branch: "main",
  base_sha: "b".repeat(40),
  repo_dir: "/workspaces/acme/widgets/main",
  worktree_dir: "/workspaces/acme/widgets/factory-issue-7-wi-3",
  factory_clone_dir: "/workspaces/factory/atelier-works",
  expected_head_sha: "b".repeat(40),
  existing_pr_number: null,
  existing_pr_url: null,
  has_previous_implementation: false,
  attempt: 1,
  spec_kind: "requirements",
  profile: "standard",
  requirements_markdown:
    "# 要件定義\n\n## 受入条件\n\n| ID | 条件 |\n| --- | --- |\n| AC-001 | CSVを出力できる |\n",
  requirements_diagrams: [],
  requirements_doc_dir: DOC_DIR,
  requirements_doc_hash: null,
  design_markdown: null,
  requirements_console_url:
    "http://127.0.0.1:8080/console/items/3/requirements",
  is_factory_repo: false,
  worktree_git_pointer:
    "gitdir: /workspaces/acme/widgets/main/.git/worktrees/factory-issue-7-wi-3\n",
  deadline_at: 1_900_000_000_000,
};
const AGENT_RUN: AgentRunRecord = {
  work_item_id: 3,
  stage: "implement",
  attempt: 1,
  model: "claude-test",
  claude_version: null,
  input_tokens: 1,
  output_tokens: 1,
  cache_read_tokens: 0,
  cost_usd: 1.25,
  num_turns: 3,
  duration_ms: 10,
  session_id: "s",
  exit_code: 0,
  error: null,
  model_usage: [],
};
const RAW: ClaudeRunResult = {
  type: "result",
  subtype: "success",
  isError: false,
  resultText: "",
  sessionId: "s",
  totalCostUsd: 1.25,
  numTurns: 3,
  durationMs: 10,
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
  modelUsage: [],
  structuredOutput: DONE,
};
function success(
  output: ImplementClaudeOutput,
): RunClaudeResult<ImplementClaudeOutput> {
  return {
    outcome: "success",
    structuredOutput: output,
    raw: RAW,
    agentRun: AGENT_RUN,
    retried: false,
  };
}
const FAILURE: RunClaudeResult<ImplementClaudeOutput> = {
  outcome: "failure",
  reason: "timeout",
  agentRun: { ...AGENT_RUN, cost_usd: null, error: "timed out" },
  detail: "claude -p timed out after 1000ms",
  retried: false,
};
const RUN_INPUT: ImplementClaudeRunInput = {
  run: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }),
  config: {
    model: "claude-test",
    heavy_model: "claude-test-heavy",
    implement_max_turns: 80,
    implement_max_budget_usd_per_run: 10,
    implement_timeout_sec: 3600,
  },
  workItemId: 3,
  attempt: 1,
  sonnetFailures: 0,
  hasDesign: false,
  stage: "implement",
  prompt: "prompt",
  systemPromptPath: "/tmp/system-prompt.md",
  worktreeDir: CONTEXT.worktree_dir,
  docDir: "/tmp/copy/requirements",
  oauthToken: "token",
  deadlineAt: 1_900_000_000_000,
  beforeRetry: async () => false,
};

describe("implementPromptInput", () => {
  test("maps the issue fields", () => {
    expect(implementPromptInput(CONTEXT, null).issue).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 7,
      title: "CSV出力",
      body: "CSVで出力したい",
      url: "https://github.com/acme/widgets/issues/7",
    });
  });

  test("inlines the approved markdown", () => {
    expect(implementPromptInput(CONTEXT, null).requirements.markdown).toBe(
      CONTEXT.requirements_markdown ?? "",
    );
  });

  test("names the doc_dir copy, not the original", () => {
    expect(
      implementPromptInput(CONTEXT, "/tmp/copy/requirements").requirements
        .doc_dir,
    ).toBe("/tmp/copy/requirements");
  });

  test("carries has_previous_implementation", () => {
    expect(
      implementPromptInput(
        { ...CONTEXT, has_previous_implementation: true },
        null,
      ).hasPreviousImplementation,
    ).toBe(true);
  });

  test("carries the approved design", () => {
    expect(
      implementPromptInput({ ...CONTEXT, design_markdown: "# 設計" }, null)
        .design,
    ).toBe("# 設計");
  });

  test("carries no design when the context has none", () => {
    expect(implementPromptInput(CONTEXT, null).design).toBeNull();
  });

  test("reads a context made before the field existed as having no design", () => {
    const { design_markdown: _omitted, ...older } = CONTEXT;
    expect(implementPromptInput(older, null).design).toBeNull();
  });

  test("hands Claude only the copy of the requirements directory even with a design", () => {
    expect(
      implementPromptInput(
        { ...CONTEXT, design_markdown: "# 設計" },
        "/tmp/copy/requirements",
      ).requirements.doc_dir,
    ).toBe("/tmp/copy/requirements");
  });
});

describe("implementContextSpecKind", () => {
  test("reads the kind the preparation recorded", () => {
    expect(implementContextSpecKind({ spec_kind: "issue" })).toBe("issue");
  });

  test("reads a context made before the field existed as the requirements", () => {
    expect(implementContextSpecKind({})).toBe("requirements");
  });
});

describe("implementPromptInput with the issue as the specification", () => {
  const ISSUE_SPEC = {
    ...CONTEXT,
    spec_kind: "issue" as const,
    profile: "bugfix",
    requirements_markdown: null,
    requirements_diagrams: [],
    requirements_doc_dir: null,
    requirements_doc_hash: null,
    requirements_console_url: null,
  };

  test("marks the specification as the issue", () => {
    expect(implementPromptInput(ISSUE_SPEC, null).specKind).toBe("issue");
  });

  test("carries the profile", () => {
    expect(implementPromptInput(ISSUE_SPEC, null).profile).toBe("bugfix");
  });

  test("carries the recorded title and body of the issue", () => {
    expect(implementPromptInput(ISSUE_SPEC, null).issue.body).toBe(
      "CSVで出力したい",
    );
  });

  test("hands Claude no requirements directory", () => {
    expect(implementPromptInput(ISSUE_SPEC, null).requirements.doc_dir).toBe(
      null,
    );
  });

  test("marks the requirements as the specification for a context made before the field existed", () => {
    const { spec_kind: _omitted, ...older } = CONTEXT;
    expect(implementPromptInput(older, null).specKind).toBe("requirements");
  });
});

describe("prepareImplementWorktree", () => {
  function prepDeps(existing: boolean): {
    deps: WorktreePrepDeps;
    calls: string[];
  } {
    const calls: string[] = [];
    let created = 0;
    return {
      calls,
      deps: {
        hasWorktree: async () => existing,
        createWorktree: async () => {
          calls.push("create");
          created += 1;
          return `/wt-${String(created)}`;
        },
        publishBranch: async () => {
          calls.push("publish");
          return PUBLISHED_BASE_SHA;
        },
      },
    };
  }
  const PUBLISHED_BASE_SHA = "d".repeat(40);

  test("publishes an existing worktree's branch before reusing it", async () => {
    const { deps, calls } = prepDeps(true);
    await prepareImplementWorktree(deps);
    expect(calls).toEqual(["publish", "create"]);
  });

  test("re-takes a new worktree through the reuse path after publishing", async () => {
    const { deps, calls } = prepDeps(false);
    await prepareImplementWorktree(deps);
    expect(calls).toEqual(["create", "publish", "create"]);
  });

  test("returns the aligned worktree's path", async () => {
    const { deps } = prepDeps(false);
    expect((await prepareImplementWorktree(deps)).worktreeDir).toBe("/wt-2");
  });

  test("returns the base sha the publish verified against the remote", async () => {
    const { deps } = prepDeps(true);
    expect((await prepareImplementWorktree(deps)).baseSha).toBe(
      PUBLISHED_BASE_SHA,
    );
  });
});

describe("withReadOnlyDocDirCopy", () => {
  function copyDeps(): {
    deps: DocDirCopyDeps;
    copied: [string, string][];
    removed: string[];
  } {
    const copied: [string, string][] = [];
    const removed: string[] = [];
    return {
      copied,
      removed,
      deps: {
        pathExists: async () => true,
        makeTempDir: async () => "/tmp/fake-req",
        copyDir: async (source, destination) => {
          copied.push([source, destination]);
        },
        removeDir: async (path) => {
          removed.push(path);
        },
      },
    };
  }

  test("runs fn with null when doc_dir no longer exists on disk", async () => {
    const h = copyDeps();
    const deps = { ...h.deps, pathExists: async () => false };
    expect(
      await withReadOnlyDocDirCopy(DOC_DIR, async (copy) => copy, deps),
    ).toBeNull();
  });

  test("copies doc_dir into a fresh temp dir", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", h.deps);
    expect(h.copied).toEqual([[DOC_DIR, "/tmp/fake-req/requirements"]]);
  });

  test("hands the copy's path to fn", async () => {
    const h = copyDeps();
    expect(
      await withReadOnlyDocDirCopy(DOC_DIR, async (copy) => copy, h.deps),
    ).toBe("/tmp/fake-req/requirements");
  });

  test("removes the temp dir after fn", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", h.deps);
    expect(h.removed).toEqual(["/tmp/fake-req"]);
  });

  test("removes the temp dir when fn throws", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(
      DOC_DIR,
      async () => {
        throw new Error("boom");
      },
      h.deps,
    ).catch(() => undefined);
    expect(h.removed).toEqual(["/tmp/fake-req"]);
  });

  test("passes null through without copying", async () => {
    const h = copyDeps();
    await withReadOnlyDocDirCopy(null, async () => "x", h.deps);
    expect(h.copied).toEqual([]);
  });
});

describe("withReadOnlyDocDirCopy and the baseline of the approved requirements", () => {
  const BASELINE = "a".repeat(64);

  /** 呼び出しの順を控える偽の依存。`hashes`は呼び出しごとに順に返す。 */
  function guarded(
    hashes: (string | null)[],
    options: { pathExists?: boolean; baseline?: string | null } = {},
  ) {
    const events: string[] = [];
    const hashed: string[] = [];
    let hashCall = 0;
    const deps: DocDirCopyDeps = {
      pathExists: async () => options.pathExists ?? true,
      makeTempDir: async () => "/tmp/fake-req",
      copyDir: async () => {
        events.push("copy");
      },
      removeDir: async () => {
        events.push("remove");
      },
    };
    const guard: DocDirGuard = {
      baseline: options.baseline === undefined ? BASELINE : options.baseline,
      hashTree: async (dir) => {
        events.push("hash");
        hashed.push(dir);
        const value = hashes[hashCall];
        hashCall += 1;
        return value === undefined ? null : value;
      },
    };
    const run = (
      fn: (copy: string | null) => Promise<string> = async () => "ran",
    ) => {
      return withReadOnlyDocDirCopy(
        DOC_DIR,
        async (copy) => {
          events.push("fn");
          return fn(copy);
        },
        deps,
        guard,
      );
    };
    return { run, events, hashed };
  }

  test("hashes the original directory before and after the copy, then runs fn", async () => {
    const g = guarded([BASELINE, BASELINE]);
    await g.run();
    expect(g.events).toEqual(["hash", "copy", "hash", "fn", "remove"]);
  });

  test("hashes the original directory, not the copy", async () => {
    const g = guarded([BASELINE, BASELINE]);
    await g.run();
    expect(g.hashed).toEqual([DOC_DIR, DOC_DIR]);
  });

  test("returns what fn returns when both hashes match", async () => {
    const g = guarded([BASELINE, BASELINE]);
    expect(await g.run()).toBe("ran");
  });

  test("throws the reason before implementation when the directory differs before the copy", async () => {
    const g = guarded(["b".repeat(64)]);
    await expect(g.run()).rejects.toMatchObject({
      reason: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    });
  });

  test("does not copy or run fn when the directory differs before the copy", async () => {
    const g = guarded(["b".repeat(64)]);
    await g.run().catch(() => undefined);
    expect(g.events).toEqual(["hash"]);
  });

  test("throws the reason before implementation when the directory changes during the copy", async () => {
    const g = guarded([BASELINE, "b".repeat(64)]);
    await expect(g.run()).rejects.toMatchObject({
      reason: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    });
  });

  test("does not run fn and removes the copy when the directory changes during the copy", async () => {
    const g = guarded([BASELINE, "b".repeat(64)]);
    await g.run().catch(() => undefined);
    expect(g.events).toEqual(["hash", "copy", "hash", "remove"]);
  });

  test("throws the missing reason when the directory is gone", async () => {
    const g = guarded([null], { pathExists: false });
    await expect(g.run()).rejects.toMatchObject({
      reason: REQUIREMENTS_DIR_MISSING_REASON,
    });
  });

  test("throws the missing reason when the directory disappears during the copy", async () => {
    const g = guarded([BASELINE, null]);
    await expect(g.run()).rejects.toMatchObject({
      reason: REQUIREMENTS_DIR_MISSING_REASON,
    });
  });

  test("throws an error that callers can tell apart", async () => {
    const g = guarded(["b".repeat(64)]);
    await expect(g.run()).rejects.toBeInstanceOf(RequirementsUntrustedError);
  });

  test("skips the comparison when there is no baseline", async () => {
    const g = guarded([], { baseline: null });
    await g.run();
    expect(g.events).toEqual(["copy", "fn", "remove"]);
  });

  test("does not hash the directory when there is no baseline", async () => {
    const g = guarded([], { baseline: null });
    await g.run();
    expect(g.hashed).toEqual([]);
  });

  test("runs fn with null when there is no baseline and the directory is gone", async () => {
    const g = guarded([], { baseline: null, pathExists: false });
    expect(await g.run(async (copy) => String(copy))).toBe("null");
  });
});

describe("withReadOnlyDocDirCopy and the hash of the copied bytes", () => {
  const BASELINE = "a".repeat(64);

  /**
   * 元のディレクトリのハッシュは常に基準値と合い、複製が返すハッシュだけを`copied`で変える。
   * 複製の最中だけ書き換えて戻す攻撃は、元のハッシュには現れず、複製のハッシュにだけ現れる。
   */
  function guardedCopy(
    copied: string | null,
    options: { baseline?: string | null } = {},
  ) {
    const events: string[] = [];
    const deps: DocDirCopyDeps = {
      pathExists: async () => true,
      makeTempDir: async () => "/tmp/fake-req",
      copyDir: async () => {
        events.push("copyDir");
      },
      removeDir: async () => {
        events.push("remove");
      },
    };
    const guard: DocDirGuard = {
      baseline: options.baseline === undefined ? BASELINE : options.baseline,
      hashTree: async () => {
        events.push("hash");
        return BASELINE;
      },
      copyAndHash: async (source, destination) => {
        events.push(`copyAndHash:${source}:${destination}`);
        return copied;
      },
    };
    const run = () =>
      withReadOnlyDocDirCopy(
        DOC_DIR,
        async (copy) => {
          events.push("fn");
          return copy;
        },
        deps,
        guard,
      );
    return { run, events };
  }

  test("copies with the hashing copy instead of the plain copy", async () => {
    const g = guardedCopy(BASELINE);
    await g.run();
    expect(g.events).toEqual([
      "hash",
      `copyAndHash:${DOC_DIR}:/tmp/fake-req/requirements`,
      "hash",
      "fn",
      "remove",
    ]);
  });

  test("hands the copy's path to fn when the copied bytes match the baseline", async () => {
    const g = guardedCopy(BASELINE);
    expect(await g.run()).toBe("/tmp/fake-req/requirements");
  });

  test("throws the modified reason when the copied bytes differ from the baseline", async () => {
    const g = guardedCopy("b".repeat(64));
    await expect(g.run()).rejects.toMatchObject({
      reason: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    });
  });

  test("does not run fn and removes the copy when the copied bytes differ from the baseline", async () => {
    const g = guardedCopy("b".repeat(64));
    await g.run().catch(() => undefined);
    expect(g.events).toEqual([
      "hash",
      `copyAndHash:${DOC_DIR}:/tmp/fake-req/requirements`,
      "remove",
    ]);
  });

  test("throws the missing reason when the directory vanished during the copy", async () => {
    const g = guardedCopy(null);
    await expect(g.run()).rejects.toMatchObject({
      reason: REQUIREMENTS_DIR_MISSING_REASON,
    });
  });

  test("uses the plain copy when there is no baseline", async () => {
    const g = guardedCopy(null, { baseline: null });
    await g.run();
    expect(g.events).toEqual(["copyDir", "fn", "remove"]);
  });

  test("copies the real directory and hands fn the same bytes that the baseline names", async () => {
    const source = mkdtempSync(join(tmpdir(), "guard-source-"));
    writeFileSync(join(source, "requirements.md"), "R");
    const baseline = await docDirGuardFor({}).hashTree(source);
    const seen = await withReadOnlyDocDirCopy(
      source,
      async (copy) =>
        copy === null ? null : Bun.file(join(copy, "requirements.md")).text(),
      defaultDocDirCopyDeps,
      docDirGuardFor({ requirements_doc_hash: baseline }),
    );
    rmSync(source, { recursive: true, force: true });
    expect(seen).toBe("R");
  });
});

describe("withReadOnlyDocDirCopy and a context that has no baseline item", () => {
  const deps: DocDirCopyDeps = {
    pathExists: async () => true,
    makeTempDir: async () => "/tmp/fake-req",
    copyDir: async () => {},
    removeDir: async () => {},
  };

  /** 警告を控える照合の設定。`baseline`が`undefined`なら項目が無い文脈を表す。 */
  function guardOf(
    baseline: string | null | undefined,
    hash: string | null = null,
  ) {
    const warnings: string[] = [];
    const guard: DocDirGuard = {
      baseline,
      hashTree: async () => hash,
      warn: (message) => {
        warnings.push(message);
      },
    };
    return { guard, warnings };
  }

  test("warns once per call when the context has no baseline item", async () => {
    const g = guardOf(undefined);
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", deps, g.guard);
    expect(g.warnings).toHaveLength(1);
  });

  test("warns once for each call, not once for the guard", async () => {
    const g = guardOf(undefined);
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", deps, g.guard);
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", deps, g.guard);
    expect(g.warnings).toHaveLength(2);
  });

  test("still runs fn when the context has no baseline item", async () => {
    const g = guardOf(undefined);
    expect(
      await withReadOnlyDocDirCopy(DOC_DIR, async () => "ran", deps, g.guard),
    ).toBe("ran");
  });

  test("stays silent for a null baseline, which the prepare step already warned about", async () => {
    const g = guardOf(null);
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", deps, g.guard);
    expect(g.warnings).toHaveLength(0);
  });

  test("stays silent for an empty baseline", async () => {
    const g = guardOf("");
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", deps, g.guard);
    expect(g.warnings).toHaveLength(0);
  });

  test("stays silent for a baseline that is set", async () => {
    const g = guardOf("a".repeat(64), "a".repeat(64));
    await withReadOnlyDocDirCopy(DOC_DIR, async () => "x", deps, g.guard);
    expect(g.warnings).toHaveLength(0);
  });

  test("does not need a warn function", async () => {
    const guard: DocDirGuard = {
      baseline: undefined,
      hashTree: async () => null,
    };
    expect(
      await withReadOnlyDocDirCopy(DOC_DIR, async () => "ran", deps, guard),
    ).toBe("ran");
  });

  test("does not warn when the directory is not copied at all", async () => {
    const g = guardOf(undefined);
    await withReadOnlyDocDirCopy(null, async () => "x", deps, g.guard);
    expect(g.warnings).toHaveLength(0);
  });
});

describe("withReadOnlyDocDirCopy and the reasons that the guard hands over", () => {
  const BASELINE = "a".repeat(64);
  const deps: DocDirCopyDeps = {
    pathExists: async () => true,
    makeTempDir: async () => "/tmp/fake-req",
    copyDir: async () => {},
    removeDir: async () => {},
  };
  const REASONS = {
    modified: "approved designs were modified before implementation",
    missing: "approved designs directory is missing",
  };

  /** 呼び出しごとに`hashes`を順に返す照合の設定。 */
  function guardOf(
    hashes: (string | null)[],
    reasons?: DocDirGuard["reasons"],
  ): DocDirGuard {
    let call = 0;
    return {
      baseline: BASELINE,
      hashTree: async () => {
        const value = hashes[call];
        call += 1;
        return value === undefined ? null : value;
      },
      ...(reasons === undefined ? {} : { reasons }),
    };
  }

  test("uses the reason of the requirements for a change when the guard gives none", async () => {
    await expect(
      withReadOnlyDocDirCopy(
        DOC_DIR,
        async () => "x",
        deps,
        guardOf(["b".repeat(64)]),
      ),
    ).rejects.toMatchObject({
      reason: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    });
  });

  test("uses the reason of the requirements for a missing directory when the guard gives none", async () => {
    await expect(
      withReadOnlyDocDirCopy(DOC_DIR, async () => "x", deps, guardOf([null])),
    ).rejects.toMatchObject({ reason: REQUIREMENTS_DIR_MISSING_REASON });
  });

  test("uses the reason of the guard for a change before the copy", async () => {
    await expect(
      withReadOnlyDocDirCopy(
        DOC_DIR,
        async () => "x",
        deps,
        guardOf(["b".repeat(64)], REASONS),
      ),
    ).rejects.toMatchObject({ reason: REASONS.modified });
  });

  test("uses the reason of the guard for a change during the copy", async () => {
    await expect(
      withReadOnlyDocDirCopy(
        DOC_DIR,
        async () => "x",
        deps,
        guardOf([BASELINE, "b".repeat(64)], REASONS),
      ),
    ).rejects.toMatchObject({ reason: REASONS.modified });
  });

  test("uses the missing reason of the guard when the directory is gone", async () => {
    await expect(
      withReadOnlyDocDirCopy(
        DOC_DIR,
        async () => "x",
        deps,
        guardOf([null], REASONS),
      ),
    ).rejects.toMatchObject({ reason: REASONS.missing });
  });

  test("hands the reason of the guard to the round that stops", async () => {
    expect(
      await runDocDirGuardedRound(
        DOC_DIR,
        guardOf(["b".repeat(64)], REASONS),
        async () => {
          throw new Error("must not run");
        },
        deps,
      ),
    ).toEqual({ kind: "requirements_modified", reason: REASONS.modified });
  });
});

describe("runDocDirGuardedRound", () => {
  const ROUND: ImplementClaudeRunRound = {
    kind: "output",
    output: DONE,
    agent_run_id: 7,
    cost_usd: 0.5,
  };
  const BASELINE = "a".repeat(64);
  const deps: DocDirCopyDeps = {
    pathExists: async () => true,
    makeTempDir: async () => "/tmp/fake-req",
    copyDir: async () => {},
    removeDir: async () => {},
  };
  const guardOf = (hash: string | null): DocDirGuard => ({
    baseline: BASELINE,
    hashTree: async () => hash,
  });

  test("returns the round of Claude when the directory matches", async () => {
    expect(
      await runDocDirGuardedRound(
        DOC_DIR,
        guardOf(BASELINE),
        async () => ROUND,
        deps,
      ),
    ).toEqual(ROUND);
  });

  test("returns a requirements_modified round with the reason when the directory differs", async () => {
    expect(
      await runDocDirGuardedRound(
        DOC_DIR,
        guardOf("b".repeat(64)),
        async () => ROUND,
        deps,
      ),
    ).toEqual({
      kind: "requirements_modified",
      reason: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    });
  });

  test("returns a requirements_modified round with the missing reason when the directory is gone", async () => {
    expect(
      await runDocDirGuardedRound(
        DOC_DIR,
        guardOf(null),
        async () => ROUND,
        deps,
      ),
    ).toEqual({
      kind: "requirements_modified",
      reason: REQUIREMENTS_DIR_MISSING_REASON,
    });
  });

  test("does not run Claude when the directory differs", async () => {
    let ran = false;
    await runDocDirGuardedRound(
      DOC_DIR,
      guardOf("b".repeat(64)),
      async () => {
        ran = true;
        return ROUND;
      },
      deps,
    );
    expect(ran).toBe(false);
  });

  test("rethrows any other error", async () => {
    await expect(
      runDocDirGuardedRound(
        DOC_DIR,
        guardOf(BASELINE),
        async () => {
          throw new Error("boom");
        },
        deps,
      ),
    ).rejects.toThrow("boom");
  });
});

describe("docDirGuardFor", () => {
  test("takes the baseline from the context", () => {
    const guard = docDirGuardFor({
      ...CONTEXT,
      requirements_doc_hash: "h".repeat(64),
    });
    expect(guard.baseline).toBe("h".repeat(64));
  });

  test("hashes a real directory as a sha-256 digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-guard-test-"));
    try {
      writeFileSync(join(dir, "requirements.md"), "R");
      const guard = docDirGuardFor(CONTEXT);
      expect(await guard.hashTree(dir)).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hashes a directory that does not exist as null", async () => {
    const guard = docDirGuardFor(CONTEXT);
    expect(await guard.hashTree("/does/not/exist/anywhere")).toBeNull();
  });

  test("keeps a context from before the baseline existed apart from a null baseline", () => {
    const guard = docDirGuardFor({});
    expect(guard.baseline).toBeUndefined();
  });

  test("keeps a null baseline of the context as null", () => {
    const guard = docDirGuardFor({ requirements_doc_hash: null });
    expect(guard.baseline).toBeNull();
  });

  test("hands over a function that logs the warning", () => {
    const guard = docDirGuardFor({});
    expect(typeof guard.warn).toBe("function");
  });

  test("hands over a copy that hashes the bytes it writes", () => {
    const guard = docDirGuardFor({});
    expect(typeof guard.copyAndHash).toBe("function");
  });

  test("copies a real directory and returns the hash that hashTree gives", async () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-guard-copy-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "doc-guard-dest-"));
    try {
      writeFileSync(join(dir, "requirements.md"), "R");
      const guard = docDirGuardFor(CONTEXT);
      expect(await guard.copyAndHash?.(dir, join(elsewhere, "copy"))).toBe(
        await guard.hashTree(dir),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("isCopyableDocEntry", () => {
  type Kind = "file" | "dir" | "symlink" | "other";
  const statOf = (kind: Kind) => ({
    isFile: () => kind === "file",
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
  });
  function fs(own: Kind): DocEntryFs {
    return { lstat: async () => statOf(own) };
  }

  test("copies a regular file", async () => {
    expect(await isCopyableDocEntry("/d/a.md", fs("file"))).toBe(true);
  });

  test("copies a directory", async () => {
    expect(await isCopyableDocEntry("/d/sub", fs("dir"))).toBe(true);
  });

  test("skips every symlink, whatever it points to", async () => {
    expect(await isCopyableDocEntry("/d/l", fs("symlink"))).toBe(false);
  });

  test("skips anything else (fifo, socket, device)", async () => {
    expect(await isCopyableDocEntry("/d/fifo", fs("other"))).toBe(false);
  });
});

describe("defaultDocDirCopyDeps.copyDir", () => {
  function tree(): { source: string; destination: string } {
    const base = mkdtempSync(join(tmpdir(), "doc-copy-test-"));
    const source = join(base, "src");
    mkdirSync(join(base, "outside"));
    writeFileSync(join(base, "outside", "note.txt"), "outside");
    mkdirSync(source);
    writeFileSync(join(source, "requirements.md"), "# 要件定義");
    symlinkSync(join(base, "outside", "note.txt"), join(source, "link.txt"));
    symlinkSync(join(base, "outside"), join(source, "dirlink"));
    return { source, destination: join(base, "dst") };
  }

  test("does not copy a symlinked file", async () => {
    const { source, destination } = tree();
    await defaultDocDirCopyDeps.copyDir(source, destination);
    expect(existsSync(join(destination, "link.txt"))).toBe(false);
  });

  test("does not copy a symlinked directory", async () => {
    const { source, destination } = tree();
    await defaultDocDirCopyDeps.copyDir(source, destination);
    expect(existsSync(join(destination, "dirlink"))).toBe(false);
  });

  test("copies regular files", async () => {
    const { source, destination } = tree();
    await defaultDocDirCopyDeps.copyDir(source, destination);
    expect(existsSync(join(destination, "requirements.md"))).toBe(true);
  });
});

/** 設計書の無い実行のラウンド。 */
function roundWithoutDesign(
  result: RunClaudeResult<ImplementClaudeOutput>,
  agentRunId: number,
) {
  return toImplementClaudeRound(result, agentRunId, false);
}

describe("toImplementClaudeRound", () => {
  test("returns an output round for a valid output", () => {
    expect(roundWithoutDesign(success(DONE), 11)).toEqual({
      kind: "output",
      output: DONE,
      agent_run_id: 11,
      cost_usd: 1.25,
    });
  });

  test("returns an invalid_output round when the semantic check fails", () => {
    expect(
      roundWithoutDesign(success({ ...DONE, gap_report: "x" }), 11).kind,
    ).toBe("invalid_output");
  });

  test("keeps the semantic check's reason on an invalid_output round", () => {
    const round = roundWithoutDesign(success({ ...DONE, gap_report: "x" }), 11);
    expect(round.kind === "invalid_output" ? round.reason : null).toBe(
      "gap_report must be null when outcome is done",
    );
  });

  test("returns a claude_failed round for a failed run", () => {
    expect(roundWithoutDesign(FAILURE, 12)).toEqual({
      kind: "claude_failed",
      reason: "timeout",
      detail: "claude -p timed out after 1000ms",
      agent_run_id: 12,
      cost_usd: 0,
    });
  });

  test("accepts a requirements_gap output as a valid round", () => {
    expect(roundWithoutDesign(success(GAP), 13).kind).toBe("output");
  });

  test("adds the discarded attempt's cost to the round cost", () => {
    const retried: RunClaudeResult<ImplementClaudeOutput> = {
      ...success(DONE),
      retried: true,
      discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
    };
    expect(roundWithoutDesign(retried, 11).cost_usd).toBe(2);
  });

  test("adds the discarded attempt's cost to a failed round", () => {
    const retriedFailure: RunClaudeResult<ImplementClaudeOutput> = {
      ...FAILURE,
      retried: true,
      discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
    };
    expect(roundWithoutDesign(retriedFailure, 12).cost_usd).toBe(0.75);
  });

  test("accepts a design_gap output as a valid round when a design was given", () => {
    expect(toImplementClaudeRound(success(DESIGN_GAP), 14, true).kind).toBe(
      "output",
    );
  });

  test("returns an invalid_output round for a design_gap output without a design", () => {
    expect(toImplementClaudeRound(success(DESIGN_GAP), 14, false).kind).toBe(
      "invalid_output",
    );
  });

  test("keeps the reason of a design_gap output without a design", () => {
    const round = toImplementClaudeRound(success(DESIGN_GAP), 14, false);
    expect(round.kind === "invalid_output" ? round.reason : null).toBe(
      "design_gap outcome without an approved design",
    );
  });
});

describe("buildImplementClaudeOptions", () => {
  test("uses model when no round has failed", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).model).toBe("claude-test");
  });

  test("uses model after one failed round", () => {
    expect(
      buildImplementClaudeOptions({ ...RUN_INPUT, sonnetFailures: 1 }).model,
    ).toBe("claude-test");
  });

  test("uses heavy_model after two failed rounds", () => {
    expect(
      buildImplementClaudeOptions({ ...RUN_INPUT, sonnetFailures: 2 }).model,
    ).toBe("claude-test-heavy");
  });

  test("does not escalate on the attempt number alone", () => {
    expect(
      buildImplementClaudeOptions({ ...RUN_INPUT, attempt: 3 }).model,
    ).toBe("claude-test");
  });

  test("passes the flow deadline to runClaude", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).deadlineAt).toBe(
      1_900_000_000_000,
    );
  });

  test("gives Claude no Bash", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Edit",
      "Write",
    ]);
  });

  test("allows only Edit and Write without asking", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).allowedTools).toEqual([
      "Edit",
      "Write",
    ]);
  });

  test("mounts the given docDir via addDirs", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).addDirs).toEqual([
      "/tmp/copy/requirements",
    ]);
  });

  test("mounts nothing when there is no docDir", () => {
    expect(
      buildImplementClaudeOptions({ ...RUN_INPUT, docDir: null }).addDirs,
    ).toEqual([]);
  });

  test("passes the pre-retry .git pointer check to runClaude", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).beforeRetry).toBe(
      RUN_INPUT.beforeRetry,
    );
  });

  test("runs in the worktree", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).cwd).toBe(
      CONTEXT.worktree_dir,
    );
  });

  test("uses implement_max_turns", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).maxTurns).toBe(80);
  });

  test("uses implement_max_budget_usd_per_run", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).maxBudgetUsd).toBe(10);
  });

  test("uses implement_timeout_sec in milliseconds", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).timeoutMs).toBe(3_600_000);
  });

  test("uses IMPLEMENT_SCHEMA when there is no design", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).jsonSchema).toBe(
      IMPLEMENT_SCHEMA,
    );
  });

  test("uses IMPLEMENT_SCHEMA_WITH_DESIGN_GAP when a design was given", () => {
    expect(
      buildImplementClaudeOptions({ ...RUN_INPUT, hasDesign: true }).jsonSchema,
    ).toBe(IMPLEMENT_SCHEMA_WITH_DESIGN_GAP);
  });

  test("uses dontAsk", () => {
    expect(buildImplementClaudeOptions(RUN_INPUT).permissionMode).toBe(
      "dontAsk",
    );
  });
});

describe("runImplementClaudeRound", () => {
  test("records the agent run once", async () => {
    const recorded: AgentRunRecord[] = [];
    await runImplementClaudeRound(
      {
        runClaude: async () => success(DONE),
        recordAgentRun: async (record) => {
          recorded.push(record);
          return 42;
        },
      },
      RUN_INPUT,
    );
    expect(recorded).toHaveLength(1);
  });

  test("records the discarded attempt too when Claude retried", async () => {
    const recorded: AgentRunRecord[] = [];
    await runImplementClaudeRound(
      {
        runClaude: async () => ({
          ...success(DONE),
          retried: true,
          discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
        }),
        recordAgentRun: async (record) => {
          recorded.push(record);
          return 42;
        },
      },
      RUN_INPUT,
    );
    expect(recorded.map((record) => record.cost_usd)).toEqual([0.75, 1.25]);
  });

  test("puts the final attempt's recorded id on a retried round", async () => {
    let nextId = 40;
    const round = await runImplementClaudeRound(
      {
        runClaude: async () => ({
          ...success(DONE),
          retried: true,
          discardedAgentRun: { ...AGENT_RUN, cost_usd: 0.75 },
        }),
        recordAgentRun: async () => {
          nextId += 1;
          return nextId;
        },
      },
      RUN_INPUT,
    );
    expect(round.agent_run_id).toBe(42);
  });

  test("puts the recorded id on the round", async () => {
    const round = await runImplementClaudeRound(
      { runClaude: async () => success(DONE), recordAgentRun: async () => 42 },
      RUN_INPUT,
    );
    expect(round.agent_run_id).toBe(42);
  });
});

const fp = (digit: string, files = 1): WorktreeFingerprint => ({
  treeSha: digit.repeat(40),
  diffStat: { files, added: 10, deleted: 1 },
});
const FP_1 = fp("1");
const FP_2 = fp("2");
const FP_3 = fp("3");
const FP_EMPTY = fp("9", 0);
const CLEAN: ChangeInspection = {
  changes: [{ path: "src/a.ts", status: "modified" }],
  packageJsonScriptsChanged: false,
  symlinkReasons: [],
};
const PROTECTED: ChangeInspection = {
  changes: [{ path: ".github/workflows/ci.yml", status: "modified" }],
  packageJsonScriptsChanged: false,
  symlinkReasons: [],
};
const GITLEAKS_OK: GitleaksResult = { ok: true, output: "" };
const GITLEAKS_LEAK: GitleaksResult = {
  ok: false,
  output: "- github-pat: a.txt:3",
};
const PASS: LoopCheckResult = {
  command: "bun test",
  ok: true,
  output: "1 pass",
  outputTail: "1 pass",
};
const FAIL: LoopCheckResult = {
  command: "bun test",
  ok: false,
  output: "1 fail",
  outputTail: "1 fail",
};
const LINT_FAIL: LoopCheckResult = {
  command: "bunx --bun biome check .",
  ok: false,
  output: "lint error",
  outputTail: "lint error",
};
const INVALID: ImplementClaudeRound = {
  kind: "invalid_output",
  output: DONE,
  reason: "commit_subject exceeds 72 code points",
  agent_run_id: 1,
  cost_usd: 0.5,
};
const FAILED: ImplementClaudeRound = {
  kind: "claude_failed",
  reason: "timeout",
  detail: "timed out",
  agent_run_id: 9,
  cost_usd: 0,
};
const FAILED_EXIT: ImplementClaudeRound = {
  kind: "claude_failed",
  reason: "non_zero_exit",
  detail: "exit 1",
  agent_run_id: 9,
  cost_usd: 0,
};

function outputRound(
  output: ImplementClaudeOutput = DONE,
  agentRunId = 1,
): ImplementClaudeRound {
  return { kind: "output", output, agent_run_id: agentRunId, cost_usd: 0.5 };
}

function pick<T>(list: readonly T[], index: number): T {
  const value = list[Math.min(index, list.length - 1)];
  if (value === undefined) throw new Error("harness: empty list");
  return value;
}

type HarnessOptions = {
  readonly fingerprints?: readonly WorktreeFingerprint[];
  readonly inspection?: ChangeInspection;
  readonly sizeReasons?: readonly string[];
  readonly gitleaks?: readonly GitleaksResult[];
  /** gitleaksが検査したツリー。既定は直前に取った指紋のツリーと同じにする。 */
  readonly scannedTrees?: readonly string[];
  readonly checks?: readonly (readonly LoopCheckResult[])[];
  readonly fixRounds?: readonly ImplementClaudeRound[];
  readonly budgetExceeded?: boolean;
  /** `modelChangesAfterFailure`が、呼び出しの順に返す値。最後の値を繰り返す。既定はfalse。 */
  readonly modelChangesNext?: readonly boolean[];
  /** `holdsLease`が、0始まりで`from`回目以降の呼び出しでfalseを返す(リースを失った)。 */
  readonly leaseLostFrom?: number;
  /** `assertGitPointer`が、0始まりで`from`回目以降の呼び出しで投げる例外。 */
  readonly pointerError?: { readonly from: number; readonly error: Error };
  /** `now`が返す時刻(epoch ms)。既定は0。 */
  readonly now?: number;
  /** `runChecks`が投げる例外。 */
  readonly checksError?: Error;
  /** `at`回目(0から数える)以降の`runChecks`が投げる例外。 */
  readonly checksErrorFrom?: { readonly at: number; readonly error: Error };
};

type Harness = {
  readonly deps: ImplementLoopDeps;
  readonly recorded: ImplementRoundRecord[];
  readonly fixRequests: FixRoundRequest[];
  readonly calls: {
    gitleaks: number;
    checks: number;
    fingerprint: number;
    modelChange: number;
  };
  readonly events: string[];
};

function harness(options: HarnessOptions = {}): Harness {
  const recorded: ImplementRoundRecord[] = [];
  const fixRequests: FixRoundRequest[] = [];
  const calls = {
    gitleaks: 0,
    checks: 0,
    fingerprint: 0,
    modelChange: 0,
  };
  const events: string[] = [];
  let lastTreeSha = "";
  const deps: ImplementLoopDeps = {
    assertGitPointer: async () => {
      const index = events.filter((event) => event === "pointer").length;
      events.push("pointer");
      const failure = options.pointerError;
      if (failure !== undefined && index >= failure.from) throw failure.error;
    },
    removeIgnoredFiles: async () => {
      events.push("clean");
    },
    fingerprint: async () => {
      events.push("fingerprint");
      const value = pick(options.fingerprints ?? [FP_1], calls.fingerprint);
      calls.fingerprint += 1;
      lastTreeSha = value.treeSha;
      return value;
    },
    inspectChanges: async () => options.inspection ?? CLEAN,
    diffSizeReasons: () => options.sizeReasons ?? [],
    runGitleaks: async () => {
      const value = pick(options.gitleaks ?? [GITLEAKS_OK], calls.gitleaks);
      const treeSha = pick(
        options.scannedTrees ?? [lastTreeSha],
        calls.gitleaks,
      );
      calls.gitleaks += 1;
      return { ...value, treeSha };
    },
    runChecks: async () => {
      events.push("checks");
      if (options.checksError !== undefined) throw options.checksError;
      if (
        options.checksErrorFrom !== undefined &&
        calls.checks >= options.checksErrorFrom.at
      )
        throw options.checksErrorFrom.error;
      const value = pick(options.checks ?? [[PASS]], calls.checks);
      calls.checks += 1;
      return value;
    },
    runFixRound: async (request) => {
      fixRequests.push(request);
      return pick(
        options.fixRounds ?? [outputRound(DONE, 2)],
        fixRequests.length - 1,
      );
    },
    recordRound: async (record) => {
      recorded.push(record);
    },
    dailyBudgetExceeded: async () => options.budgetExceeded ?? false,
    modelChangesAfterFailure: async () => {
      const value = pick(
        options.modelChangesNext ?? [false],
        calls.modelChange,
      );
      calls.modelChange += 1;
      return value;
    },
    holdsLease: async () => {
      const index = events.filter((event) => event === "lease").length;
      events.push("lease");
      return (
        options.leaseLostFrom === undefined || index < options.leaseLostFrom
      );
    },
    now: () => options.now ?? 0,
    log: () => {},
    reportCheckImageStale: async (error) => {
      events.push(`stale ${error.message}`);
    },
  };
  return { deps, recorded, fixRequests, calls, events };
}

function loopInput(
  firstRound: ImplementClaudeRound = outputRound(),
  overrides: Partial<ImplementLoopInput> = {},
): ImplementLoopInput {
  return {
    workItemId: 3,
    attempt: 1,
    maxRounds: 5,
    hasCheckCommands: true,
    firstRound,
    deadlineAt: Number.MAX_SAFE_INTEGER,
    fixRoundRequiredMs: 7_860_000,
    ...overrides,
  };
}

const run = (h: Harness, input: ImplementLoopInput = loopInput()) =>
  runImplementVerifyLoop(h.deps, input);

describe("runImplementVerifyLoop", () => {
  test("exits checks_passed when the first round passes", async () => {
    expect((await run(harness())).exit).toBe("checks_passed");
  });

  test("records the first round as mode implement", async () => {
    const h = harness();
    await run(h);
    expect(h.recorded[0]?.mode).toBe("implement");
  });

  test("records a passing round with outcome done", async () => {
    const h = harness();
    await run(h);
    expect(h.recorded[0]?.outcome).toBe("done");
  });

  test("returns the passing round's output as final_output", async () => {
    expect((await run(harness())).final_output).toEqual(DONE);
  });

  test("keeps the tail of a failed check in the record when a large passed output follows", async () => {
    const failedOutput = `${"warn: noisy log\n".repeat(3000)}FAIL: the failing test\n3 fail\n`;
    const passedOutput = "ok: checked a file\n".repeat(3000);
    const h = harness({
      checks: [
        [
          {
            ...FAIL,
            output: failedOutput,
            outputTail: failedOutput.slice(-2000),
          },
          { ...LINT_FAIL, ok: true, output: passedOutput, outputTail: "" },
        ],
      ],
    });
    await run(h, loopInput(outputRound(), { maxRounds: 1 }));
    expect(h.recorded[0]?.check_output).toContain("FAIL: the failing test");
  });

  test("lists gitleaks and the commands in the check summary", async () => {
    expect((await run(harness())).checks).toEqual({
      kind: "ran",
      results: [
        { command: GITLEAKS_CHECK_NAME, ok: true },
        { command: "bun test", ok: true },
      ],
    });
  });

  test("exits checks_skipped when no check command is configured", async () => {
    expect(
      (
        await run(
          harness(),
          loopInput(outputRound(), { hasCheckCommands: false }),
        )
      ).exit,
    ).toBe("checks_skipped");
  });

  test("does not run check commands in a round that changed a protected path", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.calls.checks).toBe(0);
  });

  test("records why the checks were skipped", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.recorded[0]?.checks_skipped_reason).toBe(
      IMPLEMENT_CHECK_SKIP_REASONS.protected_paths,
    );
  });

  test("notes a passing gitleaks in the summary of skipped checks", async () => {
    expect((await run(harness({ inspection: PROTECTED }))).checks).toEqual({
      kind: "skipped",
      reason: "保護パスを変更したため(gitleaks: 合格)",
    });
  });

  test("notes a failing gitleaks in the summary of skipped checks", async () => {
    expect(
      (
        await run(
          harness({ inspection: PROTECTED, gitleaks: [GITLEAKS_LEAK] }),
          loopInput(outputRound(), { maxRounds: 1 }),
        )
      ).checks,
    ).toEqual({
      kind: "skipped",
      reason: "保護パスを変更したため(gitleaks: 不合格)",
    });
  });

  test("lists the failed change check in the summary of a no-changes round", async () => {
    expect(
      (
        await run(
          harness({ fingerprints: [FP_EMPTY] }),
          loopInput(outputRound(), { maxRounds: 1 }),
        )
      ).checks,
    ).toEqual({
      kind: "ran",
      results: [{ command: NO_CHANGES_CHECK_NAME, ok: false }],
    });
  });

  test("records the protected changes on the round", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.recorded[0]?.protected_changes).toEqual([
      "保護パスを変更: .github/workflows/ci.yml",
    ]);
  });

  test("exits requirements_gap without inspecting the worktree", async () => {
    const h = harness();
    await run(h, loopInput(outputRound(GAP)));
    expect(h.calls.fingerprint).toBe(0);
  });

  test("carries the gap report on a requirements_gap exit", async () => {
    expect((await run(harness(), loopInput(outputRound(GAP)))).gap_report).toBe(
      GAP.gap_report,
    );
  });

  test("exits design_gap without inspecting the worktree", async () => {
    const h = harness();
    await run(h, loopInput(outputRound(DESIGN_GAP)));
    expect(h.calls.fingerprint).toBe(0);
  });

  test("exits design_gap for a design_gap output", async () => {
    expect(
      (await run(harness(), loopInput(outputRound(DESIGN_GAP)))).exit,
    ).toBe("design_gap");
  });

  test("carries the gap report on a design_gap exit", async () => {
    expect(
      (await run(harness(), loopInput(outputRound(DESIGN_GAP)))).gap_report,
    ).toBe(DESIGN_GAP.gap_report);
  });

  test("records a design_gap round with the report", async () => {
    const h = harness();
    await run(h, loopInput(outputRound(DESIGN_GAP)));
    expect(h.recorded[0]).toMatchObject({
      outcome: "design_gap",
      gap_report: DESIGN_GAP.gap_report,
    });
  });

  test("exits claude_error for a failed run", async () => {
    expect((await run(harness(), loopInput(FAILED))).exit).toBe("claude_error");
  });

  test("records an error round for a failed run", async () => {
    const h = harness();
    await run(h, loopInput(FAILED));
    expect(h.recorded[0]?.outcome).toBe("error");
  });

  test("flags a contract violation on the fix request", async () => {
    const h = harness();
    await run(h, loopInput(INVALID));
    expect(h.fixRequests[0]?.contractViolated).toBe(true);
  });

  test("keeps the contract rules out of the fenced failures", async () => {
    const h = harness();
    await run(h, loopInput(INVALID));
    expect(h.fixRequests[0]?.failures).toEqual([]);
  });

  test("records the contract violation's reason in check_output", async () => {
    const h = harness();
    await run(h, loopInput(INVALID));
    expect(h.recorded[0]?.check_output).toContain(
      "commit_subject exceeds 72 code points",
    );
  });

  test("does not pass a done round that changed nothing", async () => {
    const h = harness({ fingerprints: [FP_EMPTY, FP_2] });
    await run(h);
    expect(
      h.fixRequests[0]?.failures.map((failure) => failure.command),
    ).toEqual([NO_CHANGES_CHECK_NAME]);
  });

  test("does not scan an unchanged round for secrets", async () => {
    const h = harness({ fingerprints: [FP_EMPTY, FP_2] });
    await run(h);
    expect(h.calls.gitleaks).toBe(1);
  });

  test("passes the failing command's tail to the fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.fixRequests[0]?.failures).toEqual([
      { command: "bun test", outputTail: "1 fail" },
    ]);
  });

  test("puts failed command output before passed output in check_output", async () => {
    const h = harness({
      checks: [[PASS, LINT_FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
    });
    await run(h);
    expect(
      h.recorded[0]?.check_output?.startsWith("$ bunx --bun biome check ."),
    ).toBe(true);
  });

  test("records a fix round as mode fix", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.recorded[1]?.mode).toBe("fix");
  });

  test("exits checks_passed after a successful fix round", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] }),
        )
      ).exit,
    ).toBe("checks_passed");
  });

  test("counts both Claude runs as rounds", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] }),
        )
      ).rounds,
    ).toBe(2);
  });

  test("sums the cost of every round", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] }),
        )
      ).total_cost_usd,
    ).toBe(1);
  });

  test("exits max_rounds when the checks keep failing", async () => {
    const h = harness({ checks: [[FAIL]], fingerprints: [FP_1, FP_2, FP_3] });
    expect(
      (await run(h, loopInput(outputRound(), { maxRounds: 2 }))).exit,
    ).toBe("max_rounds");
  });

  test("gives max_rounds an English reason describeReason knows", async () => {
    const h = harness({ checks: [[FAIL]], fingerprints: [FP_1, FP_2, FP_3] });
    expect(
      (await run(h, loopInput(outputRound(), { maxRounds: 2 }))).reason,
    ).toBe("implement checks still failing after 2 rounds");
  });

  test("exits stalled when the worktree did not change", async () => {
    expect(
      (await run(harness({ checks: [[FAIL]], fingerprints: [FP_1] }))).exit,
    ).toBe("stalled");
  });

  test("runs a fix round past a stall when the next failure changes the model", async () => {
    const h = harness({
      checks: [[FAIL]],
      fingerprints: [FP_1],
      modelChangesNext: [false, true, false],
    });
    expect((await run(h)).rounds).toBe(3);
  });

  test("tells the fix round the previous round stalled when the stall check was skipped", async () => {
    const h = harness({
      checks: [[FAIL]],
      fingerprints: [FP_1],
      modelChangesNext: [false, true, false],
    });
    await run(h);
    expect(
      h.fixRequests.map((request) => request.previousRoundStalled),
    ).toEqual([false, true]);
  });

  test("does not flag a stall when the model changes but the round made progress", async () => {
    const h = harness({
      checks: [[FAIL], [LINT_FAIL]],
      fingerprints: [FP_1, FP_2],
      modelChangesNext: [true],
    });
    await run(h);
    expect(h.fixRequests[0]?.previousRoundStalled).toBe(false);
  });

  test("exits stalled once the model no longer changes", async () => {
    const h = harness({
      checks: [[FAIL]],
      fingerprints: [FP_1],
      modelChangesNext: [false, true, false],
    });
    expect((await run(h)).exit).toBe("stalled");
  });

  test("skips the stall check only once when the model changes from the recorded failures", async () => {
    const h = harness({ checks: [[FAIL]], fingerprints: [FP_1] });
    const failedOutcomes: readonly string[] = [
      "check_failed",
      "stalled",
      "error",
    ];
    const deps: ImplementLoopDeps = {
      ...h.deps,
      modelChangesAfterFailure: async () =>
        modelChangesAfterFailure(
          MODEL_CONFIG,
          "implement",
          h.recorded.filter((record) => failedOutcomes.includes(record.outcome))
            .length,
        ),
    };
    const result = await runImplementVerifyLoop(deps, loopInput());
    expect({ exit: result.exit, rounds: result.rounds }).toEqual({
      exit: "stalled",
      rounds: 3,
    });
  });

  test("still exits max_rounds when the next failure changes the model", async () => {
    const h = harness({
      checks: [[FAIL]],
      fingerprints: [FP_1],
      modelChangesNext: [true],
    });
    expect(
      (await run(h, loopInput(outputRound(), { maxRounds: 2 }))).exit,
    ).toBe("max_rounds");
  });

  test("asks whether the model changes only for a failed round", async () => {
    const h = harness({ checks: [[PASS]] });
    await run(h);
    expect(h.calls.modelChange).toBe(0);
  });

  test("asks whether the model changes before recording the failed round", async () => {
    const order: string[] = [];
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    const base = h.deps;
    const deps: ImplementLoopDeps = {
      ...base,
      modelChangesAfterFailure: async () => {
        order.push("count");
        return base.modelChangesAfterFailure();
      },
      recordRound: async (record) => {
        order.push("record");
        await base.recordRound(record);
      },
    };
    await runImplementVerifyLoop(deps, loopInput());
    expect(order).toEqual(["count", "record", "record"]);
  });

  test("exits daily_budget when the budget is spent", async () => {
    expect(
      (await run(harness({ checks: [[FAIL]], budgetExceeded: true }))).exit,
    ).toBe("daily_budget");
  });

  test("exits symlink on a symlink change", async () => {
    const h = harness({
      inspection: {
        ...CLEAN,
        symlinkReasons: ["symlink_change: symlink changed: link"],
      },
    });
    expect((await run(h)).exit).toBe("symlink");
  });

  // イメージの問題と稼働中のworkerの問題は、運用者の操作が違うだけで、ループの扱いは同じである。
  const ENVIRONMENT_ERRORS = [
    {
      name: "a stale image",
      error: new CheckImageStaleError(["/usr/bin/getfacl is missing"]),
    },
    {
      name: "an unsafe running worker",
      error: new CheckRuntimeUnsafeError([
        "world-writable paths created at runtime: /tmp/open",
      ]),
    },
  ];

  test.each(ENVIRONMENT_ERRORS)(
    "exits check_image_stale on $name",
    async ({ error }) => {
      const h = harness({ checksError: error });
      expect((await run(h)).exit).toBe("check_image_stale");
    },
  );

  test.each(ENVIRONMENT_ERRORS)(
    "gives $name as the reason",
    async ({ error }) => {
      const h = harness({ checksError: error });
      expect((await run(h)).reason).toBe(error.message);
    },
  );

  test("gives the stale image as a reason that asks for mise run up", async () => {
    const h = harness({
      checksError: new CheckImageStaleError(["/usr/bin/getfacl is missing"]),
    });
    expect((await run(h)).reason).toBe(
      `${CHECK_IMAGE_STALE_REASON}: /usr/bin/getfacl is missing`,
    );
  });

  test.each(ENVIRONMENT_ERRORS)("reports $name once", async ({ error }) => {
    const h = harness({ checksError: error });
    await run(h);
    expect(h.events.filter((event) => event.startsWith("stale "))).toEqual([
      `stale ${error.message}`,
    ]);
  });

  test.each(ENVIRONMENT_ERRORS)(
    "does not start a fix round on $name",
    async ({ error }) => {
      const h = harness({ checksError: error });
      await run(h);
      expect(h.fixRequests).toEqual([]);
    },
  );

  test.each(ENVIRONMENT_ERRORS)(
    "does not record the round $name stopped, so that it is not counted as a failure",
    async ({ error }) => {
      const h = harness({ checksError: error });
      await run(h);
      expect(h.recorded).toEqual([]);
    },
  );

  test.each(ENVIRONMENT_ERRORS)(
    "keeps the failed rounds before $name",
    async ({ error }) => {
      const h = harness({
        checks: [[FAIL]],
        checksErrorFrom: { at: 1, error },
      });
      await run(h);
      expect(h.recorded.map((record) => record.outcome)).toEqual([
        "check_failed",
      ]);
    },
  );

  test("passes another error from the checks through", async () => {
    const h = harness({ checksError: new Error("disk full") });
    await expect(run(h)).rejects.toThrow("disk full");
  });

  // 検査コマンドが見つからず、setpriv自身が実行に失敗したときは、コードの失敗ではなく環境の問題である。
  const SETPRIV_MISSING: LoopCheckResult = {
    command: "bunx --bun biome check .",
    ok: false,
    exitCode: 127,
    output: "setpriv: failed to execute bunx: No such file or directory",
    outputTail: "setpriv: failed to execute bunx: No such file or directory",
  };
  const SETPRIV_NOT_EXECUTABLE: LoopCheckResult = {
    ...SETPRIV_MISSING,
    exitCode: 126,
    output: "setpriv: failed to execute bunx: Permission denied",
    outputTail: "setpriv: failed to execute bunx: Permission denied",
  };
  const UNRUNNABLE_CASES = [
    { name: "exit 127", result: SETPRIV_MISSING },
    { name: "exit 126", result: SETPRIV_NOT_EXECUTABLE },
  ];

  test.each(UNRUNNABLE_CASES)(
    "exits check_unrunnable when setpriv could not execute a check ($name)",
    async ({ result }) => {
      const h = harness({ checks: [[PASS, result]] });
      expect((await run(h)).exit).toBe("check_unrunnable");
    },
  );

  test("gives the command and setpriv's message as the unrunnable reason", async () => {
    const h = harness({ checks: [[SETPRIV_MISSING]] });
    expect((await run(h)).reason).toBe(
      checkUnrunnableReason(
        "bunx --bun biome check .",
        "setpriv: failed to execute bunx: No such file or directory",
      ),
    );
  });

  test("builds the unrunnable reason without a reason separator", () => {
    expect(checkUnrunnableReason("a; b", "c; d")).toBe(
      "check command could not run: a, b: c, d",
    );
  });

  test("builds an unrunnable reason that names the command and the detail", () => {
    expect(checkUnrunnableReason("bun test", "setpriv: failed")).toBe(
      "check command could not run: bun test: setpriv: failed",
    );
  });

  test("does not start a fix round when a check could not run", async () => {
    const h = harness({ checks: [[SETPRIV_MISSING]] });
    await run(h);
    expect(h.fixRequests).toEqual([]);
  });

  test("does not record the round whose check could not run, so that it is not counted as a model failure", async () => {
    const h = harness({ checks: [[SETPRIV_MISSING]] });
    await run(h);
    expect(h.recorded).toEqual([]);
  });

  test("records no verified tree when a check could not run", async () => {
    const h = harness({ checks: [[SETPRIV_MISSING]] });
    expect((await run(h)).verified_tree_sha).toBeNull();
  });

  test("keeps the failed rounds before the check that could not run", async () => {
    const h = harness({ checks: [[FAIL], [SETPRIV_MISSING]] });
    await run(h);
    expect(h.recorded.map((record) => record.outcome)).toEqual([
      "check_failed",
    ]);
  });

  test("starts a fix round when the check's own program exits 127", async () => {
    const h = harness({
      checks: [
        [
          {
            ...FAIL,
            exitCode: 127,
            output: "sh: 1: foo: not found",
            outputTail: "sh: 1: foo: not found",
          },
        ],
        [PASS],
      ],
      fingerprints: [FP_1, FP_2],
    });
    expect((await run(h)).exit).toBe("checks_passed");
  });

  test("is unrunnable for a program given by an absolute path", async () => {
    const output =
      "setpriv: failed to execute /usr/bin/foo: No such file or directory";
    const h = harness({
      checks: [
        [
          {
            ...SETPRIV_MISSING,
            command: "/usr/bin/foo",
            output,
            outputTail: output,
          },
        ],
      ],
    });
    expect((await run(h)).exit).toBe("check_unrunnable");
  });

  test("starts a fix round when the setpriv line is not the first line of the output", async () => {
    const output = `running tests\n${SETPRIV_MISSING.output}`;
    const h = harness({
      checks: [[{ ...SETPRIV_MISSING, output, outputTail: output }], [PASS]],
      fingerprints: [FP_1, FP_2],
    });
    expect((await run(h)).exit).toBe("checks_passed");
  });

  test("starts a fix round when a program given by a relative path could not run", async () => {
    const output =
      "setpriv: failed to execute scripts/check.sh: Permission denied";
    const h = harness({
      checks: [
        [
          {
            ...SETPRIV_NOT_EXECUTABLE,
            command: "scripts/check.sh",
            output,
            outputTail: output,
          },
        ],
        [PASS],
      ],
      fingerprints: [FP_1, FP_2],
    });
    expect((await run(h)).exit).toBe("checks_passed");
  });

  test("starts a fix round when the setpriv message comes with another exit code", async () => {
    const h = harness({
      checks: [[{ ...SETPRIV_MISSING, exitCode: 1 }], [PASS]],
      fingerprints: [FP_1, FP_2],
    });
    expect((await run(h)).exit).toBe("checks_passed");
  });

  test("exits worktree_changed when gitleaks scanned another tree than the inspected one", async () => {
    const h = harness({ scannedTrees: [FP_2.treeSha] });
    expect((await run(h)).exit).toBe("worktree_changed");
  });

  test("gives the round when gitleaks scanned another tree", async () => {
    const h = harness({ scannedTrees: [FP_2.treeSha] });
    expect((await run(h)).reason).toBe(scannedTreeChangedReason(1));
  });

  test("does not run check commands when gitleaks scanned another tree", async () => {
    const h = harness({ scannedTrees: [FP_2.treeSha] });
    await run(h);
    expect(h.calls.checks).toBe(0);
  });

  test("records no verified tree when gitleaks scanned another tree", async () => {
    const h = harness({ scannedTrees: [FP_2.treeSha] });
    expect((await run(h)).verified_tree_sha).toBeNull();
  });

  test("records the round as failed when gitleaks scanned another tree", async () => {
    const h = harness({ scannedTrees: [FP_2.treeSha] });
    await run(h);
    expect(h.recorded.at(-1)?.outcome).toBe("check_failed");
  });

  test("keeps a symlink path with the reason separator in one reason item", async () => {
    const h = harness({
      inspection: {
        ...CLEAN,
        symlinkReasons: [
          "symlink_change: symlink changed: a; needs human attention",
          "symlink_change: symlink changed: b",
        ],
      },
    });
    expect((await run(h)).reason).toBe(
      "symlink_change: symlink changed: a, needs human attention; symlink_change: symlink changed: b",
    );
  });

  test("stops on a symlink change before scanning for secrets", async () => {
    const h = harness({
      inspection: {
        ...CLEAN,
        symlinkReasons: ["symlink_change: symlink changed: link"],
      },
    });
    await run(h);
    expect(h.calls.gitleaks).toBe(0);
  });

  test("exits diff_too_large when the guard fires", async () => {
    const h = harness({
      sizeReasons: [
        "diff line total 4000 exceeds implement_max_diff_lines 3000",
      ],
    });
    expect((await run(h)).exit).toBe("diff_too_large");
  });

  test("uses the diff-size guard's text as the reason", async () => {
    const h = harness({
      sizeReasons: [
        "diff line total 4000 exceeds implement_max_diff_lines 3000",
      ],
    });
    expect((await run(h)).reason).toBe(
      "diff line total 4000 exceeds implement_max_diff_lines 3000",
    );
  });

  test("treats a gitleaks finding as a failure to fix", async () => {
    const h = harness({
      gitleaks: [GITLEAKS_LEAK, GITLEAKS_OK],
      fingerprints: [FP_1, FP_2],
    });
    await run(h);
    expect(h.fixRequests[0]?.failures[0]).toEqual({
      command: GITLEAKS_CHECK_NAME,
      outputTail: "- github-pat: a.txt:3",
    });
  });

  test("still fails a protected-path round whose gitleaks scan fails", async () => {
    const h = harness({
      inspection: PROTECTED,
      gitleaks: [GITLEAKS_LEAK, GITLEAKS_OK],
      fingerprints: [FP_1, FP_2],
    });
    await run(h);
    expect(h.fixRequests).toHaveLength(1);
  });

  test("checks the worktree's .git pointer before fingerprinting", async () => {
    const h = harness();
    await run(h);
    expect(h.events.slice(1, 3)).toEqual(["pointer", "fingerprint"]);
  });

  test("checks the .git pointer before and after a fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.events.filter((event) => event === "pointer")).toHaveLength(3);
  });

  test("checks the .git pointer right before starting a fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    const afterChecks = h.events.indexOf("checks") + 1;
    expect(h.events.slice(afterChecks, afterChecks + 2)).toEqual([
      "lease",
      "pointer",
    ]);
  });

  test("does not start a fix round when the checks changed the .git pointer", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      pointerError: { from: 1, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.fixRequests).toHaveLength(0);
  });

  test("exits git_pointer_modified when the checks changed the .git pointer", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      pointerError: { from: 1, error: new WorktreeGitPointerModifiedError() },
    });
    expect(await run(h)).toMatchObject({
      exit: "git_pointer_modified",
      reason: "worktree git pointer was modified",
    });
  });

  test("exits git_pointer_modified when the .git pointer changed", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h)).exit).toBe("git_pointer_modified");
  });

  test("runs no git command after a modified .git pointer", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.calls.fingerprint).toBe(0);
  });

  test("uses the pointer error's text as the reason", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h)).reason).toBe("worktree git pointer was modified");
  });

  test("records a modified .git pointer as a check_failed round", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.recorded[0]?.outcome).toBe("check_failed");
  });

  test("records the pointer reason in check_output", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    await run(h);
    expect(h.recorded[0]?.check_output).toBe(
      "worktree git pointer was modified",
    );
  });

  test("stops a fix round that modified the .git pointer", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      pointerError: { from: 2, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h)).exit).toBe("git_pointer_modified");
  });

  test("checks the .git pointer even after a failed Claude run", async () => {
    const h = harness({
      pointerError: { from: 0, error: new WorktreeGitPointerModifiedError() },
    });
    expect((await run(h, loopInput(FAILED))).exit).toBe("git_pointer_modified");
  });

  test("rethrows any other error from the pointer check", async () => {
    const h = harness({
      pointerError: { from: 0, error: new Error("EIO") },
    });
    await expect(run(h)).rejects.toThrow("EIO");
  });

  test("removes ignored files right before the check commands", async () => {
    const h = harness();
    await run(h);
    expect(h.events.slice(-2)).toEqual(["clean", "checks"]);
  });

  test("removes ignored files again before a fix round's checks", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.events.filter((event) => event === "clean")).toHaveLength(2);
  });

  test("does not remove ignored files when no check command runs", async () => {
    const h = harness();
    await run(h, loopInput(outputRound(), { hasCheckCommands: false }));
    expect(h.events).not.toContain("clean");
  });

  test("does not remove ignored files in a round that changed a protected path", async () => {
    const h = harness({ inspection: PROTECTED });
    await run(h);
    expect(h.events).not.toContain("clean");
  });

  test("returns the passing round's tree as verified_tree_sha", async () => {
    expect((await run(harness())).verified_tree_sha).toBe(FP_1.treeSha);
  });

  test("returns the skipped round's tree as verified_tree_sha", async () => {
    expect(
      (
        await run(
          harness(),
          loopInput(outputRound(), { hasCheckCommands: false }),
        )
      ).verified_tree_sha,
    ).toBe(FP_1.treeSha);
  });

  test("returns the last passing round's tree after a fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    expect((await run(h)).verified_tree_sha).toBe(FP_2.treeSha);
  });

  test("has no verified tree when the checks never passed", async () => {
    expect(
      (
        await run(
          harness({ checks: [[FAIL]] }),
          loopInput(outputRound(), { maxRounds: 1 }),
        )
      ).verified_tree_sha,
    ).toBeNull();
  });

  test("stops with lease_lost before a fix round once the lease is gone", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    expect((await run(h)).exit).toBe("lease_lost");
  });

  test("starts no fix round once the lease is gone", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    await run(h);
    expect(h.fixRequests).toHaveLength(0);
  });

  test("reports the lease-lost reason", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    expect((await run(h)).reason).toBe(IMPLEMENT_LEASE_LOST_REASON);
  });

  test("checks the lease at each round start and before the fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h);
    expect(h.events.filter((event) => event === "lease")).toHaveLength(3);
  });

  test("checks the lease before touching the worktree", async () => {
    const h = harness();
    await run(h);
    expect(h.events[0]).toBe("lease");
  });

  test("stops with lease_lost when the lease is gone at the start of a round", async () => {
    const h = harness({ leaseLostFrom: 0 });
    expect((await run(h)).exit).toBe("lease_lost");
  });

  test("touches no worktree when the lease is gone at the start of a round", async () => {
    const h = harness({ leaseLostFrom: 0 });
    await run(h);
    expect(h.events).toEqual(["lease"]);
  });

  test("records no round when the lease is gone at the start of a round", async () => {
    const h = harness({ leaseLostFrom: 0 });
    await run(h);
    expect(h.recorded).toHaveLength(0);
  });

  test("stops at the start of the round after a fix round once the lease is gone", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      leaseLostFrom: 2,
    });
    expect((await run(h)).exit).toBe("lease_lost");
  });

  test("does not fingerprint the fix round's worktree once the lease is gone", async () => {
    const h = harness({
      checks: [[FAIL], [PASS]],
      fingerprints: [FP_1, FP_2],
      leaseLostFrom: 2,
    });
    await run(h);
    expect(h.calls.fingerprint).toBe(1);
  });

  test("stops with lease_lost when generate lost the lease", async () => {
    const h = harness();
    expect((await run(h, loopInput(LEASE_LOST_ROUND))).exit).toBe("lease_lost");
  });

  test("touches nothing when generate lost the lease", async () => {
    const h = harness();
    await run(h, loopInput(LEASE_LOST_ROUND));
    expect(h.events).toEqual([]);
  });

  test("counts no Claude run when generate lost the lease", async () => {
    const h = harness();
    expect((await run(h, loopInput(LEASE_LOST_ROUND))).rounds).toBe(0);
  });

  test("exits deadline when the time left is under the worst-case fix round", async () => {
    const h = harness({ checks: [[FAIL]] });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 7_859_999 }))).exit,
    ).toBe("deadline");
  });

  test("starts a fix round when the time left covers the worst-case fix round", async () => {
    const h = harness({ checks: [[FAIL], [PASS]], fingerprints: [FP_1, FP_2] });
    await run(h, loopInput(outputRound(), { deadlineAt: 7_860_000 }));
    expect(h.fixRequests).toHaveLength(1);
  });

  test("measures the time left from now", async () => {
    const h = harness({ checks: [[FAIL]], now: 1 });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 7_860_000 }))).exit,
    ).toBe("deadline");
  });

  test("gives the deadline exit an English reason describeReason knows", async () => {
    const h = harness({ checks: [[FAIL]] });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 0 }))).reason,
    ).toBe("implement flow deadline reached after round 1");
  });

  test("does not start a fix round at the deadline", async () => {
    const h = harness({ checks: [[FAIL]] });
    await run(h, loopInput(outputRound(), { deadlineAt: 0 }));
    expect(h.fixRequests).toHaveLength(0);
  });

  test("records the round stopped by the deadline as check_failed", async () => {
    const h = harness({ checks: [[FAIL]] });
    await run(h, loopInput(outputRound(), { deadlineAt: 0 }));
    expect(h.recorded[0]?.outcome).toBe("check_failed");
  });

  test("still runs the check commands past the deadline", async () => {
    const h = harness({ checks: [[FAIL]] });
    await run(h, loopInput(outputRound(), { deadlineAt: 0 }));
    expect(h.calls.checks).toBe(1);
  });

  test("still opens a PR when the checks pass past the deadline", async () => {
    expect(
      (await run(harness(), loopInput(outputRound(), { deadlineAt: 0 }))).exit,
    ).toBe("checks_passed");
  });

  test("keeps claude_error for a Claude run cut by the deadline", async () => {
    expect(
      (await run(harness(), loopInput(FAILED, { deadlineAt: 0 }))).exit,
    ).toBe("claude_error");
  });

  test("notes the deadline on a Claude timeout past it", async () => {
    expect(
      (await run(harness(), loopInput(FAILED, { deadlineAt: 0 }))).reason,
    ).toBe(
      `claude run failed (timeout): timed out; ${deadlinePassedReason(1)}`,
    );
  });

  test("leaves a Claude timeout before the deadline as it was", async () => {
    expect((await run(harness(), loopInput(FAILED))).reason).toBe(
      "claude run failed (timeout): timed out",
    );
  });

  test("does not blame the deadline for a Claude failure other than a timeout", async () => {
    expect(
      (await run(harness(), loopInput(FAILED_EXIT, { deadlineAt: 0 }))).reason,
    ).toBe("claude run failed (non_zero_exit): exit 1");
  });

  test("prefers the round-start lease check over the deadline", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 0 });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 0 }))).exit,
    ).toBe("lease_lost");
  });

  test("decides the deadline before the lease check ahead of a fix round", async () => {
    const h = harness({ checks: [[FAIL]], leaseLostFrom: 1 });
    expect(
      (await run(h, loopInput(outputRound(), { deadlineAt: 0 }))).exit,
    ).toBe("deadline");
  });

  test("stops a lease-lost first round without looking at the deadline", async () => {
    expect(
      (await run(harness(), loopInput(LEASE_LOST_ROUND, { deadlineAt: 0 })))
        .exit,
    ).toBe("lease_lost");
  });
});

describe("runImplementVerifyLoop and a requirements directory that cannot be trusted", () => {
  const UNTRUSTED: ImplementClaudeRound = {
    kind: "requirements_modified",
    reason: REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
  };

  test("lists the kind among the rounds that the flow accepts", () => {
    expect(IMPLEMENT_CLAUDE_ROUND_KINDS).toContain("requirements_modified");
  });

  test("stops the first round with claude_error", async () => {
    expect((await run(harness(), loopInput(UNTRUSTED))).exit).toBe(
      "claude_error",
    );
  });

  test("carries the reason of the round", async () => {
    expect((await run(harness(), loopInput(UNTRUSTED))).reason).toBe(
      REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    );
  });

  test("does not count a round that never ran Claude", async () => {
    expect((await run(harness(), loopInput(UNTRUSTED))).rounds).toBe(0);
  });

  test("does not touch the worktree in the first round", async () => {
    const h = harness();
    await run(h, loopInput(UNTRUSTED));
    expect(h.events.filter((event) => event !== "lease")).toEqual([]);
  });

  test("records no round for the first round", async () => {
    const h = harness();
    await run(h, loopInput(UNTRUSTED));
    expect(h.recorded).toEqual([]);
  });

  const FAILING_CHECK: LoopCheckResult = {
    command: "bun test",
    ok: false,
    output: "FAIL",
    outputTail: "FAIL",
  };

  test("stops a fix round with claude_error too", async () => {
    const h = harness({ checks: [[FAILING_CHECK]], fixRounds: [UNTRUSTED] });
    expect((await run(h)).exit).toBe("claude_error");
  });

  test("carries the reason of a fix round", async () => {
    const h = harness({ checks: [[FAILING_CHECK]], fixRounds: [UNTRUSTED] });
    expect((await run(h)).reason).toBe(
      REQUIREMENTS_MODIFIED_BEFORE_IMPLEMENT_REASON,
    );
  });

  test("counts only the rounds that ran Claude when a fix round stops", async () => {
    const h = harness({ checks: [[FAILING_CHECK]], fixRounds: [UNTRUSTED] });
    expect((await run(h)).rounds).toBe(1);
  });

  test("records only the first round when a fix round stops", async () => {
    const h = harness({ checks: [[FAILING_CHECK]], fixRounds: [UNTRUSTED] });
    await run(h);
    expect(h.recorded.map((record) => record.mode)).toEqual(["implement"]);
  });

  test("does not verify the worktree again after a fix round stops", async () => {
    const h = harness({ checks: [[FAILING_CHECK]], fixRounds: [UNTRUSTED] });
    await run(h);
    expect(h.calls.checks).toBe(1);
  });

  test("carries the missing reason", async () => {
    const missing: ImplementClaudeRound = {
      kind: "requirements_modified",
      reason: REQUIREMENTS_DIR_MISSING_REASON,
    };
    expect((await run(harness(), loopInput(missing))).reason).toBe(
      REQUIREMENTS_DIR_MISSING_REASON,
    );
  });
});

describe("runImplementGenerateRound", () => {
  test("returns a lease_lost round when the lease is gone", async () => {
    expect(
      await runImplementGenerateRound({
        holdsLease: async () => false,
        runRound: async () => outputRound(),
      }),
    ).toEqual(LEASE_LOST_ROUND);
  });

  test("does not run Claude when the lease is gone", async () => {
    let ran = false;
    await runImplementGenerateRound({
      holdsLease: async () => false,
      runRound: async () => {
        ran = true;
        return outputRound();
      },
    });
    expect(ran).toBe(false);
  });

  test("runs the round while the lease is held", async () => {
    expect(
      await runImplementGenerateRound({
        holdsLease: async () => true,
        runRound: async () => outputRound(DONE, 7),
      }),
    ).toEqual(outputRound(DONE, 7));
  });
});

describe("ranClaude", () => {
  test("is true for a round with an output", () => {
    expect(ranClaude(outputRound(DONE, 7))).toBe(true);
  });

  test("is false for a round that lost the lease", () => {
    expect(ranClaude({ kind: "lease_lost" })).toBe(false);
  });

  test("is false for a round stopped by the requirements check", () => {
    expect(ranClaude({ kind: "requirements_modified", reason: "r" })).toBe(
      false,
    );
  });
});

describe("IMPLEMENT_LOOP_EXITS", () => {
  test("lists design_gap", () => {
    expect(IMPLEMENT_LOOP_EXITS).toContain("design_gap");
  });
});

describe("implementContextHasDesign", () => {
  test("is true for a design", () => {
    expect(implementContextHasDesign({ design_markdown: "## 設計" })).toBe(
      true,
    );
  });

  test("is false for a null design", () => {
    expect(implementContextHasDesign({ design_markdown: null })).toBe(false);
  });

  test("is false for a context made before the design was added", () => {
    expect(implementContextHasDesign({})).toBe(false);
  });
});

describe("the output contract note", () => {
  test("keeps the note without a design byte for byte", () => {
    expect(IMPLEMENT_OUTPUT_CONTRACT_NOTE).toBe(
      [
        "Your previous structured output broke the output contract, so the flow could not use it.",
        '- outcome "done": gap_report is null; commit_subject is one non-empty line of at most 72 code points, not ending in "…", without control characters.',
        '- outcome "requirements_gap": gap_report is a non-empty string; commit_subject and commit_body are both "".',
        "Answer again with an output that follows these rules.",
      ].join("\n"),
    );
  });

  test("adds the design_gap rule when a design was given", () => {
    expect(IMPLEMENT_OUTPUT_CONTRACT_NOTE_WITH_DESIGN_GAP).toContain(
      '- outcome "design_gap": gap_report is a non-empty string; commit_subject and commit_body are both "".',
    );
  });

  test("selects the note without a design", () => {
    expect(implementOutputContractNote(false)).toBe(
      IMPLEMENT_OUTPUT_CONTRACT_NOTE,
    );
  });

  test("selects the note with design_gap when a design was given", () => {
    expect(implementOutputContractNote(true)).toBe(
      IMPLEMENT_OUTPUT_CONTRACT_NOTE_WITH_DESIGN_GAP,
    );
  });
});
