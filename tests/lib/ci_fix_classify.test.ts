import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyCiFailure,
  isLockIntegrityOnlyLog,
  LOCK_INTEGRITY_TESTS,
} from "../../f/factory/lib/ci_fix_classify.ts";

const FIRST_TEST_FILE = LOCK_INTEGRITY_TESTS[0]?.file ?? "";
const FIRST_TEST_NAME = LOCK_INTEGRITY_TESTS[0]?.name ?? "";

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

const INTEGRITY_NAME = FIRST_TEST_NAME;

function bunLog(lines: readonly string[]): string {
  return lines.join("\n");
}

function integrityLog(extra: readonly string[] = []): string {
  return bunLog([
    "bun test v1.3.0",
    "",
    `${FIRST_TEST_FILE}:`,
    "error: expect(received).toEqual(expected)",
    `(fail) ${INTEGRITY_NAME} [4.10ms]`,
    "",
    " 1200 pass",
    " 1 fail",
    "Ran 1201 tests across 90 files. [9.00s]",
    ...extra,
  ]);
}

describe("isLockIntegrityOnlyLog", () => {
  test("accepts a log in which every known test failed", () => {
    const lines: string[] = ["bun test v1.3.0"];
    for (const entry of LOCK_INTEGRITY_TESTS) {
      lines.push(`${entry.file}:`, `(fail) ${entry.name} [4.10ms]`);
    }
    lines.push(` ${String(LOCK_INTEGRITY_TESTS.length)} fail`);
    expect(isLockIntegrityOnlyLog(lines.join("\n"), false)).toBe(true);
  });

  describe("with the log of a parallel run on CI", () => {
    function parallelLog(summaryOnly: readonly string[] = []): string {
      const lines: string[] = [
        "##[group]tests/lib/other.test.ts:",
        "(pass) a > b [1.00ms]",
        "##[endgroup]",
      ];
      for (const entry of LOCK_INTEGRITY_TESTS) {
        lines.push(
          `##[group]${entry.file}:`,
          "error: expect(received).toEqual(expected)",
          `(fail) ${entry.name} [4.10ms]`,
          "##[endgroup]",
          "##[group]tests/lib/other.test.ts:",
          "(skip) c > d",
          "##[endgroup]",
        );
      }
      lines.push(
        `${String(LOCK_INTEGRITY_TESTS.length + summaryOnly.length)} tests failed:`,
      );
      for (const entry of LOCK_INTEGRITY_TESTS) {
        lines.push(`(fail) ${entry.name} [4.10ms]`);
      }
      for (const name of summaryOnly) lines.push(`(fail) ${name} [4.10ms]`);
      lines.push(
        "",
        " 100 pass",
        ` ${String(LOCK_INTEGRITY_TESTS.length + summaryOnly.length)} fail`,
      );
      return lines.join("\n");
    }

    test("accepts the failures, which the summary lists again without headers", () => {
      expect(isLockIntegrityOnlyLog(parallelLog(), false)).toBe(true);
    });

    test("rejects a failure that only the summary lists", () => {
      expect(
        isLockIntegrityOnlyLog(parallelLog(["other > fails"]), false),
      ).toBe(false);
    });

    test("accepts a known name that only the summary lists", () => {
      const first = LOCK_INTEGRITY_TESTS[0];
      const log = [
        "##[group]tests/lib/other.test.ts:",
        "##[endgroup]",
        "1 tests failed:",
        `(fail) ${first?.name ?? ""} [4.10ms]`,
        " 1 fail",
      ].join("\n");
      expect(isLockIntegrityOnlyLog(log, false)).toBe(true);
    });
  });

  test("rejects a known name under another file", () => {
    const entry = LOCK_INTEGRITY_TESTS[1];
    const log = [
      "tests/lib/other.test.ts:",
      `(fail) ${entry?.name ?? ""} [4.10ms]`,
      " 1 fail",
    ].join("\n");
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });

  test("accepts a log whose only failure is the lock integrity test", () => {
    expect(isLockIntegrityOnlyLog(integrityLog(), false)).toBe(true);
  });

  test("accepts the failure when the summary lists it again", () => {
    const log = bunLog([
      `${FIRST_TEST_FILE}:`,
      `(fail) ${INTEGRITY_NAME} [4.10ms]`,
      "tests/lib/zzz.test.ts:",
      "",
      "1 tests failed:",
      `(fail) ${INTEGRITY_NAME} [4.10ms]`,
      " 1 fail",
    ]);
    expect(isLockIntegrityOnlyLog(log, false)).toBe(true);
  });

  test("accepts a log with timestamp prefixes and terminal sequences", () => {
    const log = integrityLog()
      .split("\n")
      .map((line) => `2026-10-13T00:00:00.1234567Z \u001b[31m${line}\u001b[0m`)
      .join("\n");
    expect(isLockIntegrityOnlyLog(log, false)).toBe(true);
  });

  test("accepts a log that reports zero errors", () => {
    expect(isLockIntegrityOnlyLog(integrityLog([" 0 errors"]), false)).toBe(
      true,
    );
  });

  test("rejects a log that the fetch truncated", () => {
    expect(isLockIntegrityOnlyLog(integrityLog(), true)).toBe(false);
  });

  test("rejects a log with another failing test in the same file", () => {
    const log = bunLog([
      `${FIRST_TEST_FILE}:`,
      `(fail) ${INTEGRITY_NAME} [4.10ms]`,
      "(fail) the repository's wmill-lock.yaml > covers the scripts [1.00ms]",
      " 2 fail",
    ]);
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });

  test("rejects a log with a failing test in another file", () => {
    const log = bunLog([
      `${FIRST_TEST_FILE}:`,
      `(fail) ${INTEGRITY_NAME} [4.10ms]`,
      "tests/lib/other.test.ts:",
      "(fail) other > fails [1.00ms]",
      " 2 fail",
    ]);
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });

  test("rejects a failure of the same name under another file", () => {
    const log = bunLog([
      "tests/lib/other.test.ts:",
      `(fail) ${INTEGRITY_NAME} [4.10ms]`,
      " 1 fail",
    ]);
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });

  test("accepts a known name that has no file header above it", () => {
    const log = bunLog([`(fail) ${INTEGRITY_NAME} [4.10ms]`, " 1 fail"]);
    expect(isLockIntegrityOnlyLog(log, false)).toBe(true);
  });

  test("rejects an unknown name that has no file header above it", () => {
    const log = bunLog(["(fail) other > fails [4.10ms]", " 1 fail"]);
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });

  test("rejects a log whose summary counts more failures than it lists", () => {
    const log = integrityLog().replace(" 1 fail", " 2 fail");
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });

  test("rejects a log without a summary of failures", () => {
    const log = integrityLog().replace(" 1 fail", "");
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });

  test("rejects a log with two summaries of failures", () => {
    expect(isLockIntegrityOnlyLog(integrityLog([" 1 fail"]), false)).toBe(
      false,
    );
  });

  test("rejects a log that reports errors between tests", () => {
    expect(isLockIntegrityOnlyLog(integrityLog([" 1 error"]), false)).toBe(
      false,
    );
  });

  test("rejects a log with no failing test", () => {
    expect(isLockIntegrityOnlyLog("##[error]lint failed in a.ts", false)).toBe(
      false,
    );
  });

  test("rejects an empty log", () => {
    expect(isLockIntegrityOnlyLog("", false)).toBe(false);
  });

  test("rejects a failing test of the file under another name", () => {
    const log = integrityLog().replace(INTEGRITY_NAME, "something else");
    expect(isLockIntegrityOnlyLog(log, false)).toBe(false);
  });
});

describe("the lock integrity tests", () => {
  const sourceOf = (file: string) =>
    readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");

  test("name a test file that exists", () => {
    const missing = LOCK_INTEGRITY_TESTS.filter((entry) => {
      try {
        sourceOf(entry.file);
        return false;
      } catch {
        return true;
      }
    });
    expect(missing).toEqual([]);
  });

  test("each match a describe and a test in its file", () => {
    const missing = LOCK_INTEGRITY_TESTS.filter(({ file, name }) => {
      const [suite, title] = name.split(" > ");
      const source = sourceOf(file);
      return !(
        source.includes(`describe("${suite}"`) &&
        source.includes(`test("${title}"`)
      );
    });
    expect(missing).toEqual([]);
  });

  test("have no name twice in the same file", () => {
    const keys = LOCK_INTEGRITY_TESTS.map((e) => `${e.file}\n${e.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
