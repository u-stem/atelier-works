import { describe, expect, test } from "bun:test";
import type { NewDesignDraft } from "../../f/factory/lib/db.ts";
import { REQUIREMENTS_REGENERATION_FAILED_REASON } from "../../f/factory/lib/implement_finish_support.ts";
import {
  AUTOMATED_FEEDBACK_MARKER,
  type DesignOutput,
} from "../../f/factory/lib/prompts.ts";
import type {
  DesignDraft,
  RequirementDraft,
  WorkItem,
} from "../../f/factory/lib/types.ts";
import {
  DESIGN_GAP_REPORT_MAX_CHARS,
  type DesignClaudeRequest,
  type DesignClaudeResult,
  type DesignGenerateDeps,
  type DesignGenerateFs,
  runDesignGenerate,
} from "../../f/factory/steps/design_generate.ts";

const LEASE = "0191f1a2-0000-7000-8000-000000000001";
const OTHER = "0191f1a2-0000-7000-8000-000000000002";
const PIPELINE_JOB = "0191F1A2-0000-7000-8000-0000000000AA";
const HEAD_SHA = "b".repeat(40);
const DATE = new Date("2026-10-26T00:00:00Z");
const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

const WORKTREE = "/workspaces/acme/widgets/design-42";
const REQUIREMENTS_DIR =
  "/var/lib/factory/requirements/acme/widgets/issue-42/wi-7/attempt-2";
const DESIGN_DIR =
  "/var/lib/factory/requirements/acme/widgets/issue-42/wi-7/design/req-2/attempt-3";
const TEMPLATE_PATH = "/factory/.claude/skills/factory-design/template.md";
const TEMPLATE = "TEMPLATE_BODY";

const DRAWIO = [
  '<mxfile host="app.diagrams.net">',
  '  <diagram name="sample" id="d1">',
  '    <mxGraphModel dx="800" dy="600">',
  "      <root>",
  '        <mxCell id="0" />',
  '        <mxCell id="1" parent="0" />',
  '        <mxCell id="n1" value="start" vertex="1" parent="1">',
  '          <mxGeometry x="40" y="40" width="160" height="60" as="geometry" />',
  "        </mxCell>",
  "      </root>",
  "    </mxGraphModel>",
  "  </diagram>",
  "</mxfile>",
].join("\n");

const VALID_DOC = `# 設計: 例の機能

対象: acme/widgets Issue #42 / 要件の試行: 2 / 設計の試行: 3

## 方針

既存の保存処理を拡張する。

## 構成要素と境界

| 構成要素 | 責務 | 境界 |
| --- | --- | --- |
| 保存処理 | 下書きを保存する | リースを持つ実行だけが書く |

## データの流れ

要件定義を読み、設計書を作って保存する。

![data-flow](data-flow.drawio)

## インターフェース

| 名前 | 入力 | 出力 |
| --- | --- | --- |
| 保存 | 作業項目の識別子 | 下書きの識別子 |

## エラーと境界条件

| 条件 | 扱い |
| --- | --- |
| リースを失った | 何も書かずに終える |

## テスト方針

| 観点 | 方法 |
| --- | --- |
| 保存 | 単体テスト |

## 要件との対応表

| ID | 対象要件 | 設計の対応 |
| --- | --- | --- |
| DS-001 | FR-001 | 保存処理が下書きを保存する |

## 未決事項

| 論点 | 仮置き | 影響 |
| --- | --- | --- |
| 保持期間 | 無期限 | 容量が増える |

## 変更履歴

| 試行 | 変更内容 |
| --- | --- |
| attempt 1 | 初版 |
`;

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 7,
    cycle: 1,
    source: "issue",
    kind: "issue",
    owner: "acme",
    repo: "widgets",
    issue_number: 42,
    issue_url: "https://github.com/acme/widgets/issues/42",
    pr_number: null,
    title: "Add feature",
    body: "body",
    status: "designing",
    attempt: 2,
    claimed_by: null,
    flow_job_id: LEASE,
    resume_url: null,
    cancel_url: null,
    head_sha: null,
    last_review_id: null,
    last_comment_id: null,
    last_review_comment_id: null,
    observed_review_id: null,
    observed_comment_id: null,
    observed_review_comment_id: null,
    fix_round: 0,
    parent_work_item_id: null,
    branch: null,
    pr_url: null,
    ci_check_id: null,
    conflict_check_id: null,
    conflict_episode: null,
    design_attempt: 3,
    created_at: DATE,
    updated_at: DATE,
    ...overrides,
  };
}

function requirementDraft(
  overrides: Partial<RequirementDraft> = {},
): RequirementDraft {
  return {
    id: 5,
    work_item_id: 7,
    attempt: 2,
    summary: "s",
    markdown: "UNIQUE_APPROVED_REQUIREMENTS_MARKER_9917",
    diagrams: [{ name: "flow", file: "flow.drawio" }],
    open_questions: [],
    doc_dir: REQUIREMENTS_DIR,
    created_at: DATE,
    ...overrides,
  };
}

const DESIGNED: DesignOutput = {
  outcome: "designed",
  summary: "設計の要約",
  open_questions: ["論点: a / 仮置き: b / 影響: c"],
  gap_report: null,
};

function gapOutput(report: string): DesignOutput {
  return {
    outcome: "requirements_gap",
    summary: "",
    open_questions: [],
    gap_report: report,
  };
}

/** 偽のファイルシステム。パスは文字列のキー、ディレクトリはキーの接頭辞で表す。 */
function memoryFs(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  const removedPaths: string[] = [];
  const copies: { source: string; destination: string }[] = [];
  let temps = 0;
  const under = (dir: string): string[] =>
    [...files.keys()].filter((key) => key.startsWith(`${dir}/`));
  const fs: DesignGenerateFs = {
    ensureEmptyDir: async (dir) => {
      for (const key of under(dir)) files.delete(key);
    },
    copyFile: async (source, destination) => {
      const content = files.get(source);
      if (content === undefined) throw new Error(`ENOENT: ${source}`);
      copies.push({ source, destination });
      files.set(destination, content);
    },
    readDir: async (dir) => [
      ...new Set(
        under(dir).map((key) => key.slice(dir.length + 1).split("/")[0] ?? ""),
      ),
    ],
    readText: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    removePath: async (path) => {
      removedPaths.push(path);
      files.delete(path);
      for (const key of under(path)) files.delete(key);
    },
    makeTempDir: async () => {
      temps += 1;
      return `/job-tmp/copy-${String(temps)}`;
    },
    hashTree: async (dir) => {
      const keys = under(dir).sort();
      if (keys.length === 0) return null;
      return keys.map((key) => `${key}\0${files.get(key)}`).join("\n");
    },
  };
  return { fs, files, removedPaths, copies, under };
}

type Options = {
  readonly item?: WorkItem | null;
  readonly approved?: RequirementDraft | null;
  readonly previous?: DesignDraft | null;
  readonly budget?: { exceeded: boolean; spent_usd: number; limit_usd: number };
  readonly maxAttempts?: number;
  readonly claude?: (
    request: DesignClaudeRequest,
    ctx: Context,
  ) => Promise<DesignClaudeResult>;
  readonly files?: Record<string, string>;
  readonly pipelineJob?: () => Promise<string>;
  readonly recordPipeline?: () => Promise<boolean>;
  readonly rollbackAccepted?: boolean;
  readonly removeWorktree?: () => Promise<void>;
};

type Context = {
  readonly world: { item: WorkItem | null };
  readonly memory: ReturnType<typeof memoryFs>;
  readonly calls: string[];
};

function harness(options: Options = {}) {
  const calls: string[] = [];
  const requests: DesignClaudeRequest[] = [];
  const saved: NewDesignDraft[] = [];
  const moves: { to: string; reason: string }[] = [];
  const notified: string[] = [];
  const returnNotes: string[] = [];
  const launches: { attempt: number; feedback: string }[] = [];
  const recordedJobs: string[] = [];
  const rollbacks: string[] = [];
  const snapshots: { designDir: string[]; copyDir: string[] }[] = [];
  const removedWorktrees: string[] = [];
  const world: { item: WorkItem | null } = {
    item: options.item === undefined ? workItem() : options.item,
  };
  const memory = memoryFs({
    [TEMPLATE_PATH]: TEMPLATE,
    [`${REQUIREMENTS_DIR}/requirements.md`]: "REQUIREMENTS_FILE",
    [`${REQUIREMENTS_DIR}/flow.drawio`]: DRAWIO,
    [`${REQUIREMENTS_DIR}/other.drawio`]: DRAWIO,
    ...options.files,
  });
  const ctx: Context = { world, memory, calls };
  const holds = (): boolean =>
    world.item !== null &&
    world.item.status === "designing" &&
    world.item.flow_job_id === LEASE;
  const approved =
    options.approved === undefined ? requirementDraft() : options.approved;
  const defaultClaude = async (
    request: DesignClaudeRequest,
  ): Promise<DesignClaudeResult> => {
    memory.files.set(`${request.cwd}/design.md`, VALID_DOC);
    memory.files.set(`${request.cwd}/data-flow.drawio`, DRAWIO);
    return { outcome: "success", output: DESIGNED };
  };
  let cleanups = 0;
  let opens = 0;
  const startContents: (string | undefined)[] = [];
  const deps: DesignGenerateDeps = {
    config: {
      model: "light-model",
      heavy_model: "heavy-model",
      max_attempts: options.maxAttempts ?? 3,
    },
    leaseJobId: LEASE,
    getWorkItem: async () => world.item,
    dailyBudget: async () => {
      calls.push("budget");
      return options.budget ?? { exceeded: false, spent_usd: 0, limit_usd: 5 };
    },
    moveFromDesigning: async (to, reason) => {
      calls.push(`move:${to}`);
      moves.push({ to, reason });
      if (!holds() || world.item === null) return false;
      world.item = { ...world.item, status: to };
      return true;
    },
    returnToRequirements: async (note) => {
      calls.push("return_to_requirements");
      returnNotes.push(note);
      if (!holds() || world.item === null) return false;
      world.item = {
        ...world.item,
        status: "requirements_generating",
        design_attempt: 0,
        flow_job_id: null,
      };
      return true;
    },
    notifyNeedsHuman: async (_item, reason) => {
      calls.push("notify");
      notified.push(reason);
    },
    loadApprovedRequirements: async () => approved,
    latestDesignDraft: async () => options.previous ?? null,
    openFactory: async () => {
      opens += 1;
      return {
        systemPromptFile: "/job-tmp/system-prompt.md",
        templatePath: TEMPLATE_PATH,
        cleanup: async () => {
          cleanups += 1;
        },
      };
    },
    fs: memory.fs,
    runClaude: async (request) => {
      calls.push("claude");
      requests.push(request);
      startContents.push(memory.files.get(`${request.cwd}/design.md`));
      const copyDir = request.addDirs.find((dir) => dir !== WORKTREE);
      snapshots.push({
        designDir: memory
          .under(request.cwd)
          .map((key) => key.slice(request.cwd.length + 1)),
        copyDir:
          copyDir === undefined
            ? []
            : memory.under(copyDir).map((key) => key.slice(copyDir.length + 1)),
      });
      return (options.claude ?? defaultClaude)(request, ctx);
    },
    saveDesignDraft: async (draft) => {
      calls.push("save");
      if (!holds()) return null;
      saved.push(draft);
      return 99;
    },
    launchPipeline: async (input) => {
      calls.push("launch_pipeline");
      launches.push({ attempt: input.attempt, feedback: input.feedback });
      return options.pipelineJob === undefined
        ? PIPELINE_JOB
        : options.pipelineJob();
    },
    recordPipelineJobId: async (jobId) => {
      calls.push("record_pipeline_job");
      recordedJobs.push(jobId);
      return options.recordPipeline === undefined
        ? true
        : options.recordPipeline();
    },
    moveRequirementsToNeedsHuman: async (reason) => {
      calls.push("rollback_to_needs_human");
      rollbacks.push(reason);
      return options.rollbackAccepted ?? true;
    },
    removeWorktree: async (dir) => {
      calls.push("remove_worktree");
      removedWorktrees.push(dir);
      if (options.removeWorktree !== undefined) await options.removeWorktree();
    },
    log: () => {},
  };
  return {
    deps,
    calls,
    requests,
    saved,
    moves,
    notified,
    returnNotes,
    launches,
    recordedJobs,
    rollbacks,
    snapshots,
    removedWorktrees,
    world,
    memory,
    startContents,
    cleanups: () => cleanups,
    factoryOpens: () => opens,
  };
}

const INPUT = {
  work_item_id: 7,
  design_attempt: 3,
  feedback: null,
  worktree_dir: WORKTREE,
  head_sha: HEAD_SHA,
};

describe("runDesignGenerate and the lease", () => {
  test("throws when the work item does not exist", async () => {
    const h = harness({ item: null });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "no work item with id 7",
    );
  });

  test("throws when the issue has no number", async () => {
    const h = harness({ item: workItem({ issue_number: null }) });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "has no issue_number",
    );
  });

  test("reports lease_lost when another run holds the lease", async () => {
    const h = harness({ item: workItem({ flow_job_id: OTHER }) });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "lease_lost",
    });
  });

  test("reports lease_lost when the work item is not designing", async () => {
    const h = harness({
      item: workItem({ status: "awaiting_design_approval" }),
    });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "lease_lost",
    });
  });

  test("starts nothing without the lease", async () => {
    const h = harness({ item: workItem({ flow_job_id: OTHER }) });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls).toEqual([]);
  });

  test("does not open the factory without the lease", async () => {
    const h = harness({ item: workItem({ flow_job_id: OTHER }) });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.factoryOpens()).toBe(0);
  });
});

describe("runDesignGenerate and the daily budget", () => {
  const EXCEEDED = { exceeded: true, spent_usd: 5, limit_usd: 5 };

  test("does not start Claude when the budget is exceeded", async () => {
    const h = harness({ budget: EXCEEDED });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests).toEqual([]);
  });

  test("reports budget_exceeded", async () => {
    const h = harness({ budget: EXCEEDED });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "budget_exceeded",
    });
  });

  test("moves the work item to needs_human with the amounts", async () => {
    const h = harness({ budget: EXCEEDED });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.moves).toEqual([
      {
        to: "needs_human",
        reason: "daily budget exceeded ($5.00 >= $5.00)",
      },
    ]);
  });

  test("notifies the person", async () => {
    const h = harness({ budget: EXCEEDED });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.notified).toEqual(["daily budget exceeded ($5.00 >= $5.00)"]);
  });

  test("reports lease_lost when the move is refused", async () => {
    const h = harness({ budget: EXCEEDED });
    const result = await runDesignGenerate(
      { ...h.deps, moveFromDesigning: async () => false },
      INPUT,
    );
    expect(result).toEqual({ outcome: "lease_lost" });
  });

  test("does not notify when the move is refused", async () => {
    const h = harness({ budget: EXCEEDED });
    await runDesignGenerate(
      { ...h.deps, moveFromDesigning: async () => false },
      INPUT,
    );
    expect(h.notified).toEqual([]);
  });
});

describe("runDesignGenerate on success", () => {
  test("reports success", async () => {
    const h = harness();
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "success",
    });
  });

  test("saves exactly one draft", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved).toHaveLength(1);
  });

  test("ties the draft to the approved requirements", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved[0]?.requirement_draft_id).toBe(5);
  });

  test("records the head sha that the prepare step found", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved[0]?.head_sha).toBe(HEAD_SHA);
  });

  test("records the design attempt of the input", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved[0]?.design_attempt).toBe(3);
  });

  test("records the work item", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved[0]?.work_item_id).toBe(7);
  });

  test("records the directory of the design document", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved[0]?.doc_dir).toBe(DESIGN_DIR);
  });

  test("records the markdown that Claude wrote", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved[0]?.markdown).toBe(VALID_DOC);
  });

  test("records the summary and the open questions of Claude", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect([h.saved[0]?.summary, h.saved[0]?.open_questions]).toEqual([
      "設計の要約",
      ["論点: a / 仮置き: b / 影響: c"],
    ]);
  });

  test("records the diagrams by name and file", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved[0]?.diagrams).toEqual([
      { name: "data-flow", file: "data-flow.drawio" },
    ]);
  });

  test("saves after Claude ran", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls.indexOf("save")).toBeGreaterThan(h.calls.indexOf("claude"));
  });
});

describe("runDesignGenerate and what Claude can reach", () => {
  test("runs Claude in the directory of the design document", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.cwd).toBe(DESIGN_DIR);
  });

  test("lets Claude read the worktree of the target repository", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.addDirs).toContain(WORKTREE);
  });

  test("never hands the original directory of the requirements to Claude as an added directory", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.addDirs).not.toContain(REQUIREMENTS_DIR);
  });

  test("never hands the original directory of the requirements to Claude as the working directory", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.cwd).not.toBe(REQUIREMENTS_DIR);
  });

  test("hands over one copy of the requirements diagrams", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.addDirs).toHaveLength(2);
  });

  test("puts only the declared diagram in the copy", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.snapshots[0]?.copyDir).toEqual(["flow.drawio"]);
  });

  test("leaves out a diagram that the requirements do not declare", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.snapshots[0]?.copyDir).not.toContain("other.drawio");
  });

  test("leaves out the requirements document itself", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.snapshots[0]?.copyDir).not.toContain("requirements.md");
  });

  test("leaves out a declared file whose name is not a plain diagram name", async () => {
    const h = harness({
      approved: requirementDraft({
        diagrams: [
          { name: "x", file: "../escape.drawio" },
          { name: "flow", file: "flow.drawio" },
        ],
      }),
      files: { [`${REQUIREMENTS_DIR}/../escape.drawio`]: DRAWIO },
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.snapshots[0]?.copyDir).toEqual(["flow.drawio"]);
  });

  test("skips a declared diagram that is missing on disk", async () => {
    const h = harness({
      approved: requirementDraft({
        diagrams: [
          { name: "gone", file: "gone.drawio" },
          { name: "flow", file: "flow.drawio" },
        ],
      }),
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.snapshots[0]?.copyDir).toEqual(["flow.drawio"]);
  });

  test("hands over no copy when the requirements declare no diagram", async () => {
    const h = harness({ approved: requirementDraft({ diagrams: [] }) });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.addDirs).toEqual([WORKTREE]);
  });

  test("works when the requirements have no directory", async () => {
    const h = harness({ approved: requirementDraft({ doc_dir: null }) });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "success",
    });
  });

  test("hands over no copy when the requirements have no directory", async () => {
    const h = harness({ approved: requirementDraft({ doc_dir: null }) });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.addDirs).toEqual([WORKTREE]);
  });

  test.each([
    "/etc",
    "/var/lib/factory/requirements/../claude/x",
    "relative/path",
    "/var/lib/factory/requirements",
  ])("rejects the requirements directory %s", async (docDir) => {
    const h = harness({ approved: requirementDraft({ doc_dir: docDir }) });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "outside the requirements base directory",
    );
  });

  test("does not run Claude when the requirements directory is rejected", async () => {
    const h = harness({ approved: requirementDraft({ doc_dir: "/etc" }) });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.requests).toEqual([]);
  });

  test("gives Claude only the tools to read and to write its own files", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.tools).toEqual([
      "Read",
      "Glob",
      "Grep",
      "Write",
      "Edit",
    ]);
  });

  test("lets Claude write and edit without asking", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.allowedTools).toEqual(["Write", "Edit"]);
  });

  test("uses the heavy model", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.model).toBe("heavy-model");
  });

  test("passes the system prompt file of the factory", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.systemPromptFile).toBe("/job-tmp/system-prompt.md");
  });
});

describe("runDesignGenerate and the prompt", () => {
  test("carries the approved requirements", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.prompt).toContain(
      "UNIQUE_APPROVED_REQUIREMENTS_MARKER_9917",
    );
  });

  test("does not name the original directory of the requirements", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.prompt).not.toContain(REQUIREMENTS_DIR);
  });

  test("names the worktree of the target repository", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.prompt).toContain(WORKTREE);
  });

  test("includes the previous design of the same approved requirements", async () => {
    const previous: DesignDraft = {
      id: 1,
      work_item_id: 7,
      requirement_draft_id: 5,
      design_attempt: 1,
      summary: "s",
      markdown: "UNIQUE_PREVIOUS_DESIGN_3301",
      diagrams: [],
      open_questions: [],
      doc_dir: null,
      head_sha: null,
      created_at: DATE,
    };
    const h = harness({ previous });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.prompt).toContain("UNIQUE_PREVIOUS_DESIGN_3301");
  });

  test("leaves out a previous design made for other requirements", async () => {
    const previous: DesignDraft = {
      id: 1,
      work_item_id: 7,
      requirement_draft_id: 4,
      design_attempt: 1,
      summary: "s",
      markdown: "UNIQUE_PREVIOUS_DESIGN_3301",
      diagrams: [],
      open_questions: [],
      doc_dir: null,
      head_sha: null,
      created_at: DATE,
    };
    const h = harness({ previous });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.requests[0]?.prompt).not.toContain("UNIQUE_PREVIOUS_DESIGN_3301");
  });

  test("includes the rejection feedback", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, {
      ...INPUT,
      feedback: "UNIQUE_REJECTION_REASON_4408",
    });
    expect(h.requests[0]?.prompt).toContain("UNIQUE_REJECTION_REASON_4408");
  });

  test("treats an empty feedback as no feedback", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, { ...INPUT, feedback: "" });
    expect(h.requests[0]?.prompt).not.toContain("design rejection feedback");
  });
});

describe("runDesignGenerate and the output directory", () => {
  test("starts from the template", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.snapshots[0]?.designDir).toEqual(["design.md"]);
  });

  test("copies the template into design.md", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.startContents).toEqual([TEMPLATE]);
  });

  test("empties a directory that an earlier run left behind", async () => {
    const h = harness({ files: { [`${DESIGN_DIR}/old.drawio`]: "old" } });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.snapshots[0]?.designDir).not.toContain("old.drawio");
  });

  test("removes a file that Claude was not asked to write", async () => {
    const h = harness({
      claude: async (request, ctx) => {
        ctx.memory.files.set(`${request.cwd}/design.md`, VALID_DOC);
        ctx.memory.files.set(`${request.cwd}/data-flow.drawio`, DRAWIO);
        ctx.memory.files.set(`${request.cwd}/notes.txt`, "stray");
        return { outcome: "success", output: DESIGNED };
      },
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.memory.files.has(`${DESIGN_DIR}/notes.txt`)).toBe(false);
  });

  test("still saves the draft after it removed a stray file", async () => {
    const h = harness({
      claude: async (request, ctx) => {
        ctx.memory.files.set(`${request.cwd}/design.md`, VALID_DOC);
        ctx.memory.files.set(`${request.cwd}/data-flow.drawio`, DRAWIO);
        ctx.memory.files.set(`${request.cwd}/notes.txt`, "stray");
        return { outcome: "success", output: DESIGNED };
      },
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved).toHaveLength(1);
  });

  test("fails on a diagram whose XML is not valid", async () => {
    const h = harness({
      claude: async (request, ctx) => {
        ctx.memory.files.set(`${request.cwd}/design.md`, VALID_DOC);
        ctx.memory.files.set(`${request.cwd}/data-flow.drawio`, "<svg></svg>");
        return { outcome: "success", output: DESIGNED };
      },
    });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "failed validation",
    );
  });

  test("fails on a document that breaks the section list", async () => {
    const h = harness({
      claude: async (request, ctx) => {
        ctx.memory.files.set(
          `${request.cwd}/design.md`,
          VALID_DOC.replace("## テスト方針", "## 別の章"),
        );
        ctx.memory.files.set(`${request.cwd}/data-flow.drawio`, DRAWIO);
        return { outcome: "success", output: DESIGNED };
      },
    });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "failed validation",
    );
  });

  test("saves nothing when the document is invalid", async () => {
    const h = harness({
      claude: async (request, ctx) => {
        ctx.memory.files.set(`${request.cwd}/design.md`, "# 空");
        return { outcome: "success", output: DESIGNED };
      },
    });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.saved).toEqual([]);
  });

  test("fails when Claude does not write design.md", async () => {
    const h = harness({
      claude: async () => ({ outcome: "success", output: DESIGNED }),
    });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow("design.md");
  });

  test("hands Claude a way to review its own output", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    const issues = await h.requests[0]?.reviewOutput(DESIGNED);
    expect(issues).toEqual([]);
  });

  test("names the broken file in the review of a document with a problem", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    h.memory.files.set(`${DESIGN_DIR}/design.md`, "# 空");
    const issues = await h.requests[0]?.reviewOutput(DESIGNED);
    expect(issues?.some((issue) => issue.startsWith("design.md: "))).toBe(true);
  });

  test("does not review a report of a gap in the requirements", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    h.memory.files.set(`${DESIGN_DIR}/design.md`, "# 空");
    expect(await h.requests[0]?.reviewOutput(gapOutput("x"))).toEqual([]);
  });
});

describe("runDesignGenerate when Claude fails", () => {
  const FAILED: DesignClaudeResult = {
    outcome: "failure",
    reason: "non_zero_exit",
    detail: `exit 1 ${GITHUB_TOKEN}`,
  };

  test("throws with the reason", async () => {
    const h = harness({ claude: async () => FAILED });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "runClaude failed (non_zero_exit)",
    );
  });

  test("masks secrets in the error", async () => {
    const h = harness({ claude: async () => FAILED });
    const error = await runDesignGenerate(h.deps, INPUT).catch(
      (err: unknown) => err,
    );
    expect(String(error)).not.toContain(GITHUB_TOKEN);
  });

  test("saves nothing", async () => {
    const h = harness({ claude: async () => FAILED });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.saved).toEqual([]);
  });

  test("moves the work item nowhere: the failure handler of the flow decides", async () => {
    const h = harness({ claude: async () => FAILED });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.moves).toEqual([]);
  });

  test("still removes the worktree while it holds the lease", async () => {
    const h = harness({ claude: async () => FAILED });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.removedWorktrees).toEqual([WORKTREE]);
  });
});

describe("runDesignGenerate and the approved requirements on disk", () => {
  test("hashes the requirements directory before and after Claude", async () => {
    const hashed: (string | null)[] = [];
    const h = harness();
    const fs: DesignGenerateFs = {
      ...h.deps.fs,
      hashTree: async (dir) => {
        if (dir === REQUIREMENTS_DIR) hashed.push(dir);
        return h.deps.fs.hashTree(dir);
      },
    };
    await runDesignGenerate({ ...h.deps, fs }, INPUT);
    expect(hashed).toHaveLength(2);
  });

  test("saves when the requirements are untouched", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved).toHaveLength(1);
  });

  test.each([
    [
      "changed",
      (files: Map<string, string>) =>
        files.set(`${REQUIREMENTS_DIR}/requirements.md`, "changed"),
    ],
    [
      "added to",
      (files: Map<string, string>) =>
        files.set(`${REQUIREMENTS_DIR}/new.drawio`, DRAWIO),
    ],
    [
      "removed from",
      (files: Map<string, string>) =>
        files.delete(`${REQUIREMENTS_DIR}/flow.drawio`),
    ],
  ])(
    "stops without saving when the requirements are %s",
    async (_name, tamper) => {
      const h = harness({
        claude: async (request, ctx) => {
          ctx.memory.files.set(`${request.cwd}/design.md`, VALID_DOC);
          ctx.memory.files.set(`${request.cwd}/data-flow.drawio`, DRAWIO);
          tamper(ctx.memory.files);
          return { outcome: "success", output: DESIGNED };
        },
      });
      const result = await runDesignGenerate(h.deps, INPUT);
      expect([result.outcome, h.saved.length]).toEqual(["needs_human", 0]);
    },
  );

  test("moves the work item to needs_human under the lease", async () => {
    const h = harness({
      claude: async (_request, ctx) => {
        ctx.memory.files.set(`${REQUIREMENTS_DIR}/requirements.md`, "changed");
        return { outcome: "success", output: DESIGNED };
      },
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.moves).toEqual([
      {
        to: "needs_human",
        reason: "approved requirements were modified during design",
      },
    ]);
  });

  test("notifies the person of the change", async () => {
    const h = harness({
      claude: async (_request, ctx) => {
        ctx.memory.files.set(`${REQUIREMENTS_DIR}/requirements.md`, "changed");
        return { outcome: "success", output: DESIGNED };
      },
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.notified).toEqual([
      "approved requirements were modified during design",
    ]);
  });

  test("reports lease_lost instead when the lease is gone", async () => {
    const h = harness({
      claude: async (_request, ctx) => {
        ctx.memory.files.set(`${REQUIREMENTS_DIR}/requirements.md`, "changed");
        if (ctx.world.item !== null)
          ctx.world.item = { ...ctx.world.item, flow_job_id: OTHER };
        return { outcome: "success", output: DESIGNED };
      },
    });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "lease_lost",
    });
  });

  test("checks the requirements before it follows a report of a gap", async () => {
    const h = harness({
      claude: async (_request, ctx) => {
        ctx.memory.files.set(`${REQUIREMENTS_DIR}/requirements.md`, "changed");
        return { outcome: "success", output: gapOutput("a gap") };
      },
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls).not.toContain("launch_pipeline");
  });
});

describe("runDesignGenerate and losing the lease while Claude runs", () => {
  function losing() {
    return harness({
      claude: async (request, ctx) => {
        ctx.memory.files.set(`${request.cwd}/design.md`, VALID_DOC);
        ctx.memory.files.set(`${request.cwd}/data-flow.drawio`, DRAWIO);
        if (ctx.world.item !== null)
          ctx.world.item = { ...ctx.world.item, flow_job_id: OTHER };
        return { outcome: "success", output: DESIGNED };
      },
    });
  }

  test("reports lease_lost", async () => {
    const h = losing();
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "lease_lost",
    });
  });

  test("does not move the work item", async () => {
    const h = losing();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.moves).toEqual([]);
  });

  test("does not launch the pipeline", async () => {
    const h = losing();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls).not.toContain("launch_pipeline");
  });

  test("does not remove the worktree that the new owner may use", async () => {
    const h = losing();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.removedWorktrees).toEqual([]);
  });

  test("still removes the copy of the diagrams, which only this job uses", async () => {
    const h = losing();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.memory.removedPaths).toContain("/job-tmp/copy-1");
  });

  test("removes the copy of the diagrams when Claude fails after the lease moved on", async () => {
    const h = harness({
      claude: async (_request, ctx) => {
        if (ctx.world.item !== null)
          ctx.world.item = { ...ctx.world.item, flow_job_id: OTHER };
        throw new Error("claude crashed");
      },
    });
    await runDesignGenerate(h.deps, INPUT).catch(() => {});
    expect(h.memory.removedPaths).toContain("/job-tmp/copy-1");
  });

  test("still removes the system prompt file", async () => {
    const h = losing();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.cleanups()).toBe(1);
  });
});

describe("runDesignGenerate cleaning up", () => {
  test("removes the worktree of the input while it holds the lease", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.removedWorktrees).toEqual([WORKTREE]);
  });

  test("removes the copy of the diagrams while it holds the lease", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.memory.removedPaths).toContain("/job-tmp/copy-1");
  });

  test("removes the system prompt file", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.cleanups()).toBe(1);
  });

  test("removes the worktree after the draft is saved", async () => {
    const h = harness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls.indexOf("remove_worktree")).toBeGreaterThan(
      h.calls.indexOf("save"),
    );
  });

  test("keeps the result when removing the worktree fails", async () => {
    const h = harness({
      removeWorktree: async () => {
        throw new Error("busy");
      },
    });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "success",
    });
  });

  test("keeps the original error when removing the worktree fails too", async () => {
    const h = harness({
      claude: async () => ({
        outcome: "failure",
        reason: "timeout",
        detail: "slow",
      }),
      removeWorktree: async () => {
        throw new Error("busy");
      },
    });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "runClaude failed (timeout)",
    );
  });
});

describe("runDesignGenerate when the requirements have a gap", () => {
  const GAP = "FR-001とFR-002が矛盾している";

  function gapHarness(options: Options = {}) {
    return harness({
      claude: async () => ({ outcome: "success", output: gapOutput(GAP) }),
      ...options,
    });
  }

  test("reports requirements_gap", async () => {
    const h = gapHarness();
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "requirements_gap",
    });
  });

  test("saves no draft", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.saved).toEqual([]);
  });

  test("returns the work item to the requirements under the lease, with the gap in the note", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.returnNotes).toEqual([`design gap: ${GAP}`]);
  });

  test("launches the pipeline for the next attempt of the requirements", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.launches.map((launch) => launch.attempt)).toEqual([3]);
  });

  test("hands the gap to the pipeline as an automated report", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.launches[0]?.feedback).toBe(`${AUTOMATED_FEEDBACK_MARKER} ${GAP}`);
  });

  test("records the job id of the pipeline in lower case", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.recordedJobs).toEqual([PIPELINE_JOB.toLowerCase()]);
  });

  test("returns the work item before it launches the pipeline", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls.indexOf("return_to_requirements")).toBeLessThan(
      h.calls.indexOf("launch_pipeline"),
    );
  });

  test("removes the worktree while it still holds the lease, before it returns the work item", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls.indexOf("remove_worktree")).toBeLessThan(
      h.calls.indexOf("return_to_requirements"),
    );
  });

  test("removes the worktree only once", async () => {
    const h = gapHarness();
    await runDesignGenerate(h.deps, INPUT);
    expect(h.removedWorktrees).toEqual([WORKTREE]);
  });

  test("masks secrets in the gap that it hands on", async () => {
    const h = gapHarness({
      claude: async () => ({
        outcome: "success",
        output: gapOutput(`token ${GITHUB_TOKEN} leaked`),
      }),
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.launches[0]?.feedback).not.toContain(GITHUB_TOKEN);
  });

  test("cuts a long gap to the limit", async () => {
    const h = gapHarness({
      claude: async () => ({
        outcome: "success",
        output: gapOutput("あ".repeat(DESIGN_GAP_REPORT_MAX_CHARS + 500)),
      }),
    });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.launches[0]?.feedback.length).toBeLessThanOrEqual(
      AUTOMATED_FEEDBACK_MARKER.length + 1 + DESIGN_GAP_REPORT_MAX_CHARS,
    );
  });

  test("uses the limit that the module states", () => {
    expect(DESIGN_GAP_REPORT_MAX_CHARS).toBeGreaterThan(0);
  });

  test("stops at max_attempts without launching the pipeline", async () => {
    const h = gapHarness({ maxAttempts: 2 });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.calls).not.toContain("launch_pipeline");
  });

  test("moves the work item to needs_human at max_attempts", async () => {
    const h = gapHarness({ maxAttempts: 2 });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.moves).toEqual([
      {
        to: "needs_human",
        reason: "design requirements_gap after max_attempts 2",
      },
    ]);
  });

  test("reports needs_human at max_attempts", async () => {
    const h = gapHarness({ maxAttempts: 2 });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "needs_human",
      reason: "design requirements_gap after max_attempts 2",
    });
  });

  test("notifies the person at max_attempts", async () => {
    const h = gapHarness({ maxAttempts: 2 });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.notified).toHaveLength(1);
  });

  test("does not return the work item to the requirements at max_attempts", async () => {
    const h = gapHarness({ maxAttempts: 2 });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.returnNotes).toEqual([]);
  });

  test("reports lease_lost when the move at max_attempts is refused", async () => {
    const h = gapHarness({ maxAttempts: 2 });
    const result = await runDesignGenerate(
      { ...h.deps, moveFromDesigning: async () => false },
      INPUT,
    );
    expect(result).toEqual({ outcome: "lease_lost" });
  });

  test("launches nothing when the lease is lost before the return", async () => {
    const h = gapHarness();
    const result = await runDesignGenerate(
      { ...h.deps, returnToRequirements: async () => false },
      INPUT,
    );
    expect([result.outcome, h.calls.includes("launch_pipeline")]).toEqual([
      "lease_lost",
      false,
    ]);
  });

  test("returns the work item to needs_human when the launch fails", async () => {
    const h = gapHarness({
      pipelineJob: async () => {
        throw new Error("windmill down");
      },
    });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.rollbacks).toEqual([REQUIREMENTS_REGENERATION_FAILED_REASON]);
  });

  test("throws after it returned the work item to needs_human", async () => {
    const h = gapHarness({
      pipelineJob: async () => {
        throw new Error("windmill down");
      },
    });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "f/factory/pipeline could not be started: windmill down",
    );
  });

  test("treats a response that is not a job id as a failed launch", async () => {
    const h = gapHarness({ pipelineJob: async () => "not-a-job-id" });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.rollbacks).toEqual([REQUIREMENTS_REGENERATION_FAILED_REASON]);
  });

  test("returns the work item to needs_human when the job id cannot be recorded", async () => {
    const h = gapHarness({
      recordPipeline: async () => {
        throw new Error("db down");
      },
    });
    await runDesignGenerate(h.deps, INPUT).catch(() => undefined);
    expect(h.rollbacks).toEqual([REQUIREMENTS_REGENERATION_FAILED_REASON]);
  });

  test("names the job when the job id cannot be recorded", async () => {
    const h = gapHarness({
      recordPipeline: async () => {
        throw new Error("db down");
      },
    });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      `${PIPELINE_JOB.toLowerCase()} could not be recorded: db down`,
    );
  });

  test("says that it did not move the work item when another run holds the lease", async () => {
    const h = gapHarness({
      pipelineJob: async () => {
        throw new Error("windmill down");
      },
      rollbackAccepted: false,
    });
    await expect(runDesignGenerate(h.deps, INPUT)).rejects.toThrow(
      "was not moved to needs_human",
    );
  });

  test("keeps the result when another run recorded its own job id", async () => {
    const h = gapHarness({ recordPipeline: async () => false });
    expect(await runDesignGenerate(h.deps, INPUT)).toEqual({
      outcome: "requirements_gap",
    });
  });

  test("does not return the work item to needs_human when another run recorded its own job id", async () => {
    const h = gapHarness({ recordPipeline: async () => false });
    await runDesignGenerate(h.deps, INPUT);
    expect(h.rollbacks).toEqual([]);
  });
});
