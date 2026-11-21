// 5分ごとに、設定(`f/factory/factory_config`のresource)を読み、Consoleの外の経路
// (`wmill resource push`、Windmillの画面、ホストのCLI)で変わった項目を、`factory.config_history`へ`out_of_band`として書く。
// Consoleの設定の更新と全停止は、変更の成功の後に自分で履歴を書く。ここは、その履歴の最後の値と今の値を項目ごとに比べ、
// 違う項目だけを書くので、Consoleの経路の変更は二重にならない。
// 履歴にまだ無い項目は、基準の段階(基準の印の行が書かれるまで)に、基準(`snapshot_baseline`)として書く。
// 印の行を書いた後に現れた項目は、足された項目(`out_of_band_added`)として、変更に数える。
// 書き残しが出た実行(上限、時間の区切り、知らない項目の数の上限)は、行を書いた後にジョブを失敗させる。
// 書き残しが続くと、scheduleの連続失敗の検知(`detect_schedule_failures`)が、要対応の通知にする。
//
// 補間しない生の値を読む(`ResourceService.getResourceValue`)。補間する`getResource`は、`$var:`を秘密の値に解決するので使わない。
// resourceへは書かない。値は許可リストで射影してから扱い、ログにも履歴にも生の値を出さない。
// 履歴の表か関数が無い間(migrationより先にコードが反映された間)は、何も書かずに終える。
// 呼び出しの失敗は、投げずに結果の件数と`skipped_reason`に出す。
//
// 判定と書き込みは`./lib/config_snapshot.ts`にあり、このファイルは入出力をつなぐだけ。

import wmillDefault, * as wmill from "windmill-client@1.817.0";
import { appendConfigProjection } from "./lib/config_history.ts";
import {
  deferralProblem,
  loadLatestProjections,
  runConfigSnapshot,
  type SnapshotResult,
} from "./lib/config_snapshot.ts";
import { defaultSqlClient } from "./lib/db.ts";
import { logger } from "./lib/log.ts";
import { withCallTimeout } from "./lib/self_update_support.ts";

/**
 * resourceの読み取りと、履歴の読み書き1回に許す時間(ミリ秒)。
 * 1回ごとの上限であり、読み取り2回と多数の行の書き込み(基準の行は上限に数えない)を足すと、ジョブ全体のtimeout(60秒)を超えうる。
 * 全体は、`runConfigSnapshot`の実行全体の時間の区切り(`SNAPSHOT_DEADLINE_MS`)が抑える。
 */
const CALL_TIMEOUT_MS = 15_000;

export async function main(): Promise<SnapshotResult> {
  const workspace = wmillDefault.getWorkspace();
  const log = logger("config_snapshot");
  const result = await runConfigSnapshot({
    readRawConfig: () =>
      withCallTimeout(
        "read the config resource",
        () =>
          wmill.ResourceService.getResourceValue({
            workspace,
            path: "f/factory/factory_config",
          }),
        CALL_TIMEOUT_MS,
      ),
    loadLatest: () =>
      withCallTimeout(
        "read the config history",
        () => loadLatestProjections(defaultSqlClient),
        CALL_TIMEOUT_MS,
      ),
    append: (input) =>
      withCallTimeout(
        "write the config history",
        () => appendConfigProjection(defaultSqlClient, input),
        CALL_TIMEOUT_MS,
      ),
    log,
  });
  log.info("config_snapshot: done", { ...result });
  const problem = deferralProblem(result);
  if (problem !== null) throw new Error(problem);
  return result;
}
