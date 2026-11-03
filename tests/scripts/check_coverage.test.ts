import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCoverage,
  isTargetPath,
  judgeCoverage,
  summarizeLcov,
} from "../../scripts/check-coverage.ts";

type Hit = readonly [line: number, count: number];

/** lcovの1レコードを作る。`hits`は`DA:<行>,<回数>`の並びで、`extra`は`SF`の直後に足す行。 */
function record(path: string, hits: readonly Hit[], extra = ""): string {
  const lines = hits.map(([line, count]) => `DA:${line},${count}`);
  return ["TN:", `SF:${path}`, extra, ...lines, "end_of_record"]
    .filter((line) => line !== "")
    .join("\n");
}

/** 行1から並べ、先頭の`executed`行だけを実行済みにするDAを作る。 */
function hitsOf(executable: number, executed: number): Hit[] {
  return Array.from({ length: executable }, (_, index): Hit => {
    return [index + 1, index < executed ? 1 : 0];
  });
}

describe("isTargetPath", () => {
  test("accepts a source file under f/factory", () => {
    expect(isTargetPath("f/factory/lib/foo.ts")).toBe(true);
  });

  test("accepts a source file under scripts", () => {
    expect(isTargetPath("scripts/check-idle.ts")).toBe(true);
  });

  test("rejects a test file", () => {
    expect(isTargetPath("f/factory/lib/foo.test.ts")).toBe(false);
  });

  test("rejects a declaration file", () => {
    expect(isTargetPath("scripts/types.d.ts")).toBe(false);
  });

  test("rejects a test helper under tests", () => {
    expect(isTargetPath("tests/fixtures/helper.ts")).toBe(false);
  });

  test("rejects the console sources", () => {
    expect(isTargetPath("console/src/lib/pipeline.ts")).toBe(false);
  });

  test("rejects a path that leaves the repository", () => {
    expect(isTargetPath("../../tmp/x/f/factory/foo.ts")).toBe(false);
  });

  test("rejects a path that climbs out through a target prefix", () => {
    expect(isTargetPath("f/factory/../../etc/foo.ts")).toBe(false);
  });

  test("rejects a non-TypeScript file", () => {
    expect(isTargetPath("f/factory/lib/foo.script.yaml")).toBe(false);
  });
});

describe("summarizeLcov", () => {
  test("counts executed and executable lines of a target file", () => {
    const text = record("f/factory/lib/a.ts", hitsOf(10, 8));

    expect(summarizeLcov(text)).toMatchObject({ executable: 10, executed: 8 });
  });

  test("leaves files outside the target out of the totals", () => {
    const text = [
      record("f/factory/lib/a.ts", hitsOf(10, 8)),
      record("../../tmp/x/b.ts", hitsOf(100, 0)),
      record("tests/fixtures/c.ts", hitsOf(100, 0)),
      record("console/src/d.ts", hitsOf(100, 0)),
    ].join("\n");

    expect(summarizeLcov(text)).toMatchObject({ executable: 10, executed: 8 });
  });

  test("counts a line once when the same file appears twice", () => {
    const text = [
      record("f/factory/lib/a.ts", [
        [1, 1],
        [2, 0],
        [3, 0],
        [4, 0],
      ]),
      record("f/factory/lib/a.ts", [
        [1, 0],
        [2, 1],
        [3, 0],
        [4, 0],
      ]),
    ].join("\n");

    expect(summarizeLcov(text)).toMatchObject({ executable: 4, executed: 2 });
  });

  test("lists a file that appears twice as one file", () => {
    const text = [
      record("f/factory/lib/a.ts", hitsOf(4, 1)),
      record("f/factory/lib/a.ts", hitsOf(4, 2)),
    ].join("\n");

    expect(summarizeLcov(text).files).toHaveLength(1);
  });

  test("ignores lines it cannot parse", () => {
    const text = record("f/factory/lib/a.ts", hitsOf(4, 2), "DA:oops,x");

    expect(summarizeLcov(text)).toMatchObject({ executable: 4, executed: 2 });
  });
});

describe("judgeCoverage", () => {
  test("passes when the ratio equals the floor", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 8)));

    expect(judgeCoverage(summary, 80).ok).toBe(true);
  });

  test("passes when the ratio is above the floor", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 9)));

    expect(judgeCoverage(summary, 80).ok).toBe(true);
  });

  test("fails when the ratio is below the floor", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    expect(judgeCoverage(summary, 80).ok).toBe(false);
  });

  test("states the measured ratio on failure", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    expect(judgeCoverage(summary, 80).message).toContain("70.00%");
  });

  test("states the floor on failure", () => {
    const summary = summarizeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    expect(judgeCoverage(summary, 80).message).toContain("80.00%");
  });

  test("lists the file with the most unexecuted lines first", () => {
    const text = [
      record("f/factory/lib/small.ts", hitsOf(10, 0)),
      record("f/factory/lib/large.ts", hitsOf(100, 10)),
    ].join("\n");

    const message = judgeCoverage(summarizeLcov(text), 80).message;

    expect(message.indexOf("large.ts")).toBeLessThan(
      message.indexOf("small.ts"),
    );
  });

  test("lists at most five files", () => {
    const text = Array.from({ length: 8 }, (_, index) =>
      record(`f/factory/lib/file${index}.ts`, hitsOf(10, 0)),
    ).join("\n");

    const message = judgeCoverage(summarizeLcov(text), 80).message;

    expect(message.match(/f\/factory\/lib\/file\d\.ts/g)).toHaveLength(5);
  });

  test("keeps function names out of the failure output", () => {
    const text = record(
      "f/factory/lib/a.ts",
      hitsOf(10, 0),
      "FN:3,secretFunctionName",
    );

    expect(judgeCoverage(summarizeLcov(text), 80).message).not.toContain(
      "secretFunctionName",
    );
  });

  test("fails when there are no target files", () => {
    const summary = summarizeLcov(
      record("tests/fixtures/c.ts", hitsOf(10, 10)),
    );

    expect(judgeCoverage(summary, 0).ok).toBe(false);
  });

  test("says that no target file was found", () => {
    const summary = summarizeLcov(
      record("tests/fixtures/c.ts", hitsOf(10, 10)),
    );

    expect(judgeCoverage(summary, 0).message).toContain("no target");
  });
});

describe("checkCoverage", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-coverage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeLcov(text: string): void {
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(join(root, "coverage", "lcov.info"), text);
  }

  const untracked = (): readonly string[] => [];

  test("passes with a readable lcov at or above the floor", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 8)));

    const result = checkCoverage({
      root,
      floorPercent: 80,
      listTracked: untracked,
    });

    expect(result.ok).toBe(true);
  });

  test("fails with a readable lcov below the floor", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 7)));

    const result = checkCoverage({
      root,
      floorPercent: 80,
      listTracked: untracked,
    });

    expect(result.message).toContain("70.00%");
  });

  test("fails when coverage/lcov.info is missing", () => {
    const result = checkCoverage({ root, listTracked: untracked });

    expect(result.message).toContain("lcov.info");
  });

  test("fails when coverage/lcov.info is empty", () => {
    writeLcov("");

    const result = checkCoverage({ root, listTracked: untracked });

    expect(result.message).toContain("empty");
  });

  test("fails when coverage/lcov.info is a directory", () => {
    mkdirSync(join(root, "coverage", "lcov.info"), { recursive: true });

    const result = checkCoverage({ root, listTracked: untracked });

    expect(result.message).toContain("regular file");
  });

  test("fails when lcov.info is a symlink", () => {
    mkdirSync(join(root, "coverage"));
    writeFileSync(
      join(root, "real.info"),
      record("f/factory/a.ts", hitsOf(1, 1)),
    );
    symlinkSync(join(root, "real.info"), join(root, "coverage", "lcov.info"));

    const result = checkCoverage({ root, listTracked: untracked });

    expect(result.message).toContain("symlink");
  });

  test("fails when the lcov has no target file", () => {
    writeLcov(record("tests/fixtures/c.ts", hitsOf(10, 10)));

    const result = checkCoverage({ root, listTracked: untracked });

    expect(result.message).toContain("no target");
  });

  test("fails when coverage is a symlink to a directory", () => {
    const real = join(root, "elsewhere");
    mkdirSync(real);
    writeFileSync(
      join(real, "lcov.info"),
      record("f/factory/lib/a.ts", hitsOf(10, 10)),
    );
    symlinkSync(real, join(root, "coverage"));

    const result = checkCoverage({ root, listTracked: untracked });

    expect(result.message).toContain("symlink");
  });

  test("fails when coverage holds files tracked by git", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      listTracked: () => ["coverage/lcov.info"],
    });

    expect(result.message).toContain("tracked");
  });

  test("fails when git cannot list the tracked files", () => {
    writeLcov(record("f/factory/lib/a.ts", hitsOf(10, 10)));

    const result = checkCoverage({
      root,
      listTracked: () => {
        throw new Error("git failed");
      },
    });

    expect(result.message).toContain("git ls-files");
  });
});
