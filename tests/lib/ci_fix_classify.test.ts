import { describe, expect, test } from "bun:test";
import { classifyCiFailure } from "../../f/factory/lib/ci_fix_classify.ts";

const job = (name: string, conclusion: string | null, id = 1) => ({
  id,
  name,
  conclusion,
});

describe("classifyCiFailure", () => {
  test("a failed check job is fixable", () => {
    expect(classifyCiFailure([job("check", "failure")]).kind).toBe("fixable");
  });

  test("hands back the failed jobs of a fixable run", () => {
    const failed = job("check", "failure", 7);
    const result = classifyCiFailure([job("test-db", "success", 3), failed]);
    expect(result.kind === "fixable" ? result.jobs : null).toEqual([failed]);
  });

  test("keeps the order of several failed jobs", () => {
    const first = job("check", "failure", 1);
    const second = job("test-db", "failure", 2);
    const result = classifyCiFailure([first, second]);
    expect(result.kind === "fixable" ? result.jobs : null).toEqual([
      first,
      second,
    ]);
  });

  test("a failed metadata job alone is fixable with no job to read", () => {
    const result = classifyCiFailure([job("metadata", "failure")]);
    expect(result).toEqual({ kind: "fixable", jobs: [], metadataFailed: true });
  });

  test("a metadata job with a different case is a metadata failure", () => {
    const result = classifyCiFailure([job("Metadata", "failure")]);
    expect(result.kind === "fixable" && result.metadataFailed).toBe(true);
  });

  test("a fullwidth metadata job name is a metadata failure", () => {
    const result = classifyCiFailure([job("ｍｅｔａｄａｔａ", "failure")]);
    expect(result.kind === "fixable" && result.metadataFailed).toBe(true);
  });

  test("a metadata job with a matrix suffix is a metadata failure", () => {
    const result = classifyCiFailure([job("metadata (ubuntu)", "failure")]);
    expect(result.kind === "fixable" && result.metadataFailed).toBe(true);
  });

  test("a job whose name starts with metadata is a metadata failure", () => {
    const result = classifyCiFailure([job("metadata-check", "failure")]);
    expect(result.kind === "fixable" && result.metadataFailed).toBe(true);
  });

  test("a metadata failure next to a check failure keeps only the check job", () => {
    const check = job("check", "failure");
    const result = classifyCiFailure([check, job("metadata", "failure", 2)]);
    expect(result).toEqual({
      kind: "fixable",
      jobs: [check],
      metadataFailed: true,
    });
  });

  test("a failure without a metadata job is not a metadata failure", () => {
    const result = classifyCiFailure([job("check", "failure")]);
    expect(result.kind === "fixable" && result.metadataFailed).toBe(false);
  });

  test("a job with an empty name is unfixable", () => {
    const result = classifyCiFailure([job("", "failure")]);
    expect(result).toEqual({
      kind: "unfixable_job",
      reason: "unnamed_job",
      jobName: "(unnamed)",
    });
  });

  test("a job whose name is only invisible characters is unfixable", () => {
    expect(classifyCiFailure([job("​ ‮", "failure")]).kind).toBe("unfixable_job");
  });

  test("shows an external job name sanitized and shortened", () => {
    const result = classifyCiFailure([
      job(`check‮ ${"x".repeat(200)}`, "cancelled"),
    ]);
    expect(
      result.kind === "other_conclusion" ? result.jobName.length : -1,
    ).toBeLessThanOrEqual(60);
  });

  test("a cancelled job is reported by its conclusion", () => {
    expect(classifyCiFailure([job("check", "cancelled")])).toEqual({
      kind: "other_conclusion",
      conclusion: "cancelled",
      jobName: "check",
    });
  });

  test("a timed out job is reported by its conclusion", () => {
    const result = classifyCiFailure([job("check", "timed_out")]);
    expect(result.kind === "other_conclusion" ? result.conclusion : null).toBe(
      "timed_out",
    );
  });

  test("a startup failure is reported by its conclusion", () => {
    const result = classifyCiFailure([job("check", "startup_failure")]);
    expect(result.kind === "other_conclusion" ? result.conclusion : null).toBe(
      "startup_failure",
    );
  });

  test("an action_required job is reported by its conclusion", () => {
    const result = classifyCiFailure([job("check", "action_required")]);
    expect(result.kind === "other_conclusion" ? result.conclusion : null).toBe(
      "action_required",
    );
  });

  test("an unknown conclusion string is reported as unknown", () => {
    const result = classifyCiFailure([job("check", "exploded")]);
    expect(result.kind === "other_conclusion" ? result.conclusion : null).toBe(
      "unknown",
    );
  });

  test("a job without a conclusion is not claimed", () => {
    const result = classifyCiFailure([job("check", null)]);
    expect(result.kind === "other_conclusion" ? result.conclusion : null).toBe(
      "unknown",
    );
  });

  test("a non-failure conclusion wins over a fixable failure", () => {
    const result = classifyCiFailure([
      job("check", "failure"),
      job("test-db", "timed_out"),
    ]);
    expect(result.kind).toBe("other_conclusion");
  });

  test("a non-failure conclusion wins over a metadata failure", () => {
    const result = classifyCiFailure([
      job("check", "timed_out"),
      job("metadata", "failure"),
    ]);
    expect(result.kind).toBe("other_conclusion");
  });

  test("an unnamed failed job wins over a non-failure conclusion", () => {
    const result = classifyCiFailure([
      job("check", "timed_out"),
      job("", "failure"),
    ]);
    expect(result.kind).toBe("unfixable_job");
  });

  test("an unnamed failed job wins over a metadata failure", () => {
    const result = classifyCiFailure([
      job("metadata", "failure"),
      job("", "failure"),
    ]);
    expect(result.kind).toBe("unfixable_job");
  });

  test("success, skipped and neutral jobs are not failures", () => {
    const result = classifyCiFailure([
      job("check", "success"),
      job("scope", "skipped"),
      job("lint", "neutral"),
    ]);
    expect(result).toEqual({ kind: "no_failure" });
  });

  test("an empty job list has no failure", () => {
    expect(classifyCiFailure([])).toEqual({ kind: "no_failure" });
  });

  test("a metadata job that succeeded does not block a fixable failure", () => {
    const result = classifyCiFailure([
      job("metadata", "success"),
      job("check", "failure"),
    ]);
    expect(result.kind === "fixable" && result.metadataFailed).toBe(false);
  });
});
