import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// `scripts/test-db.sh`の使い捨てのデータベース名は、作業ツリーごとに変える。
// 複数のworktreeが同時に流しても、互いのデータベースを消さないためである。

const SOURCE = readFileSync("scripts/test-db.sh", "utf8");
const ASSIGNMENT = /^SCRATCH_DB=.*$/m.exec(SOURCE)?.[0] ?? "";
const BASH = Bun.which("bash") ?? "bash";

/** 代入の行だけを、`root`をREPO_ROOTにして評価し、得た名前を返す。 */
function scratchNameFor(root: string): string {
  const result = Bun.spawnSync(
    [
      BASH,
      "-c",
      `REPO_ROOT="$1"; ${ASSIGNMENT}; printf '%s' "$SCRATCH_DB"`,
      "_",
      root,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return result.stdout.toString();
}

describe("the scratch database name of test-db.sh", () => {
  test("has an assignment line", () => {
    expect(ASSIGNMENT).not.toBe("");
  });

  test("differs between two working trees", () => {
    expect(scratchNameFor("/work/trees/a")).not.toBe(
      scratchNameFor("/work/trees/b"),
    );
  });

  test("is the same for the same working tree", () => {
    expect(scratchNameFor("/work/trees/a")).toBe(
      scratchNameFor("/work/trees/a"),
    );
  });

  test("is a lowercase identifier that PostgreSQL accepts", () => {
    expect(scratchNameFor("/work/trees/a")).toMatch(
      /^factory_test_[0-9]{1,10}$/,
    );
  });

  test("stays within the 63 characters of a database name", () => {
    expect(
      scratchNameFor("/a/very/long/path/".repeat(50)).length,
    ).toBeLessThanOrEqual(63);
  });

  test("is not written as a literal anywhere else in the commands", () => {
    const code = SOURCE.split("\n").filter(
      (line) =>
        !line.trimStart().startsWith("#") && !line.startsWith("SCRATCH_DB="),
    );
    expect(code.filter((line) => line.includes("factory_test"))).toEqual([]);
  });
});
