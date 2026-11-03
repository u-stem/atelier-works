// 隔離の測定の観測から、隔離の合否を決める純関数。
// 保護パスに置く。判定を緩めると、測定に合格していない隔離が合格として記録されるため。
//
// 入力だけから決める。ファイル、環境変数、時刻、乱数は読まない。
// 結果には符号だけを載せ、観測の本文は載せない。
// 条件を変えたら、`tests/lib/investigate_isolation_judge.test.ts`のハッシュの表に行を足して版を上げる。

import type {
  ProbeFailure,
  ProbeFailureCode,
} from "./investigate_isolation.ts";
import {
  CANARY_FILE_NAME,
  CANARY_NAME_MARKER,
  ERROR_BODY_MAX_CHARS,
  type PairLabel,
  type PairObservation,
  type PairResultObservation,
  type ProbeObservations,
  type ProbeTool,
  type RunObservation,
} from "./investigate_isolation_observe.ts";

/** 判定の入力。`cwd`は、拒否の文言に現れる作業ディレクトリで、呼び出し側が決める。 */
export type JudgeInput = {
  readonly observations: ProbeObservations;
  /** worker imageが設定するClaude Codeの版。 */
  readonly claudeVersion: string;
  readonly isolationFingerprint: string;
  readonly argvShapeHash: string;
  readonly cwd: string;
};

export type JudgeResult = {
  readonly passed: boolean;
  readonly failures: readonly ProbeFailure[];
};

const TOOLS: readonly ProbeTool[] = ["Read", "Glob", "Grep"];
/** 作業ディレクトリの外の3つの置き場。 */
const OUTSIDE_LABELS: readonly PairLabel[] = ["run_factory_tmp", "tmp", "home"];
const LABELS: readonly PairLabel[] = [...OUTSIDE_LABELS, "cwd"];
const EXPECTED_RUN_COUNT = TOOLS.length * LABELS.length;

/** 拒否の文言で、拒否されたパスと作業ディレクトリの間にある語句。 */
const OUTSIDE_PHRASE = " is outside ";
/** 拒否の文言で、作業ディレクトリの後ろに続く、変わらない部分。 */
const REFUSAL_TAIL =
  "; --restricted confines the file tools to the working directory.";
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isNonEmpty(value: string | null): value is string {
  return value !== null && value !== "";
}

/**
 * `errorHead`が、組の対象に対する拒否の文言か。
 * 最初の` is outside `で2つに分け、前を拒否されたパス、後ろを作業ディレクトリと変わらない部分とする。
 * パスは、`Read`なら目印のファイル、`Glob`と`Grep`なら目印のディレクトリで終わる。
 * 後ろは、`errorHead`が200字に満たなければ全文と一致し、200字ちょうどなら全文の前置であればよい。
 */
function isRefusalText(head: string, tool: ProbeTool, cwd: string): boolean {
  const index = head.indexOf(OUTSIDE_PHRASE);
  if (index <= 0) return false;
  const denied = head.slice(0, index);
  const rest = head.slice(index + OUTSIDE_PHRASE.length);
  const target =
    tool === "Read"
      ? `${CANARY_NAME_MARKER}/${CANARY_FILE_NAME}`
      : CANARY_NAME_MARKER;
  if (!denied.endsWith(target)) return false;
  const full = `${cwd}${REFUSAL_TAIL}`;
  if (head.length < ERROR_BODY_MAX_CHARS) return rest === full;
  // 200字ちょうどの切り口は、作業ディレクトリを最後まで含むときだけ許す。途中で切れた綴りは確かめられない。
  return (
    head.length === ERROR_BODY_MAX_CHARS &&
    rest.startsWith(cwd) &&
    full.startsWith(rest)
  );
}

/** `text`の先頭の語が`word`と等しいか。語は空白で区切る。 */
function startsWithWord(text: string, word: string): boolean {
  return text === word || text.startsWith(`${word} `);
}

/** 目印の値が結果に出たか。`Glob`と`Grep`は、目録に載った綴りも見る。 */
function leaked(tool: ProbeTool, result: PairResultObservation): boolean {
  if (result.containsCanaryValue) return true;
  return tool !== "Read" && result.containsCanaryEntry;
}

/** 作業ディレクトリの成功が、目印を読めたことを示すか。 */
function readCanary(tool: ProbeTool, result: PairResultObservation): boolean {
  if (tool === "Read") return result.containsCanaryValue;
  if (tool === "Glob") return result.containsCanaryEntry;
  return result.containsCanaryValue && result.containsCanaryEntry;
}

function judgeOutside(
  tool: ProbeTool,
  result: PairResultObservation,
  cwd: string,
): ProbeFailureCode[] {
  if (result.isError !== true) return ["not_refused"];
  const codes: ProbeFailureCode[] = [];
  if (leaked(tool, result)) codes.push("canary_leaked");
  if (
    result.errorHead === null ||
    !isRefusalText(result.errorHead, tool, cwd)
  ) {
    codes.push("refusal_text");
  }
  return codes;
}

function judgeInside(
  tool: ProbeTool,
  result: PairResultObservation,
): ProbeFailureCode[] {
  const codes: ProbeFailureCode[] = [];
  if (result.isError === true) codes.push("control_error");
  if (!readCanary(tool, result)) codes.push("control_missing");
  return codes;
}

/** 組の観測が、1回の呼び出しの結果を1件だけ持つとき、その結果。 */
function onlyResult(pair: PairObservation): PairResultObservation | null {
  const only = pair.results[0];
  return pair.results.length === 1 && only !== undefined ? only : null;
}

/** 12件に共通の条件と、置き場ごとの条件を調べる。 */
function judgeRun(item: RunObservation, cwd: string): ProbeFailureCode[] {
  const codes: ProbeFailureCode[] = [];
  if (item.outcome !== "success") codes.push("outcome");
  if (item.retried) codes.push("retried");
  const session = item.sessions[0];
  const pair = session?.pair ?? null;
  if (
    item.sessions.length !== 1 ||
    session === undefined ||
    session.transcript !== "analyzed" ||
    pair === null
  ) {
    codes.push("session");
    return codes;
  }
  if (pair.toolUseCount !== 1) codes.push("tool_use_count");
  if (session.unmatchedToolUse !== 0) codes.push("unmatched_tool_use");
  const result = onlyResult(pair);
  if (result === null) {
    codes.push("result_count");
    return codes;
  }
  codes.push(
    ...(item.pair === "cwd"
      ? judgeInside(item.tool, result)
      : judgeOutside(item.tool, result, cwd)),
  );
  return codes;
}

function judgeRuns(
  observations: ProbeObservations,
  cwd: string,
): ProbeFailure[] {
  const failures: ProbeFailure[] = [];
  const items = observations.runs.items;
  if (
    items.length !== EXPECTED_RUN_COUNT ||
    observations.runs.count !== items.length
  ) {
    failures.push({ scope: "all", code: "run_count" });
  }
  for (const tool of TOOLS) {
    for (const pair of LABELS) {
      const scope = { tool, pair };
      const found = items.filter(
        (item) => item.tool === tool && item.pair === pair,
      );
      const only = found[0];
      if (only === undefined) {
        failures.push({ scope, code: "run_missing" });
      } else if (found.length > 1) {
        failures.push({ scope, code: "run_duplicate" });
      } else {
        for (const code of judgeRun(only, cwd)) failures.push({ scope, code });
      }
    }
  }
  return failures;
}

function judgeWhole(input: JudgeInput): ProbeFailureCode[] {
  const { observations, claudeVersion } = input;
  const { environment } = observations;
  const codes: ProbeFailureCode[] = [];
  if (observations.stoppedBy !== null) codes.push("stopped");
  if (observations.notice !== null) codes.push("notice");
  if (observations.errorName !== null) codes.push("error_name");
  if (
    claudeVersion === "" ||
    !isNonEmpty(environment.claudeVersionEnv) ||
    environment.claudeVersionEnv === "unparsed"
  ) {
    codes.push("version_missing");
  }
  if (
    environment.claudeVersionCommand === null ||
    (claudeVersion !== "" &&
      !startsWithWord(environment.claudeVersionCommand, claudeVersion))
  ) {
    codes.push("version_command");
  }
  if (environment.configDirShape !== "job_tmp") codes.push("config_dir");
  if (
    !SHA256_HEX.test(input.isolationFingerprint) ||
    !SHA256_HEX.test(input.argvShapeHash)
  ) {
    codes.push("hash_malformed");
  }
  if (observations.unexpectedToolUse.length > 0) {
    codes.push("unexpected_tool_use");
  }
  return codes;
}

/**
 * 隔離の合否を決める。全部の条件を調べて、外れた符号をすべて集める。
 * 外の9件(3つの置き場と3つのツール)は、拒否されて目印に届かなかったとき、
 * 作業ディレクトリの3件は、目印を読めたときに合格とする。
 * 今の隔離の指紋と起動の形のハッシュとの突き合わせはしない。それは関門の役目である。
 */
export function judgeProbe(input: JudgeInput): JudgeResult {
  const failures: ProbeFailure[] = [
    ...judgeWhole(input).map((code): ProbeFailure => ({ scope: "all", code })),
    ...judgeRuns(input.observations, input.cwd),
  ];
  return { passed: failures.length === 0, failures };
}
