// 設計工程の入口が閉じていることを固定する。
// 設計フローを起動する配線(`startDesign`)は、`design_enabled`が真のときだけ非nullになり、
// 本番の設定の読み込みは`design_enabled: true`を偽として読む(`DESIGN_STAGE_OPENABLE`)。
// このテストは保護パスに置く。実装フローの自動修正やPRの修正が閉じる条件を緩めて、
// このテストを書き換えると、黙って通るようになるためである。
//
// 文字列の照合は`Bun.Transpiler`でコメントを落としてから行う。変換できないファイルは失敗として扱う(fail-closed)。
// 追えない形がある。識別子を連結や別名で組み立てる参照は数えられない。
// 関数の観測(下の「設計の入口3つ」)と組み合わせて守る。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isReadyForImplement } from "../../f/factory/lib/approval_gate.ts";
import { parseFactoryConfig } from "../../f/factory/lib/config.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import { computeRestartPlan } from "../../f/factory/retry_work_item.ts";
import { applyDesignApproved } from "../../f/factory/steps/design_apply.ts";
import {
  type ApprovedBranchContext,
  type ApprovedBranchDeps,
  applyApprovedBranch,
  buildApprovedBranchDeps,
} from "../../f/factory/steps/requirements_apply.ts";

const FACTORY_DIR = join(import.meta.dir, "../../f/factory");
const transpiler = new Bun.Transpiler({ loader: "ts" });

/** コメントを落としたJavaScript。変換できないときは例外を投げる。 */
function codeOf(path: string): string {
  return transpiler.transformSync(
    readFileSync(join(FACTORY_DIR, path), "utf8"),
  );
}

/** `f/factory`の下の、テストを除くすべての`.ts`の相対パス。 */
function productionSources(): string[] {
  return [...new Bun.Glob("**/*.ts").scanSync(FACTORY_DIR)]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort();
}

const WORK_ITEM: WorkItem = {
  id: 7,
  cycle: 1,
  source: "issue",
  kind: "issue",
  owner: "octo",
  repo: "widgets",
  issue_number: 42,
  issue_url: "https://github.com/octo/widgets/issues/42",
  pr_number: null,
  title: "t",
  body: "b",
  status: "awaiting_approval",
  attempt: 1,
  claimed_by: null,
  flow_job_id: null,
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
  design_attempt: 0,
  created_at: new Date("2026-10-26T00:00:00Z"),
  updated_at: new Date("2026-10-26T00:00:00Z"),
};

const CONTEXT: ApprovedBranchContext = {
  workItem: WORK_ITEM,
  issueNumber: 42,
  attempt: 1,
  client: {
    run: async () => {
      throw new Error("the builder must not call GitHub");
    },
    ghToken: "token",
  },
  viewerLogin: "factory-bot",
  webhookUrl: "",
  log: { info() {}, warn() {}, error() {} },
};

const CONFIG = {
  implement_enabled: true,
  design_enabled: false,
  windmill_public_url: "http://127.0.0.1:8080",
  instance_name: "local",
};

const RAW_CONFIG = {
  owners: [{ name: "octo-owner", kind: "user" }],
  trigger_label: "factory",
  allowed_labeler_associations: ["OWNER", "MEMBER", "COLLABORATOR"],
  model: "claude-opus-5-5",
  max_attempts: 3,
  max_turns: 40,
  max_budget_usd_per_run: 5,
  daily_budget_usd: 50,
  claude_timeout_sec: 1800,
  worktree_ttl_days: 7,
  factory_repo: "https://github.com/octo-owner/atelier-works",
  instance_name: "local",
  windmill_public_url: "http://127.0.0.1:8080",
};

describe("the wiring of the design flow", () => {
  test("leaves the design flow unwired when design_enabled is false", () => {
    expect(buildApprovedBranchDeps(CONFIG, CONTEXT).startDesign).toBeNull();
  });

  test("wires the design flow when design_enabled is true", () => {
    const deps = buildApprovedBranchDeps(
      { ...CONFIG, design_enabled: true },
      CONTEXT,
    );
    expect(typeof deps.startDesign).toBe("function");
  });

  test("leaves the design flow unwired in production, where the configuration ignores design_enabled: true", () => {
    const config = parseFactoryConfig({ ...RAW_CONFIG, design_enabled: true });
    expect(buildApprovedBranchDeps(config, CONTEXT).startDesign).toBeNull();
  });
});

describe("the literal that opens the design stage", () => {
  test("appears nowhere in the production code of f/factory", () => {
    const found = productionSources().filter((path) =>
      /\bdesign_enabled\b\s*:\s*true/.test(codeOf(path)),
    );
    expect(found).toEqual([]);
  });

  test("reads every production file", () => {
    expect(productionSources().length).toBeGreaterThan(100);
  });
});

describe("the gate in config.ts", () => {
  const config = codeOf("lib/config.ts");

  test("declares DESIGN_STAGE_OPENABLE as false exactly once", () => {
    expect([
      ...config.matchAll(/\bconst DESIGN_STAGE_OPENABLE = false;/g),
    ]).toHaveLength(1);
  });

  test("uses DESIGN_STAGE_OPENABLE in its declaration and two derivations only", () => {
    expect([...config.matchAll(/\bDESIGN_STAGE_OPENABLE\b/g)]).toHaveLength(3);
  });

  test("derives design_enabled from the request and the gate only", () => {
    expect(config).toMatch(
      /\bdesign_enabled:\s*designEnabledRequested\s*&&\s*DESIGN_STAGE_OPENABLE\b/,
    );
  });

  test("derives design_enabled_ignored from the request and the closed gate only", () => {
    expect(config).toMatch(
      /\bdesign_enabled_ignored:\s*designEnabledRequested\s*&&\s*!DESIGN_STAGE_OPENABLE\b/,
    );
  });

  test.each(["process.env", "Bun.env", "import.meta.env"])(
    "does not read %s",
    (reader) => {
      expect(config.includes(reader)).toBe(false);
    },
  );
});

describe("the three entries to the implement flow when the design is enabled", () => {
  test("starts the implement flow when design_apply accepts an approval", async () => {
    const started: string[] = [];
    await applyDesignApproved(
      {
        moveToNeedsHuman: async () => true,
        notifyNeedsHuman: async () => {},
        casToApproved: async () => true,
        startImplement: async () => {
          started.push("implement");
          return "started";
        },
        log: () => {},
      },
      {
        workItem: { attempt: 2, design_attempt: 3 },
        requirementsApproval: { status: "approved", attempt: 2, draft_id: 8 },
        designApproval: {
          approval_request_id: 11,
          design_draft_id: 5,
          status: "approved",
          payload_attempt: 2,
          payload_design_attempt: 3,
          reason: null,
          draft: { design_attempt: 3, requirement_draft_id: 8 },
        },
      },
    );
    expect(started).toEqual(["implement"]);
  });

  test("does not start the implement flow when the approval of requirements goes to the design", async () => {
    const started: string[] = [];
    const deps: ApprovedBranchDeps = {
      casToApproved: async () => true,
      casToDesigning: async () => true,
      commentIssue: async () => {},
      addCommentFailedNotice: async () => {},
      notifyApproved: async () => {},
      removeWorktree: async () => {},
      startImplement: async () => {
        started.push("implement");
        return "started";
      },
      startDesign: async () => "started",
      log: () => {},
    };
    await applyApprovedBranch(deps);
    expect(started).toEqual([]);
  });

  test("moves the approval of requirements to designing when the design flow is wired", async () => {
    const moves: string[] = [];
    const deps: ApprovedBranchDeps = {
      casToApproved: async () => {
        moves.push("approved");
        return true;
      },
      casToDesigning: async () => {
        moves.push("designing");
        return true;
      },
      commentIssue: async () => {},
      addCommentFailedNotice: async () => {},
      notifyApproved: async () => {},
      removeWorktree: async () => {},
      startImplement: async () => "started",
      startDesign: async () => "started",
      log: () => {},
    };
    await applyApprovedBranch(deps);
    expect(moves).toEqual(["designing"]);
  });

  const UNAPPROVED_DESIGN = {
    implementReady: true,
    implementEnabled: true,
    designEnabled: true,
    designApproved: false,
    stop: "other",
    feedback: null,
    designFeedback: null,
    carriesGap: false,
  } as const;

  test("restarts at the design flow when the design is unapproved", () => {
    const plan = computeRestartPlan(
      { ...WORK_ITEM, status: "failed", design_attempt: 1 },
      UNAPPROVED_DESIGN,
    );
    expect(plan.flowPath).toBe("f/factory/design");
  });

  test("does not restart the implement flow when the design is unapproved", () => {
    const plan = computeRestartPlan(
      { ...WORK_ITEM, status: "failed", design_attempt: 1 },
      UNAPPROVED_DESIGN,
    );
    expect(plan.flowPath).not.toBe("f/factory/implement");
  });

  test("is not ready for the implement flow when the design is unapproved", async () => {
    const ready = await isReadyForImplement(WORK_ITEM, true, {
      latestRequirementsApproval: async () => ({
        status: "approved",
        attempt: 1,
        draft_id: 8,
      }),
      latestDesignApproval: async () => null,
    });
    expect(ready).toBe(false);
  });
});
