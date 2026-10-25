// 画面の層は、`runScript`を直接読み込まない(`windmill.ts`の方針)。
// 帯の元になる結果の報告先は、api層のこの入口から結ぶ。

import type { RunResult } from "./errors.ts";
import { setConnectionReporter } from "./windmill.ts";

/** `runScript`が終わるたびに、結果を`report`へ渡す。結び直すと、前の報告先は外れる。 */
export function reportRunScriptTo(report: (result: RunResult) => void): void {
  setConnectionReporter(report);
}
