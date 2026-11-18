// スキルとプロンプトの回帰評価の純粋な部分。
// 固定の差分に対するレビューの出力を、正解の定義と照合し、検出率と誤検知を求める。
// Claudeの起動、gitの読み取り、ファイルの読み込みは`scripts/review-eval.ts`が担う。
//
// このモジュールの指標は、DBに記録した採用率などの指標とは別物である。
// 同じ表には混ぜない。

import {
  isNumber,
  isOneOf,
  isRecord,
  isString,
  type ReviewFindingKind,
} from "./types.ts";

/** 正解の行の範囲の前後に許す行数。指摘が欠陥の数行先や手前を指しても、同じ箇所とみなす。 */
export const LINE_TOLERANCE = 2;

const FINDING_KINDS: readonly ReviewFindingKind[] = [
  "must",
  "imo",
  "nits",
  "q",
];

/** 誤検知に数える指摘の種類。nitsと質問は、問題があるという主張ではないので数えない。 */
const CLAIMING_KINDS: readonly ReviewFindingKind[] = ["must", "imo"];

const CONFIDENCES = ["high", "medium", "low"] as const;
export type EvalConfidence = (typeof CONFIDENCES)[number];

// ---------------------------------------------------------------------------
// 正解の定義
// ---------------------------------------------------------------------------

/** 差分に仕込んだ欠陥1件。行は、差分の新しい側(head)の行番号で、両端を含む。 */
export type ExpectedDefect = {
  readonly id: string;
  readonly path: string;
  readonly start_line: number;
  readonly end_line: number;
  /** この欠陥の検出とみなす指摘の種類。 */
  readonly kinds: readonly ReviewFindingKind[];
};

export type EvalCase = {
  readonly id: string;
  readonly title: string;
  /** 差分のファイル名。`expected.json`と同じディレクトリにある。 */
  readonly diff: string;
  /** 空なら無欠陥のケース。 */
  readonly defects: readonly ExpectedDefect[];
};

function isPositiveInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 1;
}

function parseDefect(value: unknown, where: string): ExpectedDefect {
  if (!isRecord(value)) throw new Error(`${where} is not an object`);
  const { id, path, start_line, end_line, kinds } = value;
  if (!isString(id) || id === "") throw new Error(`${where}.id is invalid`);
  if (!isString(path) || path === "") {
    throw new Error(`${where}.path is invalid`);
  }
  if (!isPositiveInteger(start_line) || !isPositiveInteger(end_line)) {
    throw new Error(
      `${where}.start_line and end_line must be positive integers`,
    );
  }
  if (start_line > end_line) {
    throw new Error(`${where}.start_line must not be after end_line`);
  }
  if (
    !Array.isArray(kinds) ||
    kinds.length === 0 ||
    !kinds.every((kind) => isOneOf(kind, FINDING_KINDS))
  ) {
    throw new Error(`${where}.kinds must be a non-empty list of finding kinds`);
  }
  const parsedKinds = FINDING_KINDS.filter((kind) => kinds.includes(kind));
  return { id, path, start_line, end_line, kinds: parsedKinds };
}

function parseCase(value: unknown, index: number): EvalCase {
  const where = `cases[${String(index)}]`;
  if (!isRecord(value)) throw new Error(`${where} is not an object`);
  const { id, title, diff, defects } = value;
  if (!isString(id) || id === "") throw new Error(`${where}.id is invalid`);
  if (!isString(title)) throw new Error(`${where}.title is invalid`);
  if (!isString(diff) || diff === "") {
    throw new Error(`${where}.diff is invalid`);
  }
  if (!Array.isArray(defects)) {
    throw new Error(`${where}.defects is not an array`);
  }
  return {
    id,
    title,
    diff,
    defects: defects.map((defect, i) =>
      parseDefect(defect, `${where}.defects[${String(i)}]`),
    ),
  };
}

/** `expected.json`の中身を読む。形が違えば、場所を示した例外を投げる。 */
export function parseEvalCases(value: unknown): EvalCase[] {
  if (!isRecord(value) || !Array.isArray(value.cases)) {
    throw new Error("expected.json must be an object with a cases array");
  }
  const cases = value.cases.map(parseCase);
  const seen = new Set<string>();
  for (const evalCase of cases) {
    if (seen.has(evalCase.id)) {
      throw new Error(`duplicate case id: ${evalCase.id}`);
    }
    seen.add(evalCase.id);
  }
  return cases;
}

/** unified diffが変更するファイルの、新しい側のパス。削除されたファイルは古い側のパスを返す。 */
export function changedFilesOfDiff(diff: string): string[] {
  const files: string[] = [];
  let oldPath: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
    } else if (line.startsWith("--- ")) {
      oldPath = line.startsWith("--- a/") ? line.slice("--- a/".length) : null;
    } else if (line.startsWith("+++ ")) {
      if (line.startsWith("+++ b/")) {
        files.push(line.slice("+++ b/".length));
      } else if (oldPath !== null) {
        files.push(oldPath);
      }
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// レビューの出力の読み取り
// ---------------------------------------------------------------------------

/** 評価が出力から読む、指摘1件の項目。出力の形の読みは`readReviewOutput`だけが行う。 */
export type EvalFinding = {
  readonly path: string;
  readonly line: number | null;
  readonly end_line: number | null;
  readonly kind: ReviewFindingKind;
  /** 出力に項目が無い、または値が想定外のときは`null`。 */
  readonly confidence: EvalConfidence | null;
};

export type ReadOutputResult =
  | { readonly ok: true; readonly findings: EvalFinding[] }
  | { readonly ok: false; readonly reason: string };

function lineOrNull(value: unknown): number | null | undefined {
  if (value === null || value === undefined) return null;
  return isNumber(value) && Number.isInteger(value) ? value : undefined;
}

/**
 * `claude -p`の構造化出力から、評価に使う項目を読む。
 * 評価が出力の形に依存する場所は、ここだけにする。
 * `confidence`は、出力にあれば読み、無くても動く。
 * 指摘の項目が壊れているときは、その出力全体を評価の対象外(invalid)にする。
 */
export function readReviewOutput(output: unknown): ReadOutputResult {
  if (!isRecord(output)) {
    return { ok: false, reason: "output is not an object" };
  }
  const { findings } = output;
  if (!Array.isArray(findings)) {
    return { ok: false, reason: "findings is not an array" };
  }
  const read: EvalFinding[] = [];
  for (const [index, item] of findings.entries()) {
    const where = `findings[${String(index)}]`;
    if (!isRecord(item)) {
      return { ok: false, reason: `${where} is not an object` };
    }
    if (!isString(item.path)) {
      return { ok: false, reason: `${where} has an invalid path` };
    }
    const line = lineOrNull(item.line);
    if (line === undefined) {
      return { ok: false, reason: `${where} has an invalid line` };
    }
    const endLine = lineOrNull(item.end_line);
    if (endLine === undefined) {
      return { ok: false, reason: `${where} has an invalid end_line` };
    }
    if (!isOneOf(item.kind, FINDING_KINDS)) {
      return { ok: false, reason: `${where} has an invalid kind` };
    }
    read.push({
      path: item.path,
      line,
      end_line: endLine,
      kind: item.kind,
      confidence: isOneOf(item.confidence, CONFIDENCES)
        ? item.confidence
        : null,
    });
  }
  return { ok: true, findings: read };
}

// ---------------------------------------------------------------------------
// 照合
// ---------------------------------------------------------------------------

export type RunScore = {
  /** 検出した欠陥のid。 */
  readonly detected: readonly string[];
  /** `confidence`が`low`の指摘だけで検出した欠陥を除いたid。 */
  readonly detected_excluding_low: readonly string[];
  readonly false_positives: number;
  readonly false_positives_excluding_low: number;
  /** 誤検知にした指摘の位置(`path:line kind`)。ケースの正解が妥当かを見直す手がかりにする。 */
  readonly false_positive_locations: readonly string[];
  readonly finding_count: number;
};

function pointsAt(finding: EvalFinding, defect: ExpectedDefect): boolean {
  if (finding.path !== defect.path || finding.line === null) return false;
  const first = finding.line;
  const last = Math.max(finding.end_line ?? first, first);
  return (
    first <= defect.end_line + LINE_TOLERANCE &&
    last >= defect.start_line - LINE_TOLERANCE
  );
}

/**
 * 1回の出力を、ケースの正解と照合する。
 * - 検出: 欠陥の行(前後に`LINE_TOLERANCE`行)に重なり、欠陥の`kinds`に含まれる種類の指摘がある。
 * - 誤検知: どの欠陥の位置も指さない、種類が`must`か`imo`の指摘。無欠陥のケースでは、そのような指摘すべて。
 */
export function scoreRun(
  evalCase: EvalCase,
  findings: readonly EvalFinding[],
): RunScore {
  const notLow = findings.filter((f) => f.confidence !== "low");
  const detects = (pool: readonly EvalFinding[], defect: ExpectedDefect) =>
    pool.some((f) => pointsAt(f, defect) && defect.kinds.includes(f.kind));
  const isFalsePositive = (f: EvalFinding) =>
    CLAIMING_KINDS.includes(f.kind) &&
    !evalCase.defects.some((defect) => pointsAt(f, defect));
  const falsePositives = findings.filter(isFalsePositive);
  return {
    detected: evalCase.defects
      .filter((d) => detects(findings, d))
      .map((d) => d.id),
    detected_excluding_low: evalCase.defects
      .filter((d) => detects(notLow, d))
      .map((d) => d.id),
    false_positives: falsePositives.length,
    false_positives_excluding_low: notLow.filter(isFalsePositive).length,
    false_positive_locations: falsePositives.map(
      (f) => `${f.path}:${f.line === null ? "-" : String(f.line)} ${f.kind}`,
    ),
    finding_count: findings.length,
  };
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

/**
 * 1回の実行の結果。
 * - scored: 出力を読めて照合した。母数に入る。
 * - invalid: 失敗したか、出力の形が壊れていた。母数に入れず、件数だけを残す。
 * - skipped: 費用の上限で、起動しなかった。母数に入れない。
 */
export type RunOutcome =
  | {
      readonly status: "scored";
      readonly score: RunScore;
      readonly cost_usd: number | null;
    }
  | {
      readonly status: "invalid";
      readonly reason: string;
      readonly cost_usd: number | null;
    }
  | { readonly status: "skipped" };

export type EvalCounts = {
  readonly runs_scored: number;
  readonly runs_invalid: number;
  readonly runs_skipped: number;
  /** 照合した実行ごとの、ケースの欠陥数の和。検出率の分母。 */
  readonly defects_expected: number;
  readonly defects_detected: number;
  readonly defects_detected_excluding_low: number;
  readonly false_positives: number;
  readonly false_positives_excluding_low: number;
  /** 無欠陥のケースで照合した実行の数。 */
  readonly clean_runs: number;
  /** そのうち、誤検知が1件以上あった実行の数。 */
  readonly clean_runs_flagged: number;
  readonly clean_runs_flagged_excluding_low: number;
  readonly cost_usd: number;
};

const ZERO_COUNTS: EvalCounts = {
  runs_scored: 0,
  runs_invalid: 0,
  runs_skipped: 0,
  defects_expected: 0,
  defects_detected: 0,
  defects_detected_excluding_low: 0,
  false_positives: 0,
  false_positives_excluding_low: 0,
  clean_runs: 0,
  clean_runs_flagged: 0,
  clean_runs_flagged_excluding_low: 0,
  cost_usd: 0,
};

export function addCounts(a: EvalCounts, b: EvalCounts): EvalCounts {
  return {
    runs_scored: a.runs_scored + b.runs_scored,
    runs_invalid: a.runs_invalid + b.runs_invalid,
    runs_skipped: a.runs_skipped + b.runs_skipped,
    defects_expected: a.defects_expected + b.defects_expected,
    defects_detected: a.defects_detected + b.defects_detected,
    defects_detected_excluding_low:
      a.defects_detected_excluding_low + b.defects_detected_excluding_low,
    false_positives: a.false_positives + b.false_positives,
    false_positives_excluding_low:
      a.false_positives_excluding_low + b.false_positives_excluding_low,
    clean_runs: a.clean_runs + b.clean_runs,
    clean_runs_flagged: a.clean_runs_flagged + b.clean_runs_flagged,
    clean_runs_flagged_excluding_low:
      a.clean_runs_flagged_excluding_low + b.clean_runs_flagged_excluding_low,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

/** 1つのケースの実行の結果を、母数つきの件数にまとめる。 */
export function countRuns(
  evalCase: EvalCase,
  outcomes: readonly RunOutcome[],
): EvalCounts {
  const isClean = evalCase.defects.length === 0;
  let counts = ZERO_COUNTS;
  for (const outcome of outcomes) {
    const cost = outcome.status === "skipped" ? 0 : (outcome.cost_usd ?? 0);
    if (outcome.status === "skipped") {
      counts = { ...counts, runs_skipped: counts.runs_skipped + 1 };
    } else if (outcome.status === "invalid") {
      counts = {
        ...counts,
        runs_invalid: counts.runs_invalid + 1,
        cost_usd: counts.cost_usd + cost,
      };
    } else {
      const { score } = outcome;
      counts = addCounts(counts, {
        ...ZERO_COUNTS,
        runs_scored: 1,
        defects_expected: evalCase.defects.length,
        defects_detected: score.detected.length,
        defects_detected_excluding_low: score.detected_excluding_low.length,
        false_positives: score.false_positives,
        false_positives_excluding_low: score.false_positives_excluding_low,
        clean_runs: isClean ? 1 : 0,
        clean_runs_flagged: isClean && score.false_positives > 0 ? 1 : 0,
        clean_runs_flagged_excluding_low:
          isClean && score.false_positives_excluding_low > 0 ? 1 : 0,
        cost_usd: cost,
      });
    }
  }
  return counts;
}

export type EvalRates = {
  readonly detection_rate: number | null;
  readonly detection_rate_excluding_low: number | null;
  readonly false_positives_per_run: number | null;
  readonly false_positives_per_run_excluding_low: number | null;
  readonly clean_flag_rate: number | null;
  readonly clean_flag_rate_excluding_low: number | null;
};

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/** 件数から率を求める。分母が0の率は`null`にする。 */
export function ratesOf(counts: EvalCounts): EvalRates {
  return {
    detection_rate: ratio(counts.defects_detected, counts.defects_expected),
    detection_rate_excluding_low: ratio(
      counts.defects_detected_excluding_low,
      counts.defects_expected,
    ),
    false_positives_per_run: ratio(counts.false_positives, counts.runs_scored),
    false_positives_per_run_excluding_low: ratio(
      counts.false_positives_excluding_low,
      counts.runs_scored,
    ),
    clean_flag_rate: ratio(counts.clean_runs_flagged, counts.clean_runs),
    clean_flag_rate_excluding_low: ratio(
      counts.clean_runs_flagged_excluding_low,
      counts.clean_runs,
    ),
  };
}

// ---------------------------------------------------------------------------
// 報告
// ---------------------------------------------------------------------------

export type RefResult = {
  readonly ref: string;
  /** その参照のスキルを連結したシステムプロンプトのsha256。参照ごとに内容が違うことの証拠にする。 */
  readonly system_prompt_sha256: string;
  readonly cases: readonly {
    readonly eval_case: EvalCase;
    readonly outcomes: readonly RunOutcome[];
  }[];
};

export type CaseReport = {
  readonly id: string;
  readonly title: string;
  readonly defect_count: number;
  readonly counts: EvalCounts;
  readonly rates: EvalRates;
  /** 実行ごとの結果の要約。照合に失敗した理由もここに残す。 */
  readonly runs: readonly {
    readonly status: RunOutcome["status"];
    readonly detected?: readonly string[];
    readonly false_positives?: number;
    readonly false_positive_locations?: readonly string[];
    readonly reason?: string;
  }[];
};

export type RefReport = {
  readonly ref: string;
  readonly system_prompt_sha256: string;
  readonly counts: EvalCounts;
  readonly rates: EvalRates;
  readonly cases: readonly CaseReport[];
};

export type EvalReport = {
  readonly case_count: number;
  readonly defect_case_count: number;
  readonly clean_case_count: number;
  readonly runs_per_case: number;
  /** 各指標の式。同じ入力で再実行したとき、母数と式が同じであることを確かめる拠り所にする。 */
  readonly formulas: Readonly<Record<keyof EvalRates, string>>;
  readonly refs: readonly RefReport[];
};

export const EVAL_FORMULAS: Readonly<Record<keyof EvalRates, string>> = {
  detection_rate:
    "defects detected / defects expected, summed over the scored runs",
  detection_rate_excluding_low:
    "the same, not counting a defect that only low-confidence findings detected",
  false_positives_per_run:
    "must or imo findings that point at no defect / scored runs",
  false_positives_per_run_excluding_low:
    "the same, not counting low-confidence findings",
  clean_flag_rate:
    "scored runs of defect-free cases with a false positive / scored runs of defect-free cases",
  clean_flag_rate_excluding_low:
    "the same, not counting low-confidence findings",
};

function runSummary(outcome: RunOutcome): CaseReport["runs"][number] {
  if (outcome.status === "scored") {
    return {
      status: "scored",
      detected: outcome.score.detected,
      false_positives: outcome.score.false_positives,
      false_positive_locations: outcome.score.false_positive_locations,
    };
  }
  if (outcome.status === "invalid") {
    return { status: "invalid", reason: outcome.reason };
  }
  return { status: "skipped" };
}

/** 参照ごとの結果から報告を作る。ケースの並びは、最初の参照のものにそろえる。 */
export function buildEvalReport(
  refResults: readonly RefResult[],
  runsPerCase: number,
): EvalReport {
  const first = refResults[0]?.cases ?? [];
  const defectCases = first.filter((c) => c.eval_case.defects.length > 0);
  return {
    case_count: first.length,
    defect_case_count: defectCases.length,
    clean_case_count: first.length - defectCases.length,
    runs_per_case: runsPerCase,
    formulas: EVAL_FORMULAS,
    refs: refResults.map((refResult) => {
      const cases = refResult.cases.map(({ eval_case, outcomes }) => {
        const counts = countRuns(eval_case, outcomes);
        return {
          id: eval_case.id,
          title: eval_case.title,
          defect_count: eval_case.defects.length,
          counts,
          rates: ratesOf(counts),
          runs: outcomes.map(runSummary),
        };
      });
      const counts = cases.reduce(
        (sum, c) => addCounts(sum, c.counts),
        ZERO_COUNTS,
      );
      return {
        ref: refResult.ref,
        system_prompt_sha256: refResult.system_prompt_sha256,
        counts,
        rates: ratesOf(counts),
        cases,
      };
    }),
  };
}

function percent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function withRate(
  numerator: number,
  denominator: number,
  rate: number | null,
): string {
  return rate === null
    ? "n/a"
    : `${String(numerator)}/${String(denominator)} (${percent(rate)})`;
}

function escapeCell(text: string): string {
  return text.replaceAll("|", "\\|");
}

function row(cells: readonly string[]): string {
  return `| ${cells.map(escapeCell).join(" | ")} |`;
}

/** 参照を横に並べたMarkdownにする。指標は式と母数を添えて出す。 */
export function formatEvalMarkdown(report: EvalReport): string {
  const refs = report.refs;
  const lines: string[] = [
    "# Review evaluation",
    "",
    `- Cases: ${String(report.case_count)} (${String(report.defect_case_count)} with defects, ${String(report.clean_case_count)} defect-free)`,
    `- Runs per case: ${String(report.runs_per_case)}`,
    ...refs.map(
      (r) =>
        `- System prompt of ${r.ref}: sha256 ${r.system_prompt_sha256.slice(0, 12)}`,
    ),
    "",
    "## Summary",
    "",
    row(["metric", ...refs.map((r) => r.ref)]),
    row(["---", ...refs.map(() => "---")]),
    row([
      "detection rate",
      ...refs.map((r) =>
        withRate(
          r.counts.defects_detected,
          r.counts.defects_expected,
          r.rates.detection_rate,
        ),
      ),
    ]),
    row([
      "detection rate excluding low confidence",
      ...refs.map((r) =>
        withRate(
          r.counts.defects_detected_excluding_low,
          r.counts.defects_expected,
          r.rates.detection_rate_excluding_low,
        ),
      ),
    ]),
    row([
      "false positives per run",
      ...refs.map((r) =>
        r.rates.false_positives_per_run === null
          ? "n/a"
          : `${String(r.counts.false_positives)}/${String(r.counts.runs_scored)} (${r.rates.false_positives_per_run.toFixed(2)})`,
      ),
    ]),
    row([
      "false positives per run excluding low confidence",
      ...refs.map((r) =>
        r.rates.false_positives_per_run_excluding_low === null
          ? "n/a"
          : `${String(r.counts.false_positives_excluding_low)}/${String(r.counts.runs_scored)} (${r.rates.false_positives_per_run_excluding_low.toFixed(2)})`,
      ),
    ]),
    row([
      "defect-free runs with a false positive",
      ...refs.map((r) =>
        withRate(
          r.counts.clean_runs_flagged,
          r.counts.clean_runs,
          r.rates.clean_flag_rate,
        ),
      ),
    ]),
    row([
      "defect-free runs with a false positive excluding low confidence",
      ...refs.map((r) =>
        withRate(
          r.counts.clean_runs_flagged_excluding_low,
          r.counts.clean_runs,
          r.rates.clean_flag_rate_excluding_low,
        ),
      ),
    ]),
    row(["scored runs", ...refs.map((r) => String(r.counts.runs_scored))]),
    row(["invalid runs", ...refs.map((r) => String(r.counts.runs_invalid))]),
    row(["skipped runs", ...refs.map((r) => String(r.counts.runs_skipped))]),
    row(["cost (USD)", ...refs.map((r) => r.counts.cost_usd.toFixed(2))]),
    "",
    "## Cases",
    "",
    row([
      "case",
      "defects",
      ...refs.flatMap((r) => [`${r.ref} detected`, `${r.ref} false positives`]),
    ]),
    row(["---", "---", ...refs.flatMap(() => ["---", "---"])]),
  ];
  const caseIds = refs[0]?.cases.map((c) => c.id) ?? [];
  for (const [index, id] of caseIds.entries()) {
    const defectCount = refs[0]?.cases[index]?.defect_count ?? 0;
    lines.push(
      row([
        id,
        String(defectCount),
        ...refs.flatMap((r) => {
          const counts = r.cases[index]?.counts;
          if (counts === undefined) return ["-", "-"];
          return [
            counts.defects_expected === 0
              ? "-"
              : `${String(counts.defects_detected)}/${String(counts.defects_expected)}`,
            String(counts.false_positives),
          ];
        }),
      ]),
    );
  }
  lines.push("", "## Definitions", "");
  for (const [name, formula] of Object.entries(report.formulas)) {
    lines.push(`- ${name}: ${formula}`);
  }
  lines.push(
    "- Invalid and skipped runs are left out of every denominator and counted above.",
    "- A rate with a zero denominator is shown as n/a.",
  );
  return lines.join("\n");
}
