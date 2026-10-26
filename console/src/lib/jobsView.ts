// ジョブの画面が使う純関数。状態の表示、所要時間、履歴の絞り込み、詳細の整形、
// scheduleと凍結の突き合わせ、設定の表示を決める。

import type { HoldsSnapshot } from "../api/guards/holds.ts";
import type {
  ArgViewData,
  ConfigItemView,
  JobListView,
  OutputViewData,
  ScheduleViewData,
} from "../api/jobsQueries.ts";
import { displayableIssueText } from "./intakeText.ts";
import { parseIdParam } from "./routeParams.ts";

/** ジョブの画面の入口のパス。ルーターの基準(`/console`)からの絶対パスで書く。 */
export const JOBS_PATH = "/jobs";
/** 一覧が返すジョブのscriptの共通のフォルダ。表示では省く。 */
export const JOB_SCRIPT_PREFIX = "f/factory/";

export type JobStateKind =
  | "success"
  | "failure"
  | "running"
  | "queued"
  | "scheduled"
  | "canceled"
  | "skipped"
  | "unknown";

export type JobStateInfo = {
  readonly kind: JobStateKind;
  readonly label: string;
};

/**
 * ジョブとステップの状態の語。画面は、記号と語を並べて示し、色だけに頼らない。
 * 表に無い値は、生の値を添えて「不明」にする。backendが先に新しい値を返しても、一覧の全体が消えないためである。
 * 表は`Map`で引く。`constructor`のような名前を、継承したプロパティとして拾わないためである。
 */
const STATES: ReadonlyMap<string, JobStateInfo> = new Map([
  ["success", { kind: "success", label: "成功" }],
  ["failure", { kind: "failure", label: "失敗" }],
  ["running", { kind: "running", label: "実行中" }],
  ["queued", { kind: "queued", label: "待ち" }],
  ["scheduled", { kind: "scheduled", label: "予定" }],
  ["canceled", { kind: "canceled", label: "取消" }],
  ["skipped", { kind: "skipped", label: "スキップ" }],
  ["waiting", { kind: "queued", label: "待機中" }],
]);

export function jobStateInfo(state: string): JobStateInfo {
  return STATES.get(state) ?? { kind: "unknown", label: `不明(${state})` };
}

/** 所要時間。1秒未満は「1秒未満」にし、分と時間は大きい単位から出す。値が無ければ「—」。 */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return "1秒未満";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}時間` : `${hours}時間${restMinutes}分`;
}

/** scriptのパスから、共通のフォルダを省いた名前。 */
export function jobScriptName(path: string): string {
  return path.startsWith(JOB_SCRIPT_PREFIX)
    ? path.slice(JOB_SCRIPT_PREFIX.length)
    : path;
}

export type HistoryStatus = "success" | "failure";

/** URLの`?status=`から絞り込みを決める。無い値と知らない値は「すべて」(`undefined`)にする。 */
export function parseHistoryStatus(
  value: string | null,
): HistoryStatus | undefined {
  return value === "success" || value === "failure" ? value : undefined;
}

/**
 * URLの`?script=`から絞り込みを決める。既知のscriptのパスだけを受け入れ、それ以外は無視する。
 * 画面が組み立てる値でなく、URLから来る値なので、サーバーに渡す前に既知の集合で照合する。
 */
export function parseHistoryScript(
  value: string | null,
  known: readonly string[],
): string | undefined {
  return value !== null && known.includes(value) ? value : undefined;
}

function withParam(
  current: URLSearchParams,
  name: string,
  value: string | undefined,
): URLSearchParams {
  const next = new URLSearchParams(current);
  if (value === undefined) {
    next.delete(name);
  } else {
    next.set(name, value);
  }
  return next;
}

/** 状態の絞り込みを替えた後のクエリ。他のクエリは残す。 */
export function withHistoryStatus(
  current: URLSearchParams,
  status: HistoryStatus | undefined,
): URLSearchParams {
  return withParam(current, "status", status);
}

/** scriptの絞り込みを替えた後のクエリ。他のクエリは残す。 */
export function withHistoryScript(
  current: URLSearchParams,
  script: string | undefined,
): URLSearchParams {
  return withParam(current, "script", script);
}

/**
 * 一覧の行から詳細を開くときに、リンクの`state`へ渡す戻り先。
 * 一覧のタブと絞り込み(`location.search`)を持つ。詳細のパンくずの「ジョブ」が、この戻り先を使う。
 */
export function jobsBackState(search: string): { jobsBack: string } {
  return { jobsBack: `${JOBS_PATH}${search}` };
}

/** 戻り先に受け入れる形。`/jobs`だけか、`/jobs?`の後に安全な文字だけが続くもの。 */
const JOBS_BACK_PATTERN = /^\/jobs(\?[A-Za-z0-9_=&%.-]*)?$/;

/**
 * 履歴の`state`から戻り先を取り出す。
 * `state`は履歴に残る外からの値なので、`/jobs`で始まる内部のパスだけを受け入れ、それ以外は`null`にする。
 * `null`のときは、既定の`/jobs`を使う。
 */
export function parseJobsBack(state: unknown): string | null {
  if (typeof state !== "object" || state === null || !("jobsBack" in state)) {
    return null;
  }
  const back = state.jobsBack;
  return typeof back === "string" && JOBS_BACK_PATTERN.test(back) ? back : null;
}

/**
 * 引数から、関連する作業項目のidを取る。正の整数のときだけ返す。
 * リンクは、この整数から組み立てる。引数の文字列をそのままパスに入れない。
 */
export function relatedWorkItemId(args: readonly ArgViewData[]): number | null {
  const arg = args.find((candidate) => candidate.key === "work_item_id");
  const value = arg?.value;
  return typeof value === "number" || typeof value === "string"
    ? parseIdParam(String(value))
    : null;
}

export type ArgText = {
  readonly key: string;
  readonly type: string;
  /** 値を出さない引数は`null`。キーと型だけを出す。 */
  readonly value: string | null;
};

export function describeArg(arg: ArgViewData): ArgText {
  return {
    key: arg.key,
    type: arg.type,
    value: arg.value === undefined ? null : String(arg.value),
  };
}

export const REDACTION_LIMIT_NOTE = "伏せ字処理済み。完全ではありません。";

/** ログと結果に添える注記。限界は常に添え、伏せた、切った、JSONでない行がある、は該当するときだけ添える。 */
export function outputNotes(
  kind: "log" | "result",
  output: OutputViewData & { readonly nonJsonLines?: number },
): string[] {
  const notes = [REDACTION_LIMIT_NOTE];
  if (output.masked) notes.push("伏せた箇所があります。");
  if (output.truncated) {
    notes.push(
      kind === "log"
        ? "長いため、末尾だけを表示しています。"
        : "長いため、先頭だけを表示しています。",
    );
  }
  const lines = output.nonJsonLines ?? 0;
  if (lines > 0) {
    notes.push(
      `JSONでない行が${lines}行あります。この行には、文字列の規則だけで伏せ字をかけています。`,
    );
  }
  return notes;
}

/** ループのステップの繰り返しの回数。ループでなければ`null`。 */
export function stepIterationsLabel(iterations: number | null): string | null {
  return iterations === null ? null : `${iterations}回繰り返し`;
}

/** 履歴を読み進める累積の上限。サーバーの上限と同じ値である。 */
export const HISTORY_TOTAL_MAX = 200;

export function historyTotal(pages: readonly JobListView[]): number {
  return pages.reduce((total, page) => total + page.jobs.length, 0);
}

/** 履歴が累積の上限で止まったときの注記。履歴が自然に終わったときは`null`。 */
export function historyEndNote(pages: readonly JobListView[]): string | null {
  const last = pages.at(-1);
  if (
    last === undefined ||
    last.next_before !== null ||
    historyTotal(pages) < HISTORY_TOTAL_MAX
  ) {
    return null;
  }
  return `${HISTORY_TOTAL_MAX}件まで読み込みました。これより古いジョブは、絞り込みを変えて探してください。`;
}

export const ACTIVE_TRUNCATED_NOTE =
  "キューの1ページ(100件)に達したため、全件を読めていません。実行中と待ちのジョブが、ここに出ていない場合があります。";

export const SCHEDULES_TRUNCATED_NOTE =
  "ページの上限に達したため、全件を読めていません。ここに出ていないscheduleがある場合があります。";

/**
 * 有効な凍結の対象のscheduleのパス。期限を過ぎた行は何も止めないので数えない。
 * 凍結を読めなかったとき、まだ取得していないときは`null`にする。凍結が無いと言い切らないためである。
 */
export function frozenScheduleTargets(
  holds: HoldsSnapshot | undefined,
  nowMs: number,
): ReadonlySet<string> | null {
  if (holds === undefined || !holds.freezes.ok) return null;
  return new Set(
    holds.freezes.schedule
      .filter((row) => Date.parse(row.expires_at) > nowMs)
      .map((row) => row.target),
  );
}

export type ScheduleRow = {
  readonly path: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly enabledLabel: string;
  /** 凍結が有効か。凍結を読めなかったときは偽にする。読めなかったことは画面が別に伝える。 */
  readonly frozen: boolean;
  /** 定義と違う項目の、日本語の名前。 */
  readonly differences: readonly string[];
  /** 定義との関係の注記。一致するときは`null`。 */
  readonly definitionNote: string | null;
  readonly nextRunAt: string | null;
  readonly lastRun: {
    readonly jobId: string;
    readonly success: boolean;
    readonly label: string;
    readonly durationLabel: string;
  } | null;
  readonly error: string | null;
};

const DIFFERENCE_LABELS: ReadonlyMap<string, string> = new Map([
  ["script_path", "実行先"],
  ["is_flow", "scriptかflowか"],
  ["schedule", "cron"],
  ["timezone", "タイムゾーン"],
  ["enabled", "有効/無効"],
]);

function definitionNoteOf(
  definition: string,
  differences: readonly string[],
): string | null {
  switch (definition) {
    case "matches":
      return null;
    case "differs":
      return `リポジトリの定義と違います: ${differences.join("、")}`;
    case "not_in_repo":
      return "リポジトリに定義がありません";
    default:
      return "リポジトリの定義との関係は不明です";
  }
}

export function describeSchedule(
  schedule: ScheduleViewData,
  frozen: ReadonlySet<string> | null,
): ScheduleRow {
  const differences = schedule.differences.map(
    (key) => DIFFERENCE_LABELS.get(key) ?? key,
  );
  const last = schedule.recent_runs[0];
  return {
    path: schedule.path,
    name: jobScriptName(schedule.path),
    enabled: schedule.enabled,
    enabledLabel: schedule.enabled ? "有効" : "無効",
    frozen: frozen !== null && frozen.has(schedule.path),
    differences,
    definitionNote: definitionNoteOf(schedule.definition, differences),
    nextRunAt: schedule.next_run_at,
    lastRun:
      last === undefined
        ? null
        : {
            jobId: last.job_id,
            success: last.success,
            label: last.success ? "成功" : "失敗",
            durationLabel: formatDuration(last.duration_ms),
          },
    error: schedule.error,
  };
}

/** 値を出さない設定の印の文言。参照と、伏せた値に使う。 */
export const CONFIG_REFERENCE_LABEL = "参照(出さない)";

/** キー名の部分一致で絞る。大文字と小文字を区別せず、前後の空白は無視する。値は探さない。 */
export function filterConfigItems(
  items: readonly ConfigItemView[],
  query: string,
): ConfigItemView[] {
  const needle = query.trim().toLowerCase();
  return needle === ""
    ? [...items]
    : items.filter((item) => item.key.toLowerCase().includes(needle));
}

export type ConfigValueText =
  | { readonly kind: "reference" }
  | { readonly kind: "scalar"; readonly text: string }
  | { readonly kind: "structure"; readonly text: string };

/**
 * 設定の値を、テキストにする。参照と、伏せた値は出さない。
 * 配列とオブジェクトは、字下げしたJSONの文字列にする。見えない文字と並びを入れ替える文字は、代替文字にする。
 */
export function describeConfigValue(item: ConfigItemView): ConfigValueText {
  if (item.kind === "reference" || item.masked) return { kind: "reference" };
  const value = item.value;
  if (typeof value === "object" && value !== null) {
    const text = JSON.stringify(value, null, 2) ?? String(value);
    return { kind: "structure", text: displayableIssueText(text).text };
  }
  return { kind: "scalar", text: displayableIssueText(String(value)).text };
}
