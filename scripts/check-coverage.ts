#!/usr/bin/env bun
// lcovから全体の行カバレッジを求め、下限を割っていないか確かめる。
// 実装は後続のコミットで書く。このファイルはテストが読み込めるようにする最小のスタブである。

export const COVERAGE_FLOOR_PERCENT = 0;

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
  readonly root: string;
  readonly floorPercent?: number;
  readonly listTracked?: (root: string) => readonly string[];
};

export function isTargetPath(_path: string): boolean {
  return false;
}

export function summarizeLcov(_text: string): CoverageSummary {
  return { files: [], executable: 0, executed: 0 };
}

export function judgeCoverage(
  _summary: CoverageSummary,
  _floorPercent: number,
): Verdict {
  return { ok: false, message: "" };
}

export function checkCoverage(_options: CheckCoverageOptions): Verdict {
  return { ok: false, message: "" };
}
