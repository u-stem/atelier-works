// Windmillのscriptを同じオリジンから呼ぶ唯一の入口。
// ログインのCookieだけで`run_wait_result`が動くので、トークンは持たない。
// 呼べるscriptは`SCRIPT_PATHS`の許可リストだけで、パスを外から受け取らない。
// 画面は`runScript`を直接呼ばず、`queries.ts`と`writes.ts`の型付きの関数を通す。

import { classifyRunResponse, type RunResult } from "./errors.ts";

/**
 * Consoleが呼んでよいscript。キーが呼び出し側の名前、値がWindmillのパス。
 * 保留を置くscriptは持たない。Consoleは保留と凍結を読み、解除するだけである。
 * ジョブ、schedule、設定を読む3本(`console_jobs`、`console_schedules`、`console_config`)は読み取り専用で、
 * 書き込みは持たない。
 */
export const SCRIPT_PATHS = {
  console_query: "f/factory/steps/console_query",
  console_holds: "f/factory/console_holds",
  approval_decide: "f/factory/approval_decide",
  retry_work_item: "f/factory/retry_work_item",
  audit_kickoff: "f/factory/audit_kickoff",
  manual_intake_submit: "f/factory/manual_intake_submit",
  notice_resolve: "f/factory/notice_resolve",
  hold_release: "f/factory/hold_release",
  freeze_release: "f/factory/freeze_release",
  console_jobs: "f/factory/console_jobs",
  console_schedules: "f/factory/console_schedules",
  console_config: "f/factory/console_config",
} as const;

export type ScriptName = keyof typeof SCRIPT_PATHS;

/**
 * 型の外から来た文字列が許可リストの名前か。
 * `SCRIPT_PATHS[name]`は`constructor`などの継承したプロパティも返すので、自身のキーに限る。
 */
export function isScriptName(name: string): name is ScriptName {
  return Object.hasOwn(SCRIPT_PATHS, name);
}

/** `runScript`が終わるたびに、結果を受け取る関数。Windmillに届いているかの判断に使う。 */
export type ConnectionReporter = (result: RunResult) => void;

let reporter: ConnectionReporter | null = null;

/**
 * 結果の報告先を差し替える。`null`で外す。
 * 届いているかは、Windmillを呼ぶ`runScript`の結果だけを元にする。
 * `status.json`のように`runScript`を通らない取得は、帯に影響しない。
 */
export function setConnectionReporter(next: ConnectionReporter | null): void {
  reporter = next;
}

/** テストで差し替えられるよう、`fetch`の形を絞った型。 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type RunScriptOptions = {
  readonly fetchFn?: FetchLike;
  readonly signal?: AbortSignal;
};

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function runUrl(name: ScriptName): string {
  return `/api/w/factory/jobs/run_wait_result/p/${SCRIPT_PATHS[name]}`;
}

function report(result: RunResult): RunResult {
  reporter?.(result);
  return result;
}

/**
 * `name`のscriptを`args`で実行し、終わるまで待った結果を返す。例外は投げず、
 * 失敗は`RunResult`の`error`に分類して返す。
 * 呼び出しの中断(`signal`)だけは、呼び出し側が取り消しとして扱えるよう例外を再び投げる。中断は報告しない。
 * 終わった結果は、報告先(`setConnectionReporter`)にも渡す。
 * 書き込みのscriptでも自動では再試行しない。再試行するかは呼び出し側が決める。
 */
export async function runScript(
  name: ScriptName,
  args: Readonly<Record<string, unknown>>,
  options: RunScriptOptions = {},
): Promise<RunResult> {
  if (!isScriptName(name)) {
    return { ok: false, error: { kind: "invalid_response" } };
  }
  const fetchFn = options.fetchFn ?? defaultFetch;
  const init: RequestInit = {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  };
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }
  try {
    const response = await fetchFn(runUrl(name), init);
    const body = await response.text();
    return report(classifyRunResponse(response.status, body));
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw error;
    }
    return report({ ok: false, error: { kind: "network" } });
  }
}
