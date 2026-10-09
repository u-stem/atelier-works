// Windmillのscriptを同じオリジンから呼ぶ唯一の入口。
// ログインのCookieだけで`run_wait_result`が動くので、トークンは持たない。
// 呼べるscriptは`SCRIPT_PATHS`の許可リストだけで、パスを外から受け取らない。

import { classifyRunResponse, type RunResult } from "./errors.ts";

/** Consoleが呼んでよいscript。キーが呼び出し側の名前、値がWindmillのパス。 */
export const SCRIPT_PATHS = {
  console_query: "f/factory/steps/console_query",
  approval_decide: "f/factory/approval_decide",
} as const;

export type ScriptName = keyof typeof SCRIPT_PATHS;

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

/**
 * `name`のscriptを`args`で実行し、終わるまで待った結果を返す。例外は投げず、
 * 失敗は`RunResult`の`error`に分類して返す。
 * 呼び出しの中断(`signal`)だけは、呼び出し側が取り消しとして扱えるよう例外を再び投げる。
 * 書き込みのscriptでも自動では再試行しない。再試行するかは呼び出し側が決める。
 */
export async function runScript(
  name: ScriptName,
  args: Readonly<Record<string, unknown>>,
  options: RunScriptOptions = {},
): Promise<RunResult> {
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
    return classifyRunResponse(response.status, body);
  } catch (error) {
    if (options.signal?.aborted === true) {
      throw error;
    }
    return { ok: false, error: { kind: "network" } };
  }
}
