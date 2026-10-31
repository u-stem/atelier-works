// 実装が設計の不足を返したとき、設計へ戻す手順を、本番と同じ設計フローの起動(`buildStartDesign`)で確かめる。
// 起動の入出力は偽に差し替える。`implement_finish`のmainはWindmillの変数・リソースとDBを直接使うので、
// mainの結線はソースの文面で固定する。整形や変数名の変更で落ちたときは、結線が変わっていないかを確かめてから文面を直す。

import { describe, expect, test } from "bun:test";
import { DESIGN_START_FAILED_REASON } from "../../f/factory/lib/design_launch_support.ts";
import type { NotifyEvent } from "../../f/factory/lib/discord.ts";
import {
  DESIGN_GAP_DISABLED_REASON,
  DESIGN_GAP_EXHAUSTED_REASON,
  implementDesignGapNote,
  rerouteImplementationToDesign,
} from "../../f/factory/lib/implement_finish_support.ts";
import { limitGapReport } from "../../f/factory/lib/model_text.ts";
import { DESIGN_FLOW_PATH } from "../../f/factory/lib/pipeline_lease.ts";
import {
  AUTOMATED_FEEDBACK_MARKER,
  automatedFeedback,
} from "../../f/factory/lib/prompts.ts";
import type { WorkItem } from "../../f/factory/lib/types.ts";
import {
  buildStartDesign,
  type StartDesignPorts,
} from "../../f/factory/steps/requirements_apply.ts";

const JOB_A = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const NO_LOG = { info() {}, warn() {}, error() {} };
const REPORT = "設計書は存在しないAPIを前提としています。";

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
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
    status: "implementing",
    attempt: 2,
    claimed_by: null,
    flow_job_id: "0190ffff-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
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
    profile: "standard",
    created_at: new Date("2026-10-26T00:00:00Z"),
    updated_at: new Date("2026-10-26T00:00:00Z"),
    ...overrides,
  };
}

/** 設計フローの起動の入出力の偽。 */
function ports(overrides: Partial<StartDesignPorts> = {}) {
  const events: string[] = [];
  const launches: { path: string; args: Record<string, unknown> }[] = [];
  const moves: {
    id: number;
    from: string;
    to: string;
    note: string | null;
  }[] = [];
  const notifications: NotifyEvent[] = [];
  const value: StartDesignPorts = {
    runFlowAsync: async (path, args) => {
      events.push("launch");
      launches.push({ path, args });
      return JOB_A;
    },
    setFlowJobIdIfUnset: async () => {
      events.push("record_job");
      return true;
    },
    updateStatusIfLeaseHolder: async (id, from, to, _lease, note) => {
      events.push("move_after_failure");
      moves.push({ id, from, to, note });
      return true;
    },
    recordFailure: async () => {},
    notifyBestEffort: async (_url, event) => {
      notifications.push(event);
    },
    ...overrides,
  };
  return { value, events, launches, moves, notifications };
}

/** 本番と同じ`buildStartDesign`を、偽の入出力で組み立てた戻しの依存。 */
function reroute(
  p: ReturnType<typeof ports>,
  options: { cas?: () => Promise<boolean> } = {},
) {
  const ctx = {
    workItem: workItem(),
    issueNumber: 42,
    webhookUrl: "https://discord.example/webhook",
    log: NO_LOG,
  };
  const notes: string[] = [];
  const run = () =>
    rerouteImplementationToDesign(
      {
        casToDesigning: async (note) => {
          p.events.push("cas_designing");
          notes.push(note);
          return (await options.cas?.()) ?? true;
        },
        launchDesign: (feedback) =>
          buildStartDesign(
            { instance_name: "local" },
            ctx,
            p.value,
            feedback,
          )(),
      },
      { gapReport: REPORT },
    );
  return { run, notes };
}

describe("rerouting an implementation to the design", () => {
  test("moves to designing before it starts the design flow", async () => {
    const p = ports();
    await reroute(p).run();
    expect(p.events).toEqual(["cas_designing", "launch", "record_job"]);
  });

  test("moves with the note of the design gap", async () => {
    const p = ports();
    const r = reroute(p);
    await r.run();
    expect(r.notes).toEqual([implementDesignGapNote(REPORT)]);
  });

  test("starts the design flow with the next design attempt", async () => {
    const p = ports();
    await reroute(p).run();
    expect(p.launches[0]?.args.design_attempt).toBe(4);
  });

  test("starts the design flow at the design flow path", async () => {
    const p = ports();
    await reroute(p).run();
    expect(p.launches[0]?.path).toBe(DESIGN_FLOW_PATH);
  });

  test("hands the report to the design flow as an automated report", async () => {
    const p = ports();
    await reroute(p).run();
    expect(p.launches[0]?.args.feedback).toBe(
      automatedFeedback(limitGapReport(REPORT)),
    );
  });

  test("marks the feedback as an automated report", async () => {
    const p = ports();
    await reroute(p).run();
    expect(
      String(p.launches[0]?.args.feedback).startsWith(
        AUTOMATED_FEEDBACK_MARKER,
      ),
    ).toBe(true);
  });

  test("moves a design that could not start to needs_human", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("boom");
      },
    });
    await reroute(p).run();
    expect(p.moves).toEqual([
      {
        id: 7,
        from: "designing",
        to: "needs_human",
        note: DESIGN_START_FAILED_REASON,
      },
    ]);
  });

  test("notifies a person of a design that could not start", async () => {
    const p = ports({
      runFlowAsync: async () => {
        throw new Error("boom");
      },
    });
    await reroute(p).run();
    expect(p.notifications[0]).toMatchObject({ kind: "needs_human" });
  });

  test("goes on when another run already recorded the job id", async () => {
    const p = ports({ setFlowJobIdIfUnset: async () => false });
    expect(await reroute(p).run()).toEqual({
      kind: "started",
      outcome: "started",
    });
  });

  test("never moves from designing to designing", async () => {
    const p = ports();
    await reroute(p).run();
    expect(p.moves.filter((move) => move.from === move.to)).toEqual([]);
  });

  test("starts nothing when the work item moved on", async () => {
    const p = ports();
    await reroute(p, { cas: async () => false }).run();
    expect(p.launches).toEqual([]);
  });
});

describe("the wiring of the design gap in implement_finish", () => {
  async function source(): Promise<string> {
    const text = await Bun.file(
      new URL("../../f/factory/steps/implement_finish.ts", import.meta.url),
    ).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  test("decides from the design_enabled setting that was read", async () => {
    expect(await source()).toContain("designEnabled: config.design_enabled,");
  });

  test("moves to designing with the helper that advances design_attempt", async () => {
    expect(await source()).toMatch(
      /returnToDesigningFromImplementingIfLeaseHolder\(\s*work_item_id,\s*leaseJobId,/,
    );
  });

  test("starts the design flow with buildStartDesign once", async () => {
    expect((await source()).split("buildStartDesign(").length - 1).toBe(1);
  });

  // design_gapの分岐の本文だけを切り出す。分岐は2字下げの閉じ括弧で終わる。
  async function designGapBranch(): Promise<string> {
    const text = await source();
    const start = text.indexOf('if (action.kind === "design_gap") {');
    const end = text.indexOf("\n  }\n", start);
    return text.slice(start, end);
  }

  test("calls the cleanup of the gap work in the branch", async () => {
    expect(await designGapBranch()).toContain(
      "cleanUpGapWork(context, gapReport)",
    );
  });

  test("cleans up the gap work before it decides", async () => {
    const branch = await designGapBranch();
    const cleanup = branch.indexOf("cleanUpGapWork(context, gapReport)");
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(cleanup).toBeLessThan(branch.indexOf("decideDesignGapAction("));
  });

  test("stops with the fixed reason of the limit", async () => {
    expect(await source()).toContain("DESIGN_GAP_EXHAUSTED_REASON");
  });

  test("stops with the fixed reason of the closed stage", async () => {
    expect(await source()).toContain("DESIGN_GAP_DISABLED_REASON");
  });

  test("keeps the reasons as the fixed sentences", () => {
    expect([DESIGN_GAP_EXHAUSTED_REASON, DESIGN_GAP_DISABLED_REASON]).toEqual([
      "design gap after max_design_attempts",
      "design gap reported while design_enabled is off",
    ]);
  });
});

// 要件の不足の差し戻しは、設計の試行を0にそろえ、報告を自動の報告として渡す。
describe("the requirements gap reroute in implement_finish", () => {
  async function source(): Promise<string> {
    const text = await Bun.file(
      new URL("../../f/factory/steps/implement_finish.ts", import.meta.url),
    ).text();
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  test("moves to the requirements with the helper that resets design_attempt", async () => {
    expect(await source()).toMatch(
      /updateStatusToRequirementsIfLeaseHolder\(\s*work_item_id,\s*"implementing",\s*leaseJobId,/,
    );
  });

  test("records the job id only when it is unset", async () => {
    expect(await source()).toContain(
      "setFlowJobIdIfUnset(work_item_id, flowJobId)",
    );
  });

  test("does not overwrite the job id", async () => {
    expect(await source()).not.toMatch(/\bsetFlowJobId\(/);
  });

  test("hands the report to the requirements as an automated report", async () => {
    expect(await source()).toContain(
      "feedback: automatedFeedback(limitGapReport(gapReport))",
    );
  });

  test("moves a failed relaunch to needs_human without the lease of the finished run", async () => {
    expect(await source()).toContain(
      "options.from === undefined ? leaseJobId : null",
    );
  });
});
