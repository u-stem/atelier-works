#!/usr/bin/env bun
// `mise run test`が作るcoverage/lcov.infoから行カバレッジを求め、全体と層ごとの下限を割っていないか確かめる。
//
// bunの`coverageThreshold`は、ファイルごとに判定する。全体や層の下限には使えないので、ここで縛る。
// lcovに分岐(BRDA)は出ないので、見るのは行だけである。
//
// 数える対象は、`f/factory/**`と`scripts/**`の`.ts`から、`*.test.ts`と`*.d.ts`を除いたもの。
// 対象の一覧は、作業ツリーに実在する追跡中と未追跡のファイル(`git ls-files`)から作る。
// lcovには`console/`、`infra/`、`tests/`の補助、テストが作る一時ファイルも混ざるが、
// 一覧に無いものは分母にも分子にも入れない。
//
// bunは、テストが一度も読み込まなかったファイルをlcovに出さない。
// 一覧にあるのにlcovに出ない対象は、実行可能な行数が分からず、推定は検査を甘くするので、失敗にする。
// `f/factory/**`は`tests/lib/coverage_load_all.test.ts`がすべて読み込む。
// `scripts/**`は、そのファイルをimportするテストを足す。
// bunのテストでは読み込めないものだけを`NOT_LOADABLE_BY_BUN_TEST`に足す。
//
// 同じファイルがlcovに複数回出ても正しく数えるため、行ごとの和集合で数える。
// どれかの記録で回数が0より大きい行を実行済みとし、`LF`と`LH`は使わない。
//
// 次のどれかのときは、終了コード1で止まる(fail-closed)。
// - coverage/lcov.infoが無い、空、通常のファイルでない、読めない。
// - coverageがsymlinkなど、実在のディレクトリでない。
// - `git ls-files -- coverage`が空でない。コミットされたlcovで検査を通せないようにする。
// - 対象の一覧を作る`git ls-files`が失敗する。作業ツリーのパスを調べられない(無い場合を除く)。対象のファイルが1件も無い。
// - 名前が許可する文字の外にある対象がある。数えられないまま外れるのを防ぐ。
// - 一覧にあるのにlcovに出ない対象がある。
// - `NOT_LOADABLE_BY_BUN_TEST`の項目が、許す形でない、作業ツリーの対象の一覧に無い、lcovに出ている。
// - 下限の表に載る層に、対象が1件も無い。
// - 全体、または層のどれかが、下限を割る。
//
// 失敗の出力は、Factoryの修正のプロンプトに載る末尾2000字から、miseのタスク失敗の行の分を引いた字数に収める。
// 割った層、未読み込みの総数と上位のパスを、出力の最後に置く。
// 出すのは、値、下限、パス、割合に限る。行の中身は出さない。標準エラーも載せない。
//
// 下限を変えるときは、実測を見てこの定数を変える。変更は保護パスの変更として扱う。
// 使い方: bun ./scripts/check-coverage.ts

import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** 全体の行カバレッジの下限(%)。ローカルの実測より2ポイント低く置き、実測を見て詰める。 */
export const COVERAGE_FLOOR_PERCENT = 82.76;

export type Layer =
  | "f/factory/lib"
  | "f/factory/steps"
  | "f/factory (other)"
  | "scripts";

export type LayerFloor = {
  readonly layer: Layer;
  readonly floorPercent: number;
};

/**
 * 層ごとの行カバレッジの下限(%)。ローカルの実測より2ポイント低く置き、実測を見て詰める。
 * 層は、全体の値に隠れる低い層を拾うために分ける。
 */
export const LAYER_FLOORS: readonly LayerFloor[] = [
  { layer: "f/factory/lib", floorPercent: 96.23 },
  { layer: "f/factory/steps", floorPercent: 54.11 },
  { layer: "f/factory (other)", floorPercent: 61.59 },
  { layer: "scripts", floorPercent: 90.08 },
];

/**
 * bunのテストでは読み込めない対象。読み込むと本物のDBに文を流すので、
 * `mise run test:db`が実行する。ここに足した対象は、分母にも分子にも入れない。
 * 足す変更は、検査の対象を狭めるので、人がレビューする。
 */
export const NOT_LOADABLE_BY_BUN_TEST: readonly string[] = [
  "scripts/test-db-console-actions.ts",
  "scripts/test-db-deploy-approvals.ts",
  "scripts/test-db-holds.ts",
  "scripts/test-db-queries.ts",
];

/** `NOT_LOADABLE_BY_BUN_TEST`に入れてよいパスの形。これ以外は受け付けない。 */
export const NOT_LOADABLE_PATH = /^scripts\/test-db-[\w-]+\.ts$/;

/**
 * 失敗の出力の字数の上限。`check_runner`は出力の末尾2000字を修正のプロンプトに載せる。
 * 末尾にはmiseのタスク失敗の行が付くので、その分を引く。
 */
const OUTPUT_BUDGET_CHARS = 1800;

/** 失敗の出力に載せる、未実行の行が多い対象と、未読み込みの対象の件数。 */
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

export type TargetListing = {
  /** 対象のパス。作業ツリーに実在するものに限り、並べ替えて重複を除く。 */
  readonly targets: readonly string[];
  /** 対象の接頭辞と拡張子を持つが、名前に許可する文字の外を含むパス。 */
  readonly malformed: readonly string[];
};

export type ListTargetsOptions = {
  /** trueなら、追跡していない(gitignoreされていない)ファイルも列挙する。 */
  readonly includeUntracked: boolean;
};

export type JudgeOptions = {
  readonly layerFloors?: readonly LayerFloor[];
  /** 一覧にあるのにlcovに出ない対象。 */
  readonly unloaded?: readonly string[];
};

export type CheckCoverageOptions = {
  /** リポジトリのルート。coverage/lcov.infoはその直下から読む。 */
  readonly root: string;
  readonly floorPercent?: number;
  readonly layerFloors?: readonly LayerFloor[];
  readonly notLoadable?: readonly string[];
  /** `git ls-files -- coverage`の結果。既定は実際にgitを呼ぶ。 */
  readonly listTracked?: (root: string) => readonly string[];
  /** 下限の対象の列挙。既定は実際にgitを呼ぶ。 */
  readonly listTargets?: (
    root: string,
    options: ListTargetsOptions,
  ) => TargetListing;
};

// パスに使える文字を絞る。外れたファイルは対象にせず、検査を失敗させる(出力に制御文字を載せないためでもある)。
const TARGET_PATH = /^(?:f\/factory|scripts)\/[\w./@+-]+\.ts$/;
const DA_LINE = /^DA:(\d+),(\d+)(?:,.*)?$/;

/** lcovの`SF`のパスが、下限の対象かを返す。 */
export function isTargetPath(path: string): boolean {
  if (!TARGET_PATH.test(path)) return false;
  if (path.endsWith(".test.ts") || path.endsWith(".d.ts")) return false;
  return !path.split("/").includes("..");
}

/**
 * パスが属する層を返す。対象のパスでなければnullを返す。
 * 接頭辞で決めるので、対象のパスはどれかの層に入る。
 */
export function layerOf(path: string): Layer | null {
  if (!isTargetPath(path)) return null;
  if (path.startsWith("f/factory/lib/")) return "f/factory/lib";
  if (path.startsWith("f/factory/steps/")) return "f/factory/steps";
  if (path.startsWith("f/factory/")) return "f/factory (other)";
  return "scripts";
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

type Tally = {
  readonly files: readonly FileCoverage[];
  readonly executable: number;
  readonly executed: number;
};

function tally(files: readonly FileCoverage[]): Tally {
  return {
    files,
    executable: files.reduce((sum, file) => sum + file.executable, 0),
    executed: files.reduce((sum, file) => sum + file.executed, 0),
  };
}

function percent(executed: number, executable: number): number {
  return executable === 0 ? 0 : (executed / executable) * 100;
}

function meetsFloor(counts: Tally, floorPercent: number): boolean {
  return counts.executed * 100 >= floorPercent * counts.executable;
}

function describeCounts(counts: Tally, floorPercent: number): string {
  const ratio = percent(counts.executed, counts.executable).toFixed(2);
  return `${ratio}% (${counts.executed} of ${counts.executable} lines in ${counts.files.length} files), floor ${floorPercent.toFixed(2)}%`;
}

function leastCovered(files: readonly FileCoverage[]): readonly FileCoverage[] {
  return [...files]
    .filter((file) => file.executed < file.executable)
    .sort(
      (a, b) =>
        b.executable - b.executed - (a.executable - a.executed) ||
        a.path.localeCompare(b.path),
    )
    .slice(0, WORST_FILE_COUNT);
}

function worstRows(files: readonly FileCoverage[]): string[] {
  return leastCovered(files).map((file) => {
    const unexecuted = file.executable - file.executed;
    const fileRatio = percent(file.executed, file.executable).toFixed(1);
    return `  ${file.path}: ${fileRatio}% (${unexecuted} of ${file.executable} lines not executed)`;
  });
}

/** 見出し1行と、字数が足りないときに末尾から削る詳細の行。 */
type Section = { readonly heading: string; readonly details: string[] };

/** 見出しと、残っている詳細の行を並べる。詳細が無い見出しだけの節は、`keepEmpty`のときだけ残す。 */
function render(sections: readonly Section[], keepEmpty: boolean): string[] {
  return sections.flatMap(({ heading, details }) =>
    details.length === 0 && !keepEmpty ? [] : [heading, ...details],
  );
}

/**
 * 失敗の出力を、字数の上限に収める。
 * 理由の節(`reasons`)は出力の最後に置き、見出しを残す。
 * 収まらないときは、未実行の行が多い対象の行を後ろから、次に理由の詳細を後ろから削る。
 */
function composeFailure(
  head: readonly string[],
  rows: readonly Section[],
  reasons: readonly Section[],
): string {
  const build = (): string =>
    [...head, ...render(rows, false), ...render(reasons, true)].join("\n");
  const popLast = (sections: readonly Section[]): boolean => {
    for (let index = sections.length - 1; index >= 0; index -= 1) {
      const section = sections[index];
      if (section !== undefined && section.details.length > 0) {
        section.details.pop();
        return true;
      }
    }
    return false;
  };
  let text = build();
  while (text.length > OUTPUT_BUDGET_CHARS) {
    if (!popLast(rows) && !popLast(reasons)) break;
    text = build();
  }
  return text;
}

/** 未読み込みの対象の理由の節。上位のパスは、字数が足りないときに削る詳細に入れる。 */
function unloadedSection(unloaded: readonly string[]): Section {
  const shown = [...unloaded].sort().slice(0, WORST_FILE_COUNT);
  const rest = unloaded.length - shown.length;
  return {
    heading: `${unloaded.length} target files were not loaded by any test (no record in coverage/lcov.info; see docs/testing-guidelines.md):`,
    details: [
      ...shown.map((path) => `  ${path}`),
      ...(rest > 0 ? [`  ... and ${rest} more`] : []),
    ],
  };
}

/**
 * 集計が全体と層ごとの下限を満たし、未読み込みの対象が無いかを判定する。
 * 失敗の出力には行の中身を含めず、字数の上限に収める。
 */
export function judgeCoverage(
  summary: CoverageSummary,
  floorPercent: number,
  options: JudgeOptions = {},
): Verdict {
  const layerFloors = options.layerFloors ?? [];
  const unloaded = options.unloaded ?? [];
  if (summary.files.length === 0 || summary.executable === 0) {
    return {
      ok: false,
      message:
        "coverage check failed: no target file found in coverage/lcov.info",
    };
  }

  const layers = layerFloors.map(({ layer, floorPercent: layerFloor }) => ({
    layer,
    floorPercent: layerFloor,
    counts: tally(summary.files.filter((file) => layerOf(file.path) === layer)),
  }));
  const empty = layers.filter(({ counts }) => counts.executable === 0);
  if (empty.length > 0) {
    return {
      ok: false,
      message: composeFailure(
        ["coverage check failed:"],
        [],
        [
          ...empty.map(({ layer }) => ({
            heading: `no target file in layer ${layer}`,
            details: [],
          })),
          ...(unloaded.length > 0 ? [unloadedSection(unloaded)] : []),
        ],
      ),
    };
  }

  const total = tally(summary.files);
  const totalMeets = meetsFloor(total, floorPercent);
  const below = layers.filter(
    ({ counts, floorPercent: layerFloor }) => !meetsFloor(counts, layerFloor),
  );
  const head = `line coverage ${describeCounts(total, floorPercent)}`;
  const layerLines = layers.map(
    ({ layer, counts, floorPercent: layerFloor }) =>
      `  ${layer}: ${describeCounts(counts, layerFloor)}`,
  );
  if (totalMeets && below.length === 0 && unloaded.length === 0) {
    return { ok: true, message: [head, ...layerLines].join("\n") };
  }

  const rows: Section[] = below.map(({ layer, counts }) => ({
    heading: `files with the most unexecuted lines in ${layer}:`,
    details: worstRows(counts.files),
  }));
  if (!totalMeets && below.length === 0) {
    rows.push({
      heading: "files with the most unexecuted lines:",
      details: worstRows(summary.files),
    });
  }
  const reasons: Section[] = below.map(
    ({ layer, counts, floorPercent: layerFloor }) => ({
      heading: `${layer} is below its floor: ${percent(counts.executed, counts.executable).toFixed(2)}% < ${layerFloor.toFixed(2)}%`,
      details: [],
    }),
  );
  if (!totalMeets) {
    reasons.push({
      heading: `total is below its floor: ${percent(total.executed, total.executable).toFixed(2)}% < ${floorPercent.toFixed(2)}%`,
      details: [],
    });
  }
  if (unloaded.length > 0) reasons.push(unloadedSection(unloaded));
  return {
    ok: false,
    message: composeFailure(
      [`coverage check failed: ${head}`, ...layerLines],
      rows,
      reasons,
    ),
  };
}

function runGit(argv: readonly string[], cwd: string): string {
  const result = Bun.spawnSync([...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git exited with code ${result.exitCode}`);
  }
  return result.stdout.toString();
}

function listTrackedWithGit(root: string): readonly string[] {
  return runGit(["git", "ls-files", "-z", "--", "coverage"], root)
    .split("\0")
    .filter((entry) => entry !== "");
}

/**
 * 対象を列挙する`git ls-files`の引数。シェルを通さず、`-z`でNUL区切りにし、`--`でパスと分ける。
 * 未読み込みの判定は未追跡のファイルも含め、読み込みのテストはステージ済みまでにする。
 * 未追跡のファイルは、`git add`の明示の操作の後に初めて読み込まれる。
 */
export function targetListArgv(options: ListTargetsOptions): string[] {
  return [
    "git",
    "ls-files",
    "-z",
    "--cached",
    ...(options.includeUntracked ? ["--others", "--exclude-standard"] : []),
    "--",
    "f/factory",
    "scripts",
  ];
}

function isCandidate(path: string): boolean {
  return (
    (path.startsWith("f/factory/") || path.startsWith("scripts/")) &&
    path.endsWith(".ts") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".d.ts")
  );
}

/**
 * gitの出力のパスから、対象と、名前の取りこぼしを選ぶ。
 * 作業ツリーに無いパスは、どちらにも入れない。ステージせずに消しただけの追跡中のファイルが、
 * 読み込みの失敗や未読み込みで止まらないようにする。
 */
export function selectTargets(
  entries: readonly string[],
  exists: (path: string) => boolean,
): TargetListing {
  const targets = new Set<string>();
  const malformed = new Set<string>();
  for (const entry of entries) {
    if (!isCandidate(entry) || !exists(entry)) continue;
    (isTargetPath(entry) ? targets : malformed).add(entry);
  }
  return { targets: [...targets].sort(), malformed: [...malformed].sort() };
}

/** 下限の対象を列挙する。gitが失敗したら投げる。`run`は、テストで差し替える。 */
export function listTargetFiles(
  root: string,
  options: ListTargetsOptions,
  run: (argv: readonly string[], cwd: string) => string = runGit,
): TargetListing {
  const entries = run(targetListArgv(options), root)
    .split("\0")
    .filter((entry) => entry !== "");
  return selectTargets(entries, (path) => existsInTree(join(root, path)));
}

/**
 * パスが作業ツリーにあるかを返す。無い(ENOENT)ときだけfalseにする。
 * 権限やsymlinkの輪など、ほかの理由で調べられないときは、無いものとして外さず投げる。
 */
function existsInTree(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function failure(reason: string): Verdict {
  return { ok: false, message: `coverage check failed: ${reason}` };
}

/** 名前の取りこぼしの失敗。パスは`JSON.stringify`でエスケープし、制御文字を出力に載せない。 */
function malformedFailure(malformed: readonly string[]): Verdict {
  const details = malformed
    .slice(0, WORST_FILE_COUNT)
    .map((path) => `  ${JSON.stringify(path)}`);
  return {
    ok: false,
    message: composeFailure(
      [],
      [],
      [
        {
          heading: `coverage check failed: ${malformed.length} target file names use characters outside [A-Za-z0-9_./@+-] and cannot be counted:`,
          details,
        },
      ],
    ),
  };
}

/** `NOT_LOADABLE_BY_BUN_TEST`の項目の誤りを返す。無ければnullを返す。 */
function checkNotLoadable(
  notLoadable: readonly string[],
  targets: ReadonlySet<string>,
  lcovPaths: ReadonlySet<string>,
): string | null {
  for (const path of notLoadable) {
    if (!NOT_LOADABLE_PATH.test(path)) {
      return `NOT_LOADABLE_BY_BUN_TEST has an entry outside the allowed form scripts/test-db-*.ts: ${JSON.stringify(path)}`;
    }
    if (!targets.has(path)) {
      return `NOT_LOADABLE_BY_BUN_TEST lists ${path}, which is not among the target files in the working tree (remove the entry)`;
    }
    if (lcovPaths.has(path)) {
      return `NOT_LOADABLE_BY_BUN_TEST lists ${path}, but it is in lcov (remove the entry)`;
    }
  }
  return null;
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

/** coverage/lcov.infoを検証して読み、対象の一覧と照らして、下限と未読み込みを判定する。 */
export function checkCoverage(options: CheckCoverageOptions): Verdict {
  const floor = options.floorPercent ?? COVERAGE_FLOOR_PERCENT;
  const layerFloors = options.layerFloors ?? LAYER_FLOORS;
  const notLoadable = options.notLoadable ?? NOT_LOADABLE_BY_BUN_TEST;
  const listTracked = options.listTracked ?? listTrackedWithGit;
  const listTargets = options.listTargets ?? listTargetFiles;

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

  // 失敗の理由にgitの標準エラーを載せないよう、投げられた内容は読まない。
  let listing: TargetListing;
  try {
    listing = listTargets(options.root, { includeUntracked: true });
  } catch {
    return failure("listing the target files failed (git ls-files)");
  }
  if (listing.malformed.length > 0) {
    return malformedFailure(listing.malformed);
  }
  if (listing.targets.length === 0) {
    return failure("no target file found in the working tree (git ls-files)");
  }

  const lcov = summarizeLcov(text);
  const lcovPaths = new Set(lcov.files.map((entry) => entry.path));
  const invalid = checkNotLoadable(
    notLoadable,
    new Set(listing.targets),
    lcovPaths,
  );
  if (invalid !== null) return failure(invalid);

  // 分母に入れるのは、一覧にあり、読み込める対象だけである。一覧に無い`SF`は無視する。
  const excluded = new Set(notLoadable);
  const countable = listing.targets.filter((path) => !excluded.has(path));
  const countableSet = new Set(countable);
  const loaded = tally(
    lcov.files.filter((entry) => countableSet.has(entry.path)),
  );
  const unloaded = countable.filter((path) => !lcovPaths.has(path));
  return judgeCoverage(loaded, floor, { layerFloors, unloaded });
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
