// tag `console`のscriptを、読み取りと書き込みに分ける一覧。1か所に置き、拒否フックと検査が同じ一覧を使う。
//
// 書き込みは、ローカルのClaudeのセッションが`wmill`やHTTPで呼べないようにする。
// Consoleの画面は、運用者がログインして確認のダイアログを通した後にだけ、書き込みを呼ぶ。
// セッションが同じscriptを直接呼ぶと、その確認を通らずに、運用者と同じ操作を行える。
//
// 一覧にあるscriptのうち、読み取りの一覧に無いものがすべて書き込みで、フックは名前で拒否する。
// 新しいtag `console`のscriptは、どちらの一覧にも無い間は
// `tests/scripts/claude-hooks/console-scripts.test.ts`が落ちるので、足す人が分類を選ぶ。

/**
 * 読み取りだけのtag `console`のscript(basename)。
 * `console_fetch_watch`は、画面が呼ぶscriptではなく、Consoleの取り込みを見張る定期の処理である。
 */
export const CONSOLE_READ_SCRIPTS: readonly string[] = [
  "console_query",
  "console_holds",
  "console_jobs",
  "console_schedules",
  "console_config",
  "console_fetch_watch",
];

/** 書き込みのtag `console`のscript(basename)。拒否フックが名前で止める。 */
export const CONSOLE_WRITE_SCRIPTS: readonly string[] = [
  "approval_decide",
  "retry_work_item",
  "audit_kickoff",
  "manual_intake_submit",
  "notice_resolve",
  "hold_release",
  "freeze_release",
  "console_job_cancel",
  "console_job_rerun",
  "console_config_update",
  "console_hold_place",
  "console_schedule_stop",
];

/**
 * 書き込みのうち、`f/`の他のファイルが名前を持たないscript。
 * 名前は拒否フックが止める語なので、定数や文書の文字列として`f/`に置かない。
 * 置くと、そのファイルを読み書きするコマンドまで止まる。検査は`tests/scripts/hold_wiring.test.ts`にある。
 * 既存の書き込みのscriptは、`f/`の他のファイルが名前を持っているため、この一覧に含めない。
 */
export const WRITE_SCRIPTS_NAMED_ONLY_BY_THEMSELVES: readonly string[] = [
  "hold_release",
  "freeze_release",
  "console_job_cancel",
  "console_job_rerun",
  "console_config_update",
  "console_hold_place",
  "console_schedule_stop",
];
