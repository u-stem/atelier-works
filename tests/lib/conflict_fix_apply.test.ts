import { describe, expect, test } from "bun:test";
import {
  CONFLICT_BLOCKED_REASON_MAX_CHARS,
  CONFLICT_CLEAN_MERGE_SUMMARY,
  CONFLICT_SUMMARY_MAX_CHARS,
  type ConflictClaudeOutcome,
  type ConflictFixApplyDeps,
  conflictClaudeFailedMessage,
  runConflictFixApply,
} from "../../f/factory/lib/conflict_fix_apply.ts";
import {
  CONFLICT_CLAUDE_FAILED_NOTE_PREFIX,
  CONFLICT_FIX_SKILL_MARKER,
  CONFLICT_ROUND_DETAILS,
  conflictRoundReason,
} from "../../f/factory/lib/conflict_fix_round.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const INPUT = {
  pr: {
    owner: "acme",
    repo: "widgets",
    number: 12,
    headSha: HEAD,
    baseSha: BASE,
  },
  conflictedPaths: ["src/a.ts"],
};

type Recorded = { prompts: string[]; skillReads: number; scans: string[] };

function deps(
  claude: ConflictClaudeOutcome,
  overrides: Partial<ConflictFixApplyDeps> = {},
): { deps: ConflictFixApplyDeps; recorded: Recorded } {
  const recorded: Recorded = { prompts: [], skillReads: 0, scans: [] };
  return {
    recorded,
    deps: {
      readSkillText: async () => {
        recorded.skillReads += 1;
        return `# skill\n${CONFLICT_FIX_SKILL_MARKER}`;
      },
      startClaude: async (prompt) => {
        recorded.prompts.push(prompt);
        return claude;
      },
      scan: async (text) => {
        recorded.scans.push(text);
        return { ok: true, output: "" };
      },
      ...overrides,
    },
  };
}

const done = (summary = "解消しました"): ConflictClaudeOutcome => ({
  kind: "success",
  output: { outcome: "done", summary, blocked_reason: null },
});

describe("runConflictFixApply without a conflicted file", () => {
  const noConflict = { ...INPUT, conflictedPaths: [] };

  test("finishes with done and the fixed summary", async () => {
    const { deps: d } = deps(done());
    expect(await runConflictFixApply(d, noConflict)).toEqual({
      kind: "finished",
      outcome: "done",
      reason: null,
      summary: CONFLICT_CLEAN_MERGE_SUMMARY,
    });
  });

  test("does not start Claude", async () => {
    const { deps: d, recorded } = deps(done());
    await runConflictFixApply(d, noConflict);
    expect(recorded.prompts).toEqual([]);
  });

  test("does not read the skill", async () => {
    const { deps: d, recorded } = deps(done());
    await runConflictFixApply(d, noConflict);
    expect(recorded.skillReads).toBe(0);
  });
});

describe("runConflictFixApply before Claude starts", () => {
  test("blocks with the fixed reason when the skill lacks the marker", async () => {
    const { deps: d } = deps(done(), { readSkillText: async () => "# skill" });
    expect(await runConflictFixApply(d, INPUT)).toEqual({
      kind: "blocked",
      reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.markerMissing),
    });
  });

  test("does not start Claude when the skill lacks the marker", async () => {
    const { deps: d, recorded } = deps(done(), {
      readSkillText: async () => "# skill",
    });
    await runConflictFixApply(d, INPUT);
    expect(recorded.prompts).toEqual([]);
  });

  test("blocks as unresolvable when a conflicted path is unsafe", async () => {
    const { deps: d, recorded } = deps(done());
    const result = await runConflictFixApply(d, {
      ...INPUT,
      conflictedPaths: ["../outside"],
    });
    expect([result, recorded.prompts]).toEqual([
      {
        kind: "blocked",
        reason: conflictRoundReason(CONFLICT_ROUND_DETAILS.unresolvable),
      },
      [],
    ]);
  });

  test("passes the conflicted paths to Claude inside the prompt", async () => {
    const { deps: d, recorded } = deps(done());
    await runConflictFixApply(d, INPUT);
    expect(recorded.prompts[0]).toContain("src/a.ts");
  });
});

describe("runConflictFixApply after Claude answered", () => {
  test("finishes with done and the summary", async () => {
    const { deps: d } = deps(done("要約です"));
    expect(await runConflictFixApply(d, INPUT)).toEqual({
      kind: "finished",
      outcome: "done",
      reason: null,
      summary: "要約です",
    });
  });

  test("prefixes the reason of a blocked output", async () => {
    const { deps: d } = deps({
      kind: "success",
      output: { outcome: "blocked", summary: "", blocked_reason: "衝突です" },
    });
    expect(await runConflictFixApply(d, INPUT)).toMatchObject({
      outcome: "blocked",
      reason: "conflict round: claude blocked: 衝突です",
    });
  });

  test("gives a blocked output without a reason a fixed reason", async () => {
    const { deps: d } = deps({
      kind: "success",
      output: { outcome: "blocked", summary: "", blocked_reason: null },
    });
    expect(await runConflictFixApply(d, INPUT)).toMatchObject({
      reason: "conflict round: claude blocked",
    });
  });

  test("replaces the separator of reasons inside the reason of Claude", async () => {
    const { deps: d } = deps({
      kind: "success",
      output: {
        outcome: "blocked",
        summary: "",
        blocked_reason: "one; two",
      },
    });
    expect(await runConflictFixApply(d, INPUT)).toMatchObject({
      reason: "conflict round: claude blocked: one, two",
    });
  });

  test("cuts a summary that is too long", async () => {
    const { deps: d } = deps(
      done("あ".repeat(CONFLICT_SUMMARY_MAX_CHARS + 50)),
    );
    const result = await runConflictFixApply(d, INPUT);
    expect(result.kind === "finished" && [...result.summary].length).toBe(
      CONFLICT_SUMMARY_MAX_CHARS,
    );
  });

  test("cuts a reason that is too long", async () => {
    const { deps: d } = deps({
      kind: "success",
      output: {
        outcome: "blocked",
        summary: "",
        blocked_reason: "い".repeat(CONFLICT_BLOCKED_REASON_MAX_CHARS + 50),
      },
    });
    const result = await runConflictFixApply(d, INPUT);
    expect(
      result.kind === "finished" &&
        [...(result.reason ?? "")].length -
          "conflict round: claude blocked: ".length,
    ).toBe(CONFLICT_BLOCKED_REASON_MAX_CHARS);
  });

  test("scans the summary and the reason once", async () => {
    const { deps: d, recorded } = deps({
      kind: "success",
      output: { outcome: "blocked", summary: "S", blocked_reason: "R" },
    });
    await runConflictFixApply(d, INPUT);
    expect(recorded.scans.map((text) => text.trim())).toEqual(["S\n\nR"]);
  });

  test("blocks without the text when the scan finds a secret", async () => {
    const { deps: d } = deps(done("token"), {
      scan: async () => ({ ok: false, output: "- rule" }),
    });
    expect(await runConflictFixApply(d, INPUT)).toEqual({
      kind: "blocked",
      reason:
        "conflict round: the output of Claude matched the secret scan (gitleaks)",
    });
  });

  test("blocks when the scan cannot run", async () => {
    const { deps: d } = deps(done(), {
      scan: async () => {
        throw new Error("gitleaks is down");
      },
    });
    expect(await runConflictFixApply(d, INPUT)).toEqual({
      kind: "blocked",
      reason:
        "conflict round: the output of Claude matched the secret scan (scan_failed)",
    });
  });

  test("returns the failure of Claude without a detail", async () => {
    const { deps: d } = deps({ kind: "failure", reason: "timeout" });
    expect(await runConflictFixApply(d, INPUT)).toEqual({
      kind: "claude_failure",
      reason: "timeout",
    });
  });
});

describe("conflictClaudeFailedMessage", () => {
  test("starts with the prefix that the recovery matches", () => {
    expect(
      conflictClaudeFailedMessage("timeout").startsWith(
        CONFLICT_CLAUDE_FAILED_NOTE_PREFIX,
      ),
    ).toBe(true);
  });

  test("states the reason of the failure in the fixed form", () => {
    expect(conflictClaudeFailedMessage("timeout")).toBe(
      "pr_fix_apply: conflict round: claude run failed (timeout)",
    );
  });

  test("ends the prefix at the open parenthesis of the reason", () => {
    expect(CONFLICT_CLAUDE_FAILED_NOTE_PREFIX).toBe(
      "pr_fix_apply: conflict round: claude run failed (",
    );
  });
});
