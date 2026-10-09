import { describe, expect, test } from "bun:test";
import {
  evaluateBashGuard,
  type GuardDeps,
} from "../../../scripts/claude-hooks/bash-guard.ts";

/** 呼ばれた回数を数える依存を作る。 */
function countingDeps(): { deps: GuardDeps; calls: () => number } {
  let calls = 0;
  const deps: GuardDeps = {
    currentBranch: () => {
      calls += 1;
      return "feature";
    },
    repoRoot: () => {
      calls += 1;
      return "/repo";
    },
  };
  return { deps, calls: () => calls };
}

function evaluate(command: string, deps: GuardDeps) {
  return evaluateBashGuard({ command, cwd: "/repo", agentId: null }, deps);
}

/** 異なるディレクトリで続けてpushするコマンド行を作る。 */
function pushesInDirectories(count: number): string {
  return Array.from(
    { length: count },
    (_unused, index) => `cd /d${index} && git push`,
  ).join("; ");
}

describe("bash-guard spawn budget", () => {
  test("looks up the branch of one directory once", () => {
    const { deps, calls } = countingDeps();
    evaluate("git push; git push; git push origin HEAD", deps);
    expect(calls()).toBe(1);
  });

  test("looks up the repository root once", () => {
    const { deps, calls } = countingDeps();
    evaluate("grep -rn x docs; grep -rn y scripts; grep -rn z tests", deps);
    expect(calls()).toBe(1);
  });

  test("allows a few different directories", () => {
    const { deps } = countingDeps();
    expect(evaluate(pushesInDirectories(5), deps).kind).toBe("allow");
  });

  test("denies a command line that needs too many lookups", () => {
    const { deps } = countingDeps();
    expect(evaluate(pushesInDirectories(40), deps).kind).toBe("deny");
  });

  test("explains the limit in the reason", () => {
    const { deps } = countingDeps();
    const decision = evaluate(pushesInDirectories(40), deps);
    expect(decision.kind === "deny" && decision.reason).toContain("too many");
  });

  test("stops spawning git after the limit", () => {
    const { deps, calls } = countingDeps();
    evaluate(pushesInDirectories(40), deps);
    expect(calls()).toBeLessThanOrEqual(21);
  });
});
