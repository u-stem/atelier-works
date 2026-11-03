#!/usr/bin/env bun
// `mise run test`が作るcoverage/lcov.infoから全体の行カバレッジを求め、下限を割っていないか確かめる。
//
// bunの`coverageThreshold`は、ファイルごとに判定する。全体の下限には使えないので、ここで縛る。
// lcovに分岐(BRDA)は出ないので、見るのは行だけである。
//
// 数える対象は、`f/factory/**`と`scripts/**`の`.ts`から、`*.test.ts`と`*.d.ts`を除いたもの。
// lcovには`console/`、`infra/`、`tests/`の補助、テストが作る一時ファイルも混ざるが、母数に入れない。
// bunは、テストが一度も読み込まなかったファイルをlcovに出さない。下限は「読み込まれた対象」の値で、
// 未読み込みのファイルは分母に入らない。
//
// 同じファイルがlcovに複数回出ても正しく数えるため、行ごとの和集合で数える。
// どれかの記録で回数が0より大きい行を実行済みとし、`LF`と`LH`は使わない。
//
// 次のどれかのときは、終了コード1で止まる(fail-closed)。
// - coverage/lcov.infoが無い、空、通常のファイルでない、読めない。
// - coverageがsymlinkなど、実在のディレクトリでない。
// - `git ls-files -- coverage`が空でない。コミットされたlcovで検査を通せないようにする。
// - 対象のファイルが1件も無い。
//
// 失敗の出力は、全体の値、下限、未実行の行が多い対象の上位のパスと割合に限る。行の中身は出さない。
//
// 下限を上げるときは、実測を見てこの定数を変える。変更は保護パスの変更として扱う。
// 使い方: bun ./scripts/check-coverage.ts

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 全体の行カバレッジの下限(%)。実測より低く置き、実測を見て詰める。 */
export const COVERAGE_FLOOR_PERCENT = 83.94;

/** 失敗の出力に載せる、未実行の行が多い対象の件数。 */
const WORST_FILE_COUNT = 5;

export type FileCoverage = {
  readonly path: string;
  readonly executable: number;
  readonly executed: number;
};

export type CoverageSummary = {
  readonly files: readonly FileCoverage[];
  readonly executable: number;
  readonly executed: number;
};

export type Verdict = {
  readonly ok: boolean;
  readonly message: string;
};

export type CheckCoverageOptions = {
  /** リポジトリのルート。coverage/lcov.infoはその直下から読む。 */
  readonly root: string;
  readonly floorPercent?: number;
  /** `git ls-files -- coverage`の結果。既定は実際にgitを呼ぶ。 */
  readonly listTracked?: (root: string) => readonly string[];
};

// パスに使える文字を絞る。外れたファイルは対象にしない(出力に制御文字を載せないためでもある)。
const TARGET_PATH = /^(?:f\/factory|scripts)\/[\w./@+-]+\.ts$/;
const DA_LINE = /^DA:(\d+),(\d+)(?:,.*)?$/;

/** lcovの`SF`のパスが、下限の対象かを返す。 */
export function isTargetPath(path: string): boolean {
  if (!TARGET_PATH.test(path)) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".d.ts")) return false;
  return !path.split("/").includes("..");
}

/**
 * lcovを解析し、対象のファイルごとの行数を数える。
 * 同じ`SF`が複数回出ても1つにまとめ、どれかで実行された行を実行済みとする。
 * 解析できない行は無視する。
 */
export function summarizeLcov(text: string): CoverageSummary {
  const byPath = new Map<string, Map<number, boolean>>();
  let current: Map<number, boolean> | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("SF:")) {
      const path = line.slice("SF:".length);
      if (!isTargetPath(path)) {
        current = null;
        continue;
      }
      const known = byPath.get(path);
      current = known ?? new Map<number, boolean>();
      byPath.set(path, current);
      continue;
    }
    if (line === "end_of_record") {
      current = null;
      continue;
    }
    if (current === null) continue;
    const match = DA_LINE.exec(line);
    if (match === null) continue;
    const lineNumber = Number(match[1]);
    const executed = Number(match[2]) > 0;
    current.set(lineNumber, current.get(lineNumber) === true || executed);
  }

  const files: FileCoverage[] = [];
  let executable = 0;
  let executed = 0;
  for (const [path, lines] of byPath) {
    const fileExecuted = [...lines.values()].filter(Boolean).length;
    files.push({ path, executable: lines.size, executed: fileExecuted });
    executable += lines.size;
    executed += fileExecuted;
  }
  return { files, executable, executed };
}

function percent(executed: number, executable: number): number {
  return executable === 0 ? 0 : (executed / executable) * 100;
}

function leastCovered(summary: CoverageSummary): readonly FileCoverage[] {
  return [...summary.files]
    .filter((file) => file.executed < file.executable)
    .sort(
      (a, b) =>
        b.executable - b.executed - (a.executable - a.executed) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, WORST_FILE_COUNT);
}

/** 集計が下限を満たすかを判定する。失敗の出力には行の中身を含めない。 */
export function judgeCoverage(
  summary: CoverageSummary,
  floorPercent: number,
): Verdict {
  if (summary.files.length === 0 || summary.executable === 0) {
    return {
      ok: false,
      message:
        "coverage check failed: no target file found in coverage/lcov.info",
    };
  }
  const ratio = percent(summary.executed, summary.executable);
  const head = `line coverage ${ratio.toFixed(2)}% (${summary.executed} of ${summary.executable} lines in ${summary.files.length} files), floor ${floorPercent.toFixed(2)}%`;
  if (summary.executed * 100 >= floorPercent * summary.executable) {
    return { ok: true, message: head };
  }
  const rows = leastCovered(summary).map((file) => {
    const unexecuted = file.executable - file.executed;
    const fileRatio = percent(file.executed, file.executable).toFixed(1);
    return `  ${file.path}: ${fileRatio}% (${unexecuted} of ${file.executable} lines not executed)`;
  });
  return {
    ok: false,
    message: [
      `coverage check failed: ${head}`,
      "files with the most unexecuted lines:",
      ...rows,
    ].join("\n"),
  };
}

function listTrackedWithGit(root: string): readonly string[] {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--", "coverage"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`exit code ${result.exitCode}`);
  }
  return result.stdout
    .toString()
    .split("\0")
    .filter((entry) => entry !== "");
}

function failure(reason: string): Verdict {
  return { ok: false, message: `coverage check failed: ${reason}` };
}

/** lstatでパスの種類を調べる。symlinkは辿らず、調べられなければ`missing`にする。 */
function inspect(path: string): "missing" | "symlink" | "directory" | "file" {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return "missing";
  }
  if (stat.isSymbolicLink()) return "symlink";
  return stat.isDirectory() ? "directory" : "file";
}

/** coverage/lcov.infoを検証して読み、下限と照らす。 */
export function checkCoverage(options: CheckCoverageOptions): Verdict {
  const floor = options.floorPercent ?? COVERAGE_FLOOR_PERCENT;
  const listTracked = options.listTracked ?? listTrackedWithGit;

  let tracked: readonly string[];
  try {
    tracked = listTracked(options.root);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failure(`git ls-files -- coverage failed (${reason})`);
  }
  if (tracked.length > 0) {
    return failure(
      `files under coverage/ are tracked by git (${tracked.join(", ")})`,
    );
  }

  const dir = join(options.root, "coverage");
  const dirKind = inspect(dir);
  if (dirKind === "symlink") {
    return failure("coverage is a symlink, expected a real directory");
  }
  if (dirKind === "file") {
    return failure("coverage is not a directory");
  }
  const file = join(dir, "lcov.info");
  const fileKind = inspect(file);
  if (fileKind === "missing") {
    return failure("coverage/lcov.info is missing (run mise run test first)");
  }
  if (fileKind === "symlink") {
    return failure("coverage/lcov.info is a symlink");
  }
  if (fileKind !== "file") {
    return failure("coverage/lcov.info is not a regular file");
  }

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return failure("coverage/lcov.info is not readable");
  }
  if (text.trim() === "") {
    return failure("coverage/lcov.info is empty");
  }
  return judgeCoverage(summarizeLcov(text), floor);
}

if (import.meta.main) {
  const result = checkCoverage({ root: resolve(import.meta.dir, "..") });
  if (result.ok) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}
