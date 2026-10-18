/** ホストの照会。プロセスの開始時刻とブートセッションを読む。 */

import type { CommandRunner } from "./command.ts";

export async function processStart(
  _run: CommandRunner,
  _pid: number,
): Promise<string | null> {
  return null;
}

export async function bootId(_run: CommandRunner): Promise<string> {
  return "";
}
